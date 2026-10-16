'use strict';

// The unit suite's time-balanced shards (scripts/test-shard-plan.js,
// scripts/test-shard.js, tests/lib/shard-ledger.js) and the platform's
// check that the shards together ran every test file
// (src/services/unit-suite.js shardCoverage).
//
// The guard that matters most is the first: for this repository's own test
// files and baseline, at every shard count the platform may use, the plan
// holds every test file exactly once. A plan that dropped a file would pass
// a suite that never ran it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const shardPlan = require('../scripts/test-shard-plan');
const testShard = require('../scripts/test-shard');
const unitSuite = require('../src/services/unit-suite');

const files = shardPlan.listTestFiles(ROOT);
const durations = shardPlan.loadDurations();

test('the plan holds every test file of this repository exactly once, at every shard count', () => {
  assert.ok(files.length > 1000, `the test files were found (${files.length})`);
  assert.ok(files.includes('tests/test-shard-plan.test.js'));
  for (let n = 1; n <= 8; n += 1) {
    const shards = shardPlan.plan(files, durations, n);
    assert.equal(shards.length, n);
    assert.equal(shardPlan.verifyPartition(shards, files), true);
    const all = shards.flat();
    assert.equal(all.length, files.length, `${n} shards: every file once`);
    assert.deepEqual([...all].sort(), [...files].sort(), `${n} shards: the union is the test files`);
    assert.ok(shards.every((s) => s.length > 0), `${n} shards: none is empty`);
  }
});

test('the baseline is well formed and knows almost every test file', () => {
  const raw = JSON.parse(fs.readFileSync(shardPlan.DURATIONS_FILE, 'utf8'));
  assert.equal(raw.version, 1);
  assert.ok(raw.defaultSeconds > 0);
  const unknown = files.filter((f) => !durations.files.has(f));
  // New files are planned with the default; refresh the baseline
  // (npm run test:durations) once many have piled up.
  assert.ok(unknown.length <= files.length * 0.2, `${unknown.length} of ${files.length} test files are not in the baseline`);
});

test('verifyPartition refuses a plan that drops, repeats or invents a file', () => {
  const list = ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js'];
  assert.equal(shardPlan.verifyPartition([['tests/a.test.js'], ['tests/b.test.js', 'tests/c.test.js']], list), true);
  assert.throws(() => shardPlan.verifyPartition([['tests/a.test.js'], ['tests/b.test.js']], list), /no shard holds 1 test file/);
  assert.throws(() => shardPlan.verifyPartition([['tests/a.test.js', 'tests/b.test.js'], ['tests/b.test.js', 'tests/c.test.js']], list), /is in shard 1 and shard 2/);
  assert.throws(() => shardPlan.verifyPartition([['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js', 'tests/z.test.js']], list), /not a test file/);
  assert.throws(() => shardPlan.verifyPartition([list], [...list, 'tests/a.test.js']), /names a file twice/);
});

test('the plan is the same whatever order the files come in, and runs each shard longest first', () => {
  const shuffled = [...files].reverse();
  assert.deepEqual(shardPlan.plan(shuffled, durations, 3), shardPlan.plan(files, durations, 3));
  assert.equal(shardPlan.planId(shardPlan.plan(shuffled, durations, 3)), shardPlan.planId(shardPlan.plan(files, durations, 3)));
  for (const shard of shardPlan.plan(files, durations, 3)) {
    const secs = shard.map((f) => (durations.files.get(f) || { seconds: durations.defaultSeconds }).seconds);
    assert.deepEqual(secs, [...secs].sort((a, b) => b - a));
  }
});

test('two CPU-heavy files go to different shards, and short files fill in around a long one', () => {
  const d = { defaultSeconds: 1, files: new Map([
    ['tests/heavy-a.test.js', { seconds: 100, cores: 6 }],
    ['tests/heavy-b.test.js', { seconds: 90, cores: 6 }],
    ['tests/waits.test.js', { seconds: 95, cores: 0.1 }],
    ...Array.from({ length: 70 }, (_, i) => [`tests/small-${i}.test.js`, { seconds: 10, cores: 1 }]),
  ]) };
  const list = [...d.files.keys()];
  const shards = shardPlan.plan(list, d, 3);
  shardPlan.verifyPartition(shards, list);
  const where = (f) => shards.findIndex((s) => s.includes(f));
  assert.notEqual(where('tests/heavy-a.test.js'), where('tests/heavy-b.test.js'));
  assert.notEqual(where('tests/heavy-a.test.js'), where('tests/waits.test.js'));
  // The small files go mostly beside the light long file, not the heavy ones.
  const small = (i) => shards[i].filter((f) => f.startsWith('tests/small-')).length;
  assert.ok(small(where('tests/waits.test.js')) > small(where('tests/heavy-a.test.js')));
});

