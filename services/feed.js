/**
 * Feed Generation Engine (§7).
 * Core runtime system — generates ranked, diverse feed batches.
 */

import { getDb } from '../db/index.js';
import { findWarmCacheKeys, getItemsForSearchTerm, resolveBudgetBuckets } from './amazon.js';
import { loadAngles } from './taxonomy.js';
import { expandCrossHobby } from './claude.js';
import { relationshipAngleMultiplier } from './relationship-priors.js';
import { isGiftCardItem, isGiftCardSearchTerm, MAX_GIFT_CARDS_PER_BATCH, isSameProductListing, normalizeProductTitle } from './product-filters.js';
import {
  classifyHobbyRelevance,
  classifyUnratedInBackground,
  isHobbyRejected,
  isHobbyVerified,
  loadHobbyRelevance,
} from './relevance.js';
import { addMeta, count, note, reportTrace, runDetached, span, syncSpan } from './diag.js';

const ALL_ANGLES = loadAngles().map(a => a.name);

// ── Feed Slot Pattern (§7.1) ──────────────────────────────
const SLOT_PATTERN = [
  'interest', 'interest', 'adjacent', 'interest', 'wildcard',
  'interest', 'occasion', 'interest', 'adjacent', 'interest',
];

const MAX_CONSECUTIVE_SAME_CLUSTER = 2;

// Searches run as a continuous pool rather than in fixed rounds, so this is how
// many may be in flight at once, not a barrier width. A live Canopy search takes
// seconds, so the work is entirely I/O-bound; a cold batch needs ~13 searches,
// and fitting those into one wave is what keeps a cold start near the cost of a
// single search rather than a multiple of it. Canopy's request rate is still
// paced by the throttle in amazon.js.
const FETCH_CONCURRENCY = Number(process.env.FEED_FETCH_CONCURRENCY ?? 10);

// Hard ceiling on searches per batch, so an unproductive queue can't spin.
const MAX_FETCH_TERMS = Number(process.env.FEED_MAX_FETCH_TERMS ?? 60);

// How long a request will wait on Claude relevance verdicts before serving the
// batch unlabelled and letting classification finish in the background. 0 waits
// indefinitely (the previous behaviour).
const RELEVANCE_BUDGET_MS = Number(process.env.FEED_RELEVANCE_BUDGET_MS ?? 1500);

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
  const ctx = await span('loadFeedContext', () => loadFeedContext(sessionId, profileId));
  ctx.log = options.log ?? null;

  addMeta({
    profile: ctx.profile?.label,
    hobbies: (ctx.hobbyNames ?? []).length,
    occasion: ctx.occasion,
    budget: `${ctx.profile?.budget_min}-${ctx.profile?.budget_max}`,
    buckets: ctx.budgetBuckets.length,
    batch: batchSize,
  });
  note('recently_served_asins', ctx.recentlyServed.size);
  note('suppressed_asins', ctx.suppressedAsins.size);

  feedLog(ctx, '[Feed] Profile interests for session', {
    session_id: sessionId,
    profile_id: profileId,
    label: ctx.profile?.label,
    relationship: ctx.profile?.relationship ?? null,
    occasion: ctx.occasion,
    budget: [ctx.profile?.budget_min, ctx.profile?.budget_max],
    interests: (ctx.hobbyNames ?? []).map((h) => ({ id: h.id, name: h.name })),
  });

  const queues = await span('buildFetchQueues', () => buildFetchQueues(ctx));
  await span('orderQueuesCacheFirst', () => orderQueuesCacheFirst(queues));
  feedLog(ctx, '[Feed] Fetch queue sizes', {
    interest: queues.interest.length,
    adjacent: queues.adjacent.length,
    wildcard: queues.wildcard.length,
    occasion: queues.occasion.length,
  });
  note('queue_sizes', {
    interest: queues.interest.length,
    adjacent: queues.adjacent.length,
    wildcard: queues.wildcard.length,
    occasion: queues.occasion.length,
  });

  // The fetch loop already filters the pool as it grows, so its result is reused
  // here rather than filtering the finished pool a second time.
  const { itemPool, filtered } = await span(
    'fetchItemPool',
    () => fetchItemPoolIncremental(queues, ctx, batchSize),
  );
  note('pool_size', itemPool.length);
  note('pool_after_filters', filtered.length);
  note('pool_by_slot_type', countBySlotType(filtered));

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

  const hobbyNameById = new Map((ctx.hobbyNames ?? []).map((h) => [h.id, h.name]));

  // Score the cards we are about to show *before* insert. Background-only
  // classification is too late: served ASINs are suppressed, so the user
  // never sees the hobby chip on an item we only labelled after they left.
  let feed = syncSpan('fillFeedSlots', () => fillFeedSlots(
    filtered,
    batchSize,
    ctx.weights,
    ctx.asinLastSeen,
    ctx.profile?.relationship ?? null,
  ));
  feed = await span(
    'finalizeFeedRelevance',
    () => finalizeFeedRelevance(feed, filtered, ctx, batchSize, hobbyNameById),
    { picked: feed.length },
  );

  for (const item of feed) {
    if (isGiftCardItem(item)) {
      logGiftCardHit(ctx, 'served_in_batch', item, {
        hobby_name: hobbyLabel(ctx, item.hobby_id),
        score: item.score,
      });
    }
  }

  const events = await span('insertFeedEvents', () => insertFeedEvents(
    ctx.sb, sessionId, profileId, feed, ctx.hobbyNames, ctx.relevance,
  ), { rows: feed.length });
  note('items_returned', events.length);

  classifyUnratedInBackground(filtered, hobbyNameById, ctx.relevance);

  return events;
}

