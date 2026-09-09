/**
 * Authenticated hobby catalog routes.
 */

import { getDb } from '../db/index.js';
import { loadHobbies } from '../services/taxonomy.js';

export default async function hobbyRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /hobbies — List hobbies for profile creation (read-only).
  // Filtered to the current taxonomy file so retired/merged names stay out of
  // the picker; old rows remain in the table for existing profiles.
  fastify.get('/hobbies', async (request) => {
    const sb = getDb();
    const allowed = new Set(loadHobbies());
    const { data } = await sb
      .from('hobbies')
      .select('id, name, slug')
      .order('name')
      .limit(500);
    const rows = (data ?? []).filter((h) => allowed.has(h.name));
    return { data: rows, total: rows.length, limit: rows.length, offset: 0 };
  });
}
