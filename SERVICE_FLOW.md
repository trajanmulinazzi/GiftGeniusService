# GiftGenius Service Flow Reference

This document explains how the `giftgenius-engine` package works as a service and recommendation engine.

It is written for engineers/agents who need to quickly understand:

- what the service does
- how data moves through the system
- which files own which responsibilities
- how feed recommendations are produced and updated

---

## 1) What This Package Is

`giftgenius-engine` is a Node.js backend that powers personalized gift discovery.

It supports two execution modes:

1. **CLI mode** (`npm start`)  
   Interactive flow for creating/selecting user/feed and swiping Shop/Save/Dislike.

2. **API mode** (`npm run start:api`)  
   Fastify HTTP service used by frontend clients. Serves items in batches.

Core behavior is shared: feeds, two-tier refill, interactions, and deterministic ranking.

---

## 2) High-Level Architecture

Main layers:

- **Transport layer**
  - CLI entrypoint: `index.js`
  - API entrypoint: `server.js`

- **Service layer**
  - Refill orchestration (two-tier): `services/refill.js`
  - Ranking, scoring, and weight updates: `services/ranking.js`
  - Atomic interaction + learning: `services/feed-interactions.js`
  - Retail providers:
    - Amazon Creators API: `services/amazon-api.js`
    - Canopy fallback: `services/canopy-api.js`

- **Data access layer (models)**
  - Users: `models/user.js`
  - Feeds: `models/feed.js`
  - Queue: `models/queue.js`
  - Catalog: `models/catalog.js`
  - Interactions: `models/interaction.js`

- **Persistence**
  - PostgreSQL schema: `db/schema.pg.sql`
  - DB connection/pool: `db/index.js`

---

## 3) Core Domain Objects

### User
Gift-giver identity. One user has many feeds.

### Feed
Recipient-specific context:
- name / relationship
- interests (input keywords)
- budget range
- `tag_weights` (learned preference state)
- `last_batch_at` (timestamp for scroll-past detection)

### Catalog Item
Shared cached product row:
- source/source_id
- title, image, price, currency, buy URL
- tags (JSON string in DB)
- `last_refreshed` (for cache freshness)

### Interaction
Per feed + item preference (`shop` | `save` | `dislike` | `scroll_past`), upserted.
Legacy types `like` and `pass` are still accepted.

### Queue Item
Persisted per-feed queue pointing to catalog item IDs.

---

## 4) End-to-End Flow (Recommendation Loop)

This is the central loop for both CLI and API feed consumption.

1. **Select/create feed**
   - User picks a feed (or creates one with interests + budget).
   - New feed seeds initial `tag_weights` from entered interests (+1 each).

2. **Get next batch**
   - API: `GET /feeds/:feedId/next?count=6` dequeues a batch.
   - CLI: dequeues one item at a time.
   - If queue is empty, triggers `refillQueue(feedId)` and retries.

3. **Scroll-past detection (automatic)**
   - On batch request: items from the previous batch with no explicit interaction are recorded as `scroll_past` (tag weights updated at −0.25 per tag).

4. **Show products**
   - Batch is returned to the client. Items are marked as shown + seen.
   - `recordShown(catalogItemId)` increments display counters.

5. **Record interactions**
   - Client posts `shop`/`save`/`dislike` individually as user acts.
   - `recordInteractionWithLearning()` atomically upserts interaction + updates `tag_weights`:
     - shop: +2.0 per tag
     - save: +1.5 per tag
     - scroll_past: −0.25 per tag (auto-detected)
     - dislike: −1.0 per tag

6. **Background refill trigger**
   - If queue size ≤ 3 after dequeue, refill runs in background.

---

## 5) Refill Logic (Two-Tier Sourcing)

`services/refill.js` is the heart of recommendations.

### Inputs
- feed state (`interests`, `tag_weights`, budget)
- already seen items for that feed

### Search term selection
- Initial refill (queue empty): uses feed interests.
- Later refills: uses top 5 positive weighted tags (fallback to interests if none).

### Tier 1: Cache-first
- Query catalog for unseen items matching top tags, within budget.
- Uses `getUnseenCandidates()` with GIN index on `tags::jsonb`.
- If enough candidates (≥6): rank and fill queue. **Zero API calls.**

