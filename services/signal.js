/**
 * Signal Processing (§8).
 * Processes user actions on feed items and updates profile weights via Supabase RPC.
 */

import { getDb } from '../db/index.js';

/**
 * Process a signal on a feed event (§8.2).
 */
export async function processSignal(feedEventId, signal) {
  const sb = getDb();

  // 1. Load feed event
  const { data: event, error } = await sb
    .from('feed_events')
    .select('*')
    .eq('id', feedEventId)
    .single();

  if (error || !event) throw new Error('Feed event not found');

  const { profile_id, item_asin, hobby_id, angle } = event;

  // 2. Update feed event with signal
  await sb.from('feed_events')
    .update({ signal, acted_at: new Date().toISOString() })
    .eq('id', feedEventId);

  // 3. Process signal — skip if no cluster (occasion/adjacent items)
  if (!hobby_id || !angle) return { ok: true };

  switch (signal) {
    case 'skip':
      await sb.rpc('adjust_weight', {
        p_profile_id: profile_id, p_hobby_id: hobby_id, p_angle: angle,
        p_delta: -0.1, p_floor: 0.1, p_ceiling: 3.0,
      });
      break;

    case 'dislike':
      await sb.rpc('set_weight', {
        p_profile_id: profile_id, p_hobby_id: hobby_id, p_angle: angle,
        p_weight: 0.0,
      });
      await sb.from('dislike_suppressions').insert([
        { profile_id, suppression_type: 'cluster', hobby_id, angle },
        { profile_id, suppression_type: 'item', item_asin },
      ]);
      break;

    case 'save':
      await sb.rpc('adjust_weight', {
        p_profile_id: profile_id, p_hobby_id: hobby_id, p_angle: angle,
        p_delta: 0.3, p_floor: 0.1, p_ceiling: 3.0,
      });
      break;

    case 'shop_now':
      await sb.rpc('adjust_weight_with_cooldown', {
        p_profile_id: profile_id, p_hobby_id: hobby_id, p_angle: angle,
        p_delta: 0.2, p_ceiling: 3.0, p_cooldown_days: 7,
      });
      break;
  }

  return { ok: true };
}

/**
 * Weight Decay Job (§11).
 */
export async function applyWeightDecay() {
  const sb = getDb();
  const { data } = await sb.rpc('apply_weight_decay');
  console.log(`[WeightDecay] Updated ${data ?? 0} weights`);
  return data ?? 0;
}
