/**
 * Detect gift-card / e-gift products (for logging and optional filtering).
 * Narrow patterns only — does not match "gift set" / "gift basket".
 */

const GIFT_CARD_RE =
  /\b(e[-\s]?gift(\s*card)?s?|gift\s*cards?|giftcards?)\b/i;

export function isGiftCardItem(item) {
  const title = item?.title ?? '';
  return GIFT_CARD_RE.test(title);
}
