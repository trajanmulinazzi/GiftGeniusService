/**
 * Temporary evaluation harness — offline dry run of the relevance filter.
 * Reads served feed items, classifies them, and reports what the new filter
 * would have done. Writes nothing.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { createClient } from '@supabase/supabase-js';
import { rateHobbyRelevance } from '../services/claude.js';
import {
  loadHobbyRelevance,
  isHobbyRejected,
  isHobbyVerified,
  MIN_VERIFIED_AFFINITY,
  MAX_REJECTED_AFFINITY,
} from '../services/relevance.js';

const SESSION_ID = process.argv[2] ?? 'dc7a01e9-3eba-46be-ad8f-7651a7cd3450';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: hobbies } = await sb.from('hobbies').select('id, name');
const hobbyName = new Map((hobbies ?? []).map((h) => [h.id, h.name]));

function verdict(affinity) {
  if (isHobbyRejected(affinity)) return 'DROPPED';
  if (isHobbyVerified(affinity)) return 'tagged';
  return 'kept, no tag';
}

async function classifyAll(rows) {
  const byHobby = new Map();
  for (const r of rows) {
    if (!r.hobby_id) continue;
    if (!byHobby.has(r.hobby_id)) byHobby.set(r.hobby_id, []);
    byHobby.get(r.hobby_id).push({ asin: r.item_asin, title: r.item_snapshot?.title ?? '' });
  }
  const scores = new Map();
  for (const [hobbyId, products] of byHobby) {
    const name = hobbyName.get(hobbyId);
    if (!name) continue;
    for (let i = 0; i < products.length; i += 20) {
      const batch = products.slice(i, i + 20);
      const rated = await rateHobbyRelevance(name, batch);
      for (const [asin, a] of rated) scores.set(`${asin}:${hobbyId}`, a);
    }
  }
  return scores;
}

// ── 1. Fail-soft check: no table yet, so lookups must degrade quietly ──
const probe = await loadHobbyRelevance([{ asin: 'B0GJ5GD31D', hobby_id: '54e6f272-1135-479a-bcaf-0debdddd1ea2' }]);
console.log(`\n[1] Pre-migration lookup returned ${probe.size} verdicts without throwing (feed degrades to "unverified").`);

// ── 2. The exact feed from the logs ──
const { data: served } = await sb
  .from('feed_events')
  .select('item_asin, item_snapshot, hobby_id, slot_type, served_at')
  .eq('session_id', SESSION_ID)
  .order('served_at', { ascending: true });

console.log(`\n[2] Feed ${SESSION_ID.slice(0, 8)} — ${served?.length ?? 0} served items\n`);
const scores = await classifyAll(served ?? []);

let dropped = 0;
let tagged = 0;
for (const r of served ?? []) {
  const key = `${r.item_asin}:${r.hobby_id}`;
  const a = r.hobby_id ? scores.get(key) : undefined;
  const v = r.hobby_id ? verdict(a) : `${r.slot_type} slot, no hobby`;
  if (v === 'DROPPED') dropped++;
  if (v === 'tagged') tagged++;
  const score = a === undefined ? '  – ' : String(a).padEnd(4);
  console.log(
    `  ${score} ${v.padEnd(14)} ${(hobbyName.get(r.hobby_id) ?? '—').padEnd(18)} ${(r.item_snapshot?.title ?? '').slice(0, 50)}`,
  );
}
console.log(`\n  => ${dropped} dropped, ${tagged} keep their hashtag, thresholds ${MAX_REJECTED_AFFINITY}/${MIN_VERIFIED_AFFINITY}`);

// ── 3. Wider sample, to check the feed won't starve ──
const { data: recent } = await sb
  .from('feed_events')
  .select('item_asin, item_snapshot, hobby_id')
  .not('hobby_id', 'is', null)
  .order('served_at', { ascending: false })
  .limit(400);

const perHobby = new Map();
const sample = [];
for (const r of recent ?? []) {
  const n = perHobby.get(r.hobby_id) ?? 0;
  if (n >= 12) continue;
  perHobby.set(r.hobby_id, n + 1);
  sample.push(r);
  if (sample.length >= 120) break;
}

console.log(`\n[3] Wider sample: ${sample.length} items across ${perHobby.size} hobbies`);
const wideScores = await classifyAll(sample);

const stats = new Map();
for (const r of sample) {
  const a = wideScores.get(`${r.item_asin}:${r.hobby_id}`);
  const name = hobbyName.get(r.hobby_id) ?? '—';
  if (!stats.has(name)) stats.set(name, { drop: 0, tag: 0, mid: 0 });
  const s = stats.get(name);
  if (isHobbyRejected(a)) s.drop++;
  else if (isHobbyVerified(a)) s.tag++;
  else s.mid++;
}

let d = 0, t = 0, m = 0;
console.log(`\n  ${'hobby'.padEnd(24)} dropped  tagged  untagged`);
for (const [name, s] of [...stats].sort((a, b) => b[1].drop - a[1].drop)) {
  d += s.drop; t += s.tag; m += s.mid;
  console.log(`  ${name.padEnd(24)} ${String(s.drop).padEnd(8)} ${String(s.tag).padEnd(7)} ${s.mid}`);
}
const total = d + t + m;
console.log(`\n  => ${((d / total) * 100).toFixed(0)}% dropped, ${((t / total) * 100).toFixed(0)}% tagged, ${((m / total) * 100).toFixed(0)}% kept untagged`);
