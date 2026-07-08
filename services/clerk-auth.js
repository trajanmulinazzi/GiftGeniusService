/**
 * Clerk session-token verification + backend user resolution.
 *
 * The mobile app authenticates with Clerk and sends Clerk's short-lived
 * session JWT as `Authorization: Bearer <token>`. We verify that token against
 * Clerk's public JWKS (RS256) — no Clerk secret key required — then map the
 * verified Clerk user id (`sub`) to a row in our own `users` table, creating
 * one on first sight. `request.user.id` is always our backend UUID.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getDb } from '../db/index.js';

// ── Issuer / JWKS resolution ──────────────────────────────
/** Derive the Clerk Frontend API host from a publishable key. */
function hostFromPublishableKey(pk) {
  if (!pk) return null;
  const encoded = pk.replace(/^pk_(test|live)_/, '');
  try {
    // Clerk encodes "<host>$" in base64.
    return Buffer.from(encoded, 'base64').toString('utf-8').replace(/\$$/, '');
  } catch {
    return null;
  }
}

function resolveIssuer() {
  if (process.env.CLERK_ISSUER) return process.env.CLERK_ISSUER.replace(/\/+$/, '');
  const host = hostFromPublishableKey(process.env.CLERK_PUBLISHABLE_KEY);
  return host ? `https://${host}` : null;
}

const ISSUER = resolveIssuer();
const JWKS_URL =
  process.env.CLERK_JWKS_URL || (ISSUER ? `${ISSUER}/.well-known/jwks.json` : null);

let _jwks = null;
function getJwks() {
  if (!JWKS_URL) {
    throw new Error(
      'Clerk auth is not configured. Set CLERK_PUBLISHABLE_KEY (or CLERK_ISSUER / CLERK_JWKS_URL) in the engine environment.'
    );
  }
  if (!_jwks) {
    // Caches and rotates signing keys automatically.
    _jwks = createRemoteJWKSet(new URL(JWKS_URL));
  }
  return _jwks;
}

export function isClerkConfigured() {
  return !!JWKS_URL;
}

// ── Token verification ────────────────────────────────────
/**
 * Verify a Clerk session token. Throws on invalid/expired tokens.
 * Returns the decoded payload (includes `sub`, optional `email`/`name`).
 */
export async function verifyClerkToken(token) {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: ISSUER || undefined,
    // Tolerate small clock differences between device and server.
    clockTolerance: 10,
  });
  if (!payload.sub) {
    throw new Error('Token missing subject claim');
  }
  return payload;
}

// ── Backend user resolution (get-or-create) ───────────────
const userCache = new Map(); // clerk_user_id -> { id, clerk_user_id, email, name }

/**
 * Map a verified Clerk identity to our backend user row, creating it on first
 * sight. `profile` may carry name/email harvested from the client to enrich a
 * freshly created row (display only — identity comes from the verified token).
 */
export async function resolveBackendUser(clerkUserId, profile = {}) {
  const cached = userCache.get(clerkUserId);
  if (cached) return cached;

  const sb = getDb();

  const { data: existing } = await sb
    .from('users')
    .select('id, clerk_user_id, email, name')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();

  if (existing) {
    userCache.set(clerkUserId, existing);
    return existing;
  }

  const insert = {
    clerk_user_id: clerkUserId,
    name: profile.name?.trim() || 'GiftGenius User',
    email: profile.email?.trim() || null,
  };

  const { data: created, error } = await sb
    .from('users')
    .insert(insert)
    .select('id, clerk_user_id, email, name')
    .single();

  if (created) {
    userCache.set(clerkUserId, created);
    return created;
  }

  // Lost an insert race (or unique email clash) — re-read by clerk id.
  if (error) {
    const { data: retry } = await sb
      .from('users')
      .select('id, clerk_user_id, email, name')
      .eq('clerk_user_id', clerkUserId)
      .maybeSingle();
    if (retry) {
      userCache.set(clerkUserId, retry);
      return retry;
    }
    // Email collision fallback: insert without the conflicting email.
    if (insert.email) {
      const { data: noEmail } = await sb
        .from('users')
        .insert({ clerk_user_id: clerkUserId, name: insert.name })
        .select('id, clerk_user_id, email, name')
        .single();
      if (noEmail) {
        userCache.set(clerkUserId, noEmail);
        return noEmail;
      }
    }
    throw new Error(`Could not provision user: ${error.message}`);
  }

  throw new Error('Could not provision user');
}

/** Update display fields (name/email) for an existing user, refreshing cache. */
export async function updateBackendUserProfile(clerkUserId, { name, email }) {
  const sb = getDb();
  const updates = { updated_at: new Date().toISOString() };
  if (name?.trim()) updates.name = name.trim();
  if (email?.trim()) updates.email = email.trim();

  const { data, error } = await sb
    .from('users')
    .update(updates)
    .eq('clerk_user_id', clerkUserId)
    .select('id, clerk_user_id, email, name')
    .maybeSingle();

  // Ignore unique-email clashes — display enrichment is best-effort.
  if (!error && data) userCache.set(clerkUserId, data);
  return data ?? userCache.get(clerkUserId) ?? null;
}
