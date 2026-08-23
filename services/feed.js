/**
 * Feed Generation Engine (§7).
 * Core runtime system — generates ranked, diverse feed batches.
 */

import { getDb } from '../db/index.js';
import { getItemsForSearchTerm, resolveBudgetBuckets } from './amazon.js';
import { loadAngles } from './taxonomy.js';
import { expandCrossHobby } from './claude.js';
import { relationshipAngleMultiplier } from './relationship-priors.js';
import { isGiftCardItem, isGiftCardSearchTerm, MAX_GIFT_CARDS_PER_BATCH } from './product-filters.js';

const ALL_ANGLES = loadAngles().map(a => a.name);

// ── Feed Slot Pattern (§7.1) ──────────────────────────────
const SLOT_PATTERN = [
  'interest', 'interest', 'adjacent', 'interest', 'wildcard',
  'interest', 'occasion', 'interest', 'adjacent', 'interest',
];

const MAX_CONSECUTIVE_SAME_CLUSTER = 2;
const FETCH_CHUNK_SIZE = 6;
const MAX_FETCH_ROUNDS = 20;

/**
 * Round-robin merge per-hobby term lists so no single hobby dominates the fetch
 * order. Without this the interest queue is grouped by hobby and the
 * incremental fetcher drains the first hobby before reaching the others —
 * skewing a multi-hobby feed entirely to one interest.
 */
function interleaveByHobby(byHobby) {
  const lists = [...byHobby.values()];
  const merged = [];
  const maxLen = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      if (i < list.length) merged.push(list[i]);
    }
  }
  return merged;
}

function hobbyLabel(ctx, hobbyId) {
  if (!hobbyId) return null;
  return ctx.hobbyNames?.find((h) => h.id === hobbyId)?.name ?? hobbyId;
}

/** Prefer Fastify/pino logger so Render shows structured JSON like other request logs. */
function feedLog(ctx, msg, data = {}) {
  const payload = { feed: true, ...data };
  if (ctx?.log?.info) {
    ctx.log.info(payload, msg);
  } else {
    console.log(msg, payload);
  }
}

function logGiftCardHit(ctx, phase, item, extra = {}) {
  feedLog(ctx, '[Feed][GiftCard]', {
    phase,
    title: item.title,
    asin: item.asin,
    search_term: item.source_term ?? null,
    slot_type: item.slot_type ?? null,
    angle: item.angle ?? null,
    hobby_id: item.hobby_id ?? null,
    hobby_name: extra.hobby_name ?? null,
    budget_bucket: extra.budget_bucket ?? null,
    ...extra,
  });
}

/**
 * Generate a batch of feed items for a session (§7.2).
 * @param {object} [options]
 * @param {import('fastify').FastifyBaseLogger} [options.log] Fastify request logger (shows on Render)
 */
export async function generateFeed(sessionId, profileId, batchSize = 10, options = {}) {
  const ctx = await loadFeedContext(sessionId, profileId);
  ctx.log = options.log ?? null;

  feedLog(ctx, '[Feed] Profile interests for session', {
    session_id: sessionId,
    profile_id: profileId,
    label: ctx.profile?.label,
    relationship: ctx.profile?.relationship ?? null,
    occasion: ctx.occasion,
    budget: [ctx.profile?.budget_min, ctx.profile?.budget_max],
    interests: (ctx.hobbyNames ?? []).map((h) => ({ id: h.id, name: h.name })),
  });

  const queues = await buildFetchQueues(ctx);
  feedLog(ctx, '[Feed] Fetch queue sizes', {
    interest: queues.interest.length,
    adjacent: queues.adjacent.length,
    wildcard: queues.wildcard.length,
    occasion: queues.occasion.length,
  });

  const itemPool = await fetchItemPoolIncremental(queues, ctx, batchSize);
  const filtered = filterItemPool(itemPool, ctx);

  const giftCardsInPool = filtered.filter(isGiftCardItem);
  feedLog(ctx, '[Feed] Pool summary', {
    pool: itemPool.length,
    after_filters: filtered.length,
    gift_cards_in_filtered_pool: giftCardsInPool.length,
  });
  for (const item of giftCardsInPool) {
    logGiftCardHit(ctx, 'in_filtered_pool', item, {
      hobby_name: hobbyLabel(ctx, item.hobby_id),
    });
  }

  const feed = fillFeedSlots(
    filtered,
    batchSize,
    ctx.weights,
    ctx.asinLastSeen,
    ctx.profile?.relationship ?? null,
  );

  for (const item of feed) {
    if (isGiftCardItem(item)) {
      logGiftCardHit(ctx, 'served_in_batch', item, {
        hobby_name: hobbyLabel(ctx, item.hobby_id),
        score: item.score,
      });
    }
  }

  return insertFeedEvents(ctx.sb, sessionId, profileId, feed, ctx.hobbyNames);
}

