-- Incremental migration 004 — per-item hobby relevance.
-- Apply with: node scripts/apply-sql.js db/migrations/004_item_hobby_relevance.sql
--
-- An item's hobby_id records which hobby's search surfaced it, not what the
-- product is: Amazon keyword-matches loosely, so "crossword puzzle lap desk
-- with storage" returns plain lap desks that arrive attributed to crosswords.
-- This table stores Claude's judgement of whether a product actually suits the
-- hobby, so the feed can drop the worst and the client can avoid labelling an
-- item with a hobby it has nothing to do with.

CREATE TABLE IF NOT EXISTS item_hobby_relevance (
  item_asin TEXT NOT NULL,
  hobby_id UUID NOT NULL REFERENCES hobbies(id) ON DELETE CASCADE,
  -- 0 = unrelated to the hobby, 1 = unmistakably for it.
  affinity REAL NOT NULL CHECK (affinity >= 0 AND affinity <= 1),
  -- Title as classified; lets us re-run when a cache refresh changes the title.
  title TEXT,
  model TEXT NOT NULL,
  checked_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (item_asin, hobby_id)
);

CREATE INDEX IF NOT EXISTS idx_item_hobby_relevance_hobby
  ON item_hobby_relevance(hobby_id);
