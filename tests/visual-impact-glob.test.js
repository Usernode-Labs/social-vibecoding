'use strict';

// #2512, part 1: `visualImpactMatches` compiled dapp.json impact globs to a
// RegExp, turning every `**` into an unbounded `.*`. A pattern with several
// of them costs O(len^stars) when it fails to match, and the patterns come
// from `resolveDeclaredTests` — which reads dapp.json off THE PROPOSAL'S OWN
// BRANCH. Anyone who can open a proposal picks the string, and the match runs
// on the platform's single event loop inside the check pipeline.
//
// Measured against the implementation at the base commit: eight `**` pairs
// versus a 62-character path took 72 SECONDS. Nothing else is served in that
// time.
//
// Two things have to be true of the replacement, and this file asserts both:
//
//   1. It is fast on the hostile input (the DoS is gone).
//   2. It answers EXACTLY what the old regex answered (no check silently
//      stops matching). That is the bulk of this file: `oldMatcher` below is
//      the base-commit implementation kept verbatim as an oracle, and the
//      fuzz tests assert agreement over thousands of generated pairs.
//
// Run with: node --test tests/visual-impact-glob.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { visualImpactMatches } = require('../src/services/visuals-glob');
const visuals = require('../src/services/visuals');

// ── The oracle ─────────────────────────────────────────────────────────
//
// The base-commit body of visualImpactMatches, copied character for
// character. It is only ever called here on SHORT, star-poor inputs, so it
// never hits its own pathological case. Do not "clean this up" — its value
// is that it is the old code, not that it is nice code.
function oldMatcher(pattern, file) {
  const glob = String(pattern || '').replace(/\\/g, '/');
  const candidate = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!glob || !candidate) return false;
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  try { return new RegExp(`${source}$`).test(candidate); } catch { return false; }
}

// ── 1. The DoS itself ──────────────────────────────────────────────────

test('a pattern packed with ** answers immediately', () => {
  // On the old implementation this is the 72-second case. Sixteen pairs
  // rather than eight, so the margin is not luck: each extra pair multiplied
  // the old cost, and this returns in microseconds.
  const glob = `a${'**'.repeat(16)}b`;
  const candidate = `a${'a'.repeat(60)}c`;
  const started = process.hrtime.bigint();
  const answer = visualImpactMatches(glob, candidate);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(answer, false, 'and it is still the RIGHT answer, not a bail-out');
  assert.ok(ms < 100, `took ${ms.toFixed(1)}ms; the old matcher took ~72000ms`);
});

test('the pathological shape stays cheap as the candidate grows', () => {
  // The old cost was exponential in the stars and polynomial in the length.
  // This asserts the surviving growth is mild: 4x the path for well under
  // 20x the time.
  const glob = `a${'**'.repeat(12)}b`;
  const time = (n) => {
    const candidate = `a${'a'.repeat(n)}c`;
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) visualImpactMatches(glob, candidate);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  const short = Math.max(time(64), 0.5);
  const long = time(256);
  assert.ok(long < short * 20, `64ch ${short.toFixed(1)}ms vs 256ch ${long.toFixed(1)}ms`);
});

// ── 2. Equivalence with the old regex ──────────────────────────────────

// The dialect's own documented cases, stated directly rather than generated,
// so a reader can see what the matcher is supposed to do.
const TABLE = [
  ['frontend/src/features/settings/**', 'frontend/src/features/settings/index.tsx', true],
  ['frontend/src/features/settings/**', 'frontend/src/features/settings/a/b/c.tsx', true],
  ['frontend/src/features/settings/**', 'frontend/src/features/other/index.tsx', false],
  ['frontend/**/profile-?.tsx', 'frontend/a/profile-x.tsx', true],
  ['frontend/**/profile-?.tsx', 'frontend/profile-x.tsx', true],
  ['frontend/**/profile-?.tsx', 'frontend/a/b/profile-x.tsx', true],
  ['frontend/**/profile-?.tsx', 'frontend/a/profile-xy.tsx', false],
  ['frontend/*/profile.tsx', 'frontend/a/profile.tsx', true],
  ['frontend/*/profile.tsx', 'frontend/a/b/profile.tsx', false],
  ['*.js', 'app.js', true],
  ['*.js', 'src/app.js', false],
  ['src/*.js', 'src/app.js', true],
  ['?', 'a', true],
  ['?', '/', false],
  // `**` not followed by `/` compiled to a bare `.*`, which DOES cross a
  // slash. Preserved deliberately — see the module comment.
  ['frontend/**.tsx', 'frontend/a/b.tsx', true],
  // Backslashes are normalized to `/` on both sides before matching.
  ['src/**', 'src\\a\\b.js', true],
  // A leading `./` is stripped from the candidate only.
  ['src/app.js', './src/app.js', true],
  // Regex metacharacters in a glob are literals.
  ['src/a+b.js', 'src/a+b.js', true],
  ['src/a+b.js', 'src/aab.js', false],
  ['src/(x).js', 'src/(x).js', true],
  ['a.b', 'axb', false],
  // A JS regex `.` matches none of the four line terminators, so `**` stops
  // at each one. Stated explicitly because handling only `\n` is the easy
  // mistake and the fuzzer alone would make the reason hard to read.
  ['**', 'a\n', false],
  ['**', 'a\r', false],
  ['**', 'a\u2028', false],
  ['**', 'a\u2029', false],
  ['**/a', 'x\r/a', false],
  ['**/a', 'x/a', true],
  // `*` is `[^/]*`, which has no terminator rule at all — it crosses them.
  ['a*', 'a\n', true],
  // Empty inputs are never a match.
  ['', 'src/app.js', false],
  ['src/**', '', false],
];

