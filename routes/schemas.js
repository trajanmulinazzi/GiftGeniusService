/**
 * Zod validation schemas for all route inputs.
 */

import { z } from 'zod';

const uuid = z.string().uuid();

// ── Profiles ─────────────────────────────────────────────
export const createProfileSchema = z.object({
  label: z.string().min(1).max(100),
  hobby_ids: z.array(uuid).min(1).max(20),
  budget_min: z.number().int().min(0),
  budget_max: z.number().int().min(1),
}).refine(d => d.budget_max > d.budget_min, {
  message: 'budget_max must be greater than budget_min',
});

export const updateProfileSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  hobby_ids: z.array(uuid).min(1).max(20).optional(),
  budget_min: z.number().int().min(0).optional(),
  budget_max: z.number().int().min(1).optional(),
}).refine(d => {
  if (d.budget_min !== undefined && d.budget_max !== undefined) {
    return d.budget_max > d.budget_min;
  }
  return true;
}, { message: 'budget_max must be greater than budget_min' });

// ── Sessions ─────────────────────────────────────────────
const OCCASIONS = ['birthday', 'christmas', 'mothers_day', 'fathers_day', 'anniversary', 'graduation', 'housewarming', 'just_because'];

export const createSessionSchema = z.object({
  profile_id: uuid,
  occasion: z.enum(OCCASIONS),
});

// ── Feed ─────────────────────────────────────────────────
const SIGNALS = ['skip', 'save', 'shop_now', 'dislike'];

export const signalSchema = z.object({
  feed_event_id: uuid,
  signal: z.enum(SIGNALS),
});

// ── Admin ────────────────────────────────────────────────
export const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
});

export const addHobbiesSchema = z.object({
  hobbies: z.array(z.object({
    name: z.string().min(1).max(100),
    slug: z.string().min(1).max(100).optional(),
  })).min(1),
});

// ── Auth ─────────────────────────────────────────────────
export const authTokenSchema = z.object({
  user_id: uuid,
});

// ── Helpers ──────────────────────────────────────────────
export function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const err = new Error('Validation failed');
    err.statusCode = 400;
    err.validation = result.error.issues.map(i => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    throw err;
  }
  return result.data;
}
