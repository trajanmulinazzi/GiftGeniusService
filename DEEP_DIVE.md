
# GiftGenius Engine — Deep Dive Guide

This guide explains exactly how every part of the engine works, end to end. Read it top to bottom and you'll understand the full system.

---

## 1. The Big Picture

GiftGenius is a recommendation engine that shows gift ideas one at a time. The user swipes through them (like a dating app for gifts), and every action teaches the engine what to show next.

There are three loops running simultaneously:

1. **The display loop** — dequeue an item, show it, wait for user action.
2. **The learning loop** — record the action, update tag weights, shift what "good" means.
3. **The refill loop** — when the queue gets low, source new items (cache first, then API).

---

## 2. Data Model

### Users and Feeds

A **user** is the person using the app (the gift-giver). A user has many **feeds** — one per person they're buying for.

```
User: "Aaron"
  ├── Feed: "Mom"     (interests: gardening, cooking | budget: $20-$80)
  ├── Feed: "Emma"    (interests: art, coffee       | budget: $15-$60)
  └── Feed: "Dad"     (interests: tools, outdoor    | budget: $30-$100)
```

Each feed stores:
- `interests` — the hobbies/likes entered when creating the feed (JSON array)
- `tag_weights` — the learned preferences (JSON object: `{ "coffee": 3.5, "art": 1.0, ... }`)
- `budget_min` / `budget_max` — price filter in dollars
- `last_batch_at` — timestamp of when the last batch was served (used for scroll-past detection)

### Catalog

A single shared table of products. Every item ever fetched from any API call lives here. It acts as a cache — the engine checks it before calling external APIs.

Key columns: `source_id` (ASIN), `source` ("amazon"), `title`, `price_cents`, `buy_url`, `tags` (JSON array of canonical tags like `["coffee","kitchen"]`), `last_refreshed`, `times_shown`, `times_liked`.

### Interactions

One row per (feed, catalog_item) pair. Records what the user did: `shop`, `save`, `dislike`, or `scroll_past`. Used for:
1. Learning (update tag weights)
2. Filtering (never show the same item twice)

### Queue

Per-feed list of catalog item IDs, ordered. The user sees item #1, then #2, etc. When ≤3 remain, the refill loop kicks in.

### Seen Items

A separate table that marks items as "shown" even before the user acts. Prevents re-serving duplicates.

---

## 3. Tag System

Tags are the core of the engine. Every product has tags, and every feed has tag weights. Tags connect items to preferences.

### How tags are assigned to products

When a product comes from the Amazon API, raw metadata (title, categories, features, brand) is extracted and run through a **canonical tag map** (`data/tag-canonical.js`). This map converts hundreds of raw words into ~40 canonical tags:

```
"espresso machine" → "coffee"
"hiking boots"     → "outdoor"
"yoga mat"         → "wellness"
"arduino kit"      → "maker"
```

Only mapped terms survive. This keeps the tag vocabulary bounded and ensures tag weights are meaningful across products.

### How tag weights work

Each feed has a `tag_weights` object:

```json
{ "coffee": 3.5, "kitchen": 1.0, "outdoor": -2.0, "art": 0.5 }
```

These start seeded from the feed's interests (each interest gets weight 1.0). Then every interaction shifts them:

| Action | Delta per tag |
|--------|--------------|
| Shop (clicked to buy) | +2.0 |
| Save | +1.5 |
| Scroll-past | −0.25 |
| Dislike | −1.0 |

Example: user shops an item tagged `["coffee", "kitchen"]`:
- `coffee` goes from 3.5 → 5.5
- `kitchen` goes from 1.0 → 3.0

Over time, tags the user likes rise to the top. Tags they dislike sink. The top tags become the search terms for the next refill.

---

## 4. Scoring and Ranking

When the engine has a pool of candidate items, it scores each one:

```
score = Σ tag_weight[tag]           // how well tags match learned preferences
      + 2 × (matching interests)    // bonus for matching explicit interests
      + 0.5 (if refreshed < 24h)    // prefer fresh inventory
      - 1 × (oversaturated tags)    // penalize tags seen in last 5 shown items
```

Example for an item tagged `["coffee", "kitchen"]` with feed weights `{ coffee: 5.5, kitchen: 3.0 }` and interest `["coffee"]`:
- Tag sum: 5.5 + 3.0 = 8.5
- Interest bonus: 2 (coffee matches)
- Score: **10.5**

Items are sorted by score descending. A **diversity cap** (max 2 items per tag per refill) prevents the queue from being all coffee mugs.

---

## 5. The Refill Loop (Two-Tier Sourcing)

This is the most important part of the engine. It answers: "where do the next items come from?"

### Step 1: Determine search terms

- **First refill** (empty queue): use the feed's `interests` directly (e.g., `["gardening", "cooking"]`).
- **Subsequent refills**: use the top 5 tags by weight from `tag_weights`.

### Step 2: Check the cache (Tier 1)

Query the catalog table:
```sql
SELECT * FROM catalog
WHERE tags match ANY of the search terms
  AND item NOT in (interactions ∪ seen_items ∪ queue_items for this feed)
  AND price within budget
```

If this returns ≥6 candidates → rank them, fill the queue. **Zero API calls.**

### Step 3: Call the API (Tier 2, only if cache is thin)

For each search term (top 3 first, then remaining):
1. Call Amazon Creators API (or Canopy as fallback) with the term + budget filters.
2. **Upsert ALL results** into the catalog — not just the ones for this feed. This is the key difference from the old architecture. 10 items come back, all 10 go into the cache.
3. Filter the results: remove already-seen, remove out-of-budget.
4. Add the eligible items to the candidate pool.

### Step 4: Rank and enqueue

Merge cached candidates + fresh API candidates. Rank them all. Apply diversity cap. Append top N to the queue.

### Why this matters

- **API calls drop dramatically** once the cache warms up. Feed A's API calls populate items that Feed B can use later.
- The cache serves as a shared inventory. You pay the API cost once per item, not once per feed.
- 8640 API calls/day × 10 items/call = potential 86,400 cached items/day.

---

## 6. Batch Serving and Scroll-Past Detection

The server uses a batch model, like Hinge or Tinder. The client fetches a page of cards, the user swipes through them locally, and interactions fire individually as they happen.

### How batches work

1. Frontend calls `GET /feeds/:feedId/next?count=6` → server returns 6 items.
2. User swipes through them. For each action (shop/save/dislike), frontend sends `POST /interactions`.
3. Items the user scrolled past without acting on — the frontend does nothing.
4. When the stack runs low, frontend calls `/next?count=6` again.

### How scroll-past is detected automatically

When the server receives a new batch request:

1. Look at `last_batch_at` on the feed (set when the previous batch was served).
2. Query: "which items were marked as seen after `last_batch_at` but have no interaction row?"
3. Those items = scroll-pasts. Record `scroll_past` interaction for each, update tag weights.
4. Serve the new batch, mark all items as seen, update `last_batch_at`.

Example:
```
Batch 1 served: [A, B, C, D, E, F]     ← last_batch_at = T1
User shops A, saves C, scrolls past B/D/E/F

Next batch request arrives:
  → Query seen_items after T1 with no interaction → [B, D, E, F]
  → Record scroll_past for B, D, E, F (tag weights shift by -0.25 each)
  → Serve batch 2: [G, H, I, J, K, L]  ← last_batch_at = T2
```

The frontend never sends scroll-past events. It's fully server-side.

---

## 7. API Endpoints

All feed-specific endpoints require JWT auth (`Authorization: Bearer <token>`).

### Auth

```
POST /auth/login
Body: { "email": "user@example.com" }
Returns: { "accessToken": "...", "user": { ... } }
```

### Users

