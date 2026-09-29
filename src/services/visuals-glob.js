'use strict';

// The dapp.json visual-impact glob matcher.
//
// dapp.json visual scenarios use a deliberately small git-glob dialect:
// `*` and `?` stay inside one path segment; `**` may cross directories.
// That is enough for ownership-shaped declarations such as
// `frontend/src/features/settings/**` without adding a transitive glob
// package to the platform's runtime surface.
//
// #2512 — WHY THIS IS NOT A REGEX ANY MORE.
//
// This used to compile the glob to a RegExp and call `.test()`. The dialect
// is fine; the compilation was not. Each `**` became an unbounded `.*`, so a
// pattern like `a**b**c**d**e**f**g**h**i` compiled to nine unanchored runs
// in a row. When the candidate does NOT match, JS's backtracking engine has
// to try every way of splitting the string between those runs — O(len^stars).
// Measured on the real function at the base commit: eight `**` pairs against
// a 62-character path took **72 seconds** of wall clock.
//
// That is not a slow match, it is a halted platform. `visualImpactMatches` is
// called from `selectVisualScenarios`, which runs inside the proposal check
// pipeline on the platform's single Node event loop — and the patterns come
// from `resolveDeclaredTests`, which reads dapp.json off THE PROPOSAL'S OWN
// BRANCH. Anyone who can open a proposal on any app chooses these strings.
// Nothing else is served while the regex spins.
//
// Capping the pattern length or the star count does not fix it: the cost is
// exponential in the stars, so even four of them against a long path is
// billions of steps. The fix has to remove the backtracking, so the matcher
// below is an NFA simulation instead.
//
// HOW IT WORKS. The glob is compiled once into a flat list of atoms, each of
// which is one of:
//
//   lit   a literal character
//   qm    `?`        — one character that is not `/`
//   star  `*`        — zero or more characters, none of them `/`
//   any   `**`       — zero or more of anything (not `\n`; see below)
//   dirs  `**/`      — zero or more whole directories, or nothing
//
// Matching walks the atoms once, carrying a SET of candidate positions that
// are still alive rather than one position plus a backtrack stack. Because a
// position is either in the set or not, work is bounded by
// O(atoms x candidate length) — there is no configuration to revisit and so
// nothing to blow up. The same eight-star pattern now answers in well under a
// millisecond.
//
// Each wildcard step is written as a single forward sweep whose cursor never
// moves backwards, which keeps one step O(len) rather than O(len^2).
//
// EXACT EQUIVALENCE WITH THE OLD REGEX is the requirement, not merely
// "close enough" — dapp.json files in the wild already carry impact globs and
// a check that silently stops matching is worse than a slow one.
// `tests/visual-impact-glob.test.js` pins that by differential fuzzing: it
// rebuilds the old regex from the same glob and asserts the two agree on
// thousands of generated glob/path pairs. Two details of the old behaviour
// that are easy to lose and are therefore deliberate here:
//
//   - `.` in a JS regex does not match a LINE TERMINATOR, so `**` and `**/`
//     stop at one. There are FOUR of them, not one: `\n`, `\r`, U+2028 and
//     U+2029 (`isTerminator` below). Stopping at `\n` alone is the mistake
//     this comment exists to prevent — it makes `**` match `a\r`, which the
//     old regex refused. A line terminator in a path is pathological, but it
//     is the old behaviour, and the fuzzer generates all four.
//   - `**` NOT followed by `/` compiled to a bare `.*`, which crosses `/`.
//     So `frontend/**.tsx` matches `frontend/a/b.tsx`. That is looser than
//     the doc comment suggests, and it is preserved as-is: tightening it is a
//     dialect change, not a DoS fix, and would belong in its own proposal.

