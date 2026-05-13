# Gift Recommendation App — Backend Engine HLA

## 1. Purpose & Scope

This document defines the backend architecture for the gift recommendation engine. It covers data modeling, the pre-computation pipeline, Amazon API sourcing and caching, feed generation, signal processing, and the learning loop. Frontend and auth are out of scope.

---

## 2. Core Concepts

Before implementation, internalize these domain concepts. Every architectural decision flows from them.

**Hobby × Angle Matrix**: A hobby (e.g. `cooking`) is never queried directly. It is always expanded across a fixed set of angles (e.g. `skill`, `experience`, `aesthetic`) to produce diverse search terms. This is pre-computed once and cached permanently.

**Angle**: A dimension of a hobby that targets a different slice of the Amazon catalog. Fixed enum:
- `ingredient` — consumable, supply-based gifts
- `skill` — tools and equipment that improve technique
- `experience` — classes, subscriptions, events
- `aesthetic` — style/design-driven items in the space
- `social` — gifts centered on shared or hosted activities
- `wildcard` — Claude-generated lateral associations (non-obvious)

**Occasion**: The context for a shopping session. Changes which angle buckets are prioritized at feed construction time. Does not trigger new Amazon API calls. Fixed enum: `birthday`, `christmas`, `mothers_day`, `fathers_day`, `anniversary`, `graduation`, `housewarming`, `just_because`.

**Budget Bucket**: Discretized budget range used as a cache key. User's min/max budget maps to one or more buckets. Buckets: `0-25`, `25-50`, `50-75`, `75-100`, `100-150`, `150-200`, `200+`.

**Item Pool**: The set of Amazon items available for a profile's feed, drawn from cached results for all applicable hobby × angle × budget bucket combinations.

**Signal**: A user action on a feed item. Four types: `skip`, `save`, `shop_now`, `dislike`. Each has distinct effects on profile weights and future feed construction.

---

## 3. Database Schema (Supabase / PostgreSQL)

### 3.1 Reference Tables (static, pre-populated)

```sql
-- Fixed taxonomy of hobbies
CREATE TABLE hobbies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,         -- e.g. "cooking"
  slug TEXT NOT NULL UNIQUE,         -- e.g. "cooking"
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Pre-computed search terms per hobby × angle combination
-- Populated once by the pre-computation pipeline, never at runtime
CREATE TABLE hobby_angle_expansions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hobby_id UUID REFERENCES hobbies(id) ON DELETE CASCADE,
  angle TEXT NOT NULL CHECK (angle IN ('ingredient','skill','experience','aesthetic','social','wildcard')),
  search_terms JSONB NOT NULL,       -- string[]
  computed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(hobby_id, angle)
);

-- Occasion-specific search terms, independent of hobbies
-- e.g. "luxury birthday gift set", "unique experience gift"
-- Populated once, 5-10 terms per occasion × budget_bucket pair
CREATE TABLE occasion_search_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occasion TEXT NOT NULL,
  budget_bucket TEXT NOT NULL,
  search_terms JSONB NOT NULL,       -- string[]
  computed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(occasion, budget_bucket)
);
```

### 3.2 Caching Tables

```sql
-- Amazon API result cache
-- Key: search_term + budget_bucket
-- TTL enforced by expired_at; background job refreshes stale entries
CREATE TABLE amazon_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key TEXT NOT NULL UNIQUE,    -- sha256("{search_term}:{budget_bucket}")
  search_term TEXT NOT NULL,
  budget_bucket TEXT NOT NULL,
  items JSONB NOT NULL,              -- AmazonItem[]
  cached_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,   -- cached_at + 48 hours
  hit_count INT DEFAULT 0
);

CREATE INDEX idx_amazon_cache_expires ON amazon_cache(expires_at);
CREATE INDEX idx_amazon_cache_key ON amazon_cache(cache_key);
```

### 3.3 User & Profile Tables