### Tier 2: API fetch (only when cache is thin)
- Always sample from **top 3 terms first**, then continue remaining terms.
- Primary: Amazon Creators API. Fallback: Canopy API.
- **ALL results are upserted** into catalog (not just picks for this feed).
- Per-term provider failures are caught and logged; refill continues.

### Combine, rank, enqueue
- Merge cached + freshly-fetched candidates.
- Rank deterministically via `rankItems` (tag weights + interest bonus + freshness − oversaturation).
- Apply diversity cap (max 2 items per tag).
- Append selected item IDs to `queue_items`.

### Relationship fallback
- If still short after all terms, tries a relationship-based phrase (e.g. "gifts for mom").

---

## 6) Tagging + Learning Model

Tag extraction for Amazon items (`services/amazon-api.js`) is priority-based:

1. Category fields first (`productGroup`, `binding`)
2. Title phrase mapping (n-grams)
3. Feature phrase mapping (mapped terms only)
4. Brand as weak signal
5. Fallback from refill search term when item ends up tagless

Tags are normalized through canonical mapping (`data/tag-canonical.js`) during extraction.

Important distinction:
- **Initial feed hobby weights** are stored as raw lowercased hobby terms.
- **Item tags** are canonicalized/tag-mapped.

This can produce mixed vocab in `tag_weights` over time; this is currently accepted behavior.

---

## 7) API Surface

From `server.js`:

- `GET /health`
- `GET /ready`
- `GET /users`
- `POST /users`
- `POST /auth/login`
- `GET /feeds?userId=...`
- `POST /feeds`
- `GET /feeds/:feedId/next?count=6` — **batch endpoint**
- `POST /feeds/:feedId/interactions`
- `GET /feeds/:feedId/saved`

### Auth boundary
Feed-scoped routes require `Authorization: Bearer <jwt>` and feed ownership checks.

### Batch serving
`/next` returns an array of items (default 6, max 20). The client swipes through them locally and sends interactions individually.

### Validation
Routes use Zod runtime validation and Fastify schema metadata.

### Error format
All API errors use:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

### Rate limiting
Global + per-route limits are enabled via `@fastify/rate-limit`.

---

## 8) File Ownership Guide

Use this quick map when modifying behavior:

- **API routes/auth/validation/rate limit**: `server.js`
- **Queue refill policy (two-tier)**: `services/refill.js`
- **Score math / tag weight updates**: `services/ranking.js`
- **Atomic interaction + learning**: `services/feed-interactions.js`
- **Amazon mapping/tag extraction**: `services/amazon-api.js`
- **Canonical taxonomy**: `data/tag-canonical.js`
- **Feed creation/search term logic**: `models/feed.js`
- **Interaction persistence / seen tracking**: `models/interaction.js`
- **Queue persistence/dequeue/batch**: `models/queue.js`
- **Catalog upsert/read/cache-first query**: `models/catalog.js`

---

## 9) Operational Notes

- Environment variables are loaded from `.env.local` then `.env`.
- Secrets must stay in env vars only.
- DB schema changes should go through `db/schema.pg.sql` migrations.
- Logs:
  - API logs are structured via Fastify logger.
  - Refill debug writes to `queue.log` (`LOG_REFILL=1` mirrors to console).

---

## 10) Known Design Constraints / Tradeoffs

- Initial weights (raw hobbies) vs canonical item tags may diverge vocabulary.
- Interaction update currently depends on item tags stored in catalog.
- Queue refill is deterministic but provider responses can vary by term/provider availability.
- Auth boundary is JWT bearer token; client-provided user headers are not trusted.
- Cache-first queries depend on GIN index on `tags::jsonb`; catalog must have canonical tags.

---

## 11) Quick Local Smoke Test

1. Start DB + migrate:

```bash
docker-compose up -d
npm run db:migrate
```

2. Start API:

```bash
npm run start:api
```

3. Hit health:

```bash
curl -s http://127.0.0.1:3000/health
```

4. Create user/feed and fetch next batch using README examples.

---

## 12) If You Are an Agent Making Changes

Before editing, identify which layer you are changing:

- transport (API/CLI)
- refill policy (two-tier sourcing)
- ranking math
- tagging taxonomy
- DB model semantics

Then verify:

- validation still matches expected payload shape
- authorization still protects feed-scoped routes
- SQL remains parameterized
- no secrets or internal stack traces leak to clients
