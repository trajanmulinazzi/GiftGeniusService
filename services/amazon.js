/**
 * Amazon product data service — backed by the Canopy API (REST).
 *
 * Canopy provides Amazon catalog/search data; we lost access to the Amazon
 * Creators API, so this module swaps the underlying provider while keeping the
 * same public surface (getItemsForSearchTerm / refreshExpiringCache /
 * getDailyApiUsage / resolveBudgetBuckets / normalizeAmazonImageUrl) and the
 * same cached item shape so downstream feed/precompute code is unchanged.
 *
 * Uses the global fetch (Node 18+) for HTTPS calls and the Supabase JS client
 * for cache storage.
 */

import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { loadAngles, loadBudgetBuckets, getBucketRanges } from './taxonomy.js';
import { count, note, record } from './diag.js';

// ── Taxonomy-driven constants (read from .txt files) ──────
const ALL_ANGLES = loadAngles().map(a => a.name);
const ALL_BUDGET_BUCKETS = loadBudgetBuckets();
const BUCKET_RANGES = getBucketRanges();

// Canopy REST quota is plan-dependent; keep a defensive daily ceiling so a
// runaway job can never drain the account. Override via env if the plan differs.
const DAILY_CALL_LIMIT = Number(process.env.CANOPY_DAILY_CALL_LIMIT ?? 8500);
const DAILY_CALL_ALERT = Number(process.env.CANOPY_DAILY_CALL_ALERT ?? 7500);
const CACHE_TTL_HOURS = 48;

// Canopy is a REST API (higher throughput than PA-API's ~1 TPS), but we still
// pace calls to stay polite and under plan rate limits. The queue is global, so
// this interval is added latency for every concurrent search behind the first;
// raise it back toward 250ms if Canopy starts returning 429s.
const MIN_REQUEST_INTERVAL_MS = Number(process.env.CANOPY_MIN_INTERVAL_MS ?? 150);
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000; // exponential backoff: 2s, 4s, 8s

const CANOPY_SEARCH_URL = 'https://rest.canopyapi.co/api/amazon/search';
const CANOPY_DOMAIN = process.env.CANOPY_DOMAIN ?? 'US';
// Canopy's search endpoint is often slow (multi-second) under load. A tight cap
// aborts responses that would otherwise succeed, which just burns the API call
// and triggers a retry. Keep the ceiling generous and env-tunable.
const REQUEST_TIMEOUT_MS = Number(process.env.CANOPY_REQUEST_TIMEOUT_MS ?? 30000);

// Max results to keep per search (Canopy returns ~60/page; a slice keeps cache
// rows small while still giving the feed plenty of candidates per API call).
const SEARCH_ITEM_COUNT = Number(process.env.CANOPY_SEARCH_ITEM_COUNT ?? 20);

const IMAGE_LONGEST_EDGE_PX = 500;

/**
 * Upscale Amazon CDN thumbnails for sharper swipe cards by rewriting the size
 * token in the image URL. Handles both legacy Creators-API URLs (`._SL160_.`)
 * and Canopy URLs (`._AC_UL320_.`, `._AC_SX466_.`, …). Leaves untokenized URLs
 * untouched.
 */
export function normalizeAmazonImageUrl(url) {
  if (!url) return url;
  // Match the trailing Amazon image size modifier segment, e.g.
  //   ._SL160_.jpg   ._AC_UL320_.jpg   ._AC_SX466_.png
  return url.replace(
    /\.(_[A-Z0-9]+(?:_[A-Z0-9]+)*_)\.(jpg|jpeg|png|webp|gif)$/i,
    (_m, _token, ext) => `._AC_UL${IMAGE_LONGEST_EDGE_PX}_.${ext}`,
  );
}

// ── Budget Bucket Resolution ──────────────────────────────
export function resolveBudgetBuckets(min, max) {
  return ALL_BUDGET_BUCKETS.filter(b => {
    const [lo, hi] = BUCKET_RANGES[b];
    return lo < max && hi > min;
  });
}

// ── Cache Key ─────────────────────────────────────────────
export function buildCacheKey(searchTerm, bucket) {
  return crypto.createHash('sha256').update(`${searchTerm}:${bucket}`).digest('hex');
}

