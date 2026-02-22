# GiftGenius Engine — Architecture
## Problem Statement: 
Buying gifts is stressful and time-consuming, and generic guides don’t adapt as you refine what you want, making it hard to land on the right gift without starting over.

## Solution
This app acts like a personalized gift discovery tool. Instead of searching endlessly, users swipe through gift ideas the way they’d browse a dating app. Each swipe teaches the app what is and isn’t right, allowing it to narrow in on better options quickly. Users can create separate feeds for different people in their life, so gift ideas feel tailored and intentional rather than random.

## Vision

GiftGenius Engine is a **gift recommendation system** that:

- Uses **real, purchasable products** from a shared inventory instead of LLM-generated ideas.
- **Learns from feedback** (like / pass / save) via tag weights and explicit interests—no ML training, fully deterministic and explainable.
- Stays **monetizable** by driving traffic to affiliate links (e.g. Amazon Associates) via `buy_url` and partner tags.
- Currently runs as a **CLI first**, in the end this will serve as the backend for a frontend that displays each item.

The goal is to give gift-givers a focused, fast way to browse and save ideas for specific people (Mom, Partner, Coworker) with a budget and interests in mind, while the system gets better at showing relevant items over time.

---

## What We’ve Built

### Core stack

- **Runtime:** Node.js (ES modules).
- **Data:** PostgreSQL (Docker); schema in `db/schema.pg.sql`.
- **CLI:** `@clack/prompts` for user/feed selection and the product queue.

### Main pieces

| Layer | What it does |
|-------|----------------|
| **Users** | App users (gift-givers). One user can have many feeds. |
| **Feeds** | One feed per recipient (name, relationship, budget, interests). Each feed has its own tag weights and interaction history. |
| **Catalog** | Shared product table. Items have `source` + `source_id` (e.g. Amazon ASIN), title, price, image, `buy_url`, and a **tags** JSON array used for ranking. |
| **Interactions** | Stored like/pass/save per feed and catalog item. Used to update feed tag weights and to exclude already-seen items. |
| **Queue** | Displays one item at a time; triggers refill when queue size ≤ 5; records interactions and updates tag weights. |
| **Refill** | Fetches candidates from the catalog (budget filter, unseen only), ranks them by tag weights + interests, returns top N for the queue. |
| **Ranking** | Deterministic score = sum of tag weights + bonus for tags matching feed interests. Like/Save +1 per tag, Pass −0.5 per tag. |

### Catalog ingestion (how products get in)

- **Sample data:** `npm run ingest` — seeds the catalog with built-in sample products.
- **Canopy API (search):** `npm run ingest:canopy` — many searches (e.g. 100 keywords), ~40 products per search. Tags are **derived** from search term + title + prime/rating. Uses `CANOPY_API_KEY`; 100 free calls/month.
- **Canopy API (product):** `npm run ingest:canopy-product` — one search + one product API call per ASIN. Tags come from **API categories**, feature bullets, and brand. Fewer items (1 call per item) but better tags. Saves each item as it’s fetched so partial runs persist.
- **Amazon Creators API:** `npm run ingest:amazon` — uses Amazon’s SearchItems for live data. Requires Associates eligibility (e.g. 10 qualifying sales in 30 days). Uses `AMAZON_CREDENTIAL_*` and `AMAZON_PARTNER_TAG`. Kept for when the account qualifies.
- **Affiliate links:** `buy_url` is set with the partner tag (Canopy/Amazon). Existing rows can be updated with `npm run update-affiliate-links` using `AMAZON_PARTNER_TAG`.

### Scripts and ops

- **List catalog:** `npm run list-catalog [N]` — print recent catalog rows with title and tags.
- **DB migrate:** `npm run db:migrate` — apply `db/schema.pg.sql` to Postgres.

---

## How It Should Work

### End-to-end flow

1. **User starts the app** (`npm start`). Chooses or creates a **user**, then chooses or creates a **feed** (who the gift is for, budget, interests).
2. **Queue starts** with an initial refill: refill service loads candidates from the catalog (within budget, not yet seen for this feed), ranks them, and enqueues the top batch.
3. **User sees one product at a time** (title, price, link). Actions: **Like**, **Pass**, or **Save**.
4. **Each action** is stored as an interaction and updates that feed’s **tag weights** (e.g. tags on a liked item get +1, on a passed item −0.5).
5. **When the queue has ≤ 5 items**, a background refill runs: new candidates are fetched, ranked (using updated tag weights and interests), and appended. The user keeps going without waiting.
6. **Catalog is populated separately** via ingest scripts (Canopy now; Amazon when eligible). Refill only reads from the catalog; it does not call external APIs.

### Data flow (simplified)

```
User/Feed selection (CLI)
        ↓
Queue ← Refill (catalog → filter → rank → top N)
        ↓
User: Like / Pass / Save
        ↓
Interaction stored → tag weights updated
        ↓
Queue low? → Refill again (repeat)
```

### Design choices

- **Catalog as single source of truth:** All recommendation logic reads from the `catalog` table. Ingest jobs (Canopy, Amazon) write/upsert; the queue never calls retailers directly.
- **Tags drive ranking:** Tags come from the ingest path (search-term + title for Canopy search; API categories for Canopy product; features for Amazon). Ranking uses these tags plus per-feed tag weights and explicit interests.
- **Feed-scoped learning:** Tag weights and seen-item exclusion are per feed, so “gift for Mom” and “gift for Dad” learn separately.
- **Affiliate links everywhere:** Every catalog item has a `buy_url`; we append the partner tag so traffic is attributable.

---

## File map (high level)

| Area | Path | Role |
|------|------|------|
| Entry | `index.js` | User/feed prompts, start queue |
| Queue UX | `classes/queue.js` | Loop: show item, handle Like/Pass/Save, trigger refill |
| Refill | `services/refill.js` | Get candidates, rank, return batch |
| Ranking | `services/ranking.js` | Score items, update tag weights |
| Catalog API | `services/canopy-api.js`, `services/amazon-api.js` | Canopy search/product, Amazon Creators (for ingest) |
| Data | `models/catalog.js`, `models/feed.js`, `models/interaction.js`, `models/user.js` | CRUD and queries |
| Schema | `db/schema.pg.sql`, `db/index.js` | Postgres schema and pool |
| Ingest | `scripts/ingest-catalog.js`, `data/gift-keywords.js` | Seed/sample, Canopy, Amazon; keyword list |

This document should stay aligned with the README and `.cursorrules` so new code and docs follow the same vision and patterns.
