/**
 * Amazon Creators API service wrapper
 * Fetches product data via SearchItems and GetItems for catalog ingestion.
 * Requires AMAZON_CREDENTIAL_ID, AMAZON_CREDENTIAL_SECRET, AMAZON_PARTNER_TAG in env.
 */

import { createRequire } from "node:module";
import { normalizeTags } from "../data/tag-canonical.js";

const require = createRequire(import.meta.url);
const { ApiClient, DefaultApi, SearchItemsRequestContent, GetItemsRequestContent } =
  require("@amzn/creatorsapi-nodejs-sdk");

const SEARCH_RESOURCES = [
  "images.primary.medium",
  "itemInfo.title",
  "itemInfo.features",
  "itemInfo.classifications",
  "itemInfo.byLineInfo",
  "itemInfo.productInfo",
  "offersV2.listings.price",
  "offersV2.listings.availability",
];

const GET_ITEMS_RESOURCES = [
  "images.primary.medium",
  "itemInfo.title",
  "itemInfo.features",
  "itemInfo.classifications",
  "itemInfo.byLineInfo",
  "itemInfo.productInfo",
  "offersV2.listings.price",
];

/**
 * @returns {DefaultApi}
 */
function getApi() {
  const credentialId = process.env.AMAZON_CREDENTIAL_ID;
  const credentialSecret = process.env.AMAZON_CREDENTIAL_SECRET;
  const partnerTag = process.env.AMAZON_PARTNER_TAG;
  // 2.x = Cognito token hosts; 3.x = Login with Amazon (LWA) at api.amazon.* — must match the credential type from Associates Central.
  const rawVersion = (process.env.AMAZON_CREDENTIAL_VERSION || "2.1").trim();
  const allowed = new Set(["2.1", "2.2", "2.3", "3.1", "3.2", "3.3"]);
  if (!allowed.has(rawVersion)) {
    throw new Error(
      `Invalid AMAZON_CREDENTIAL_VERSION="${rawVersion}". Use 2.1/2.2/2.3 (Cognito) or 3.1/3.2/3.3 (LWA). For US: 2.1 or 3.1 depending on whether your credentials say v2 or v3.`
    );
  }
  const version = rawVersion;
  const marketplace = process.env.AMAZON_MARKETPLACE || "www.amazon.com";

  if (!credentialId || !credentialSecret || !partnerTag) {
    throw new Error(
      "Missing Amazon credentials. Set AMAZON_CREDENTIAL_ID, AMAZON_CREDENTIAL_SECRET, AMAZON_PARTNER_TAG in .env"
    );
  }

  const apiClient = new ApiClient();
  apiClient.credentialId = credentialId;
  apiClient.credentialSecret = credentialSecret;
  apiClient.version = version;

  const api = new DefaultApi(apiClient);
  return { api, marketplace, partnerTag };
}

/**
 * Turn a display value into a tag: lowercase, alphanumeric + hyphens, max length.
 */
function toTag(value, maxLen = 40) {
  if (value == null || value === "") return null;
  const s = String(value).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, "-").replace(/^-|-$/g, "");
  return s.slice(0, maxLen) || null;
}

/**
 * Extract keyword from a feature string (one short word) for tagging.
 */
function tokenizeText(value) {
  if (typeof value !== "string") return [];
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

function mappedFromText(value, { maxGram = 3, maxCandidates = 20 } = {}) {
  const words = tokenizeText(value);
  if (!words.length) return [];

  const raw = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    raw.push(candidate);
  };

  for (let i = 0; i < words.length; i++) {
    for (let n = maxGram; n >= 1; n--) {
      if (i + n > words.length) continue;
      const phrase = words.slice(i, i + n).join("-");
      add(phrase);
      if (raw.length >= maxCandidates) break;
    }
    if (raw.length >= maxCandidates) break;
  }
  return normalizeTags(raw);
}

function featureToMappedTags(feature) {
  // Only mapped tags are kept; generic adjectives get dropped unless explicitly mapped.
  return mappedFromText(feature, { maxGram: 3, maxCandidates: 24 });
}

/**
 * Map Amazon API item to catalog product shape.
 * Uses tags returned by Amazon: Classifications (ProductGroup, Binding), ByLineInfo (Brand),
 * ProductInfo (Color, Size), and Features (keyword from each).
 * @param {object} item - Raw item from SearchItems/GetItems response
 * @param {string} partnerTag
 * @returns {object}
 */