/**
 * Warm a subset of cache keys in the background after session start.
 * Fire-and-forget — does not block the HTTP response.
 */
export function prefetchFeedCache(profileId, occasion) {
  setImmediate(async () => {
    try {
      // Traced separately: this runs after the session response has gone out, so
      // its cost shows up to the user as polling time, not request time.
      await runDetached('feed.prefetch', { profile_id: profileId, occasion }, async () => {
        const ctx = await span('loadFeedContext', () => loadFeedContext(null, profileId, occasion));
        const queues = await span('buildFetchQueues', () => buildFetchQueues(ctx));
        // Warm roughly what a first batch consumes rather than a token couple of
        // terms. This runs while the client is polling a preparing feed, so time
        // spent here is time the user was already going to wait — and it turns
        // their first real request from ~13 live searches into mostly hits.
        const warmPerSlot = Number(process.env.FEED_PREFETCH_PER_SLOT ?? 4);
        const tasks = [];
        for (const slotType of ['interest', 'adjacent', 'wildcard', 'occasion']) {
          for (const entry of (queues[slotType] ?? []).slice(0, warmPerSlot)) {
            tasks.push(getItemsForSearchTerm(entry.term, entry.bucket));
          }
        }
        note('terms_warmed', tasks.length);
        await span('warmCache', () => Promise.all(tasks), { terms: tasks.length });
      }, reportTrace);
    } catch (err) {
      console.error('[Feed] Prefetch error:', err.message);
    }
  });
}

// ── Context loading ───────────────────────────────────────