test('a file the baseline does not know is planned with the default', () => {
  const d = { defaultSeconds: 2, files: new Map([['tests/known.test.js', { seconds: 50, cores: 1 }]]) };
  const shards = shardPlan.plan(['tests/known.test.js', 'tests/new-1.test.js', 'tests/new-2.test.js'], d, 2);
  assert.deepEqual(shards, [['tests/known.test.js'], ['tests/new-1.test.js', 'tests/new-2.test.js']]);
});

test('loadDurations refuses what is not a version 1 baseline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durations-'));
  try {
    const f = path.join(dir, 'd.json');
    fs.writeFileSync(f, JSON.stringify({ version: 2, defaultSeconds: 1, files: {} }));
    assert.throws(() => shardPlan.loadDurations(f), /not a version 1/);
    fs.writeFileSync(f, JSON.stringify({ version: 1, defaultSeconds: 0, files: {} }));
    assert.throws(() => shardPlan.loadDurations(f), /no defaultSeconds/);
    fs.writeFileSync(f, JSON.stringify({ version: 1, defaultSeconds: 1, files: { 'tests/a.test.js': ['x', 1] } }));
    assert.throws(() => shardPlan.loadDurations(f), /bad durations entry/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an override sets what a measurement cannot see, and must say why', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durations-'));
  try {
    const f = path.join(dir, 'd.json');
    const base = { version: 1, defaultSeconds: 1, files: { 'tests/a.test.js': [10, 1] } };
    fs.writeFileSync(f, JSON.stringify({ ...base, overrides: { 'tests/a.test.js': { cores: 5, why: 'its database server' } } }));
    assert.deepEqual(shardPlan.loadDurations(f).files.get('tests/a.test.js'), { seconds: 10, cores: 5 });
    fs.writeFileSync(f, JSON.stringify({ ...base, overrides: { 'tests/a.test.js': { cores: 5 } } }));
    assert.throws(() => shardPlan.loadDurations(f), /bad durations override/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // This repository's: the crash suite's database work is counted.
  assert.ok(durations.files.get('tests/bot-build-crash-postgres.test.js').cores >= 4);
});

test('a refresh charges a file with its child processes, keeps each process\'s last record, and keeps the overrides', () => {
  const td = require('../scripts/test-durations');
  const rec = (o) => JSON.stringify(o);
  const files = td.summarise([
    rec({ file: 'tests/a.test.js', own: true, pid: 1, wallMs: 1000, cpuMs: 200 }),
    rec({ file: 'tests/a.test.js', own: true, pid: 1, wallMs: 4000, cpuMs: 1000 }),
    rec({ file: 'tests/a.test.js', own: false, pid: 2, wallMs: 3000, cpuMs: 3000 }),
    rec({ file: 'tests/b.test.js', own: true, pid: 3, wallMs: 20, cpuMs: 10 }),
    rec({ file: '../tmp/x/tests/c.test.js', own: true, pid: 4, wallMs: 500, cpuMs: 100 }),
    '{ torn',
  ].join('\n'));
  assert.deepEqual(files, { 'tests/a.test.js': [4, 1], 'tests/b.test.js': [0.05, 0.5] });
  const b = td.baseline(files, 'now', { 'tests/a.test.js': { cores: 5, why: 'x' } });
  assert.equal(b.version, 1);
  assert.deepEqual(b.overrides, { 'tests/a.test.js': { cores: 5, why: 'x' } });
  assert.equal(b.defaultSeconds, 4, 'the median');
});

test('parseShard reads k/n and refuses anything else', () => {
  assert.deepEqual(shardPlan.parseShard('2/3'), { k: 2, n: 3 });
  for (const bad of ['0/3', '4/3', '1/0', 'x', '', '1-3']) assert.equal(shardPlan.parseShard(bad), null, bad);
});

test('the run check: a planned file that never started, one not planned, or one started twice fails the shard', () => {
  const planned = ['tests/a.test.js', 'tests/b.test.js'];
  assert.equal(testShard.compare(planned, ['tests/b.test.js', 'tests/a.test.js']).ok, true);
  assert.deepEqual(testShard.compare(planned, ['tests/a.test.js']).missing, ['tests/b.test.js']);
  assert.deepEqual(testShard.compare(planned, [...planned, 'tests/c.test.js']).extra, ['tests/c.test.js']);
  assert.equal(testShard.compare(planned, [...planned, 'tests/a.test.js']).ok, false);
});

