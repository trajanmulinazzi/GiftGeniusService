/**
 * Database connection — Supabase JS client (HTTPS, no direct PG needed).
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { DIAG_ENABLED, record } from '../services/diag.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

let _supabase = null;

/**
 * Time every query without touching call sites.
 *
 * Supabase builders are lazy thenables: the HTTPS request goes out when `then`
 * is called, so that's where the clock starts. Chained modifiers (`eq`, `single`,
 * …) hand back a thenable too, so the wrapper reapplies itself to keep the label
 * attached all the way to the await. Methods are invoked with the raw builder as
 * receiver so private fields keep working.
 *
 * Queries are recorded as events rather than tree spans — a feed batch runs a
 * couple of hundred, and the per-label aggregate is the readable form.
 */
function instrument(builder, label) {
  return new Proxy(builder, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);

      if (prop === 'then' && typeof value === 'function') {
        return (onFulfilled, onRejected) => {
          const startedAt = performance.now();
          let settled = false;
          const stop = (res) => {
            if (settled) return;
            settled = true;
            record('db', label, performance.now() - startedAt, {
              rows: Array.isArray(res?.data) ? res.data.length : res?.data ? 1 : 0,
              error: res?.error?.message ?? undefined,
            });
          };
          return Reflect.apply(value, target, [
            (res) => {
              stop(res);
              return onFulfilled ? onFulfilled(res) : res;
            },
            (err) => {
              stop({ error: { message: err?.message ?? String(err) } });
              if (onRejected) return onRejected(err);
              throw err;
            },
          ]);
        };
      }

      if (typeof value === 'function') {
        return (...args) => {
          const out = Reflect.apply(value, target, args);
          const chainable = out && typeof out === 'object' && typeof out.then === 'function';
          return chainable ? instrument(out, label) : out;
        };
      }

      return value;
    },
  });
}

function instrumentClient(client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'from') {
        return (table) => instrument(target.from(table), table);
      }
      if (prop === 'rpc') {
        return (fn, args, opts) => instrument(target.rpc(fn, args, opts), `rpc.${fn}`);
      }
      return Reflect.get(target, prop, target);
    },
  });
}

export function getDb() {
  if (_supabase) return _supabase;
  const client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  _supabase = DIAG_ENABLED ? instrumentClient(client) : client;
  return _supabase;
}
