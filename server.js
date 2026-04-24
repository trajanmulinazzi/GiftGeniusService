/**
 * GiftGenius Engine API server (Fastify)
 * First step: boot server + health endpoint.
 */

import Fastify from "fastify";
import { config } from "dotenv";
import { getDb } from "./db/index.js";

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

try {
  await app.listen({ port, host });
  app.log.info(`API listening on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