```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,             -- FK to your auth users table
  label TEXT NOT NULL,               -- "Mom", "Brother", etc.
  hobby_ids UUID[] NOT NULL,         -- references hobbies.id
  budget_min INT NOT NULL,
  budget_max INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Per-profile weight scores for each hobby × angle pair
-- Updated after every signal
-- Drives feed ranking
CREATE TABLE profile_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  hobby_id UUID REFERENCES hobbies(id),
  angle TEXT NOT NULL,
  weight FLOAT NOT NULL DEFAULT 1.0, -- starts neutral, adjusted by signals
  consecutive_shown INT DEFAULT 0,   -- tracks how many times shown recently
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(profile_id, hobby_id, angle)
);

-- Hard suppression list — items and category clusters the user disliked
CREATE TABLE dislike_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  suppression_type TEXT NOT NULL CHECK (suppression_type IN ('item','cluster')),
  item_asin TEXT,                    -- if suppression_type = 'item'
  hobby_id UUID,                     -- if suppression_type = 'cluster'
  angle TEXT,                        -- if suppression_type = 'cluster'
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### 3.4 Session & Feed Tables

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  occasion TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

-- Every item served to a user in a session, with outcome
CREATE TABLE feed_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES profiles(id),
  item_asin TEXT NOT NULL,
  item_snapshot JSONB NOT NULL,      -- price, title, image at time of serving
  hobby_id UUID,                     -- source hobby
  angle TEXT,                        -- source angle
  slot_type TEXT NOT NULL CHECK (slot_type IN ('interest','adjacent','wildcard','occasion')),
  signal TEXT CHECK (signal IN ('skip','save','shop_now','dislike')),
  served_at TIMESTAMPTZ DEFAULT now(),
  acted_at TIMESTAMPTZ
);

CREATE INDEX idx_feed_events_profile ON feed_events(profile_id);
CREATE INDEX idx_feed_events_asin ON feed_events(item_asin);
```

---

## 4. Data Types

```typescript
interface AmazonItem {
  asin: string;
  title: string;
  price: number;
  image_url: string;
  product_url: string;
  category: string;
  fetched_at: string; // ISO timestamp
}

type Angle = 'ingredient' | 'skill' | 'experience' | 'aesthetic' | 'social' | 'wildcard';

type Signal = 'skip' | 'save' | 'shop_now' | 'dislike';

type SlotType = 'interest' | 'adjacent' | 'wildcard' | 'occasion';

type Occasion =
  | 'birthday' | 'christmas' | 'mothers_day' | 'fathers_day'
  | 'anniversary' | 'graduation' | 'housewarming' | 'just_because';

type BudgetBucket = '0-25' | '25-50' | '50-75' | '75-100' | '100-150' | '150-200' | '200+';

interface FeedSlotConfig {
  pattern: SlotType[];   // repeating pattern, e.g. ['interest','interest','adjacent','interest','wildcard']
  max_consecutive_same_cluster: number; // hard cap, default 2
}
```

---

## 5. Pre-Computation Pipeline

This pipeline runs **once at system setup** and again whenever the hobby taxonomy changes. It is never invoked at runtime during user sessions. All Claude calls happen here, not in the hot path.

### 5.1 Step 1 — Expand Hobby × Angle Matrix

For every `(hobby, angle)` pair in the taxonomy:

1. Call Claude with the following prompt structure:

```
You are generating Amazon product search terms for a gift recommendation app.

Hobby: {hobby.name}
Angle: {angle}
Angle definition: {ANGLE_DEFINITIONS[angle]}

Generate 6-8 distinct search queries that would surface genuinely useful and non-obvious
Amazon products for someone who loves this hobby, viewed through this angle.

Rules:
- Each query should hit a meaningfully different product type
- Avoid generic terms like "cooking gift" — be specific
- Queries should work as literal Amazon search inputs
- Budget context: products should generally fall in the $20-$200 range
- Return ONLY a JSON array of strings. No preamble, no explanation.

Example output: ["japanese chef knife set","mandoline slicer with safety guard","cast iron spice grinder"]
```

2. Parse response, validate as `string[]`.
3. Write to `hobby_angle_expansions(hobby_id, angle, search_terms)`.

Total Claude calls: `num_hobbies × num_angles`. With 150 hobbies and 6 angles = 900 calls. Run async in batches of 10 with 1s delay to avoid rate limits.

### 5.2 Step 2 — Generate Occasion Search Terms

For every `(occasion, budget_bucket)` pair:

1. Call Claude:

```
Generate 6-8 Amazon search terms for occasion-specific gift discovery.
These should NOT be hobby-dependent — they are universal gift ideas for this occasion.

Occasion: {occasion}
Budget bucket: {budget_bucket}

Return ONLY a JSON array of strings.
```

