#!/usr/bin/env node
/**
 * Catalog ingestion script (out of band)
 * Seeds or refreshes the product catalog from retailer APIs or curated lists.
 * Run separately from the recommendation loop.
 *
 * Usage:
 *   npm run ingest               - Ingest sample products
 *   npm run ingest:canopy        - Canopy API: 100 searches, broad catalog (uses CANOPY_API_KEY)
 *   npm run ingest -- --canopy   - Same as above
 *   npm run ingest:canopy-product - Canopy: 1 search + product API per item = well-tagged (1 call per item)
 *   npm run ingest -- --canopy-product --max-calls 20 - Same, limit to 20 API calls (1 search + 19 products)
 *   npm run ingest -- --amazon   - Amazon Creators API (requires 10 sales/30d eligibility)
 *   npm run ingest -- --amazon --keywords "gift for dad" --count 20
 */

import "dotenv/config";
import { upsertProduct } from "../models/catalog.js";
import { getDb } from "../db/index.js";
import { searchProducts as amazonSearch } from "../services/amazon-api.js";
import { searchProducts as canopySearch, getProductByAsin } from "../services/canopy-api.js";
import { GIFT_KEYWORDS } from "../data/gift-keywords.js";

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

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    amazon: false,
    canopy: false,
    canopyProduct: false,
    keywords: "gift ideas",
    count: 10,
    maxCalls: 100,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--amazon") opts.amazon = true;
    if (args[i] === "--canopy") opts.canopy = true;
    if (args[i] === "--canopy-product") opts.canopyProduct = true;
    if (args[i] === "--keywords" && args[i + 1]) opts.keywords = args[++i];
    if (args[i] === "--count" && args[i + 1]) opts.count = parseInt(args[++i], 10) || 10;
    if (args[i] === "--max-calls" && args[i + 1]) opts.maxCalls = parseInt(args[++i], 10) || 100;
  }
  return opts;
}

async function run() {
  const opts = parseArgs();

  await getDb();

  let products;
  if (opts.canopy) {
    const keywords = GIFT_KEYWORDS.slice(0, opts.maxCalls);
    console.log(
      `Searching Canopy API (${keywords.length} queries, ~40 products each)...`
    );
    products = [];
    const seen = new Set();
    for (let i = 0; i < keywords.length; i++) {
      process.stdout.write(
        `  [${i + 1}/${keywords.length}] "${keywords[i]}"... `
      );
      try {
        const batch = await canopySearch(keywords[i], { limit: 40 });
        let newCount = 0;
        for (const p of batch) {
          if (seen.has(p.source_id)) continue;
          seen.add(p.source_id);
          products.push(p);
          newCount++;
        }
        console.log(`${batch.length} results (${newCount} new)`);
      } catch (err) {
        console.log(`error: ${err.message}`);
      }
      if (i < keywords.length - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!products.length) {
      console.warn("No products from Canopy. Check CANOPY_API_KEY and try again.");
      process.exit(0);
    }
  } else if (opts.canopyProduct) {
    const keyword = opts.keywords;
    const maxCalls = Math.max(2, opts.maxCalls);
    const productCalls = maxCalls - 1;
    console.log(`Canopy product mode: 1 search + up to ${productCalls} product lookups (tags from API)...`);
    const searchResults = await canopySearch(keyword, { limit: Math.min(40, productCalls) });
    const asins = [...new Set(searchResults.map((p) => p.source_id))].slice(0, productCalls);
    console.log(`  Search "${keyword}" → ${asins.length} ASINs. Fetching each (1 API call per item), saving as we go...`);
    products = [];
    for (let i = 0; i < asins.length; i++) {
      process.stdout.write(`  [${i + 1}/${asins.length}] ${asins[i]}... `);
      try {
        const p = await getProductByAsin(asins[i]);
        if (p) {
          products.push(p);
          await upsertProduct(p);
          console.log(`OK (${p.tags.length} tags), saved`);
        } else console.log("no data");
      } catch (err) {
        console.log(`error: ${err.message}`);
      }
      if (i < asins.length - 1) await new Promise((r) => setTimeout(r, 250));
    }
    if (!products.length) {
      console.warn("No products from Canopy product API.");
      process.exit(0);
    }
  } else if (opts.amazon) {
    console.log(`Searching Amazon Creators API for "${opts.keywords}" (${opts.count} items)...`);
    products = await amazonSearch(opts.keywords, {
      searchIndex: "All",
      itemCount: opts.count,
    });
    if (!products.length) {
      console.warn(
        "No products returned from Amazon. Check credentials and eligibility (10 sales/30d)."
      );
      process.exit(0);
    }
  } else {
    products = SAMPLE_PRODUCTS;
  }

  if (!opts.canopyProduct) {
    for (const product of products) {
      await upsertProduct(product);
    }
  }
  console.log(`Ingested ${products.length} products into catalog.`);
}

run().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
