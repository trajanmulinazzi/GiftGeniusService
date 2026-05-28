/**
 * Pre-computation pipeline (§5).
 * Runs once at system setup or when hobby taxonomy changes.
 */

import { getDb } from '../db/index.js';
import { expandHobbyAngle, expandOccasion } from './claude.js';
import { loadAngles, loadOccasions, loadBudgetBuckets } from './taxonomy.js';

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