// The characters a JS regex `.` will not match. All four, deliberately: the
// first version of this module stopped at `\n` only, and `**` then matched
// `a\r` where the old regex did not.
function isTerminator(ch) {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

const LIT = 0;
const QM = 1;
const STAR = 2;
const ANY = 3;
const DIRS = 4;

// Compile a glob into the atom list described above. Separate from the match
// so a caller matching many candidates against one pattern pays for this once
// (the cache below is what actually uses that).
function compileGlob(glob) {
  const atoms = [];
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          atoms.push({ t: DIRS });
        } else {
          atoms.push({ t: ANY });
        }
      } else {
        atoms.push({ t: STAR });
      }
    } else if (ch === '?') {
      atoms.push({ t: QM });
    } else {
      atoms.push({ t: LIT, c: ch });
    }
  }
  return atoms;
}

// dapp.json is read from an untrusted branch, and one proposal declares many
// checks against many changed files, so the same handful of patterns is
// compiled over and over. A small bounded cache keeps that off the hot path
// without letting a hostile manifest grow the map without limit — past the
// cap it simply stops caching rather than evicting, because the cost being
// avoided is small and predictable either way.
const MAX_CACHED_GLOBS = 512;
const compiled = new Map();
function atomsFor(glob) {
  const hit = compiled.get(glob);
  if (hit) return hit;
  const atoms = compileGlob(glob);
  if (compiled.size < MAX_CACHED_GLOBS) compiled.set(glob, atoms);
  return atoms;
}

function visualImpactMatches(pattern, file) {
  const glob = String(pattern == null ? '' : pattern).replace(/\\/g, '/');
  const candidate = String(file == null ? '' : file).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!glob || !candidate) return false;

  const atoms = atomsFor(glob);
  const len = candidate.length;

  // `cur[p]` — position p in the candidate is reachable having consumed every
  // atom so far. Anchored at both ends: we start only at 0, and accept only
  // if `len` survives to the end.
  let cur = new Uint8Array(len + 1);
  let next = new Uint8Array(len + 1);
  cur[0] = 1;
  let alive = true;

  for (let a = 0; a < atoms.length && alive; a++) {
    const atom = atoms[a];
    next.fill(0);
    alive = false;

    if (atom.t === LIT) {
      const c = atom.c;
      for (let p = 0; p < len; p++) {
        if (cur[p] && candidate[p] === c) { next[p + 1] = 1; alive = true; }
      }
    } else if (atom.t === QM) {
      for (let p = 0; p < len; p++) {
        if (cur[p] && candidate[p] !== '/') { next[p + 1] = 1; alive = true; }
      }
    } else if (atom.t === STAR) {
      // `[^/]*` — zero or more non-slash characters. Every live position
      // stays live, and each one extends forward to the end of its segment.
      // `i` only ever moves forward: a run started at an earlier position
      // covers everything a later one inside it would, and a run always stops
      // at the same `/`.
      let i = 0;
      for (let p = 0; p <= len; p++) {
        if (!cur[p]) continue;
        next[p] = 1; alive = true;
        if (p > i) i = p;
        while (i < len && candidate[i] !== '/') { next[i + 1] = 1; i++; }
      }
    } else if (atom.t === ANY) {
      // `.*` — zero or more of anything except a line terminator, which is
      // where the old regex's `.` stopped.
      let i = 0;
      for (let p = 0; p <= len; p++) {
        if (!cur[p]) continue;
        next[p] = 1; alive = true;
        if (p > i) i = p;
        while (i < len && !isTerminator(candidate[i])) { next[i + 1] = 1; i++; }
      }
    } else { // DIRS
      // `(?:.*/)?` — either nothing, or any run ending at a `/`. Same forward
      // sweep, marking the position AFTER each slash it passes.
      let i = 0;
      for (let p = 0; p <= len; p++) {
        if (!cur[p]) continue;
        next[p] = 1; alive = true;
        if (p > i) i = p;
        while (i < len && !isTerminator(candidate[i])) {
          if (candidate[i] === '/') next[i + 1] = 1;
          i++;
        }
      }
    }

    const swap = cur; cur = next; next = swap;
  }

  return !!cur[len];
}

module.exports = { visualImpactMatches, compileGlob, MAX_CACHED_GLOBS };
