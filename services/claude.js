/**
 * Claude API service — pre-computation and cross-hobby synthesis.
 * All Claude calls happen here, never at runtime during user sessions.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getAngleDefinitions } from './taxonomy.js';

const ANGLE_DEFINITIONS = getAngleDefinitions();

let _client = null;
function getClient() {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Generate search terms for a hobby × angle pair.
 * Returns string[] of 6-8 Amazon search queries.
 */
export async function expandHobbyAngle(hobbyName, angle) {
  const client = getClient();
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
- Return ONLY a JSON array of strings. No preamble, no explanation.

Example output: ["japanese chef knife set","mandoline slicer with safety guard","cast iron spice grinder"]`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  return JSON.parse(text);
}

/**
 * Generate occasion-specific search terms for a (occasion, budget_bucket) pair.
 * Returns string[] of 6-8 search queries.
 */
export async function expandOccasion(occasion, budgetBucket) {
  const client = getClient();
  const prompt = `Generate 6-8 Amazon search terms for occasion-specific gift discovery.
These should NOT be hobby-dependent — they are universal gift ideas for this occasion.

Occasion: ${occasion}
Budget bucket: $${budgetBucket}

Return ONLY a JSON array of strings.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  return JSON.parse(text);
}

/**
 * Generate cross-hobby synthesis search terms.
 * Returns string[] of 6-8 search queries at the intersection of multiple hobbies.
 */
export async function expandCrossHobby(hobbyNames) {
  const client = getClient();
  const prompt = `A person has the following hobbies: ${hobbyNames.join(', ')}.
Generate 6-8 Amazon search terms for gifts that combine or sit at the intersection of these hobbies.
These should be non-obvious — items they wouldn't find just searching for one hobby alone.
Return ONLY a JSON array of strings.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  return JSON.parse(text);
}

