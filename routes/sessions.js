/**
 * Session routes (§10).
 */

import { getDb } from '../db/index.js';
import { createSessionSchema, validate } from './schemas.js';

export default async function sessionRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /sessions — Start a new session
  fastify.post('/sessions', async (request, reply) => {
    const { profile_id, occasion } = validate(createSessionSchema, request.body);
    const sb = getDb();

    // Verify user owns the profile
    const { data: profile } = await sb.from('profiles').select('user_id').eq('id', profile_id).single();
    if (!profile) return reply.code(404).send({ error: 'Profile not found' });
    if (profile.user_id !== request.user.id) return reply.code(403).send({ error: 'Forbidden' });

    const { data, error } = await sb
      .from('sessions')
      .insert({ profile_id, occasion })
      .select()
      .single();

    if (error) return reply.code(400).send({ error: error.message });
    return reply.code(201).send(data);
  });

  // PATCH /sessions/:id/end — End session
  fastify.patch('/sessions/:id/end', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;

    // Verify ownership via profile
    const { data: session } = await sb.from('sessions').select('profile_id').eq('id', id).single();
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const { data: profile } = await sb.from('profiles').select('user_id').eq('id', session.profile_id).single();
    if (!profile || profile.user_id !== request.user.id) return reply.code(403).send({ error: 'Forbidden' });

    const { data, error } = await sb
      .from('sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return reply.code(500).send({ error: error.message });
    return data;
  });

  // GET /sessions/:id — Get session details
  fastify.get('/sessions/:id', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;

    const { data, error } = await sb
      .from('sessions').select('*, profiles!inner(user_id)').eq('id', id).single();
    if (error || !data) return reply.code(404).send({ error: 'Session not found' });
    if (data.profiles.user_id !== request.user.id) return reply.code(403).send({ error: 'Forbidden' });

    const { profiles: _, ...session } = data;
    return session;
  });
}
