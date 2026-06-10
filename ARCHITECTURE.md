# GiftGenius Engine — Architecture

This document describes the current backend architecture, code layout, and runtime behavior. For the full product-level HLA (domain rules, scoring math, guardrails), see [`gift-app-hla.md`](./gift-app-hla.md).

---

## 1. Overview

GiftGenius Engine is a Node.js (ESM) + Fastify API that powers a swipe-based gift discovery experience. The backend:

- Stores recipient **profiles** with hobbies and budget
- Runs **sessions** scoped to an occasion (birthday, Christmas, etc.)
- Serves **feed batches** from a cached Amazon item pool
- Learns from user **signals** (`skip`, `save`, `shop_now`, `dislike`)

**Key constraint:** Amazon and Claude are never called on the swipe hot path. Search terms are pre-computed; Amazon results are cached. Feed generation reads from cache and scores locally.

```
taxonomy/*.txt  →  Claude precompute  →  hobby_angle_expansions / occasion_search_terms
                                              ↓
User → Profile → Session → generateFeed() → amazon_cache → feed_events
                                              ↓
                                    processSignal() → profile_weights
```

---

## 2. Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (ES modules) |
| HTTP | Fastify 5 |
| Validation | Zod (`routes/schemas.js`) |
| Auth | `@fastify/jwt` (Bearer tokens) |
| Database | Supabase (PostgreSQL) via `@supabase/supabase-js` |
| Amazon | Amazon Creators API (`amazon-creators-api` npm package) |
| LLM | Anthropic Claude (`@anthropic-ai/sdk`) — setup/precompute only |
| Jobs | `node-cron` (in-process, started with API server) |
| Dev UI | React test console (`test-console/`, Vite) |

---

## 3. Repository Structure

```
giftgenius-engine/
├── server.js                 # Fastify bootstrap, plugins, route registration
├── index.js                  # CLI entry (placeholder)
├── gift-app-hla.md           # Full HLA spec (domain + algorithms)
│
├── routes/                   # HTTP handlers (thin — validate, authorize, delegate)
│   ├── auth.js               # POST /auth/token
│   ├── profiles.js           # POST/GET/PATCH /profiles
│   ├── sessions.js           # POST /sessions, PATCH /sessions/:id/end
│   ├── feed.js               # GET /feed/:session_id, POST /feed/signal
│   ├── admin.js              # /admin/* (taxonomy, precompute, cache, users, stats)
│   └── schemas.js            # Zod schemas + validate() helper
│
├── services/                 # Business logic
│   ├── taxonomy.js           # Read taxonomy/*.txt, sync hobbies to DB
│   ├── claude.js             # LLM search-term generation
│   ├── precompute.js         # Batch hobby×angle + occasion expansion pipeline
│   ├── amazon.js             # Cache layer, API calls, rate limiting, refresh
│   ├── feed.js               # Feed generation engine (scoring, slots, diversity)
│   ├── signal.js             # Signal processing + weight decay job
│   └── jobs.js               # Cron scheduler (cache refresh, weight decay)
│
├── db/
│   ├── index.js              # Supabase client singleton (getDb)
│   ├── schema.pg.sql         # Full schema + RPC functions (HLA v2)
│   └── schema.js             # Schema helpers (if any)
│
├── taxonomy/                 # Static taxonomy source of truth (.txt files)
│   ├── hobbies.txt
│   ├── angles.txt            # name|definition per line
│   ├── occasions.txt
│   └── budget_buckets.txt
│
├── scripts/
│   ├── migrate.js            # Apply schema via Supabase Management API
│   ├── clear-data.js         # Wipe runtime data (optional --keep-hobbies)
│   └── test-commands.sh      # curl cookbook for local testing
│
├── test-console/             # React dev UI for end-to-end workflow testing
│   └── src/
│       ├── api.js            # Fetch wrapper with JWT
│       ├── App.jsx           # 5-step wizard: Setup → Precompute → Profile → Session → Feed
│       └── panels/           # One panel per step
│
└── public/                   # Built test-console assets served at GET /
```

### Layering rules

| Layer | Responsibility |
|---|---|
| `routes/` | Parse/validate input, auth checks, call services, map HTTP status |
| `services/` | Domain logic, orchestration, scoring, external API integration |
| `db/` | Connection + schema only — no business rules |
| `taxonomy/` | Human-editable config; synced into `hobbies` table via admin endpoint |

---

## 4. Core Domain Model

### Profiles (recipients)

