/**
 * Run database migration via Supabase Management API (HTTPS).
 * Requires SUPABASE_ACCESS_TOKEN (personal access token) in .env.local.
 * Generate at: https://supabase.com/dashboard/account/tokens
 *
 * Usage: node scripts/migrate.js
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { readFileSync } from 'fs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error('Missing SUPABASE_URL or SUPABASE_ACCESS_TOKEN in .env.local');
  console.error('Generate a personal access token at: https://supabase.com/dashboard/account/tokens');
  process.exit(1);
}

// Extract project ref from URL: https://<ref>.supabase.co
const projectRef = SUPABASE_URL.replace('https://', '').split('.')[0];

async function runSQL(sql) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase API error (${res.status}): ${body}`);
  }

  return res.json();
}

try {
  console.log(`Migrating project: ${projectRef}`);
  const sql = readFileSync('db/schema.pg.sql', 'utf-8');

  console.log('Applying schema...');
  const result = await runSQL(sql);
  console.log('Schema applied successfully.');

  // Verify tables
  const tables = await runSQL(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  console.log('Tables:', tables.map(r => r.tablename).join(', '));
} catch (err) {
  console.error('Migration error:', err.message);
  process.exit(1);
}
