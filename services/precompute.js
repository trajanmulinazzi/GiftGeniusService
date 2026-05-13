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

/**
 * Step 1 — Expand Hobby × Angle Matrix (§5.1)
 */
export async function expandAllHobbyAngles() {
  const sb = getDb();
  const { data: hobbies } = await sb.from('hobbies').select('id, name').order('name');

  let total = 0;
  let errors = 0;

  for (let i = 0; i < hobbies.length; i += 10) {
    const batch = hobbies.slice(i, i + 10);
    const promises = [];

    for (const hobby of batch) {
      for (const angle of ALL_ANGLES) {
        // Check if already computed
        const { data: existing } = await sb
          .from('hobby_angle_expansions')
          .select('id')
          .eq('hobby_id', hobby.id)
          .eq('angle', angle)
          .maybeSingle();

        if (existing) { total++; continue; }

        promises.push(
          expandHobbyAngle(hobby.name, angle)
            .then(async (terms) => {
              await sb.from('hobby_angle_expansions').upsert({
                hobby_id: hobby.id,
                angle,
                search_terms: terms,
                computed_at: new Date().toISOString(),
              }, { onConflict: 'hobby_id,angle' });
              total++;
              console.log(`[Precompute] ${hobby.name} × ${angle}: ${terms.length} terms`);
            })
            .catch(err => {
              errors++;
              console.error(`[Precompute] Error for ${hobby.name} × ${angle}:`, err.message);
            })
        );
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`[Precompute] Hobby×Angle complete: ${total} expansions, ${errors} errors`);
  return { total, errors };
}

/**
 * Step 2 — Generate Occasion Search Terms (§5.2)
 */
export async function expandAllOccasions() {
  const sb = getDb();
  let total = 0;
  let errors = 0;

  for (const occasion of ALL_OCCASIONS) {
    const promises = ALL_BUDGET_BUCKETS.map(async (bucket) => {
      const { data: existing } = await sb
        .from('occasion_search_terms')
        .select('id')
        .eq('occasion', occasion)
        .eq('budget_bucket', bucket)
        .maybeSingle();

      if (existing) { total++; return; }

      try {
        const terms = await expandOccasion(occasion, bucket);
        await sb.from('occasion_search_terms').upsert({
          occasion,
          budget_bucket: bucket,
          search_terms: terms,
          computed_at: new Date().toISOString(),
        }, { onConflict: 'occasion,budget_bucket' });
        total++;
        console.log(`[Precompute] ${occasion} × $${bucket}: ${terms.length} terms`);
      } catch (err) {
        errors++;
        console.error(`[Precompute] Error for ${occasion} × $${bucket}:`, err.message);
      }
    });

    await Promise.all(promises);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[Precompute] Occasions complete: ${total} expansions, ${errors} errors`);
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