test('the documented dialect behaves, and matches the old regex', () => {
  for (const [glob, file, expected] of TABLE) {
    assert.equal(visualImpactMatches(glob, file), expected,
      `${JSON.stringify(glob)} vs ${JSON.stringify(file)}`);
    assert.equal(oldMatcher(glob, file), expected,
      `oracle disagrees on ${JSON.stringify(glob)} vs ${JSON.stringify(file)} — the table is wrong`);
  }
});

// A deterministic PRNG, so a failure is reproducible from the seed printed
// in the assertion message rather than being a coin toss in CI.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

// A small alphabet on purpose: matches are only interesting when the pattern
// and the candidate collide often, and `/`, `.` and `\n` are the characters
// with special meaning in the dialect.
const GLOB_ALPHABET = ['a', 'b', '/', '.', '*', '**', '**/', '?', '-', '+'];
// All four JS line terminators, not just `\n`. The first version of this
// corpus carried `\n` alone and therefore missed a real divergence: `**`
// matched `a\r`, which the old regex refused. A fuzzer is only as good as
// the characters it knows are special.
const PATH_ALPHABET = ['a', 'b', '/', '.', '-', '+', '\n', '\r', '\u2028', '\u2029'];

function pick(next, list) { return list[Math.floor(next() * list.length)]; }

test('fuzz: the new matcher agrees with the old regex everywhere', () => {
  let checked = 0;
  let matched = 0;
  for (let seed = 1; seed <= 4000; seed++) {
    const next = rng(seed * 2654435761);
    let glob = '';
    for (let i = 0; i < 1 + Math.floor(next() * 7); i++) glob += pick(next, GLOB_ALPHABET);
    let file = '';
    for (let i = 0; i < 1 + Math.floor(next() * 10); i++) file += pick(next, PATH_ALPHABET);

    const expected = oldMatcher(glob, file);
    const actual = visualImpactMatches(glob, file);
    assert.equal(actual, expected,
      `seed ${seed}: glob ${JSON.stringify(glob)} vs file ${JSON.stringify(file)}`);
    checked++;
    if (expected) matched++;
  }
  assert.equal(checked, 4000);
  // A fuzzer that never matches proves nothing, so pin that both answers
  // actually occur in the corpus.
  assert.ok(matched > 200, `only ${matched} of ${checked} pairs matched — corpus too sparse`);
  assert.ok(matched < checked - 200, `${matched} of ${checked} matched — corpus too dense`);
});

test('fuzz: realistic repository paths against ownership-shaped globs', () => {
  const DIRS = ['frontend', 'src', 'public', 'features', 'settings', 'js', 'admin'];
  const FILES = ['index.tsx', 'app.js', 'browse.js', 'profile-a.tsx', 'notes.md'];
  let matched = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    const next = rng(seed * 40503);
    const depth = 1 + Math.floor(next() * 4);
    const parts = [];
    for (let i = 0; i < depth; i++) parts.push(pick(next, DIRS));
    const file = `${parts.join('/')}/${pick(next, FILES)}`;

    // Build the glob from the same vocabulary so hits are common.
    const gdepth = 1 + Math.floor(next() * 3);
    const gparts = [];
    for (let i = 0; i < gdepth; i++) {
      const r = next();
      gparts.push(r < 0.2 ? '**' : r < 0.35 ? '*' : pick(next, DIRS));
    }
    const tail = next() < 0.5 ? '**' : pick(next, FILES);
    const glob = `${gparts.join('/')}/${tail}`;

    const expected = oldMatcher(glob, file);
    assert.equal(visualImpactMatches(glob, file), expected,
      `seed ${seed}: glob ${JSON.stringify(glob)} vs file ${JSON.stringify(file)}`);
    if (expected) matched++;
  }
  assert.ok(matched > 100, `only ${matched} of 2000 realistic pairs matched`);
});

// ── 3. The wiring ──────────────────────────────────────────────────────

test('visuals.js still exports the matcher its callers import', () => {
  assert.equal(typeof visuals.visualImpactMatches, 'function');
  assert.equal(visuals.visualImpactMatches, visualImpactMatches,
    'selectVisualScenarios must call the fixed matcher, not a stale copy');
});

test('the compiled-glob cache is bounded', () => {
  const { MAX_CACHED_GLOBS } = require('../src/services/visuals-glob');
  assert.ok(Number.isInteger(MAX_CACHED_GLOBS) && MAX_CACHED_GLOBS > 0);
  // A hostile manifest declaring thousands of distinct patterns must not grow
  // the process's memory without limit.
  for (let i = 0; i < MAX_CACHED_GLOBS * 3; i++) visualImpactMatches(`p${i}/**`, 'p0/x.js');
  assert.equal(visualImpactMatches('p0/**', 'p0/x.js'), true, 'still correct past the cap');
  assert.equal(visualImpactMatches('p9999/**', 'p0/x.js'), false);
});