async function loadFeedContext(sessionId, profileId, occasionOverride) {
  const sb = getDb();

  // One wave instead of five sequential round trips: none of these depend on
  // each other, and at ~150ms each the serial version cost most of a second
  // before any search had started.
  const [
    { data: profile, error: profileErr },
    { data: weightsRows },
    { data: sessionRow },
    { data: suppressions },
    { data: recentEvents },
  ] = await Promise.all([
    sb.from('profiles').select('*').eq('id', profileId).single(),
    sb.from('profile_weights').select('*').eq('profile_id', profileId),
    !occasionOverride && sessionId
      ? sb.from('sessions').select('occasion').eq('id', sessionId).single()
      : Promise.resolve({ data: null }),
    sb.from('dislike_suppressions').select('*').eq('profile_id', profileId),
    sb.from('feed_events')
      .select('item_asin, item_snapshot, signal, served_at')
      .eq('profile_id', profileId)
      .order('served_at', { ascending: false })
      .limit(500),
  ]);
  if (profileErr || !profile) throw new Error('Profile not found');

  const weights = {};
  for (const w of (weightsRows ?? [])) {
    weights[`${w.hobby_id}:${w.angle}`] = w;
  }

  const occasion = occasionOverride ?? sessionRow?.occasion ?? 'just_because';

  const suppressedAsins = new Set();
  const suppressedClusters = new Set();
  for (const s of (suppressions ?? [])) {
    if (s.suppression_type === 'item') suppressedAsins.add(s.item_asin);
    if (s.suppression_type === 'cluster') suppressedClusters.add(`${s.hobby_id}:${s.angle}`);
  }

  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const recentlyServed = new Set();
  const recentlyServedTitles = new Set();
  const asinLastSeen = {};

  for (const e of (recentEvents ?? [])) {
    if (!asinLastSeen[e.item_asin]) {
      asinLastSeen[e.item_asin] = (now - new Date(e.served_at).getTime()) / (1000 * 60 * 60 * 24);
    }
    const titleKey = normalizeProductTitle(e.item_snapshot?.title);
    if (e.signal === 'save' || e.signal === 'shop_now' || e.signal === 'dislike') {
      recentlyServed.add(e.item_asin);
      if (titleKey) recentlyServedTitles.add(titleKey);
    } else if (e.signal === 'skip') {
      if (now - new Date(e.served_at).getTime() < THIRTY_DAYS_MS) {
        recentlyServed.add(e.item_asin);
        if (titleKey) recentlyServedTitles.add(titleKey);
      }
    } else {
      recentlyServed.add(e.item_asin);
      if (titleKey) recentlyServedTitles.add(titleKey);
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
    recentlyServedTitles,
    asinLastSeen,
    budgetBuckets: resolveBudgetBuckets(profile.budget_min, profile.budget_max),
    hobbyIds,
    hobbyNames,
    // `${asin}:${hobby_id}` → affinity, filled in as the pool is fetched.
    relevance: new Map(),
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
      // Computing this is a ~6s Claude call, and it only feeds `adjacent` — two
      // slots out of ten, which fall back to other slot types when empty. Making
      // every card in a new profile's first batch wait on it isn't worth that, so
      // it's computed in the background and picked up from cache next batch.
      note('cross_hobby_expansion', 'deferred_to_background');
      count('cross_hobby_deferred');
      crossTerms = [];
      runDetached('feed.crossHobbyExpansion', { combo_key: comboKey }, async () => {
        const terms = await expandCrossHobby(hobbyNames.map(h => h.name));
        await sb.from('cross_hobby_expansions').upsert({
          combo_key: comboKey,
          search_terms: terms,
          computed_at: new Date().toISOString(),
        }, { onConflict: 'combo_key' });
      }, reportTrace).catch(err => {
        console.error('[Feed] Cross-hobby expansion error:', err.message);
      });
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

const SLOT_TYPES = ['interest', 'adjacent', 'wildcard', 'occasion'];

/**
 * Move already-cached searches to the front of every queue.
 *
 * A cached search returns in ~200ms and a live one took ~6s on measurement, so
 * ordering by warmth is the difference between filling a batch from cache and
 * paying Canopy for it. Relative order within the warm and cold groups is kept,
 * which preserves the per-hobby interleaving built above.
 */
async function orderQueuesCacheFirst(queues) {
  const entries = SLOT_TYPES.flatMap((slot) => queues[slot] ?? []);
  if (entries.length === 0) return;

  const warm = await findWarmCacheKeys(entries);
  if (warm.size === 0) {
    note('warm_terms', 0);
    return;
  }

  const isWarm = (entry) => warm.has(`${entry.term}::${entry.bucket}`);
  for (const slot of SLOT_TYPES) {
    const queue = queues[slot] ?? [];
    queues[slot] = [...queue.filter(isWarm), ...queue.filter((e) => !isWarm(e))];
  }
  note('warm_terms', warm.size);
  note('total_terms', entries.length);
}

/** How many slots of each type a batch of this size needs. */
function slotDemand(batchSize) {
  const demand = { interest: 0, adjacent: 0, wildcard: 0, occasion: 0 };
  for (let i = 0; i < batchSize; i++) {
    demand[SLOT_PATTERN[i % SLOT_PATTERN.length]]++;
  }
  return demand;
}

/**
 * Choose the next search to run: the slot type furthest from having its share of
 * the batch filled, counting both candidates already found and searches still in
 * flight. Picking one at a time (rather than a fixed chunk per slot type) keeps
 * every slot type progressing together, so a batch can usually be filled in one
 * wave instead of needing a second and third round.
 */
function pickNextTerm(queues, cursors, filtered, demand, inflight) {
  const counts = countBySlotType(filtered);
  const available = SLOT_TYPES.filter(
    (slot) => cursors[slot] < (queues[slot] ?? []).length,
  );
  if (available.length === 0) return null;

  const wanted = available.filter((slot) => demand[slot] > 0);
  const pool = wanted.length > 0 ? wanted : available;
  const satisfaction = (slot) =>
    (counts[slot] + (inflight[slot] ?? 0)) / (demand[slot] || 0.5);

  pool.sort((a, b) => satisfaction(a) - satisfaction(b));
  const slot = pool[0];
  return queues[slot][cursors[slot]++];
}

/**
 * @param {(slotType: string) => boolean} [canStillCover] Whether more searches
 *   could yet produce a candidate for a slot type. Fetching stops as soon as the
 *   batch is fillable, so without this a slot type with no candidates yet —
 *   wildcard, typically, since the pattern only asks for one — gets dropped from
 *   the batch instead of waited for.
 */
function hasEnoughCandidates(filtered, batchSize, canStillCover = () => false) {
  if (filtered.length < batchSize) return false;

  const needed = slotTypesNeeded(batchSize);
  const counts = countBySlotType(filtered);

  for (const slot of needed) {
    if (counts[slot] < 1 && canStillCover(slot)) return false;
  }

  return filtered.length >= batchSize * 2
    || canFillFeedSlots(filtered, batchSize, {}, {});
}

/**
 * Fetch until the batch can be filled, running searches as a continuous pool.
 *
 * The previous shape was fixed rounds of six: every round waited for its slowest
 * search before the next could start, so three rounds cost the sum of three
 * worst cases rather than the worst case overall. Here a finished worker starts
 * its next search immediately, and the whole pool stops as soon as there are
 * enough candidates — searches already in flight are allowed to land, since
 * their cost is sunk and their items are still useful.
 */
async function fetchItemPoolIncremental(queues, ctx, batchSize) {
  const itemPool = [];
  const cursors = { interest: 0, adjacent: 0, wildcard: 0, occasion: 0 };
  const inflight = { interest: 0, adjacent: 0, wildcard: 0, occasion: 0 };
  const demand = slotDemand(batchSize);

  const refilter = createIncrementalPoolFilter(ctx);
  let filtered = [];
  let dispatched = 0;
  let stoppedBecause = 'queues_exhausted';
  let stop = false;

  // Relevance lookups are coalesced: items from concurrent searches are pooled
  // and looked up together, so the pool isn't issuing one query per search.
  let pendingRelevance = [];
  let relevanceInFlight = null;

  // Only hold out for a slot type that still has unused terms and budget left,
  // so a slot whose searches keep coming back empty can't stall the batch.
  const canStillCover = (slotType) =>
    dispatched < MAX_FETCH_TERMS
    && cursors[slotType] < (queues[slotType] ?? []).length;

  const drainRelevance = async () => {
    if (relevanceInFlight) return relevanceInFlight;
    if (pendingRelevance.length === 0) return;
    const batch = pendingRelevance;
    pendingRelevance = [];
    relevanceInFlight = (async () => {
      for (const [key, affinity] of await loadHobbyRelevance(batch)) {
        ctx.relevance.set(key, affinity);
      }
    })().finally(() => { relevanceInFlight = null; });
    return relevanceInFlight;
  };

  const worker = async () => {
    while (!stop) {
      if (dispatched >= MAX_FETCH_TERMS) {
        stoppedBecause = 'max_terms';
        stop = true;
        return;
      }

      const entry = pickNextTerm(queues, cursors, filtered, demand, inflight);
      if (!entry) return;

      const { term, bucket, meta } = entry;
      dispatched += 1;
      inflight[meta.slot_type] = (inflight[meta.slot_type] ?? 0) + 1;

      try {
        const items = await getItemsForSearchTerm(term, bucket);
        const tagged = items.map((item) => ({ ...item, ...meta, source_term: term }));

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

        itemPool.push(...tagged);
        pendingRelevance.push(...tagged);
      } finally {
        inflight[meta.slot_type] -= 1;
      }

      // Verdicts must land before the candidate count is trusted, or rejected
      // items would be counted as fillable and the loop would stop early.
      await drainRelevance();

      const cpuStartedAt = performance.now();
      filtered = refilter(itemPool);
      const enough = hasEnoughCandidates(filtered, batchSize, canStillCover);
      count('cpu_filter_and_slotfill_ms', performance.now() - cpuStartedAt);

      if (enough) {
        stoppedBecause = 'enough_candidates';
        stop = true;
      }
    }
  };

  await span(
    'searchPool',
    () => Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker)),
    { concurrency: FETCH_CONCURRENCY },
  );
  await drainRelevance();

  note('fetch_loop_exit', stoppedBecause);
  note('searches_run', dispatched);
  // Verdicts from that last drain may not have been applied yet, and searches
  // still in flight when the loop stopped have since landed.
  return { itemPool, filtered: refilter(itemPool) };
}

// ── Filter + slot fill ────────────────────────────────────

/**
 * A stateful accept-or-reject test for one item, holding the dedupe bookkeeping
 * for everything it has already accepted.
 */
function createItemFilter(ctx) {
  const { profile, recentlyServed, recentlyServedTitles, suppressedAsins, suppressedClusters, relevance } = ctx;
  const seenAsins = new Set();
  const seenTitles = new Set();
  const kept = [];

  return (item) => {
    if (seenAsins.has(item.asin)) return false;
    const titleKey = normalizeProductTitle(item.title);
    if (titleKey && seenTitles.has(titleKey)) return false;
    if (recentlyServed.has(item.asin)) return false;
    if (titleKey && recentlyServedTitles?.has(titleKey)) return false;
    if (suppressedAsins.has(item.asin)) return false;
    if (item.hobby_id && item.angle && suppressedClusters.has(`${item.hobby_id}:${item.angle}`)) return false;
    if (item.hobby_id && isHobbyRejected(relevance?.get(`${item.asin}:${item.hobby_id}`))) return false;
    if (item.price > 0 && (item.price < profile.budget_min || item.price > profile.budget_max)) return false;
    if (kept.some((other) => isSameProductListing(other, item))) return false;

    seenAsins.add(item.asin);
    if (titleKey) seenTitles.add(titleKey);
    kept.push(item);
    return true;
  };
}

/**
 * Filters the pool as it grows, for callers that re-check after every search.
 *
 * Comparing each item against everything kept so far is quadratic, so filtering
 * the whole pool from scratch on every completion cost seconds of CPU on a cold
 * batch — the work was redone once per search instead of once per item. This
 * carries the kept list between passes and only tests what has newly arrived.
 */
function createIncrementalPoolFilter(ctx) {
  const accept = createItemFilter(ctx);
  let kept = [];
  let cursor = 0;

  return (itemPool) => {
    for (; cursor < itemPool.length; cursor += 1) {
      if (accept(itemPool[cursor])) kept.push(itemPool[cursor]);
    }
    // A relevance verdict can land after its item was first accepted, so
    // rejections are re-applied each pass. That check is per-item, not pairwise.
    kept = kept.filter((item) => !isRejectedByRelevance(item, ctx.relevance));
    return kept;
  };
}

function relevanceKey(item) {
  return item.hobby_id ? `${item.asin}:${item.hobby_id}` : null;
}

function isRejectedByRelevance(item, relevance) {
  const key = relevanceKey(item);
  return Boolean(key && isHobbyRejected(relevance.get(key)));
}

/**
 * Classify the picked cards, drop any that score as unrelated, and refill
 * once if needed so the returned batch already has hobby_verified set.
 */
async function finalizeFeedRelevance(feed, filtered, ctx, batchSize, hobbyNameById) {
  const apply = async (items) => {
    // Bounded wait: verdicts improve the batch but aren't worth an unbounded
    // delay in front of it. Whatever hasn't answered by the deadline keeps
    // running — it still writes to the table, so the next batch benefits — and
    // the affected cards are served unlabelled, which is the same state as any
    // item we've not classified yet.
    const classification = classifyHobbyRelevance(items, hobbyNameById, ctx.relevance)
      .then((added) => {
        for (const [key, affinity] of added) ctx.relevance.set(key, affinity);
        return true;
      })
      .catch((err) => {
        console.error('[Relevance] Inline classification failed:', err?.message ?? err);
        return true;
      });

    if (RELEVANCE_BUDGET_MS <= 0) return classification;

    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), RELEVANCE_BUDGET_MS);
    });
    const finishedInTime = await Promise.race([classification, deadline]);
    clearTimeout(timer);
    if (!finishedInTime) {
      count('relevance_budget_exceeded');
      note('relevance_budget_exceeded_ms', RELEVANCE_BUDGET_MS);
    }
    return finishedInTime;
  };

  await apply(feed);
  if (!feed.some((item) => isRejectedByRelevance(item, ctx.relevance))) {
    return feed;
  }

  const pool = filtered.filter((item) => !isRejectedByRelevance(item, ctx.relevance));
  const refilled = fillFeedSlots(
    pool,
    batchSize,
    ctx.weights,
    ctx.asinLastSeen,
    ctx.profile?.relationship ?? null,
  );
  await apply(refilled);
  return refilled.filter((item) => !isRejectedByRelevance(item, ctx.relevance));
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
        if (feed.some((picked) => isSameProductListing(picked, item))) return false;
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
          if (feed.some((picked) => isSameProductListing(picked, item))) return false;
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

async function insertFeedEvents(sb, sessionId, profileId, feed, hobbyRows = [], relevance = new Map()) {
  if (feed.length === 0) return [];

  const verifiedFor = (item) => {
    if (!item.hobby_id) return false;
    const affinity = relevance.get(`${item.asin}:${item.hobby_id}`);
    if (typeof affinity !== 'number') return null;
    return isHobbyVerified(affinity);
  };

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
      hobby_verified: verifiedFor(item),
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
    // Whether the product itself supports the hobby label, as opposed to merely
    // having been found by that hobby's search. Clients label only when true.
    hobby_verified: verifiedFor(item),
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
