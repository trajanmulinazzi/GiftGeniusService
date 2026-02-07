import { Queue } from "./classes/queue.js";
import { User } from "./classes/user.js";
import { Generate } from "./generate.js";

(async () => {
  const user = new User(
    27,
    "female",
    "girlfriend",
    ["rock-climbing", "coffee", "fantasy books"],
    30,
    80,
  );
  const queue = new Queue(user);

  const initItems = await Generate(user.getProfile(), user.getLikedItems(), user.getDislikedItems());
  queue.add(initItems.ideas);
})();
