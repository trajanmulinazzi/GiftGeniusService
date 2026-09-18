/**
 * Profile interest add/remove — keeps hobby_ids in sync with profile_weights.
 */

import { getDb } from '../db/index.js';
import { loadAngles } from './taxonomy.js';

const ALL_ANGLES = loadAngles().map(a => a.name);

/** Matches the interest picker cap in gift-app `HobbyChipPicker`. */
export const PICKER_MAX_INTERESTS = 8;

/** Weight given to a hobby copied onto a feed that did not already have it. */
export const COPIED_INTEREST_WEIGHT = 0.1;

/** Weight floor applied to all angles when an interest is removed. */
export const REMOVAL_WEIGHT = 0.1;

/** Cooldown window so re-added interests stay deprioritized until it expires. */
export const REMOVAL_COOLDOWN_DAYS = 14;

export async function applyInterestWeightPenalty(profileId, hobbyId) {
  const sb = getDb();
  const { error } = await sb.rpc('suppress_hobby_interest', {
    p_profile_id: profileId,
    p_hobby_id: hobbyId,
    p_weight: REMOVAL_WEIGHT,
    p_cooldown_days: REMOVAL_COOLDOWN_DAYS,
  });
  if (error) {
    throw new Error(`Failed to penalize interest weights: ${error.message}`);
  }
}

export async function resetInterestWeights(profileId, hobbyId) {
  const sb = getDb();
  const weightRows = ALL_ANGLES.map((angle) => ({
    profile_id: profileId,
    hobby_id: hobbyId,
    angle,
    weight: 1.0,
    cooldown_until: null,
  }));
  const { error } = await sb.from('profile_weights').upsert(weightRows, {
    onConflict: 'profile_id,hobby_id,angle',
  });
  if (error) {
    throw new Error(`Failed to reset interest weights: ${error.message}`);
  }
}

/**
 * Add `hobbyId` to a profile at a low weight when a bookmark is copied over.
 * No-op if the hobby is already on the profile or the picker cap is full.
 */
export async function ensureCopiedInterest(profileId, hobbyId, currentIds) {
  const sb = getDb();
  const ids = currentIds ?? [];
  if (ids.includes(hobbyId)) {
    return { added: false, alreadyHad: true };
  }
  if (ids.length >= PICKER_MAX_INTERESTS) {
    return { added: false, alreadyHad: false };
  }

  const weightRows = ALL_ANGLES.map((angle) => ({
    profile_id: profileId,
    hobby_id: hobbyId,
    angle,
    weight: COPIED_INTEREST_WEIGHT,
    cooldown_until: null,
  }));
  const { error: weightErr } = await sb.from('profile_weights').upsert(weightRows, {
    onConflict: 'profile_id,hobby_id,angle',
  });
  if (weightErr) {
    throw new Error(`Failed to seed copied interest weights: ${weightErr.message}`);
  }

  const { error } = await sb
    .from('profiles')
    .update({
      hobby_ids: [...ids, hobbyId],
      updated_at: new Date().toISOString(),
    })
    .eq('id', profileId);
  if (error) {
    throw new Error(`Failed to add copied interest: ${error.message}`);
  }

  return { added: true, alreadyHad: false };
}

/**
 * Apply weight penalties for removed hobbies and reset weights for newly added ones.
 */
export async function syncHobbyChanges(profileId, previousIds, nextIds) {
  const prev = new Set(previousIds ?? []);
  const next = new Set(nextIds ?? []);
  const removed = [...prev].filter((id) => !next.has(id));
  const added = [...next].filter((id) => !prev.has(id));

  for (const hobbyId of removed) {
    await applyInterestWeightPenalty(profileId, hobbyId);
  }
  for (const hobbyId of added) {
    await resetInterestWeights(profileId, hobbyId);
  }

  return { removed, added };
}

/**
 * Remove one interest from a profile and penalize its weights.
 */
export async function removeInterestFromProfile(profileId, hobbyId) {
  const sb = getDb();

  const { data: profile, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', profileId)
    .single();

  if (error || !profile) {
    const err = new Error('Profile not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const currentIds = profile.hobby_ids ?? [];
  if (!currentIds.includes(hobbyId)) {
    const err = new Error('Interest is not on this profile');
    err.code = 'HOBBY_NOT_ON_PROFILE';
    throw err;
  }
  if (currentIds.length <= 1) {
    const err = new Error('Keep at least one interest on this list');
    err.code = 'LAST_INTEREST';
    throw err;
  }

  const nextIds = currentIds.filter((id) => id !== hobbyId);
  const { error: updateError } = await sb
    .from('profiles')
    .update({
      hobby_ids: nextIds,
      updated_at: new Date().toISOString(),
    })
    .eq('id', profileId);

  if (updateError) {
    throw new Error(updateError.message);
  }

  await applyInterestWeightPenalty(profileId, hobbyId);

  const { data: updated } = await sb.from('profiles').select('*').eq('id', profileId).single();
  return { profile: updated, removed_hobby_id: hobbyId };
}
