/**
 * Refill service — round-robin sourcing across diverse search terms.
 *
 * Flow:
 * 1. Get all expanded search terms for the feed's hobbies (from hobby_searches / LLM).
 * 2. For each term, fetch from Amazon (fallback Canopy), cap to 2 eligible items per term.
 * 3. Round-robin pick one item from each term bucket so consecutive queue items
 *    always come from DIFFERENT search terms.
 * 4. When all terms are exhausted, check recent sentiment:
 *    - Negative (lots of skip/dislike) → generate brand new search terms via LLM
 *    - Positive → re-query existing terms for 2 more items each
 */

import { appendFile } from "fs/promises";
import { join } from "path";
import * as amazonApi from "./amazon-api.js";
import * as canopyApi from "./canopy-api.js";
import { getFeed, getSearchTermsForRefill } from "../models/feed.js";
import { getSeenSourceIds, getRecentSentiment } from "../models/interaction.js";
import {
  upsertProduct,
  getProductsByIds,
} from "../models/catalog.js";
import { appendToQueue, getQueueSize } from "../models/queue.js";
import { normalizeTags } from "../data/tag-canonical.js";
import { getExpandedSearchTerms } from "./search-term-expander.js";

const REFILL_TARGET_SIZE = 6;
/** Max eligible items to keep per search term. */
const ITEMS_PER_TERM = 2;

const QUEUE_LOG = join(process.cwd(), "queue.log");
const LOG_TO_CONSOLE =
  process.env.LOG_REFILL === "1" || process.env.DEBUG === "refill";