```
GET  /users              → { users: [...] }
POST /users              → { id, name, email, createdAt }
Body: { "name": "Aaron", "email": "aaron@example.com" }
```

### Feeds

```
GET  /feeds?userId=1     → { feeds: [...] }
POST /feeds              → { id, userId, name, interests, tagWeights, ... }
Body: { "userId": 1, "name": "Mom", "relationship": "mom",
        "interests": ["gardening","cooking"], "budgetMin": 20, "budgetMax": 80 }
```

### Feed Queue — Batch (auth required)

```
GET /feeds/:feedId/next?count=6
→ {
    items: [
      { id, sourceId, source, title, imageUrl, priceCents, currency, buyUrl, tags },
      ...
    ],
    queueRemaining: 3
  }
```

This is the main endpoint. It:
- Auto-detects scroll-pasts from the previous batch
- Dequeues `count` items (default 6, max 20)
- Marks them as seen
- Triggers background refill when ≤3 items remain in the queue

### Interactions (auth required)

```
POST /feeds/:feedId/interactions
Body: { "catalogItemId": 42, "type": "shop" }
→ { ok: true }
```

Valid types: `shop`, `save`, `dislike`, `scroll_past` (plus legacy `like`, `pass`)

Send one of these for each card the user explicitly acts on. Don't send anything for scroll-past — it's automatic.

### Saved Items (auth required)

```
GET /feeds/:feedId/saved
→ { items: [{ id, sourceId, title, imageUrl, priceCents, buyUrl, tags, savedAt }] }
```

---

## 8. Hooking Up a Frontend

### Auth flow

1. Call `POST /auth/login` with the user's email.
2. Store the returned `accessToken`.
3. Send it as `Authorization: Bearer <token>` on all `/feeds/:feedId/*` requests.

### Feed creation flow

1. `POST /users` to create a user (or login to get existing).
2. `POST /feeds` with userId, name, interests, budget.
3. The first call to `/feeds/:feedId/next` triggers the initial refill (uses interests as search terms).

### Main swipe loop (batch model)

```
let cardStack = []

function fetchBatch():
  response = GET /feeds/:feedId/next?count=6
  cardStack = response.items
  // response.queueRemaining tells you how many are left server-side

loop:
  if cardStack is empty → fetchBatch()

  card = cardStack.shift()   // take from front
  Display: card.title, card.imageUrl, card.priceCents, card.buyUrl

  On user action:
    "Shop"    → open card.buyUrl in browser/webview
              → POST /interactions { catalogItemId: card.id, type: "shop" }
    "Save"    → POST /interactions { catalogItemId: card.id, type: "save" }
    "Dislike" → POST /interactions { catalogItemId: card.id, type: "dislike" }
    Scroll    → do nothing (server detects on next fetchBatch)

  if cardStack.length <= 2 → fetchBatch() in background  // prefetch

  repeat
```

### Saved items screen

```
GET /feeds/:feedId/saved → display list with buy links
```

### Key points for frontend devs

- **Batch, not per-item.** Fetch 6 items at once, swipe through locally, fetch more when running low.
- **You don't send scroll-past events.** The server detects them automatically when you fetch the next batch.
- **Interactions are fire-and-forget.** Send them as the user acts; don't wait for a response before showing the next card.
- **Prefetch at ~2 cards remaining.** Call `/next?count=6` in the background so the user never sees a loading state.
- **`queueRemaining`** tells you how many items the server has queued. If it's 0, the next `/next` call may take longer (refill in progress).
- **`buyUrl` already has the affiliate tag.** Open it directly.
- **Prices are in cents.** Display: `$${(item.priceCents / 100).toFixed(2)}`.

---

## 9. Environment Variables

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

---

## 10. Running It

```bash
# Start Postgres
docker compose up -d

# Apply schema
npm run db:migrate

# Start the API server (for frontend)
npm run start:api

# Or run the CLI (for testing)
npm start
```

API docs are at `http://localhost:3000/docs` (Swagger UI).
