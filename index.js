import { Queue } from "./classes/queue.js";
import { createFeed } from "./models/feed.js";
import { refillQueue } from "./services/refill.js";
import { getDb } from "./db/index.js";

(async () => {
  await getDb();

  const feedId = await createFeed({
    name: "Girlfriend",
    ageMin: 25,
    ageMax: 30,
    relationship: "girlfriend",
    interests: ["rock-climbing", "coffee", "fantasy books"],
    budgetMin: 30,
    budgetMax: 80,
    occasion: null,
  });

  const queue = new Queue(feedId);
  const initItems = await refillQueue(feedId);
  queue.add(initItems);
})();