async function logRefill(message, detail = null) {
  const line =
    detail != null ? `${message} ${JSON.stringify(detail)}` : message;
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [refill] ${line}\n`;
  try {
    await appendFile(QUEUE_LOG, logLine);
  } catch (_) {}
  if (LOG_TO_CONSOLE) {
    console.log(`[refill] ${line}`);
  }
}

function budgetOpts(feed) {
  const opts = {};
  if (feed.budget_min != null)
    opts.budgetMinCents = Math.round(feed.budget_min * 100);
  if (feed.budget_max != null)
    opts.budgetMaxCents = Math.round(feed.budget_max * 100);
  return opts;
}

async function fetchFromApi(searchTerm, feed) {
  const budget = budgetOpts(feed || {});
  const apiOpts = { itemCount: 10, ...budget };
  try {
    const products = await amazonApi.searchProducts(searchTerm, apiOpts);
    return { products, source: "amazon" };
  } catch (amazonErr) {
    try {
      const products = await canopyApi.searchProducts(searchTerm, {
        limit: 10,
        ...budget,
      });
      return { products, source: "canopy" };
    } catch (canopyErr) {
      const err = new Error("Amazon and Canopy fetch failed");
      err.amazonMessage = amazonErr?.message || String(amazonErr);
      err.canopyMessage = canopyErr?.message || String(canopyErr);
      throw err;
    }
  }
}

function inBudget(product, feed) {
  const cents = product.price_cents;
  if (feed.budget_min != null) {
    const minCents = Math.round(feed.budget_min * 100);
    if (cents != null && cents < minCents) return false;
  }
  if (feed.budget_max != null) {
    const maxCents = Math.round(feed.budget_max * 100);
    if (cents != null && cents > maxCents) return false;
  }
  return true;
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string") {
    try {
      return JSON.parse(tags);
    } catch {
      return [];
    }
  }
  return [];
}

function tagsFromSearchTerm(term) {
  const text = typeof term === "string" ? term.trim().toLowerCase() : "";
  if (!text) return [];
  const raw = [text, ...text.split(/\s+/).filter(Boolean)];
  return normalizeTags(raw);
}

/**
 * Fetch from API for a single search term, upsert ALL results into catalog,
 * and return up to `maxEligible` IDs of items eligible for this feed.
 */
async function fetchAndUpsertTerm(term, feed, seenSet, maxEligible = ITEMS_PER_TERM) {
  let products = [];
  let source = "amazon";
  try {
    if (
      process.env.REFILL_FAIL_TERM &&
      term.toLowerCase() === process.env.REFILL_FAIL_TERM.toLowerCase()
    ) {
      throw new Error(`Simulated refill failure for term "${term}"`);
    }
    ({ products, source } = await fetchFromApi(term, feed));
  } catch (err) {
    await logRefill(`term="${term}" API failed`, {
      message: err?.message || String(err),
    });
    return [];
  }

  await logRefill(`term="${term}" ${source} API: ${products.length} items`);

  const eligibleIds = [];
  for (const p of products) {
    const key = `${p.source || "amazon"}:${p.source_id}`;

    if (!Array.isArray(p.tags) || p.tags.length === 0) {
      p.tags = tagsFromSearchTerm(term);
    }

    const id = await upsertProduct(p);

    if (eligibleIds.length >= maxEligible) continue;
    if (seenSet.has(key)) continue;
    if (!inBudget(p, feed)) continue;
    if (id) {
      seenSet.add(key);
      eligibleIds.push(id);
    }
  }

  await logRefill(`term="${term}" eligible: ${eligibleIds.length}/${products.length}`);
  return eligibleIds;
}

/**
 * Round-robin pick from term buckets: take 1 from each bucket in turn.
 * This guarantees consecutive items come from DIFFERENT search terms.
 * @param {number[][]} buckets - each bucket is IDs from one search term
 * @param {number} limit - max items to return
 * @returns {number[]} interleaved IDs
 */
function roundRobinPick(buckets, limit) {
  const result = [];
  let idx = 0;
  while (result.length < limit) {
    let added = false;
    for (const bucket of buckets) {
      if (result.length >= limit) break;
      if (idx < bucket.length) {
        result.push(bucket[idx]);
        added = true;
      }
    }
    if (!added) break;
    idx++;
  }
  return result;
}

/**
 * Refill the persisted queue for a feed.
 *
 * @param {number} feedId
 * @returns {Promise<number>} count of items added to queue
 */
export async function refillQueue(feedId) {
  const feed = await getFeed(feedId);
  if (!feed) return 0;

  const queueSize = await getQueueSize(feedId);
  const slotsNeeded = REFILL_TARGET_SIZE - queueSize;
  if (slotsNeeded <= 0) return 0;

  const isInitial = queueSize === 0;
  const seenSet = await getSeenSourceIds(feedId);

  const searchTerms = await getSearchTermsForRefill(feedId, isInitial);
  const terms = Array.from(
    new Set(
      searchTerms
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean)
    )
  );

  await logRefill(
    `feedId=${feedId} isInitial=${isInitial} slotsNeeded=${slotsNeeded} terms=`,
    terms
  );

  if (!terms.length) return 0;

  // ── Fetch 2 items per term ──────────────────────────────────────────
  // Each bucket = IDs from one search term. We track them separately
  // so we can round-robin across terms for the final queue order.
  const buckets = [];
  let totalCollected = 0;

  for (const term of terms) {
    const ids = await fetchAndUpsertTerm(term, feed, seenSet, ITEMS_PER_TERM);
    if (ids.length > 0) {
      buckets.push(ids);
      totalCollected += ids.length;
    }
  }

  // ── If not enough, check sentiment and decide strategy ──────────────
  if (totalCollected < slotsNeeded) {
    const sentiment = await getRecentSentiment(feedId);
    await logRefill("sentiment check", sentiment);

    if (sentiment.total === 0 || sentiment.negative > sentiment.positive) {
      await logRefill("negative sentiment → generating new search terms");
      const interests = Array.isArray(feed.interests) ? feed.interests : [];
      for (const hobby of interests) {
        const freshTerms = await getExpandedSearchTerms(hobby, 5);
        for (const term of freshTerms) {
          if (totalCollected >= slotsNeeded) break;
          const ids = await fetchAndUpsertTerm(term, feed, seenSet, ITEMS_PER_TERM);
          if (ids.length > 0) {
            buckets.push(ids);
            totalCollected += ids.length;
          }
        }
        if (totalCollected >= slotsNeeded) break;
      }
    } else {
      await logRefill("positive sentiment → fetching more from existing terms");
      for (const term of terms) {
        if (totalCollected >= slotsNeeded) break;
        const ids = await fetchAndUpsertTerm(term, feed, seenSet, ITEMS_PER_TERM);
        if (ids.length > 0) {
          buckets.push(ids);
          totalCollected += ids.length;
        }
      }
    }
  }

  if (totalCollected === 0) return 0;

  // ── Round-robin across term buckets → final queue order ─────────────
  // This is the KEY step: we pick 1 item from term A, 1 from term B,
  // 1 from term C, then back to term A, etc. No ranking step that would
  // re-group similar items together.
  const toAdd = roundRobinPick(buckets, slotsNeeded);

  // Fetch full rows just for logging
  const rows = await getProductsByIds(toAdd);
  const rowMap = new Map(rows.map((r) => [r.id, r]));

  await logRefill(
    `adding to queue: ${toAdd.length} items`,
    toAdd.map((id) => {
      const r = rowMap.get(id);
      return r
        ? { id: r.id, source_id: r.source_id, title: (r.title || "").slice(0, 60), price_cents: r.price_cents }
        : { id };
    })
  );

  await appendToQueue(feedId, toAdd);
  return toAdd.length;
}
