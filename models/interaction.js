import { getDb, persistDb } from "../db/index.js";

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

export async function getInteractionsForFeed(feedId) {
  const pool = await getDb();
  const result = await pool.query(
    "SELECT catalog_item_id, type FROM interactions WHERE feed_id = $1",
    [feedId]
  );
  return result.rows;
}
