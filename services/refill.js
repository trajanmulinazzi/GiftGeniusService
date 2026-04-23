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
  } catch (_) {
    const products = await canopyApi.searchProducts(searchTerm, {
      limit: 20,
      ...budget,
    });
    return { products, source: "canopy" };
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

/**
 * Select up to targetSize items from ranked list, capping how many items share the same tag.
 * Preserves ranking order; skips an item only if adding it would exceed maxPerTag for any of its tags.
 * @param {Object[]} rankedItems - items sorted by score (best first), each with .tags (string[])
 * @param {{ targetSize: number, maxPerTag: number }} opts
 * @returns {Object[]} subset of rankedItems with diversity cap applied
 */
function selectWithTagCap(rankedItems, { targetSize, maxPerTag }) {
  const selected = [];
  const tagCount = {};
  for (const item of rankedItems) {
    if (selected.length >= targetSize) break;
    const tags = (item.tags && Array.isArray(item.tags) ? item.tags : []).map(
      (t) => String(t).toLowerCase()
    );
    const wouldExceed =
      tags.length > 0 && tags.some((tag) => (tagCount[tag] || 0) >= maxPerTag);
    if (wouldExceed) continue;
    selected.push(item);
    for (const tag of tags) tagCount[tag] = (tagCount[tag] || 0) + 1;
  }
  return selected;
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

  const seenSet = await getSeenSourceIds(feedId);
  const candidateIds = [];

  await logRefill(
    `feedId=${feedId} isInitial=${isInitial} searchTerms=`,
    searchTerms
  );

  for (const term of searchTerms) {
    const { products, source } = await fetchFromApi(term, feed);
    await logRefill(
      `term="${term}" ${source} API: ${products.length} items`,
      products.map((p) => ({
        source_id: p.source_id,
        title: (p.title || "").slice(0, 60),
        price_cents: p.price_cents,
      }))
    );
    for (const p of products) {
      const key = `${p.source || "amazon"}:${p.source_id}`;
      if (seenSet.has(key)) continue;
      if (!inBudget(p, feed)) continue;
      if (!Array.isArray(p.tags) || p.tags.length === 0) {
        // Fallback when API metadata doesn't map: derive tags from the term that fetched this item.
        p.tags = tagsFromSearchTerm(term);
      }

      const id = await upsertProduct(p);
      if (id) {
        seenSet.add(key);
        candidateIds.push(id);
      }
    }
    if (candidateIds.length >= REFILL_TARGET_SIZE) break;
    if (
      candidateIds.length >= REFILL_THRESHOLD &&
      searchTerms.indexOf(term) === searchTerms.length - 1
    )
      break;
  }

  if (candidateIds.length === 0) return 0;

  const rows = await getProductsByIds(candidateIds);
  const parsed = rows.map((p) => ({
    ...p,
    tags: parseTags(p.tags),
  }));
  const ranked = rankItems(parsed, feed);
  const selected = selectWithTagCap(ranked, {
    targetSize: REFILL_TARGET_SIZE,
    maxPerTag: MAX_ITEMS_PER_TAG,
  });
  const toAdd = selected.map((r) => r.id);
  const addedRows = selected;

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
