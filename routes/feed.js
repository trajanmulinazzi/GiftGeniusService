/**
 * Feed routes (§10).
 */

import { generateFeed } from '../services/feed.js';
import { processSignal, clearSignal } from '../services/signal.js';
import { isProfileExpansionReady } from '../services/precompute.js';
import { getDb } from '../db/index.js';
import { signalSchema, validate } from './schemas.js';
import { sendError } from './errors.js';
import {
  DIAG_ENABLED,
  reportTrace,
  runWithDiag,
  span,
  summarizeTrace,
} from '../services/diag.js';

export default async function feedRoutes(fastify) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /feed/:session_id — Get next batch of feed items
  fastify.get('/feed/:session_id', async (request, reply) => {
    const { session_id } = request.params;
    const batch = Math.min(Math.max(parseInt(request.query.batch) || 10, 1), 30);
    const sb = getDb();

    const { data: session, error } = await sb
      .from('sessions').select('*, profiles!inner(user_id)').eq('id', session_id).single();
    if (error || !session) return sendError(reply, 404, 'This feed session no longer exists. Pull to refresh to start a new one.');
    if (session.profiles.user_id !== request.user.id) return sendError(reply, 403, 'You don’t have access to this feed.');

    try {
      const { result, trace } = await runWithDiag(
        'feed.generate',
        { session_id, profile_id: session.profile_id, batch },
        async () => {
          const items = await generateFeed(session_id, session.profile_id, batch, {
            log: request.log,
          });
          // Empty is a valid (not error) state — the profile's expansions may still
          // be computing. `preparing` tells the app to keep polling vs. give up.
          const preparing = items.length === 0
            ? !(await span(
              'isProfileExpansionReady',
              () => isProfileExpansionReady(session.profile_id, session.occasion),
            ))
            : false;
          return { items, preparing };
        },
      );

      reportTrace(trace);
      return {
        items: result.items,
        count: result.items.length,
        preparing: result.preparing,
        // Lets the client log server-side timings next to its own, so network
        // time is visible as the gap between the two.
        ...(DIAG_ENABLED ? { diag: summarizeTrace(trace) } : {}),
      };
    } catch (err) {
      request.log.error({ err }, '[Feed] Generation error');
      reportTrace(err?.diagTrace);
      return sendError(
        reply,
        503,
        'We’re still building recommendations for this profile. Please pull to refresh in a moment.',
        'FEED_UNAVAILABLE',
      );
    }
  });

  // POST /feed/signal — Record a signal
  fastify.post('/feed/signal', async (request, reply) => {
    const { feed_event_id, signal } = validate(signalSchema, request.body);

    // Verify ownership via feed_event -> profile -> user
    const sb = getDb();
    const { data: event } = await sb.from('feed_events').select('profile_id').eq('id', feed_event_id).single();
    if (!event) return sendError(reply, 404, 'We couldn’t find that item.');
    const { data: profile } = await sb.from('profiles').select('user_id').eq('id', event.profile_id).single();
    if (!profile || profile.user_id !== request.user.id) return sendError(reply, 403, 'You don’t have access to this item.');

    try {
      const result = await processSignal(feed_event_id, signal);
      return result;
    } catch (err) {
      console.error('[Feed] Signal error:', err);
      return sendError(reply, 500, 'We couldn’t save your response. Please try again.');
    }
  });

  // DELETE /feed/signal/:feed_event_id — Undo a previously recorded signal
  // (e.g. un-dislike / un-save from the feed). Reverses the signal's side
  // effects and clears it so the item reads as un-acted again.
  fastify.delete('/feed/signal/:feed_event_id', async (request, reply) => {
    const { feed_event_id } = request.params;

    // Verify ownership via feed_event -> profile -> user (same as POST).
    const sb = getDb();
    const { data: event } = await sb.from('feed_events').select('profile_id').eq('id', feed_event_id).single();
    if (!event) return sendError(reply, 404, 'We couldn’t find that item.');
    const { data: profile } = await sb.from('profiles').select('user_id').eq('id', event.profile_id).single();
    if (!profile || profile.user_id !== request.user.id) return sendError(reply, 403, 'You don’t have access to this item.');

    try {
      const result = await clearSignal(feed_event_id);
      return result;
    } catch (err) {
      console.error('[Feed] Undo signal error:', err);
      return sendError(reply, 500, 'We couldn’t undo that. Please try again.');
    }
  });
}
