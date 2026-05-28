/**
 * Taxonomy handler — reads .txt files from taxonomy/ and populates Supabase.
 * Single source of truth for hobbies, angles, budget buckets, and occasions.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getDb } from '../db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TAXONOMY_DIR = join(__dirname, '..', 'taxonomy');

// ── File Readers ────────────────────────────────────────

function readLines(filename) {
  const content = readFileSync(join(TAXONOMY_DIR, filename), 'utf-8');
  return content.split('\n').map(l => l.trim()).filter(Boolean);
}

export function loadAngles() {
  return readLines('angles.txt').map(line => {
    const [name, definition] = line.split('|').map(s => s.trim());
    return { name, definition };
  });
}

export function loadHobbies() {
  return readLines('hobbies.txt');
}

export function loadBudgetBuckets() {
  return readLines('budget_buckets.txt');
}

export function loadOccasions() {
  return readLines('occasions.txt');
}

export function getBucketRanges() {
  const buckets = loadBudgetBuckets();
  const ranges = {};
  for (const b of buckets) {
    if (b.endsWith('+')) {
      ranges[b] = [parseInt(b), 9999];
    } else {
      const [lo, hi] = b.split('-').map(Number);
      ranges[b] = [lo, hi];
    }
  }
  return ranges;
}

export function getAngleDefinitions() {
  const angles = loadAngles();
  const defs = {};
  for (const a of angles) defs[a.name] = a.definition;
  return defs;
}

// ── Supabase Population ─────────────────────────────────

export async function syncHobbies() {
  const sb = getDb();
  const hobbyNames = loadHobbies();
  let inserted = 0;

  for (const name of hobbyNames) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
    const { data } = await sb
      .from('hobbies')
      .upsert({ name, slug }, { onConflict: 'slug', ignoreDuplicates: true })
      .select('id');
    if (data && data.length > 0) inserted++;
  }

  const { count } = await sb.from('hobbies').select('*', { count: 'exact', head: true });
  return { inserted, existing: (count ?? 0) - inserted, total: count ?? 0 };
}

export async function syncAll() {
  console.log('[Taxonomy] Syncing hobbies to Supabase...');
  const hobbyResult = await syncHobbies();
  console.log(`[Taxonomy] Hobbies: ${hobbyResult.inserted} inserted, ${hobbyResult.existing} existing, ${hobbyResult.total} total`);

  const angles = loadAngles();
  const buckets = loadBudgetBuckets();
  const occasions = loadOccasions();

  console.log(`[Taxonomy] Angles: ${angles.map(a => a.name).join(', ')}`);
  console.log(`[Taxonomy] Budget buckets: ${buckets.join(', ')}`);
  console.log(`[Taxonomy] Occasions: ${occasions.join(', ')}`);

  return {
    hobbies: hobbyResult,
    angles: angles.length,
    budget_buckets: buckets.length,
    occasions: occasions.length,
  };
}
