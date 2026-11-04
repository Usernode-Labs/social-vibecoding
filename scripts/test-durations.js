#!/usr/bin/env node
'use strict';

// `npm run test:durations`: measure every test file and rewrite
// tests/baselines/test-durations.json, the baseline the unit suite's shard
// plan is made from (scripts/test-shard-plan.js).
//
// A new test file brings its own entry: `--add` writes it with the default
// seconds and lists it as unmeasured, so it costs balance, not correctness.
// A full refresh completes the tree the same way: a test file it did not
// time gets the default and is listed as unmeasured, so a baseline written
// on a branch cut before a new test file merged still names every file.
// Run a full refresh now and then, not on every change, to replace those
// placeholders with measured times: a plan made from durations a few weeks
// old still balances well. Run it where the suite runs, for numbers that
// mean the same thing: the worker image with 8 CPUs (one shard's Job), with
// PostgreSQL up on 127.0.0.1:5432, or the *-postgres suites skip and look
// free. A run on another machine (fewer than 8 CPUs, or no PostgreSQL) writes
// nothing and says why; --force "<reason>" overrides the refusal and records
// the reason in the baseline's measured line. `--add` is exempt: it writes no
// measurements, so it works anywhere. It runs the whole suite once, as one
// `node --test` with the `test` script's flags, and records for each file its
// wall time and the CPU of its process and every process it started
// (tests/lib/test-timing.js).
//
//   node scripts/test-durations.js            run the suite, then write the baseline
//   node scripts/test-durations.js --from F   write it from an earlier run's records
//   node scripts/test-durations.js --add a,b  add entries for new test files, at the default
//   node scripts/test-durations.js --add      add an entry for every test file missing one
//   node scripts/test-durations.js --force "why"   write even on the wrong machine

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testCommand } = require('./test-changed');
const shardPlan = require('./test-shard-plan');

const ROOT = path.join(__dirname, '..');
// The machine the numbers must describe: the worker image one shard's Job
// runs, with the tests' PostgreSQL up. Measured anywhere else they are not
// comparable, and the shard plan balances on them (a 2-CPU measurement once
// put defaultSeconds at 1.3 s against 0.4 s, and a 33 s file at 131 s).
const REQUIRED_CPUS = 8;

/** `{ host, port }` of the tests' PostgreSQL, from the test DSN, else the local default. */
function databaseTarget(env = process.env) {
  const raw = env.TEST_DATABASE_URL || env.DATABASE_URL || '';
  try {
    const url = new URL(raw);
    if (url.hostname) return { host: url.hostname, port: Number(url.port) || 5432 };
  } catch { /* not a connection URL: the local default below */ }
  return { host: '127.0.0.1', port: 5432 };
}

