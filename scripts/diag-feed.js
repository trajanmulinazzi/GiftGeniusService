/**
 * Feed latency harness.
 *
 * Runs the real generation path against a real profile and prints a trace per
 * batch, without Clerk, HTTP or the app in the way. Two things it isolates that
 * are hard to see from the client:
 *
 *   - cold vs warm: `--cold` drops the cached searches this profile would use,
 *     so the next batch pays full Canopy cost; run again to see the warm number
 *   - new-feed setup: `--new` runs the lazy Claude expansion + cache warm that a
 *     newly created feed waits on, traced on its own
 *
 * Run from the repo root (it reads .env.local):
 *
 *   node scripts/diag-feed.js                      # newest profile, 1 warm batch
 *   node scripts/diag-feed.js --batches 3          # see batch-over-batch drift
 *   node scripts/diag-feed.js --cold               # worst case, empty cache
 *   node scripts/diag-feed.js --new                # time first-feed setup
 *   node scripts/diag-feed.js --profile <uuid>
 */

import { getDb } from '../db/index.js';
import { generateFeed, prefetchFeedCache } from '../services/feed.js';
import { prepareProfileExpansions } from '../services/precompute.js';
import { buildCacheKey, resolveBudgetBuckets } from '../services/amazon.js';
import { reportTrace, runWithDiag, DIAG_ENABLED } from '../services/diag.js';

function parseArgs(argv) {
  const args = { batches: 1, batchSize: 10, cold: false, new: false, profile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cold') args.cold = true;
    else if (arg === '--new') args.new = true;
    else if (arg === '--profile') args.profile = argv[++i];
    else if (arg === '--batches') args.batches = Number(argv[++i]);
    else if (arg === '--batch-size') args.batchSize = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

async function pickProfile(sb, profileId) {
  if (profileId) {
    const { data } = await sb.from('profiles').select('*').eq('id', profileId).single();
    if (!data) throw new Error(`No profile ${profileId}`);
    return data;
  }
  const { data } = await sb
    .from('profiles').select('*').order('created_at', { ascending: false }).limit(1);
  if (!data?.length) throw new Error('No profiles exist yet — create one in the app first.');
  return data[0];
}

/**
 * Drop the cache rows this profile's searches would hit, so the next batch is a
 * true cold start. Scoped to the profile's own (term, bucket) keys — other
 * profiles keep their cache.
 */
async function clearCacheForProfile(sb, profile) {
  const hobbyIds = profile.hobby_ids ?? [];
  const buckets = resolveBudgetBuckets(profile.budget_min, profile.budget_max);
  const terms = new Set();

  if (hobbyIds.length > 0) {
    const { data } = await sb
      .from('hobby_angle_expansions').select('search_terms').in('hobby_id', hobbyIds);
    for (const row of data ?? []) for (const t of row.search_terms ?? []) terms.add(t);
  }
  const { data: occRows } = await sb
    .from('occasion_search_terms')
    .select('search_terms')
    .eq('occasion', profile.occasion ?? 'just_because');
  for (const row of occRows ?? []) for (const t of row.search_terms ?? []) terms.add(t);

  const keys = [];
  for (const term of terms) for (const bucket of buckets) keys.push(buildCacheKey(term, bucket));
  if (keys.length === 0) return 0;

  // Chunked: a few thousand keys in one `in` filter overruns the URL length.
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200);
    const { data } = await sb
      .from('amazon_cache').delete().in('cache_key', slice).select('cache_key');
    deleted += (data ?? []).length;
  }
  return deleted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readmeText());
    return;
  }
  if (!DIAG_ENABLED) {
    console.error('FEED_DIAG is disabled — unset FEED_DIAG=false to collect traces.');
    process.exit(1);
  }

  const sb = getDb();
  const profile = await pickProfile(sb, args.profile);
  const occasion = profile.occasion ?? 'just_because';

  console.log(
    `\nProfile "${profile.label}" (${profile.id})\n` +
    `  hobbies=${(profile.hobby_ids ?? []).length} occasion=${occasion} ` +
    `budget=${profile.budget_min}-${profile.budget_max} ` +
    `buckets=${resolveBudgetBuckets(profile.budget_min, profile.budget_max).join(',')}`,
  );

  if (args.cold) {
    const deleted = await clearCacheForProfile(sb, profile);
    console.log(`  cleared ${deleted} cached searches — next batch is a cold start`);
  }

  if (args.new) {
    // The path a brand-new feed waits on: Claude expansions, then cache warming.
    const { trace } = await runWithDiag(
      'harness.newFeedSetup',
      { profile_id: profile.id, occasion },
      () => prepareProfileExpansions(profile.id, occasion),
    );
    reportTrace(trace);
    prefetchFeedCache(profile.id, occasion);
  }

  const { data: session, error } = await sb
    .from('sessions').insert({ profile_id: profile.id, occasion }).select().single();
  if (error) throw new Error(`Could not create session: ${error.message}`);

  const totals = [];
  for (let i = 0; i < args.batches; i++) {
    const { result, trace } = await runWithDiag(
      'feed.generate',
      { session_id: session.id, profile_id: profile.id, batch: args.batchSize, run: i + 1 },
      () => generateFeed(session.id, profile.id, args.batchSize),
    );
    reportTrace(trace);
    totals.push({ run: i + 1, ms: Math.round(trace.totalMs), items: result.length });
  }

  await sb.from('sessions').update({ ended_at: new Date().toISOString() }).eq('id', session.id);

  console.log('\nBATCH TOTALS');
  for (const t of totals) {
    console.log(`  run ${t.run}: ${t.ms.toLocaleString()}ms → ${t.items} items`);
  }
  if (totals.length > 1) {
    const avg = totals.reduce((s, t) => s + t.ms, 0) / totals.length;
    console.log(`  average: ${Math.round(avg).toLocaleString()}ms`);
  }
  console.log(
    '\nBackground classification may still be running; the process exits once it settles.\n',
  );
}

function readmeText() {
  return `
Usage: node scripts/diag-feed.js [options]

  --profile <uuid>   Profile to generate for (default: newest)
  --batches <n>      Batches to generate (default: 1)
  --batch-size <n>   Items per batch (default: 10)
  --cold             Clear this profile's cached searches first
  --new              Time the first-feed setup (Claude expansions + cache warm)
`.trim();
}

main().catch((err) => {
  console.error('\n[diag-feed] Failed:', err.message ?? err);
  reportTrace(err?.diagTrace);
  process.exit(1);
});
