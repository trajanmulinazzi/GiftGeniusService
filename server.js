/**
 * GiftGenius Engine API server (Fastify)
 * First step: boot server + health endpoint.
 */

import Fastify from "fastify";
import { config } from "dotenv";
import { getDb } from "./db/index.js";
import { createUser, listUsers } from "./models/user.js";
import { createFeed, getFeedsByUser } from "./models/feed.js";

config({ path: ".env.local" });
config();

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

app.get("/health", async () => {
  // Ensure DB is reachable so health reflects real backend readiness.
  await getDb();
  return { ok: true };
});

app.get("/users", async () => {
  const users = await listUsers();
  return { users };
});

app.post("/users", async (request, reply) => {
  const name = String(request.body?.name || "").trim();
  const emailRaw = request.body?.email;
  const email = typeof emailRaw === "string" ? emailRaw.trim() : null;
  if (!name) {
    return reply.code(400).send({
      error: "BadRequest",
      message: "name is required",
    });
  }
  const id = await createUser({ name, email: email || null });
  return reply.code(201).send({ id, name, email: email || null });
});

app.get("/feeds", async (request, reply) => {
  const userId = Number(request.query?.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return reply.code(400).send({
      error: "BadRequest",
      message: "userId query param is required and must be a positive integer",
    });
  }
  const feeds = await getFeedsByUser(userId);
  return { feeds };
});

app.post("/feeds", async (request, reply) => {
  const body = request.body || {};
  const userId = Number(body.userId);
  const name = String(body.name || "").trim();
  const relationship =
    typeof body.relationship === "string" ? body.relationship.trim() : null;
  const budgetMin =
    body.budgetMin == null || body.budgetMin === ""
      ? null
      : Number(body.budgetMin);
  const budgetMax =
    body.budgetMax == null || body.budgetMax === ""
      ? null
      : Number(body.budgetMax);
  const interests = Array.isArray(body.interests)
    ? body.interests.map((v) => String(v).trim()).filter(Boolean)
    : [];

  if (!Number.isInteger(userId) || userId <= 0) {
    return reply.code(400).send({
      error: "BadRequest",
      message: "userId is required and must be a positive integer",
    });
  }
  if (!name) {
    return reply.code(400).send({
      error: "BadRequest",
      message: "name is required",
    });
  }

  const id = await createFeed({
    userId,
    name,
    relationship: relationship || null,
    interests: interests.length ? interests : ["gift"],
    budgetMin,
    budgetMax,
    occasion: null,
  });
  return reply.code(201).send({ id });
});

try {
  await app.listen({ port, host });
  app.log.info(`API listening on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
