import {
  intro,
  select,
  spinner,
  isCancel,
  cancel,
} from "@clack/prompts";
import { appendFile } from "fs/promises";
import { join } from "path";
import { refillQueue } from "../services/refill.js";
import { recordInteraction } from "../models/interaction.js";
import { recordShown } from "../models/catalog.js";
import { getFeed, updateTagWeights } from "../models/feed.js";
import { updateTagWeightsFromInteraction } from "../services/ranking.js";

const REFILL_THRESHOLD = 5;

export class Queue {
  constructor(feedId) {
    this.queue = [];
    this.feedId = feedId;
    this.isProcessing = false;
    this.spinner = spinner();
    this.backgroundRefill = false;
    this.logFile = join(process.cwd(), "queue.log");

    intro("Welcome to GiftGenius");
    this.spinner.start("Loading gift ideas");
  }

  async log(...messages) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${messages.join(" ")}\n`;
    try {
      await appendFile(this.logFile, logMessage);
    } catch (error) {
      console.error("Failed to write to log file:", error);
    }
  }

  add(items) {
    this.queue.push(...items);
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  formatProduct(item) {
    const price =
      item.price_cents != null
        ? `$${(item.price_cents / 100).toFixed(2)}`
        : "";
    const parts = [item.title];
    if (price) parts.push(price);
    if (item.buy_url) parts.push(`\n  ${item.buy_url}`);
    return parts.join(" • ");
  }

  async processQueue() {
    this.isProcessing = true;
    this.spinner.stop("Loaded more gift ideas");

    while (this.queue.length > 0) {
      const item = this.queue.shift();

      await recordShown(item.id);

      const choice = await this.askUser(item);

      if (choice === null) {
        // User cancelled
        return;
      }

      // Record interaction and update tag weights
      await recordInteraction(this.feedId, item.id, choice);
      const feed = await getFeed(this.feedId);
      const tags = typeof item.tags === "string" ? JSON.parse(item.tags || "[]") : (item.tags || []);
      const nextWeights = updateTagWeightsFromInteraction(
        feed?.tag_weights || {},
        tags,
        choice
      );
      await updateTagWeights(this.feedId, nextWeights);

      if (this.queue.length <= REFILL_THRESHOLD && !this.backgroundRefill) {
        this.log("Background refill started for feed", this.feedId);
        this.backgroundRefill = true;
        refillQueue(this.feedId)
          .then((items) => {
            this.add(items);
            this.backgroundRefill = false;
            this.log("Background refill completed, added", items.length, "items");
          })
          .catch((error) => {
            this.backgroundRefill = false;
            this.log("Background refill failed:", error.message);
          });
      }
    }

    this.isProcessing = false;
    this.spinner.start("Loading more gift ideas");
  }

  async askUser(item) {
    const message = this.formatProduct(item);

    const choice = await select({
      message,
      options: [
        { value: "like", label: "Like", hint: "I like this" },
        { value: "pass", label: "Pass", hint: "Not for me" },
        { value: "save", label: "Save", hint: "Save for later" },
      ],
    });

    if (isCancel(choice)) {
      cancel("Cancelled.");
      process.exit(0);
      return null;
    }

    return choice;
  }
}
