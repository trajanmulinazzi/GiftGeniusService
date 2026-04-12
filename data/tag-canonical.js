/**
 * Canonical tag taxonomy: map raw words/phrases from API (categories, features, title)
 * to a bounded set of tags. Keeps feed tag_weights small and refill search terms meaningful.
 *
 * - Only canonical tags are stored in catalog and used in feed tag weights.
 * - Add entries to RAW_TO_CANONICAL to map product words → canonical tag.
 * - Canonical tags should be good search terms (e.g. "technology", "outdoor", "kitchen").
 */

/** Max canonical tags per product (keeps vocabulary bounded). */
export const MAX_TAGS_PER_PRODUCT = 12;

/**
 * Raw word or slug → canonical tag.
 * Multiple raw terms can map to the same canonical tag (e.g. device, stream, display → technology).
 */
export const RAW_TO_CANONICAL = {
  // Technology / electronics
  technology: "technology",
  tech: "technology",
  electronics: "technology",
  device: "technology",
  devices: "technology",
  "amazon-devices": "technology",
  stream: "technology",
  streaming: "technology",
  display: "technology",
  smart: "technology",
  audio: "technology",
  camera: "technology",
  wireless: "technology",
  bluetooth: "technology",
  wifi: "technology",
  speaker: "technology",
  headphones: "technology",
  tablet: "technology",
  gaming: "technology",
  gamer: "technology",

  // Outdoor / fitness
  outdoor: "outdoor",
  outdoors: "outdoor",
  hiking: "outdoor",
  camping: "outdoor",
  backpack: "outdoor",
  hydration: "outdoor",
  running: "outdoor",
  cycling: "outdoor",
  fitness: "outdoor",
  sports: "outdoor",
  "sports-outdoors": "outdoor",
  "outdoor-recreation": "outdoor",
  "hydration-packs": "outdoor",

  // Home / living
  home: "home",
  kitchen: "kitchen",
  cooking: "kitchen",
  "home-decor": "home",
  decor: "home",
  living: "home",

  // Style / wearables
  fashion: "fashion",
  clothing: "fashion",
  apparel: "fashion",
  jewelry: "fashion",
  watch: "fashion",
  watches: "fashion",

  // Books / media
  books: "books",
  book: "books",
  reading: "books",
  music: "music",
  movie: "music",
  entertainment: "music",

  // Health / wellness
  health: "wellness",
  wellness: "wellness",
  yoga: "wellness",
  skincare: "wellness",
  beauty: "wellness",
  self-care: "wellness",

  // Kids / family
  kids: "kids",
  baby: "kids",
  family: "kids",
  toys: "kids",
  games: "kids",
  "board-game": "games",
  puzzle: "games",

  // Pet
  pet: "pets",
  pets: "pets",
  dog: "pets",
  cat: "pets",
  "cat-toy": "pets",
  "dog-toy": "pets",
  "cat-food": "pets",
  "dog-food": "pets",
  "cat-care": "pets",
  "dog-care": "pets",
  "cat-grooming": "pets",
  "dog-grooming": "pets",
  "cat-health": "pets",
  "dog-health": "pets",
  "cat-training": "pets",
  "dog-training": "pets",
  "cat-behavior": "pets",
  "dog-behavior": "pets",
  "cat-breeds": "pets",
  "dog-breeds": "pets",
  "cat-breeds": "pets",

  // Office / workspace
  office: "office",
  workspace: "office",
  desk: "office",

  // Automotive / tools
  automotive: "automotive",
  tools: "tools",
  garden: "garden",
  gardening: "garden",

  // Generic / meta
  prime: "prime",
  amazon: "technology",
  accessories: "outdoor",
};

/**
 * Normalize raw tags to canonical set. Unmapped tags are dropped.
 * @param {string[]} rawTags - Tags from API (categories, features, title, etc.)
 * @param {{ maxTags?: number }} [opts] - maxTags caps output length (default MAX_TAGS_PER_PRODUCT)
 * @returns {string[]} Unique canonical tags, order preserved, capped
 */
export function normalizeTags(rawTags, opts = {}) {
  const max = opts.maxTags ?? MAX_TAGS_PER_PRODUCT;
  const seen = new Set();
  const out = [];
  for (const raw of rawTags) {
    if (!raw || typeof raw !== "string") continue;
    const key = raw.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const canonical = RAW_TO_CANONICAL[key] ?? RAW_TO_CANONICAL[raw.toLowerCase()];
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
      if (out.length >= max) break;
    }
  }
  return out;
}
