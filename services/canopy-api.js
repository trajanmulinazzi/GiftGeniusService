/**
 * Canopy API service wrapper
 * Fetches Amazon product data via search for catalog ingestion.
 * Uses REST API: https://rest.canopyapi.co/api/amazon/search
 * Requires CANOPY_API_KEY in env.
 *
 * Free tier: 100 requests/month. Search returns up to 40 products per call.
 */

const CANOPY_BASE = "https://rest.canopyapi.co";

/**
 * @returns {{ apiKey: string }}
 */
function getConfig() {
  const apiKey = process.env.CANOPY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Canopy API key. Set CANOPY_API_KEY in .env or .env.local"
    );
  }
  return { apiKey };
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "under",
  "over",
  "into",
  "onto",
]);

/**
 * Derive tags from search term (e.g. "gift for dad" -> ["gift-for-dad", "gift", "dad"]).
 */
function tagsFromSearchTerm(searchTerm) {
  if (!searchTerm || typeof searchTerm !== "string") return [];
  const slug = searchTerm
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  if (!slug) return [];
  const words = searchTerm
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  const seen = new Set([slug]);
  const out = [slug];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/**
 * Extract meaningful keywords from product title for tags.
 */
function tagsFromTitle(title) {
  if (!title || typeof title !== "string") return [];
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (!seen.has(w) && out.length < 5) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

/**
 * Add affiliate tag to Amazon URL for tracking.
 */
function withAffiliateTag(url, partnerTag) {
  if (!partnerTag || !url) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}tag=${encodeURIComponent(partnerTag)}`;
}

/**
 * Map Canopy search result item to catalog product shape.
 * Search API does not return categories/featureBullets per item, so we derive tags
 * from the search term (same for all) + each item's title + prime/rating when present.
 * @param {object} item - Raw item from Canopy search
 * @param {string} [partnerTag] - Amazon Associate tag for buy_url
 * @param {string} [searchTerm] - Query used to find this product (for tagging)
 */
function itemToProduct(item, partnerTag, searchTerm) {
  const asin = item.asin;
  if (!asin) return null;

  const title = item.title || "Untitled";
  const imageUrl = item.mainImageUrl || null;
  const priceObj = item.price;
  const priceValue = priceObj?.value;
  const priceCents =
    priceValue != null ? Math.round(Number(priceValue) * 100) : null;
  const currency = priceObj?.currency || "USD";

  const rawUrl = item.url || `https://www.amazon.com/dp/${asin}`;
  const buyUrl = withAffiliateTag(rawUrl, partnerTag);

  // Derived tags: search API doesn't include categories per item (rating/reviews stored as columns, not tags)
  const tags = [];
  tags.push(...tagsFromSearchTerm(searchTerm));
  tags.push(...tagsFromTitle(title));
  if (item.isPrime) tags.push("prime");
  const unique = [...new Set(tags)];

  const rating = item.rating != null ? Number(item.rating) : null;
  const reviewsCount = item.ratingsTotal != null && item.ratingsTotal > 0 ? Math.floor(Number(item.ratingsTotal)) : null;

  return {
    source_id: asin,
    source: "amazon",
    title,
    image_url: imageUrl,
    price_cents: priceCents,
    currency,
    buy_url: buyUrl,
    tags: unique,
    rating,
    reviews_count: reviewsCount,
    active: true,
  };
}

/**
 * Call Canopy search API and return the raw JSON response (for debugging).
 * @param {string} searchTerm - Search keywords
 * @param {object} [opts] - page, limit, domain
 * @returns {Promise<object>} Full response body from the API
 */
export async function searchProductsRaw(searchTerm, opts = {}) {
  const { apiKey } = getConfig();
  const params = new URLSearchParams({
    searchTerm,
    domain: opts.domain || "US",
    page: String(opts.page ?? 1),
    limit: String(opts.limit ?? 40),
  });
  const url = `${CANOPY_BASE}/api/amazon/search?${params}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "API-KEY": apiKey,
      "Content-Type": "application/json",
    },
  });
  const json = await response.json();
  if (!response.ok) {
    const err = new Error(
      json?.errors?.[0]?.message ||
        json?.message ||
        `Canopy API ${response.status}`
    );
    err.status = response.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * Search Amazon products via Canopy API.
 * @param {string} searchTerm - Search keywords
 * @param {object} [opts]
 * @param {number} [opts.page] - Page number (default 1)
 * @param {number} [opts.limit] - Results per page, 20-40 (default 40)
 * @param {string} [opts.domain] - Marketplace (default US)
 * @param {number} [opts.budgetMinCents] - Min price filter (cents)
 * @param {number} [opts.budgetMaxCents] - Max price filter (cents)
 * @returns {Promise<object[]>} Catalog-ready products
 */
export async function searchProducts(searchTerm, opts = {}) {
  const { apiKey } = getConfig();
  const partnerTag = process.env.AMAZON_PARTNER_TAG;

  const params = new URLSearchParams({
    searchTerm,
    domain: opts.domain || "US",
    page: String(opts.page ?? 1),
    limit: String(opts.limit ?? 40),
  });
  if (opts.budgetMinCents != null) params.set("minPrice", String(opts.budgetMinCents));
  if (opts.budgetMaxCents != null) params.set("maxPrice", String(opts.budgetMaxCents));

  const url = `${CANOPY_BASE}/api/amazon/search?${params}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "API-KEY": apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    let errMsg = `Canopy API error ${response.status}: ${response.statusText}`;
    try {
      const body = JSON.parse(text);
      errMsg = body?.errors?.[0]?.message || body?.message || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const json = await response.json();
  const results =
    json?.data?.amazonProductSearchResults?.productResults?.results ?? [];
  const products = [];
  for (const item of results) {
    const p = itemToProduct(item, partnerTag, searchTerm);
    if (p) products.push(p);
  }
  return products;
}

/**
 * Fetch a single product by ASIN (1 API call).
/**
 * Call Canopy product-by-ASIN API once and return the full raw JSON response (for debugging / inspecting tags).
 * One API call, one item, full response including categories, featureBullets, brand, etc.
 * @param {string} asin - Amazon ASIN
 * @param {object} [opts] - { domain }
 * @returns {Promise<object>} Full response body from the API
 */
export async function getProductByAsinRaw(asin, opts = {}) {
  const { apiKey } = getConfig();
  const params = new URLSearchParams({
    asin,
    domain: opts.domain || "US",
  });
  const url = `${CANOPY_BASE}/api/amazon/product?${params}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "API-KEY": apiKey,
      "Content-Type": "application/json",
    },
  });
  const json = await response.json();
  if (!response.ok) {
    const err = new Error(
      json?.errors?.[0]?.message ||
        json?.message ||
        `Canopy API ${response.status}`
    );
    err.status = response.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * Returns item with tags from API categories + featureBullets.
 * @param {string} asin
 * @param {object} [opts] - { domain }
 * @returns {Promise<object|null>} Catalog-ready product or null
 */
export async function getProductByAsin(asin, opts = {}) {
  const { apiKey } = getConfig();
  const partnerTag = process.env.AMAZON_PARTNER_TAG;

  const params = new URLSearchParams({
    asin,
    domain: opts.domain || "US",
  });
  const url = `${CANOPY_BASE}/api/amazon/product?${params}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "API-KEY": apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    const text = await response.text();
    let errMsg = `Canopy API error ${response.status}: ${response.statusText}`;
    try {
      const body = JSON.parse(text);
      errMsg = body?.errors?.[0]?.message || body?.message || errMsg;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const json = await response.json();
  const p = json?.data?.amazonProduct;
  if (!p || !p.asin) return null;

  const title = p.title || "Untitled";
  const imageUrl = p.mainImageUrl || null;
  const priceObj = p.price;
  const priceValue = priceObj?.value;
  const priceCents =
    priceValue != null ? Math.round(Number(priceValue) * 100) : null;
  const currency = priceObj?.currency || "USD";
  const rawUrl = p.url || `https://www.amazon.com/dp/${p.asin}`;
  const buyUrl = withAffiliateTag(rawUrl, partnerTag);

  const tags = [];
  if (p.categories && Array.isArray(p.categories)) {
    for (const cat of p.categories) {
      const path = cat.breadcrumbPath || cat.name || "";
      const parts = path
        .split(/\s*>\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const part of parts) {
        const slug = part
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        if (slug && slug.length >= 2 && !STOPWORDS.has(slug)) tags.push(slug);
      }
      if (cat.name) {
        const slug = cat.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        if (slug && !tags.includes(slug)) tags.push(slug);
      }
    }
  }
  if (p.featureBullets && Array.isArray(p.featureBullets)) {
    for (const bullet of p.featureBullets.slice(0, 3)) {
      const w = String(bullet)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .find((x) => x.length >= 4 && !STOPWORDS.has(x));
      if (w) tags.push(w);
    }
  }
  if (p.brand)
    tags.push(
      p.brand
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
    );
  if (p.isPrime) tags.push("prime");
  const unique = [...new Set(tags)];

  const rating = p.rating != null ? Number(p.rating) : null;
  const reviewsCount = p.ratingsTotal != null && p.ratingsTotal > 0 ? Math.floor(Number(p.ratingsTotal)) : null;

  return {
    source_id: p.asin,
    source: "amazon",
    title,
    image_url: imageUrl,
    price_cents: priceCents,
    currency,
    buy_url: buyUrl,
    tags: unique,
    rating,
    reviews_count: reviewsCount,
    active: true,
  };
}
