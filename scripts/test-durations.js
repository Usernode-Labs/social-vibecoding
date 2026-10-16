#!/usr/bin/env node
'use strict';

// `npm run test:durations`: measure every test file and rewrite
// tests/baselines/test-durations.json, the baseline the unit suite's shard
// plan is made from (scripts/test-shard-plan.js).
//
// Run it now and then, not on every change: a plan made from durations a
// few weeks old still balances well, and a file the baseline does not know
// is given its default. Run it where the suite runs, for numbers that mean
// the same thing: the worker image with 8 CPUs (one shard's Job), with
// PostgreSQL up on 127.0.0.1:5432, or the *-postgres suites skip and look
// free. It runs the whole suite once, as one `node --test` with the `test`
// script's flags, and records for each file its wall time and the CPU of
// its process and every process it started (tests/lib/test-timing.js).
//
//   node scripts/test-durations.js            run the suite, then write the baseline
//   node scripts/test-durations.js --from F   write it from an earlier run's records

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { testCommand } = require('./test-changed');
const shardPlan = require('./test-shard-plan');

const ROOT = path.join(__dirname, '..');

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

function main(argv = process.argv.slice(2)) {
  let records;
  if (argv[0] === '--from') {
    records = fs.readFileSync(argv[1], 'utf8');
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
  const note = `${new Date().toISOString().slice(0, 10)}, node ${process.version}, ${os.availableParallelism()} CPUs available`;
  fs.writeFileSync(shardPlan.DURATIONS_FILE, `${JSON.stringify(baseline(files, note, overrides), null, 0).replace(/("overrides":\{|"files":\{)/g, '$1\n').replace(/\],"/g, '],\n"').replace(/\},"tests\//g, '},\n"tests/')}\n`);
  process.stdout.write(`test:durations: ${Object.keys(files).length} files written to ${path.relative(ROOT, shardPlan.DURATIONS_FILE)}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { summarise, baseline };
