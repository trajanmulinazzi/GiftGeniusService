import { getDb, persistDb } from "../db/index.js";
import { getExpandedSearchTerms } from "../services/search-term-expander.js";

/**
 * Feed model - personalized recommendation context (one per recipient/gift list)
 */

export async function createFeed({
  userId,
  name,
  ageMin,
  ageMax,
  relationship,
  interests,
  budgetMin,
  budgetMax,
  occasion,
}) {
  const pool = await getDb();
  const interestsArray =
    typeof interests === "string" ? [interests] : Array.isArray(interests) ? interests : [];
  const interestsJson = JSON.stringify(interestsArray);
  const initialTagWeights = buildInitialTagWeights(interestsArray);
  const initialTagWeightsJson = JSON.stringify(initialTagWeights);

  const result = await pool.query(
    `INSERT INTO feeds (user_id, name, age_min, age_max, relationship, interests, budget_min, budget_max, occasion, tag_weights)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      userId,
      name,
      ageMin ?? null,
      ageMax ?? null,
      relationship ?? null,
      interestsJson,
      budgetMin ?? null,
      budgetMax ?? null,
      occasion ?? null,
      initialTagWeightsJson,
    ]
  );
  persistDb();
  return result.rows[0].id;
}

function buildInitialTagWeights(interests) {
  const out = {};
  for (const interest of interests || []) {
    if (typeof interest !== "string") continue;
    const text = interest.trim();
    if (!text) continue;
    // Initial hobby input is stored directly (no canonical mapping).
    // This preserves exact user intent and sends the same terms to API search.
    const key = text.toLowerCase();
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export async function getFeedsByUser(userId) {
  const pool = await getDb();
  const result = await pool.query(
    "SELECT * FROM feeds WHERE user_id = $1 ORDER BY name",
    [userId]
  );
  return result.rows.map(parseFeedRow);
}

export async function updateFeed(id, updates) {
  const pool = await getDb();
  const fields = [];
  const values = [];
  let i = 1;

  const mapping = {
    name: "name",
    ageMin: "age_min",
    ageMax: "age_max",
    relationship: "relationship",
    interests: "interests",
    budgetMin: "budget_min",
    budgetMax: "budget_max",
    occasion: "occasion",
  };

  for (const [key, col] of Object.entries(mapping)) {
    if (updates[key] !== undefined) {
      let val = updates[key];
      if (key === "interests") {
        val = typeof val === "string" ? val : JSON.stringify(val || []);
      }
      fields.push(`${col} = $${i}`);
      values.push(val ?? null);
      i++;
    }
  }

  if (fields.length === 0) return;

  values.push(id);
  await pool.query(
    `UPDATE feeds SET ${fields.join(", ")} WHERE id = $${i}`,
    values
  );
  persistDb();
}

export async function getFeed(id) {
  const pool = await getDb();
  const result = await pool.query("SELECT * FROM feeds WHERE id = $1", [id]);
  const row = result.rows[0] ?? null;
  return parseFeedRow(row);
}

export async function updateTagWeights(feedId, tagWeights) {
  const pool = await getDb();
  const json =
    typeof tagWeights === "string"
      ? tagWeights
      : JSON.stringify(tagWeights || {});
  await pool.query("UPDATE feeds SET tag_weights = $1 WHERE id = $2", [
    json,
    feedId,
  ]);
  persistDb();
}

export async function getTagWeights(feedId) {
  const feed = await getFeed(feedId);
  if (!feed) return {};
  try {
    return typeof feed.tag_weights === "string"
      ? JSON.parse(feed.tag_weights)
      : feed.tag_weights || {};
  } catch {
    return {};
  }
}

const TOP_TAGS_LIMIT = 5;

/**
 * Search terms for refill: expands each hobby/interest into diverse gift
 * search queries via LLM (cached in hobby_searches table).
 *
 * Initial load uses explicit interests; subsequent refills use top tag weights.
 * Each hobby is expanded into ~5 specific search terms (e.g. "coffee" →
 * "espresso machine", "pour over kit", "coffee grinder", etc.)
 *
 * @param {number} feedId
 * @param {boolean} isInitial - true when queue was empty (first refill for this feed session)
 * @returns {Promise<string[]>} expanded search terms for API
 */
export async function getSearchTermsForRefill(feedId, isInitial) {
  const feed = await getFeed(feedId);
  if (!feed) return [];

  // Determine which hobbies/interests to expand
  let hobbies;
  if (isInitial) {
    const interests = feed.interests || [];
    hobbies = Array.isArray(interests) ? interests : [];
  } else {
    const weights = feed.tag_weights || {};
    const entries = Object.entries(weights)
      .filter(([, w]) => typeof w === "number" && w > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_TAGS_LIMIT);
    hobbies =
      entries.length > 0
        ? entries.map(([tag]) => tag)
        : Array.isArray(feed.interests)
          ? feed.interests
          : [];
  }

  if (!hobbies.length) return [];

  // Expand each hobby into diverse search terms via LLM (cached)
  const termsPerHobby = Math.max(2, Math.floor(10 / hobbies.length));
  const allTerms = [];
  for (const hobby of hobbies) {
    const expanded = await getExpandedSearchTerms(hobby, termsPerHobby);
    allTerms.push(...expanded);
  }

  return allTerms;
}

/**
 * Update last_batch_at to now. Called when a new batch is served.
 * On the next batch request, items seen after this timestamp with no
 * interaction are recorded as scroll_past.
 */
export async function updateLastBatchAt(feedId) {
  const pool = await getDb();
  await pool.query(
    "UPDATE feeds SET last_batch_at = now() WHERE id = $1",
    [feedId]
  );
  persistDb();
}

function parseFeedRow(row) {
  if (!row) return null;
  try {
    return {
      ...row,
      interests:
        typeof row.interests === "string"
          ? JSON.parse(row.interests)
          : row.interests,
      tag_weights:
        typeof row.tag_weights === "string"
          ? JSON.parse(row.tag_weights)
          : row.tag_weights,
    };
  } catch {
    return row;
  }
}
