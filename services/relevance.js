/**
 * Per-item hobby relevance.
 *
 * An item's hobby_id says which hobby's search surfaced it, which is not the
 * same as the product being for that hobby — Amazon returns generic products
 * for hobby-specific queries. This module holds Claude's read of the product
 * itself, so the feed can drop the clearly-unrelated and the client can avoid
 * labelling an item with a hobby it has nothing to do with.
 *
 * Classification runs in the background, never inside a user's request. Until
 * a verdict exists an item is simply unverified: it still gets served, just
 * without the hobby label.
 */

import { getDb } from '../db/index.js';
import { rateHobbyRelevance, CLAUDE_MODEL } from './claude.js';
import { count, span } from './diag.js';

/** At or above this, the product is genuinely hobby gear — safe to label. */
export const MIN_VERIFIED_AFFINITY = 0.6;

/** At or below this, the product is unrelated — keep it out of hobby slots. */
export const MAX_REJECTED_AFFINITY = 0.3;

/** Bounds the Claude spend a single feed generation can trigger. */
const MAX_ITEMS_PER_PASS = 60;
const BATCH_SIZE = 20;

const pairKey = (asin, hobbyId) => `${asin}:${hobbyId}`;

/**
 * Look up affinities for (asin, hobby_id) pairs.
 * Returns an empty map on any failure — an unavailable verdict must degrade to
 * "unverified", never to a broken feed.
 */
export async function loadHobbyRelevance(items) {
  const pairs = items.filter((item) => item.asin && item.hobby_id);
  if (pairs.length === 0) return new Map();

  const asins = [...new Set(pairs.map((i) => i.asin))];
  const hobbyIds = [...new Set(pairs.map((i) => i.hobby_id))];

  try {
    const sb = getDb();
    const { data, error } = await sb
      .from('item_hobby_relevance')
      .select('item_asin, hobby_id, affinity')
      .in('item_asin', asins)
      .in('hobby_id', hobbyIds);
    if (error) throw new Error(error.message);

    const scores = new Map();
    for (const row of data ?? []) {
      scores.set(pairKey(row.item_asin, row.hobby_id), row.affinity);
    }
    return scores;
  } catch (err) {
    console.error('[Relevance] Lookup failed:', err.message ?? err);
    return new Map();
  }
}

/** True when we know the product suits the hobby well enough to say so. */
export function isHobbyVerified(affinity) {
  return typeof affinity === 'number' && affinity >= MIN_VERIFIED_AFFINITY;
}

/** True when we know the product does not belong in that hobby's slot. */
export function isHobbyRejected(affinity) {
  return typeof affinity === 'number' && affinity <= MAX_REJECTED_AFFINITY;
}

function collectUnrated(items, knownScores) {
  const byHobby = new Map();
  const seen = new Set();
  let total = 0;

  for (const item of items) {
    if (total >= MAX_ITEMS_PER_PASS) break;
    if (!item.asin || !item.hobby_id || !item.title) continue;

    const key = pairKey(item.asin, item.hobby_id);
    if (seen.has(key) || knownScores.has(key)) continue;
    seen.add(key);

    if (!byHobby.has(item.hobby_id)) byHobby.set(item.hobby_id, []);
    byHobby.get(item.hobby_id).push({ asin: item.asin, title: item.title });
    total++;
  }

  return byHobby;
}

/**
 * Classify items we have no verdict for and persist the scores.
 * Returns a map of newly written `${asin}:${hobby_id}` → affinity.
 * Fail-soft: a Claude or DB error leaves those items unrated.
 */
export async function classifyHobbyRelevance(items, hobbyNameById, knownScores = new Map()) {
  const byHobby = collectUnrated(items, knownScores);
  const written = new Map();
  if (byHobby.size === 0) return written;

  const sb = getDb();
  const unrated = [...byHobby.values()].reduce((n, list) => n + list.length, 0);
  count('relevance_items_classified', unrated);

  const classifyBatch = async (hobbyId, hobbyName, batch) => {
    try {
      const scores = await rateHobbyRelevance(hobbyName, batch);
      const rows = batch
        .filter((p) => scores.has(p.asin))
        .map((p) => ({
          item_asin: p.asin,
          hobby_id: hobbyId,
          affinity: scores.get(p.asin),
          title: p.title,
          model: CLAUDE_MODEL,
          checked_at: new Date().toISOString(),
        }));
      if (rows.length === 0) return;

      const { error } = await sb
        .from('item_hobby_relevance')
        .upsert(rows, { onConflict: 'item_asin,hobby_id' });
      if (error) throw new Error(error.message);

      for (const row of rows) {
        written.set(pairKey(row.item_asin, row.hobby_id), row.affinity);
      }
    } catch (err) {
      console.error(
        `[Relevance] Classification failed for "${hobbyName}":`,
        err.message ?? err,
      );
    }
  };

  // One batch per (hobby, chunk), all at once. These were sequential, which cost
  // a full Claude round trip each — ~1.4s apiece even for a handful of items —
  // while the user waited on the feed request.
  const batches = [];
  for (const [hobbyId, products] of byHobby) {
    const hobbyName = hobbyNameById.get(hobbyId);
    if (!hobbyName) continue;
    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      batches.push([hobbyId, hobbyName, products.slice(i, i + BATCH_SIZE)]);
    }
  }

  const classifyAll = async () => {
    await Promise.all(batches.map((args) => classifyBatch(...args)));
    if (written.size > 0) {
      console.log(`[Relevance] Classified ${written.size} item/hobby pairs`);
    }
    return written;
  };

  return span('relevance.classify', classifyAll, {
    hobbies: byHobby.size,
    items: unrated,
    batches: batches.length,
  });
}

/**
 * Classify the rest of the pool after the response has gone out so later
 * feeds start with more verdicts already on file.
 */
export function classifyUnratedInBackground(items, hobbyNameById, knownScores) {
  setImmediate(() => {
    classifyHobbyRelevance(items, hobbyNameById, knownScores).catch((err) => {
      console.error('[Relevance] Background classification failed:', err.message ?? err);
    });
  });
}
