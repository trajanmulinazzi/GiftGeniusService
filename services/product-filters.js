/**
 * Gift-card detection for products and Amazon search terms.
 * Narrow patterns — does not match "gift set" / "gift basket".
 */

const GIFT_CARD_PRODUCT_RE =
  /\b(e[-\s]?gift(\s*card)?s?|gift\s*cards?|giftcards?)\b/i;

/** Search terms that explicitly ask Amazon for gift cards / certificates. */
const GIFT_CARD_TERM_RE =
  /\b(gift\s*cards?|giftcards?|e[-\s]?gift(\s*card)?s?|gift\s*certificates?)\b/i;

/** At most this many gift-card products in a single feed batch. */
export const MAX_GIFT_CARDS_PER_BATCH = 1;

export function isGiftCardItem(item) {
  const title = item?.title ?? '';
  return GIFT_CARD_PRODUCT_RE.test(title);
}

export function isGiftCardSearchTerm(term) {
  return GIFT_CARD_TERM_RE.test(term ?? '');
}

/** Drop search terms that would primarily surface gift cards. */
export function sanitizeSearchTerms(terms) {
  return (terms ?? []).filter((term) => !isGiftCardSearchTerm(term));
}

// Marketing / unit words that make Amazon titles look different while naming
// the same product. Kept small so "steel mixing bowl" and "steel thermos"
// still count as distinct.
const TITLE_JUNK = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this',
  'pack', 'packs', 'set', 'pcs', 'piece', 'pieces',
  'oz', 'ml', 'mm', 'inch', 'inches',
  'new', 'pro', 'plus', 'premium', 'bundle',
  'adults', 'adult', 'kids', 'home', 'use',
]);

/** Lowercase letters/digits only, collapsed whitespace. */
export function normalizeProductTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleTokens(title) {
  return normalizeProductTitle(title)
    .split(' ')
    .filter((w) => w.length > 2 && !TITLE_JUNK.has(w));
}

/**
 * True when two listings are the same product sold under different ASINs.
 * Identical normalized titles always match; otherwise require 3 shared
 * content tokens covering at least 70% of the shorter title.
 */
export function isSameProductListing(a, b) {
  const titleA = a?.title ?? a;
  const titleB = b?.title ?? b;
  const na = normalizeProductTitle(titleA);
  const nb = normalizeProductTitle(titleB);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const ta = titleTokens(titleA);
  const tb = titleTokens(titleB);
  if (ta.length === 0 || tb.length === 0) return false;
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t)).length;
  const shorter = Math.min(ta.length, tb.length);
  return shared >= 3 && shared / shorter >= 0.7;
}
