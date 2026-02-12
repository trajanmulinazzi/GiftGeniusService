/**
 * Refill service - fetches candidates from catalog, ranks them, returns top N
 * Replaces LLM "generation" with catalog retrieval + ranking
 */

import { getActiveProducts } from "../models/catalog.js";
import { getFeed, updateTagWeights } from "../models/feed.js";
import { getSeenCatalogIds } from "../models/interaction.js";
import { rankItems } from "./ranking.js";

const REFILL_BATCH_SIZE = 5;
const CANDIDATE_POOL_SIZE = 200;

/**
 * Get the next batch of ranked catalog items for a feed.
 * Excludes already-seen items, applies budget filter, ranks by preferences.
 * @param {number} feedId
 * @returns {Promise<Object[]>} array of catalog items (with parsed tags)
 */
export async function refillQueue(feedId) {
  const feed = await getFeed(feedId);
  if (!feed) return [];

  const seenIds = await getSeenCatalogIds(feedId);
  const seenSet = new Set(seenIds);

  // Fetch candidate pool with budget filter
  const candidates = await getActiveProducts(feed.budget_min, feed.budget_max);

  // Exclude seen items
  const unseen = candidates.filter((c) => !seenSet.has(c.id));
  if (unseen.length === 0) return [];

  // Limit pool size for performance
  const pool = unseen.slice(0, CANDIDATE_POOL_SIZE);

  // Parse tags for ranking (rankItems expects objects)
  const parsed = pool.map((p) => ({
    ...p,
    tags: parseTags(p.tags),
  }));

  const ranked = rankItems(parsed, feed);
  const top = ranked.slice(0, REFILL_BATCH_SIZE);

  return top;
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
