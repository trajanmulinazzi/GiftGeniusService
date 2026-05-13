/**
 * LLM-powered search term expansion.
 *
 * Given a hobby/interest (e.g. "coffee"), generates diverse gift search
 * queries ("espresso machine", "pour over kit", "coffee grinder", etc.)
 * via Claude Haiku and caches them in the hobby_searches table.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  getUnusedSearchTerms,
  getSearchTermsForHobby,
  insertSearchTerms,
  markSearchTermsUsed,
} from "../models/hobby-search.js";

const BATCH_SIZE = 10; // terms to generate per LLM call
const TERMS_PER_REFILL = 5; // terms to return per refill request

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

/**
 * Ask Claude to generate diverse gift search queries for a hobby.
 * @param {string} hobby
 * @param {string[]} existingTerms - terms already in cache (avoid repeats)
 * @returns {Promise<string[]>} new search terms
 */
async function generateSearchTerms(hobby, existingTerms = []) {
  const anthropic = getClient();

  const existingList =
    existingTerms.length > 0
      ? `\n\nAlready generated (DO NOT repeat these):\n${existingTerms.map((t) => `- ${t}`).join("\n")}`
      : "";

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `Generate ${BATCH_SIZE} diverse gift search queries for someone whose hobby/interest is "${hobby}".

These will be used to search Amazon for gift ideas, so make them specific product-oriented queries that would return different TYPES of products (not just variations of the same thing).

Rules:
- Each query should target a DIFFERENT product category or gift type
- Be specific enough to return relevant results (e.g. "pour over coffee dripper" not just "coffee")
- Include a mix of price ranges (affordable accessories to premium items)
- Think creatively — what would a thoughtful gift-giver search for?${existingList}

Return ONLY the search queries, one per line, no numbering or bullets.`,
      },
    ],
  });

  const text =
    message.content?.[0]?.type === "text" ? message.content[0].text : "";
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length < 200);
}

/**
 * Get expanded search terms for a hobby. Returns cached unused terms if
 * available, otherwise generates new ones via LLM and caches them.
 *
 * @param {string} hobby - e.g. "coffee"
 * @param {number} [limit] - how many terms to return
 * @returns {Promise<string[]>} search terms ready for API queries
 */
export async function getExpandedSearchTerms(hobby, limit = TERMS_PER_REFILL) {
  const h = hobby.toLowerCase().trim();
  if (!h) return [];

  // Check for unused cached terms first
  let unused = await getUnusedSearchTerms(h, limit);

  if (unused.length < limit) {
    // Need more terms — generate via LLM
    const allExisting = await getSearchTermsForHobby(h);
    const existingTerms = allExisting.map((r) => r.search_term);

    try {
      const newTerms = await generateSearchTerms(h, existingTerms);
      const inserted = await insertSearchTerms(h, newTerms);
      if (inserted > 0) {
        // Re-fetch unused terms now that we have more
        unused = await getUnusedSearchTerms(h, limit);
      }
    } catch (err) {
      console.error(`[search-expander] LLM generation failed for "${h}":`, err.message);
      // Fall through — use whatever unused terms we have, or the raw hobby
    }
  }

  if (unused.length === 0) {
    // No cached terms at all — return the raw hobby as fallback
    return [h];
  }

  // Mark these terms as used so next refill gets different ones
  const ids = unused.map((r) => r.id);
  await markSearchTermsUsed(ids);

  return unused.map((r) => r.search_term);
}
