import {
  intro,
  confirm,
  spinner,
  isCancel,
  cancel
} from "@clack/prompts";
import { Generate } from "../generate.js";
import { appendFile } from "fs/promises";
import { join } from "path";

export class Queue {
  constructor(user) {
    this.queue = [];
    this.isProcessing = false;
    this.user = user;
    this.spinner = spinner();
    this.backgroundGeneration = false;
    this.logFile = join(process.cwd(), "queue.log");

    intro("Welcome to gift idea generator");
    this.spinner.start("Thinking of more gift ideas");
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

  async processQueue() {
    this.isProcessing = true;
    this.spinner.stop("Loaded more gift ideas");

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      await this.askUser(item);

      if (this.queue.length <= 2 && !this.backgroundGeneration) {
        this.log("Background generation started");
        this.log(`Profile: ${JSON.stringify(this.user.getProfile())}`);
        this.log(`Liked items: ${JSON.stringify(this.user.getLikedItems())}`);
        this.log(`Disliked items: ${JSON.stringify(this.user.getDislikedItems())}`);
        this.backgroundGeneration = true;
        Generate(this.user.getProfile(), this.user.getLikedItems(), this.user.getDislikedItems())
          .then(initItems => {
            this.add(initItems.ideas);
            this.backgroundGeneration = false;
            this.log("Background generation completed");
          })
          .catch(error => {
            this.backgroundGeneration = false;
            this.log("Background generation failed:", error.message);
          });
      }
    }

    this.isProcessing = false;
    this.spinner.start("Thinking of more gift ideas");
  }

  async askUser(text) {
    const isUserLikesItem = await confirm({
      message: text,
    });

    if (isCancel(isUserLikesItem)) {
      cancel("Cancelled.");
      process.exit(0);
    }

    if (isUserLikesItem) {
      this.user.addLikedItem(text);
    } else {
      this.user.addDislikedItem(text);
    }
  }
}
