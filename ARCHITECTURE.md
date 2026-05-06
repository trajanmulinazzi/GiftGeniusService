# GiftGenius Engine — Architecture

## Problem Statement

Buying gifts is stressful and time-consuming, and generic guides don't adapt as you refine what you want, making it hard to land on the right gift without starting over.

## Solution

This app acts like a personalized gift discovery tool. Users scroll through gift ideas in a feed-style format. Each action — shopping, saving, disliking, or simply scrolling past — teaches the engine what is and isn't right, allowing it to narrow in on better options quickly. Users can create separate profiles for different people in their life, so gift ideas feel tailored and intentional.

## Vision

GiftGenius Engine is a **gift recommendation system** that:

- Uses **real, purchasable products** from retailer APIs (Amazon Creators API primary, Canopy API fallback).
- Employs a **two-tier data sourcing model**: a catalog cache (Postgres) is queried first; the API is only called when the cache can't fill the queue. Every API response is fully upserted to the cache so future refills across all feeds benefit.
- Keeps a **short queue** of ~6 items per feed; when the queue drops to **≤3 items**, the system refills from cache first, then API if needed.
- **Learns from feedback** (shop / save / dislike / scroll-past) via tag weights — fully deterministic and explainable, no ML.
- Stays **monetizable** via affiliate links (Amazon Associates) on every `buy_url`.
- Lets users create a **profile** and **specific feeds for each relationship**; tag weights and interactions are feed-scoped.
- Runs as both a **CLI** and a **Fastify REST API** for frontend clients.

---

## Core Stack

- **Runtime:** Node.js (ES modules)
- **Data:** PostgreSQL (Docker); schema in `db/schema.pg.sql`
- **API:** Fastify with JWT auth, CORS, rate limiting, Swagger docs
- **CLI:** `@clack/prompts` for interactive use

---

## Two-Tier Data Sourcing

This is the key architectural decision. Product data flows through two tiers:

```
┌──────────────────────────────────────────────────────┐
│  Tier 1: Catalog Cache (Postgres)                    │
│  All items ever fetched, with last_refreshed         │
│  Query: unseen items matching top tags + budget      │
│  → If enough candidates exist, zero API calls        │
└──────────────────────┬───────────────────────────────┘
                       │ cache miss (< 6 candidates)
                       ▼
┌──────────────────────────────────────────────────────┐
│  Tier 2: Amazon Creator API (8640 req/day)           │
│  Called only when cache can't fill the queue          │
│  ALL results upserted to cache (not just picks)      │
│  Canopy API is the fallback when Amazon unavailable  │
└──────────────────────────────────────────────────────┘
```

### Cross-feed cache sharing

Items fetched for "Mom who likes hiking" also serve "Dad who likes hiking." The catalog is shared; only seen-item tracking and tag weights are per-feed. Every API call multiplies in value.

### Cache freshness

- Items with `last_refreshed` in the last 24h get a freshness bonus in ranking.
- Items are re-upserted (price/availability updated) whenever the API returns them again during a refill.

---

## Recommendation Engine

### Interaction signals

Users have four actions, each with a different learning weight per tag on the item:

| Action | Tag Weight Delta | Description |
|--------|-----------------|-------------|
| **Shop** | +2.0 | User clicked to buy — strongest positive signal |
| **Save** | +1.5 | User bookmarked for later |
| **Scroll-past** | −0.25 | Implicit — user scrolled without acting (auto-detected) |
| **Dislike** | −1.0 | Active rejection |

Legacy types `like` (+1.0) and `pass` (−0.5) remain for backward compatibility.

### Batch serving and scroll-past detection

`GET /feeds/:feedId/next?count=6` returns a batch of items. The client displays them as a card stack or feed, and sends interactions individually as the user acts.

When the next batch is requested:
1. Server queries `seen_items LEFT JOIN interactions` for items seen after `last_batch_at` with no explicit interaction.
2. Those items are recorded as `scroll_past` (with tag weight updates).
3. A new batch is dequeued, all items are marked as seen, and `last_batch_at` is updated.

The frontend never needs to send scroll-past events — it's fully automatic.

### Scoring formula

```
score = Σ(tag_weight[tag])
      + explicit_interest_bonus  (+2 per tag matching feed interests)
      + freshness_bonus          (+0.5 if item refreshed in last 24h)
      - oversaturation_penalty   (-1 per tag seen in last 5 shown items)
```

