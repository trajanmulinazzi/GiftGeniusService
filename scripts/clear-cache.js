/**
 * Clear only the Amazon (Canopy) product cache — leaves profiles, sessions,
 * feed history, and taxonomy intact. Use this after a change to the cached item
 * shape (e.g. adding ratings) so the next feed load repopulates from Canopy with
 * the new fields instead of waiting out the 48h TTL.
 *
 * Usage: node scripts/clear-cache.js
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../db/index.js";

const sb = getDb();

// Supabase delete() requires a filter — "id is not null" matches all rows.
const { error, count } = await sb
  .from("amazon_cache")
  .delete({ count: "exact" })
  .not("id", "is", null);

if (error) {
  console.error("Error clearing amazon_cache:", error.message);
  process.exit(1);
}

console.log(`Cleared amazon_cache (${count ?? 0} rows). Next feed load will refetch from Canopy.`);
process.exit(0);
