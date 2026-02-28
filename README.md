# GiftGenius Engine

A catalog-driven gift recommendation engine that selects real, purchasable products from a shared inventory and learns from your feedback. Built as a CLI with an iterative like/pass/save loop—no LLM required, fully deterministic, and monetizable via affiliate links.

---

## Table of Contents

- [GiftGenius Engine](#giftgenius-engine)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Architecture](#architecture)
  - [Getting Started](#getting-started)
    - [Prerequisites](#prerequisites)
    - [Install](#install)
    - [Start Postgres](#start-postgres)
    - [Set up API keys](#set-up-api-keys-required-for-running-the-app)
    - [Run the app](#run-the-app)
    - [View the database](#view-the-database-optional)
    - [Optional: seed or backfill](#optional-seed-or-backfill-the-catalog)
    - [Testing](#testing)
  - [Project Structure](#project-structure)
  - [Core Concepts](#core-concepts)
    - [Catalog](#catalog)
    - [Feed](#feed)
    - [Interactions](#interactions)
    - [Ranking](#ranking)
  - [Configuration \& Tuning](#configuration--tuning)
    - [Refill threshold](#refill-threshold)
    - [Batch size](#batch-size)
    - [Ranking weights](#ranking-weights)
  - [Extending the Catalog](#extending-the-catalog)
    - [Add products via ingest script](#add-products-via-ingest-script)
    - [Connect real retailer APIs](#connect-real-retailer-apis)
  - [Future Work](#future-work)
  - [Scripts](#scripts)

---

## Overview

GiftGenius Engine replaces LLM-based idea generation with a **catalog + ranking** approach:

- **Catalog** = shared inventory of real products (Amazon, Etsy, etc.)
- **Feed** = personalized context per recipient (budget, interests, relationship)
- **Queue** = smooth UX layer that keeps items flowing without waiting
- **Interactions** = learning signal (like, pass, save) used to refine recommendations
- **Ranking** = deterministic scoring based on tag weights and explicit interests

The user experience stays the same: swipe-style feedback on product suggestions, with new items loading in the background so there’s no downtime.

---

## Architecture

For full vision, data flow, and file map see **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI / Frontend                           │
│  (displays products, captures Like / Pass / Save)                │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Queue (persisted, ~6 items)                   │
│  • Shows items one at a time                                     │
│  • Triggers background refill when ≤ 3 items remain              │
│  • Refill calls Amazon (or Canopy) API with top tags/interests   │
│  • Records interactions and updates tag weights                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│     Refill      │  │   Interaction   │  │    Ranking      │
│  (API fetch,    │  │   (persist      │  │  (tag weights,  │
│   filter, rank, │  │    like/pass/   │  │   scoring)      │
│   upsert, queue)│  │    save)        │  │                 │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PostgreSQL (Docker)                          │
│  catalog (cache) | feeds | interactions | queue_items            │
└─────────────────────────────────────────────────────────────────┘
```

**Data flow:**

1. User creates a **Feed** (name, budget, **interests**, relationship).
2. **Refill** calls Amazon Creators API (or Canopy) with the feed’s interests or top tags, filters already-seen and budget, upserts to catalog, ranks, and appends to the **persisted queue**.
3. User sees products one at a time from the queue and responds with Like, Pass, or Save.
4. Each response is stored as an **Interaction** and used to update **tag weights**.
5. When the queue has ≤ 3 items, a background refill runs (API + top tags); the user continues without waiting.

---

## Getting Started

### Prerequisites

- **Node.js** 18+
- **Docker** (for Postgres)

### Install

```bash
git clone <repo-url>
cd giftgenius-engine
npm install
```

### Start Postgres

```bash
docker-compose up -d
npm run db:migrate
```

The schema includes `catalog`, `users`, `feeds`, `interactions`, and `queue_items` (persisted per-feed queue). Run `db:migrate` after any schema change.

### Set up API keys (required for running the app)

The app fills the queue by calling **Amazon Creators API** (primary) or **Canopy API** (fallback). Set at least one in `.env.local`:

- **Amazon** (recommended): `AMAZON_CREDENTIAL_ID`, `AMAZON_CREDENTIAL_SECRET`, `AMAZON_PARTNER_TAG`
- **Canopy** (fallback): `CANOPY_API_KEY` (e.g. if Amazon isn’t configured or fails)

See [Environment](#environment) and `.env.example` for all options.

### Run the app

```bash
npm start
```

1. Choose or create a **user**, then choose or create a **feed** (recipient name, relationship, **interests** — comma-separated hobbies/interests — and budget).
2. The first run fetches products from the API using the feed’s **interests**, fills a persisted queue (~6 items), then shows one product at a time.
3. Use the arrow keys and Enter to choose **Like**, **Pass**, or **Save**. Each action updates the feed’s tag weights. When the queue has ≤3 items, more are fetched in the background using the feed’s **top tags**.
4. Press **Ctrl+C** to exit. The queue is saved; next time you open the same feed, you continue from the same queue.

You do **not** need to seed the catalog before running; refill fetches from the API when the queue is empty or low.

### View the database (optional)

Connect to Postgres via psql:

```bash
docker exec -it giftgenius-postgres psql -U giftgenius -d giftgenius
```

Useful commands inside psql:
- `\dt` — list tables
- `SELECT * FROM queue_items;` — current queue entries per feed
- `SELECT * FROM interactions;` — liked/passed/saved items
- `SELECT * FROM catalog LIMIT 5;` — cached products (from refill)
- `\q` — quit

Or use a GUI (pgAdmin, DBeaver, TablePlus) with: host `localhost`, port `5432`, user `giftgenius`, password `giftgenius`, database `giftgenius`.

### Optional: seed or backfill the catalog

Refill fetches live from the API during normal use. To pre-populate the catalog (e.g. for ingest scripts or testing), use:

| Command | What it does |
|--------|----------------|
| `npm run ingest` | 10 sample products (no API keys) |
| `npm run ingest:canopy` | Canopy API: many searches (needs `CANOPY_API_KEY`) |
| `npm run ingest:canopy-product` | Canopy API: 1 search + 1 call per item, better tags |
| `npm run ingest -- --amazon` | Amazon Creators API (needs `AMAZON_*` env) |

Example with limits: `npm run ingest -- --canopy --max-calls 10`.

### Testing

```bash
npm test
```

*(Test suite is placeholder; add unit tests for ranking and refill, and integration tests for feed creation, interactions, and queue refill.)*

To sanity-check locally: run `npm start`, create a user and feed with interests (e.g. `coffee, books`), ensure at least one API key is set, and confirm products appear and Like/Pass/Save are recorded. Check `queue_items` and `interactions` in the DB after a short run.

To see what items the app fetches and shows while testing, set `LOG_REFILL=1` (or `DEBUG=refill`) so refill and queue log to the console as well as to `queue.log`:

```bash
LOG_REFILL=1 npm start
```

You’ll see: search terms used, raw API results per term (source_id, title snippet, price_cents), which items were added to the queue, and each item as it’s shown. Without the env var, the same details are still written to `queue.log` only.

---

## Project Structure

```
giftgenius-engine/
├── index.js              # Entry point: user/feed prompts, runs queue
├── package.json
├── docker-compose.yml    # Postgres container
├── queue.log             # Runtime log (created on first run)
├── ARCHITECTURE.md       # Vision, what's built, how it works
├── .cursorrules          # Project rules for AI-assisted editing
│
├── db/
│   ├── index.js          # Database pool, init
│   ├── schema.js         # Table definitions (legacy)
│   └── schema.pg.sql     # PostgreSQL schema (source of truth)
│
├── models/
│   ├── catalog.js        # Product CRUD, getActiveProducts
│   ├── feed.js           # Feed CRUD, tag weights
│   ├── interaction.js   # Record & query interactions
│   └── user.js           # User CRUD
│
├── services/
│   ├── ranking.js        # Tag weights, scoring
│   ├── refill.js         # Candidate fetch, rank, enqueue
│   ├── canopy-api.js     # Canopy API (search + product by ASIN)
│   └── amazon-api.js     # Amazon Creators API (search/get items)
│
├── classes/
│   ├── queue.js          # Queue loop, UI prompts
│   └── user.js           # (Legacy, unused)
│
├── data/
│   └── gift-keywords.js  # Curated keywords for Canopy ingest
│
└── scripts/
    ├── ingest-catalog.js # Catalog seed: sample, Canopy, Amazon
    ├── list-catalog.js   # Print recent catalog items and tags
    └── update-affiliate-links.js # Add partner tag to existing buy_urls
```

---

## Core Concepts

### Catalog

Global product inventory. Each item has:

| Field        | Description                          |
|-------------|--------------------------------------|
| `source_id` | Stable ID (e.g., ASIN for Amazon)   |
| `source`    | `amazon`, `etsy`, etc.              |
| `title`     | Product name                        |
| `image_url` | Thumbnail URL                       |
| `price_cents` | Cached price in integer cents      |
| `currency`   | ISO code (default `USD`)            |
| `buy_url`   | Affiliate / purchase link           |
| `tags`      | JSON array of categories (e.g. `["coffee", "gift"]`) |
| `active`    | 1 = available, 0 = hidden           |
| `times_shown` | Count of times product has been shown              |
| `times_liked` | Count of times product was liked                   |
| `last_shown_at` | When product was last shown (timestamp)          |

Catalog updates are decoupled from the recommendation loop—run ingestion jobs on a schedule.

### Feed

A personalized recommendation context (e.g., one per gift recipient). Includes:

- **Constraints**: budget min/max, age range, relationship, occasion
- **Interests**: explicit tags (e.g. `["rock-climbing", "coffee", "fantasy books"]`)
- **Tag weights**: learned from interactions (`{ "coffee": 1.5, "gadgets": -0.5 }`)

### Interactions

Each Like / Pass / Save is stored as:

- `feed_id`
- `catalog_item_id`
- `type`: `like` | `pass` | `save`

Used to update tag weights and to exclude items the user has already seen.

### Ranking

Deterministic scoring per item:

- **Tag weights**: Like/Save adds +1, Pass adds -0.5 per tag
- **Explicit interest bonus**: +2 for tags matching feed interests
- **Formula**: `score = sum(tag_weights) + interest_bonuses`

No ML; fully explainable and testable.

---

## Configuration & Tuning

### Refill threshold and queue size

In `classes/queue.js`:

```javascript
const REFILL_THRESHOLD = 3;  // Start background refill when ≤ 3 items left
```

In `services/refill.js`:

```javascript
const REFILL_TARGET_SIZE = 6;   // Target queue size; refill adds up to this many
const API_ITEM_COUNT = 10;      // Items requested per API search
```

### Ranking weights

In `services/ranking.js`:

```javascript
const LIKE_WEIGHT_DELTA = 1;      // Per-tag boost for like/save
const PASS_WEIGHT_DELTA = -0.5;   // Per-tag penalty for pass
const EXPLICIT_INTEREST_BONUS = 2; // Bonus for matching feed interests
```

---

## Extending the Catalog

### Add products via ingest script

Edit `scripts/ingest-catalog.js` and add to `SAMPLE_PRODUCTS`:

```javascript
{
  source_id: "B011-YOUR-ID",
  source: "amazon",
  title: "Product Name",
  image_url: "https://...",
  price: 39.99,
  buy_url: "https://amazon.com/dp/B011-YOUR-ID",
  tags: ["category1", "category2"],
  active: true,
}
```

Then run `npm run ingest`.

### Connect real retailer APIs

**Canopy API** (implemented): Set `CANOPY_API_KEY` in `.env.local`. Use `npm run ingest:canopy` (many items, derived tags) or `npm run ingest:canopy-product` (fewer items, tags from API categories). Free tier: 100 requests/month.

**Amazon Creators API** (implemented): Set `AMAZON_CREDENTIAL_ID`, `AMAZON_CREDENTIAL_SECRET`, `AMAZON_PARTNER_TAG` in `.env.local`. Use `npm run ingest -- --amazon` when your Associates account meets eligibility (e.g. 10 qualifying sales in 30 days). Requires the `@amzn/creatorsapi-nodejs-sdk` (see repo or local path in package.json).

#### Amazon API: what we request and what we use

We call **SearchItems** (and optionally **GetItems**) and request these resources:

| Resource | What the API returns | What we use |
|----------|---------------------|-------------|
| `images.primary.medium` | Primary product image URL | `image_url` |
| `itemInfo.title` | Product title (displayValue / label) | `title` |
| `itemInfo.features` | List of feature strings (displayValues) | **Tags**: one keyword (≥4 chars) per feature, up to 5 |
| `itemInfo.classifications` | ProductGroup, Binding (category names) | **Tags**: slugified ProductGroup and Binding |
| `itemInfo.byLineInfo` | Brand, Manufacturer | **Tags**: slugified Brand |
| `itemInfo.productInfo` | Color, Size, etc. | **Tags**: slugified Color and Size |
| `offersV2.listings.price` | Price (amount, currency) | `price_cents`, `currency` |
| `offersV2.listings.availability` | Availability (search only) | Not stored |

**Catalog fields we fill:** `source_id` (ASIN), `source` (`"amazon"`), `title`, `image_url`, `price_cents`, `currency`, `buy_url` (detail page + partner tag), `tags` (all of the above tag sources combined, normalized to lowercase hyphenated slugs), `active`.

Both paths map API responses to the catalog schema and call `upsertProduct()` from `models/catalog.js`. The recommendation engine always reads from the local catalog; it never calls retailer APIs during the swipe loop.

---

## Future Work

- [x] **User model**: Link multiple feeds to a user account *(done)*
- [ ] **Web API**: Express/Fastify layer for web/mobile clients
- [ ] **Duplicate detection**: Penalize near-duplicates and overused tags
- [ ] **Catalog refresh job**: Update prices, availability, images on a schedule
- [ ] **Export saved items**: List of saved products per feed

---

## Scripts

| Command | Description |
|--------|-------------|
| `npm start` | Run the GiftGenius CLI (user/feed selection, then queue; needs Amazon or Canopy env) |
| `npm run db:migrate` | Apply PostgreSQL schema (run once after clone; run again after schema changes) |
| `npm test` | Run tests *(placeholder — add tests for ranking, refill, queue)* |
| `npm run ingest` | Optional: seed catalog with sample products |
| `npm run ingest:canopy` | Optional: ingest from Canopy API (search) |
| `npm run ingest:canopy-product` | Optional: ingest from Canopy API (product per item; better tags) |
| `npm run ingest -- --amazon` | Optional: ingest from Amazon Creators API |
| `npm run list-catalog [N]` | Print N most recent catalog items and their tags |
| `npm run amazon:response [keywords]` | Call Amazon SearchItems once and print raw API response (default keyword: `hiking`) |
| `npm run canopy:response [ASIN]` | Call Canopy product API once for one item; print full raw response (tags: categories, featureBullets, brand). Default ASIN: `B09TR9LPKN` |
| `npm run update-affiliate-links` | Add `AMAZON_PARTNER_TAG` to existing catalog `buy_url`s |

### Environment

Copy `.env.example` to `.env.local` and set as needed.

- **Database**: Defaults match docker-compose (localhost:5432, user `giftgenius`, database `giftgenius`). Use `DATABASE_URL` or `PGHOST`/`PGUSER`/etc.
- **Canopy API**: `CANOPY_API_KEY` (for ingest:canopy and ingest:canopy-product).
- **Amazon**: `AMAZON_CREDENTIAL_ID`, `AMAZON_CREDENTIAL_SECRET`, `AMAZON_PARTNER_TAG` (and optional `AMAZON_CREDENTIAL_VERSION`, `AMAZON_MARKETPLACE`). Partner tag is also used for affiliate links on Canopy-ingested items.

---


