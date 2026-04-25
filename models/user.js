import { getDb, persistDb } from "../db/index.js";

/**
 * User model - app users (gift-givers), each with multiple feeds (recipients)
 */

export async function createUser({ name, email }) {
  const pool = await getDb();
  const result = await pool.query(
    `INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id`,
    [name, email ?? null]
  );
  persistDb();
  return result.rows[0].id;
}

export async function getUser(id) {
  const pool = await getDb();
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function getUserByEmail(email) {
  const pool = await getDb();
  const result = await pool.query("SELECT * FROM users WHERE lower(email) = lower($1)", [
    email,
  ]);
  return result.rows[0] ?? null;
}

export async function updateUser(id, { name, email }) {
  const pool = await getDb();
  await pool.query(
    `UPDATE users SET name = COALESCE($1, name), email = COALESCE($2, email), updated_at = now() WHERE id = $3`,
    [name ?? null, email ?? null, id]
  );
  persistDb();
}

export async function listUsers() {
  const pool = await getDb();
  const result = await pool.query(
    "SELECT id, name, email, created_at FROM users ORDER BY name"
  );
  return result.rows;
}