/**
 * Warm a subset of cache keys in the background after session start.
 * Fire-and-forget — does not block the HTTP response.
 */
export function prefetchFeedCache(profileId, occasion) {
  setImmediate(async () => {
    try {
      const ctx = await loadFeedContext(null, profileId, occasion);
      const queues = await buildFetchQueues(ctx);
      const warmPerSlot = 2;
      const tasks = [];
      for (const slotType of ['interest', 'adjacent', 'wildcard', 'occasion']) {
        for (const entry of (queues[slotType] ?? []).slice(0, warmPerSlot)) {
          tasks.push(getItemsForSearchTerm(entry.term, entry.bucket));
        }
      }
      await Promise.all(tasks);
    } catch (err) {
      console.error('[Feed] Prefetch error:', err.message);
    }
  });
}

// ── Context loading ───────────────────────────────────────

async function loadFeedContext(sessionId, profileId, occasionOverride) {
  const sb = getDb();

  const { data: profile, error: profileErr } = await sb
    .from('profiles').select('*').eq('id', profileId).single();
  if (profileErr || !profile) throw new Error('Profile not found');

  const { data: weightsRows } = await sb
    .from('profile_weights').select('*').eq('profile_id', profileId);
  const weights = {};
  for (const w of (weightsRows ?? [])) {
    weights[`${w.hobby_id}:${w.angle}`] = w;
  }

  let occasion = occasionOverride;
  if (!occasion && sessionId) {
    const { data: session } = await sb
      .from('sessions').select('occasion').eq('id', sessionId).single();
    occasion = session?.occasion ?? 'just_because';
  }
  occasion ??= 'just_because';

  const { data: suppressions } = await sb
    .from('dislike_suppressions').select('*').eq('profile_id', profileId);
  const suppressedAsins = new Set();
  const suppressedClusters = new Set();
  for (const s of (suppressions ?? [])) {
    if (s.suppression_type === 'item') suppressedAsins.add(s.item_asin);
    if (s.suppression_type === 'cluster') suppressedClusters.add(`${s.hobby_id}:${s.angle}`);
  }

  const { data: recentEvents } = await sb
    .from('feed_events')
    .select('item_asin, signal, served_at')
    .eq('profile_id', profileId)
    .order('served_at', { ascending: false })
    .limit(500);

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const recentlyServed = new Set();
  const asinLastSeen = {};

  for (const e of (recentEvents ?? [])) {
    if (!asinLastSeen[e.item_asin]) {
      asinLastSeen[e.item_asin] = (now - new Date(e.served_at).getTime()) / (1000 * 60 * 60 * 24);
    }
    if (e.signal === 'save' || e.signal === 'shop_now' || e.signal === 'dislike') {
      recentlyServed.add(e.item_asin);
    } else if (e.signal === 'skip') {
      if (now - new Date(e.served_at).getTime() < THIRTY_DAYS_MS) {
        recentlyServed.add(e.item_asin);
      }
    } else {
      recentlyServed.add(e.item_asin);
    }
  }

  const hobbyIds = profile.hobby_ids ?? [];
  let hobbyNames = [];
  if (hobbyIds.length > 0) {
    const { data: hobbyRows } = await sb
      .from('hobbies').select('id, name').in('id', hobbyIds);
    hobbyNames = hobbyRows ?? [];
  }

  return {
    sb,
    profile,
    weights,
    occasion,
    suppressedAsins,
    suppressedClusters,
    recentlyServed,
    asinLastSeen,
    budgetBuckets: resolveBudgetBuckets(profile.budget_min, profile.budget_max),
    hobbyIds,
    hobbyNames,
  };
}

// ── Fetch queue construction ──────────────────────────────

