#!/usr/bin/env node
/**
 * List recent catalog items (most recently refreshed first).
 * Usage: node scripts/list-catalog.js [limit]
 */

import "dotenv/config";
import { getDb } from "../db/index.js";

const limit = parseInt(process.argv[2], 10) || 10;

async function run() {
  const pool = await getDb();
  const { rows } = await pool.query(
    `SELECT id, title, price_cents, tags, last_refreshed
     FROM catalog
     ORDER BY last_refreshed DESC NULLS LAST, id DESC
     LIMIT $1`,
    [limit]
  );
  for (const r of rows) {
    const price = r.price_cents != null ? `$${(r.price_cents / 100).toFixed(2)}` : "—";
    const tags = typeof r.tags === "string" ? JSON.parse(r.tags || "[]") : r.tags || [];
    const title = (r.title || "").trim();
    console.log(`--- id ${r.id} | ${price} ---`);
    console.log(`  title: ${title}`);
    console.log(`  tags:  ${tags.length ? tags.join(", ") : "(none)"}`);
    console.log("");
  }
  console.log(`Showing ${rows.length} most recent items.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