2. Write to `occasion_search_terms`.

Total calls: `8 occasions × 7 budget_buckets` = 56 calls. Trivial.

### 5.3 Step 3 — Pre-warm Amazon Cache (Optional)

After generating all search terms, optionally trigger Amazon API calls for the most common hobby × angle × budget_bucket combinations to pre-warm the cache. Prioritize the highest-frequency hobby slugs (determine from expected usage or a fixed priority list).

---

## 6. Amazon API Sourcing & Cache Layer

### 6.1 Budget Bucket Resolution

A user's `budget_min` / `budget_max` maps to one or more buckets:

```typescript
function resolveBudgetBuckets(min: number, max: number): BudgetBucket[] {
  const ALL_BUCKETS: BudgetBucket[] = ['0-25','25-50','50-75','75-100','100-150','150-200','200+'];
  const BUCKET_RANGES = { '0-25':[0,25], '25-50':[25,50], ... };
  return ALL_BUCKETS.filter(b => {
    const [lo, hi] = BUCKET_RANGES[b];
    return lo < max && hi > min; // overlapping ranges only
  });
}
```

### 6.2 Cache Key

```typescript
function buildCacheKey(searchTerm: string, bucket: BudgetBucket): string {
  return sha256(`${searchTerm}:${bucket}`);
}
```

### 6.3 Cache Resolution Flow

```
getItemsForSearchTerm(searchTerm, bucket):
  key = buildCacheKey(searchTerm, bucket)
  row = SELECT FROM amazon_cache WHERE cache_key = key AND expires_at > now()
  
  if row exists:
    UPDATE amazon_cache SET hit_count = hit_count + 1 WHERE cache_key = key
    return row.items
  
  else:
    CHECK daily_api_call_count < 8500  // leave 500 as buffer
    if over limit:
      return []  // surface no items for this term today; log for retry
    
    items = callAmazonAPI(searchTerm, bucket.min, bucket.max)
    UPSERT amazon_cache(cache_key, search_term, budget_bucket, items, expires_at = now() + 48h)
    INCREMENT daily_api_call_count
    return items
```

### 6.4 Daily API Call Tracking

Store `daily_api_calls` in a simple key-value table or Redis counter, keyed by UTC date. Reset at midnight UTC. Alert at 7,500 calls. Hard stop new cache-miss calls at 8,500.

### 6.5 Cache Refresh Job

Run every 6 hours:
1. `SELECT cache_key FROM amazon_cache WHERE expires_at < now() + interval '6 hours'`
2. For each expiring entry, re-call Amazon API if daily budget allows, update `items` and `expires_at`.
3. This ensures cache is refreshed proactively, not reactively during user sessions.

---

## 7. Feed Generation Engine

This is the core runtime system. It runs on every request for the next batch of feed items.

### 7.1 Feed Slot Pattern

The feed is not a flat ranked list. It follows a **repeating slot pattern** that enforces diversity structurally:

```
Pattern (repeats): [interest, interest, adjacent, interest, wildcard, interest, occasion, interest, adjacent, interest]
```

- `interest` — items from the profile's highest-weighted hobby × angle buckets
- `adjacent` — items from a hobby × angle the user has not yet interacted with, or a cross-hobby synthesis bucket
- `wildcard` — items from the `wildcard` angle of any hobby; intended to be surprising
- `occasion` — items from `occasion_search_terms` for the active session's occasion

**Hard constraint**: Never serve more than 2 consecutive items from the same `(hobby_id, angle)` cluster, regardless of slot type. This is enforced after scoring, before returning items to the client.

### 7.2 Feed Generation Flow

