/**
 * Truncate all data tables via Supabase JS client (preserves schema).
 * Usage: node scripts/clear-data.js
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../db/index.js";

// Order matters: children before parents (FK constraints)
// Each entry: [table_name, pk_column]
const TABLES = [
  ["feed_events", "id"],
  ["sessions", "id"],
  ["dislike_suppressions", "id"],
  ["profile_weights", "id"],
  ["profiles", "id"],
  ["amazon_cache", "id"],
  ["api_call_tracking", "date_key"],
  ["cross_hobby_expansions", "id"],
  ["occasion_search_terms", "id"],
  ["hobby_angle_expansions", "id"],
  ["hobbies", "id"],
  ["users", "id"],
];

const sb = getDb();
for (const [table, pk] of TABLES) {
  // Supabase delete() requires a filter — use "pk is not null" to match all rows
  const { error } = await sb.from(table).delete().not(pk, "is", null);
  if (error) console.error(`Error clearing ${table}:`, error.message);
  else console.log(`Cleared ${table}`);
}
console.log("Done.");
process.exit(0);
