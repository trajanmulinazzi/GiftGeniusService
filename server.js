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
import { readFileSync } from 'fs';

import profileRoutes from './routes/profiles.js';
import sessionRoutes from './routes/sessions.js';
import feedRoutes from './routes/feed.js';
import adminRoutes from './routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fastify = Fastify({ logger: true });

// CORS
await fastify.register(fastifyCors, { origin: true });

// Serve index.html manually (no @fastify/static dependency needed)
fastify.get('/', async (request, reply) => {
  const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8');
  reply.type('text/html').send(html);
});

// Routes
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
  console.log(`GiftGenius Engine running on http://localhost:${port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
