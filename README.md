# GiftGenius Engine

A gift recommendation engine that serves real, purchasable products in a swipe-style feed. Learns from every interaction — shopping, saving, disliking, or scrolling past — to surface better gift ideas over time. Fully deterministic, no ML, monetizable via affiliate links.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Install](#install)
  - [Start Postgres](#start-postgres)
  - [Set up API keys](#set-up-api-keys-required-for-running-the-app)
  - [Run the CLI](#run-the-cli)
  - [Run the API](#run-the-api-fastify)
  - [View the database](#view-the-database-optional)
  - [Testing](#testing)
- [Project Structure](#project-structure)
- [Core Concepts](#core-concepts)
- [Configuration & Tuning](#configuration--tuning)
- [API Endpoint Examples](#api-endpoint-examples)
- [Scripts](#scripts)

---

## Overview

GiftGenius Engine uses a **catalog + ranking** approach:

- **Catalog** = shared cache of real products (Amazon). Populated on-demand, reused across feeds.
- **Feed** = personalized context per recipient (budget, interests, relationship)
- **Queue** = per-feed batch of ~6 items, served to the client as a card stack
- **Interactions** = learning signal (shop, save, dislike, scroll-past) used to refine recommendations
- **Ranking** = deterministic scoring based on tag weights, interests, freshness, and diversity
- **Two-tier sourcing** = catalog cache first, API call only when cache is thin

The user experience: swipe through gift ideas in a feed (like Hinge/Tinder), with items loading in the background so there's no downtime.

---

## Architecture

For full vision, data flow, and file map see **[ARCHITECTURE.md](./ARCHITECTURE.md)**.  
For a deep dive into how the engine works, see **[DEEP_DIVE.md](./DEEP_DIVE.md)**.

```
┌─────────────────────────────────────────────────────────────────┐
│                       Frontend / CLI                             │
│  Receives batch of items, sends shop/save/dislike individually   │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  GET /feeds/:feedId/next?count=6                  │
│  • Auto-detects scroll-past from previous batch                  │
│  • Dequeues batch from persisted queue                           │
│  • Triggers background refill when ≤ 3 items remain              │
└─────────────────────────────┬───────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Refill        │  │   Interaction   │  │    Ranking      │
│  Tier 1: cache  │  │   (atomic       │  │  (tag weights,  │
│  Tier 2: API    │  │    shop/save/   │  │   freshness,    │
│  Upsert all     │  │    dislike +    │  │   diversity)    │
│  results        │  │    tag update)  │  │                 │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PostgreSQL (Docker)                          │
│  catalog | feeds | interactions | seen_items | queue_items       │
└─────────────────────────────────────────────────────────────────┘
```

**Data flow:**

1. User creates a **Feed** (name, budget, interests, relationship).
2. **Refill** checks catalog cache first; if thin, calls Amazon Creators API (Canopy fallback). ALL results are upserted to catalog. Ranked candidates are appended to the persisted queue.
3. Client fetches a **batch** of items (`GET /next?count=6`) and displays them as a card stack.
4. User swipes: **Shop** (opens buy link), **Save**, **Dislike**, or scrolls past. Each action (except scroll-past) fires `POST /interactions`.
5. **Scroll-past** is auto-detected on the next batch request — items the user saw but didn't act on.
6. Each interaction updates **tag weights**. Top tags drive the next refill's search terms.
7. When the queue has ≤3 items, a background refill runs; the user continues without waiting.

---

## Getting Started

### Prerequisites

- **Node.js** 18+
- **Supabase** project (free tier works) — or Docker for local Postgres

### Install

```bash
git clone <repo-url>
cd giftgenius-engine
npm install
```

### Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Go to **Settings → Database → Connection string** and copy the URI.
3. Add it to `.env.local`:

```
DATABASE_URL=postgresql://postgres.[your-ref]:[your-password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

4. Apply the schema:

```bash
npm run db:migrate
```

This runs `psql` against your `DATABASE_URL`. Run it again after any schema change.

<details>
<summary>Alternative: local Docker Postgres</summary>

```bash
docker-compose up -d
npm run db:migrate:docker
```

Set `DATABASE_URL=postgresql://giftgenius:giftgenius@localhost:5432/giftgenius` in `.env.local`.
</details>

The schema includes `catalog`, `users`, `feeds`, `interactions`, `seen_items`, and `queue_items`.

### Set up API keys (required for running the app)

The app sources products from **Amazon Creators API** (primary) or **Canopy API** (fallback). Set at least one in `.env.local`:

- **Amazon** (recommended): `AMAZON_CREDENTIAL_ID`, `AMAZON_CREDENTIAL_SECRET`, `AMAZON_PARTNER_TAG`
- **Canopy** (fallback): `CANOPY_API_KEY`

See [Environment](#environment) and `.env.example` for all options.

### Run the CLI

```bash
npm start
```

1. Choose or create a **user**, then choose or create a **feed** (recipient name, relationship, interests, budget).
2. The first run fetches products from the API using the feed's interests, fills the queue, then shows one product at a time.
3. Use arrow keys and Enter to choose **Shop**, **Save**, or **Dislike**. Each action updates tag weights.
4. Press **Ctrl+C** to exit. The queue is saved; next time you continue from where you left off.

### Run the API (Fastify)

```bash
npm run start:api
```

Default base URL: `http://127.0.0.1:3000`

Quick checks:

```bash
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/ready
```

OpenAPI docs:

```bash
# Swagger UI
open http://127.0.0.1:3000/docs

# OpenAPI JSON
curl -s http://127.0.0.1:3000/docs/json
```

### View the database (optional)

```bash
docker exec -it giftgenius-postgres psql -U giftgenius -d giftgenius
```

Useful commands:
- `\dt` — list tables
- `SELECT * FROM queue_items;` — current queue entries per feed
- `SELECT * FROM interactions;` — user actions
- `SELECT * FROM catalog LIMIT 5;` — cached products
- `\q` — quit

Or use a GUI (pgAdmin, DBeaver, TablePlus) with: host `localhost`, port `5432`, user `giftgenius`, password `giftgenius`, database `giftgenius`.

### Testing

```bash
npm test
```

To sanity-check locally: run `npm start`, create a user and feed with interests (e.g. `coffee, books`), ensure at least one API key is set, and confirm products appear and interactions are recorded.

For debug logging:

```bash
LOG_REFILL=1 npm start
```

---

## Project Structure

```
giftgenius-engine/
├── index.js              # CLI entry point
├── server.js             # API entry point (Fastify)
├── package.json
├── docker-compose.yml    # Postgres container
├── ARCHITECTURE.md       # Architecture overview
├── DEEP_DIVE.md          # Deep dive guide (how it all works)
├── SERVICE_FLOW.md       # Service flow reference
│
├── db/
│   ├── index.js          # Postgres connection pool
│   ├── schema.js         # SQLite schema (legacy reference)
│   └── schema.pg.sql     # PostgreSQL schema (source of truth)
│
├── models/
│   ├── catalog.js        # Product CRUD, cache-first query (getUnseenCandidates)
│   ├── feed.js           # Feed CRUD, tag weights, search terms, batch tracking
│   ├── interaction.js    # Record interactions, seen tracking, scroll-past detection
│   ├── queue.js          # Queue append/dequeue (single + batch)
│   └── user.js           # User CRUD
│
├── services/
│   ├── ranking.js        # Scoring, tag weight updates (shop/save/dislike/scroll_past)
│   ├── refill.js         # Two-tier refill: cache-first → API fallback
│   ├── feed-interactions.js  # Atomic interaction + tag weight update
│   ├── amazon-api.js     # Amazon Creators API wrapper
│   └── canopy-api.js     # Canopy API wrapper (fallback)
│
├── classes/
│   └── queue.js          # CLI queue loop (Shop/Save/Dislike)
│
├── data/
│   ├── tag-canonical.js  # Raw word → canonical tag mapping
│   └── gift-keywords.js  # Keywords for Canopy ingest
│
└── scripts/
    ├── ingest-catalog.js # Catalog seed scripts
    ├── list-catalog.js   # Print recent catalog items
    └── ...               # Other utility scripts
```

---

## Core Concepts

### Catalog (Shared Cache)

Global product cache. Every item ever fetched from any API call lives here. Cache-first queries check this table before calling external APIs.

Key fields: `source_id` (ASIN), `title`, `price_cents`, `buy_url`, `tags` (canonical JSON array), `last_refreshed`, `times_shown`, `times_liked`.

### Feed

Personalized context per gift recipient. Includes:

- **Constraints**: budget min/max, relationship, occasion
- **Interests**: explicit tags (e.g. `["hiking", "coffee", "books"]`)
- **Tag weights**: learned from interactions (`{ "coffee": 5.5, "outdoor": -2.0 }`)
- **last_batch_at**: when the last batch was served (for scroll-past detection)

### Interactions

Each user action is stored as:

- `feed_id` + `catalog_item_id` + `type` (`shop` | `save` | `dislike` | `scroll_past`)

Used to update tag weights and to exclude already-seen items from future recommendations.

### Ranking

Deterministic scoring per item:

```
score = Σ(tag_weights)
      + interest_bonus  (+2 per tag matching feed interests)
      + freshness_bonus  (+0.5 if refreshed in last 24h)
      - oversaturation_penalty  (-1 per tag seen in last 5 shown items)
```

Signal weights:

| Action | Delta per tag |
|--------|--------------|
| Shop | +2.0 |
| Save | +1.5 |
| Scroll-past | −0.25 |
| Dislike | −1.0 |

### Two-Tier Refill

1. **Tier 1 (cache)**: Query catalog for unseen items matching top tags + budget. If enough → fill queue, zero API calls.
2. **Tier 2 (API)**: Call Amazon (Canopy fallback) only when cache is thin. Upsert ALL results so future refills benefit.

---

## Configuration & Tuning

### Refill parameters

In `services/refill.js`:

```javascript
const REFILL_TARGET_SIZE = 6;   // Target queue size
const REFILL_THRESHOLD = 3;     // Trigger refill when ≤ 3 items remain
const API_ITEM_COUNT = 10;      // Items requested per API search
const MAX_ITEMS_PER_TAG = 2;    // Diversity cap per refill batch
```

### Ranking weights

In `services/ranking.js`:

```javascript
const WEIGHT_DELTAS = {
  shop: 2.0,
  save: 1.5,
  like: 1.0,         // legacy
  scroll_past: -0.25,
  pass: -0.5,         // legacy
  dislike: -1.0,
};
const EXPLICIT_INTEREST_BONUS = 2;
const FRESHNESS_BONUS = 0.5;
const OVERSATURATION_PENALTY = 1;
```

---

## API Endpoint Examples

Login and get token:

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"user@example.com"}' | jq -r '.accessToken')
```

Create user:

```bash
curl -s -X POST http://127.0.0.1:3000/users \
  -H "content-type: application/json" \
  -d '{"name":"Aaron","email":"user@example.com"}'
```

Create feed:

```bash
curl -s -X POST http://127.0.0.1:3000/feeds \
  -H "content-type: application/json" \
  -d '{"userId":1,"name":"Mom","relationship":"mom","interests":["gardening","cooking"],"budgetMin":20,"budgetMax":80}'
```

Get next batch (6 items):

```bash
curl -s "http://127.0.0.1:3000/feeds/1/next?count=6" \
  -H "authorization: Bearer $TOKEN"
```

Record interaction:

```bash
curl -s -X POST http://127.0.0.1:3000/feeds/1/interactions \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"catalogItemId":42,"type":"shop"}'
```

List saved items:

```bash
curl -s http://127.0.0.1:3000/feeds/1/saved \
  -H "authorization: Bearer $TOKEN"
```

Notes:
- Feed-scoped routes require `Authorization: Bearer <token>`.
- Token identity must match the owner of `:feedId`.
- If rate-limited (`429`), retry with exponential backoff.
- Error format: `{ "error": { "code": "...", "message": "..." } }`

---

## Scripts

| Command | Description |
|--------|-------------|
| `npm start` | Run the CLI (Shop/Save/Dislike loop) |
| `npm run start:api` | Run the Fastify API server |
| `npm run db:migrate` | Apply PostgreSQL schema |
| `npm test` | Run tests (placeholder) |
| `npm run ingest` | Seed catalog with sample products |
| `npm run ingest:canopy` | Ingest from Canopy API (search) |
| `npm run ingest:canopy-product` | Ingest from Canopy API (product per item) |
| `npm run ingest -- --amazon` | Ingest from Amazon Creators API |
| `npm run list-catalog [N]` | Print N most recent catalog items |
| `npm run update-affiliate-links` | Add partner tag to existing buy_urls |

### Environment

Copy `.env.example` to `.env.local` and set as needed.

| Variable | Required | Description |
|----------|----------|-------------|
| `PGHOST` / `DATABASE_URL` | Yes | Postgres connection |
| `PGUSER`, `PGPASSWORD`, `PGDATABASE` | If no DATABASE_URL | Postgres credentials |
| `JWT_SECRET` | Yes (API) | Secret for signing JWTs |
| `AMAZON_CREDENTIAL_ID` | Yes | Amazon Creators API credential |
| `AMAZON_CREDENTIAL_SECRET` | Yes | Amazon Creators API secret |
| `AMAZON_PARTNER_TAG` | Yes | Amazon Associates affiliate tag |
| `CANOPY_API_KEY` | Fallback | Canopy API key |
| `CORS_ALLOWED_ORIGINS` | Prod | Comma-separated frontend origins |
| `PORT` | No | API port (default 3000) |
| `LOG_REFILL` | No | Set to "1" for refill debug logs |
