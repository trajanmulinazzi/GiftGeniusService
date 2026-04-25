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
    "SELECT catalog_item_id FROM interactions WHERE feed_id = $1",
    [feedId]
  );
  return result.rows.map((r) => r.catalog_item_id);
}

/**
 * Get already-seen (source, source_id) for this feed for filtering API results.
 * @param {number} feedId
 * @returns {Promise<Set<string>>} Set of "source:source_id" (e.g. "amazon:B08XYZ")
 */
export async function getSeenSourceIds(feedId) {
  const pool = await getDb();
  const result = await pool.query(
    `SELECT c.source, c.source_id FROM interactions i
     INNER JOIN catalog c ON c.id = i.catalog_item_id
     WHERE i.feed_id = $1`,
    [feedId]
  );
  const set = new Set();
  for (const row of result.rows) {
    set.add(`${row.source}:${row.source_id}`);
  }
  return set;
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
