# GiftGenius Engine — Architecture

## Problem Statement

Buying gifts is stressful and time-consuming, and generic guides don't adapt as you refine what you want, making it hard to land on the right gift without starting over.

## Solution

This app acts like a personalized gift discovery tool. Instead of searching endlessly, users swipe through gift ideas the way they'd browse a dating app. Each swipe teaches the app what is and isn't right, allowing it to narrow in on better options quickly. Users can create separate feeds for different people in their life, so gift ideas feel tailored and intentional rather than random.

## Vision

GiftGenius Engine is a **gift recommendation system** that:

- Uses **real, purchasable products** from retailer APIs (e.g. Amazon Creators API) instead of a pre-stored full catalog.
- Keeps a **short queue** of about 6 items per feed; when the queue drops to **3 items**, the system fetches more by calling the Amazon Creator API using the **top tags** associated with the current feed.
- **Learns from feedback** (like / pass / save) via tag weights and explicit interests—no ML training, fully deterministic and explainable.
- Stays **monetizable** by driving traffic to affiliate links (e.g. Amazon Associates) via `buy_url` and partner tags.
- Lets users create a **profile** and **specific feeds for each of their relationships**; almost everything else (interactions, ranking, tag weights) stays the same.
- Currently runs as a **CLI first**; in the end this will serve as the backend for a frontend that displays each item.

The goal is to give gift-givers a focused, fast way to browse and save ideas for specific people (Mom, Partner, Coworker) with a budget and interests in mind, while the system gets better at showing relevant items over time—without maintaining a large stored catalog.

---

## What We're Building (Short-Queue, On-Demand Model)

### Core stack

- **Runtime:** Node.js (ES modules).
- **Data:** PostgreSQL (Docker); schema in `db/schema.pg.sql`.
- **CLI:** `@clack/prompts` for user/feed selection and the product queue.

### Main pieces

| Layer | What it does |
|-------|----------------|
| **Users** | App users (gift-givers). One user can have many feeds. |
| **Feeds** | One feed per recipient (name, relationship, budget, interests). Each feed has its own tag weights and interaction history. **Top tags** (from tag weights + interests) drive the next API search when the queue needs refilling. |
| **Short queue** | Per-feed queue of **~6 items**, **persisted** in the DB so returning users see the same queue. User sees one item at a time. When **≤3 items** remain, a **refill** runs: call API (Amazon primary, Canopy fallback) with top tags or interests, get items, filter out already-seen ASINs, rank, upsert into catalog, append to queue. Only call the API again in the same refill if after filtering the queue would still be below 3. |
| **Catalog (cache)** | No longer a large pre-ingested inventory. Every item fetched during refill is **upserted** into the catalog so we have stable IDs for interactions and saved items. Refill does **not** read from catalog for candidates; it fetches live from the API (Amazon primary, Canopy fallback). |
| **Interactions** | Stored like/pass/save per feed and catalog item (same as today). Used to update feed tag weights and to exclude already-seen items when refilling. |
| **Refill** | **New behavior:** Call **Amazon Creator API** (fallback: **Canopy API**) with search terms from the feed’s **top tags** or **explicit interests**. Map API results to catalog shape; **filter out already-seen ASINs**; only call the API again in the same refill if after filtering the queue would still be below 3. Rank; **upsert every item into catalog**; return top N and append to **persisted** queue. |
| **Ranking** | Unchanged: deterministic score = sum of tag weights + bonus for tags matching feed interests. Like/Save +1 per tag, Pass −0.5 per tag. |

### Queue and refill parameters

- **Queue size (target):** ~6 items.
- **Refill threshold:** 3 items (trigger refill when queue has ≤3 items left).
- **Refill batch size:** Enough to bring queue back to ~6 (e.g. fetch 6 from API, filter/rank, add up to 6).

### How products get into the queue (no bulk ingest for recommendation)

- **Initial load:** The user is required to list **hobbies and interests** for the feed. The first refill calls the API (Amazon Creator primary, Canopy fallback) using the feed’s **explicit interests** as search terms. Results are filtered by budget and already-seen ASINs, **upserted into catalog**, ranked, and used to fill the persisted queue.
- **Subsequent refills:** When the queue has ≤3 items, refill calls the API with the feed’s **top tags** (from tag weights + interests). Same flow: fetch → filter already-seen ASINs → only call API again if queue would still be below 3 after filtering → rank → upsert every item into catalog → append to queue.
- **Already-seen:** Filter out ASINs we have already seen for this feed; do not call the API a second time in the same refill unless the queue would still be below 3 after filtering.
- **Catalog:** Every fetched item is **upserted into the catalog** so we have stable IDs for interactions and saved lists. Refill does not read from catalog for candidates.
- **API choice:** **Amazon Creator API** is primary for refill; **Canopy API** is the fallback when Amazon is unavailable.

