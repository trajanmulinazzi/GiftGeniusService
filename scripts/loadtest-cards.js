// k6 load test for the deployed read path (A8.3: p95 GET /cards < 250ms under
// 30 concurrent feeds). Run this AFTER deploying the functions and warming a few
// feeds, ideally from a machine near the Supabase region so network RTT is
// representative (a laptop over the WAN inflates every number — see the local
// harness caveat).
//
//   BASE_URL=https://<ref>.supabase.co/functions/v1 \
//   TOKEN=<a valid Clerk JWT> \
//   FEED_IDS=uuid1,uuid2,...,uuid30 \
//   k6 run scripts/loadtest-cards.js
//
// Get TOKEN from a signed-in Clerk session (the frontend's Authorization header,
// or `clerk` test tokens). FEED_IDS: create feeds via POST /feeds first.

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL;
const TOKEN = __ENV.TOKEN;
const FEED_IDS = (__ENV.FEED_IDS || "").split(",").filter(Boolean);

const cardsLatency = new Trend("cards_latency_ms", true);

export const options = {
  scenarios: {
    concurrent_feeds: {
      executor: "constant-vus",
      vus: 30, // 30 concurrent feeds (A8.3)
      duration: "30s",
    },
  },
  thresholds: {
    "cards_latency_ms": ["p(95)<250"], // the A8.3 bar
    "http_req_failed": ["rate<0.01"],
  },
};

export default function () {
  if (FEED_IDS.length === 0) {
    throw new Error("Set FEED_IDS to a comma-separated list of warmed feed ids");
  }
  const feedId = FEED_IDS[Math.floor(Math.random() * FEED_IDS.length)];
  const res = http.get(`${BASE_URL}/api-feeds/feeds/${feedId}/cards`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  cardsLatency.add(res.timings.duration);
  check(res, {
    "status 200": (r) => r.status === 200,
    "has cards array": (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).cards);
      } catch {
        return false;
      }
    },
  });
}
