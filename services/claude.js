/**
 * Claude API service — pre-computation and cross-hobby synthesis.
 * All Claude calls happen here, never at runtime during user sessions.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAngleDefinitions } from './taxonomy.js';
import { sanitizeSearchTerms } from './product-filters.js';
import { count, record } from './diag.js';

const ANGLE_DEFINITIONS = getAngleDefinitions();

const MODEL = 'claude-sonnet-4-6';
export { MODEL as CLAUDE_MODEL };

const NO_GIFT_CARD_RULES = `
- NEVER include "gift card", "egift", "e-gift", or "gift certificate" in any query
- For the "experience" angle, search for physical products that enable or enhance the experience
  (gear, kits, accessories, books, tools) — NOT vouchers or stored-value cards
- Amazon sells gift cards for many queries containing those words; we must avoid them`.trim();

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function parseJsonResponse(text) {
  const cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Single timed entry point for every Claude call, so a trace can attribute
 * latency to the specific purpose (relevance rating on the feed path costs very
 * differently from a one-off precompute expansion).
 */
async function callClaude(purpose, params, meta = {}) {
  const client = getClient();
  const startedAt = performance.now();
  try {
    const response = await client.messages.create(params);
    record('claude', purpose, performance.now() - startedAt, {
      ...meta,
      out_tokens: response.usage?.output_tokens,
    });
    count('claude_calls');
    return response;
  } catch (err) {
    record('claude', purpose, performance.now() - startedAt, {
      ...meta,
      failed: err?.status ?? err?.name ?? 'error',
    });
    count('claude_calls');
    count('claude_failures');
    throw err;
  }
}

/**
 * Generate search terms for a hobby × angle pair.
 * Returns string[] of 6-8 Amazon search queries.
 */
export async function expandHobbyAngle(hobbyName, angle) {
  const prompt = `You are generating Amazon product search terms for a gift recommendation app.

Hobby: ${hobbyName}
Angle: ${angle}
Angle definition: ${ANGLE_DEFINITIONS[angle]}

Generate 6-8 distinct search queries that would surface genuinely useful and non-obvious
Amazon products for someone who loves this hobby, viewed through this angle.

Rules:
- Each query should hit a meaningfully different product type
- Avoid generic terms like "${hobbyName} gift" — be specific
- Queries should work as literal Amazon search inputs
- Budget context: products should generally fall in the $20-$200 range
${NO_GIFT_CARD_RULES}
- Return ONLY a JSON array of strings. No preamble, no explanation.

Example output: ["japanese chef knife set","mandoline slicer with safety guard","cast iron spice grinder"]`;

  const response = await callClaude('expandHobbyAngle', {
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  }, { hobby: hobbyName, angle });

  const text = response.content[0].text.trim();
  return sanitizeSearchTerms(parseJsonResponse(text));
}

/**
 * Generate occasion-specific search terms for a (occasion, budget_bucket) pair.
 * Returns string[] of 6-8 search queries.
 */
export async function expandOccasion(occasion, budgetBucket) {
  const prompt = `Generate 6-8 Amazon search terms for occasion-specific gift discovery.
These should NOT be hobby-dependent — they are universal gift ideas for this occasion.

Occasion: ${occasion}
Budget bucket: $${budgetBucket}

Rules:
${NO_GIFT_CARD_RULES}
- Prefer physical products someone would wrap and give
- Return ONLY a JSON array of strings.`;

  const response = await callClaude('expandOccasion', {
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  }, { occasion, bucket: budgetBucket });

  const text = response.content[0].text.trim();
  return sanitizeSearchTerms(parseJsonResponse(text));
}

/**
 * Rate how well each product suits a hobby.
 *
 * Amazon keyword-matches loosely, so a search written for one hobby routinely
 * returns generic products ("crossword puzzle lap desk with storage" returns a
 * plain lap desk). Search provenance therefore can't be trusted as a statement
 * about the product, and only reading the product itself can tell them apart.
 *
 * @param {string} hobbyName
 * @param {{asin: string, title: string}[]} products
 * @returns {Promise<Map<string, number>>} asin → affinity in [0, 1]
 */
export async function rateHobbyRelevance(hobbyName, products) {
  if (!products?.length) return new Map();

  const list = products
    .map((p, i) => `${i + 1}. [${p.asin}] ${p.title}`)
    .join('\n');

  const prompt = `Someone is shopping for a gift for a person whose hobby is "${hobbyName}".
These Amazon products were returned by searches written for that hobby, but Amazon
matches keywords loosely, so some are generic products that have nothing to do with it.

Rate how well each product suits someone who loves "${hobbyName}":
- 1.0 — made for this hobby, or a core piece of its gear
- 0.7 — not hobby-specific, but a keen enthusiast would genuinely use it for it
- 0.4 — plausible but a stretch; suits the general public equally
- 0.0 — no meaningful connection to the hobby

Judge the product itself, not the words in its title. A "lap desk" is a 0.0 for
crossword puzzles even though a crossword search returned it, while "PLA filament"
is a 1.0 for 3D printing even though the title never says "3D printing".

Products:
${list}

Return ONLY a JSON object mapping each ASIN to its number, e.g.
{"B01ABCDEFG": 1.0, "B02HIJKLMN": 0.0}. Include every ASIN listed.`;

  const response = await callClaude('rateHobbyRelevance', {
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  }, { hobby: hobbyName, products: products.length });

  const parsed = parseJsonResponse(response.content[0].text.trim());
  const scores = new Map();
  for (const { asin } of products) {
    const value = Number(parsed?.[asin]);
    if (Number.isFinite(value)) {
      scores.set(asin, Math.min(Math.max(value, 0), 1));
    }
  }
  return scores;
}

/**
 * Generate cross-hobby synthesis search terms.
 * Returns string[] of 6-8 search queries at the intersection of multiple hobbies.
 */
export async function expandCrossHobby(hobbyNames) {
  const prompt = `A person has the following hobbies: ${hobbyNames.join(', ')}.
Generate 6-8 Amazon search terms for gifts that combine or sit at the intersection of these hobbies.
These should be non-obvious — items they wouldn't find just searching for one hobby alone.

Rules:
${NO_GIFT_CARD_RULES}
- Return ONLY a JSON array of strings.`;

  const response = await callClaude('expandCrossHobby', {
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  }, { hobbies: hobbyNames.length });

  const text = response.content[0].text.trim();
  return sanitizeSearchTerms(parseJsonResponse(text));
}

