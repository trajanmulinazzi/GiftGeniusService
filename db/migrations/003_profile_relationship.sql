-- Incremental migration 003 — optional relationship on profiles.
-- Apply with: node scripts/apply-sql.js db/migrations/003_profile_relationship.sql

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS relationship TEXT;
