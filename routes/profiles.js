/**
 * Profile routes (§10).
 */

import { getDb } from '../db/index.js';
import { loadAngles } from '../services/taxonomy.js';

const ALL_ANGLES = loadAngles().map(a => a.name);

export default async function profileRoutes(fastify) {
  // POST /profiles — Create a new recipient profile
  fastify.post('/profiles', async (request, reply) => {
    const { user_id, label, hobby_ids, budget_min, budget_max } = request.body;
    const sb = getDb();

    const { data: profile, error } = await sb
      .from('profiles')
      .insert({ user_id, label, hobby_ids, budget_min, budget_max })
      .select()
      .single();

    if (error) return reply.code(400).send({ error: error.message });

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

  // GET /profiles/:id — Get profile with current weights summary
  fastify.get('/profiles/:id', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;

    const { data: profile, error } = await sb
      .from('profiles').select('*').eq('id', id).single();
    if (error) return reply.code(404).send({ error: 'Profile not found' });

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

  // PATCH /profiles/:id — Update hobbies or budget
  fastify.patch('/profiles/:id', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;
    const { hobby_ids, budget_min, budget_max, label } = request.body;

    const updates = { updated_at: new Date().toISOString() };
    if (hobby_ids !== undefined) updates.hobby_ids = hobby_ids;
    if (budget_min !== undefined) updates.budget_min = budget_min;
    if (budget_max !== undefined) updates.budget_max = budget_max;
    if (label !== undefined) updates.label = label;

    await sb.from('profiles').update(updates).eq('id', id);

    // If hobby_ids changed, initialize new weights
    if (hobby_ids) {
      const weightRows = [];
      for (const hobbyId of hobby_ids) {
        for (const angle of ALL_ANGLES) {
          weightRows.push({ profile_id: id, hobby_id: hobbyId, angle, weight: 1.0 });
        }
      }
      if (weightRows.length > 0) {
        await sb.from('profile_weights').upsert(weightRows, {
          onConflict: 'profile_id,hobby_id,angle',
          ignoreDuplicates: true,
        });
      }
    }

    const { data: updated } = await sb.from('profiles').select('*').eq('id', id).single();
    return updated;
  });
}
