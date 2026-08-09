"use strict";
/**
 * dedupe.js — group Amazon-style product listings into perceptual-duplicate buckets.
 *
 *   npm install wordpos
 *
 *   const { dedupe } = require('./dedupe');
 *   const buckets = await dedupe(items);        // items: [{ title, brand? }, ...]
 *
 * Pipeline per title:
 *   strip brand -> lowercase -> keep pure [a-z] tokens (len > 2) -> drop junk
 *   -> WordNet noun filter -> count frequency -> descend frequency tiers until
 *   >= minTokens collected -> cap at maxTokens -> sort alphabetically
 *
 * Two listings are duplicates when their signatures share >= threshold tokens.
 * Absolute shared count is used deliberately, NOT Jaccard: signatures are
 * variable length, and Jaccard swings 0.36-0.63 across pairs with identical
 * evidence purely because of length. Shared count is stable.
 */

const WordPOS = require("wordpos");

const DEFAULTS = {
  threshold: 3, // shared nouns required to call two listings duplicates
  minTokens: 3, // keep descending frequency tiers until the signature has this many
  maxTokens: 10, // hard cap on signature length
  minUsable: 2, // signatures shorter than this never match anything
  linkage: "single", // 'single' = transitive chains; 'complete' = all-pairs must match
  dictPath: null, // point at Open English WordNet 2025 WNDB dir to use a current lexicon
  explain: false, // log every pairwise comparison that clears the threshold
  junk: null, // override the default junk list
};

// Tokens that survive the noun filter but carry no product identity.
// WordNet counts several prepositions and marketing words as nouns.
const JUNK = new Set([
  "in",
  "over",
  "out",
  "pro",
  "staff",
  "oz",
  "qt",
  "lb",
  "ml",
  "gift",
  "gifts",
  "men",
  "women",
  "man",
  "woman",
  "kid",
  "kids",
  "size",
  "fit",
  "quality",
  "grade",
  "duty",
  "set",
  "pack",
  "piece",
  "use",
  "used",
  "using",
  "new",
  "day",
  "year",
  "time",
  "home",
  "house",
  "love",
  "lover",
  "idea",
  "ideas",
  "style",
  "design",
  "product",
  "item",
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Memoised WordNet noun lookup. Tokens repeat heavily across a catalogue. */
function makeNounTest(wp) {
  const cache = new Map();
  return async function isNoun(word) {
    if (cache.has(word)) return cache.get(word);
    const p = wp.isNoun(word).catch(() => false);
    cache.set(word, p);
    return p;
  };
}

/**
 * Build the noun signature for a single title.
 * Returns { signature: string[], counts: Record<string, number> }
 */
async function buildSignature(title, brand, isNoun, opts) {
  const junk = opts.junk || JUNK;
  if (!title) return { signature: [], counts: {} };

  let text = String(title);
  if (brand) {
    text = text.replace(
      new RegExp("\\b" + escapeRegex(String(brand)) + "\\b", "ig"),
      " ",
    );
  }

  const tokens = text
    .toLowerCase()
    .split(/[^a-z]+/) // drops digits, symbols, and hyphenated compounds
    .filter((w) => w.length > 2 && !junk.has(w));

  const flags = await Promise.all(tokens.map(isNoun));
  const nouns = tokens.filter((_, i) => flags[i]); // duplicates preserved — frequency matters

  const counts = {};
  for (const n of nouns) counts[n] = (counts[n] || 0) + 1;

  // Descend frequency tiers until we have enough tokens.
  // When every count is 1 there is one tier, so this takes everything — intended.
  const tiers = [...new Set(Object.values(counts))].sort((a, b) => b - a);
  let signature = [];
  for (const t of tiers) {
    signature = signature.concat(
      Object.keys(counts)
        .filter((k) => counts[k] === t)
        .sort(),
    );
    if (signature.length >= opts.minTokens) break;
  }

  return { signature: signature.slice(0, opts.maxTokens).sort(), counts };
}

/** Number of tokens two signatures share. */
function sharedCount(a, b) {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x)).length;
}

/** Union-find for single-linkage clustering. */
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => {
    const a = find(i),
      b = find(j);
    if (a !== b) parent[a] = b;
  };
  return { find, union };
}

/**
 * Group listings into duplicate buckets.
 *
 * @param {Array<{title: string, brand?: string}>} items
 * @param {object} options  see DEFAULTS
 * @returns {Promise<Array<{signature: string[], shared: string[], items: object[]}>>}
 *          Every input appears in exactly one bucket. Non-duplicates come back
 *          as buckets of length 1.
 */
async function dedupe(items, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const wp = opts.dictPath
    ? new WordPOS({ dictPath: opts.dictPath })
    : new WordPOS();
  const isNoun = makeNounTest(wp);

  const sigs = [];
  for (const item of items) {
    const { signature } = await buildSignature(
      item.title,
      item.brand,
      isNoun,
      opts,
    );
    sigs.push(signature);
  }

  const n = items.length;
  const uf = makeUnionFind(n);
  const usable = (i) => sigs[i].length >= opts.minUsable;

  for (let i = 0; i < n; i++) {
    if (!usable(i)) continue;
    for (let j = i + 1; j < n; j++) {
      if (!usable(j)) continue;
      const shared = sharedCount(sigs[i], sigs[j]);
      if (shared >= opts.threshold) {
        if (opts.linkage === "complete" && uf.find(i) === uf.find(j)) continue;
        if (opts.linkage === "complete") {
          // only merge if i matches every existing member of j's group
          const group = [];
          for (let k = 0; k < n; k++)
            if (uf.find(k) === uf.find(j)) group.push(k);
          const ok = group.every(
            (k) => sharedCount(sigs[i], sigs[k]) >= opts.threshold,
          );
          if (!ok) continue;
        }
        if (opts.explain) {
          const s = sigs[i].filter((x) => sigs[j].includes(x));
          console.log(
            `  merge [${i}] + [${j}]  shared=${shared}  {${s.join(", ")}}`,
          );
        }
        uf.union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  return [...groups.values()]
    .map((idx) => {
      const shared =
        idx.length < 2
          ? []
          : idx
              .slice(1)
              .reduce(
                (acc, i) => acc.filter((x) => sigs[i].includes(x)),
                [...sigs[idx[0]]],
              );
      return {
        signature: sigs[idx[0]],
        shared,
        items: idx.map((i) => items[i]),
      };
    })
    .sort((a, b) => b.items.length - a.items.length);
}

/** Pretty-print buckets to the console. */
function report(buckets) {
  buckets.forEach((b, i) => {
    const tag = b.items.length > 1 ? `DUPE x${b.items.length}` : "unique";
    console.log(
      `\n[${i}] ${tag}${b.shared.length ? "  shared: " + b.shared.join(" ") : ""}`,
    );
    b.items.forEach((it) =>
      console.log("     - " + String(it.title).slice(0, 78)),
    );
  });
}

module.exports = {
  dedupe,
  buildSignature,
  sharedCount,
  report,
  JUNK,
  DEFAULTS,
};