A **profile** is a gift recipient: label ("Mom"), hobby UUIDs, and budget range. On creation, `profile_weights` rows are initialized for every `(hobby_id, angle)` pair at weight `1.0`.

### Sessions (shopping context)

A **session** ties a profile to an **occasion** (`birthday`, `christmas`, `mothers_day`, etc.). Occasion affects which slot types are prioritized in feed construction; it does not trigger new Amazon calls.

### Feed events (served items)

Each item returned by `GET /feed/:session_id` is recorded in `feed_events` with:

- `item_snapshot` (title, price, image, product URL at serve time)
- `hobby_id`, `angle`, `slot_type` (provenance metadata)
- `signal` (null until user acts)

The client must send `feed_event_id` back when recording a signal.

### Hobby × Angle matrix

Hobbies are never searched directly. Each hobby expands across six **angles**:

| Angle | Purpose |
|---|---|
| `consumable` | Supplies, refills, raw materials |
| `skill` | Tools and equipment |
| `experience` | Classes, subscriptions, events |
| `aesthetic` | Style/design-driven items |
| `social` | Shared or hosted activities |
| `wildcard` | Lateral, non-obvious associations |

Claude generates 6–8 Amazon search terms per `(hobby, angle)` during precompute. Stored in `hobby_angle_expansions`.

### Budget buckets

User `budget_min` / `budget_max` maps to overlapping discretized buckets (`0-25`, `25-50`, … `200+`). Buckets are part of the Amazon cache key: `sha256("{search_term}:{budget_bucket}")`.

### Signals

| Signal | Effect |
|---|---|
| `skip` | Weight −0.1 (floor 0.1) on `(hobby_id, angle)` |
| `dislike` | Weight → 0.0; permanent item + cluster suppression |
| `save` | Weight +0.3 (ceiling 3.0) |
| `shop_now` | Weight +0.2; 7-day cooldown on cluster (score × 0.2) |

Signals on occasion/adjacent items (no `hobby_id`/`angle`) are recorded but do not adjust weights.

---

## 5. Data Model (PostgreSQL / Supabase)

Schema lives in `db/schema.pg.sql`. Tables group into four layers:

### Reference (static / precomputed)

- `hobbies` — taxonomy entries synced from `taxonomy/hobbies.txt`
- `hobby_angle_expansions` — Claude-generated search terms per hobby×angle
- `occasion_search_terms` — occasion×budget_bucket search terms
- `cross_hobby_expansions` — intersection terms for multi-hobby profiles (generated async)

### Cache

- `amazon_cache` — JSONB item arrays keyed by `cache_key`, 48h TTL
- `api_call_tracking` — daily Amazon API call counter (UTC date key)

### User state

- `users` — app users (created via admin for now)
- `profiles` — recipient config per user
- `profile_weights` — learned scores per `(profile, hobby, angle)` + optional `cooldown_until`
- `dislike_suppressions` — permanent item- or cluster-level blocks

### Runtime feed

- `sessions` — active shopping sessions
- `feed_events` — every served item + eventual signal

### RPC functions

Weight adjustment, cache hit increment, daily call counting, and weight decay are implemented as Postgres functions called via `supabase.rpc()`.

**Note:** The schema migration drops legacy v1 tables (`catalog`, `feeds`, `queue_items`, `interactions`, `seen_items`, etc.) if upgrading.

---

## 6. Pipelines

### 6.1 Taxonomy sync (admin, on demand)

```
POST /admin/taxonomy/sync
  → services/taxonomy.js::syncAll()
  → upsert hobbies from taxonomy/hobbies.txt into Supabase
```

Angles, occasions, and budget buckets are read from `.txt` files at runtime (not stored as DB rows).

### 6.2 Pre-computation (admin, one-time / on taxonomy change)

```
POST /admin/precompute
  → services/precompute.js::runPrecompute()
    Step 1: expandAllHobbyAngles()  — Claude per (hobby, angle), batched 10 + 1s delay
    Step 2: expandAllOccasions()    — Claude per (occasion, budget_bucket)
  → writes hobby_angle_expansions, occasion_search_terms
```

Claude is **not** called during user sessions except async cross-hobby synthesis when a profile has 2+ hobbies.

### 6.3 Amazon cache resolution

```
getItemsForSearchTerm(term, bucket)   [services/amazon.js]
  1. Check amazon_cache (expires_at > now) → return items, increment hit_count
  2. If miss: check daily call count (< 8500)
  3. If under limit: throttle (~1.2s), call SearchItems, upsert cache (48h TTL)
  4. If over limit or error: return []
```

### 6.4 Feed generation (runtime hot path)

