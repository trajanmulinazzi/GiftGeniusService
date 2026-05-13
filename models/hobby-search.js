import { getDb, persistDb } from "../db/index.js";

/**
 * Get all cached search terms for a hobby.
 * @param {string} hobby - e.g. "coffee"
 * @returns {Promise<{ id: number, search_term: string, used_at: string|null }[]>}
 */
export async function getSearchTermsForHobby(hobby) {
  const pool = await getDb();
  const result = await pool.query(
    "SELECT id, search_term, used_at FROM hobby_searches WHERE hobby = $1 ORDER BY created_at",
    [hobby.toLowerCase().trim()]
  );
  return result.rows;
}

/**
 * Get unused search terms for a hobby (never used or least recently used).
 * @param {string} hobby
 * @param {number} limit
 * @returns {Promise<{ id: number, search_term: string }[]>}
 */
export async function getUnusedSearchTerms(hobby, limit = 5) {
  const pool = await getDb();
  const result = await pool.query(
    `SELECT id, search_term FROM hobby_searches
     WHERE hobby = $1
     ORDER BY used_at ASC NULLS FIRST, created_at ASC
     LIMIT $2`,
    [hobby.toLowerCase().trim(), limit]
  );
  return result.rows;
}

/**
 * Mark search terms as used (set used_at = now).
 * @param {number[]} ids
 */
export async function markSearchTermsUsed(ids) {
  if (!ids?.length) return;
  const pool = await getDb();
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  await pool.query(
    `UPDATE hobby_searches SET used_at = now() WHERE id IN (${placeholders})`,
    ids
  );
  persistDb();
}

/**
 * Bulk-insert new search terms for a hobby (skips duplicates).
 * @param {string} hobby
 * @param {string[]} terms
 * @returns {Promise<number>} count of newly inserted terms
 */
export async function insertSearchTerms(hobby, terms) {
  if (!terms?.length) return 0;
  const pool = await getDb();
  const h = hobby.toLowerCase().trim();
  let inserted = 0;
  for (const term of terms) {
    const t = term.trim();
    if (!t) continue;
    const result = await pool.query(
      `INSERT INTO hobby_searches (hobby, search_term) VALUES ($1, $2)
       ON CONFLICT(hobby, search_term) DO NOTHING
       RETURNING id`,
      [h, t]
    );
    if (result.rowCount > 0) inserted++;
  }
  persistDb();
  return inserted;
}
