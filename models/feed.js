import { getDb, persistDb } from "../db/index.js";

/**
 * Feed model - personalized recommendation context (one per recipient/gift list)
 */

export async function createFeed({
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
  const interestsJson =
    typeof interests === "string" ? interests : JSON.stringify(interests || []);

  const result = await pool.query(
    `INSERT INTO feeds (name, age_min, age_max, relationship, interests, budget_min, budget_max, occasion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      name,
      ageMin ?? null,
      ageMax ?? null,
      relationship ?? null,
      interestsJson,
      budgetMin ?? null,
      budgetMax ?? null,
      occasion ?? null,
    ]
  );
  persistDb();
  return result.rows[0].id;
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
