import { getDb } from "../db/index.js";
import { updateTagWeightsFromInteraction } from "./ranking.js";

function parseJsonObject(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function parseTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Atomically records an interaction and updates feed learning state.
 * This prevents partial writes where interaction is stored but tag weights are not.
 */
export async function recordInteractionWithLearning(feedId, catalogItemId, type) {
  const pool = await getDb();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const feedResult = await client.query(
      "SELECT id, tag_weights FROM feeds WHERE id = $1 FOR UPDATE",
      [feedId]
    );
    const feed = feedResult.rows[0] ?? null;
    if (!feed) {
      throw new Error("Feed not found");
    }

    const itemResult = await client.query(
      "SELECT id, tags FROM catalog WHERE id = $1",
      [catalogItemId]
    );
    const item = itemResult.rows[0] ?? null;
    if (!item) {
      const err = new Error("catalogItemId not found");
      err.code = "CATALOG_ITEM_NOT_FOUND";
      throw err;
    }

    await client.query(
      `INSERT INTO interactions (feed_id, catalog_item_id, type) VALUES ($1, $2, $3)
       ON CONFLICT(feed_id, catalog_item_id) DO UPDATE SET type = excluded.type`,
      [feedId, catalogItemId, type]
    );

    if (type === "like") {
      await client.query(
        "UPDATE catalog SET times_liked = times_liked + 1 WHERE id = $1",
        [catalogItemId]
      );
    }

    const currentWeights = parseJsonObject(feed.tag_weights, {});
    const itemTags = parseTags(item.tags);
    const nextWeights = updateTagWeightsFromInteraction(currentWeights, itemTags, type);
    await client.query("UPDATE feeds SET tag_weights = $1 WHERE id = $2", [
      JSON.stringify(nextWeights),
      feedId,
    ]);

    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