async function buildFetchQueues(ctx) {
  const { sb, hobbyIds, hobbyNames, budgetBuckets, occasion } = ctx;
  const queues = { interest: [], adjacent: [], wildcard: [], occasion: [] };

  if (hobbyIds.length > 0) {
    const { data: expansions } = await sb
      .from('hobby_angle_expansions')
      .select('hobby_id, angle, search_terms')
      .in('hobby_id', hobbyIds);

    // Group terms per hobby so we can interleave across hobbies below —
    // otherwise the queue is grouped by hobby and the fetcher drains the first
    // one, skewing the batch to a single interest.
    const interestByHobby = new Map();
    const wildcardByHobby = new Map();
    for (const exp of (expansions ?? [])) {
      const isWild = exp.angle === 'wildcard';
      const group = isWild ? wildcardByHobby : interestByHobby;
      if (!group.has(exp.hobby_id)) group.set(exp.hobby_id, []);
      const list = group.get(exp.hobby_id);
      const slotType = isWild ? 'wildcard' : 'interest';
      for (const bucket of budgetBuckets) {
        // Skip terms that explicitly search for gift cards (legacy Claude expansions).
        const terms = (exp.search_terms ?? [])
          .filter((term) => !isGiftCardSearchTerm(term))
          .slice(0, 3);
        for (const term of terms) {
          list.push({
            term,
            bucket,
            meta: { hobby_id: exp.hobby_id, angle: exp.angle, slot_type: slotType },
          });
        }
      }
    }
    queues.interest = interleaveByHobby(interestByHobby);
    queues.wildcard = interleaveByHobby(wildcardByHobby);
  }

  if (hobbyIds.length >= 2) {
    const comboKey = `cross_hobby:${hobbyNames.map(h => h.name).sort().join('_')}`;
    const { data: crossRow } = await sb
      .from('cross_hobby_expansions')
      .select('search_terms')
      .eq('combo_key', comboKey)
      .maybeSingle();

    let crossTerms = crossRow?.search_terms ?? null;
    if (!crossTerms) {
      try {
        crossTerms = await expandCrossHobby(hobbyNames.map(h => h.name));
        await sb.from('cross_hobby_expansions').upsert({
          combo_key: comboKey,
          search_terms: crossTerms,
          computed_at: new Date().toISOString(),
        }, { onConflict: 'combo_key' });
      } catch (err) {
        console.error('[Feed] Cross-hobby expansion error:', err.message);
        crossTerms = [];
      }
    }

    for (const bucket of budgetBuckets) {
      for (const term of (crossTerms ?? []).filter((t) => !isGiftCardSearchTerm(t)).slice(0, 3)) {
        queues.adjacent.push({
          term,
          bucket,
          meta: { hobby_id: null, angle: null, slot_type: 'adjacent' },
        });
      }
    }
  }

  if (budgetBuckets.length > 0) {
    const { data: occasionRows } = await sb
      .from('occasion_search_terms')
      .select('budget_bucket, search_terms')
      .eq('occasion', occasion)
      .in('budget_bucket', budgetBuckets);

    for (const row of (occasionRows ?? [])) {
      for (const term of (row.search_terms ?? []).filter((t) => !isGiftCardSearchTerm(t)).slice(0, 3)) {
        queues.occasion.push({
          term,
          bucket: row.budget_bucket,
          meta: { hobby_id: null, angle: null, slot_type: 'occasion' },
        });
      }
    }
  }

  return queues;
}

// ── Incremental cache/API fetch ───────────────────────────

function slotTypesNeeded(batchSize) {
  const types = new Set();
  for (let i = 0; i < batchSize; i++) {
    types.add(SLOT_PATTERN[i % SLOT_PATTERN.length]);
  }
  return types;
}

function countBySlotType(items) {
  const counts = { interest: 0, adjacent: 0, wildcard: 0, occasion: 0 };
  for (const item of items) {
    if (counts[item.slot_type] !== undefined) counts[item.slot_type]++;
  }
  return counts;
}

function pickFetchChunk(queues, cursors, chunkSize, filtered, batchSize) {
  const chunk = [];
  const needed = slotTypesNeeded(batchSize);
  const counts = countBySlotType(filtered);
  const slotOrder = [...needed].sort((a, b) => counts[a] - counts[b]);

  for (const slotType of slotOrder) {
    const queue = queues[slotType] ?? [];
    while (chunk.length < chunkSize && cursors[slotType] < queue.length) {
      chunk.push(queue[cursors[slotType]++]);
    }
  }

  if (chunk.length < chunkSize) {
    for (const slotType of ['interest', 'adjacent', 'wildcard', 'occasion']) {
      const queue = queues[slotType] ?? [];
      while (chunk.length < chunkSize && cursors[slotType] < queue.length) {
        chunk.push(queue[cursors[slotType]++]);
      }
    }
  }

  return chunk;
}

