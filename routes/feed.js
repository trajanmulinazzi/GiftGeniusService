/**
 * Feed routes (§10).
 */

import { generateFeed } from '../services/feed.js';
import { processSignal } from '../services/signal.js';
import { getDb } from '../db/index.js';
import { signalSchema, validate } from './schemas.js';

export default async function feedRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /feed/:session_id — Get next batch of feed items
  fastify.get('/feed/:session_id', async (request, reply) => {
    const { session_id } = request.params;
    const batch = parseInt(request.query.batch) || 10;
    const sb = getDb();

    const { data: session, error } = await sb
      .from('sessions').select('*, profiles!inner(user_id)').eq('id', session_id).single();
    if (error || !session) return reply.code(404).send({ error: 'Session not found' });
    if (session.profiles.user_id !== request.user.id) return reply.code(403).send({ error: 'Forbidden' });

    try {
      const items = await generateFeed(session_id, session.profile_id, batch);
      return { items, count: items.length };
    } catch (err) {
      console.error('[Feed] Generation error:', err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /feed/signal — Record a signal
  fastify.post('/feed/signal', async (request, reply) => {
    const { feed_event_id, signal } = validate(signalSchema, request.body);

    // Verify ownership via feed_event -> profile -> user
    const sb = getDb();
    const { data: event } = await sb.from('feed_events').select('profile_id').eq('id', feed_event_id).single();
    if (!event) return reply.code(404).send({ error: 'Feed event not found' });
    const { data: profile } = await sb.from('profiles').select('user_id').eq('id', event.profile_id).single();
    if (!profile || profile.user_id !== request.user.id) return reply.code(403).send({ error: 'Forbidden' });

    try {
      const result = await processSignal(feed_event_id, signal);
      return result;
    } catch (err) {
      console.error('[Feed] Signal error:', err);
      return reply.code(500).send({ error: err.message });
    }
  });
}
