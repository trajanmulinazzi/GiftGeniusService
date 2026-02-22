#!/usr/bin/env node
/**
 * Add affiliate tag to existing catalog buy_urls.
 * Use after ingesting without AMAZON_PARTNER_TAG, or to fix old links.
 *
 * Usage: node scripts/update-affiliate-links.js
 * Requires: AMAZON_PARTNER_TAG in .env
 */

import "dotenv/config";
import { getDb } from "../db/index.js";

function withAffiliateTag(url, partnerTag) {
  if (!partnerTag || !url) return url;
  try {
    const u = new URL(url);
    if (u.searchParams.get("tag") === partnerTag) return url;
    u.searchParams.set("tag", partnerTag);
    return u.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}tag=${encodeURIComponent(partnerTag)}`;
  }
}

async function run() {
  const tag = process.env.AMAZON_PARTNER_TAG;
  if (!tag) {
    console.error("Set AMAZON_PARTNER_TAG in .env");
    process.exit(1);
  }

  const pool = await getDb();
  const { rows } = await pool.query(
    `SELECT id, buy_url FROM catalog WHERE source = 'amazon' AND buy_url IS NOT NULL`
  );

  let updated = 0;
  for (const row of rows) {
    const newUrl = withAffiliateTag(row.buy_url, tag);
    if (newUrl === row.buy_url) continue;
    await pool.query(`UPDATE catalog SET buy_url = $1 WHERE id = $2`, [
      newUrl,
      row.id,
    ]);
    updated++;
  }

  console.log(`Updated ${updated} of ${rows.length} Amazon links with tag ${tag}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
