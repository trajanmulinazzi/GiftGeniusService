-- GiftGenius Engine — Full PostgreSQL Schema (HLA v2)
-- Run via Supabase Dashboard SQL Editor

-- Drop old tables if upgrading from v1
DROP TABLE IF EXISTS queue_items CASCADE;
DROP TABLE IF EXISTS seen_items CASCADE;
DROP TABLE IF EXISTS interactions CASCADE;
DROP TABLE IF EXISTS feeds CASCADE;
DROP TABLE IF EXISTS hobby_searches CASCADE;
DROP TABLE IF EXISTS catalog CASCADE;
DROP TABLE IF EXISTS feed_events CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS dislike_suppressions CASCADE;
DROP TABLE IF EXISTS profile_weights CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS cross_hobby_expansions CASCADE;
DROP TABLE IF EXISTS amazon_cache CASCADE;
DROP TABLE IF EXISTS api_call_tracking CASCADE;
DROP TABLE IF EXISTS occasion_search_terms CASCADE;
DROP TABLE IF EXISTS hobby_angle_expansions CASCADE;
DROP TABLE IF EXISTS hobbies CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ============================================================
-- 1. Reference Tables (static, pre-populated)
-- ============================================================

CREATE TABLE hobbies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE hobby_angle_expansions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hobby_id UUID REFERENCES hobbies(id) ON DELETE CASCADE,
  angle TEXT NOT NULL CHECK (angle IN ('consumable','skill','experience','aesthetic','social','wildcard')),
  search_terms JSONB NOT NULL,
  computed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(hobby_id, angle)
);

CREATE TABLE occasion_search_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occasion TEXT NOT NULL,
  budget_bucket TEXT NOT NULL,
  search_terms JSONB NOT NULL,
  computed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(occasion, budget_bucket)
);

CREATE TABLE cross_hobby_expansions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_key TEXT NOT NULL UNIQUE,
  search_terms JSONB NOT NULL,
  computed_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 2. Caching Tables
-- ============================================================

CREATE TABLE amazon_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key TEXT NOT NULL UNIQUE,
  search_term TEXT NOT NULL,
  budget_bucket TEXT NOT NULL,
  items JSONB NOT NULL,
  cached_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  hit_count INT DEFAULT 0
);

CREATE INDEX idx_amazon_cache_expires ON amazon_cache(expires_at);
CREATE INDEX idx_amazon_cache_key ON amazon_cache(cache_key);

CREATE TABLE api_call_tracking (
  date_key DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  call_count INT DEFAULT 0
);

-- ============================================================
-- 3. User & Profile Tables
-- ============================================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  hobby_ids UUID[] NOT NULL,
  budget_min INT NOT NULL,
  budget_max INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE profile_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  hobby_id UUID REFERENCES hobbies(id),
  angle TEXT NOT NULL,
  weight FLOAT NOT NULL DEFAULT 1.0,
  consecutive_shown INT DEFAULT 0,
  cooldown_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(profile_id, hobby_id, angle)
);

CREATE TABLE dislike_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  suppression_type TEXT NOT NULL CHECK (suppression_type IN ('item','cluster')),
  item_asin TEXT,
  hobby_id UUID,
  angle TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 4. Session & Feed Tables
-- ============================================================

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  occasion TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE feed_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES profiles(id),
  item_asin TEXT NOT NULL,
  item_snapshot JSONB NOT NULL,
  hobby_id UUID,
  angle TEXT,
  slot_type TEXT NOT NULL CHECK (slot_type IN ('interest','adjacent','wildcard','occasion')),
  signal TEXT CHECK (signal IN ('skip','save','shop_now','dislike')),
  served_at TIMESTAMPTZ DEFAULT now(),
  acted_at TIMESTAMPTZ
);

CREATE INDEX idx_feed_events_profile ON feed_events(profile_id);
CREATE INDEX idx_feed_events_asin ON feed_events(item_asin);
CREATE INDEX idx_feed_events_session ON feed_events(session_id);

-- ============================================================
-- 5. RPC Functions (called via supabase.rpc() from JS client)
-- ============================================================

-- Increment amazon_cache hit count
CREATE OR REPLACE FUNCTION increment_cache_hit(p_cache_key TEXT)
RETURNS VOID AS $$
  UPDATE amazon_cache SET hit_count = hit_count + 1 WHERE cache_key = p_cache_key;
$$ LANGUAGE sql;

-- Get or init daily API call count, returns current count
CREATE OR REPLACE FUNCTION get_daily_call_count(p_date DATE)
RETURNS INT AS $$
  INSERT INTO api_call_tracking (date_key, call_count) VALUES (p_date, 0)
  ON CONFLICT (date_key) DO NOTHING;
  SELECT call_count FROM api_call_tracking WHERE date_key = p_date;
$$ LANGUAGE sql;

-- Increment daily API call count, returns new count
CREATE OR REPLACE FUNCTION increment_daily_calls(p_date DATE)
RETURNS INT AS $$
  INSERT INTO api_call_tracking (date_key, call_count) VALUES (p_date, 1)
  ON CONFLICT (date_key) DO UPDATE SET call_count = api_call_tracking.call_count + 1;
  SELECT call_count FROM api_call_tracking WHERE date_key = p_date;
$$ LANGUAGE sql;

-- Adjust profile weight with floor/ceiling
CREATE OR REPLACE FUNCTION adjust_weight(
  p_profile_id UUID, p_hobby_id UUID, p_angle TEXT,
  p_delta FLOAT, p_floor FLOAT, p_ceiling FLOAT
) RETURNS VOID AS $$
  UPDATE profile_weights
  SET weight = GREATEST(LEAST(weight + p_delta, p_ceiling), p_floor),
      updated_at = now()
  WHERE profile_id = p_profile_id AND hobby_id = p_hobby_id AND angle = p_angle;
$$ LANGUAGE sql;

-- Set weight to exact value (for dislike → 0.0)
CREATE OR REPLACE FUNCTION set_weight(
  p_profile_id UUID, p_hobby_id UUID, p_angle TEXT, p_weight FLOAT
) RETURNS VOID AS $$
  UPDATE profile_weights
  SET weight = p_weight, updated_at = now()
  WHERE profile_id = p_profile_id AND hobby_id = p_hobby_id AND angle = p_angle;
$$ LANGUAGE sql;

-- Set weight + cooldown (for shop_now)
CREATE OR REPLACE FUNCTION adjust_weight_with_cooldown(
  p_profile_id UUID, p_hobby_id UUID, p_angle TEXT,
  p_delta FLOAT, p_ceiling FLOAT, p_cooldown_days INT
) RETURNS VOID AS $$
  UPDATE profile_weights
  SET weight = LEAST(weight + p_delta, p_ceiling),
      cooldown_until = now() + (p_cooldown_days || ' days')::interval,
      updated_at = now()
  WHERE profile_id = p_profile_id AND hobby_id = p_hobby_id AND angle = p_angle;
$$ LANGUAGE sql;

-- Weight decay: drift all stale weights 2% toward 1.0
CREATE OR REPLACE FUNCTION apply_weight_decay()
RETURNS INT AS $$
  WITH updated AS (
    UPDATE profile_weights
    SET weight = weight + (1.0 - weight) * 0.02,
        updated_at = now()
    WHERE updated_at < now() - interval '1 day'
    RETURNING id
  )
  SELECT COUNT(*)::int FROM updated;
$$ LANGUAGE sql;
