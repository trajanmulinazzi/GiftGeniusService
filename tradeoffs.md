# Tradeoffs: Catalog vs. API-per-User Pricing

Comparison of **catalog-based** (cache prices, batch refresh) vs. **API-per-user** (call Amazon on every user action) for gift recommendations. Uses **Amazon Creators API** only for pricing. *(PA-API is deprecated; migrate by Jan 30, 2026.)*

---

## Amazon Creators API Summary

| Property | Value |
|----------|-------|
| **Cost per request** | Free |
| **Rate limits** | Not fully documented; assume similar to legacy PA-API (~8,640 TPD, 1 TPS) until Amazon publishes specifics |
| **Auth** | OAuth 2.0 client-credentials; token valid ~1 hour |
| **Credentials** | Credential ID + Credential Secret (from Associates Central → Tools → Creators API) |
| **Eligibility** | 10+ qualified sales in last 30 days; access revoked after 30 days without qualifying sales |
| **Payload** | lowerCamelCase (`itemIds`, `partnerTag`, etc.) |

### Implementation Overview

1. **Create credentials**: Associates Central → Tools → Creators API → Create Application → Add New Credential
2. **Get OAuth token**: `POST` to token endpoint with `client_id` (Credential ID) and `client_secret` (Credential Secret); `grant_type=client_credentials`
3. **Fetch products**: Use Creators API product/offers endpoint with `itemIds` (ASINs), `partnerTag`; batch up to ~10 ASINs per request (check current docs)
4. **Cache token**: Reuse until ~1 hour to avoid extra auth calls

### PA-API Deprecation

- **Offers V1 retirement**: January 31, 2026
- **Switch deadline**: January 30, 2026 (to access Offers V2 via Creators API)
- PA-API 5.0 deprecated April 30, 2026

---

## Assumptions (Pricing Model)

- **Products per refill**: 5 (matches current `REFILL_BATCH_SIZE`)
- **Refills per user session**: 4 (queue refills when ≤5 items left)
- **Products shown per user per day**: ~25 (5 initial + 4×5 refills)
- **Creators API batching**: 1 request per 5 products (~10 ASINs per call, similar to GetItems)
- **API calls per user per day**: ~5 (25 products ÷ 5 per request)
- **Catalog refresh**: 1 batch job/day; 1000 products = ~100 API calls (10 ASINs each)
- **Rate limit assumption**: 8,640 TPD (conservative; use Creators API docs when available)

---

## 100 Users

| Metric | Catalog | API-per-User |
|--------|---------|--------------|
| **API calls/day** | ~100 (ingestion only) | ~500 (5 × 100 users) |
| **Within ~8,640 TPD?** | Yes | Yes |
| **Latency per refill** | ~0 ms (DB read) | ~200–500 ms (Amazon round-trip) |
| **Price freshness** | Stale until refresh (e.g. 24h) | Real-time |
| **Failure mode** | Ingestion fails → stale prices | API slow/down → user waits or errors |

**100 users:** Both approaches fit within assumed limits. Catalog uses fewer calls; API-per-user gives fresher prices but slower UX.

---

## 1,000 Users

| Metric | Catalog | API-per-User |
|--------|---------|--------------|
| **API calls/day** | ~100 (ingestion only) | ~5,000 (5 × 1000 users) |
| **Within ~8,640 TPD?** | Yes | Yes (tight) |
| **Latency per refill** | ~0 ms | ~200–500 ms |
| **Peak load** | Ingestion job (batch) | Distributed; 1 TPS cap (if similar to PA-API) |

**1,000 users:** Fits assumed limits, but:

- **1 TPS limit:** 5,000 calls ÷ 86,400 sec ≈ 0.06 req/s average. Bursty traffic can trigger throttling.
- **Headroom:** ~3,640 calls for growth, errors, retries.
- **Risk:** High traffic or retries can exceed limits.

---

## 1,000 Users × 2 Sessions/Day (Heavy Usage)

| Metric | Catalog | API-per-User |
|--------|---------|--------------|
| **API calls/day** | ~100 | ~10,000 |
| **Within ~8,640 TPD?** | Yes | **No** |
| **Result** | No change | Throttling, failed refills, degraded UX |

---

## Summary Table

| Users | Sessions/user/day | Catalog (calls/day) | API-per-User (calls/day) | Within limit? |
|-------|-------------------|---------------------|--------------------------|---------------|
| 100 | 1 | 100 | 500 | Yes |
| 1000 | 1 | 100 | 5,000 | Yes (tight) |
| 1000 | 2 | 100 | 10,000 | No (API-per-user exceeds ~8,640) |
| 2000 | 1 | 100 | 10,000 | No (API-per-user exceeds ~8,640) |

---

## Implementation: Creators API Integration

### Auth (OAuth 2.0 client-credentials)

```text
POST https://api.amazon.com/auth/o2/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=<Credential ID>
&client_secret=<Credential Secret>
```

Response: `access_token` (valid ~1 hour). Cache and reuse until near expiry.

### Product/Offers request

```text
POST https://creators-api.amazon.com/...  (check latest Creators API docs for base URL)
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "itemIds": ["B001ABC123", "B002DEF456", ...],
  "partnerTag": "<your-associate-tag>",
  "marketplace": "www.amazon.com"
}
```

Response: product data including offers (prices, availability). Use the documented response schema for parsing.

### GiftGenius integration points

- **Catalog approach**: Call Creators API in `scripts/ingest-catalog.js` (or a dedicated refresh job); store results in `catalog` table; models read from DB.
- **API-per-user approach**: Call Creators API in `services/refill.js` before enqueuing each batch; pass product data to the queue without persisting.

---

## Recommendation

| Approach | Best for |
|----------|----------|
| **Catalog** | Any scale; predictable usage; low latency; survives API hiccups |
| **API-per-user** | Small scale (&lt;~1,500 users/day at 5 calls each); when real-time price matters more than latency |

Catalog is the better default: it scales with users, keeps refills fast, and stays under Creators API limits. Use API-per-user only if real-time pricing is critical and daily active users stay low.
