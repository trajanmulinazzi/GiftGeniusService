/**
 * Amazon Creators API service wrapper
 * Fetches product data via SearchItems and GetItems for catalog ingestion.
 * Requires AMAZON_CREDENTIAL_ID, AMAZON_CREDENTIAL_SECRET, AMAZON_PARTNER_TAG in env.
 */

import { createRequire } from "node:module";

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
  const version = process.env.AMAZON_CREDENTIAL_VERSION || "2.1";
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
function featureToTag(feature) {
  if (typeof feature !== "string" || !feature.trim()) return null;
  const words = feature.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4);
  return words[0]?.slice(0, 30) || null;
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

  const tags = [];
  const seen = new Set();

  const add = (tag) => {
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  };

  const itemInfo = item.itemInfo || {};
  const classif = itemInfo.classifications || {};
  add(toTag(classif.productGroup?.displayValue));
  add(toTag(classif.binding?.displayValue));

  const byLine = itemInfo.byLineInfo || {};
  add(toTag(byLine.brand?.displayValue));

  const productInfo = itemInfo.productInfo || {};
  add(toTag(productInfo.color?.displayValue));
  add(toTag(productInfo.size?.displayValue));

  const features = itemInfo.features?.displayValues || [];
  if (Array.isArray(features)) {
    for (const f of features.slice(0, 5)) {
      add(featureToTag(typeof f === "string" ? f : String(f)));
    }
  }

  return {
    source_id: asin,
    source: "amazon",
    title,
    image_url: imageUrl,
    price_cents: priceCents,
    currency,
    buy_url: buyUrl,
    tags: tags.filter(Boolean),
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
 * Search Amazon products by keywords.
 * @param {string} keywords
 * @param {object} opts
 * @param {string} [opts.searchIndex] - e.g. "All", "Books", "Electronics"
 * @param {number} [opts.itemCount] - default 10
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
