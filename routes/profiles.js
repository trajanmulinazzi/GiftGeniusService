/**
 * Profile routes (§10).
 */

import { getDb } from '../db/index.js';
import { normalizeAmazonImageUrl } from '../services/amazon.js';
import { loadAngles } from '../services/taxonomy.js';
import {
  removeInterestFromProfile,
  syncHobbyChanges,
} from '../services/profile-interests.js';
import { copySavedItem, unsaveItem } from '../services/saved-items.js';
import {
  copySavedItemSchema,
  createProfileSchema,
  updateProfileSchema,
  validate,
} from './schemas.js';
import { sendError } from './errors.js';

const NOT_FOUND = 'We couldn’t find that profile.';
const FORBIDDEN = 'You don’t have access to this profile.';

const ALL_ANGLES = loadAngles().map(a => a.name);

export default async function profileRoutes(fastify) {
  // All profile routes require authentication
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /profiles — Create a new recipient profile
  fastify.post('/profiles', async (request, reply) => {
    const { label, hobby_ids, budget_min, budget_max, occasion, relationship } = validate(createProfileSchema, request.body);
    const user_id = request.user.id;
    const sb = getDb();

    const insert = { user_id, label, hobby_ids, budget_min, budget_max };
    if (occasion !== undefined) insert.occasion = occasion;
    if (relationship !== undefined) insert.relationship = relationship;

    const { data: profile, error } = await sb
      .from('profiles')
      .insert(insert)
      .select()
      .single();

    if (error) return sendError(reply, 400, 'We couldn’t create that profile. Please check the details and try again.');

    // Initialize profile weights for all hobby × angle pairs
    const weightRows = [];
    for (const hobbyId of hobby_ids) {
      for (const angle of ALL_ANGLES) {
        weightRows.push({ profile_id: profile.id, hobby_id: hobbyId, angle, weight: 1.0 });
      }
    }
    if (weightRows.length > 0) {
      await sb.from('profile_weights').upsert(weightRows, {
        onConflict: 'profile_id,hobby_id,angle',
        ignoreDuplicates: true,
      });
    }

    return reply.code(201).send(profile);
  });

  // GET /profiles — List profiles for the authenticated user
  fastify.get('/profiles', async (request, reply) => {
    const sb = getDb();
    const user_id = request.user.id;
    const { data, error } = await sb
      .from('profiles')
      .select('*')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false });
    if (error) return sendError(reply, 500, 'We couldn’t load your profiles. Please try again.');
    return { data: data ?? [] };
  });

  // GET /profiles/:id/saved — Saved gift items for a profile
  fastify.get('/profiles/:id/saved', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;

    const { data: profile } = await sb.from('profiles').select('user_id').eq('id', id).single();
    if (!profile) return sendError(reply, 404, NOT_FOUND);
    if (profile.user_id !== request.user.id) return sendError(reply, 403, FORBIDDEN);

    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const offset = parseInt(request.query.offset) || 0;

    const { data, error, count } = await sb
      .from('feed_events')
      .select('id, item_asin, item_snapshot, hobby_id, angle, slot_type, acted_at', { count: 'exact' })
      .eq('profile_id', id)
      .eq('signal', 'save')
      .order('acted_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return sendError(reply, 500, 'We couldn’t load your saved items. Please try again.');

    const hobbyIds = [...new Set((data ?? []).map((row) => row.hobby_id).filter(Boolean))];
    const hobbyNameById = new Map();
    if (hobbyIds.length > 0) {
      const { data: hobbyRows } = await sb
        .from('hobbies')
        .select('id, name')
        .in('id', hobbyIds);
      for (const row of hobbyRows ?? []) {
        hobbyNameById.set(row.id, row.name);
      }
    }

    const items = (data ?? []).map(row => {
      const snap = row.item_snapshot ?? {};
      return {
        feed_event_id: row.id,
        asin: row.item_asin,
        title: snap.title ?? '',
        price: snap.price ?? 0,
        image_url: normalizeAmazonImageUrl(snap.image_url ?? ''),
        product_url: snap.product_url ?? '',
        // Absent on items saved before ratings were snapshotted.
        rating: snap.rating ?? null,
        ratings_total: snap.ratings_total ?? null,
        slot_type: row.slot_type,
        hobby_id: row.hobby_id,
        hobby_name: row.hobby_id ? (hobbyNameById.get(row.hobby_id) ?? null) : null,
        // Items saved before relevance checks existed read as unverified.
        hobby_verified: snap.hobby_verified === true,
        angle: row.angle,
        saved_at: row.acted_at,
      };
    });

    return { items, count: items.length, total: count ?? 0, limit, offset };
  });

  // POST /profiles/:id/saved/:feed_event_id/copy — Copy a bookmark onto another profile
  fastify.post('/profiles/:id/saved/:feed_event_id/copy', async (request, reply) => {
    const { id, feed_event_id } = request.params;
    const { target_profile_id } = validate(copySavedItemSchema, request.body);

    try {
      const result = await copySavedItem({
        sourceProfileId: id,
        feedEventId: feed_event_id,
        targetProfileId: target_profile_id,
        userId: request.user.id,
      });
      return result;
    } catch (err) {
      if (err.code === 'SAME_PROFILE') {
        return sendError(reply, 400, err.message);
      }
      if (err.code === 'NOT_FOUND') {
        return sendError(reply, 404, err.message);
      }
      if (err.code === 'FORBIDDEN') {
        return sendError(reply, 403, err.message);
      }
      request.log.error(err);
      return sendError(reply, 500, 'We couldn’t copy that saved item. Please try again.');
    }
  });

  // DELETE /profiles/:id/saved/:feed_event_id — Remove a bookmark from this profile
  fastify.delete('/profiles/:id/saved/:feed_event_id', async (request, reply) => {
    const { id, feed_event_id } = request.params;

    try {
      const result = await unsaveItem({
        profileId: id,
        feedEventId: feed_event_id,
        userId: request.user.id,
      });
      return result;
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        return sendError(reply, 404, err.message);
      }
      if (err.code === 'FORBIDDEN') {
        return sendError(reply, 403, err.message);
      }
      request.log.error(err);
      return sendError(reply, 500, 'We couldn’t remove that saved item. Please try again.');
    }
  });

  // GET /profiles/:id — Get profile with current weights summary
  fastify.get('/profiles/:id', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;

    const { data: profile, error } = await sb
      .from('profiles').select('*').eq('id', id).single();
    if (error || !profile) return sendError(reply, 404, NOT_FOUND);
    if (profile.user_id !== request.user.id) return sendError(reply, 403, FORBIDDEN);

    const { data: weightsData } = await sb
      .from('profile_weights')
      .select('hobby_id, angle, weight, cooldown_until')
      .eq('profile_id', id);

    let hobbies = [];
    if (profile.hobby_ids?.length > 0) {
      const { data: hobbyRows } = await sb
        .from('hobbies').select('id, name, slug').in('id', profile.hobby_ids);
      hobbies = hobbyRows ?? [];
    }

    return { ...profile, hobbies, weights: weightsData ?? [] };
  });

  // DELETE /profiles/:id/interests/:hobby_id — Remove one interest from a profile
  fastify.delete('/profiles/:id/interests/:hobby_id', async (request, reply) => {
    const { id, hobby_id } = request.params;
    const sb = getDb();

    const { data: existing } = await sb
      .from('profiles')
      .select('user_id')
      .eq('id', id)
      .single();
    if (!existing) return sendError(reply, 404, NOT_FOUND);
    if (existing.user_id !== request.user.id) return sendError(reply, 403, FORBIDDEN);

    try {
      const result = await removeInterestFromProfile(id, hobby_id);
      return result;
    } catch (err) {
      if (err.code === 'LAST_INTEREST') {
        return sendError(reply, 400, err.message);
      }
      if (err.code === 'HOBBY_NOT_ON_PROFILE') {
        return sendError(reply, 404, err.message);
      }
      if (err.code === 'NOT_FOUND') {
        return sendError(reply, 404, NOT_FOUND);
      }
      request.log.error(err);
      return sendError(reply, 500, 'We couldn’t remove that interest. Please try again.');
    }
  });

  // PATCH /profiles/:id — Update hobbies or budget
  fastify.patch('/profiles/:id', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;

    const { data: existing } = await sb
      .from('profiles')
      .select('user_id, hobby_ids')
      .eq('id', id)
      .single();
    if (!existing) return sendError(reply, 404, NOT_FOUND);
    if (existing.user_id !== request.user.id) return sendError(reply, 403, FORBIDDEN);

    const { hobby_ids, budget_min, budget_max, label, occasion, relationship } = validate(updateProfileSchema, request.body);

    const updates = { updated_at: new Date().toISOString() };
    if (hobby_ids !== undefined) updates.hobby_ids = hobby_ids;
    if (budget_min !== undefined) updates.budget_min = budget_min;
    if (budget_max !== undefined) updates.budget_max = budget_max;
    if (label !== undefined) updates.label = label;
    if (occasion !== undefined) updates.occasion = occasion;
    if (relationship !== undefined) updates.relationship = relationship;

    try {
      if (hobby_ids !== undefined) {
        await syncHobbyChanges(id, existing.hobby_ids ?? [], hobby_ids);
      }

      await sb.from('profiles').update(updates).eq('id', id);
    } catch (err) {
      request.log.error(err);
      return sendError(reply, 500, 'We couldn’t update this profile. Please try again.');
    }

    const { data: updated } = await sb.from('profiles').select('*').eq('id', id).single();
    return updated;
  });

  // DELETE /profiles/:id — Permanently delete a recipient profile and its data
  fastify.delete('/profiles/:id', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;

    const { data: existing } = await sb
      .from('profiles')
      .select('user_id')
      .eq('id', id)
      .single();
    if (!existing) return sendError(reply, 404, NOT_FOUND);
    if (existing.user_id !== request.user.id) return sendError(reply, 403, FORBIDDEN);

    try {
      // feed_events.profile_id is not ON DELETE CASCADE, so clear it first;
      // profile_weights, dislike_suppressions, and sessions cascade on their own.
      await sb.from('feed_events').delete().eq('profile_id', id);
      const { error } = await sb.from('profiles').delete().eq('id', id);
      if (error) throw error;
    } catch (err) {
      request.log.error(err);
      return sendError(reply, 500, 'We couldn’t delete this profile. Please try again.');
    }

    return reply.code(200).send({ ok: true, deleted_id: id });
  });
}
