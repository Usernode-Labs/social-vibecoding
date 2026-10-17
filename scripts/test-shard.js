#!/usr/bin/env node
'use strict';

// `npm run test:shard`: run this shard's part of the unit suite.
//
// TEST_SHARD=k/n names the shard (1/1 when unset: the whole suite). The
// files come from the time-balanced plan (scripts/test-shard-plan.js) and
// run longest first, with the `test` script's own preloads and timeout,
// through node's test runner (node:test `run`), reported as TAP on stdout
// like `node --test`, the verdict its exit code. When the plan cannot be
// made (no baseline, a malformed one, a partition that does not hold) or
// the test script is not one this reads, the shard runs `node --test` with
// node's own `--test-shard=k/n` instead, exactly as before the plan
// existed, and says so.
//
// --test-force-exit, when the test script asks for it, goes to each test
// file's process and not to the runner. A file that leaves a timer or a
// server open still ends when its tests do, as it must (several of this
// repository's do). But the runner itself waits for every file's report:
// forced, it left as soon as the last file ended and dropped what it still
// held, the whole tail of a shard's log with its counts, on about half of
// all runs (16 Oct 2026: ~17,000 of ~26,000 tests reported).
//
// Then it checks that what ran is what was planned. Each test process
// records its file as it starts (tests/lib/shard-ledger.js, preloaded); a
// planned file that never started, or a file that was not planned, fails
// the shard whatever the tests said. Its last line,
//
//   # shard 2/3: ran 647 of 647 planned files (1941 in all, plan 3fa2c1d07e9b)
//
// is read by the platform, which fails the suite unless every shard printed
// one for the same plan and together they ran every file
// (src/services/unit-suite.js shardCoverage).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const shardPlan = require('./test-shard-plan');
const { testCommand } = require('./test-changed');

// npm runs a script from the package's own directory.
const ROOT = process.cwd();
const LEDGER_PRELOAD = './tests/lib/shard-ledger.js';

/**
 * The `test` script read as options for node:test `run`:
 * `{ requires, timeout, childForceExit }`. Throws for anything else in it,
 * and the shard then runs the script's own `node --test`.
 */
function runOptionsOf(pkg) {
  const [bin, ...args] = testCommand(pkg, []);
  if (bin !== 'node') throw new Error('the test script does not run node');
  const requires = [];
  let timeout = Infinity;
  let childForceExit = false;
  let test = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--test') test = true;
    else if (a === '--test-force-exit') childForceExit = true;
    else if (a === '--require' && args[i + 1]) requires.push(args[(i += 1)]);
    else if (/^--test-timeout=\d+$/.test(a)) timeout = Number(a.split('=')[1]);
    else throw new Error(`the test script's ${a} is not one this runner passes on`);
  }
  if (!test) throw new Error('the test script does not run node --test');
  return { requires, timeout, childForceExit };
}

function readLedger(file, runnerPid) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const files = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      // Only the runner's own test processes: a file a test starts by
      // itself (a child of that test's process) is not the runner's.
      if (r.ppid === runnerPid && typeof r.file === 'string') files.push(r.file);
    } catch { /* a torn line: the check below reports what is missing */ }
  }
  return files;
}

/** What ran against what was planned: `{ ok, missing, extra, twice, ran }`. */
function compare(planned, ran) {
  const want = new Set(planned);
  const got = new Set(ran);
  const missing = planned.filter((f) => !got.has(f));
  const extra = [...got].filter((f) => !want.has(f)).sort();
  const twice = ran.length - got.size;
  return { ok: !missing.length && !extra.length && !twice, missing, extra, twice, ran: got.size };
}

// The shard as before the plan: the test script's `node --test`, with
// node's own --test-shard. Resolves its exit code.
function runFallback(pkg, shard, files) {
  const [, ...args] = testCommand(pkg, [`--test-shard=${shard.k}/${shard.n}`, ...files]);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

// The planned files through node:test `run`, as TAP on stdout. Resolves
// whether the run passed: node's own verdict over every file (its summary's
// `success`), never a count read off the output.
function runPlanned(files, opts, ledger) {
  const { run } = require('node:test');
  const { tap } = require('node:test/reporters');
  // Every test process inherits it, with the preload that writes to it.
  process.env.TEST_SHARD_LEDGER = ledger;
  return new Promise((resolve) => {
    let summary = null;
    let failed = 0;
    let errored = false;
    let done = false;
    const finish = (passed) => { if (!done) { done = true; resolve(passed); } };
    const stream = run({
      files,
      // What `node --test` runs at once.
      concurrency: Math.max(os.availableParallelism() - 1, 1),
      ...(Number.isFinite(opts.timeout) ? { timeout: opts.timeout } : {}),
      execArgv: [
        ...opts.requires.flatMap((r) => ['--require', r]),
        '--require', LEDGER_PRELOAD,
        ...(opts.childForceExit ? ['--test-force-exit'] : []),
        ...(Number.isFinite(opts.timeout) ? [`--test-timeout=${opts.timeout}`] : []),
      ],
    });
    stream.on('test:summary', (d) => { if (d && d.file === undefined) summary = d; });
    stream.on('test:fail', (d) => { if (!(d && (d.todo || d.skip))) failed += 1; });
    stream.on('error', (err) => {
      errored = true;
      process.stderr.write(`test-shard: the test runner failed: ${err && err.stack ? err.stack : err}\n`);
    });
    const out = stream.compose(tap);
    out.pipe(process.stdout, { end: false });
    // node's verdict when it gave one; otherwise, no failure seen at all.
    out.on('end', () => finish(!errored && (summary ? summary.success === true : failed === 0)));
    out.on('error', () => finish(false));
  });
}

async function main() {
  const shard = shardPlan.parseShard(process.env.TEST_SHARD || '1/1');
  if (!shard) {
    process.stderr.write(`test-shard: TEST_SHARD must be k/n, not ${JSON.stringify(process.env.TEST_SHARD)}\n`);
    return 2;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = shardPlan.listTestFiles(ROOT);
  let shards = null;
  let opts = null;
  try {
    opts = runOptionsOf(pkg);
    shards = shardPlan.plan(files, shardPlan.loadDurations(path.join(ROOT, 'tests', 'baselines', 'test-durations.json')), shard.n);
    shardPlan.verifyPartition(shards, files);
  } catch (err) {
    process.stdout.write(`# shard ${shard.k}/${shard.n}: no time-balanced plan (${err.message}); running node's --test-shard\n`);
    return runFallback(pkg, shard, files);
  }
  const mine = shards[shard.k - 1];
  const id = shardPlan.planId(shards);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-shard-'));
  const ledger = path.join(dir, 'ledger.jsonl');
  const passed = await runPlanned(mine, opts, ledger);
  const check = compare(mine, readLedger(ledger, process.pid));
  fs.rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`# shard ${shard.k}/${shard.n}: ran ${check.ran} of ${mine.length} planned files (${files.length} in all, plan ${id})\n`);
  if (!check.ok) {
    process.stderr.write(`test-shard: shard ${shard.k}/${shard.n} did not run exactly its planned files: `
      + `${check.missing.length} never started${check.missing.length ? ` (${check.missing.slice(0, 10).join(', ')})` : ''}, `
      + `${check.extra.length} not planned${check.extra.length ? ` (${check.extra.slice(0, 10).join(', ')})` : ''}`
      + `${check.twice ? `, ${check.twice} started twice` : ''}\n`);
    return 1;
  }
  return passed ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`test-shard: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { compare, readLedger, runOptionsOf, main };
