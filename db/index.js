/**
 * Database connection - PostgreSQL pool for GiftGenius.
 * Loads config from DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE.
 */

import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { Pool } = pg;

let _pool = null;

function getConnectionConfig() {
  const connStr = process.env.DATABASE_URL;
  if (connStr) {
    const config = { connectionString: connStr };
    // Supabase (and most hosted Postgres) requires SSL.
    // Detect by hostname or explicit flag.
    const needsSsl =
      process.env.PGSSLMODE === "require" ||
      connStr.includes("supabase.com") ||
      connStr.includes("neon.tech");
    if (needsSsl) {
      config.ssl = { rejectUnauthorized: false };
    }
    return config;
  }
  return {
    host: process.env.PGHOST ?? "localhost",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "giftgenius",
    password: process.env.PGPASSWORD ?? "giftgenius",
    database: process.env.PGDATABASE ?? "giftgenius",
  };
}

/**
 * Get the Postgres connection pool.
 * Ensure schema is applied first: npm run db:migrate
 */
export async function getDb() {
  if (_pool) return _pool;
  _pool = new Pool(getConnectionConfig());
  return _pool;
}

/**
 * No-op for Postgres (data persists automatically).
 * Kept for API compatibility with models.
 */
export function persistDb() {}
