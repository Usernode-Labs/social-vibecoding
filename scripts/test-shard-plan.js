'use strict';

// Which test files each shard of the unit suite runs: a plan made from how
// long each file takes, so the shards end together.
//
// Why. The platform runs `npm run test:shard` in TEST_SHARD=k/n Jobs at
// once (src/services/unit-suite.js), and a run waits for the last one.
// node's own `--test-shard` deals the files out by their place in the list,
// so where a file lands is chance: on 16 Oct 2026 one shard always held
// tests/bot-build-crash-postgres.test.js (≈140 s, six cores of the eight),
// beside a third of the other files, and ran 122–160 s while the other two
// ran 57–97 s. The suite's CPU was the same either way; only its wall time
// was lost.
//
// How. Every file's measured duration (seconds) and the cores it keeps busy
// (CPU-seconds per second, its child processes included) are kept in
// tests/baselines/test-durations.json, refreshed now and then by
// `npm run test:durations`. The plan takes the files longest first and
// gives each to the shard where it would end soonest. A shard's end is
// estimated from what bounds it: its longest file; its files shared over
// the CONCURRENCY processes node runs at once; and its CPU shared over the
// CPUS its Job may use. So two CPU-heavy files land apart, and a long file
// is not put with others that would wait behind it. Inside a shard the
// files run longest first. A file the baseline does not know is given the
// baseline's default: a new file costs a little balance, never a place.
//
// Every shard computes the same plan from the same commit, and the plan is
// checked to hold every test file exactly once before anything runs
// (verifyPartition); scripts/test-shard.js falls back to node's
// `--test-shard` when it cannot be made.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TESTS_DIR = 'tests';
const DURATIONS_FILE = path.join(ROOT, 'tests', 'baselines', 'test-durations.json');
// What a shard's Job runs at once: node --test runs availableParallelism()-1
// files at a time, and a Job may use 8 CPUs (src/services/unit-suite.js
// UNIT_SUITE_CPUS). Fixed here, not read from the machine, so that every
// shard, wherever it runs, makes the same plan.
const CONCURRENCY = 7;
// The CPU a shard's files are planned to use: three quarters of the 8 its
// Job may use. Planned to the full 8, the crash suite's shard took 1,116
// small files beside it, ran at 6.8 cores on average, throttled, and the
// crash suite ran out of its time budget (16 Oct 2026, worker image).
const CPUS = 6;

/** Every test file, as `tests/<name>.test.js`, in code-point order. */
function listTestFiles(root = ROOT) {
  return fs.readdirSync(path.join(root, TESTS_DIR))
    .filter((name) => name.endsWith('.test.js'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => `${TESTS_DIR}/${name}`);
}

/**
 * The baseline as `{ defaultSeconds, files: Map<file, { seconds, cores }> }`.
 * Throws when it is missing or malformed; the caller falls back.
 */
function loadDurations(file = DURATIONS_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || raw.version !== 1 || typeof raw.files !== 'object' || raw.files === null) {
    throw new Error(`${path.relative(ROOT, file)} is not a version 1 durations baseline`);
  }
  const defaultSeconds = Number(raw.defaultSeconds);
  if (!(defaultSeconds > 0)) throw new Error('the durations baseline has no defaultSeconds');
  const files = new Map();
  for (const [name, entry] of Object.entries(raw.files)) {
    const [seconds, cores] = Array.isArray(entry) ? entry : [];
    if (!(Number(seconds) >= 0) || !(Number(cores) >= 0)) throw new Error(`bad durations entry for ${name}`);
    files.set(name, { seconds: Number(seconds), cores: Number(cores) });
  }
  // What a measurement cannot see, set by hand with its reason: the cores a
  // file keeps busy in the database server, for one. A refresh keeps them.
  for (const [name, o] of Object.entries(raw.overrides || {})) {
    if (!o || !(Number(o.cores) > 0) || typeof o.why !== 'string' || !o.why.trim()) throw new Error(`bad durations override for ${name}`);
    const known = files.get(name);
    if (known) files.set(name, { ...known, cores: Number(o.cores) });
  }
  return { defaultSeconds, files };
}

/**
 * The plan: `n` lists of files, each in the order its shard runs them.
 * Deterministic for the same files, baseline and `n`.
 */
function plan(files, durations, n, { concurrency = CONCURRENCY, cpus = CPUS } = {}) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`a plan needs a whole number of shards, not ${n}`);
  const cost = (file) => {
    const known = durations.files.get(file);
    const seconds = known ? known.seconds : durations.defaultSeconds;
    // A file takes at least a slot of one process for its time; one that
    // keeps several cores busy (its children, a database) takes more CPU.
    const cores = known ? Math.max(known.cores, 0.05) : 1;
    return { file, seconds, cpu: seconds * cores };
  };
  const ordered = [...new Set(files)].map(cost)
    .sort((a, b) => (b.seconds - a.seconds) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const shards = Array.from({ length: n }, () => ({ files: [], longest: 0, slot: 0, cpu: 0 }));
  const ends = (s, c) => Math.max(Math.max(s.longest, c.seconds), (s.slot + c.seconds) / concurrency, (s.cpu + c.cpu) / cpus);
  const end = (s) => Math.max(s.longest, s.slot / concurrency, s.cpu / cpus);
  for (const c of ordered) {
    let best = 0;
    for (let i = 1; i < n; i += 1) {
      const a = ends(shards[i], c);
      const b = ends(shards[best], c);
      if (a < b - 1e-9 || (Math.abs(a - b) <= 1e-9 && end(shards[i]) < end(shards[best]) - 1e-9)) best = i;
    }
    const s = shards[best];
    s.files.push(c.file);
    s.longest = Math.max(s.longest, c.seconds);
    s.slot += c.seconds;
    s.cpu += c.cpu;
  }
  return shards.map((s) => s.files);
}

/** Throws unless the shards hold every file exactly once and nothing else. */
function verifyPartition(shards, files) {
  const want = new Set(files);
  if (want.size !== files.length) throw new Error('the test file list names a file twice');
  const seen = new Map();
  for (const [i, list] of shards.entries()) {
    for (const f of list) {
      if (!want.has(f)) throw new Error(`shard ${i + 1} holds ${f}, which is not a test file`);
      if (seen.has(f)) throw new Error(`${f} is in shard ${seen.get(f) + 1} and shard ${i + 1}`);
      seen.set(f, i);
    }
  }
  const missing = files.filter((f) => !seen.has(f));
  if (missing.length) throw new Error(`no shard holds ${missing.length} test file(s): ${missing.slice(0, 5).join(', ')}`);
  return true;
}

/** A short name for a plan, printed by every shard so the platform can tell they agree. */
function planId(shards) {
  return crypto.createHash('sha256').update(JSON.stringify(shards)).digest('hex').slice(0, 12);
}

/** `k/n` as `{ k, n }`, or null when it is not one. */
function parseShard(value) {
  const m = /^(\d+)\/(\d+)$/.exec(String(value || '').trim());
  if (!m) return null;
  const k = Number(m[1]);
  const n = Number(m[2]);
  return k >= 1 && n >= 1 && k <= n ? { k, n } : null;
}

module.exports = {
  CONCURRENCY, CPUS, DURATIONS_FILE, listTestFiles, loadDurations, plan, verifyPartition, planId, parseShard,
};
