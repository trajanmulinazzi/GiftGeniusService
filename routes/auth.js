/**
 * Auth routes — JWT token issuance.
 */

import { getDb } from '../db/index.js';
import { authTokenSchema, validate } from './schemas.js';

export default async function authRoutes(fastify) {
  // POST /auth/token — Issue a JWT for a user (dev/test convenience)
  fastify.post('/auth/token', async (request, reply) => {
    const { user_id } = validate(authTokenSchema, request.body);

    const sb = getDb();
    const { data: user, error } = await sb
      .from('users').select('id, name, email').eq('id', user_id).single();
    if (error || !user) return reply.code(404).send({ error: 'User not found' });

    const token = fastify.jwt.sign(
      { id: user.id, email: user.email },
      { expiresIn: '7d' },
    );

    return { token, user };
  });
}