function queuesExhausted(queues, cursors) {
  return ['interest', 'adjacent', 'wildcard', 'occasion'].every(
    slot => (cursors[slot] ?? 0) >= (queues[slot] ?? []).length
  );
}

function hasEnoughCandidates(filtered, batchSize) {
  if (filtered.length < batchSize) return false;

  const needed = slotTypesNeeded(batchSize);
  const counts = countBySlotType(filtered);

  for (const slot of needed) {
    if (counts[slot] < 1 && filtered.length < batchSize * 2) return false;
  }

  return filtered.length >= batchSize * 2
    || canFillFeedSlots(filtered, batchSize, {}, {});
}

async function fetchItemPoolIncremental(queues, ctx, batchSize) {
  const itemPool = [];
  const cursors = { interest: 0, adjacent: 0, wildcard: 0, occasion: 0 };

  for (let round = 0; round < MAX_FETCH_ROUNDS; round++) {
    const filtered = filterItemPool(itemPool, ctx);
    if (hasEnoughCandidates(filtered, batchSize)) break;
    if (queuesExhausted(queues, cursors)) break;

    const chunk = pickFetchChunk(queues, cursors, FETCH_CHUNK_SIZE, filtered, batchSize);
    if (chunk.length === 0) break;

    const results = await Promise.all(
      chunk.map(async ({ term, bucket, meta }) => {
        const items = await getItemsForSearchTerm(term, bucket);
        const tagged = items.map(item => ({ ...item, ...meta, source_term: term }));

        const giftCards = tagged.filter(isGiftCardItem);
        if (giftCards.length > 0) {
          feedLog(ctx, '[Feed][GiftCard] Amazon/cache results for search', {
            search_term: term,
            budget_bucket: bucket,
            slot_type: meta.slot_type,
            angle: meta.angle,
            hobby_id: meta.hobby_id,
            hobby_name: hobbyLabel(ctx, meta.hobby_id),
            total_items: tagged.length,
            gift_card_count: giftCards.length,
            gift_card_titles: giftCards.map((g) => g.title),
          });
        }

        return tagged;
      })
    );
    for (const items of results) itemPool.push(...items);
  }

  return itemPool;
}

// ── Filter + slot fill ────────────────────────────────────

function filterItemPool(itemPool, ctx) {
  const { profile, recentlyServed, suppressedAsins, suppressedClusters } = ctx;
  const seen = new Set();

  return itemPool.filter(item => {
    if (seen.has(item.asin)) return false;
    seen.add(item.asin);
    if (recentlyServed.has(item.asin)) return false;
    if (suppressedAsins.has(item.asin)) return false;
    if (item.hobby_id && item.angle && suppressedClusters.has(`${item.hobby_id}:${item.angle}`)) return false;
    if (item.price > 0 && (item.price < profile.budget_min || item.price > profile.budget_max)) return false;
    return true;
  });
}

function canFillFeedSlots(filtered, batchSize, weights, asinLastSeen, relationship = null) {
  return fillFeedSlots(filtered, batchSize, weights, asinLastSeen, relationship).length >= batchSize;
}

