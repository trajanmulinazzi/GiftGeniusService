-- GiftGenius Engine - PostgreSQL schema
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
  active INTEGER NOT NULL DEFAULT 1,
  last_refreshed TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_source ON catalog(source);
CREATE INDEX IF NOT EXISTS idx_catalog_active ON catalog(active);
CREATE INDEX IF NOT EXISTS idx_catalog_price ON catalog(price_cents);

-- Feeds: personalized recommendation contexts (one per recipient/gift list)
CREATE TABLE IF NOT EXISTS feeds (
  id SERIAL PRIMARY KEY,
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
