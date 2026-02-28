#!/usr/bin/env node
/**
 * Call Canopy product-by-ASIN API to get the FULL API response, map to catalog shape,
 * upsert one item to the catalog, then print full response vs stored row to verify tagging.
 *
 * Uses the same approach as canopy-api-response.js: getProductByAsinRaw(asin) for full response.
 *
 * Usage: node scripts/canopy-search-to-catalog.js [ASIN]
 *   npm run canopy:search-to-catalog
 *   npm run canopy:search-to-catalog B0BLS3Y632
 *
 * Requires: CANOPY_API_KEY (and DB) in .env / .env.local
 */

import "dotenv/config";
import { getProductByAsinRaw, getProductByAsin } from "../services/canopy-api.js";
import { upsertProduct } from "../models/catalog.js";
import { getDb } from "../db/index.js";

const asin = process.argv[2] || "B0BLS3Y632";

async function run() {
  console.log(`\n=== Canopy product-by-ASIN: ${asin} (full response) ===\n`);

  // 1. Full raw API response (same as canopy-api-response.js)
  const fullRaw = await getProductByAsinRaw(asin);
  const p = fullRaw?.data?.amazonProduct;
  if (!p || !p.asin) {
    console.log("No product in response.");
    process.exit(1);
  }

  // 2. Mapped product (getProductByAsin = categories + featureBullets + brand + rating/reviews_count)
  const product = await getProductByAsin(asin);
  if (!product) {
    console.log("Mapping returned null.");
    process.exit(1);
  }
  const catalogId = await upsertProduct(product);
  if (!catalogId) {
    console.log("Upsert failed.");
    process.exit(1);
  }

  // 3. Load full catalog row
  const pool = await getDb();
  const { rows } = await pool.query("SELECT * FROM catalog WHERE id = $1", [catalogId]);
  const row = rows[0];
  if (!row) {
    console.log("Could not load catalog row.");
    process.exit(1);
  }

  const tagsStored = typeof row.tags === "string" ? JSON.parse(row.tags || "[]") : row.tags || [];

  // --- Output: full raw API response ---
  console.log("--- 1. Full API response (getProductByAsinRaw) ---");
  console.log(JSON.stringify(fullRaw, null, 2));

  // --- Output: catalog row ---
  console.log("\n--- 2. Catalog row (after upsert) ---");
  console.log(JSON.stringify({
    id: row.id,
    source_id: row.source_id,
    source: row.source,
    title: row.title,
    image_url: row.image_url,
    price_cents: row.price_cents,
    currency: row.currency,
    buy_url: row.buy_url,
    tags: tagsStored,
    rating: row.rating,
    reviews_count: row.reviews_count,
    active: row.active,
    last_refreshed: row.last_refreshed,
  }, null, 2));

  // --- Tagging breakdown (product-by-ASIN path) ---
  console.log("\n--- 3. Tagging breakdown (product-by-ASIN path) ---");
  console.log("  Tags in catalog:", tagsStored.length ? tagsStored.join(", ") : "(none)");
  console.log("  From categories: breadcrumbPath/name -> slug per part + slug of name");
  console.log("  From featureBullets (first 3): first word length>=4, not stopword");
  console.log("  From brand:", p.brand ?? "(none)", "-> slug");
  console.log("  isPrime:", p.isPrime, "-> adds 'prime' if true");
  console.log("  rating:", row.rating, ", reviews_count:", row.reviews_count, "(columns, not tags)");
  console.log("\nDone. Catalog id =", catalogId);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
