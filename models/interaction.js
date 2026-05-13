import { getDb, persistDb } from "../db/index.js";
import { incrementTimesLiked } from "./catalog.js";

/**
 * Interaction model - records like/pass/save for learning
 */

export async function recordInteraction(feedId, catalogItemId, type) {
  const pool = await getDb();
  await pool.query(
    `INSERT INTO interactions (feed_id, catalog_item_id, type) VALUES ($1, $2, $3)
     ON CONFLICT(feed_id, catalog_item_id) DO UPDATE SET type = excluded.type`,
    [feedId, catalogItemId, type]
  );
  if (type === "like") {
    await incrementTimesLiked(catalogItemId);
  }
  persistDb();
}

export async function getSeenCatalogIds(feedId) {
  const pool = await getDb();
  const result = await pool.query(
    `SELECT catalog_item_id FROM interactions WHERE feed_id = $1
     UNION
     SELECT catalog_item_id FROM seen_items WHERE feed_id = $1`,
    [feedId]
  );
  return result.rows.map((r) => r.catalog_item_id);
}

/**
 * Mark an item as seen for a feed.
 * @returns {Promise<boolean>} true when newly marked, false when already seen
 */
export async function markSeenCatalogItem(feedId, catalogItemId) {
  const pool = await getDb();
  const result = await pool.query(
    `INSERT INTO seen_items (feed_id, catalog_item_id) VALUES ($1, $2)
     ON CONFLICT(feed_id, catalog_item_id) DO NOTHING
     RETURNING id`,
    [feedId, catalogItemId]
  );
  return result.rowCount > 0;
}

/**
 * Get already-seen (source, source_id) for this feed for filtering API results.
 * @param {number} feedId
 * @returns {Promise<Set<string>>} Set of "source:source_id" (e.g. "amazon:B08XYZ")
 */
export async function getSeenSourceIds(feedId) {
  const pool = await getDb();
  const result = await pool.query(
    `SELECT c.source, c.source_id FROM catalog c
     INNER JOIN (
       SELECT catalog_item_id FROM interactions WHERE feed_id = $1
       UNION
       SELECT catalog_item_id FROM seen_items WHERE feed_id = $1
       UNION
       SELECT catalog_item_id FROM queue_items WHERE feed_id = $1
     ) s ON s.catalog_item_id = c.id`,
    [feedId]
  );
  const set = new Set();
  for (const row of result.rows) {
    set.add(`${row.source}:${row.source_id}`);
  }
  return set;
}

/**
 * Find seen items that have no explicit interaction (candidates for scroll_past).
 * @param {number} feedId
 * @param {string|null} since - ISO timestamp; only check items seen after this time (null = all)
 * @returns {Promise<number[]>} catalog_item_ids with no interaction
 */
export async function getUninteractedSeenItems(feedId, since) {
  const pool = await getDb();
  const params = [feedId];
  let sinceClause = "";
  if (since) {
    sinceClause = " AND si.seen_at >= $2";
    params.push(since);
  }
  const result = await pool.query(
    `SELECT si.catalog_item_id
     FROM seen_items si
     LEFT JOIN interactions i
       ON i.feed_id = si.feed_id AND i.catalog_item_id = si.catalog_item_id
     WHERE si.feed_id = $1${sinceClause}
       AND i.id IS NULL`,
    params
  );
  return result.rows.map((r) => r.catalog_item_id);
}

/**
 * Bulk-insert scroll_past interactions for items the user scrolled past.
 * Uses ON CONFLICT to skip items that somehow got an interaction in the meantime.
 * @param {number} feedId
 * @param {number[]} catalogItemIds
 */
export async function recordScrollPastBatch(feedId, catalogItemIds) {
  if (!catalogItemIds?.length) return;
  const pool = await getDb();
  for (const id of catalogItemIds) {
    await pool.query(
      `INSERT INTO interactions (feed_id, catalog_item_id, type) VALUES ($1, $2, 'scroll_past')
       ON CONFLICT(feed_id, catalog_item_id) DO NOTHING`,
      [feedId, id]
    );
  }
  persistDb();
}

/**
 * Mark multiple items as seen for a feed (batch insert for served batches).
 * @param {number} feedId
 * @param {number[]} catalogItemIds
 */
export async function markSeenBatch(feedId, catalogItemIds) {
  if (!catalogItemIds?.length) return;
  const pool = await getDb();
  for (const id of catalogItemIds) {
    await pool.query(
      `INSERT INTO seen_items (feed_id, catalog_item_id) VALUES ($1, $2)
       ON CONFLICT(feed_id, catalog_item_id) DO NOTHING`,
      [feedId, id]
    );
  }
  persistDb();
}

export async function getInteractionsForFeed(feedId) {
  const pool = await getDb();
  const result = await pool.query(
    "SELECT catalog_item_id, type FROM interactions WHERE feed_id = $1",
    [feedId]
  );
  return result.rows;
}

/**
 * Get sentiment summary for the most recent N interactions on a feed.
 * Returns { positive, negative, total } where positive = shop+save+like,
 * negative = dislike+scroll_past+pass.
 * @param {number} feedId
 * @param {number} [limit=20] - how many recent interactions to analyze
 */
export async function getRecentSentiment(feedId, limit = 20) {
  const pool = await getDb();
  const result = await pool.query(
    `SELECT type, COUNT(*)::int AS cnt
     FROM (
       SELECT type FROM interactions
       WHERE feed_id = $1
       ORDER BY created_at DESC
       LIMIT $2
     ) recent
     GROUP BY type`,
    [feedId, limit]
  );
  let positive = 0;
  let negative = 0;
  for (const row of result.rows) {
    if (["shop", "save", "like"].includes(row.type)) positive += row.cnt;
    else negative += row.cnt;
  }
  return { positive, negative, total: positive + negative };
}

/**
 * Get catalog items that were liked for a feed.
 */
export async function getLikedItems(feedId) {
  const pool = await getDb();
  const result = await pool.query(
    `SELECT c.* FROM catalog c
     INNER JOIN interactions i ON i.catalog_item_id = c.id
     WHERE i.feed_id = $1 AND i.type = 'like'
     ORDER BY i.created_at DESC`,
    [feedId]
  );
  return result.rows;
}

/**
 * Get catalog items that were passed (disliked) for a feed.
 */
export async function getDislikedItems(feedId) {
  const pool = await getDb();
  const result = await pool.query(
    `SELECT c.* FROM catalog c
     INNER JOIN interactions i ON i.catalog_item_id = c.id
     WHERE i.feed_id = $1 AND i.type = 'pass'
     ORDER BY i.created_at DESC`,
    [feedId]
  );
  return result.rows;
}

/**
 * Get catalog items explicitly saved for a feed.
 */
export async function getSavedItems(feedId) {
  const pool = await getDb();
  const result = await pool.query(
    `SELECT
       c.*,
       i.id AS interaction_id,
       i.created_at AS saved_at
     FROM catalog c
     INNER JOIN interactions i ON i.catalog_item_id = c.id
     WHERE i.feed_id = $1 AND i.type = 'save'
     ORDER BY i.created_at DESC, i.id DESC`,
    [feedId]
  );
  return result.rows;
}
