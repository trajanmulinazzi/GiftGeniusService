/**
 * Feed Generation Engine (§7).
 * Core runtime system — generates ranked, diverse feed batches.
 */

import { getDb } from '../db/index.js';
import { getItemsForSearchTerm, resolveBudgetBuckets } from './amazon.js';
import { loadAngles } from './taxonomy.js';
import { expandCrossHobby } from './claude.js';

const ALL_ANGLES = loadAngles().map(a => a.name);

// ── Feed Slot Pattern (§7.1) ──────────────────────────────
const SLOT_PATTERN = [
  'interest', 'interest', 'adjacent', 'interest', 'wildcard',
  'interest', 'occasion', 'interest', 'adjacent', 'interest',
];

const MAX_CONSECUTIVE_SAME_CLUSTER = 2;

/**
 * Generate a batch of feed items for a session (§7.2).
 */
export async function generateFeed(sessionId, profileId, batchSize = 10) {
  const sb = getDb();

  // 1. Load profile
  const { data: profile, error: profileErr } = await sb
    .from('profiles').select('*').eq('id', profileId).single();
  if (profileErr || !profile) throw new Error('Profile not found');

  // 2. Load profile weights
  const { data: weightsRows } = await sb
    .from('profile_weights').select('*').eq('profile_id', profileId);
  const weights = {};
  for (const w of (weightsRows ?? [])) {
    weights[`${w.hobby_id}:${w.angle}`] = w;
  }

  // 3. Load session occasion
  const { data: session } = await sb
    .from('sessions').select('occasion').eq('id', sessionId).single();
  const occasion = session?.occasion ?? 'just_because';

  // 4. Load dislike suppressions
  const { data: suppressions } = await sb
    .from('dislike_suppressions').select('*').eq('profile_id', profileId);
  const suppressedAsins = new Set();
  const suppressedClusters = new Set();
  for (const s of (suppressions ?? [])) {
    if (s.suppression_type === 'item') suppressedAsins.add(s.item_asin);
    if (s.suppression_type === 'cluster') suppressedClusters.add(`${s.hobby_id}:${s.angle}`);
  }

  // 5. Load recent feed events for recycling rules (§12) and recency scoring (§7.3)
  const { data: recentEvents } = await sb
    .from('feed_events')
    .select('item_asin, signal, served_at')
    .eq('profile_id', profileId)
    .order('served_at', { ascending: false })
    .limit(500);

  // Build exclusion set per §12 recycling rules:
  //   - save/shop_now: permanently excluded (user acted)
  //   - dislike: permanently excluded (handled by dislike_suppressions, but also here)
  //   - skip: excluded for 30 days
  //   - null (just served, no action yet): excluded (still in current feed)
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const recentlyServed = new Set();
  const asinLastSeen = {};

  for (const e of (recentEvents ?? [])) {
    // Recency map for scoring
    if (!asinLastSeen[e.item_asin]) {
      asinLastSeen[e.item_asin] = (now - new Date(e.served_at).getTime()) / (1000 * 60 * 60 * 24);
    }

    // Recycling exclusion
    if (e.signal === 'save' || e.signal === 'shop_now' || e.signal === 'dislike') {
      recentlyServed.add(e.item_asin); // permanent
    } else if (e.signal === 'skip') {
      if (now - new Date(e.served_at).getTime() < THIRTY_DAYS_MS) {
        recentlyServed.add(e.item_asin); // 30-day window
      }
    } else {
      // null signal — currently in feed, not yet acted on
      recentlyServed.add(e.item_asin);
    }
  }

  // 6. Resolve budget buckets
  const budgetBuckets = resolveBudgetBuckets(profile.budget_min, profile.budget_max);

  // 7. Build item pool — collect all lookups, then fetch in parallel
  const itemPool = [];
  const hobbyIds = profile.hobby_ids ?? [];
  const fetchQueue = []; // { term, bucket, meta }

  // Fetch hobby names
  let hobbyNames = [];
  if (hobbyIds.length > 0) {
    const { data: hobbyRows } = await sb
      .from('hobbies').select('id, name').in('id', hobbyIds);
    hobbyNames = hobbyRows ?? [];
  }

  // Hobby × Angle — gather search terms from DB
  for (const hobbyId of hobbyIds) {
    for (const angle of ALL_ANGLES) {
      const { data: exp } = await sb
        .from('hobby_angle_expansions')
        .select('search_terms')
        .eq('hobby_id', hobbyId)
        .eq('angle', angle)
        .maybeSingle();
      if (!exp) continue;

      const termsToUse = exp.search_terms.slice(0, 3);
      for (const bucket of budgetBuckets) {
        for (const term of termsToUse) {
          fetchQueue.push({
            term, bucket,
            meta: { hobby_id: hobbyId, angle, slot_type: angle === 'wildcard' ? 'wildcard' : 'interest' },
          });
        }
      }
    }
  }

  // Cross-hobby items (adjacent)
  if (hobbyIds.length >= 2) {
    const sortedSlugs = hobbyNames.map(h => h.name).sort().join('_');
    const comboKey = `cross_hobby:${sortedSlugs}`;

    const { data: crossRow } = await sb
      .from('cross_hobby_expansions')
      .select('search_terms')
      .eq('combo_key', comboKey)
      .maybeSingle();

    let crossTerms = crossRow?.search_terms ?? null;
    if (!crossTerms) {
      try {
        crossTerms = await expandCrossHobby(hobbyNames.map(h => h.name));
        await sb.from('cross_hobby_expansions').upsert({
          combo_key: comboKey,
          search_terms: crossTerms,
          computed_at: new Date().toISOString(),
        }, { onConflict: 'combo_key' });
      } catch (err) {
        console.error('[Feed] Cross-hobby expansion error:', err.message);
        crossTerms = [];
      }
    }

    for (const bucket of budgetBuckets) {
      for (const term of (crossTerms ?? []).slice(0, 3)) {
        fetchQueue.push({
          term, bucket,
          meta: { hobby_id: null, angle: null, slot_type: 'adjacent' },
        });
      }
    }
  }

  // Occasion items — gather terms from DB
  for (const bucket of budgetBuckets) {
    const { data: occRow } = await sb
      .from('occasion_search_terms')
      .select('search_terms')
      .eq('occasion', occasion)
      .eq('budget_bucket', bucket)
      .maybeSingle();

    if (occRow) {
      for (const term of occRow.search_terms.slice(0, 3)) {
        fetchQueue.push({
          term, bucket,
          meta: { hobby_id: null, angle: null, slot_type: 'occasion' },
        });
      }
    }
  }

  // Fetch all items in parallel — cache hits resolve instantly,
  // cache misses go through the Amazon throttle sequentially
  const fetchResults = await Promise.all(
    fetchQueue.map(async ({ term, bucket, meta }) => {
      const items = await getItemsForSearchTerm(term, bucket);
      return items.map(item => ({ ...item, ...meta, source_term: term }));
    })
  );
  for (const items of fetchResults) {
    itemPool.push(...items);
  }

  // 8. Filter item pool
  const seen = new Set();
  const filtered = itemPool.filter(item => {
    if (seen.has(item.asin)) return false;
    seen.add(item.asin);
    if (recentlyServed.has(item.asin)) return false;
    if (suppressedAsins.has(item.asin)) return false;
    if (item.hobby_id && item.angle && suppressedClusters.has(`${item.hobby_id}:${item.angle}`)) return false;
    if (item.price > 0 && (item.price < profile.budget_min || item.price > profile.budget_max)) return false;
    return true;
  });

  // 10. Fill slots from pattern
  const feed = [];
  const usedAsins = new Set();
  const lastClusters = [];

  for (let i = 0; i < batchSize; i++) {
    const slotType = SLOT_PATTERN[i % SLOT_PATTERN.length];

    // Re-score each iteration so diversity bonus reflects picks so far
    let candidates = filtered
      .filter(item => {
        if (usedAsins.has(item.asin)) return false;
        return item.slot_type === slotType;
      })
      .map(item => ({ ...item, score: scoreItem(item, weights, asinLastSeen, lastClusters) }));

    // Fall back to any available if no candidates for this slot
    if (candidates.length === 0) {
      candidates = filtered
        .filter(item => !usedAsins.has(item.asin))
        .map(item => ({ ...item, score: scoreItem(item, weights, asinLastSeen, lastClusters) }));
    }
    if (candidates.length === 0) break;

    candidates.sort((a, b) => b.score - a.score);

    // Enforce consecutive same-cluster cap
    let picked = null;
    for (const c of candidates) {
      const clusterKey = c.hobby_id && c.angle ? `${c.hobby_id}:${c.angle}` : null;
      if (clusterKey) {
        const recentSame = lastClusters.slice(-MAX_CONSECUTIVE_SAME_CLUSTER).filter(k => k === clusterKey).length;
        if (recentSame >= MAX_CONSECUTIVE_SAME_CLUSTER) continue;
      }
      picked = c;
      break;
    }
    if (!picked) picked = candidates[0];
    if (!picked) break;

    feed.push(picked);
    usedAsins.add(picked.asin);
    lastClusters.push(picked.hobby_id && picked.angle ? `${picked.hobby_id}:${picked.angle}` : 'none');
  }

  // 11. Insert feed_events
  if (feed.length > 0) {
    const rows = feed.map(item => ({
      session_id: sessionId,
      profile_id: profileId,
      item_asin: item.asin,
      item_snapshot: { title: item.title, price: item.price, image_url: item.image_url, product_url: item.product_url },
      hobby_id: item.hobby_id ?? null,
      angle: item.angle ?? null,
      slot_type: item.slot_type,
    }));

    const { data: inserted } = await sb.from('feed_events').insert(rows).select('id, item_asin');
    const eventMap = {};
    for (const e of (inserted ?? [])) eventMap[e.item_asin] = e.id;

    // 12. Return feed with event IDs
    return feed.map(item => ({
      feed_event_id: eventMap[item.asin],
      asin: item.asin,
      title: item.title,
      price: item.price,
      image_url: item.image_url,
      product_url: item.product_url,
      category: item.category,
      slot_type: item.slot_type,
      hobby_id: item.hobby_id,
      angle: item.angle,
      score: item.score,
    }));
  }

  return [];
}

/**
 * Score an item (§7.3).
 * score = baseWeight * cooldownMultiplier * recencyBonus * diversityBonus + noise
 */
function scoreItem(item, weights, asinLastSeen, recentClusters) {
  const clusterKey = item.hobby_id && item.angle ? `${item.hobby_id}:${item.angle}` : null;
  const w = clusterKey ? weights[clusterKey] : null;
  const baseWeight = w?.weight ?? 1.0;

  // Cooldown: heavily deprioritize clusters in shop_now cooldown
  let cooldownMultiplier = 1.0;
  if (w?.cooldown_until && new Date(w.cooldown_until) > new Date()) {
    cooldownMultiplier = 0.2;
  }

  // Recency bonus: items not seen in a long time get a boost (§7.3)
  const daysSinceSeen = asinLastSeen[item.asin] ?? 30;
  const recencyBonus = Math.min(daysSinceSeen / 30, 1.5);

  // Diversity bonus: boost items from a different cluster than recent picks (§7.3)
  const last2 = recentClusters.slice(-2);
  const diversityBonus = (clusterKey && last2.includes(clusterKey)) ? 0.5 : 1.2;

  return baseWeight * cooldownMultiplier * recencyBonus * diversityBonus + (Math.random() * 0.1);
}
