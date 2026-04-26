/**
 * Refill service - fetches items from Amazon Creator API (fallback: Canopy),
 * filters already-seen and budget, upserts to catalog, ranks, appends to persisted queue.
 */

import { appendFile } from "fs/promises";
import { join } from "path";
import * as amazonApi from "./amazon-api.js";
import * as canopyApi from "./canopy-api.js";
import { getFeed, getSearchTermsForRefill } from "../models/feed.js";
import { getSeenSourceIds } from "../models/interaction.js";
import { upsertProduct, getProductsByIds } from "../models/catalog.js";
import { appendToQueue, getQueueSize } from "../models/queue.js";
import { rankItems } from "./ranking.js";
import { normalizeTags } from "../data/tag-canonical.js";

const REFILL_TARGET_SIZE = 6;
const REFILL_THRESHOLD = 3;
const API_ITEM_COUNT = 10;
/** Max items with the same tag in one refill batch (diversity cap). */
const MAX_ITEMS_PER_TAG = 2;

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

/**
 * Build budget options for API calls (min/max in cents, from feed dollars).
 * @param {Object} feed - feed with budget_min, budget_max (dollars)
 * @returns {{ budgetMinCents?: number, budgetMaxCents?: number }}
 */
function budgetOpts(feed) {
  const opts = {};
  if (feed.budget_min != null)
    opts.budgetMinCents = Math.round(feed.budget_min * 100);
  if (feed.budget_max != null)
    opts.budgetMaxCents = Math.round(feed.budget_max * 100);
  return opts;
}

/**
 * Fetch products from API: try Amazon first, fallback to Canopy.
 * Uses feed's min/max budget when calling the API so results are pre-filtered by price.
 * @param {string} searchTerm
 * @param {Object} feed - feed with budget_min, budget_max (dollars)
 * @returns {Promise<{ products: object[], source: 'amazon'|'canopy' }>}
 */
