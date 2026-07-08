/**
 * Auth routes.
 *
 * The app authenticates with Clerk and sends Clerk's session JWT as a Bearer
 * token. The backend verifies it (see services/clerk-auth.js) and maps it to a
 * backend user. These routes let the client confirm/enrich that mapping.
 */

import { updateBackendUserProfile } from '../services/clerk-auth.js';

export default async function authRoutes(fastify) {
  // POST /auth/sync — verify the Clerk token, ensure a backend user exists,
  // and enrich its display name/email from the client. Idempotent.
  fastify.post(
    '/auth/sync',
    { onRequest: [fastify.authenticate] },
    async (request) => {
      const { name, email } = request.body ?? {};
      if (name || email) {
        await updateBackendUserProfile(request.user.clerkId, { name, email });
      }
      return {
        user: {
          id: request.user.id,
          name: name || request.user.name,
          email: email || request.user.email,
        },
      };
    }
  );

  // GET /auth/me — return the authenticated backend user.
  fastify.get(
    '/auth/me',
    { onRequest: [fastify.authenticate] },
    async (request) => ({
      user: {
        id: request.user.id,
        name: request.user.name,
        email: request.user.email,
      },
    })
  );
}