/**
 * Which of these (term, bucket) pairs are already cached and unexpired.
 *
 * Lets the feed spend its cached searches (~200ms) before any live one (~6s),
 * in one round trip for the whole queue. A row can still turn out stale by
 * content, so this is a strong hint rather than a guarantee.
 *
 * @param {{term: string, bucket: string}[]} entries
 * @returns {Promise<Set<string>>} `${term}::${bucket}` for each warm entry
 */
export async function findWarmCacheKeys(entries) {
  if (!entries?.length) return new Set();

  const sb = getDb();
  const byKey = new Map();
  for (const { term, bucket } of entries) {
    byKey.set(buildCacheKey(term, bucket), `${term}::${bucket}`);
  }

  const keys = [...byKey.keys()];
  const warm = new Set();
  const now = new Date().toISOString();

  // Chunked: a few hundred keys in one `in` filter overruns the request URL.
  for (let i = 0; i < keys.length; i += 150) {
    const { data, error } = await sb
      .from('amazon_cache')
      .select('cache_key')
      .in('cache_key', keys.slice(i, i + 150))
      .gt('expires_at', now);
    if (error) {
      console.error('[Canopy] Warm-cache lookup failed:', error.message);
      return warm;
    }
    for (const row of data ?? []) {
      const entry = byKey.get(row.cache_key);
      if (entry) warm.add(entry);
    }
  }

  return warm;
}

// ── Daily API Call Tracking ───────────────────────────────
// The counter is a defensive ceiling, not billing, so it's held in memory and
// re-read periodically rather than round-tripped on every call. Previously each
// cache miss paid two extra sequential Supabase calls (read then increment) —
// ~340ms of the ~5.8s miss, and more importantly two more chances to queue.
const DAILY_COUNT_TTL_MS = Number(process.env.CANOPY_DAILY_COUNT_TTL_MS ?? 60_000);
let _dailyCount = { date: null, value: 0, readAt: 0 };

function utcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getDailyCallCount() {
  const today = utcDateKey();
  const fresh = _dailyCount.date === today
    && Date.now() - _dailyCount.readAt < DAILY_COUNT_TTL_MS;
  if (fresh) return _dailyCount.value;

  const sb = getDb();
  const { data } = await sb.rpc('get_daily_call_count', { p_date: today });
  _dailyCount = { date: today, value: data ?? 0, readAt: Date.now() };
  return _dailyCount.value;
}

/**
 * Count a call locally and persist it without blocking the caller.
 *
 * Supabase builders only issue their request when awaited, so the write is
 * kicked off with `.then()` rather than left as a bare expression.
 */
function incrementDailyCallCount() {
  const today = utcDateKey();
  if (_dailyCount.date !== today) {
    _dailyCount = { date: today, value: 0, readAt: Date.now() };
  }
  _dailyCount.value += 1;

  if (_dailyCount.value >= DAILY_CALL_ALERT) {
    console.warn(`[Canopy] Daily API call count: ${_dailyCount.value} (limit: ${DAILY_CALL_LIMIT})`);
  }

  getDb()
    .rpc('increment_daily_calls', { p_date: today })
    .then(
      ({ data }) => {
        // Trust the authoritative value when it comes back.
        if (typeof data === 'number' && data > _dailyCount.value) {
          _dailyCount.value = data;
        }
      },
      (err) => console.error('[Canopy] Daily call count write failed:', err?.message ?? err),
    );
  return _dailyCount.value;
}

// ── Rate Limiter (queue-based for concurrent safety) ─────

/**
 * Lower runs first. A user waiting on cards outranks cache warming that exists
 * to help some later request.
 */
export const SEARCH_PRIORITY = { foreground: 0, background: 1 };

let _nextSlotAt = 0;
let _slotSeq = 0;
let _slotWaiters = [];
let _slotTimer = null;

