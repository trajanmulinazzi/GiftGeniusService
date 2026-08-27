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
 * Undo a previously recorded signal on a feed event (§8.2, inverse).
 * Reverses the signal's side effects as closely as possible and clears the
 * signal so the item is treated as un-acted again:
 *   - dislike  → lift the item + cluster suppression, reset the cluster weight
 *                to neutral (1.0) and clear its cooldown.
 *   - save     → undo the +0.3 boost.
 *   - shop_now → undo the +0.2 boost (cooldown is left to expire naturally).
 *   - skip     → undo the -0.1 penalty.
 * No-op (returns ok) when the event carries no signal.
 */
export async function clearSignal(feedEventId) {
  const sb = getDb();

  const { data: event, error } = await sb
    .from('feed_events')
    .select('*')
    .eq('id', feedEventId)
    .single();

  if (error || !event) throw new Error('Feed event not found');

  const { profile_id, item_asin, hobby_id, angle, signal } = event;

  // Nothing to undo.
  if (!signal) return { ok: true };

  // Item-level dislike suppression is independent of the cluster.
  if (signal === 'dislike') {
    await sb
      .from('dislike_suppressions')
      .delete()
      .eq('profile_id', profile_id)
      .eq('suppression_type', 'item')
      .eq('item_asin', item_asin);
  }

  // Reverse cluster-level effects only when the item belongs to a cluster.
  if (hobby_id && angle) {
    switch (signal) {
      case 'dislike':
        await sb.rpc('set_weight', {
          p_profile_id: profile_id, p_hobby_id: hobby_id, p_angle: angle,
          p_weight: 1.0,
        });
        // set_weight leaves cooldown_until untouched; dislike never set one, so
        // the cluster is back to neutral. Lift the cluster suppression too.
        await sb
          .from('dislike_suppressions')
          .delete()
          .eq('profile_id', profile_id)
          .eq('suppression_type', 'cluster')
          .eq('hobby_id', hobby_id)
          .eq('angle', angle);
        break;

      case 'save':
        await sb.rpc('adjust_weight', {
          p_profile_id: profile_id, p_hobby_id: hobby_id, p_angle: angle,
          p_delta: -0.3, p_floor: 0.1, p_ceiling: 3.0,
        });
        break;

      case 'shop_now':
        await sb.rpc('adjust_weight', {
          p_profile_id: profile_id, p_hobby_id: hobby_id, p_angle: angle,
          p_delta: -0.2, p_floor: 0.1, p_ceiling: 3.0,
        });
        break;

      case 'skip':
        await sb.rpc('adjust_weight', {
          p_profile_id: profile_id, p_hobby_id: hobby_id, p_angle: angle,
          p_delta: 0.1, p_floor: 0.1, p_ceiling: 3.0,
        });
        break;
    }
  }

  await sb
    .from('feed_events')
    .update({ signal: null, acted_at: null })
    .eq('id', feedEventId);

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