async function fetchFromApi(searchTerm, feed) {
  const budget = budgetOpts(feed || {});
  const apiOpts = { itemCount: API_ITEM_COUNT, ...budget };
  try {
    const products = await amazonApi.searchProducts(searchTerm, apiOpts);
    return { products, source: "amazon" };
  } catch (amazonErr) {
    try {
      const products = await canopyApi.searchProducts(searchTerm, {
        limit: 20,
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

/**
 * Filter by budget (feed budget_min/budget_max in dollars; product price_cents).
 */
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

function relationshipFallbackTerm(feed) {
  const relationship =
    typeof feed?.relationship === "string" ? feed.relationship.trim().toLowerCase() : "";
  if (!relationship) return null;
  const normalized = relationship.replace(/\s+/g, " ");
  return `gifts for ${normalized}`;
}

function pickRandom(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const idx = Math.floor(Math.random() * values.length);
  return values[idx] ?? null;
}

/**
 * Two-pass selection:
 * 1) Apply diversity cap first
 * 2) Backfill remaining slots from leftover ranked items
 * This keeps diversity as a preference while still filling the queue.
 * @param {Object[]} rankedItems - items sorted by score (best first), each with .tags (string[])
 * @param {{ targetSize: number, maxPerTag: number }} opts
 * @returns {Object[]} subset of rankedItems
 */
function selectWithDiversityThenFill(rankedItems, { targetSize, maxPerTag }) {
  const selected = [];
  const tagCount = {};
  const selectedIds = new Set();
  let pass1Count = 0;
  let pass2Count = 0;

  // Pass 1: diversity-constrained picks.
  for (const item of rankedItems) {
    if (selected.length >= targetSize) break;
    const tags = (item.tags && Array.isArray(item.tags) ? item.tags : []).map(
      (t) => String(t).toLowerCase()
    );
    const wouldExceed =
      tags.length > 0 && tags.some((tag) => (tagCount[tag] || 0) >= maxPerTag);
    if (wouldExceed) continue;
    selected.push(item);
    selectedIds.add(item.id);
    pass1Count++;
    for (const tag of tags) tagCount[tag] = (tagCount[tag] || 0) + 1;
  }

  // Pass 2: fill remaining queue slots from highest-ranked leftovers.
  if (selected.length < targetSize) {
    for (const item of rankedItems) {
      if (selected.length >= targetSize) break;
      if (selectedIds.has(item.id)) continue;
      selected.push(item);
      selectedIds.add(item.id);
      pass2Count++;
    }
  }

  return { selected, pass1Count, pass2Count };
}

/**
 * Refill the persisted queue for a feed: call API with search terms (interests or top tags),
 * filter already-seen and budget, upsert to catalog, rank, append up to REFILL_TARGET_SIZE.
 * Only calls API again in same refill if queue would still be below REFILL_THRESHOLD after adding.
 * @param {number} feedId
 * @returns {Promise<number>} count of items added to queue
 */
export async function refillQueue(feedId) {
  const feed = await getFeed(feedId);
  if (!feed) return 0;

  const queueSize = await getQueueSize(feedId);
  const isInitial = queueSize === 0;
  const searchTerms = await getSearchTermsForRefill(feedId, isInitial);
  if (!searchTerms.length) return 0;
  const terms = Array.from(
    new Set(
      searchTerms
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean)
    )
  );
  if (!terms.length) return 0;

  const seenSet = await getSeenSourceIds(feedId);
  const candidateIds = [];

  await logRefill(
    `feedId=${feedId} isInitial=${isInitial} searchTerms=`,
    searchTerms
  );

  async function processTerm(term) {
    let products = [];
    let source = "amazon";
    const stats = {
      fetched: 0,
      skippedSeen: 0,
      skippedBudget: 0,
      fallbackTagsApplied: 0,
      upserted: 0,
    };
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
        amazonMessage: err?.amazonMessage,
        canopyMessage: err?.canopyMessage,
      });
      return;
    }
    stats.fetched = products.length;
    await logRefill(
      `term="${term}" ${source} API: ${products.length} items`,
      products.map((p) => ({
        source_id: p.source_id,
        title: (p.title || "").slice(0, 60),
        price_cents: p.price_cents,
      }))
    );
    const eligible = [];
    for (const p of products) {
      const key = `${p.source || "amazon"}:${p.source_id}`;
      if (seenSet.has(key)) {
        stats.skippedSeen++;
        continue;
      }
      if (!inBudget(p, feed)) {
        stats.skippedBudget++;
        continue;
      }
      if (!Array.isArray(p.tags) || p.tags.length === 0) {
        // Fallback when API metadata doesn't map: derive tags from the term that fetched this item.
        p.tags = tagsFromSearchTerm(term);
        stats.fallbackTagsApplied++;
      }
      eligible.push({ product: p, key });
    }

    const picked = pickRandom(eligible);
    if (picked) {
      const id = await upsertProduct(picked.product);
      if (id) {
        seenSet.add(picked.key);
        candidateIds.push(id);
        stats.upserted++;
        await logRefill(`term="${term}" picked random item`, {
          source_id: picked.product.source_id,
          title: (picked.product.title || "").slice(0, 60),
          price_cents: picked.product.price_cents,
        });
      }
    }
    stats.eligibleAfterFilters = eligible.length;
    await logRefill(`term="${term}" filter summary`, stats);
  }

  // Always sample from the top 3 highest-priority terms first.
  const headTerms = terms.slice(0, 3);
  const tailTerms = terms.slice(3);
  for (const term of headTerms) {
    await processTerm(term);
  }

  // After top-3 sampling, continue filling until target size.
  if (candidateIds.length < REFILL_TARGET_SIZE) {
    for (const term of tailTerms) {
      await processTerm(term);
      if (candidateIds.length >= REFILL_TARGET_SIZE) break;
    }
  }

  // Fallback: if we still have little/no inventory, query a relationship-based gift phrase.
  if (candidateIds.length < REFILL_TARGET_SIZE) {
    const fallbackTerm = relationshipFallbackTerm(feed);
    if (fallbackTerm) {
      await logRefill(`fallback relationship term="${fallbackTerm}"`);
      await processTerm(fallbackTerm);
    }
  }

  if (candidateIds.length === 0) return 0;

  const rows = await getProductsByIds(candidateIds);
  const parsed = rows.map((p) => ({
    ...p,
    tags: parseTags(p.tags),
  }));
  const ranked = rankItems(parsed, feed);
  const { selected, pass1Count, pass2Count } = selectWithDiversityThenFill(ranked, {
    targetSize: REFILL_TARGET_SIZE,
    maxPerTag: MAX_ITEMS_PER_TAG,
  });
  const toAdd = selected.map((r) => r.id);
  const addedRows = selected;

  await logRefill("selection summary", {
    candidateIds: candidateIds.length,
    fetchedRows: rows.length,
    ranked: ranked.length,
    selected: selected.length,
    diversityPassCount: pass1Count,
    backfillPassCount: pass2Count,
  });

  await logRefill(
    `adding to queue: ${addedRows.length} items`,
    addedRows.map((r) => ({
      id: r.id,
      source_id: r.source_id,
      title: (r.title || "").slice(0, 60),
      price_cents: r.price_cents,
    }))
  );

  await appendToQueue(feedId, toAdd);
  return toAdd.length;
}