function scheduleSlots() {
  if (_slotTimer || _slotWaiters.length === 0) return;
  const wait = Math.max(0, _nextSlotAt - Date.now());
  _slotTimer = setTimeout(() => {
    _slotTimer = null;
    // Ordered when the slot is granted rather than when callers arrive. That's
    // the whole point: a feed request that shows up behind a queue of background
    // warming still takes the next slot instead of its arrival position. Priority
    // is read through a shared box, so a warm search a request has joined is
    // reordered too.
    _slotWaiters.sort((a, b) => a.prio.value - b.prio.value || a.seq - b.seq);
    const next = _slotWaiters.shift();
    if (next) {
      _nextSlotAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
      next.resolve();
    }
    scheduleSlots();
  }, wait);
}

async function throttle(prio = { value: SEARCH_PRIORITY.foreground }) {
  const startedAt = Date.now();

  // Nothing queued and the interval has already elapsed — go straight through,
  // so an uncontended search pays nothing for the scheduler.
  if (_slotWaiters.length === 0 && startedAt >= _nextSlotAt) {
    _nextSlotAt = startedAt + MIN_REQUEST_INTERVAL_MS;
    return 0;
  }

  await new Promise((resolve) => {
    _slotWaiters.push({ prio, seq: _slotSeq++, resolve });
    scheduleSlots();
  });

  const waitMs = Date.now() - startedAt;
  if (waitMs > 0) {
    // The queue is process-global, so this counter shows how much of a request's
    // latency came from waiting behind other in-flight searches (including
    // background prefetch/refresh work) rather than from Canopy itself.
    count('canopy_throttle_wait_ms', waitMs);
    count('canopy_throttled_calls');
    if (prio.value === SEARCH_PRIORITY.background) {
      count('canopy_throttle_wait_ms_background', waitMs);
    }
  }
  return waitMs;
}

// ── Product URL / affiliate tagging ───────────────────────
/** Build a clean canonical Amazon product URL, tagged if an affiliate tag is set. */
function buildProductUrl(asin) {
  const tag = process.env.AMAZON_PARTNER_TAG;
  const base = `https://www.amazon.com/dp/${asin}`;
  return tag ? `${base}?tag=${tag}` : base;
}

/** Map a single Canopy search result into our cached item shape. */
function mapSearchResult(result) {
  const asin = result?.asin;
  if (!asin) return null;
  return {
    asin,
    title: result.title ?? '',
    price: result.price?.value ?? 0,
    image_url: normalizeAmazonImageUrl(result.mainImageUrl ?? ''),
    product_url: buildProductUrl(asin),
    // Canopy search results don't carry a category; keep the historical default
    // so downstream consumers (feed/client) see a consistent field.
    category: 'General',
    // Null rather than 0 so the client can tell "unrated" from "rated zero".
    // Cache rows written before this field existed also read as null.
    rating: typeof result.rating === 'number' ? result.rating : null,
    ratings_total:
      typeof result.ratingsTotal === 'number' ? result.ratingsTotal : null,
    fetched_at: new Date().toISOString(),
  };
}

// ── Raw Canopy API Call (with retry + backoff) ───────────
async function callCanopyAPI(searchTerm, minPrice, maxPrice, prio) {
  const apiKey = process.env.CANOPY_API_KEY;
  if (!apiKey) throw new Error('CANOPY_API_KEY is not set');

  const params = new URLSearchParams({
    searchTerm,
    domain: CANOPY_DOMAIN,
  });
  // Canopy filters server-side by price in dollars (inclusive band).
  if (minPrice > 0) params.set('minPrice', String(minPrice));
  if (maxPrice < 9999) params.set('maxPrice', String(maxPrice));

  const url = `${CANOPY_SEARCH_URL}?${params.toString()}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const waitedMs = await throttle(prio);
    const startedAt = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { 'API-KEY': apiKey, 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const err = new Error(`Canopy API ${response.status} for "${searchTerm}"`);
        err.statusCode = response.status;
        throw err;
      }

      const body = await response.json();
      const results = body?.data?.amazonProductSearchResults?.productResults?.results ?? [];
      const items = results
        .slice(0, SEARCH_ITEM_COUNT)
        .map(mapSearchResult)
        .filter(Boolean);
      record('canopy', 'search', performance.now() - startedAt, {
        term: searchTerm,
        attempt: attempt + 1,
        throttle_ms: Math.round(waitedMs),
        items: items.length,
      });
      count('canopy_calls');
      return items;
    } catch (err) {
      const status = err.statusCode ?? err.status;
      record('canopy', 'search', performance.now() - startedAt, {
        term: searchTerm,
        attempt: attempt + 1,
        throttle_ms: Math.round(waitedMs),
        failed: status ?? err.name,
      });
      count('canopy_calls');
      const retryable = status === 429 || status === 500 || status === 502
        || status === 503 || status === 504 || err.name === 'AbortError';
      if (retryable && attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(`[Canopy] ${status ?? err.name} for "${searchTerm}", retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        count('canopy_retries');
        count('canopy_retry_backoff_ms', backoff);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
}

