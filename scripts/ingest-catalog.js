#!/usr/bin/env node
/**
 * Catalog ingestion script (out of band)
 * Seeds or refreshes the product catalog from retailer APIs or curated lists.
 * Run separately from the recommendation loop.
 */

import { upsertProduct } from "../models/catalog.js";
import { getDb } from "../db/index.js";

const SAMPLE_PRODUCTS = [
  {
    source_id: "B001-TEST-001",
    source: "amazon",
    title: "Climbing Chalk Bag",
    image_url: "https://example.com/chalk.jpg",
    price: 24.99,
    buy_url: "https://amazon.com/dp/B001-TEST-001",
    tags: ["rock-climbing", "sports", "outdoor", "adventure"],
    active: true,
  },
  {
    source_id: "B002-TEST-002",
    source: "amazon",
    title: "Artisan Coffee Beans - Ethiopian",
    image_url: "https://example.com/coffee.jpg",
    price: 18.99,
    buy_url: "https://amazon.com/dp/B002-TEST-002",
    tags: ["coffee", "gourmet", "food", "gift"],
    active: true,
  },
  {
    source_id: "B003-TEST-003",
    source: "amazon",
    title: "Fantasy Novel Collection - Best Sellers",
    image_url: "https://example.com/books.jpg",
    price: 35.0,
    buy_url: "https://amazon.com/dp/B003-TEST-003",
    tags: ["fantasy", "books", "reading", "fiction"],
    active: true,
  },
  {
    source_id: "B004-TEST-004",
    source: "etsy",
    title: "Handmade Ceramic Mug",
    image_url: "https://example.com/mug.jpg",
    price: 28.0,
    buy_url: "https://etsy.com/listing/B004-TEST-004",
    tags: ["coffee", "handmade", "ceramics", "home"],
    active: true,
  },
  {
    source_id: "B005-TEST-005",
    source: "amazon",
    title: "Wireless Bluetooth Earbuds",
    image_url: "https://example.com/earbuds.jpg",
    price: 49.99,
    buy_url: "https://amazon.com/dp/B005-TEST-005",
    tags: ["tech", "audio", "gadgets"],
    active: true,
  },
  {
    source_id: "B006-TEST-006",
    source: "amazon",
    title: "Yoga Mat Premium",
    image_url: "https://example.com/yoga.jpg",
    price: 34.99,
    buy_url: "https://amazon.com/dp/B006-TEST-006",
    tags: ["fitness", "yoga", "wellness"],
    active: true,
  },
  {
    source_id: "B007-TEST-007",
    source: "amazon",
    title: "Puzzle Board Game - Strategy",
    image_url: "https://example.com/boardgame.jpg",
    price: 42.0,
    buy_url: "https://amazon.com/dp/B007-TEST-007",
    tags: ["games", "board-games", "strategy", "fantasy"],
    active: true,
  },
  {
    source_id: "B008-TEST-008",
    source: "etsy",
    title: "Personalized Bookmark Set",
    image_url: "https://example.com/bookmark.jpg",
    price: 12.99,
    buy_url: "https://etsy.com/listing/B008-TEST-008",
    tags: ["books", "reading", "personalized", "gift"],
    active: true,
  },
  {
    source_id: "B009-TEST-009",
    source: "amazon",
    title: "Portable Espresso Maker",
    image_url: "https://example.com/espresso.jpg",
    price: 59.99,
    buy_url: "https://amazon.com/dp/B009-TEST-009",
    tags: ["coffee", "travel", "gadgets"],
    active: true,
  },
  {
    source_id: "B010-TEST-010",
    source: "amazon",
    title: "Adventure Travel Backpack",
    image_url: "https://example.com/backpack.jpg",
    price: 79.99,
    buy_url: "https://amazon.com/dp/B010-TEST-010",
    tags: ["travel", "outdoor", "adventure", "rock-climbing"],
    active: true,
  },
];

async function run() {
  await getDb();
  for (const product of SAMPLE_PRODUCTS) {
    await upsertProduct(product);
  }
  console.log(`Ingested ${SAMPLE_PRODUCTS.length} products into catalog.`);
}

run().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