```
GET /feed/:session_id?batch=10
  → services/feed.js::generateFeed()
    1. Load profile, weights, occasion, suppressions, recent feed_events (500)
    2. Build fetch queue: hobby×angle terms (top 3 per pair), cross-hobby, occasion terms
    3. Parallel cache lookups via getItemsForSearchTerm()
    4. Filter: dedupe, recycling rules, suppressions, budget
    5. Fill slots from repeating pattern:
       [interest, interest, adjacent, interest, wildcard,
        interest, occasion, interest, adjacent, interest]
    6. Score: baseWeight × cooldown × recency × diversity + noise
    7. Enforce max 2 consecutive items from same (hobby_id, angle) cluster
    8. Insert feed_events, return items with feed_event_id
```

**Item recycling rules** (from recent `feed_events`):

- `save`, `shop_now`, `dislike` → permanently excluded
- `skip` → excluded for 30 days
- `signal = null` (served, not yet acted) → excluded

### 6.5 Signal processing

```
POST /feed/signal { feed_event_id, signal }
  → services/signal.js::processSignal()
    1. Update feed_events.signal + acted_at
    2. Adjust profile_weights via RPC (or insert dislike_suppressions)
```

---

## 7. API Surface

All authenticated routes expect `Authorization: Bearer <jwt>`. Admin routes additionally accept `x-admin-secret` when `ADMIN_SECRET` is set.

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/` | Serves built test console (`public/index.html`) |

### Auth

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/token` | Issue JWT for `{ user_id }` (dev/test convenience) |

### Profiles (authenticated)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/profiles` | Create recipient profile |
| `GET` | `/profiles/:id` | Profile + hobbies + weights |
| `PATCH` | `/profiles/:id` | Update label, hobbies, budget |

### Sessions (authenticated)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sessions` | Start session `{ profile_id, occasion }` |
| `GET` | `/sessions/:id` | Session details |
| `PATCH` | `/sessions/:id/end` | End session |

### Feed (authenticated)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/feed/:session_id?batch=10` | Next feed batch |
| `POST` | `/feed/signal` | Record `{ feed_event_id, signal }` |

