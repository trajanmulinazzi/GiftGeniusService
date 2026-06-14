/**
 * Amazon Creators API service — search + cache layer.
 * Uses Supabase JS client for cache storage (HTTPS).
 */

import { createRequire } from 'module';
import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { loadAngles, loadBudgetBuckets, getBucketRanges } from './taxonomy.js';

const require = createRequire(import.meta.url);
const { ApiClient, DefaultApi, SearchItemsRequestContent } = require('amazon-creators-api');

// ── Taxonomy-driven constants (read from .txt files) ──────
const ALL_ANGLES = loadAngles().map(a => a.name);
const ALL_BUDGET_BUCKETS = loadBudgetBuckets();
const BUCKET_RANGES = getBucketRanges();

const DAILY_CALL_LIMIT = 8500;
const DAILY_CALL_ALERT = 7500;
const CACHE_TTL_HOURS = 48;
const MARKETPLACE = 'www.amazon.com';
const MIN_REQUEST_INTERVAL_MS = 1200; // slightly over 1 TPS to stay safely under PA-API limit
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000; // exponential backoff: 2s, 4s, 8s

const IMAGE_LONGEST_EDGE_PX = 500;

const SEARCH_RESOURCES = [
  'images.primary.large',
  'itemInfo.title',
  'itemInfo.classifications',
  'offersV2.listings.price',
];

/** Upscale Amazon CDN thumbnails (e.g. _SL160_) for sharper swipe cards. */
export function normalizeAmazonImageUrl(url) {
  if (!url) return url;
  return url.replace(/\._SL(\d+)_\./, (match, size) => {
    const px = parseInt(size, 10);
    return px >= IMAGE_LONGEST_EDGE_PX ? match : `._SL${IMAGE_LONGEST_EDGE_PX}_.`;
  });
}

// ── API Client Singleton ──────────────────────────────────
let _api = null;

function getApi() {
  if (_api) return _api;
  const client = new ApiClient();
  client.credentialId = process.env.AMAZON_CREDENTIAL_ID;
  client.credentialSecret = process.env.AMAZON_CREDENTIAL_SECRET;
  client.version = process.env.AMAZON_CREDENTIAL_VERSION;
  _api = new DefaultApi(client);
  return _api;
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
    console.warn(`[Amazon] Daily API call count: ${count} (limit: ${DAILY_CALL_LIMIT})`);
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

// ── Raw Amazon API Call (with retry + backoff) ───────────
async function callAmazonAPI(searchTerm, minPrice, maxPrice) {
  const api = getApi();
  const req = new SearchItemsRequestContent();
  req.partnerTag = process.env.AMAZON_PARTNER_TAG;
  req.keywords = searchTerm;
  req.itemCount = 10;
  if (minPrice > 0) req.minPrice = minPrice * 100;
  if (maxPrice < 9999) req.maxPrice = maxPrice * 100;
  req.resources = SEARCH_RESOURCES;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    try {
      const response = await api.searchItems(MARKETPLACE, { searchItemsRequestContent: req });
      return (response?.searchResult?.items ?? []).map(item => ({
        asin: item.asin,
        title: item.itemInfo?.title?.displayValue ?? '',
        price: extractPrice(item),
        image_url: normalizeAmazonImageUrl(item.images?.primary?.large?.url ?? ''),
        product_url: item.detailPageURL ?? `https://www.amazon.com/dp/${item.asin}?tag=${process.env.AMAZON_PARTNER_TAG}`,
        category: item.itemInfo?.classifications?.binding?.displayValue ?? 'General',
        fetched_at: new Date().toISOString(),
      }));
    } catch (err) {
      const status = err.statusCode ?? err.status ?? err.$metadata?.httpStatusCode;
      if (status === 429 && attempt < MAX_RETRIES) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(`[Amazon] 429 for "${searchTerm}", retrying in ${backoff}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
}

function extractPrice(item) {
  const listings = item.offersV2?.listings;
  if (!listings || listings.length === 0) return 0;
  const listing = listings.find(l => l.isBuyBoxWinner) ?? listings[0];
  // Creators API nests amount under price.money (not price.amount)
  return listing?.price?.money?.amount ?? listing?.price?.amount ?? 0;
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
    sb.rpc('increment_cache_hit', { p_cache_key: key }); // fire and forget
    return cached.items.map(item => ({
      ...item,
      image_url: normalizeAmazonImageUrl(item.image_url),
    }));
  }

  // Check daily limit
  const dailyCount = await getDailyCallCount();
  if (dailyCount >= DAILY_CALL_LIMIT) {
    console.warn(`[Amazon] Daily API limit reached (${dailyCount}). Skipping: ${searchTerm}`);
    return [];
  }

  // Call Amazon API
  const [minPrice, maxPrice] = BUCKET_RANGES[bucket] ?? [0, 9999];
  try {
    const items = await callAmazonAPI(searchTerm, minPrice, maxPrice);
    const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();

    await sb.from('amazon_cache').upsert({
      cache_key: key,
      search_term: searchTerm,
      budget_bucket: bucket,
      items,
      cached_at: new Date().toISOString(),
      expires_at: expiresAt,
      hit_count: 0,
    }, { onConflict: 'cache_key' });

    await incrementDailyCallCount();
    return items;
  } catch (err) {
    console.error(`[Amazon] API error for "${searchTerm}" [${bucket}]:`, err.message ?? err);
    return [];
  }
}

// ── Cache Refresh Job (§6.5) ──────────────────────────────
export async function refreshExpiringCache() {
  const sb = getDb();
  const sixHoursFromNow = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  const { data: expiring } = await sb
    .from('amazon_cache')
    .select('cache_key, search_term, budget_bucket')
    .lt('expires_at', sixHoursFromNow)
    .order('hit_count', { ascending: false })
    .limit(100);

  let refreshed = 0;
  for (const row of (expiring ?? [])) {
    const dailyCount = await getDailyCallCount();
    if (dailyCount >= DAILY_CALL_LIMIT) break;

    const [minPrice, maxPrice] = BUCKET_RANGES[row.budget_bucket] ?? [0, 9999];
    try {
      const items = await callAmazonAPI(row.search_term, minPrice, maxPrice);
      const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();
      await sb.from('amazon_cache').update({
        items,
        expires_at: expiresAt,
        cached_at: new Date().toISOString(),
        hit_count: 0,
      }).eq('cache_key', row.cache_key);

      await incrementDailyCallCount();
      refreshed++;
    } catch (err) {
      console.error(`[Amazon] Refresh error for "${row.search_term}":`, err.message ?? err);
    }
  }

  console.log(`[Amazon] Cache refresh: ${refreshed}/${(expiring ?? []).length} entries`);
  return refreshed;
}

// ── Get Daily API Usage ───────────────────────────────────
export async function getDailyApiUsage() {
  const count = await getDailyCallCount();
  return { date: new Date().toISOString().slice(0, 10), count, limit: DAILY_CALL_LIMIT };
}

export { ALL_BUDGET_BUCKETS, BUCKET_RANGES };
