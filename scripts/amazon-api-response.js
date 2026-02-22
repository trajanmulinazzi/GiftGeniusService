/**
 * Call the Amazon Creators API SearchItems once and print the raw response.
 * Usage: npm run amazon:response [keywords]
 * Example: npm run amazon:response hiking
 * Requires AMAZON_CREDENTIAL_ID, AMAZON_CREDENTIAL_SECRET, AMAZON_PARTNER_TAG in .env.local
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { searchItemsRaw } from "../services/amazon-api.js";

const keywords = process.argv.slice(2).join(" ") || "hiking";

try {
  const response = await searchItemsRaw(keywords, { itemCount: 3 });
  console.log(JSON.stringify(response, null, 2));
} catch (err) {
  console.error("Amazon API error:", err?.message ?? err?.body ?? err?.response ?? String(err));
  if (err?.body) console.error("Body:", typeof err.body === "object" ? JSON.stringify(err.body, null, 2) : err.body);
  if (err?.response) console.error("Response:", err.response);
  if (err?.stack) console.error(err.stack);
  try {
    const full = JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
    if (full && full !== "{}") console.error("Full error:", full);
  } catch (_) {}
  process.exit(1);
}
