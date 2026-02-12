/**
 * Database schema for GiftGenius Engine (Catalog + Ranking architecture)
 */

export const SCHEMA = `
-- Shared product catalog (source of truth)
CREATE TABLE IF NOT EXISTS catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  image_url TEXT,
  price_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  buy_url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  last_refreshed TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_source ON catalog(source);
CREATE INDEX IF NOT EXISTS idx_catalog_active ON catalog(active);
CREATE INDEX IF NOT EXISTS idx_catalog_price ON catalog(price_cents);

-- Feeds: personalized recommendation contexts (one per recipient/gift list)
CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  age_min INTEGER,
  age_max INTEGER,
  relationship TEXT,
  interests TEXT NOT NULL DEFAULT '[]',
  budget_min REAL,
  budget_max REAL,
  occasion TEXT,
  tag_weights TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Interactions: what the user did with each item (learning signal)
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id INTEGER NOT NULL,
  catalog_item_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('like', 'pass', 'save')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (feed_id) REFERENCES feeds(id),
  FOREIGN KEY (catalog_item_id) REFERENCES catalog(id),
  UNIQUE(feed_id, catalog_item_id)
);

CREATE INDEX IF NOT EXISTS idx_interactions_feed ON interactions(feed_id);
CREATE INDEX IF NOT EXISTS idx_interactions_catalog ON interactions(catalog_item_id);
`;
