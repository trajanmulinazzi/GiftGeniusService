/**
 * Saved-item helpers — copy bookmarks across profiles and unsave.
 */

import { getDb } from '../db/index.js';

/**
 * Copy a saved feed_event onto another profile owned by the same user.
 * Leaves the source bookmark in place (copy, not move).
 */
export async function copySavedItem({ sourceProfileId, feedEventId, targetProfileId, userId }) {
  const sb = getDb();

  if (sourceProfileId === targetProfileId) {
    const err = new Error('Choose a different feed to copy to.');
    err.code = 'SAME_PROFILE';
    throw err;
  }

  const { data: profiles, error: profilesErr } = await sb
    .from('profiles')
    .select('id, user_id')
    .in('id', [sourceProfileId, targetProfileId]);

  if (profilesErr) throw profilesErr;

  const source = (profiles ?? []).find((p) => p.id === sourceProfileId);
  const target = (profiles ?? []).find((p) => p.id === targetProfileId);

  if (!source || !target) {
    const err = new Error('We couldn’t find that profile.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (source.user_id !== userId || target.user_id !== userId) {
    const err = new Error('You don’t have access to this profile.');
    err.code = 'FORBIDDEN';
    throw err;
  }

  const { data: event, error: eventErr } = await sb
    .from('feed_events')
    .select('id, profile_id, item_asin, item_snapshot, hobby_id, angle, slot_type, signal')
    .eq('id', feedEventId)
    .single();

  if (eventErr || !event) {
    const err = new Error('We couldn’t find that saved item.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (event.profile_id !== sourceProfileId || event.signal !== 'save') {
    const err = new Error('We couldn’t find that saved item.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const { data: existing } = await sb
    .from('feed_events')
    .select('id')
    .eq('profile_id', targetProfileId)
    .eq('item_asin', event.item_asin)
    .eq('signal', 'save')
    .limit(1)
    .maybeSingle();

  if (existing) {
    return { ok: true, already_saved: true, feed_event_id: existing.id };
  }

  const now = new Date().toISOString();
  const { data: inserted, error: insertErr } = await sb
    .from('feed_events')
    .insert({
      session_id: null,
      profile_id: targetProfileId,
      item_asin: event.item_asin,
      item_snapshot: event.item_snapshot,
      hobby_id: event.hobby_id,
      angle: event.angle,
      slot_type: event.slot_type,
      signal: 'save',
      served_at: now,
      acted_at: now,
    })
    .select('id')
    .single();

  if (insertErr) throw insertErr;

  if (event.hobby_id && event.angle) {
    await sb.rpc('adjust_weight', {
      p_profile_id: targetProfileId,
      p_hobby_id: event.hobby_id,
      p_angle: event.angle,
      p_delta: 0.3,
      p_floor: 0.1,
      p_ceiling: 3.0,
    });
  }

  return { ok: true, already_saved: false, feed_event_id: inserted.id };
}

/**
 * Remove a bookmark from a profile (clears the save signal).
 */
export async function unsaveItem({ profileId, feedEventId, userId }) {
  const sb = getDb();

  const { data: profile } = await sb
    .from('profiles')
    .select('id, user_id')
    .eq('id', profileId)
    .single();

  if (!profile) {
    const err = new Error('We couldn’t find that profile.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (profile.user_id !== userId) {
    const err = new Error('You don’t have access to this profile.');
    err.code = 'FORBIDDEN';
    throw err;
  }

  const { data: event } = await sb
    .from('feed_events')
    .select('id, profile_id, signal')
    .eq('id', feedEventId)
    .single();

  if (!event || event.profile_id !== profileId || event.signal !== 'save') {
    const err = new Error('We couldn’t find that saved item.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const { error } = await sb
    .from('feed_events')
    .update({ signal: null, acted_at: null })
    .eq('id', feedEventId);

  if (error) throw error;

  return { ok: true };
}