function cacheItemsNeedRefresh(items) {
  if (!items?.length) return true;
  if (items.every(i => !i.price || i.price <= 0)) return true;
  // Rows written before ratings were captured lack the key entirely. Refetch
  // them once so cards can show stars. An unrated product stores `null`, which
  // is a present key, so this never loops on genuinely unrated results.
  return items.every(i => i.rating === undefined);
}

function cacheExpiresAt() {
  return new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();
}

/** Upsert or update a cache row in place — never bulk-delete. */
async function writeCacheEntry(sb, { cache_key, search_term, budget_bucket, items }) {
  const now = new Date().toISOString();
  await sb.from('amazon_cache').upsert({
    cache_key,
    search_term,
    budget_bucket,
    items,
    cached_at: now,
    expires_at: cacheExpiresAt(),
    hit_count: 0,
  }, { onConflict: 'cache_key' });
}

async function refreshCacheRow(sb, row) {
  const [minPrice, maxPrice] = BUCKET_RANGES[row.budget_bucket] ?? [0, 9999];
  // Maintenance work — always yields the queue to live requests.
  const items = await callCanopyAPI(row.search_term, minPrice, maxPrice, {
    value: SEARCH_PRIORITY.background,
  });
  await sb.from('amazon_cache').update({
    items,
    expires_at: cacheExpiresAt(),
    cached_at: new Date().toISOString(),
    hit_count: 0,
  }).eq('cache_key', row.cache_key);
  incrementDailyCallCount();
  return true;
}

// ── Cache Resolution Flow (§6.3) ──────────────────────────

/**
 * Searches for the same (term, bucket) that are already running.
 *
 * The cache only helps once a search has finished writing, so overlapping
 * callers used to each pay a full live search for the identical query — the
 * session's background prefetch and the first feed request did exactly this,
 * duplicating whole seconds of Canopy latency. Sharing the in-flight promise
 * makes the second caller free.
 */
const _inflightSearches = new Map();

/**
 * Which of these (term, bucket) pairs already have a search running.
 *
 * Joining one of these costs only its remaining time, so to a caller choosing
 * what to search next they rank alongside a cache hit — and ahead of any term
 * that would start a new live call. Nothing is awaited here.
 *
 * @param {{term: string, bucket: string}[]} entries
 * @returns {Set<string>} `${term}::${bucket}` for each entry already in flight
 */
export function findInflightSearchKeys(entries) {
  const inflight = new Set();
  for (const { term, bucket } of entries ?? []) {
    if (_inflightSearches.has(buildCacheKey(term, bucket))) {
      inflight.add(`${term}::${bucket}`);
    }
  }
  return inflight;
}

export function getItemsForSearchTerm(searchTerm, bucket, priority = SEARCH_PRIORITY.foreground) {
  const key = buildCacheKey(searchTerm, bucket);

  const existing = _inflightSearches.get(key);
  if (existing) {
    count('search_coalesced');
    // Joining a background warm shouldn't inherit its place in the queue — from
    // here on someone is waiting on this search, so promote it.
    if (priority < existing.prio.value) {
      existing.prio.value = priority;
      count('search_priority_raised');
    }
    return existing.promise;
  }

  // Shared with the throttle so the priority can still change after the search
  // has queued.
  const prio = { value: priority };
  const promise = resolveItemsForSearchTerm(searchTerm, bucket, key, prio)
    .finally(() => _inflightSearches.delete(key));
  _inflightSearches.set(key, { promise, prio });
  return promise;
}

