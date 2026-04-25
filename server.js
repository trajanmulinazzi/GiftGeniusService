/**
 * GiftGenius Engine API server (Fastify)
 * First step: boot server + health endpoint.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyJwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config } from "dotenv";
import { z } from "zod";
import { getDb } from "./db/index.js";
import { createUser, getUser, getUserByEmail, listUsers } from "./models/user.js";
import { createFeed, getFeed, getFeedsByUser } from "./models/feed.js";
import { getQueueSize, getNextAndDequeue } from "./models/queue.js";
import { recordShown } from "./models/catalog.js";
import { getSavedItems } from "./models/interaction.js";
import { refillQueue } from "./services/refill.js";
import { recordInteractionWithLearning } from "./services/feed-interactions.js";

config({ path: ".env.local" });
config();

const app = Fastify({
  logger: {
    // Prevent accidental credential leakage in structured logs.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.set-cookie",
        "req.headers.x-user-id",
        "res.headers.set-cookie",
      ],
      censor: "[REDACTED]",
    },
  },
});
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const REFILL_THRESHOLD = 3;
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error("Missing JWT_SECRET. Set JWT_SECRET in environment.");
}
const corsAllowedOriginsRaw = process.env.CORS_ALLOWED_ORIGINS || "";
const corsAllowedOrigins = corsAllowedOriginsRaw
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const isProd = process.env.NODE_ENV === "production";
const ERROR_CODES = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};
const RATE_LIMITS = {
  GLOBAL_PER_MINUTE: 120,
  AUTH_LOGIN_PER_MINUTE: 12,
  FEED_NEXT_PER_MINUTE: 75,
  FEED_INTERACTIONS_PER_MINUTE: 90,
  FEED_SAVED_PER_MINUTE: 45,
};

await app.register(rateLimit, {
  max: RATE_LIMITS.GLOBAL_PER_MINUTE,
  timeWindow: "1 minute",
  errorResponseBuilder: () => ({
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Retry later with backoff.",
    },
  }),
});

await app.register(fastifyJwt, {
  secret: jwtSecret,
});

await app.register(cors, {
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  credentials: false,
  origin(origin, cb) {
    // Allow non-browser/server-to-server requests (no Origin header).
    if (!origin) return cb(null, true);

    // In local/dev, allow common localhost origins and Expo web defaults.
    if (!isProd && corsAllowedOrigins.length === 0) {
      const allowDev =
        /^http:\/\/localhost(:\d+)?$/.test(origin) ||
        /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
      return cb(null, allowDev);
    }

    const allowed = corsAllowedOrigins.includes(origin);
    return cb(null, allowed);
  },
});

await app.register(swagger, {
  openapi: {
    info: {
      title: "GiftGenius Engine API",
      version: "0.1.0",
      description: "Gift feed recommendation API for frontend clients.",
    },
    servers: [{ url: "http://127.0.0.1:3000" }],
  },
});

await app.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list", deepLinking: false },
  staticCSP: true,
});

const errorResponseSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
};

const errorExamples = {
  badRequest: {
    error: { code: "BAD_REQUEST", message: "Invalid request body" },
  },
  unauthorized: {
    error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token" },
  },
  forbidden: {
    error: { code: "FORBIDDEN", message: "Feed does not belong to user" },
  },
  notFound: {
    error: { code: "NOT_FOUND", message: "Feed not found" },
  },
};

const authHeadersSchema = {
  type: "object",
  properties: {
    authorization: {
      type: "string",
      description: "Bearer access token",
      pattern: "^Bearer\\s.+",
    },
  },
};

function sendError(reply, statusCode, code, message) {
  return reply.code(statusCode).send({
    error: {
      code,
      message,
    },
  });
}

function mapUserDto(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email ?? null,
    createdAt: user.created_at ?? null,
  };
}

function mapFeedDto(feed) {
  if (!feed) return null;
  return {
    id: feed.id,
    userId: feed.user_id,
    name: feed.name,
    ageMin: feed.age_min ?? null,
    ageMax: feed.age_max ?? null,
    relationship: feed.relationship ?? null,
    interests: Array.isArray(feed.interests) ? feed.interests : [],
    budgetMin: feed.budget_min ?? null,
    budgetMax: feed.budget_max ?? null,
    occasion: feed.occasion ?? null,
    tagWeights:
      typeof feed.tag_weights === "object" && feed.tag_weights != null
        ? feed.tag_weights
        : {},
    createdAt: feed.created_at ?? null,
  };
}

async function requireAuth(request, reply) {
  try {
    await request.jwtVerify();
  } catch {
    const allowLegacy = process.env.ALLOW_LEGACY_USER_HEADER === "1";
    if (!allowLegacy) {
      return sendError(
        reply,
        401,
        ERROR_CODES.UNAUTHORIZED,
        "Missing or invalid bearer token"
      );
    }
    const userIdHeader = request.headers["x-user-id"];
    const parsed = z.coerce.number().int().positive().safeParse(userIdHeader);
    if (!parsed.success) {
      return sendError(
        reply,
        401,
        ERROR_CODES.UNAUTHORIZED,
        "Missing or invalid bearer token"
      );
    }
    request.user = { userId: parsed.data };
  }

  const userId = Number(request.user?.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    request.log.warn({ route: request.url, ip: request.ip }, "auth token rejected");
    return sendError(
      reply,
      401,
      ERROR_CODES.UNAUTHORIZED,
      "Missing or invalid bearer token"
    );
  }
  const user = await getUser(userId);
  if (!user) {
    request.log.warn({ route: request.url, ip: request.ip, userId }, "auth user missing");
    return sendError(
      reply,
      401,
      ERROR_CODES.UNAUTHORIZED,
      "User not found for token"
    );
  }
  request.auth = { userId };
}

async function requireOwnedFeed(request, reply) {
  const feedIdParsed = z.coerce.number().int().positive().safeParse(
    request.params?.feedId
  );
  if (!feedIdParsed.success) {
    return sendError(
      reply,
      400,
      ERROR_CODES.BAD_REQUEST,
      "feedId must be a positive integer"
    );
  }

  const feed = await getFeed(feedIdParsed.data);
  if (!feed) {
    return sendError(reply, 404, ERROR_CODES.NOT_FOUND, "Feed not found");
  }
  if (feed.user_id !== request.auth.userId) {
    request.log.warn(
      { route: request.url, ip: request.ip, feedId: feed.id, userId: request.auth.userId },
      "feed ownership check failed"
    );
    return sendError(
      reply,
      403,
      ERROR_CODES.FORBIDDEN,
      "Feed does not belong to user"
    );
  }
  request.feed = feed;
}

app.setErrorHandler((err, request, reply) => {
  const errStatus = Number(err?.statusCode ?? err?.status ?? 0);
  const errCode = typeof err?.code === "string" ? err.code : "";
  const errMessage = typeof err?.message === "string" ? err.message : "";

  if (err?.validation) {
    return sendError(
      reply,
      400,
      ERROR_CODES.BAD_REQUEST,
      "Invalid request"
    );
  }
  if (
    errStatus === 429 ||
    errCode === "FST_ERR_RATE_LIMIT" ||
    errMessage.toLowerCase().includes("rate limit") ||
    reply.statusCode === 429
  ) {
    return sendError(
      reply,
      429,
      ERROR_CODES.RATE_LIMITED,
      "Too many requests. Retry later with backoff."
    );
  }
  if (
    err &&
    typeof err === "object" &&
    request.routeOptions?.config?.rateLimit &&
    errStatus === 0 &&
    errCode === "" &&
    errMessage === ""
  ) {
    return sendError(
      reply,
      429,
      ERROR_CODES.RATE_LIMITED,
      "Too many requests. Retry later with backoff."
    );
  }
  request.log.error(
    { err: { name: err?.name, code: errCode, status: errStatus, message: errMessage } },
    "request failed"
  );
  if (reply.sent) return;
  return sendError(
    reply,
    500,
    ERROR_CODES.INTERNAL_ERROR,
    "Unexpected server error"
  );
});

app.get(
  "/health",
  {
    schema: {
      tags: ["system"],
      summary: "Health check",
      response: {
        200: {
          type: "object",
          required: ["ok", "service"],
          properties: {
            ok: { type: "boolean" },
            service: { type: "string" },
          },
          examples: [{ ok: true, service: "giftgenius-engine" }],
        },
      },
    },
  },
  async () => {
  // Ensure DB is reachable so health reflects real backend readiness.
  await getDb();
  return { ok: true, service: "giftgenius-engine" };
  }
);

app.get(
  "/users",
  {
    schema: {
      tags: ["users"],
      summary: "List users",
      response: {
        200: {
          type: "object",
          required: ["users"],
          properties: {
            users: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "name", "email", "createdAt"],
                properties: {
                  id: { type: "number" },
                  name: { type: "string" },
                  email: { type: ["string", "null"] },
                  createdAt: { type: ["string", "null"] },
                },
              },
            },
          },
          examples: [
            {
              users: [
                {
                  id: 1,
                  name: "Alice",
                  email: "alice@example.com",
                  createdAt: "2026-04-24T02:48:40.103Z",
                },
              ],
            },
          ],
        },
      },
    },
  },
  async () => {
  const users = await listUsers();
    return { users: users.map(mapUserDto) };
  }
);

app.post(
  "/auth/login",
  {
    config: { rateLimit: { max: RATE_LIMITS.AUTH_LOGIN_PER_MINUTE, timeWindow: "1 minute" } },
    schema: {
      tags: ["auth"],
      summary: "Login with email and issue JWT",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["email"],
        properties: {
          email: { type: "string", format: "email", maxLength: 320 },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["accessToken", "tokenType", "expiresInSeconds", "user"],
          properties: {
            accessToken: { type: "string" },
            tokenType: { type: "string", enum: ["Bearer"] },
            expiresInSeconds: { type: "number" },
            user: {
              type: "object",
              required: ["id", "name", "email", "createdAt"],
              properties: {
                id: { type: "number" },
                name: { type: "string" },
                email: { type: ["string", "null"] },
                createdAt: { type: ["string", "null"] },
              },
            },
          },
        },
        400: { ...errorResponseSchema, examples: [errorExamples.badRequest] },
        401: { ...errorResponseSchema, examples: [errorExamples.unauthorized] },
        429: {
          ...errorResponseSchema,
          examples: [{ error: { code: "RATE_LIMITED", message: "Too many requests. Retry later with backoff." } }],
        },
      },
    },
  },
  async (request, reply) => {
    const schema = z
      .object({
        email: z.string().trim().email().max(320),
      })
      .strict();
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, ERROR_CODES.BAD_REQUEST, "Invalid request body");
    }
    const user = await getUserByEmail(parsed.data.email);
    if (!user) {
      return sendError(reply, 401, ERROR_CODES.UNAUTHORIZED, "Invalid credentials");
    }
    const expiresInSeconds = 60 * 60 * 24 * 7;
    const accessToken = await reply.jwtSign(
      { userId: user.id },
      { expiresIn: `${expiresInSeconds}s` }
    );
    return {
      accessToken,
      tokenType: "Bearer",
      expiresInSeconds,
      user: mapUserDto(user),
    };
  }
);

app.post(
  "/users",
  {
    schema: {
      tags: ["users"],
      summary: "Create user",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          email: { type: "string", format: "email", maxLength: 320 },
        },
      },
      response: {
        201: {
          type: "object",
          required: ["id", "name", "email", "createdAt"],
          properties: {
            id: { type: "number" },
            name: { type: "string" },
            email: { type: ["string", "null"] },
            createdAt: { type: ["string", "null"] },
          },
          examples: [
            {
              id: 10,
              name: "Api User",
              email: "api-user@example.com",
              createdAt: "2026-04-25T15:54:16.476Z",
            },
          ],
        },
        400: { ...errorResponseSchema, examples: [errorExamples.badRequest] },
      },
    },
  },
  async (request, reply) => {
  const schema = z
    .object({
      name: z.string().trim().min(1).max(120),
      email: z.string().email().max(320).optional(),
    })
    .strict();
  const parsed = schema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return sendError(
      reply,
      400,
      ERROR_CODES.BAD_REQUEST,
      "Invalid request body"
    );
  }
  const { name, email } = parsed.data;
  const id = await createUser({ name, email: email ?? null });
  const created = await getUser(id);
  return reply.code(201).send(mapUserDto(created));
  }
);

app.get(
  "/feeds",
  {
    schema: {
      tags: ["feeds"],
      summary: "List feeds by user",
      querystring: {
        type: "object",
        required: ["userId"],
        additionalProperties: false,
        properties: {
          userId: { type: "integer", minimum: 1 },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["feeds"],
          properties: {
            feeds: {
              type: "array",
              items: {
                type: "object",
                required: [
                  "id",
                  "userId",
                  "name",
                  "interests",
                  "tagWeights",
                ],
                properties: {
                  id: { type: "number" },
                  userId: { type: "number" },
                  name: { type: "string" },
                  ageMin: { type: ["number", "null"] },
                  ageMax: { type: ["number", "null"] },
                  relationship: { type: ["string", "null"] },
                  interests: { type: "array", items: { type: "string" } },
                  budgetMin: { type: ["number", "null"] },
                  budgetMax: { type: ["number", "null"] },
                  occasion: { type: ["string", "null"] },
                  tagWeights: { type: "object", additionalProperties: true },
                  createdAt: { type: ["string", "null"] },
                },
              },
            },
          },
          examples: [
            {
              feeds: [
                {
                  id: 7,
                  userId: 1,
                  name: "Mom",
                  ageMin: null,
                  ageMax: null,
                  relationship: "mom",
                  interests: ["reading", "hiking"],
                  budgetMin: 10,
                  budgetMax: 100,
                  occasion: null,
                  tagWeights: { reading: 1, hiking: 1 },
                  createdAt: "2026-04-24T02:48:53.737Z",
                },
              ],
            },
          ],
        },
        400: { ...errorResponseSchema, examples: [errorExamples.badRequest] },
        404: { ...errorResponseSchema, examples: [errorExamples.notFound] },
      },
    },
  },
  async (request, reply) => {
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
      ERROR_CODES.BAD_REQUEST,
      "userId query param is required and must be a positive integer"
    );
  }
  const { userId } = parsed.data;
  const user = await getUser(userId);
  if (!user) {
    return sendError(reply, 404, ERROR_CODES.NOT_FOUND, "User not found");
  }
  const feeds = await getFeedsByUser(parsed.data.userId);
  return { feeds: feeds.map(mapFeedDto) };
  }
);

app.post(
  "/feeds",
  {
    schema: {
      tags: ["feeds"],
      summary: "Create feed",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["userId", "name"],
        properties: {
          userId: { type: "integer", minimum: 1 },
          name: { type: "string", minLength: 1, maxLength: 120 },
          relationship: { type: "string", maxLength: 120 },
          interests: {
            type: "array",
            maxItems: 30,
            items: { type: "string", minLength: 1, maxLength: 80 },
          },
          budgetMin: { type: "number", minimum: 0, maximum: 1000000 },
          budgetMax: { type: "number", minimum: 0, maximum: 1000000 },
        },
      },
      response: {
        201: {
          type: "object",
          required: [
            "id",
            "userId",
            "name",
            "interests",
            "tagWeights",
          ],
          properties: {
            id: { type: "number" },
            userId: { type: "number" },
            name: { type: "string" },
            ageMin: { type: ["number", "null"] },
            ageMax: { type: ["number", "null"] },
            relationship: { type: ["string", "null"] },
            interests: { type: "array", items: { type: "string" } },
            budgetMin: { type: ["number", "null"] },
            budgetMax: { type: ["number", "null"] },
            occasion: { type: ["string", "null"] },
            tagWeights: { type: "object", additionalProperties: true },
            createdAt: { type: ["string", "null"] },
          },
          examples: [
            {
              id: 11,
              userId: 1,
              name: "Mom",
              ageMin: null,
              ageMax: null,
              relationship: "mom",
              interests: ["reading", "hiking"],
              budgetMin: 10,
              budgetMax: 100,
              occasion: null,
              tagWeights: { reading: 1, hiking: 1 },
              createdAt: "2026-04-25T16:02:10.222Z",
            },
          ],
        },
        400: { ...errorResponseSchema, examples: [errorExamples.badRequest] },
        404: { ...errorResponseSchema, examples: [errorExamples.notFound] },
      },
    },
  },
  async (request, reply) => {
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
    return sendError(
      reply,
      400,
      ERROR_CODES.BAD_REQUEST,
      "Invalid request body"
    );
  }
  const { userId, name, relationship, interests, budgetMin, budgetMax } =
    parsed.data;
  if (budgetMin != null && budgetMax != null && budgetMin > budgetMax) {
    return sendError(
      reply,
      400,
      ERROR_CODES.BAD_REQUEST,
      "budgetMin cannot exceed budgetMax"
    );
  }
  const user = await getUser(userId);
  if (!user) {
    return sendError(reply, 404, ERROR_CODES.NOT_FOUND, "User not found");
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
  const created = await getFeed(id);
  return reply.code(201).send(mapFeedDto(created));
  }
);

app.get(
  "/feeds/:feedId/next",
  {
    preHandler: [requireAuth, requireOwnedFeed],
    config: { rateLimit: { max: RATE_LIMITS.FEED_NEXT_PER_MINUTE, timeWindow: "1 minute" } },
    schema: {
      tags: ["feeds"],
      summary: "Get next item for feed",
      headers: authHeadersSchema,
      params: {
        type: "object",
        required: ["feedId"],
        properties: {
          feedId: { type: "integer", minimum: 1 },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["item", "queueRemaining"],
          properties: {
            item: {
              type: "object",
              required: [
                "id",
                "sourceId",
                "source",
                "title",
                "imageUrl",
                "priceCents",
                "currency",
                "buyUrl",
                "tags",
              ],
              properties: {
                id: { type: "number" },
                sourceId: { type: "string" },
                source: { type: "string" },
                title: { type: "string" },
                imageUrl: { type: ["string", "null"] },
                priceCents: { type: ["number", "null"] },
                currency: { type: ["string", "null"] },
                buyUrl: { type: ["string", "null"] },
                tags: { type: "array", items: { type: "string" } },
              },
            },
            queueRemaining: { type: "number" },
          },
        },
        401: { ...errorResponseSchema, examples: [errorExamples.unauthorized] },
        403: { ...errorResponseSchema, examples: [errorExamples.forbidden] },
        404: { ...errorResponseSchema, examples: [errorExamples.notFound] },
        429: {
          ...errorResponseSchema,
          examples: [{ error: { code: "RATE_LIMITED", message: "Too many requests. Retry later with backoff." } }],
        },
      },
    },
  },
  async (request, reply) => {
    const feedId = request.feed.id;
    let item = await getNextAndDequeue(feedId);
    if (!item) {
      try {
        await refillQueue(feedId);
      } catch (err) {
        request.log.warn(
          { feedId, message: err?.message || String(err) },
          "initial refill failed"
        );
      }
      item = await getNextAndDequeue(feedId);
    }
    if (!item) {
      return sendError(
        reply,
        404,
        ERROR_CODES.NOT_FOUND,
        "No items available for this feed"
      );
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
    preHandler: [requireAuth, requireOwnedFeed],
    config: { rateLimit: { max: RATE_LIMITS.FEED_INTERACTIONS_PER_MINUTE, timeWindow: "1 minute" } },
    schema: {
      tags: ["feeds"],
      summary: "Record interaction for feed item",
      headers: authHeadersSchema,
      params: {
        type: "object",
        required: ["feedId"],
        properties: {
          feedId: { type: "integer", minimum: 1 },
        },
      },
      body: {
        type: "object",
        required: ["catalogItemId", "type"],
        additionalProperties: false,
        properties: {
          catalogItemId: { type: "integer", minimum: 1 },
          type: { type: "string", enum: ["like", "pass", "save"] },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
        400: { ...errorResponseSchema, examples: [errorExamples.badRequest] },
        401: { ...errorResponseSchema, examples: [errorExamples.unauthorized] },
        403: { ...errorResponseSchema, examples: [errorExamples.forbidden] },
        404: { ...errorResponseSchema, examples: [errorExamples.notFound] },
        429: {
          ...errorResponseSchema,
          examples: [{ error: { code: "RATE_LIMITED", message: "Too many requests. Retry later with backoff." } }],
        },
      },
    },
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
      return sendError(
        reply,
        400,
        ERROR_CODES.BAD_REQUEST,
        "Invalid request body"
      );
    }

    const { catalogItemId, type } = parsed.data;
    try {
      await recordInteractionWithLearning(request.feed.id, catalogItemId, type);
    } catch (err) {
      if (err?.code === "CATALOG_ITEM_NOT_FOUND") {
        return sendError(
          reply,
          404,
          ERROR_CODES.NOT_FOUND,
          "catalogItemId not found"
        );
      }
      throw err;
    }
    return { ok: true };
  }
);

app.get(
  "/feeds/:feedId/saved",
  {
    preHandler: [requireAuth, requireOwnedFeed],
    config: { rateLimit: { max: RATE_LIMITS.FEED_SAVED_PER_MINUTE, timeWindow: "1 minute" } },
    schema: {
      tags: ["feeds"],
      summary: "List saved items for feed",
      headers: authHeadersSchema,
      params: {
        type: "object",
        required: ["feedId"],
        properties: {
          feedId: { type: "integer", minimum: 1 },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["items"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                required: [
                  "id",
                  "sourceId",
                  "source",
                  "title",
                  "imageUrl",
                  "priceCents",
                  "currency",
                  "buyUrl",
                  "tags",
                  "savedAt",
                ],
                properties: {
                  id: { type: "number" },
                  sourceId: { type: "string" },
                  source: { type: "string" },
                  title: { type: "string" },
                  imageUrl: { type: ["string", "null"] },
                  priceCents: { type: ["number", "null"] },
                  currency: { type: ["string", "null"] },
                  buyUrl: { type: ["string", "null"] },
                  tags: { type: "array", items: { type: "string" } },
                  savedAt: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        401: { ...errorResponseSchema, examples: [errorExamples.unauthorized] },
        403: { ...errorResponseSchema, examples: [errorExamples.forbidden] },
        429: {
          ...errorResponseSchema,
          examples: [{ error: { code: "RATE_LIMITED", message: "Too many requests. Retry later with backoff." } }],
        },
      },
    },
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
        savedAt: item.saved_at ?? null,
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
