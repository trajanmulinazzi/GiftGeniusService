/**
 * Truncate all data tables.
 * Usage: node scripts/clear-data.js
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getDb } from "../db/index.js";

const TABLES = ["users"];

const pool = await getDb();
for (const table of TABLES) {
  await pool.query(`DELETE FROM ${table}`);
  console.log(`Cleared ${table}`);
}
console.log("Done.");
process.exit(0);
