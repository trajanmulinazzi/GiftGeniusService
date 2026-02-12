import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config();

const { Pool } = pg;

let _pool = null;

function getConnectionConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
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
