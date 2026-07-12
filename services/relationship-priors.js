/**
 * Mild relationship → angle score priors.
 * Applied only in scoreItem — never changes Amazon fetch queues.
 *
 * Multipliers are intentionally small (clamped to 0.92–1.08) so hobbies
 * and learned signals remain the dominant ranking factors.
 */

import { loadRelationships } from './taxonomy.js';

/** Hard cap so relationship never contributes more than ~8%. */
export const RELATIONSHIP_PRIOR_MIN = 0.92;
export const RELATIONSHIP_PRIOR_MAX = 1.08;

/**
 * Per-relationship angle nudges. Unlisted angles default to 1.0.
 * Keep deltas tiny — this is a soft prior, not a filter.
 */
const RAW_PRIORS = {
  mom: { aesthetic: 1.06, experience: 1.05, social: 1.03, wildcard: 0.97 },
  dad: { skill: 1.05, consumable: 1.04, experience: 1.03, wildcard: 0.97 },
  partner: { experience: 1.06, aesthetic: 1.05, social: 1.04 },
  boyfriend: { experience: 1.06, aesthetic: 1.05, social: 1.04 },
  girlfriend: { experience: 1.06, aesthetic: 1.05, social: 1.04 },
  spouse: { experience: 1.06, aesthetic: 1.05, social: 1.04 },
  friend: { social: 1.06, wildcard: 1.03 },
  best_friend: { social: 1.07, wildcard: 1.04, experience: 1.03 },
  sibling: { social: 1.05, wildcard: 1.05 },
  grandparent: { aesthetic: 1.05, consumable: 1.04, experience: 1.03, wildcard: 0.96 },
  coworker: { consumable: 1.05, aesthetic: 1.03, wildcard: 0.94 },
  boss: { consumable: 1.05, aesthetic: 1.04, wildcard: 0.93 },
  child: { experience: 1.05, social: 1.04, skill: 1.03, wildcard: 0.97 },
  niece_nephew: { experience: 1.05, social: 1.04, wildcard: 1.02 },
  acquaintance: { consumable: 1.04, aesthetic: 1.03, wildcard: 0.95 },
  other: {},
};

function clamp(value) {
  return Math.min(RELATIONSHIP_PRIOR_MAX, Math.max(RELATIONSHIP_PRIOR_MIN, value));
}

/** Validate taxonomy keys exist; ignore unknown relationships at runtime. */
const ALLOWED = new Set(loadRelationships());

/**
 * Return a mild score multiplier for this relationship + item angle.
 * 1.0 when relationship/angle is missing or has no prior.
 */
export function relationshipAngleMultiplier(relationship, angle) {
  if (!relationship || !angle) return 1.0;
  if (!ALLOWED.has(relationship)) return 1.0;
  const priors = RAW_PRIORS[relationship];
  if (!priors) return 1.0;
  const raw = priors[angle];
  if (raw == null) return 1.0;
  return clamp(raw);
}
