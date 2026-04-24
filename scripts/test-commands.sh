#!/usr/bin/env bash

# GiftGenius test command cookbook
# Run from repo root: /Users/trajan/giftgenius-engine

# -----------------------------------------------------------------------------
# API server checks
# -----------------------------------------------------------------------------

# Start the Fastify API server (health + users/feeds routes)
npm run start:api

# Check API health (DB reachable)
curl -s http://127.0.0.1:3000/health

# List users from API
curl -s http://127.0.0.1:3000/users

# Create a user via API
curl -s -X POST http://127.0.0.1:3000/users \
  -H "content-type: application/json" \
  -d '{"name":"Api Test User","email":"api-test@example.com"}'

# Create a feed via API (replace userId with a real user id)
curl -s -X POST http://127.0.0.1:3000/feeds \
  -H "content-type: application/json" \
  -d '{"userId":1,"name":"Mom","relationship":"mom","interests":["reading","hiking"],"budgetMin":10,"budgetMax":100}'

# List feeds for one user (replace userId)
curl -s "http://127.0.0.1:3000/feeds?userId=1"

# -----------------------------------------------------------------------------
# CLI flow checks
# -----------------------------------------------------------------------------

# Run the interactive CLI recommendation loop
npm start

# List most recent catalog items in DB
npm run list-catalog

# List most recent queued items in DB
npm run list-queue

# -----------------------------------------------------------------------------
# Amazon API debug checks
# -----------------------------------------------------------------------------

# Raw SearchItems response for a keyword phrase
npm run amazon:response "hiking gift for men"

# Raw GetItems response for one ASIN
npm run amazon:item-response B073CVZ9GZ

# Ingest a small Amazon batch into catalog
npm run ingest -- --amazon

# -----------------------------------------------------------------------------
# Direct DB inspection helpers (advanced)
# -----------------------------------------------------------------------------

# Show feeds and tag weights for one user name (replace "Test2")
node -e "import('./db/index.js').then(async ({ getDb }) => { const db = await getDb(); const res = await db.query(\"SELECT f.id, u.name AS user_name, f.name AS feed_name, f.relationship, f.tag_weights FROM feeds f JOIN users u ON u.id = f.user_id WHERE u.name = \$1 ORDER BY f.id DESC\", ['Test2']); console.log(JSON.stringify(res.rows, null, 2)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });"

# Show recent interactions and item tags for a feed id (replace 5)
node -e "import('./db/index.js').then(async ({ getDb }) => { const db = await getDb(); const res = await db.query(\"SELECT i.id, i.type, c.source_id, c.title, c.tags FROM interactions i JOIN catalog c ON c.id = i.catalog_item_id WHERE i.feed_id = \$1 ORDER BY i.id DESC LIMIT 20\", [5]); console.log(JSON.stringify(res.rows, null, 2)); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });"