function itemToProduct(item, partnerTag) {
  const asin = item.asin;
  if (!asin) return null;

  const title =
    item.itemInfo?.title?.displayValue ||
    item.itemInfo?.title?.label ||
    "Untitled";

  const img =
    item.images?.primary?.medium ||
    item.images?.primary?.small ||
    item.images?.primary?.large;
  const imageUrl = img?.url || null;

  const listings = item.offersV2?.listings || [];
  const listing = listings[0];
  const priceObj = listing?.price?.money || listing?.price?.pricePerUnit;
  const amount = priceObj?.amount;
  const currency = priceObj?.currency || "USD";
  const price = amount != null ? Number(amount) : null;
  const priceCents =
    price != null ? Math.round(price * 100) : null;

  const buyUrl =
    item.detailPageURL ||
    (asin
      ? `https://www.amazon.com/dp/${asin}${partnerTag ? `?tag=${partnerTag}` : ""}`
      : null);

  const rawTags = [];
  const seenRaw = new Set();
  const addRaw = (value) => {
    if (!value) return;
    const v = String(value).trim();
    if (!v || seenRaw.has(v)) return;
    seenRaw.add(v);
    rawTags.push(v);
  };
  const addMappedFromText = (value, opts) => {
    const mapped = mappedFromText(value, opts);
    for (const tag of mapped) addRaw(tag);
  };

  const addMappedFromList = (values, opts) => {
    if (!Array.isArray(values)) return;
    for (const value of values) addMappedFromText(value, opts);
  };

  // 1) Category mapping first (highest confidence)
  const itemInfo = item.itemInfo || {};
  const classif = itemInfo.classifications || {};
  addRaw(toTag(classif.productGroup?.displayValue));
  addRaw(toTag(classif.binding?.displayValue));

  // 2) Title phrase mapping
  const displayTitle = itemInfo.title?.displayValue || title;
  addMappedFromText(displayTitle, { maxGram: 3, maxCandidates: 32 });

  // 3) Feature keyword mapping (mapped terms only)
  const features = itemInfo.features?.displayValues || [];
  addMappedFromList(features.slice(0, 6), { maxGram: 3, maxCandidates: 28 });

  // 4) Brand as weak signal (mapped brand only)
  const byLine = itemInfo.byLineInfo || {};
  addMappedFromText(byLine.brand?.displayValue, { maxGram: 2, maxCandidates: 8 });

  const productInfo = itemInfo.productInfo || {};
  addRaw(toTag(productInfo.color?.displayValue));
  addRaw(toTag(productInfo.size?.displayValue));
  for (const f of features.slice(0, 6)) {
    for (const tag of featureToMappedTags(typeof f === "string" ? f : String(f))) {
      addRaw(tag);
    }
  }

  const canonical = normalizeTags(rawTags);

  return {
    source_id: asin,
    source: "amazon",
    title,
    image_url: imageUrl,
    price_cents: priceCents,
    currency,
    buy_url: buyUrl,
    tags: canonical,
    active: true,
  };
}

/**
 * Call SearchItems once and return the raw API response (for debugging).
 * @param {string} keywords
 * @param {object} [opts] - itemCount, searchIndex
 * @returns {Promise<object>} Raw response from api.searchItems()
 */
export async function searchItemsRaw(keywords, opts = {}) {
  const { api, marketplace } = getApi();
  const req = new SearchItemsRequestContent();
  req.partnerTag = process.env.AMAZON_PARTNER_TAG;
  req.keywords = keywords;
  req.searchIndex = opts.searchIndex || "All";
  req.itemCount = opts.itemCount ?? 5;
  req.resources = SEARCH_RESOURCES;
  return await api.searchItems(marketplace, {
    searchItemsRequestContent: req,
  });
}

/**
 * Call GetItems once and return the raw API response (for debugging).
 * @param {string|string[]} asins
 * @returns {Promise<object>} Raw response from api.getItems()
 */
export async function getItemsRaw(asins) {
  const { api, marketplace, partnerTag } = getApi();
  const ids = Array.isArray(asins) ? asins.slice(0, 10) : [asins];

  const req = new GetItemsRequestContent();
  req.partnerTag = partnerTag;
  req.itemIds = ids;
  req.condition = "New";
  req.resources = GET_ITEMS_RESOURCES;

  return await api.getItems(marketplace, req);
}

/**
 * Search Amazon products by keywords.
 * @param {string} keywords
 * @param {object} opts
 * @param {string} [opts.searchIndex] - e.g. "All", "Books", "Electronics"
 * @param {number} [opts.itemCount] - default 10
 * @param {number} [opts.budgetMinCents] - min price filter (Creators API minPrice: positive integer, lowest denomination e.g. cents; items with price above this)
 * @param {number} [opts.budgetMaxCents] - max price filter (Creators API maxPrice: positive integer, lowest denomination e.g. cents; items with price below this)
 * @returns {Promise<object[]>} Catalog-ready products
 */
export async function searchProducts(keywords, opts = {}) {
  const { api, marketplace, partnerTag } = getApi();

  const req = new SearchItemsRequestContent();
  req.partnerTag = partnerTag;
  req.keywords = keywords;
  req.searchIndex = opts.searchIndex || "All";
  req.itemCount = opts.itemCount ?? 10;
  req.resources = SEARCH_RESOURCES;

  // Creators API: minPrice/maxPrice are Positive Integers, lowest currency denomination (e.g. cents). e.g. 3241 = $31.41
  if (opts.budgetMinCents != null && opts.budgetMinCents >= 1) req.minPrice = Math.floor(opts.budgetMinCents);
  if (opts.budgetMaxCents != null && opts.budgetMaxCents >= 1) req.maxPrice = Math.floor(opts.budgetMaxCents);

  const response = await api.searchItems(marketplace, {
    searchItemsRequestContent: req,
  });

  const items = response?.searchResult?.items || [];
  const products = [];
  for (const item of items) {
    const p = itemToProduct(item, partnerTag);
    if (p) products.push(p);
  }
  return products;
}

/**
 * Fetch product details by ASINs.
 * @param {string[]} asins - Up to 10 ASINs
 * @returns {Promise<object[]>} Catalog-ready products
 */
export async function getProductsByAsin(asins) {
  if (!asins?.length) return [];

  const { api, marketplace, partnerTag } = getApi();
  const ids = Array.isArray(asins) ? asins.slice(0, 10) : [asins];

  const req = new GetItemsRequestContent();
  req.partnerTag = partnerTag;
  req.itemIds = ids;
  req.condition = "New";
  req.resources = GET_ITEMS_RESOURCES;

  const response = await api.getItems(marketplace, req);

  const items = response?.itemsResult?.items || [];
  const products = [];
  for (const item of items) {
    const p = itemToProduct(item, partnerTag);
    if (p) products.push(p);
  }
  return products;
}
