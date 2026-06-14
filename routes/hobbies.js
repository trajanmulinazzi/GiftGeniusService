/**
 * Authenticated hobby catalog routes.
 */

import { getDb } from '../db/index.js';

export default async function hobbyRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /hobbies — List hobbies for profile creation (read-only)
  fastify.get('/hobbies', async (request) => {
    const sb = getDb();
    const limit = Math.min(parseInt(request.query.limit) || 100, 200);
    const offset = parseInt(request.query.offset) || 0;
    const { data, count } = await sb
      .from('hobbies')
      .select('id, name, slug', { count: 'exact' })
      .order('name')
      .range(offset, offset + limit - 1);
    return { data: data ?? [], total: count ?? 0, limit, offset };
  });
}
