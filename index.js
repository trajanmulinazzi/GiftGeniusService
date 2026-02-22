/**
 * GiftGenius Engine - CLI entry point
 * Prompts for user and feed selection/creation, then runs the gift recommendation queue.
 */

import { intro, select, text, isCancel, cancel } from "@clack/prompts";
import { Queue } from "./classes/queue.js";
import { createUser, listUsers } from "./models/user.js";
import { createFeed, getFeedsByUser } from "./models/feed.js";
import { refillQueue } from "./services/refill.js";
import { getDb } from "./db/index.js";

function exitOnCancel(value) {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}

async function promptUser() {
  const users = await listUsers();
  const options = [
    { value: "__new__", label: "Create new user", hint: "Add a new profile" },
  ];
  for (const u of users) {
    options.push({
      value: String(u.id),
      label: u.name,
      hint: u.email || `User #${u.id}`,
    });
  }

  const choice = exitOnCancel(
    await select({
      message: "Who is using the app?",
      options,
    })
  );

  if (choice === "__new__") {
    const name = exitOnCancel(
      await text({
        message: "Your name",
        placeholder: "Jane",
      })
    );
    const email = exitOnCancel(
      await text({
        message: "Email (optional)",
        placeholder: "jane@example.com",
      })
    );
    const id = await createUser({ name, email: email || null });
    return id;
  }

  return Number(choice);
}

async function promptFeed(userId) {
  const feeds = await getFeedsByUser(userId);
  const options = [
    {
      value: "__new__",
      label: "Create new feed",
      hint: "Add a person to find gifts for",
    },
  ];
  for (const f of feeds) {
    options.push({
      value: String(f.id),
      label: f.name,
      hint: f.relationship || "Feed",
    });
  }

  const choice = exitOnCancel(
    await select({
      message: "Who are you finding gifts for?",
      options,
    })
  );

  if (choice === "__new__") {
    const name = exitOnCancel(
      await text({
        message: "Their name (e.g. Mom, Partner)",
        placeholder: "Mom",
      })
    );
    const relationship = exitOnCancel(
      await text({
        message: "Relationship",
        placeholder: "mom, partner, friend, coworker",
      })
    );
    const interestsInput = exitOnCancel(
      await text({
        message: "Interests (comma-separated)",
        placeholder: "coffee, hiking, books",
      })
    );
    const budgetMin = exitOnCancel(
      await text({
        message: "Budget min ($)",
        placeholder: "20",
      })
    );
    const budgetMax = exitOnCancel(
      await text({
        message: "Budget max ($)",
        placeholder: "100",
      })
    );

    const interests = interestsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const id = await createFeed({
      userId,
      name,
      relationship: relationship || null,
      interests: interests.length > 0 ? interests : ["gift"],
      budgetMin: budgetMin ? Number(budgetMin) : null,
      budgetMax: budgetMax ? Number(budgetMax) : null,
      occasion: null,
    });
    return id;
  }

  return Number(choice);
}

(async () => {
  intro("GiftGenius");

  await getDb();

  const userId = await promptUser();
  const feedId = await promptFeed(userId);

  const queue = new Queue(feedId);
  await refillQueue(feedId);
  await queue.processQueue();
})();
