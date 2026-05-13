/**
 * Session routes (§10).
 */

import { getDb } from '../db/index.js';

export default async function sessionRoutes(fastify) {
  // POST /sessions — Start a new session
  fastify.post('/sessions', async (request, reply) => {
    const { profile_id, occasion } = request.body;
    const sb = getDb();

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

    const { data, error } = await sb
      .from('sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return reply.code(404).send({ error: error.message });
    return data;
  });

  // GET /sessions/:id — Get session details
  fastify.get('/sessions/:id', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;

    const { data, error } = await sb
      .from('sessions').select('*').eq('id', id).single();
    if (error) return reply.code(404).send({ error: 'Session not found' });
    return data;
  });
}