### Admin

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/admin/taxonomy/sync` | Sync hobbies from `.txt` files |
| `GET` | `/admin/taxonomy` | View angles, buckets, occasions |
| `POST` | `/admin/precompute` | Run Claude expansion pipeline |
| `POST` | `/admin/cache/refresh` | Refresh expiring cache entries |
| `GET` | `/admin/api-usage` | Daily Amazon call count |
| `GET/POST` | `/admin/hobbies` | List / bulk-add hobbies |
| `GET/POST` | `/admin/users` | List / create users |
| `GET` | `/admin/profiles` | List all profiles |
| `GET` | `/admin/sessions` | List active sessions |
| `GET` | `/admin/stats` | Table row counts |

### Feed item response shape

```json
{
  "items": [
    {
      "feed_event_id": "uuid",
      "asin": "B00...",
      "title": "...",
      "price": 29.99,
      "image_url": "https://...",
      "product_url": "https://www.amazon.com/dp/...?tag=...",
      "category": "Kitchen",
      "slot_type": "interest",
      "hobby_id": "uuid",
      "angle": "skill",
      "score": 1.44
    }
  ],
  "count": 10
}
```

---

## 8. Background Jobs

Started automatically when the API server boots (`services/jobs.js`):

| Job | Schedule | Handler |
|---|---|---|
| Weight decay | Daily 03:00 UTC | `signal.js::applyWeightDecay()` — drift stale weights 2% toward 1.0 |
| Cache refresh | Every 6h at :30 | `amazon.js::refreshExpiringCache()` — refresh top 100 expiring entries |

---

## 9. Security Model

| Concern | Implementation |
|---|---|
| User identity | JWT (`@fastify/jwt`), `request.user.id` from token payload |
| Resource ownership | Routes verify `profile.user_id === request.user.id` via joins |
| Admin access | `x-admin-secret` header; skipped if `ADMIN_SECRET` unset (dev only) |
| Input validation | Zod schemas in `routes/schemas.js` |
| Error responses | Unified handler in `server.js`; 500s hide details in production |
| Secrets | Env vars only — never committed |

For a full security checklist, see [`docs/personas/security.md`](./docs/personas/security.md).

---

## 10. Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side DB access |
| `SUPABASE_ACCESS_TOKEN` | Migrate only | Personal token for `scripts/migrate.js` |
| `JWT_SECRET` | Prod | JWT signing secret |
| `ADMIN_SECRET` | Prod | Protects `/admin/*` routes |
| `AMAZON_CREDENTIAL_ID` | Yes | Creators API credential |
| `AMAZON_CREDENTIAL_SECRET` | Yes | Creators API secret |
| `AMAZON_PARTNER_TAG` | Yes | Affiliate tag for product URLs |
| `AMAZON_CREDENTIAL_VERSION` | Optional | Default from SDK (e.g. `3.1`) |
| `ANTHROPIC_API_KEY` | Precompute | Claude for search-term generation |
| `PORT` | Optional | API port (default `3000`) |
| `NODE_ENV` | Optional | `production` enables error sanitization |

Load order: `.env.local` first, then `.env` (see `server.js`, `db/index.js`).

---

## 11. Local Development Workflow

### First-time setup

```bash
# 1. Apply schema to Supabase
node scripts/migrate.js

# 2. Start API
npm run start:api

# 3. Sync taxonomy + create a user (see scripts/test-commands.sh)
curl -X POST http://127.0.0.1:3000/admin/taxonomy/sync
curl -X POST http://127.0.0.1:3000/admin/users -H 'content-type: application/json' \
  -d '{"name":"Test","email":"test@example.com"}'

# 4. Get JWT
curl -X POST http://127.0.0.1:3000/auth/token -H 'content-type: application/json' \
  -d '{"user_id":"<USER_UUID>"}'

# 5. Precompute search terms (requires ANTHROPIC_API_KEY)
curl -X POST http://127.0.0.1:3000/admin/precompute
```

### Test console (visual workflow)

```bash
npm run start:api    # terminal 1
npm run console      # terminal 2 — opens Vite dev UI
```

The console walks through: Setup → Pre-Compute → Profile → Session → Feed.

### Useful scripts

| Command | Purpose |
|---|---|
| `npm run start:api` | Start Fastify server + background jobs |
| `npm run console` | Launch React test console |
| `npm run db:migrate` | Apply schema via Supabase API |
| `npm run db:clear` | Wipe runtime data |
| `scripts/test-commands.sh` | curl examples for every endpoint |

---

## 12. Frontend Integration (Summary)

The mobile/Expo client should follow this sequence:

1. Obtain JWT via `POST /auth/token` (or future real auth)
2. `POST /profiles` with `hobby_ids` (UUIDs from `GET /admin/hobbies`)
3. `POST /sessions` with `profile_id` + `occasion`
4. `GET /feed/:session_id?batch=N` — render swipe cards
5. `POST /feed/signal` with `feed_event_id` on each swipe action

Map UI actions to signals:

| UI action | Signal |
|---|---|
| Swipe left / pass | `skip` |
| Swipe right / like | `save` |
| Open buy link | `shop_now` |
| Strong reject | `dislike` |

Saved items are `feed_events` where `signal = 'save'`. A dedicated `GET /saved` endpoint is not yet implemented — query via admin or add a profile-scoped route when needed.

For detailed client examples, update [`FRONTEND_INTEGRATION_GUIDE.md`](./FRONTEND_INTEGRATION_GUIDE.md) to match this API (it currently describes the legacy feeds model).

---

## 13. Key Guardrails

From the HLA — enforced in code:

- **Amazon daily cap:** 8,500 calls/day; cache misses return `[]`, not blocking errors
- **Cache TTL:** 48 hours minimum; proactive refresh every 6 hours
- **Claude at runtime:** Only async cross-hobby synthesis; all other LLM work is precompute
- **Dislike permanence:** Cluster + item suppressions never expire
- **Weight bounds:** Floor 0.1 (skip), ceiling 3.0 (positive signals), 0.0 only on dislike
- **Diversity:** Slot pattern + max 2 consecutive same `(hobby_id, angle)` cluster
- **No Amazon per swipe:** Feed generation reads cache only; API calls happen on cache miss within `getItemsForSearchTerm`

---

## 14. Related Documents

| Document | Contents |
|---|---|
| [`gift-app-hla.md`](./gift-app-hla.md) | Full HLA: scoring formulas, signal deltas, recycling rules |
| [`FRONTEND_INTEGRATION_GUIDE.md`](./FRONTEND_INTEGRATION_GUIDE.md) | Client integration guide (needs update for new API) |
| [`FRONTEND_SERVICE_TASKS.md`](./FRONTEND_SERVICE_TASKS.md) | Frontend readiness checklist (legacy API references) |
| [`scripts/test-commands.sh`](./scripts/test-commands.sh) | Copy-paste curl commands |
