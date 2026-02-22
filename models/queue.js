import { getDb, persistDb } from "../db/index.js";
import { getProductById } from "./catalog.js";

/**
 * Queue model - persisted per-feed queue of catalog items
 * Refill appends; consumer gets next and dequeues.
 */

/**
 * @param {number} feedId
 * @returns {Promise<number>} count of items in queue
 */
export async function getQueueSize(feedId) {
  const pool = await getDb();
  const result = await pool.query(
    "SELECT COUNT(*)::int AS c FROM queue_items WHERE feed_id = $1",
    [feedId]
  );
  return result.rows[0]?.c ?? 0;
}

/**
 * Get the next catalog item for the feed and remove it from the queue (atomic).
 * @param {number} feedId
 * @returns {Promise<object|null>} catalog row or null if queue empty
 */
export async function getNextAndDequeue(feedId) {
  const pool = await getDb();
  const result = await pool.query(
    `DELETE FROM queue_items
     WHERE id = (SELECT id FROM queue_items WHERE feed_id = $1 ORDER BY id ASC LIMIT 1)
     RETURNING catalog_item_id`,
    [feedId]
  );
  const row = result.rows[0];
  if (!row) return null;
  persistDb();
  return getProductById(row.catalog_item_id);
}

/**
 * Append catalog item ids to the feed's queue (in order).
 * @param {number} feedId
 * @param {number[]} catalogItemIds
 */
export async function appendToQueue(feedId, catalogItemIds) {
  if (!catalogItemIds?.length) return;
  const pool = await getDb();
  for (const catalogItemId of catalogItemIds) {
    await pool.query(
      "INSERT INTO queue_items (feed_id, catalog_item_id) VALUES ($1, $2)",
      [feedId, catalogItemId]
    );
  }
  persistDb();
}
