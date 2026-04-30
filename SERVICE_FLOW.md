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
   Interactive flow for creating/selecting user/feed and swiping Like/Pass/Save.

2. **API mode** (`npm run start:api`)  
   Fastify HTTP service used by frontend clients.

Core behavior is shared: feeds, queue refill, interactions, and deterministic ranking.

---

## 2) High-Level Architecture

Main layers:

- **Transport layer**
  - CLI entrypoint: `index.js`
  - API entrypoint: `server.js`

- **Service layer**
  - Refill orchestration: `services/refill.js`
  - Ranking and weight updates: `services/ranking.js`
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

### Catalog Item
Shared cached product row:
- source/source_id
- title, image, price, currency, buy URL
- tags (JSON string in DB)

### Interaction
Per feed + item preference (`like` | `pass` | `save`), upserted.

### Queue Item
Persisted per-feed queue pointing to catalog item IDs.

---

## 4) End-to-End Flow (Recommendation Loop)

This is the central loop for both CLI and API feed consumption.

1. **Select/create feed**
   - User picks a feed (or creates one with interests + budget).
   - New feed seeds initial `tag_weights` from entered interests (+1 each, raw lowercased terms).

2. **Get next item**
   - Service tries to dequeue next item from `queue_items`.
   - If queue is empty, it triggers `refillQueue(feedId)` and retries dequeue.

3. **Show product**
   - Product is returned/rendered.
   - `recordShown(catalogItemId)` increments display counters.

4. **Record interaction**
   - Client posts `like`/`pass`/`save`.
   - `recordInteraction(feedId, catalogItemId, type)` upserts interaction.
   - Feed `tag_weights` are updated using item tags:
     - like/save: +1 per tag
     - pass: -0.5 per tag

5. **Background refill trigger**
   - If queue size is at or below threshold, service refills in background.

---

## 5) Refill Logic (Most Important)

`services/refill.js` is the heart of recommendations.

### Inputs
- feed state (`interests`, `tag_weights`, budget)
- already seen items for that feed

### Search term selection
- Initial refill (queue empty): uses feed interests.
- Later refills: uses top positive weighted tags (fallback to interests if needed).

### Term processing strategy
- Always sample from **top 3 terms first**.
- Then continue remaining terms until target queue size is reached.
- Per-term provider failures are caught and logged; refill continues.

### Provider calls
- Primary: Amazon search
- Fallback: Canopy search

### Candidate filtering
- Exclude already-seen source IDs for that feed.
- Enforce budget constraints.
- If mapped tags are empty, fallback derives tags from search term.

### Persistence and ranking
- Upsert all accepted products into catalog.
- Fetch rows back, parse tags, rank deterministically via `rankItems`.
- Apply tag diversity cap.
- Append selected item IDs to `queue_items`.

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
- **Initial feed hobby weights** are currently stored as raw lowercased hobby terms.
- **Item tags** are canonicalized/tag-mapped.

This can produce mixed vocab in `tag_weights` over time; this is currently accepted behavior.

---

## 7) API Surface (Current)

From `server.js`:

- `GET /health`
- `GET /users`
- `POST /users`
- `GET /feeds?userId=...`
- `POST /feeds`
- `GET /feeds/:feedId/next`
- `POST /feeds/:feedId/interactions`
- `GET /feeds/:feedId/saved`

### Auth boundary
Feed-scoped routes require `Authorization: Bearer <jwt>` and feed ownership checks.

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
- **Queue refill policy**: `services/refill.js`
- **Score math / tag weight updates**: `services/ranking.js`
- **Amazon mapping/tag extraction**: `services/amazon-api.js`
- **Canonical taxonomy**: `data/tag-canonical.js`
- **Feed creation/search term logic**: `models/feed.js`
- **Interaction persistence**: `models/interaction.js`
- **Queue persistence/dequeue**: `models/queue.js`
- **Catalog upsert/read**: `models/catalog.js`

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

4. Create user/feed and fetch next item using README examples.

---

## 12) If You Are an Agent Making Changes

Before editing, identify which layer you are changing:

- transport (API/CLI)
- refill policy
- ranking math
- tagging taxonomy
- DB model semantics

Then verify:

- validation still matches expected payload shape
- authorization still protects feed-scoped routes
- SQL remains parameterized
- no secrets or internal stack traces leak to clients