### Scripts and ops (aligned with new model)

- **List catalog:** `npm run list-catalog [N]` — print recent catalog rows (cached items).
- **DB migrate:** `npm run db:migrate` — apply `db/schema.pg.sql`.
- **Optional ingest:** If we keep ingest scripts (e.g. for backfill or admin), they remain separate from the refill path; refill always uses the live API with top tags.

---

## How It Should Work

### End-to-end flow

1. **User starts the app** (`npm start`). Chooses or creates a **user**, then chooses or creates a **feed** (who the gift is for, budget, **required** hobbies/interests).
2. **Initial refill:** Refill calls the **API** (Amazon Creator primary, Canopy fallback) with the feed’s **explicit interests** as search terms. Gets items, filters by budget and already-seen ASINs, upserts every item into catalog, ranks, and enqueues up to ~6 items into the **persisted** queue.
3. **User sees one product at a time** (title, price, link). Actions: **Like**, **Pass**, or **Save**.
4. **Each action** is stored as an interaction and updates that feed’s **tag weights** (e.g. tags on a liked item get +1, on a passed item −0.5).
5. **When the queue has ≤3 items**, a background refill runs: call API with the feed’s **top tags**, get items, filter out already-seen ASINs (call API again only if queue would still be below 3 after filtering), rank, upsert into catalog, append to the persisted queue. The user keeps going without waiting.
6. **Catalog** is populated by refill (every fetched item is upserted); refill does not read from catalog to build the candidate set—it always fetches from the API.

### Data flow (simplified)

```
User/Feed selection (CLI)
        ↓
Queue ← Refill (API: Amazon / Canopy → filter already-seen → rank → upsert all to catalog → top N → persisted queue)
        ↓
User: Like / Pass / Save
        ↓
Interaction stored → tag weights updated
        ↓
Queue low (≤3)? → Refill again (API + top tags, repeat)
```

### Design choices

- **Short queue, on-demand API:** Recommendation is driven by a **persisted** queue of ~6 items. When ≤3 remain, we call the API (Amazon Creator primary, Canopy fallback) with the feed’s top tags or explicit interests. No dependency on a large pre-stored catalog for the main loop.
- **Catalog upsert:** Every item fetched from the API is **upserted into the catalog** so we have stable IDs for interactions and for displaying saved items. Refill does not pull “candidates” from the catalog.
- **Top tags drive search:** The feed’s tag weights (and explicit interests) define “top tags”; refill turns these into search terms for the API so results stay relevant to what the user has liked.
- **Feed-scoped learning:** Tag weights and seen-item exclusion are per feed, so “gift for Mom” and “gift for Dad” learn separately and each feed’s top tags drive its own API calls.
- **Affiliate links:** Every item we show has a `buy_url` with the partner tag; we set it when mapping API responses to our shape.

---

## File map (high level)

| Area | Path | Role |
|------|------|------|
| Entry | `index.js` | User/feed prompts, start queue |
| Queue UX | `classes/queue.js` | Loop: show item from persisted queue, handle Like/Pass/Save, trigger refill when ≤3 items; queue size ~6 |
| Refill | `services/refill.js` | Call API (Amazon primary, Canopy fallback) with top tags or interests; filter already-seen ASINs; only re-call if queue still &lt;3; rank; upsert all to catalog; return batch; append to persisted queue |
| Ranking | `services/ranking.js` | Score items, update tag weights (unchanged) |
| Catalog API (primary) | `services/amazon-api.js` | Amazon Creators API: search by keywords, map to catalog shape (used by refill) |
| Catalog API (fallback) | `services/canopy-api.js` | Canopy: used by refill when Amazon is unavailable |
| Data | `models/catalog.js`, `models/feed.js`, `models/interaction.js`, `models/user.js` | CRUD and queries; feed model exposes “top tags” for refill |
| Schema | `db/schema.pg.sql`, `db/index.js` | Postgres schema and pool (catalog remains for cache + interactions) |
| Ingest (optional) | `scripts/ingest-catalog.js`, `data/gift-keywords.js` | Optional seed/backfill; not used by refill loop |

This document should stay aligned with the README and `.cursorrules` so new code and docs follow the same vision and patterns.

### Decided behavior

- **Already-seen:** Filter out ASINs already seen for this feed from each API page; only call the API again in the same refill if after filtering the queue would still be below 3.
- **First load:** Use the feed’s **explicit interests** as search terms; the user is required to list hobbies and interests for the feed.
- **Queue:** **Persisted** in the DB so returning users see the same queue.
- **API:** **Amazon Creator API** is primary for refill; **Canopy API** is the fallback when Amazon is unavailable.
- **Catalog:** **Upsert every item** fetched during refill into the catalog so all interactions have a `catalog_item_id`.
