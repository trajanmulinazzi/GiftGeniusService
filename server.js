/**
 * GiftGenius Engine — Fastify API Server.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

import { startJobs } from './services/jobs.js';
import { sendError } from './routes/errors.js';
import {
  verifyClerkToken,
  resolveBackendUser,
  isClerkConfigured,
} from './services/clerk-auth.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import hobbyRoutes from './routes/hobbies.js';
import sessionRoutes from './routes/sessions.js';
import feedRoutes from './routes/feed.js';
import adminRoutes from './routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fastify = Fastify({ logger: true });

// CORS
await fastify.register(fastifyCors, { origin: true });

if (!isClerkConfigured()) {
  fastify.log.warn(
    'Clerk auth is not configured (set CLERK_PUBLISHABLE_KEY). Authenticated routes will reject all requests.'
  );
}

// Auth: verify the Clerk session token and resolve our backend user.
// request.user.id is always our backend UUID.
fastify.decorate('authenticate', async function (request, reply) {
  // Gated dev bypass for local testing / the test console. OFF by default.
  if (process.env.ALLOW_DEV_AUTH === 'true') {
    const devUserId = request.headers['x-dev-user-id'];
    if (devUserId) {
      request.user = { id: devUserId, clerkId: `dev:${devUserId}`, email: null, name: 'Dev User' };
      return;
    }
  }

  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return sendError(reply, 401, 'Sign in to continue.');
  }
  const token = header.slice(7).trim();

  try {
    const payload = await verifyClerkToken(token);
    const user = await resolveBackendUser(payload.sub, {
      email: payload.email,
      name: payload.name,
    });
    request.user = { id: user.id, clerkId: payload.sub, email: user.email, name: user.name };
    request.clerkPayload = payload;
  } catch (err) {
    request.log.warn({ err: err.message }, 'Clerk auth failed');
    return sendError(reply, 401, 'Your session has expired. Please sign in again.');
  }
});

fastify.decorate('adminAuth', async function (req, reply) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    // No admin secret configured — allow in dev
    return;
  }
  const provided = req.headers['x-admin-secret'];
  if (provided !== adminSecret) {
    return sendError(reply, 403, 'Invalid admin credentials');
  }
});

// Global error handler — consistent { error: { code, message } } shape.
fastify.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode || 500;

  // Validation errors from Zod (thrown by our validate() helper).
  if (error.validation) {
    const detail = Array.isArray(error.validation)
      ? error.validation.map((v) => v.message).join('; ')
      : error.message;
    return sendError(reply, 400, detail || 'Some fields are invalid.', 'VALIDATION_ERROR');
  }

  // Fastify built-in validation errors.
  if (error.code === 'FST_ERR_VALIDATION') {
    return sendError(reply, 400, error.message, 'VALIDATION_ERROR');
  }

  // Don't leak internal details in production.
  if (statusCode >= 500) {
    request.log.error(error);
    return sendError(
      reply,
      500,
      process.env.NODE_ENV === 'production'
        ? 'Something went wrong on our end. Please try again.'
        : error.message,
    );
  }

  return sendError(reply, statusCode, error.message, error.code);
});

// Serve built test console from public/
const ASSET_TYPES = {
  '.css': 'text/css',
  '.js': 'application/javascript',
};

fastify.get('/', async (request, reply) => {
  const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8');
  reply.type('text/html').send(html);
});

fastify.get('/assets/:file', async (request, reply) => {
  const { file } = request.params;
  if (file.includes('..') || file.includes('/')) {
    return reply.code(400).send({ error: 'Bad Request' });
  }
  const path = join(__dirname, 'public', 'assets', file);
  if (!existsSync(path)) {
    return reply.code(404).send({ error: 'Not found' });
  }
  const ext = file.slice(file.lastIndexOf('.'));
  reply.type(ASSET_TYPES[ext] || 'application/octet-stream').send(readFileSync(path));
});

// Routes
await fastify.register(authRoutes);
await fastify.register(hobbyRoutes);
await fastify.register(profileRoutes);
await fastify.register(sessionRoutes);
await fastify.register(feedRoutes);
await fastify.register(adminRoutes);

// Health check
fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Start
const port = parseInt(process.env.PORT ?? '3000');
try {
  await fastify.listen({ port, host: '0.0.0.0' });
  startJobs();
  console.log(`GiftGenius Engine running on http://localhost:${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
