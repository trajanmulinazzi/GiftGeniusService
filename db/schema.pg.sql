-- GiftGenius Engine - PostgreSQL schema
-- Defines tables: catalog, users, feeds, interactions
-- Run with: psql -U giftgenius -d giftgenius -f db/schema.pg.sql
-- Or via docker: docker exec -i giftgenius-postgres psql -U giftgenius -d giftgenius < db/schema.pg.sql

-- Shared product catalog (source of truth)
CREATE TABLE IF NOT EXISTS catalog (
  id SERIAL PRIMARY KEY,
  source_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT,
  price_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  buy_url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  rating NUMERIC(3,2),
  reviews_count INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  last_refreshed TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  times_shown INTEGER NOT NULL DEFAULT 0,
  times_liked INTEGER NOT NULL DEFAULT 0,
  last_shown_at TIMESTAMPTZ,
  UNIQUE(source, source_id)
);

-- Migration: add columns if upgrading from older schema
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS times_shown INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS times_liked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS last_shown_at TIMESTAMPTZ;
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS rating NUMERIC(3,2);
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS reviews_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_catalog_source ON catalog(source);
CREATE INDEX IF NOT EXISTS idx_catalog_active ON catalog(active);
CREATE INDEX IF NOT EXISTS idx_catalog_price ON catalog(price_cents);

-- Users: app users (gift-givers), each with multiple feeds (recipients)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Feeds: personalized recommendation contexts (one per recipient in user's life)
CREATE TABLE IF NOT EXISTS feeds (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  age_min INTEGER,
  age_max INTEGER,
  relationship TEXT,
  interests TEXT NOT NULL DEFAULT '[]',
  budget_min DOUBLE PRECISION,
  budget_max DOUBLE PRECISION,
  occasion TEXT,
  tag_weights TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Migration: add user_id to feeds for existing schemas
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'feeds' AND column_name = 'user_id') THEN
    INSERT INTO users (name) SELECT 'Default User' WHERE NOT EXISTS (SELECT 1 FROM users LIMIT 1);
    ALTER TABLE feeds ADD COLUMN user_id INTEGER REFERENCES users(id);
    UPDATE feeds SET user_id = (SELECT id FROM users ORDER BY id LIMIT 1) WHERE user_id IS NULL;
    ALTER TABLE feeds ALTER COLUMN user_id SET NOT NULL;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL; -- Ignore if already migrated
END $$;

CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);

-- Interactions: what the user did with each item (learning signal)
CREATE TABLE IF NOT EXISTS interactions (
  id SERIAL PRIMARY KEY,
  feed_id INTEGER NOT NULL REFERENCES feeds(id),
  catalog_item_id INTEGER NOT NULL REFERENCES catalog(id),
  type TEXT NOT NULL CHECK (type IN ('like', 'pass', 'save')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(feed_id, catalog_item_id)
);

CREATE INDEX IF NOT EXISTS idx_interactions_feed ON interactions(feed_id);
CREATE INDEX IF NOT EXISTS idx_interactions_catalog ON interactions(catalog_item_id);

-- Seen items: records which catalog items were already served to a feed.
-- Prevents re-serving duplicates even before an explicit interaction is sent.
CREATE TABLE IF NOT EXISTS seen_items (
  id SERIAL PRIMARY KEY,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  catalog_item_id INTEGER NOT NULL REFERENCES catalog(id),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(feed_id, catalog_item_id)
);

CREATE INDEX IF NOT EXISTS idx_seen_items_feed ON seen_items(feed_id);
CREATE INDEX IF NOT EXISTS idx_seen_items_catalog ON seen_items(catalog_item_id);

-- Per-feed persisted queue (~6 items); refill when ≤3 remain
CREATE TABLE IF NOT EXISTS queue_items (
  id SERIAL PRIMARY KEY,
  feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  catalog_item_id INTEGER NOT NULL REFERENCES catalog(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_queue_items_feed ON queue_items(feed_id);
