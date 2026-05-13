/**
 * Feed routes (§10).
 */

import { generateFeed } from '../services/feed.js';
import { processSignal } from '../services/signal.js';
import { getDb } from '../db/index.js';

export default async function feedRoutes(fastify) {
  // GET /feed/:session_id — Get next batch of feed items
  fastify.get('/feed/:session_id', async (request, reply) => {
    const { session_id } = request.params;
    const batch = parseInt(request.query.batch) || 10;
    const sb = getDb();

    const { data: session, error } = await sb
      .from('sessions').select('*').eq('id', session_id).single();
    if (error || !session) return reply.code(404).send({ error: 'Session not found' });

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
    const { feed_event_id, signal } = request.body;

    if (!['skip', 'save', 'shop_now', 'dislike'].includes(signal)) {
      return reply.code(400).send({ error: 'Invalid signal type' });
    }

    try {
      const result = await processSignal(feed_event_id, signal);
      return result;
    } catch (err) {
      console.error('[Feed] Signal error:', err);
      return reply.code(500).send({ error: err.message });
    }
  });
}
