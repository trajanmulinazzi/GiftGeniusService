/**
 * GiftGenius Engine — Fastify API Server.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

import { startJobs } from './services/jobs.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import sessionRoutes from './routes/sessions.js';
import feedRoutes from './routes/feed.js';
import adminRoutes from './routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fastify = Fastify({ logger: true });

// CORS
await fastify.register(fastifyCors, { origin: true });

// JWT
await fastify.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
});

// Auth decorators
fastify.decorate('authenticate', async function (request, reply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized', message: err.message });
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
    reply.code(403).send({ error: 'Forbidden', message: 'Invalid admin credentials' });
  }
});

// Global error handler — consistent error shape for all routes
fastify.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode || 500;

  // Validation errors from Zod (thrown by our validate() helper)
  if (error.validation) {
    return reply.code(400).send({
      error: 'Validation Error',
      message: error.message,
      details: error.validation,
    });
  }

  // Fastify built-in validation/404 errors
  if (error.code === 'FST_ERR_VALIDATION') {
    return reply.code(400).send({
      error: 'Bad Request',
      message: error.message,
    });
  }

  // Don't leak internal details in production
  if (statusCode >= 500) {
    request.log.error(error);
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : error.message,
    });
  }

  return reply.code(statusCode).send({
    error: error.name || 'Error',
    message: error.message,
  });
});

// Serve index.html manually (no @fastify/static dependency needed)
fastify.get('/', async (request, reply) => {
  const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8');
  reply.type('text/html').send(html);
});

// Routes
await fastify.register(authRoutes);
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
