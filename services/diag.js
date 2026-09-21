/**
 * Request-scoped latency tracing.
 *
 * Feed generation fans out across Supabase, Canopy and Claude, much of it in
 * parallel and several layers deep, so a stopwatch at any single layer can't
 * say where a slow batch went. This module carries a trace on the async context
 * instead: `runWithDiag` opens one, and anything underneath — however deep —
 * records into it without having to be passed a timer.
 *
 * Phases (`span`/`syncSpan`) build a tree you read top-to-bottom as the
 * sequence of work. Individual external calls are recorded as flat `events`
 * and aggregated per label, because a feed batch makes hundreds of them and
 * one tree node each would bury the phases.
 *
 * Disable with FEED_DIAG=false. Set FEED_DIAG_VERBOSE=true to list every
 * external call rather than just the slowest.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export const DIAG_ENABLED = (process.env.FEED_DIAG ?? 'true').toLowerCase() !== 'false';
const VERBOSE = (process.env.FEED_DIAG_VERBOSE ?? 'false').toLowerCase() === 'true';
const SLOWEST_COUNT = Number(process.env.FEED_DIAG_SLOWEST ?? 10);

/** Children summing to more than this multiple of the parent ran concurrently. */
const PARALLEL_RATIO = 1.15;

function makeNode(label, data, startMs) {
  return { label, data: { ...data }, startMs, ms: 0, children: [] };
}

/**
 * Open a trace and run `fn` inside it. Returns the value and the finished
 * trace; on throw, the trace is attached to the error as `diagTrace` so the
 * caller can still report where the time went before it failed.
 */
export async function runWithDiag(name, meta, fn) {
  if (!DIAG_ENABLED) return { result: await fn(), trace: null };

  const t0 = performance.now();
  const root = makeNode(name, {}, 0);
  const trace = {
    name,
    meta: { ...meta },
    startedAt: new Date().toISOString(),
    t0,
    root,
    events: [],
    counters: {},
    notes: {},
    error: null,
  };

  try {
    const result = await storage.run({ trace, span: root }, fn);
    return { result, trace: finish(trace) };
  } catch (err) {
    trace.error = err?.message ?? String(err);
    finish(trace);
    if (err && typeof err === 'object') err.diagTrace = trace;
    throw err;
  }
}

function finish(trace) {
  trace.totalMs = performance.now() - trace.t0;
  trace.root.ms = trace.totalMs;
  return trace;
}

/** Time an async phase, nesting anything it awaits underneath it. */
export async function span(label, fn, data = {}) {
  const store = storage.getStore();
  if (!store) return fn();

  const node = makeNode(label, data, performance.now() - store.trace.t0);
  store.span.children.push(node);
  const startedAt = performance.now();
  try {
    return await storage.run({ trace: store.trace, span: node }, fn);
  } finally {
    node.ms = performance.now() - startedAt;
  }
}

/** Time a synchronous phase. Kept separate so CPU-bound work isn't made async. */
export function syncSpan(label, fn, data = {}) {
  const store = storage.getStore();
  if (!store) return fn();

  const node = makeNode(label, data, performance.now() - store.trace.t0);
  store.span.children.push(node);
  const startedAt = performance.now();
  try {
    return storage.run({ trace: store.trace, span: node }, fn);
  } finally {
    node.ms = performance.now() - startedAt;
  }
}

/**
 * Time a leaf that can't be wrapped (a fetch, a query builder's `then`).
 * Returns the finishing function; extra data can be attached when it lands.
 */
export function startSpan(label, data = {}) {
  const store = storage.getStore();
  if (!store) return () => {};

  const node = makeNode(label, data, performance.now() - store.trace.t0);
  store.span.children.push(node);
  const startedAt = performance.now();
  return (extra = {}) => {
    node.ms = performance.now() - startedAt;
    Object.assign(node.data, extra);
  };
}

/** Record one external call. Aggregated by `kind`+`label` in the report. */
export function record(kind, label, ms, data = {}) {
  const store = storage.getStore();
  if (!store) return;
  store.trace.events.push({ kind, label, ms, ...data });
}

/** Add to a running total (call counts, bytes, wait time). */
export function count(key, n = 1) {
  const store = storage.getStore();
  if (!store) return;
  store.trace.counters[key] = (store.trace.counters[key] ?? 0) + n;
}

/** Set a single fact about this trace (pool size, batch size, verdicts). */
export function note(key, value) {
  const store = storage.getStore();
  if (!store) return;
  store.trace.notes[key] = value;
}

/** Enrich the trace header after the fact (e.g. once the profile is loaded). */
export function addMeta(meta) {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store.trace.meta, meta);
}

export function isTracing() {
  return storage.getStore() != null;
}

/**
 * Run `fn` in a fresh trace detached from any caller's.
 * Background work (`setImmediate` after a response) would otherwise keep
 * writing into a trace that has already been reported.
 */
export async function runDetached(name, meta, fn, onFinish) {
  return storage.run(undefined, async () => {
    const { result, trace } = await runWithDiag(name, meta, fn);
    if (trace && onFinish) onFinish(trace);
    return result;
  });
}

// ── Reporting ─────────────────────────────────────────────