### How learning flows

```
User scrolls/acts on item
        ↓
Record interaction (shop/save/dislike/scroll_past)
        ↓
Update feed tag_weights with deltas above
        ↓
Tag weights shift → top tags change → next refill uses new search terms
        ↓
Better items appear in queue
```

---

## Refill Logic

```
refill(feedId):
  1. Get feed's top tags (from tag_weights) + budget
  2. Tier 1: Query catalog for unseen items matching those tags within budget
  3. If cache has enough candidates (≥ slots needed):
       → Rank, apply diversity cap, fill queue. Zero API calls.
  4. If cache is thin:
       → Call Amazon API (Canopy fallback) with top tags
       → Upsert ALL results into catalog
       → Merge cached + fresh candidates
       → Rank combined pool, diversity cap, fill queue
  5. If still short → relationship fallback term ("gifts for mom")
```

### Queue parameters

- **Queue size (target):** ~6 items
- **Refill threshold:** ≤3 items triggers refill
- **Diversity cap:** max 2 items per tag in a single refill batch

---

## Main Pieces

| Layer | What it does |
|-------|-------------|
| **Users** | App users (gift-givers). One user can have many feeds. |
| **Feeds** | One feed per recipient (name, relationship, budget, interests). Each feed has its own tag weights, interaction history, and `last_batch_at` for scroll-past tracking. Top tags drive the next refill search. |
| **Short queue** | Per-feed queue of ~6 items, persisted in `queue_items` table. User sees one item at a time. Refill triggers at ≤3 remaining. |
| **Catalog (cache)** | Every item fetched during any refill is upserted here. Cache-first queries check this table before calling the API. Items have `last_refreshed` for freshness tracking. |
| **Interactions** | Stored shop/save/dislike/scroll_past per feed and catalog item. Used to update feed tag weights and to exclude already-seen items. |
| **Refill** | Two-tier: cache first, then API. Upserts ALL API results. Ranks combined pool with diversity cap. |
| **Ranking** | Deterministic score = tag weights + interest bonus + freshness − oversaturation. |

---

## File Map

| Area | Path | Role |
|------|------|------|
| Entry (CLI) | `index.js` | User/feed prompts, start queue |
| Entry (API) | `server.js` | Fastify server, all REST routes, JWT auth, scroll-past detection |
| Queue UX | `classes/queue.js` | CLI loop: show item, handle Shop/Save/Dislike, trigger refill |
| Refill | `services/refill.js` | Two-tier sourcing: cache-first → API fallback → rank → enqueue |
| Ranking | `services/ranking.js` | Score items, update tag weights (shop/save/dislike/scroll_past) |
| Interactions | `services/feed-interactions.js` | Atomic interaction recording + tag weight update in one transaction |
| Amazon API | `services/amazon-api.js` | Amazon Creators API: search by keywords, map to catalog shape |
| Canopy API | `services/canopy-api.js` | Canopy: fallback when Amazon unavailable |
| Catalog model | `models/catalog.js` | CRUD, upsert, `getUnseenCandidates()` for cache-first queries |
| Feed model | `models/feed.js` | CRUD, tag weights, search terms for refill, `last_batch_at` |
| Interaction model | `models/interaction.js` | Record interactions, get seen source IDs |
| Queue model | `models/queue.js` | Append/dequeue from persisted queue |
| User model | `models/user.js` | User CRUD |
| Tag taxonomy | `data/tag-canonical.js` | Raw word → canonical tag mapping |
| Schema | `db/schema.pg.sql` | Postgres DDL + migrations |
| DB pool | `db/index.js` | Postgres connection pool |

---

## Decided Behavior

- **Scroll-past:** Auto-detected via `last_batch_at` on `/next` calls. No client action needed.
- **First load:** Uses the feed's explicit interests as search terms.
- **Subsequent refills:** Uses top tag weights (learned from interactions).
- **Cache-first:** Catalog is queried before any API call. API results are fully upserted so all feeds benefit.
- **API:** Amazon Creator API primary; Canopy API fallback.
- **Diversity:** Max 2 items per tag per refill batch, with backfill from ranked leftovers.
- **Queue:** Persisted in DB so returning users see the same queue.