```
generateFeed(session_id, profile_id, batch_size = 10):

  1. Load profile: hobby_ids, budget_min, budget_max
  2. Load profile_weights for all (hobby_id, angle) pairs
  3. Load occasion from sessions table
  4. Load dislike_suppressions for this profile
  5. Load recently_served_asins from feed_events (last 500 events for this profile)
  
  6. Resolve budget_buckets from profile budget
  
  7. Build item pool:
     For each hobby_id in profile.hobby_ids:
       For each angle in ALL_ANGLES:
         search_terms = hobby_angle_expansions[hobby_id][angle]
         For each term in search_terms:
           items = getItemsForSearchTerm(term, bucket)  // uses cache layer
           Tag each item with { hobby_id, angle, source_term }
           Add to item_pool
     
     Also fetch occasion items:
       terms = occasion_search_terms[occasion][budget_bucket]
       Fetch and tag with { slot_type: 'occasion' }
  
  8. Filter item pool:
     - Remove any asin in recently_served_asins
     - Remove any asin in dislike_suppressions (item-level)
     - Remove any item whose (hobby_id, angle) is in dislike_suppressions (cluster-level)
     - Remove items outside profile budget range
  
  9. Score remaining items:
     score(item) =
       profile_weights[item.hobby_id][item.angle]   // learned weight
       × recency_penalty(item)                       // items shown long ago score higher
       × diversity_bonus(item, last_2_served)        // boost if different cluster from recent
  
  10. For each slot in the pattern (up to batch_size):
      - Select slot type from pattern
      - Filter candidates by slot type rules
      - Pick highest-scoring eligible candidate
      - Enforce: if same cluster as either of the 2 previously picked items, skip and pick next
      - Add to feed, mark asin as served
  
  11. Insert feed_events rows for all served items (signal = NULL until user acts)
  
  12. Return ordered list of AmazonItem + metadata
```

### 7.3 Scoring Details

```typescript
function scoreItem(
  item: TaggedItem,
  weights: ProfileWeights,
  lastServedAsins: string[],
  lastServedClusters: string[]
): number {
  const baseWeight = weights[item.hobby_id]?.[item.angle] ?? 1.0;

  // Items not seen in a long time get a boost (recency penalty = lower = better)
  const daysSinceSeen = getDaysSinceSeen(item.asin, profile_id);
  const recencyBonus = Math.min(daysSinceSeen / 30, 1.5); // caps at 1.5x after 45 days

  // Boost items from a different cluster than the last 2 served
  const clusterKey = `${item.hobby_id}:${item.angle}`;
  const diversityBonus = lastServedClusters.includes(clusterKey) ? 0.5 : 1.2;

  return baseWeight * recencyBonus * diversityBonus;
}
```

---

## 8. Signal Processing

Called when a user acts on a feed item. Updates profile weights immediately. Weights affect the next feed generation call.

### 8.1 Signal Definitions & Weight Deltas

| Signal | Meaning | Weight Delta | Other Effects |
|---|---|---|---|
| `skip` | Mild disinterest, may resurface | `−0.1` on `(hobby_id, angle)` | None |
| `dislike` | Wrong category entirely | Set weight → `0.0` | Insert cluster-level suppression |
| `save` | Interested, still browsing | `+0.3` on `(hobby_id, angle)` | None |
| `shop_now` | Found it; brief boost then cooldown | `+0.2` then scheduled cooldown | Set `cooldown_until = now() + 7 days` on cluster |

### 8.2 Signal Processing Flow

```
processSignal(feed_event_id, signal: Signal):

  1. Load feed_event to get (profile_id, item_asin, hobby_id, angle)
  2. UPDATE feed_events SET signal = signal, acted_at = now()
  
  3. SWITCH signal:
  
     CASE 'skip':
       UPDATE profile_weights
         SET weight = GREATEST(weight - 0.1, 0.1),  // floor at 0.1, never fully suppress
             updated_at = now()
         WHERE profile_id = X AND hobby_id = Y AND angle = Z
  
     CASE 'dislike':
       UPDATE profile_weights SET weight = 0.0 WHERE profile_id = X AND hobby_id = Y AND angle = Z
       INSERT INTO dislike_suppressions (profile_id, suppression_type, hobby_id, angle)
         VALUES (X, 'cluster', Y, Z)
       -- Also suppress the specific item
       INSERT INTO dislike_suppressions (profile_id, suppression_type, item_asin)
         VALUES (X, 'item', item_asin)
  
     CASE 'save':
       UPDATE profile_weights
         SET weight = LEAST(weight + 0.3, 3.0),  // ceiling at 3.0
             updated_at = now()
         WHERE profile_id = X AND hobby_id = Y AND angle = Z
  
     CASE 'shop_now':
       -- Small immediate boost
       UPDATE profile_weights SET weight = LEAST(weight + 0.2, 3.0) WHERE ...
       -- Schedule cooldown: this cluster should appear less for next 7 days
       -- Implemented via a cooldown_until column on profile_weights
       UPDATE profile_weights SET cooldown_until = now() + interval '7 days' WHERE ...
  
  4. Return 200 OK
```

