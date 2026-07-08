-- Incremental migration 001 — per-user Clerk identity + per-profile occasion.
-- Safe to run on an existing, populated database (no DROP / no data loss).
-- Apply with: node scripts/apply-sql.js db/migrations/001_clerk_identity_occasion.sql

-- 1. Link backend users to their Clerk identity.
--    NULLs are allowed (legacy/seeded users); Postgres permits multiple NULLs
--    under a UNIQUE constraint, and the constraint lets us upsert by clerk id.
ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_clerk_user_id_key'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_clerk_user_id_key UNIQUE (clerk_user_id);
  END IF;
END $$;

-- Auto-provisioned users may be created before we know their name.
ALTER TABLE users ALTER COLUMN name SET DEFAULT 'GiftGenius User';

-- 2. Persist the occasion on the profile so switching feeds keeps the chosen
--    occasion instead of silently falling back to 'just_because'.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS occasion TEXT NOT NULL DEFAULT 'just_because';
