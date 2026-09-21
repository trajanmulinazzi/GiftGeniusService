/**
 * Pre-computation pipeline (§5).
 * Runs once at system setup or when hobby taxonomy changes.
 */

import { getDb } from '../db/index.js';
import { expandHobbyAngle, expandOccasion } from './claude.js';
import { resolveBudgetBuckets } from './amazon.js';
import { loadAngles, loadOccasions, loadBudgetBuckets } from './taxonomy.js';
import { note, span } from './diag.js';

const ALL_ANGLES = loadAngles().map(a => a.name);
const ALL_OCCASIONS = loadOccasions();
const ALL_BUDGET_BUCKETS = loadBudgetBuckets();

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

/** Run tasks in batches of `size` with a delay between batches. */
async function runBatched(tasks, size, delayMs) {
  let completed = 0;
  let errors = 0;
  for (let i = 0; i < tasks.length; i += size) {
    const batch = tasks.slice(i, i + size);
    const results = await Promise.allSettled(batch.map(t => t()));
    for (const r of results) {
      if (r.status === 'fulfilled') completed++;
      else errors++;
    }
    if (i + size < tasks.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return { completed, errors };
}

/**
 * Step 1 — Expand Hobby × Angle Matrix (§5.1)
 */
export async function expandAllHobbyAngles() {
  const sb = getDb();
  const { data: hobbies } = await sb.from('hobbies').select('id, name').order('name');

  let skipped = 0;
  const tasks = [];

  for (const hobby of hobbies) {
    for (const angle of ALL_ANGLES) {
      const { data: existing } = await sb
        .from('hobby_angle_expansions')
        .select('id')
        .eq('hobby_id', hobby.id)
        .eq('angle', angle)
        .maybeSingle();

      if (existing) { skipped++; continue; }

      tasks.push(async () => {
        const terms = await expandHobbyAngle(hobby.name, angle);
        await sb.from('hobby_angle_expansions').upsert({
          hobby_id: hobby.id,
          angle,
          search_terms: terms,
          computed_at: new Date().toISOString(),
        }, { onConflict: 'hobby_id,angle' });
        console.log(`[Precompute] ${hobby.name} × ${angle}: ${terms.length} terms`);
      });
    }
  }

  const { completed, errors } = await runBatched(tasks, BATCH_SIZE, BATCH_DELAY_MS);
  const total = skipped + completed;
  console.log(`[Precompute] Hobby×Angle complete: ${total} expansions (${skipped} cached), ${errors} errors`);
  return { total, errors };
}

/**
 * Step 2 — Generate Occasion Search Terms (§5.2)
 */
export async function expandAllOccasions() {
  const sb = getDb();
  let skipped = 0;
  const tasks = [];

  for (const occasion of ALL_OCCASIONS) {
    for (const bucket of ALL_BUDGET_BUCKETS) {
      const { data: existing } = await sb
        .from('occasion_search_terms')
        .select('id')
        .eq('occasion', occasion)
        .eq('budget_bucket', bucket)
        .maybeSingle();

      if (existing) { skipped++; continue; }

      tasks.push(async () => {
        const terms = await expandOccasion(occasion, bucket);
        await sb.from('occasion_search_terms').upsert({
          occasion,
          budget_bucket: bucket,
          search_terms: terms,
          computed_at: new Date().toISOString(),
        }, { onConflict: 'occasion,budget_bucket' });
        console.log(`[Precompute] ${occasion} × $${bucket}: ${terms.length} terms`);
      });
    }
  }

  const { completed, errors } = await runBatched(tasks, BATCH_SIZE, BATCH_DELAY_MS);
  const total = skipped + completed;
  console.log(`[Precompute] Occasions complete: ${total} expansions (${skipped} cached), ${errors} errors`);
  return { total, errors };
}

/**
 * Run the full pre-computation pipeline.
 */
export async function runPrecompute() {
  console.log('[Precompute] Starting full pipeline...');
  const hobbyResult = await expandAllHobbyAngles();
  const occasionResult = await expandAllOccasions();
  console.log('[Precompute] Pipeline complete.');
  return { hobbies: hobbyResult, occasions: occasionResult };
}

// ── Lazy, per-profile expansion (on-demand) ───────────────
// Instead of precomputing every hobby up front, a profile's expansions are
// computed the first time it's used. Rows are shared, so the second user of a
// hobby reuses them. Idempotent + concurrency-safe via upsert.

/** Load the hobby names + budget buckets a profile needs expansions for. */
async function loadProfileExpansionTargets(sb, profileId, occasion) {
  const { data: profile } = await sb
    .from('profiles')
    .select('hobby_ids, budget_min, budget_max')
    .eq('id', profileId)
    .single();
  if (!profile) return { profile: null, hobbies: [], buckets: [] };

  const hobbyIds = profile.hobby_ids ?? [];
  let hobbies = [];
  if (hobbyIds.length > 0) {
    const { data: rows } = await sb
      .from('hobbies').select('id, name').in('id', hobbyIds);
    hobbies = rows ?? [];
  }
  const buckets = resolveBudgetBuckets(profile.budget_min, profile.budget_max);
  return { profile, hobbies, buckets };
}

/**
 * Compute the expansions a single profile needs, skipping any that already
 * exist. Safe to fire-and-forget; safe to call concurrently. Returns batch
 * stats, or null if the profile has nothing to expand.
 */
export async function prepareProfileExpansions(profileId, occasion) {
  const sb = getDb();
  const { profile, hobbies, buckets } = await span(
    'loadExpansionTargets',
    () => loadProfileExpansionTargets(sb, profileId, occasion),
  );
  if (!profile) return null;

  const tasks = [];

  for (const hobby of hobbies) {
    for (const angle of ALL_ANGLES) {
      const { data: existing } = await sb
        .from('hobby_angle_expansions')
        .select('id')
        .eq('hobby_id', hobby.id)
        .eq('angle', angle)
        .maybeSingle();
      if (existing) continue;

      tasks.push(async () => {
        const terms = await expandHobbyAngle(hobby.name, angle);
        await sb.from('hobby_angle_expansions').upsert({
          hobby_id: hobby.id,
          angle,
          search_terms: terms,
          computed_at: new Date().toISOString(),
        }, { onConflict: 'hobby_id,angle' });
        console.log(`[Precompute] (lazy) ${hobby.name} × ${angle}: ${terms.length} terms`);
      });
    }
  }

  for (const bucket of buckets) {
    const { data: existing } = await sb
      .from('occasion_search_terms')
      .select('id')
      .eq('occasion', occasion)
      .eq('budget_bucket', bucket)
      .maybeSingle();
    if (existing) continue;

    tasks.push(async () => {
      const terms = await expandOccasion(occasion, bucket);
      await sb.from('occasion_search_terms').upsert({
        occasion,
        budget_bucket: bucket,
        search_terms: terms,
        computed_at: new Date().toISOString(),
      }, { onConflict: 'occasion,budget_bucket' });
      console.log(`[Precompute] (lazy) ${occasion} × $${bucket}: ${terms.length} terms`);
    });
  }

  note('expansions_missing', tasks.length);
  if (tasks.length === 0) return { completed: 0, errors: 0 };

  console.log(`[Precompute] Preparing profile ${profileId}: ${tasks.length} expansions...`);
  const result = await span(
    'runExpansions',
    () => runBatched(tasks, BATCH_SIZE, BATCH_DELAY_MS),
    { tasks: tasks.length, batch_size: BATCH_SIZE, batch_delay_ms: BATCH_DELAY_MS },
  );
  console.log(`[Precompute] Profile ${profileId} ready: ${result.completed} computed, ${result.errors} errors`);
  return result;
}

/**
 * True once a profile's feed can be produced: every hobby has at least one
 * angle expansion, and the occasion has at least one budget-bucket expansion.
 * Used to tell the app whether to keep showing the "getting ready" screen.
 */
export async function isProfileExpansionReady(profileId, occasion) {
  const sb = getDb();
  const { profile, hobbies, buckets } = await loadProfileExpansionTargets(sb, profileId, occasion);
  if (!profile) return true;

  if (hobbies.length > 0) {
    const { data: rows } = await sb
      .from('hobby_angle_expansions')
      .select('hobby_id')
      .in('hobby_id', hobbies.map(h => h.id));
    const ready = new Set((rows ?? []).map(r => r.hobby_id));
    for (const h of hobbies) {
      if (!ready.has(h.id)) return false;
    }
  }

  if (buckets.length > 0) {
    const { data: occRows } = await sb
      .from('occasion_search_terms')
      .select('id')
      .eq('occasion', occasion)
      .in('budget_bucket', buckets)
      .limit(1);
    if ((occRows ?? []).length === 0) return false;
  }

  return true;
}
