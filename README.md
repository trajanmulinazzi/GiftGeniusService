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
    - [Seed the catalog](#seed-the-catalog)
    - [Run the app](#run-the-app)
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

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI / Frontend                           │
│  (displays products, captures Like / Pass / Save)                │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                            Queue                                 │
│  • Shows items one at a time                                     │
│  • Triggers background refill when ≤ 5 items remain              │
│  • Records interactions and updates tag weights                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│     Refill      │  │   Interaction   │  │    Ranking      │
│  (fetch, rank,  │  │   (persist      │  │  (tag weights,  │
│   enqueue)      │  │    like/pass/   │  │   scoring)      │
│                 │  │    save)        │  │                 │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     PostgreSQL (Docker)                          │
│  catalog | feeds | interactions                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Data flow:**

1. User creates a **Feed** (name, budget, interests, relationship).
2. **Refill** pulls candidates from the catalog, filters by budget and unseen items, ranks them, and enqueues the top N.
3. User sees products in the **Queue** and responds with Like, Pass, or Save.
4. Each response is stored as an **Interaction** and used to update **tag weights**.
5. When the queue drops to ≤ 5 items, a new refill runs in the background; the user continues without waiting.

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

### View the database (optional)

Connect to Postgres via psql:

```bash
docker exec -it giftgenius-postgres psql -U giftgenius -d giftgenius
```

Useful commands inside psql:
- `\dt` — list tables
- `SELECT * FROM interactions;` — view liked/passed/saved items
- `SELECT * FROM catalog LIMIT 5;` — sample products
- `\q` — quit

Or use a GUI (pgAdmin, DBeaver, TablePlus) with: host `localhost`, port `5432`, user `giftgenius`, password `giftgenius`, database `giftgenius`.

### Seed the catalog

Run once (or whenever you add new products):

```bash
npm run ingest
```

This adds 10 sample products to the database.

### Run the app

```bash
npm start
```

You’ll be prompted with products one at a time. Use the arrow keys and Enter to choose **Like**, **Pass**, or **Save**. Press Ctrl+C to exit.

---

## Project Structure

```
giftgenius-engine/
├── index.js              # Entry point: creates feed, runs queue
├── package.json
├── docker-compose.yml    # Postgres container
├── queue.log             # Runtime log (created on first run)
│
├── db/
│   ├── index.js          # Database init, persistence
│   └── schema.js         # Table definitions
│
├── models/
│   ├── catalog.js        # Product CRUD, getActiveProducts
│   ├── feed.js           # Feed CRUD, tag weights
│   └── interaction.js    # Record & query interactions
│
├── services/
│   ├── ranking.js        # Tag weights, scoring
│   └── refill.js         # Candidate fetch, rank, enqueue
│
├── classes/
│   ├── queue.js          # Queue loop, UI prompts
│   └── user.js           # (Legacy, unused)
│
└── scripts/
    └── ingest-catalog.js # Catalog seed / refresh
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

### Refill threshold

In `classes/queue.js`:

```javascript
const REFILL_THRESHOLD = 5;  // Start refill when ≤ 5 items left
```

### Batch size

In `services/refill.js`:

```javascript
const REFILL_BATCH_SIZE = 5;    // Items per refill
const CANDIDATE_POOL_SIZE = 200; // Max candidates to rank
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

Implement a separate ingestion script that:

1. Fetches products from Amazon Product Advertising API, Etsy API, etc.
2. Maps responses to the catalog schema
3. Calls `upsertProduct()` from `models/catalog.js`
4. Runs on a schedule (cron, worker) to keep prices and availability fresh

The recommendation engine always reads from the local catalog; it never calls retailer APIs during the swipe loop.

---

## Future Work

- [ ] **User model**: Link multiple feeds to a user account
- [ ] **Web API**: Express/Fastify layer for web/mobile clients
- [ ] **Duplicate detection**: Penalize near-duplicates and overused tags
- [ ] **Catalog refresh job**: Update prices, availability, images on a schedule
- [ ] **Export saved items**: List of saved products per feed

---

## Scripts

| Command           | Description                          |
|-------------------|--------------------------------------|
| `npm start`       | Run the GiftGenius CLI               |
| `npm run ingest`  | Seed or refresh the product catalog  |
| `npm run db:migrate` | Apply schema to Postgres (run once) |
| `npm test`        | *(placeholder)*                      |

### Database connection

Copy `.env.example` to `.env.local` and adjust if needed. Defaults match docker-compose:

- Host: localhost, Port: 5432, User: giftgenius, Password: giftgenius, DB: giftgenius

---