function aggregateEvents(events) {
  const byLabel = new Map();
  for (const e of events) {
    const key = `${e.kind}:${e.label}`;
    let agg = byLabel.get(key);
    if (!agg) {
      agg = { kind: e.kind, label: e.label, calls: 0, totalMs: 0, maxMs: 0 };
      byLabel.set(key, agg);
    }
    agg.calls += 1;
    agg.totalMs += e.ms;
    agg.maxMs = Math.max(agg.maxMs, e.ms);
  }
  return [...byLabel.values()].sort((a, b) => b.totalMs - a.totalMs);
}

const ms = (n) => `${Math.round(n).toLocaleString()}ms`;

function pad(value, width, align = 'right') {
  const s = String(value);
  if (s.length >= width) return s;
  const fill = ' '.repeat(width - s.length);
  return align === 'right' ? fill + s : s + fill;
}

function formatData(data) {
  const parts = [];
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v == null || v === '') continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return parts.length > 0 ? `  ${parts.join(' ')}` : '';
}

function renderTree(node, totalMs, depth, lines) {
  const share = totalMs > 0 ? (node.ms / totalMs) * 100 : 0;
  const childSum = node.children.reduce((sum, c) => sum + c.ms, 0);
  const parallel = node.children.length > 1 && childSum > node.ms * PARALLEL_RATIO;

  lines.push(
    `${pad(ms(node.ms), 10)} ${pad(share.toFixed(1) + '%', 6)}  ` +
    `${'  '.repeat(depth)}${node.label}${parallel ? ' [parallel]' : ''}` +
    formatData(node.data),
  );

  for (const child of node.children) {
    renderTree(child, totalMs, depth + 1, lines);
  }

  // Time inside this phase that no child span covers — usually queries (which
  // are recorded as external calls, not spans) or plain unmeasured work. Shown
  // so the tree visibly accounts for the whole duration.
  const residual = node.ms - childSum;
  if (!parallel && node.children.length > 0 && residual > Math.max(50, totalMs * 0.02)) {
    lines.push(
      `${pad(ms(residual), 10)} ${pad(((residual / totalMs) * 100).toFixed(1) + '%', 6)}  ` +
      `${'  '.repeat(depth + 1)}(elsewhere in ${node.label} — see external calls)`,
    );
  }
}

/** Human-readable report. Written with console.log so newlines survive pino. */
export function formatTrace(trace) {
  if (!trace) return '';

  const width = 78;
  const rule = '─'.repeat(width);
  const lines = [rule, `FEED DIAG  ${trace.name}  —  total ${ms(trace.totalMs)}`];

  const meta = formatData(trace.meta).trim();
  if (meta) lines.push(meta);
  if (trace.error) lines.push(`FAILED: ${trace.error}`);

  lines.push(rule, `${pad('elapsed', 10)} ${pad('share', 6)}  phase`);
  renderTree(trace.root, trace.totalMs, 0, lines);

  const aggregates = aggregateEvents(trace.events);
  if (aggregates.length > 0) {
    lines.push(rule, 'EXTERNAL CALLS (aggregated — these overlap, so totals exceed wall time)');
    lines.push(
      `${pad('calls', 6)} ${pad('total', 10)} ${pad('avg', 8)} ${pad('max', 9)}  target`,
    );
    for (const a of aggregates) {
      lines.push(
        `${pad(a.calls, 6)} ${pad(ms(a.totalMs), 10)} ` +
        `${pad(ms(a.totalMs / a.calls), 8)} ${pad(ms(a.maxMs), 9)}  ${a.kind} ${a.label}`,
      );
    }
  }

  const counters = Object.entries(trace.counters);
  if (counters.length > 0) {
    lines.push(rule, 'COUNTERS');
    for (const [key, value] of counters.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${pad(Math.round(value).toLocaleString(), 8)}  ${key}`);
    }
  }

  const notes = Object.entries(trace.notes);
  if (notes.length > 0) {
    lines.push(rule, 'DETAIL');
    for (const [key, value] of notes) {
      lines.push(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
  }

  const slowest = [...trace.events].sort((a, b) => b.ms - a.ms);
  const shown = VERBOSE ? slowest : slowest.slice(0, SLOWEST_COUNT);
  if (shown.length > 0) {
    lines.push(rule, VERBOSE ? 'ALL EXTERNAL CALLS' : `SLOWEST ${shown.length} EXTERNAL CALLS`);
    for (const e of shown) {
      const { kind, label, ms: took, ...rest } = e;
      lines.push(`  ${pad(ms(took), 9)}  ${kind} ${label}${formatData(rest)}`);
    }
  }

  lines.push(rule);
  return lines.join('\n');
}

/** Compact, JSON-safe summary for the HTTP response body. */
export function summarizeTrace(trace) {
  if (!trace) return null;
  return {
    name: trace.name,
    total_ms: Math.round(trace.totalMs),
    phases: trace.root.children.map((c) => ({
      label: c.label,
      ms: Math.round(c.ms),
    })),
    external: aggregateEvents(trace.events).map((a) => ({
      target: `${a.kind} ${a.label}`,
      calls: a.calls,
      total_ms: Math.round(a.totalMs),
      max_ms: Math.round(a.maxMs),
    })),
    counters: Object.fromEntries(
      Object.entries(trace.counters).map(([k, v]) => [k, Math.round(v)]),
    ),
    notes: trace.notes,
  };
}

/** Print the report. Always console.log — pino would escape the newlines. */
export function reportTrace(trace) {
  if (!trace) return;
  console.log(`\n${formatTrace(trace)}`);
}