test('the runner reads this repository\'s test script: its preload, its timeout, and force-exit for each file\'s process', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(testShard.runOptionsOf(pkg), { requires: ['./tests/lib/test-net.js'], timeout: 180000, childForceExit: true });
  assert.throws(() => testShard.runOptionsOf({ scripts: { test: 'node --test --watch tests/*.test.js' } }), /--watch is not one this runner passes on/);
  assert.throws(() => testShard.runOptionsOf({ scripts: { test: 'node --require x tests/*.test.js' } }), /does not run node --test/);
});

// ── The runner, end to end, on a repository of four small test files ───

function miniRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-shard-'));
  fs.mkdirSync(path.join(dir, 'tests', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests', 'baselines'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tests', 'lib', 'shard-ledger.js'), path.join(dir, 'tests', 'lib', 'shard-ledger.js'));
  fs.writeFileSync(path.join(dir, 'tests', 'lib', 'test-net.js'), '');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    scripts: { test: 'node --require ./tests/lib/test-net.js --test --test-force-exit --test-timeout=60000 tests/*.test.js' },
  }));
  const names = ['alpha', 'beta', 'gamma', 'delta'];
  for (const n of names) {
    fs.writeFileSync(path.join(dir, 'tests', `${n}.test.js`),
      `const test = require('node:test');\ntest('${n} runs', () => {});\n`);
  }
  // A file that leaves a timer open: with the script's --test-force-exit it
  // still ends with its tests.
  fs.appendFileSync(path.join(dir, 'tests', 'delta.test.js'), 'setInterval(() => {}, 1000);\n');
  fs.writeFileSync(path.join(dir, 'tests', 'baselines', 'test-durations.json'), JSON.stringify({
    version: 1, defaultSeconds: 1, files: { 'tests/alpha.test.js': [9, 1], 'tests/beta.test.js': [1, 1] },
  }));
  return dir;
}

// This file runs under node's test runner, whose context a nested runner
// must not inherit.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TEST_SHARD_LEDGER;
  return env;
}

function runShard(dir, shard) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test-shard.js')], {
    cwd: dir, encoding: 'utf8', env: { ...childEnv(), TEST_SHARD: shard },
  });
}

