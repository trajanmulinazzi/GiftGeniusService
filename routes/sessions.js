/**
 * Session routes (§10).
 */

import { getDb } from '../db/index.js';
import { createSessionSchema, validate } from './schemas.js';
import { prefetchFeedCache } from '../services/feed.js';
import { prepareProfileExpansions } from '../services/precompute.js';
import { sendError } from './errors.js';

export default async function sessionRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /sessions — Start a new session
  fastify.post('/sessions', async (request, reply) => {
    const { profile_id, occasion } = validate(createSessionSchema, request.body);
    const sb = getDb();

    // Verify user owns the profile
    const { data: profile } = await sb
      .from('profiles').select('user_id, occasion').eq('id', profile_id).single();
    if (!profile) return sendError(reply, 404, 'We couldn’t find that profile.');
    if (profile.user_id !== request.user.id) return sendError(reply, 403, 'You don’t have access to this profile.');

    // Use the supplied occasion, else the profile's saved occasion.
    const effectiveOccasion = occasion ?? profile.occasion ?? 'just_because';

    // Persist an explicitly-chosen occasion back onto the profile so future
    // sessions (e.g. switching feeds) remember it.
    if (occasion && occasion !== profile.occasion) {
      await sb.from('profiles').update({ occasion }).eq('id', profile_id);
    }

    const { data, error } = await sb
      .from('sessions')
      .insert({ profile_id, occasion: effectiveOccasion })
      .select()
      .single();

    if (error) return sendError(reply, 400, 'We couldn’t start a session. Please try again.');

    // Fire-and-forget: compute any missing expansions for this profile (lazy,
    // on first use), then warm the Amazon cache. Both run in the background so
    // the response is immediate; the app polls the feed while `preparing`.
    setImmediate(() => {
      prepareProfileExpansions(profile_id, effectiveOccasion)
        .catch(err => console.error('[Session] Expansion prep error:', err.message))
        .finally(() => prefetchFeedCache(profile_id, effectiveOccasion));
    });

    return reply.code(201).send(data);
  });

  // PATCH /sessions/:id/end — End session
  fastify.patch('/sessions/:id/end', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;

    // Verify ownership via profile
    const { data: session } = await sb.from('sessions').select('profile_id').eq('id', id).single();
    if (!session) return sendError(reply, 404, 'We couldn’t find that session.');
    const { data: profile } = await sb.from('profiles').select('user_id').eq('id', session.profile_id).single();
    if (!profile || profile.user_id !== request.user.id) return sendError(reply, 403, 'You don’t have access to this session.');

    const { data, error } = await sb
      .from('sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) return sendError(reply, 500, 'We couldn’t end the session. Please try again.');
    return data;
  });

  // GET /sessions/:id — Get session details
  fastify.get('/sessions/:id', async (request, reply) => {
    const sb = getDb();
    const { id } = request.params;

    const { data, error } = await sb
      .from('sessions').select('*, profiles!inner(user_id)').eq('id', id).single();
    if (error || !data) return sendError(reply, 404, 'We couldn’t find that session.');
    if (data.profiles.user_id !== request.user.id) return sendError(reply, 403, 'You don’t have access to this session.');

    const { profiles: _, ...session } = data;
    return session;
  });
}