/** Whether something accepts a TCP connection at `{ host, port }` within `timeoutMs`. */
function postgresReachable({ host, port }, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Why this machine's numbers would not mean what the worker image's do, or
 * null when they would. `cpus` and `postgres` are probes so a test can answer
 * for a machine it does not run on; the database target comes from the test DSN.
 */
async function measurementMachineProblem({ cpus = os.availableParallelism(), postgres = postgresReachable, target = databaseTarget() } = {}) {
  const problems = [];
  if (!(cpus >= REQUIRED_CPUS)) problems.push(`only ${cpus} of the ${REQUIRED_CPUS} CPUs the worker image has are available`);
  if (!(await postgres(target))) problems.push(`PostgreSQL is not reachable at ${target.host}:${target.port}`);
  if (!problems.length) return null;
  return `refusing to write the durations baseline: ${problems.join(', and ')}. `
    + `It is measured where the suite runs, the worker image with ${REQUIRED_CPUS} CPUs (one shard's Job) and PostgreSQL up. `
    + 'Nothing was written. Run it there, or pass --force "<why these numbers still describe that machine>" to write it anyway.';
}

/** `--force <reason>` out of the arguments: `{ argv, reason }`. */
function parseForce(argv) {
  const at = argv.indexOf('--force');
  if (at === -1) return { argv, reason: null };
  const reason = String(argv[at + 1] || '').trim();
  if (!reason) throw new Error('--force needs a reason: --force "why these numbers still describe the worker image"');
  return { argv: argv.filter((_, i) => i !== at && i !== at + 1), reason };
}

/** `{ file: [seconds, cores] }` from the preload's records (each process's last line wins). */
function summarise(text) {
  const last = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); last.set(r.pid, r); } catch { /* torn line */ }
  }
  const byFile = new Map();
  for (const r of last.values()) {
    const f = byFile.get(r.file) || { wallMs: 0, cpuMs: 0 };
    if (r.own) f.wallMs = Math.max(f.wallMs, r.wallMs);
    f.cpuMs += r.cpuMs;
    byFile.set(r.file, f);
  }
  const files = {};
  for (const [file, f] of [...byFile].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Only the repository's own test files: a suite that runs node's test
    // runner on files of its own (in a temporary directory) is charged for
    // them, under its own name.
    if (!f.wallMs || !/^tests\/[^/]+\.test\.js$/.test(file)) continue;
    const seconds = Math.max(0.05, Math.round(f.wallMs / 100) / 10);
    files[file] = [seconds, Math.round((f.cpuMs / f.wallMs) * 10) / 10];
  }
  return files;
}

function baseline(files, note, overrides = {}) {
  const secs = Object.values(files).map(([s]) => s).sort((a, b) => a - b);
  // A file not measured yet is given the median: new files are mostly small.
  const defaultSeconds = secs.length ? secs[Math.floor(secs.length / 2)] : 1;
  return {
    version: 1,
    about: 'Per test file: [seconds, cores]. Written by `npm run test:durations`; read by scripts/test-shard-plan.js.',
    measured: note,
    defaultSeconds,
    // Set by hand, kept by every refresh (scripts/test-shard-plan.js).
    overrides,
    files,
  };
}

/**
 * `{ raw, added }` from adding an entry for each named test file the baseline
 * does not know yet: the default seconds and one core, listed as unmeasured
 * so a refresh replaces them. An entry it already has is left untouched, and
 * both the files and the list stay sorted.
 */
function addEntries(raw, names) {
  const files = { ...(raw.files || {}) };
  const unmeasured = new Set(Array.isArray(raw.unmeasured) ? raw.unmeasured : []);
  const added = [];
  for (const name of [...new Set(names)].sort()) {
    if (Object.prototype.hasOwnProperty.call(files, name)) continue;
    files[name] = [raw.defaultSeconds, 1];
    unmeasured.add(name);
    added.push(name);
  }
  const sorted = {};
  for (const name of Object.keys(files).sort()) sorted[name] = files[name];
  return { raw: { ...raw, files: sorted, unmeasured: [...unmeasured].sort() }, added };
}

/**
 * Write a baseline in the read-by-a-person layout: one file entry per line,
 * and the unmeasured list sorted. A run that timed every file has no list at
 * all; one that did not lists only the files it gave the default.
 */