test('each shard runs its planned files and says so; together they run every file once', () => {
  const dir = miniRepo();
  try {
    const outs = ['1/2', '2/2'].map((s) => runShard(dir, s));
    for (const r of outs) assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = outs.map((r) => r.stdout.split('\n').find((l) => l.startsWith('# shard ')));
    assert.match(lines[0], /^# shard 1\/2: ran 1 of 1 planned files \(4 in all, plan [0-9a-f]{12}\)$/);
    assert.match(lines[1], /^# shard 2\/2: ran 3 of 3 planned files \(4 in all, plan [0-9a-f]{12}\)$/);
    assert.match(outs[0].stdout, /^ok \d+ - alpha runs$/m, 'the long file has a shard to itself');
    const ran = outs.flatMap((r) => [...r.stdout.matchAll(/^ok \d+ - (\w+) runs$/gm)].map((m) => m[1])).sort();
    assert.deepEqual(ran, ['alpha', 'beta', 'delta', 'gamma']);
    const coverage = unitSuite.shardCoverage(outs.map((r) => ({ stdout: r.stdout })));
    assert.deepEqual(coverage, { ok: true, checked: true, files: 4 });
    // Every shard's counts reach the end of its log.
    const joined = unitSuite.joinUnitShardOutputs(outs.map((r) => ({ stdout: r.stdout })));
    assert.match(joined.stdout, /^# tests 4$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing test fails its shard', () => {
  const dir = miniRepo();
  try {
    fs.writeFileSync(path.join(dir, 'tests', 'beta.test.js'), "const test = require('node:test');\ntest('beta fails', () => { throw new Error('no'); });\n");
    const outs = ['1/2', '2/2'].map((s) => runShard(dir, s));
    assert.deepEqual(outs.map((r) => r.status), [0, 1]);
    assert.match(outs[1].stdout, /^not ok \d+ - beta fails$/m);
    assert.match(outs[1].stdout, /^# shard 2\/2: ran 3 of 3 planned files/m, 'the files all ran; a test failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a planned file whose process does not record itself fails its shard, loudly', () => {
  const dir = miniRepo();
  try {
    // gamma wipes the shard's record of what started, its own line with
    // it: the shard can no longer show it ran gamma, and must not pass.
    fs.writeFileSync(path.join(dir, 'tests', 'gamma.test.js'),
      "const test = require('node:test');\nrequire('node:fs').writeFileSync(process.env.TEST_SHARD_LEDGER, '');\ntest('gamma runs', () => {});\n");
    const outs = ['1/2', '2/2'].map((s) => runShard(dir, s));
    const bad = outs.find((r) => r.status !== 0);
    assert.ok(bad, 'the shard that ran gamma fails, though every test passed');
    assert.match(bad.stdout, /^ok \d+ - gamma runs$/m);
    assert.match(bad.stderr, /did not run exactly its planned files: \d+ never started \([^)]*tests\/gamma\.test\.js/);
    assert.match(bad.stdout, /^# shard 2\/2: ran [0-2] of 3 planned files/m);
    assert.equal(unitSuite.shardCoverage(outs.map((r) => ({ stdout: r.stdout }))).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a usable baseline, the shard falls back to node\'s --test-shard and says so', () => {
  const dir = miniRepo();
  try {
    fs.writeFileSync(path.join(dir, 'tests', 'baselines', 'test-durations.json'), '{ not json');
    const outs = ['1/2', '2/2'].map((s) => runShard(dir, s));
    for (const r of outs) {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^# shard \d\/2: no time-balanced plan \(.+\); running node's --test-shard$/m);
    }
    const ran = outs.flatMap((r) => [...r.stdout.matchAll(/^ok \d+ - (\w+) runs$/gm)].map((m) => m[1])).sort();
    assert.deepEqual(ran, ['alpha', 'beta', 'delta', 'gamma']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The platform's reading of the shards ───────────────────────────────

const line = (k, n, ran, planned, total, plan = 'abcdef012345') => `ok 1 - x\n# tests 1\n# shard ${k}/${n}: ran ${ran} of ${planned} planned files (${total} in all, plan ${plan})\n`;

test('shardCoverage: every shard, one plan, every file', () => {
  assert.deepEqual(unitSuite.shardCoverage([{ stdout: 'ok 1 - x\n# tests 1\n' }]), { ok: true, checked: false }, 'a repository without the line is not checked');
  assert.equal(unitSuite.shardCoverage([{ stdout: line(1, 2, 3, 3, 5) }, { stdout: line(2, 2, 2, 2, 5) }]).ok, true);
  const cases = [
    [[line(1, 2, 3, 3, 5), 'ok 1 - x\n'], /1 of 2 shards did not say/],
    [[line(1, 2, 3, 3, 5), line(2, 2, 1, 2, 5)], /shard 2 ran 1 of its 2 files/],
    [[line(1, 2, 3, 3, 5), line(2, 2, 1, 1, 5)], /4 of 5 files ran/],
    [[line(1, 2, 3, 3, 5), line(2, 2, 2, 2, 5, '999999999999')], /different plans/],
    [[line(1, 2, 3, 3, 5), line(1, 2, 2, 2, 5)], /two shards ran the same part/],
    [[line(1, 3, 3, 3, 5), line(2, 3, 2, 2, 5)], /different plans/],
  ];
  for (const [outs, why] of cases) {
    const c = unitSuite.shardCoverage(outs.map((stdout) => ({ stdout })));
    assert.equal(c.ok, false, String(why));
    assert.match(c.reason, why);
  }
});

test('a suite whose shards all passed but missed a file fails, on the live path and on the harvest', async () => {
  const parts = [{ stdout: line(1, 2, 3, 3, 6) }, { stdout: line(2, 2, 2, 2, 6) }];
  await assert.rejects(unitSuite.runUnitSuiteShards({}, {
    sessionId: 1, options: { env: {} }, shards: 2, tracker: unitSuite.makeUnitSuiteTracker(null),
    runJob: async (opts) => parts[Number(opts.env.TEST_SHARD[0]) - 1],
  }), (err) => /5 of 6 files ran/.test(err.message) && /5 of 6 files ran/.test(err.stdout));
  const harvest = require('../src/services/check-harvest');
  const joined = harvest.joinUnitResults(parts.map((p) => ({ ...p, state: 'succeeded' })), 2);
  assert.equal(joined.state, 'failed');
  assert.equal(joined.exitCode, 1);
  assert.match(joined.stdout, /unit-suite: The unit suite's shards did not run every test file: 5 of 6 files ran\./);
});

test('the suite\'s size is stored only when every shard counted its tests', () => {
  const full = unitSuite.joinUnitShardOutputs([{ stdout: '# tests 3\n# pass 3\n# fail 0\n' }, { stdout: '# tests 2\n# pass 2\n# fail 0\n' }]);
  assert.match(full.stdout, /^# tests 5$/m);
  assert.match(full.stdout, /^# pass 5$/m);
  // A shard whose log lost its end (and its counts with it).
  const cut = unitSuite.joinUnitShardOutputs([{ stdout: '# tests 3\n# pass 3\n# fail 0\n' }, { stdout: 'ok 1 - y\n' }]);
  assert.doesNotMatch(cut.stdout, /^# tests /m);
  assert.doesNotMatch(cut.stdout, /^# pass /m);
  assert.match(cut.stdout, /^# fail 0$/m, 'what the counts can still say');
});