async function resolveItemsForSearchTerm(searchTerm, bucket, key, prio) {
  const sb = getDb();

  // Check cache
  const { data: cached } = await sb
    .from('amazon_cache')
    .select('items')
    .eq('cache_key', key)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (cached) {
    const items = cached.items ?? [];
    if (!cacheItemsNeedRefresh(items)) {
      // `.then()` matters: a Supabase builder never sends its request until it's
      // subscribed to, so the previous bare call left hit_count permanently 0 —
      // which also made refreshExpiringCache's hit_count ordering meaningless.
      sb.rpc('increment_cache_hit', { p_cache_key: key }).then(undefined, () => {});
      count('cache_hits');
      return items.map(item => ({
        ...item,
        image_url: normalizeAmazonImageUrl(item.image_url),
      }));
    }
    // Stale entry — refetch and update row in place (no delete)
    count('cache_stale');
  } else {
    count('cache_misses');
  }

  // Check daily limit
  const dailyCount = await getDailyCallCount();
  if (dailyCount >= DAILY_CALL_LIMIT) {
    console.warn(`[Canopy] Daily API limit reached (${dailyCount}). Skipping: ${searchTerm}`);
    count('cache_skipped_over_daily_limit');
    note('canopy_daily_limit_reached', true);
    return [];
  }

  // Call Canopy API
  const [minPrice, maxPrice] = BUCKET_RANGES[bucket] ?? [0, 9999];
  try {
    const items = await callCanopyAPI(searchTerm, minPrice, maxPrice, prio);
    incrementDailyCallCount();
    // Don't make the caller wait on the cache write — the items are already in
    // hand, and a failed write only costs a repeat search later.
    writeCacheEntry(sb, { cache_key: key, search_term: searchTerm, budget_bucket: bucket, items })
      .catch((err) => console.error(`[Canopy] Cache write failed for "${searchTerm}":`, err?.message ?? err));
    return items;
  } catch (err) {
    console.error(`[Canopy] API error for "${searchTerm}" [${bucket}]:`, err.message ?? err);
    count('canopy_failed_terms');
    return [];
  }
}

// ── Cache Refresh Job (§6.5) ──────────────────────────────
/** Refresh cache rows in place: expiring soon + stale item data (e.g. missing prices). */
export async function refreshExpiringCache({ limit = 100 } = {}) {
  const sb = getDb();
  const sixHoursFromNow = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const candidates = new Map();

  const { data: expiring } = await sb
    .from('amazon_cache')
    .select('cache_key, search_term, budget_bucket, items')
    .lt('expires_at', sixHoursFromNow)
    .order('hit_count', { ascending: false })
    .limit(limit);

  for (const row of (expiring ?? [])) {
    candidates.set(row.cache_key, row);
  }

  if (candidates.size < limit) {
    const { data: rows } = await sb
      .from('amazon_cache')
      .select('cache_key, search_term, budget_bucket, items')
      .order('cached_at', { ascending: true })
      .limit(500);

    for (const row of (rows ?? [])) {
      if (candidates.size >= limit) break;
      if (cacheItemsNeedRefresh(row.items)) {
        candidates.set(row.cache_key, row);
      }
    }
  }

  let refreshed = 0;
  for (const row of candidates.values()) {
    const dailyCount = await getDailyCallCount();
    if (dailyCount >= DAILY_CALL_LIMIT) break;

    try {
      await refreshCacheRow(sb, row);
      refreshed++;
    } catch (err) {
      console.error(`[Canopy] Refresh error for "${row.search_term}":`, err.message ?? err);
    }
  }

  console.log(`[Canopy] Cache refresh: ${refreshed}/${candidates.size} entries updated in place`);
  return refreshed;
}

// ── Get Daily API Usage ───────────────────────────────────
export async function getDailyApiUsage() {
  // Admin reporting reads through to the table rather than the in-memory
  // counter, which is only meant to keep the ceiling cheap to check.
  _dailyCount.readAt = 0;
  const count = await getDailyCallCount();
  return { date: utcDateKey(), count, limit: DAILY_CALL_LIMIT };
}

export { ALL_BUDGET_BUCKETS, BUCKET_RANGES };
