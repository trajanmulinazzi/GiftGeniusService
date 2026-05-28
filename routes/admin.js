/**
 * Admin routes (§10).
 */

import { getDb } from '../db/index.js';
import { runPrecompute } from '../services/precompute.js';
import { refreshExpiringCache, getDailyApiUsage } from '../services/amazon.js';
import { syncAll, loadAngles, loadBudgetBuckets, loadOccasions } from '../services/taxonomy.js';
import { createUserSchema, addHobbiesSchema, validate } from './schemas.js';

export default async function adminRoutes(fastify) {
  fastify.addHook('onRequest', fastify.adminAuth);

  // POST /admin/taxonomy/sync — Sync taxonomy .txt files into Supabase
  fastify.post('/admin/taxonomy/sync', async (request, reply) => {
    try {
      return await syncAll();
    } catch (err) {
      console.error('[Admin] Taxonomy sync error:', err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /admin/taxonomy — View current taxonomy config
  fastify.get('/admin/taxonomy', async () => ({
    angles: loadAngles(),
    budget_buckets: loadBudgetBuckets(),
    occasions: loadOccasions(),
  }));

  // POST /admin/precompute — Trigger pre-computation pipeline
  fastify.post('/admin/precompute', async (request, reply) => {
    try {
      return await runPrecompute();
    } catch (err) {
      console.error('[Admin] Precompute error:', err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // POST /admin/cache/refresh — Trigger manual cache refresh
  fastify.post('/admin/cache/refresh', async (request, reply) => {
    try {
      return { refreshed: await refreshExpiringCache() };
    } catch (err) {
      console.error('[Admin] Cache refresh error:', err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /admin/api-usage — Get daily Amazon API call count
  fastify.get('/admin/api-usage', async () => getDailyApiUsage());

  // GET /admin/hobbies — List all hobbies
  fastify.get('/admin/hobbies', async (request) => {
    const sb = getDb();
    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const offset = parseInt(request.query.offset) || 0;
    const { data, count } = await sb.from('hobbies').select('*', { count: 'exact' }).order('name').range(offset, offset + limit - 1);
    return { data: data ?? [], total: count ?? 0, limit, offset };
  });

  // POST /admin/hobbies — Add hobbies (bulk)
  fastify.post('/admin/hobbies', async (request, reply) => {
    const { hobbies } = validate(addHobbiesSchema, request.body);
    const sb = getDb();
    const inserted = [];

    for (const h of hobbies) {
      const slug = h.slug ?? h.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
      const { data } = await sb
        .from('hobbies')
        .upsert({ name: h.name, slug }, { onConflict: 'slug', ignoreDuplicates: true })
        .select();
      if (data?.length > 0) inserted.push(data[0]);
    }

    return { inserted: inserted.length, hobbies: inserted };
  });

  // POST /admin/users — Create user
  fastify.post('/admin/users', async (request, reply) => {
    const { name, email } = validate(createUserSchema, request.body);
    const sb = getDb();
    const { data, error } = await sb.from('users').insert({ name, email }).select().single();
    if (error) return reply.code(400).send({ error: error.message });
    return reply.code(201).send(data);
  });

  // GET /admin/users — List users
  fastify.get('/admin/users', async (request) => {
    const sb = getDb();
    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const offset = parseInt(request.query.offset) || 0;
    const { data, count } = await sb.from('users').select('*', { count: 'exact' }).order('name').range(offset, offset + limit - 1);
    return { data: data ?? [], total: count ?? 0, limit, offset };
  });

  // GET /admin/profiles — List all profiles
  fastify.get('/admin/profiles', async (request) => {
    const sb = getDb();
    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const offset = parseInt(request.query.offset) || 0;
    const { data, count } = await sb.from('profiles').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    return { data: data ?? [], total: count ?? 0, limit, offset };
  });

  // GET /admin/sessions — List active sessions
  fastify.get('/admin/sessions', async (request) => {
    const sb = getDb();
    const limit = Math.min(parseInt(request.query.limit) || 50, 200);
    const offset = parseInt(request.query.offset) || 0;
    const { data, count } = await sb.from('sessions').select('*', { count: 'exact' }).is('ended_at', null).order('started_at', { ascending: false }).range(offset, offset + limit - 1);
    return { data: data ?? [], total: count ?? 0, limit, offset };
  });

  // GET /admin/stats — Get system stats
  fastify.get('/admin/stats', async () => {
    const sb = getDb();
    const counts = await Promise.all([
      sb.from('hobbies').select('*', { count: 'exact', head: true }),
      sb.from('hobby_angle_expansions').select('*', { count: 'exact', head: true }),
      sb.from('occasion_search_terms').select('*', { count: 'exact', head: true }),
      sb.from('amazon_cache').select('*', { count: 'exact', head: true }),
      sb.from('profiles').select('*', { count: 'exact', head: true }),
      sb.from('sessions').select('*', { count: 'exact', head: true }),
      sb.from('feed_events').select('*', { count: 'exact', head: true }),
    ]);

    const names = ['hobbies', 'hobby_angle_expansions', 'occasion_search_terms', 'amazon_cache_entries', 'profiles', 'sessions', 'feed_events'];
    const result = {};
    names.forEach((n, i) => { result[n] = counts[i].count ?? 0; });
    return result;
  });
}
