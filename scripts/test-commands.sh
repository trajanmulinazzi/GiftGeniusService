#!/usr/bin/env bash

# GiftGenius Engine — test command cookbook
# Run from repo root

BASE="http://127.0.0.1:3000"

# -----------------------------------------------------------------------------
# Server
# -----------------------------------------------------------------------------

# Start API server
# npm run start:api

# Health check
curl -s "$BASE/health" | jq .

# -----------------------------------------------------------------------------
# Setup: taxonomy + users
# -----------------------------------------------------------------------------

# Sync hobbies/angles/occasions from taxonomy/*.txt into Supabase
curl -s -X POST "$BASE/admin/taxonomy/sync" | jq .

# View taxonomy config (from .txt files, not DB)
curl -s "$BASE/admin/taxonomy" | jq .

# List hobbies in DB
curl -s "$BASE/admin/hobbies" | jq .

# Create a test user
curl -s -X POST "$BASE/admin/users" \
  -H "content-type: application/json" \
  -d '{"name":"Test User","email":"test@example.com"}' | jq .

# List users
curl -s "$BASE/admin/users" | jq .

# -----------------------------------------------------------------------------
# Pre-computation (run once after taxonomy sync)
# -----------------------------------------------------------------------------

# Run full Claude pre-computation pipeline (hobby×angle + occasion expansions)
# WARNING: 200 hobbies × 6 angles = 1200 Claude calls. Trim hobbies.txt first.
curl -s -X POST "$BASE/admin/precompute" | jq .

# -----------------------------------------------------------------------------
# Profiles
# -----------------------------------------------------------------------------

# Create a profile (replace user_id and hobby_ids with real UUIDs)
curl -s -X POST "$BASE/profiles" \
  -H "content-type: application/json" \
  -d '{
    "user_id": "USER_UUID_HERE",
    "label": "Mom",
    "hobby_ids": ["HOBBY_UUID_1", "HOBBY_UUID_2"],
    "budget_min": 25,
    "budget_max": 100
  }' | jq .

# Get profile with weights
# curl -s "$BASE/profiles/PROFILE_UUID" | jq .

# -----------------------------------------------------------------------------
# Sessions + Feed
# -----------------------------------------------------------------------------

# Start a session
curl -s -X POST "$BASE/sessions" \
  -H "content-type: application/json" \
  -d '{
    "profile_id": "PROFILE_UUID_HERE",
    "occasion": "birthday"
  }' | jq .

# Get feed (replace session_id)
# curl -s "$BASE/feed/SESSION_UUID?batch=10" | jq .

# Send a signal
# curl -s -X POST "$BASE/feed/signal" \
#   -H "content-type: application/json" \
#   -d '{"feed_event_id":"EVENT_UUID","signal":"save"}' | jq .

# -----------------------------------------------------------------------------
# Admin / monitoring
# -----------------------------------------------------------------------------

# System stats
curl -s "$BASE/admin/stats" | jq .

# Amazon API usage today
curl -s "$BASE/admin/api-usage" | jq .

# Manual cache refresh
# curl -s -X POST "$BASE/admin/cache/refresh" | jq .

# -----------------------------------------------------------------------------
# Data management
# -----------------------------------------------------------------------------

# Clear all data (keeps schema)
# node scripts/clear-data.js

# Clear data but keep hobbies + precomputed search terms
# node scripts/clear-data.js --keep-hobbies

# Re-run schema migration
# node scripts/migrate.js
