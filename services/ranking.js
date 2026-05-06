/**
 * Ranking service - deterministic scoring of catalog items for a feed
 * Score = sum(tag weights) + explicit-interest bonus + freshness bonus - oversaturation penalty
 *
 * Interaction signal strengths:
 *   shop        +2.0  (user clicked to buy — strongest positive)
 *   save        +1.5  (user bookmarked for later)
 *   like        +1.0  (legacy positive — kept for backward compat)
 *   scroll_past -0.25 (implicit — user scrolled without acting)
 *   pass        -0.5  (legacy mild negative)
 *   dislike     -1.0  (active rejection)
 */

const WEIGHT_DELTAS = {
  shop: 2.0,
  save: 1.5,
  like: 1.0,
  scroll_past: -0.25,
  pass: -0.5,
  dislike: -1.0,
};

const EXPLICIT_INTEREST_BONUS = 2;
const FRESHNESS_BONUS = 0.5;
const FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const OVERSATURATION_PENALTY = 1;
const OVERSATURATION_WINDOW = 5; // look at last N shown items

/**
 * Update feed tag weights based on an interaction.
 * @param {Object} tagWeights - current { tag: weight } map
 * @param {string[]} itemTags - tags of the item interacted with
 * @param {string} type - interaction type (shop/save/like/dislike/pass/scroll_past)
 * @returns {Object} updated tag weights
 */
export function updateTagWeightsFromInteraction(tagWeights, itemTags, type) {
  const next = { ...tagWeights };
  if (!itemTags?.length) return next;

  const delta = WEIGHT_DELTAS[type] ?? 0;

  for (const tag of itemTags) {
    const t = String(tag).toLowerCase();
    next[t] = (next[t] || 0) + delta;
  }
  return next;
}

/**
 * Parse tags from a catalog item (supports JSON string or array)
 */
function getItemTags(item) {
  if (!item) return [];
  let tags = item.tags;
  if (typeof tags === "string") {
    try {
      tags = JSON.parse(tags);
    } catch {
      return [];
    }
  }
  return Array.isArray(tags) ? tags : [];
}

/**
 * Score a single catalog item for a feed.
 * @param {Object} item - catalog item with tags, last_refreshed
 * @param {Object} tagWeights - feed's tag weights
 * @param {string[]} explicitInterests - feed's explicit interests
 * @param {Set<string>} [recentTags] - tags from recently shown items (for oversaturation)
 * @returns {number} score
 */
export function scoreItem(item, tagWeights, explicitInterests = [], recentTags = new Set()) {
  const itemTags = getItemTags(item).map((t) => String(t).toLowerCase());
  const interestSet = new Set(
    (explicitInterests || []).map((i) => String(i).toLowerCase())
  );

  let score = 0;

  // Sum tag weights
  for (const tag of itemTags) {
    score += tagWeights[tag] || 0;
  }

  // Bonus for matching explicit interests
  for (const tag of itemTags) {
    if (interestSet.has(tag)) {
      score += EXPLICIT_INTEREST_BONUS;
    }
  }

  // Freshness bonus: items fetched/refreshed in last 24h get a bump
  if (item.last_refreshed) {
    const refreshed = new Date(item.last_refreshed).getTime();
    if (Date.now() - refreshed < FRESHNESS_WINDOW_MS) {
      score += FRESHNESS_BONUS;
    }
  }

  // Oversaturation penalty: tags that appeared in recently shown items get penalized
  for (const tag of itemTags) {
    if (recentTags.has(tag)) {
      score -= OVERSATURATION_PENALTY;
    }
  }

  return score;
}

/**
 * Rank a list of catalog items for a feed.
 * @param {Object[]} items - catalog items
 * @param {Object} feed - feed with tag_weights and interests
 * @param {Object[]} [recentItems] - last N items shown (for oversaturation)
 * @returns {Object[]} items sorted by score descending
 */
export function rankItems(items, feed, recentItems = []) {
  const tagWeights = feed.tag_weights || {};
  const interests = feed.interests || [];

  // Build set of tags from recently shown items for oversaturation check
  const recentTags = new Set();
  for (const ri of recentItems.slice(-OVERSATURATION_WINDOW)) {
    for (const tag of getItemTags(ri)) {
      recentTags.add(String(tag).toLowerCase());
    }
  }

  const scored = items.map((item) => ({
    item,
    score: scoreItem(item, tagWeights, interests, recentTags),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
