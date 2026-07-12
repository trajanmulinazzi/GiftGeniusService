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
