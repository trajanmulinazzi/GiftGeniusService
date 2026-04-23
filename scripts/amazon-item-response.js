/**
 * Call the Amazon Creators API GetItems once and print the raw response.
 * Usage: npm run amazon:item-response [asin]
 * Example: npm run amazon:item-response B073CVZ9GZ
 * Requires AMAZON_CREDENTIAL_ID, AMAZON_CREDENTIAL_SECRET, AMAZON_PARTNER_TAG in .env.local
 */

import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { getItemsRaw } from "../services/amazon-api.js";

const asin = process.argv[2] || "B073CVZ9GZ";

function oauthHintFromErr(err) {
  const text = err?.response?.text ?? err?.text ?? "";
  let body = err?.body ?? err?.response?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const oauthErr =
    body?.error ??
    (typeof text === "string" && text.includes("invalid_client")
      ? "invalid_client"
      : null);
  if (oauthErr !== "invalid_client") return null;
  return [
    "OAuth token step failed with invalid_client (wrong client_id + client_secret for the token host, or wrong AMAZON_CREDENTIAL_VERSION).",
    "If your credentials are v3.x (LWA): set AMAZON_CREDENTIAL_VERSION=3.1 (US), 3.2 (EU), or 3.3 (FE)—not 2.1.",
    "If your credentials are v2 (Cognito): use 2.1 / 2.2 / 2.3. Copy ID and secret as one pair from Creators API; no stray spaces.",
  ].join("\n");
}

try {
  const response = await getItemsRaw([asin]);
  console.log(JSON.stringify(response, null, 2));
} catch (err) {
  const hint = oauthHintFromErr(err);
  const shortBody = err?.response?.text ?? err?.text;
  console.error("Amazon API error:", err?.message ?? String(err));
  if (shortBody && typeof shortBody === "string" && shortBody.length < 500) {
    console.error("Token/API response body:", shortBody);
  }
  if (hint) console.error("\n" + hint + "\n");
  if (err?.stack) console.error(err.stack);
  process.exit(1);
}
