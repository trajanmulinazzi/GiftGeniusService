/**
 * GiftGenius Engine API server (Fastify)
 * First step: boot server + health endpoint.
 */

import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { config } from "dotenv";
import { z } from "zod";
import { getDb } from "./db/index.js";
import { createUser, getUser, listUsers } from "./models/user.js";
import { createFeed, getFeed, getFeedsByUser, updateTagWeights } from "./models/feed.js";
import { getQueueSize, getNextAndDequeue } from "./models/queue.js";
import { getProductById, recordShown } from "./models/catalog.js";
import { getSavedItems, recordInteraction } from "./models/interaction.js";
import { refillQueue } from "./services/refill.js";
import { updateTagWeightsFromInteraction } from "./services/ranking.js";

config({ path: ".env.local" });
config();

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const REFILL_THRESHOLD = 3;

await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute",
});

function sendError(reply, statusCode, code, message) {
  return reply.code(statusCode).send({
    error: {
      code,
      message,
    },
  });
}

async function requireUserIdHeader(request, reply) {
  const userIdHeader = request.headers["x-user-id"];
  const parsed = z.coerce.number().int().positive().safeParse(userIdHeader);
  if (!parsed.success) {
    return sendError(reply, 401, "UNAUTHORIZED", "x-user-id header is required");
  }
  const user = await getUser(parsed.data);
  if (!user) {
    return sendError(reply, 401, "UNAUTHORIZED", "User not found for x-user-id");
  }
  request.auth = { userId: parsed.data };
}

async function requireOwnedFeed(request, reply) {
  const feedIdParsed = z.coerce.number().int().positive().safeParse(
    request.params?.feedId
  );
  if (!feedIdParsed.success) {
    return sendError(reply, 400, "BAD_REQUEST", "feedId must be a positive integer");
  }

  const feed = await getFeed(feedIdParsed.data);
  if (!feed) {
    return sendError(reply, 404, "NOT_FOUND", "Feed not found");
  }
  if (feed.user_id !== request.auth.userId) {
    return sendError(reply, 403, "FORBIDDEN", "Feed does not belong to user");
  }
  request.feed = feed;
}

app.setErrorHandler((err, request, reply) => {
  request.log.error({ err: { message: err.message, name: err.name } }, "request failed");
  if (reply.sent) return;
  return sendError(reply, 500, "INTERNAL_ERROR", "Unexpected server error");
});

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
  const schema = z
    .object({
      name: z.string().trim().min(1).max(120),
      email: z.string().email().max(320).optional(),
    })
    .strict();
  const parsed = schema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return sendError(reply, 400, "BAD_REQUEST", "Invalid request body");
  }
  const { name, email } = parsed.data;
  const id = await createUser({ name, email: email ?? null });
  return reply.code(201).send({ id, name, email: email ?? null });
});

app.get("/feeds", async (request, reply) => {
  const schema = z
    .object({
      userId: z.coerce.number().int().positive(),
    })
    .strict();
  const parsed = schema.safeParse(request.query ?? {});
  if (!parsed.success) {
    return sendError(
      reply,
      400,
      "BAD_REQUEST",
      "userId query param is required and must be a positive integer"
    );
  }
  const { userId } = parsed.data;
  const user = await getUser(userId);
  if (!user) {
    return sendError(reply, 404, "NOT_FOUND", "User not found");
  }
  const feeds = await getFeedsByUser(parsed.data.userId);
  return { feeds };
});

app.post("/feeds", async (request, reply) => {
  const schema = z
    .object({
      userId: z.coerce.number().int().positive(),
      name: z.string().trim().min(1).max(120),
      relationship: z.string().trim().max(120).optional(),
      interests: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
      budgetMin: z.coerce.number().nonnegative().max(1_000_000).optional(),
      budgetMax: z.coerce.number().nonnegative().max(1_000_000).optional(),
    })
    .strict();
  const parsed = schema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return sendError(reply, 400, "BAD_REQUEST", "Invalid request body");
  }
  const { userId, name, relationship, interests, budgetMin, budgetMax } =
    parsed.data;
  if (budgetMin != null && budgetMax != null && budgetMin > budgetMax) {
    return sendError(reply, 400, "BAD_REQUEST", "budgetMin cannot exceed budgetMax");
  }
  const user = await getUser(userId);
  if (!user) {
    return sendError(reply, 404, "NOT_FOUND", "User not found");
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

app.get(
  "/feeds/:feedId/next",
  {
    preHandler: [requireUserIdHeader, requireOwnedFeed],
    config: { rateLimit: { max: 90, timeWindow: "1 minute" } },
  },
  async (request, reply) => {
    const feedId = request.feed.id;
    let item = await getNextAndDequeue(feedId);
    if (!item) {
      await refillQueue(feedId);
      item = await getNextAndDequeue(feedId);
    }
    if (!item) {
      return sendError(reply, 404, "NOT_FOUND", "No items available for this feed");
    }

    await recordShown(item.id);
    const remaining = await getQueueSize(feedId);

    if (remaining <= REFILL_THRESHOLD) {
      refillQueue(feedId).catch((err) => {
        request.log.warn({ msg: err?.message }, "background refill failed");
      });
    }

    return {
      item: {
        id: item.id,
        sourceId: item.source_id,
        source: item.source,
        title: item.title,
        imageUrl: item.image_url,
        priceCents: item.price_cents,
        currency: item.currency,
        buyUrl: item.buy_url,
        tags: (() => {
          if (Array.isArray(item.tags)) return item.tags;
          if (typeof item.tags === "string") {
            try {
              return JSON.parse(item.tags);
            } catch {
              return [];
            }
          }
          return [];
        })(),
      },
      queueRemaining: remaining,
    };
  }
);

app.post(
  "/feeds/:feedId/interactions",
  {
    preHandler: [requireUserIdHeader, requireOwnedFeed],
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  },
  async (request, reply) => {
    const schema = z
      .object({
        catalogItemId: z.coerce.number().int().positive(),
        type: z.enum(["like", "pass", "save"]),
      })
      .strict();
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, "BAD_REQUEST", "Invalid request body");
    }

    const { catalogItemId, type } = parsed.data;
    await recordInteraction(request.feed.id, catalogItemId, type);
    const item = await getProductById(catalogItemId);
    const tags =
      typeof item?.tags === "string"
        ? (() => {
            try {
              return JSON.parse(item.tags);
            } catch {
              return [];
            }
          })()
        : Array.isArray(item?.tags)
        ? item.tags
        : [];

    // Keep feed learning deterministic and feed-scoped.
    const nextWeights = updateTagWeightsFromInteraction(
      request.feed.tag_weights || {},
      tags,
      type
    );
    await updateTagWeights(request.feed.id, nextWeights);

    return { ok: true };
  }
);

app.get(
  "/feeds/:feedId/saved",
  {
    preHandler: [requireUserIdHeader, requireOwnedFeed],
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  },
  async (request) => {
    const saved = await getSavedItems(request.feed.id);
    return {
      items: saved.map((item) => ({
        id: item.id,
        sourceId: item.source_id,
        source: item.source,
        title: item.title,
        imageUrl: item.image_url,
        priceCents: item.price_cents,
        currency: item.currency,
        buyUrl: item.buy_url,
        tags:
          typeof item.tags === "string"
            ? (() => {
                try {
                  return JSON.parse(item.tags);
                } catch {
                  return [];
                }
              })()
            : Array.isArray(item.tags)
            ? item.tags
            : [],
      })),
    };
  }
);

try {
  await app.listen({ port, host });
  app.log.info(`API listening on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
