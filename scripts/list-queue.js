#!/usr/bin/env node
/**
 * List the most recent items in the queue (all feeds), with catalog details.
 * Usage: node scripts/list-queue.js [limit]
 * Example: npm run list-queue
 *          npm run list-queue 5
 *
 * Note: We don't store whether an item came from Canopy vs Amazon API;
 * both set source='amazon'. Use this to see the latest items that were
 * added to the queue (e.g. from refill, which uses Canopy when Amazon fails).
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../db/index.js";

const limit = parseInt(process.argv[2], 10) || 10;

async function run() {
  const pool = await getDb();
  const { rows } = await pool.query(
    `SELECT qi.id AS queue_id, qi.feed_id, qi.created_at AS queued_at,
            c.id AS catalog_id, c.source_id, c.source, c.title, c.price_cents
     FROM queue_items qi
     JOIN catalog c ON c.id = qi.catalog_item_id
     ORDER BY qi.id DESC
     LIMIT $1`,
    [limit]
  );

  if (rows.length === 0) {
    console.log("No items in queue.");
    return;
  }

  for (const r of rows) {
    const price = r.price_cents != null ? `$${(r.price_cents / 100).toFixed(2)}` : "—";
    console.log(`--- queue_id ${r.queue_id} | feed_id ${r.feed_id} | queued ${r.queued_at} ---`);
    console.log(`  catalog_id: ${r.catalog_id} | source_id: ${r.source_id} | source: ${r.source}`);
    console.log(`  title: ${(r.title || "").trim()}`);
    console.log(`  price: ${price}`);
    console.log("");
  }
  console.log(`Showing ${rows.length} most recent queue item(s).`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