### 8.3 Cooldown Enforcement

In feed generation step 9 (scoring), apply:

```typescript
if (weight.cooldown_until && weight.cooldown_until > now()) {
  score *= 0.2; // heavily deprioritize cooled-down clusters
}
```

---

## 9. Cross-Hobby Synthesis

When a profile has 2+ hobbies, Claude-generated cross-hobby search terms provide items that sit at the intersection (e.g. cooking + hiking → camp cooking gear).

### 9.1 Generation

- Triggered **once per unique sorted hobby combination** at profile creation time, if not already cached.
- Cache key: `cross_hobby:{sorted_hobby_slugs_joined_by_underscore}`
- Store results in a `cross_hobby_expansions` table: `(combo_key TEXT, search_terms JSONB, computed_at TIMESTAMPTZ)`.
- Claude prompt:

```
A person has the following hobbies: {hobby_names_list}.
Generate 6-8 Amazon search terms for gifts that combine or sit at the intersection of these hobbies.
These should be non-obvious — items they wouldn't find just searching for one hobby alone.
Return ONLY a JSON array of strings.
```

### 9.2 Feed Integration

Cross-hobby items are tagged with `slot_type = 'adjacent'` and enter the pool with a base weight of `1.0` (unlearned, treated as neutral). They are served in `adjacent` slots in the feed pattern.

---

## 10. API Endpoints

All endpoints are authenticated. `profile_id` is always scoped to the authenticated user.

```
POST   /profiles                          Create a new recipient profile
GET    /profiles/:id                      Get profile with current weights summary
PATCH  /profiles/:id                      Update hobbies or budget

POST   /sessions                          Start a new session { profile_id, occasion }
PATCH  /sessions/:id/end                  End session

GET    /feed/:session_id?batch=10         Get next batch of feed items
POST   /feed/signal                       Record a signal { feed_event_id, signal }

POST   /admin/precompute                  Trigger pre-computation pipeline (admin only)
POST   /admin/cache/refresh               Trigger manual cache refresh (admin only)
GET    /admin/api-usage                   Get daily Amazon API call count
```

---

## 11. Background Jobs

| Job | Trigger | Purpose |
|---|---|---|
| `cache_refresh` | Every 6 hours | Refresh expiring Amazon cache entries |
| `api_call_counter_reset` | Midnight UTC daily | Reset daily Amazon API call counter |
| `weight_decay` | Daily | Apply mild decay to all profile weights toward 1.0 to prevent feed from locking in permanently (decay factor: 0.98 per day) |
| `cross_hobby_precompute` | On profile creation (async) | Generate cross-hobby search terms if not cached |

### Weight Decay Rationale

Without decay, a profile that heavily disliked "experience" items three months ago will suppress them forever — even if the user's preferences changed. Daily decay pulls weights back toward neutral slowly, keeping the feed adaptive over time.

```sql
UPDATE profile_weights
SET weight = weight + (1.0 - weight) * 0.02  -- 2% drift toward 1.0 per day
WHERE updated_at < now() - interval '1 day';
```

---

## 12. Key Constraints & Guardrails

- **Amazon API**: Hard stop at 8,500 calls/day. Cache all results for 48 hours minimum. Never call Amazon in the feed generation hot path if the cache is cold — return empty for that slot and fill with other candidates.
- **Claude**: Never called at runtime during user sessions. All Claude calls happen in pre-computation (setup) or cross-hobby synthesis (async, post profile creation).
- **Dislike suppressions**: Never expire. A user who dislikes a category should never see it again unless they manually reset the profile.
- **Weight floor**: `profile_weights.weight` never drops below `0.1` on `skip`. Only `dislike` sets it to `0.0`.
- **Weight ceiling**: `3.0`. Prevents any single cluster from dominating the feed regardless of positive signal volume.
- **Consecutive same-cluster cap**: 2 items max, enforced hard in feed construction regardless of scores.
- **Item recycling window**: Items in `feed_events` are excluded from the pool for 30 days after serving (for `skip`) and permanently for `dislike`. `save` and `shop_now` items are permanently excluded from re-serving (user already acted).
