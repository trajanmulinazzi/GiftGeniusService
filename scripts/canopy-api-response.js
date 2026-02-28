/**
 * Call the Canopy product API once for one item and print the full raw response.
 * One API call only. Use this to inspect the tags (categories, featureBullets, brand) returned for one product.
 * Usage: npm run canopy:response [ASIN]
 * Example: npm run canopy:response
 *          npm run canopy:response B09TR9LPKN
 * Requires CANOPY_API_KEY in .env.local
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getProductByAsinRaw } from "../services/canopy-api.js";

const asin = process.argv[2] || "B09TR9LPKN";

try {
  const response = await getProductByAsinRaw(asin);
  console.log(JSON.stringify(response, null, 2));
} catch (err) {
  console.error("Canopy API error:", err.message);
  if (err.body) console.error("Body:", JSON.stringify(err.body, null, 2));
  if (err.status) console.error("Status:", err.status);
  process.exit(1);
}
