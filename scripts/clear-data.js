/**
 * Truncate all data tables except users and feeds.
 * Usage: node scripts/clear-data.js
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../db/index.js";

const TABLES = [
  "queue_items",
  "seen_items",
  "interactions",
  "hobby_searches",
  "catalog",
];

const pool = await getDb();
for (const table of TABLES) {
  await pool.query(`DELETE FROM ${table}`);
  console.log(`Cleared ${table}`);
}
console.log("Done. Users and feeds untouched.");
process.exit(0);