function writeBaseline(raw, file = shardPlan.DURATIONS_FILE) {
  const out = { ...raw };
  if (Array.isArray(out.unmeasured)) out.unmeasured = [...new Set(out.unmeasured)].sort();
  else delete out.unmeasured;
  const text = JSON.stringify(out, null, 0)
    .replace(/("overrides":\{|"files":\{)/g, '$1\n')
    .replace(/\],"/g, '],\n"')
    .replace(/\},"tests\//g, '},\n"tests/');
  fs.writeFileSync(file, `${text}\n`);
}

/**
 * `raw` with an entry for every named test file the run did not time: the
 * default seconds and one core, listed as unmeasured. A run that times only
 * part of the tree (a branch cut before a new test file merged, or a suite
 * that stopped early) still writes a baseline complete for that tree.
 */
function withUntimed(raw, current) {
  const timed = new Set(Object.keys(raw.files || {}));
  return addEntries(raw, current.filter((name) => !timed.has(name))).raw;
}

function readBaseline() {
  try { return JSON.parse(fs.readFileSync(shardPlan.DURATIONS_FILE, 'utf8')); } catch {
    throw new Error(`no readable baseline at ${path.relative(ROOT, shardPlan.DURATIONS_FILE)}; run a full refresh first`);
  }
}

/** `--add`: give every named test file an entry, or every test file missing one. */
function addToBaseline(names) {
  const raw = readBaseline();
  const current = new Set(shardPlan.listTestFiles(ROOT));
  const wanted = names.length ? names : [...current];
  for (const name of wanted) {
    if (!/^tests\/[^/]+\.test\.js$/.test(name)) throw new Error(`${name} is not a test file like tests/<name>.test.js`);
    if (!fs.existsSync(path.join(ROOT, name))) throw new Error(`${name} does not exist`);
  }
  // A name left in the list for a file that is no longer a test file goes.
  raw.unmeasured = (Array.isArray(raw.unmeasured) ? raw.unmeasured : []).filter((name) => current.has(name));
  const { raw: next, added } = addEntries(raw, wanted);
  writeBaseline(next);
  process.stdout.write(`test:durations: added ${added.length} ${added.length === 1 ? 'entry' : 'entries'} with the default ${next.defaultSeconds} s\n`);
  return 0;
}

async function main(argv = process.argv.slice(2), probes = {}) {
  let records;
  const forced = parseForce(argv);
  if (forced.argv[0] === '--add') {
    // No measurement is written, so any machine may add an entry.
    return addToBaseline(forced.argv.slice(1).flatMap((arg) => arg.split(',')).map((s) => s.trim()).filter(Boolean));
  }
  // A full run and --from both write measurements: they must describe the
  // machine the shard plan is made for.
  if (!forced.reason) {
    const problem = await measurementMachineProblem(probes);
    if (problem) {
      process.stderr.write(`test:durations: ${problem}\n`);
      return 1;
    }
  }
  if (forced.argv[0] === '--from') {
    records = fs.readFileSync(forced.argv[1], 'utf8');
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-durations-'));
    const out = path.join(dir, 'timing.jsonl');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const [bin, ...args] = testCommand(pkg, shardPlan.listTestFiles(ROOT));
    const r = spawnSync(bin === 'node' ? process.execPath : bin, args, {
      cwd: ROOT, stdio: 'inherit',
      env: { ...process.env, TEST_TIMING_OUT: out, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(ROOT, 'tests/lib/test-timing.js')}`.trim() },
    });
    if (r.status !== 0) process.stderr.write(`test:durations: the suite exited ${r.status}; its durations are written all the same\n`);
    records = fs.readFileSync(out, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const files = summarise(records);
  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(shardPlan.DURATIONS_FILE, 'utf8')).overrides || {}; } catch { /* a first baseline */ }
  const note = `${new Date().toISOString().slice(0, 10)}, node ${process.version}, ${os.availableParallelism()} CPUs available`
    + (forced.reason ? `, forced: ${forced.reason}` : '');
  const next = withUntimed(baseline(files, note, overrides), shardPlan.listTestFiles(ROOT));
  writeBaseline(next);
  const untimed = next.unmeasured ? next.unmeasured.length : 0;
  process.stdout.write(`test:durations: ${Object.keys(files).length} files measured${untimed ? `, ${untimed} not timed and given the default` : ''}; written to ${path.relative(ROOT, shardPlan.DURATIONS_FILE)}\n`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`test:durations: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  summarise, baseline, addEntries, withUntimed, writeBaseline,
  databaseTarget, postgresReachable, measurementMachineProblem, parseForce, main,
};
