import { config } from "dotenv";
import { refillQueue } from "../services/refill.js";
import { getFeed, getSearchTermsForRefill } from "../models/feed.js";
import { getQueueSize } from "../models/queue.js";

config({ path: ".env.local" });
config();

function usage() {
  console.log("Usage: node scripts/verify-refill-behavior.js <feedId>");
  process.exit(1);
}

const feedId = Number(process.argv[2]);
if (!Number.isInteger(feedId) || feedId <= 0) usage();

const feed = await getFeed(feedId);
if (!feed) {
  console.error(`Feed ${feedId} not found`);
  process.exit(1);
}

const before = await getQueueSize(feedId);
const isInitial = before === 0;
const searchTerms = await getSearchTermsForRefill(feedId, isInitial);

console.log(`[verify] feedId=${feedId} queueBefore=${before} isInitial=${isInitial}`);
console.log(`[verify] terms=${JSON.stringify(searchTerms)}`);

const added = await refillQueue(feedId);
const after = await getQueueSize(feedId);
console.log(`[verify] refill added=${added} queueAfter=${after}`);

if (searchTerms.length > 0) {
  const failTerm = String(searchTerms[0]);
  process.env.REFILL_FAIL_TERM = failTerm;
  const beforeFail = await getQueueSize(feedId);
  const addedWithFailure = await refillQueue(feedId);
  const afterFail = await getQueueSize(feedId);
  console.log(
    `[verify] simulated term failure="${failTerm}" added=${addedWithFailure} queueBefore=${beforeFail} queueAfter=${afterFail}`
  );
  delete process.env.REFILL_FAIL_TERM;
}

if (after <= 3) {
  console.log("[verify] queue at/below threshold after refill; check provider configuration.");
}

console.log("[verify] done");