function fillFeedSlots(filtered, batchSize, weights, asinLastSeen, relationship = null) {
  const feed = [];
  const usedAsins = new Set();
  const lastClusters = [];
  let giftCardsPicked = 0;

  for (let i = 0; i < batchSize; i++) {
    const slotType = SLOT_PATTERN[i % SLOT_PATTERN.length];
    const giftCardCapReached = giftCardsPicked >= MAX_GIFT_CARDS_PER_BATCH;

    let candidates = filtered
      .filter(item => {
        if (usedAsins.has(item.asin) || item.slot_type !== slotType) return false;
        if (giftCardCapReached && isGiftCardItem(item)) return false;
        return true;
      })
      .map(item => ({
        ...item,
        score: scoreItem(item, weights, asinLastSeen, lastClusters, relationship),
      }));

    if (candidates.length === 0) {
      candidates = filtered
        .filter(item => {
          if (usedAsins.has(item.asin)) return false;
          if (giftCardCapReached && isGiftCardItem(item)) return false;
          return true;
        })
        .map(item => ({
          ...item,
          score: scoreItem(item, weights, asinLastSeen, lastClusters, relationship),
        }));
    }
    if (candidates.length === 0) break;

    // Prefer real products over gift cards when scores are close.
    candidates.sort((a, b) => {
      const aGift = isGiftCardItem(a) ? 1 : 0;
      const bGift = isGiftCardItem(b) ? 1 : 0;
      if (aGift !== bGift) return aGift - bGift;
      return b.score - a.score;
    });

    let picked = null;
    for (const c of candidates) {
      const clusterKey = c.hobby_id && c.angle ? `${c.hobby_id}:${c.angle}` : null;
      if (clusterKey) {
        const recentSame = lastClusters.slice(-MAX_CONSECUTIVE_SAME_CLUSTER).filter(k => k === clusterKey).length;
        if (recentSame >= MAX_CONSECUTIVE_SAME_CLUSTER) continue;
      }
      picked = c;
      break;
    }
    if (!picked) picked = candidates[0];
    if (!picked) break;

    feed.push(picked);
    usedAsins.add(picked.asin);
    if (isGiftCardItem(picked)) giftCardsPicked += 1;
    lastClusters.push(picked.hobby_id && picked.angle ? `${picked.hobby_id}:${picked.angle}` : 'none');
  }

  return feed;
}

async function insertFeedEvents(sb, sessionId, profileId, feed, hobbyRows = []) {
  if (feed.length === 0) return [];

  const hobbyNameById = new Map((hobbyRows ?? []).map((h) => [h.id, h.name]));

  // Resolve any hobby_ids not already loaded with the profile (rare).
  const missingIds = [
    ...new Set(
      feed
        .map((item) => item.hobby_id)
        .filter((id) => id && !hobbyNameById.has(id))
    ),
  ];
  if (missingIds.length > 0) {
    const { data: extra } = await sb
      .from('hobbies')
      .select('id, name')
      .in('id', missingIds);
    for (const row of extra ?? []) {
      hobbyNameById.set(row.id, row.name);
    }
  }

  const rows = feed.map(item => ({
    session_id: sessionId,
    profile_id: profileId,
    item_asin: item.asin,
    item_snapshot: {
      title: item.title,
      price: item.price,
      image_url: item.image_url,
      product_url: item.product_url,
      rating: item.rating ?? null,
      ratings_total: item.ratings_total ?? null,
    },
    hobby_id: item.hobby_id ?? null,
    angle: item.angle ?? null,
    slot_type: item.slot_type,
  }));

  const { data: inserted } = await sb.from('feed_events').insert(rows).select('id, item_asin');
  const eventMap = {};
  for (const e of (inserted ?? [])) eventMap[e.item_asin] = e.id;

  return feed.map(item => ({
    feed_event_id: eventMap[item.asin],
    asin: item.asin,
    title: item.title,
    price: item.price,
    image_url: item.image_url,
    product_url: item.product_url,
    category: item.category,
    rating: item.rating ?? null,
    ratings_total: item.ratings_total ?? null,
    slot_type: item.slot_type,
    hobby_id: item.hobby_id,
    hobby_name: item.hobby_id ? (hobbyNameById.get(item.hobby_id) ?? null) : null,
    angle: item.angle,
    score: item.score,
  }));
}

/**
 * Score an item (§7.3).
 * score = baseWeight * cooldown * recency * diversity * relationshipPrior + noise
 * Relationship prior is mild (±~8% max) and only applies when angle is known.
 */
function scoreItem(item, weights, asinLastSeen, recentClusters, relationship = null) {
  const clusterKey = item.hobby_id && item.angle ? `${item.hobby_id}:${item.angle}` : null;
  const w = clusterKey ? weights[clusterKey] : null;
  const baseWeight = w?.weight ?? 1.0;

  let cooldownMultiplier = 1.0;
  if (w?.cooldown_until && new Date(w.cooldown_until) > new Date()) {
    cooldownMultiplier = 0.2;
  }

  const daysSinceSeen = asinLastSeen[item.asin] ?? 30;
  const recencyBonus = Math.min(daysSinceSeen / 30, 1.5);

  const last2 = recentClusters.slice(-2);
  const diversityBonus = (clusterKey && last2.includes(clusterKey)) ? 0.5 : 1.2;

  const relMultiplier = relationshipAngleMultiplier(relationship, item.angle);

  return (
    baseWeight *
      cooldownMultiplier *
      recencyBonus *
      diversityBonus *
      relMultiplier +
    Math.random() * 0.1
  );
}
