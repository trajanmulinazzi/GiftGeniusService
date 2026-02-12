/**
 * Ranking service - deterministic scoring of catalog items for a feed
 * Score = sum(tag weights) + explicit-interest bonuses - penalties
 */

const LIKE_WEIGHT_DELTA = 1;
const PASS_WEIGHT_DELTA = -0.5;
const EXPLICIT_INTEREST_BONUS = 2;

/**
 * Update feed tag weights based on an interaction.
 * @param {Object} tagWeights - current { tag: weight } map
 * @param {string[]} itemTags - tags of the item interacted with
 * @param {'like'|'pass'|'save'} type - interaction type
 * @returns {Object} updated tag weights
 */
export function updateTagWeightsFromInteraction(tagWeights, itemTags, type) {
  const next = { ...tagWeights };
  if (!itemTags?.length) return next;

  const delta = type === "like" || type === "save" ? LIKE_WEIGHT_DELTA : PASS_WEIGHT_DELTA;

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
 * @param {Object} item - catalog item with tags
 * @param {Object} tagWeights - feed's tag weights
 * @param {string[]} explicitInterests - feed's explicit interests (e.g. hobbies)
 * @returns {number} score
 */
export function scoreItem(item, tagWeights, explicitInterests = []) {
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

  return score;
}

/**
 * Rank a list of catalog items for a feed.
 * @param {Object[]} items - catalog items
 * @param {Object} feed - feed with tag_weights and interests
 * @returns {Object[]} items sorted by score descending
 */
export function rankItems(items, feed) {
  const tagWeights = feed.tag_weights || {};
  const interests = feed.interests || [];
  const scored = items.map((item) => ({
    item,
    score: scoreItem(item, tagWeights, interests),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
