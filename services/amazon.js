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
// pace calls to stay polite and under plan rate limits.
const MIN_REQUEST_INTERVAL_MS = Number(process.env.CANOPY_MIN_INTERVAL_MS ?? 250);
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000; // exponential backoff: 2s, 4s, 8s

const CANOPY_SEARCH_URL = 'https://rest.canopyapi.co/api/amazon/search';
const CANOPY_DOMAIN = process.env.CANOPY_DOMAIN ?? 'US';
const REQUEST_TIMEOUT_MS = 15000;

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

// ── Daily API Call Tracking ───────────────────────────────
async function getDailyCallCount() {
  const sb = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await sb.rpc('get_daily_call_count', { p_date: today });
  return data ?? 0;
}

async function incrementDailyCallCount() {
  const sb = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await sb.rpc('increment_daily_calls', { p_date: today });
  const count = data ?? 0;
  if (count >= DAILY_CALL_ALERT) {
    console.warn(`[Canopy] Daily API call count: ${count} (limit: ${DAILY_CALL_LIMIT})`);
  }
  return count;
}

// ── Rate Limiter (queue-based for concurrent safety) ─────
let _nextAvailableTime = 0;

async function throttle() {
  const now = Date.now();
  const myTurn = Math.max(now, _nextAvailableTime);
  _nextAvailableTime = myTurn + MIN_REQUEST_INTERVAL_MS;
  const waitMs = myTurn - now;
  if (waitMs > 0) {
    await new Promise(r => setTimeout(r, waitMs));
  }
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
async function callCanopyAPI(searchTerm, minPrice, maxPrice) {
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
    await throttle();
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
      return results
        .slice(0, SEARCH_ITEM_COUNT)
        .map(mapSearchResult)
        .filter(Boolean);
    } catch (err) {
      const status = err.statusCode ?? err.status;
      const retryable = status === 429 || status === 500 || status === 502
        || status === 503 || status === 504 || err.name === 'AbortError';
      if (retryable && attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(`[Canopy] ${status ?? err.name} for "${searchTerm}", retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
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
  const items = await callCanopyAPI(row.search_term, minPrice, maxPrice);
  await sb.from('amazon_cache').update({
    items,
    expires_at: cacheExpiresAt(),
    cached_at: new Date().toISOString(),
    hit_count: 0,
  }).eq('cache_key', row.cache_key);
  await incrementDailyCallCount();
  return true;
}

// ── Cache Resolution Flow (§6.3) ──────────────────────────
export async function getItemsForSearchTerm(searchTerm, bucket) {
  const sb = getDb();
  const key = buildCacheKey(searchTerm, bucket);

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
      sb.rpc('increment_cache_hit', { p_cache_key: key }); // fire and forget
      return items.map(item => ({
        ...item,
        image_url: normalizeAmazonImageUrl(item.image_url),
      }));
    }
    // Stale entry — refetch and update row in place (no delete)
  }

  // Check daily limit
  const dailyCount = await getDailyCallCount();
  if (dailyCount >= DAILY_CALL_LIMIT) {
    console.warn(`[Canopy] Daily API limit reached (${dailyCount}). Skipping: ${searchTerm}`);
    return [];
  }

  // Call Canopy API
  const [minPrice, maxPrice] = BUCKET_RANGES[bucket] ?? [0, 9999];
  try {
    const items = await callCanopyAPI(searchTerm, minPrice, maxPrice);
    await writeCacheEntry(sb, { cache_key: key, search_term: searchTerm, budget_bucket: bucket, items });
    await incrementDailyCallCount();
    return items;
  } catch (err) {
    console.error(`[Canopy] API error for "${searchTerm}" [${bucket}]:`, err.message ?? err);
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
  const count = await getDailyCallCount();
  return { date: new Date().toISOString().slice(0, 10), count, limit: DAILY_CALL_LIMIT };
}

export { ALL_BUDGET_BUCKETS, BUCKET_RANGES };
