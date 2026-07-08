/**
 * Apply an arbitrary SQL file to Supabase via the Management API (HTTPS).
 * Use for incremental, non-destructive migrations (unlike migrate.js which
 * applies the full schema and DROPs existing tables).
 *
 * Requires SUPABASE_ACCESS_TOKEN in .env.local.
 * Usage: node scripts/apply-sql.js db/migrations/001_clerk_identity_occasion.sql
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { readFileSync } from 'fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error('Missing SUPABASE_URL or SUPABASE_ACCESS_TOKEN in .env.local');
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/apply-sql.js <path-to-sql-file>');
  process.exit(1);
}

const projectRef = SUPABASE_URL.replace('https://', '').split('.')[0];

async function runSQL(sql) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  if (!res.ok) {
    throw new Error(`Supabase API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

try {
  const sql = readFileSync(file, 'utf-8');
  console.log(`Applying ${file} to ${projectRef}...`);
  await runSQL(sql);
  console.log('Done.');
} catch (err) {
  console.error('Migration error:', err.message);
  process.exit(1);
}
