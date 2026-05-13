/**
 * Truncate all data tables via Supabase JS client (preserves schema).
 * Usage: node scripts/clear-data.js
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../db/index.js";

// Order matters: children before parents (FK constraints)
const TABLES = [
  "feed_events",
  "sessions",
  "dislike_suppressions",
  "profile_weights",
  "profiles",
  "amazon_cache",
  "api_call_tracking",
  "cross_hobby_expansions",
  "occasion_search_terms",
  "hobby_angle_expansions",
  "hobbies",
  "users",
];

const sb = getDb();
for (const table of TABLES) {
  const { error } = await sb.from(table).delete().gte("created_at", "1970-01-01");
  if (error) console.error(`Error clearing ${table}:`, error.message);
  else console.log(`Cleared ${table}`);
}
console.log("Done.");
process.exit(0);
