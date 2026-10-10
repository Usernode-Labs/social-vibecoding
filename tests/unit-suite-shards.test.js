'use strict';

// services/unit-suite.js — one repo unit suite split across Jobs.
//
// Once the browser checks were split across pods, every checks run on the
// platform's own app ended when its unit suite did: about 190s for ~23,000
// tests on 8 CPUs, 131s of it `npm test`. A repo that declares a
// `test:shard` script (its test command, taking TEST_SHARD=k/n) now runs as
// UNIT_SUITE_SHARDS Jobs at once. Pinned here:
//
//   * only on Kubernetes, only for a repo with `test:shard`, and never more
//     than one Job when UNIT_SUITE_SHARDS=1;
//   * each Job is told its shard, named and labelled as one, and asks the
//     scheduler for a shard's share of CPU;
//   * the shards' outputs are joined into what one Job would have printed:
//     one workspace, one summary that adds up, one recap of every failure,
//     so the reason, the named failures, main-watch and the harvest read
//     one suite;
//   * a shard that could not run makes the suite one that could not run;
//   * the platform's own `test:shard` is its `test` script, sharded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const unitSuite = require('../src/services/unit-suite');
const kubernetes = require('../src/services/kubernetes');
const checkHarvest = require('../src/services/check-harvest');

const { ROOT_SENTINEL, RECAP_SENTINEL, SETUP_DONE_SENTINEL } = unitSuite;

const tapFail = (n, name, root, file) => [
  `not ok ${n} - ${name}`, '  ---', '  duration_ms: 1.5', "  type: 'test'",
  `  location: '${root}/${file}:10:1'`, `  error: 'boom in ${name}'`, '  ...',
];
const summary = (tests, pass, fail, ms) => [`# tests ${tests}`, '# suites 0', `# pass ${pass}`, `# fail ${fail}`,
  '# cancelled 0', '# skipped 0', '# todo 0', `# duration_ms ${ms}`];
// One shard's output, as the run script prints it: workspace, setup, TAP,
// summary, and on a red shard the workspace again and its recap.
function shardOutput(root, { ok = 3, failures = [] } = {}) {
  const lines = [`${ROOT_SENTINEL}=${root}`, SETUP_DONE_SENTINEL];
  for (let i = 1; i <= ok; i += 1) lines.push(`ok ${i} - fine ${i}`);
  failures.forEach(([name, file], i) => lines.push(...tapFail(ok + i + 1, name, root, file)));
  lines.push(...summary(ok + failures.length, ok, failures.length, 40000 + ok * 1000));
  if (failures.length) {
    lines.push(`${ROOT_SENTINEL}=${root}`, `${RECAP_SENTINEL}=${failures.length}`);
    failures.forEach(([name, file], i) => lines.push(...tapFail(ok + i + 1, name, root, file)));
  }
  return lines.join('\n');
}

test('three passing shards read as one passing suite: one summary that adds up', () => {
  const joined = unitSuite.joinUnitShardOutputs([
    { stdout: shardOutput('/tmp/tmp.A', { ok: 3 }) },
    { stdout: shardOutput('/tmp/tmp.B', { ok: 4 }) },
    { stdout: shardOutput('/tmp/tmp.C', { ok: 5 }) },
  ]);
  const lines = joined.stdout.split('\n');
  assert.deepEqual(lines.filter((l) => /^# (tests|pass|fail|duration_ms) /.test(l)),
    ['# tests 12', '# pass 12', '# fail 0', '# duration_ms 45000'], 'added up; the duration is the longest shard\'s');
  assert.equal(lines.filter((l) => l.startsWith(RECAP_SENTINEL)).length, 0, 'no recap when nothing failed');
  assert.ok(lines.every((l) => !l.includes('/tmp/tmp.B') && !l.includes('/tmp/tmp.C')), 'one workspace');
});

test('failures from several shards read as one red suite: named once each, files relative, complete', () => {
  const joined = unitSuite.joinUnitShardOutputs([
    { stdout: shardOutput('/tmp/tmp.A', { failures: [['first breaks', 'tests/a.test.js']] }) },
    { stdout: shardOutput('/tmp/tmp.B') },
    { stdout: shardOutput('/tmp/tmp.C', { failures: [['second breaks', 'tests/c.test.js'], ['third breaks', 'tests/c2.test.js']] }) },
  ]);
  const parts = unitSuite.failureOutcomeParts(joined.stdout, joined.stderr);
  assert.equal(parts.reason,
    'tests/a.test.js (1): first breaks | tests/c.test.js (1): second breaks | tests/c2.test.js (1): third breaks'
    + ' | # tests 12 | # pass 9 | # fail 3 | # cancelled 0');
  assert.deepEqual(parts.named.tests, [
    { file: 'tests/a.test.js', test: 'first breaks' },
    { file: 'tests/c.test.js', test: 'second breaks' },
    { file: 'tests/c2.test.js', test: 'third breaks' },
  ]);
  assert.equal(parts.named.complete, true, 'the joined recap counts three and all three were read');
  assert.match(joined.stdout, new RegExp(`${RECAP_SENTINEL}=3`));
});

test('a shard whose log lost its start still has its failures named, through the joined recap', () => {
  const full = shardOutput('/tmp/tmp.B', { failures: [['lost line', 'tests/b.test.js']] }).split('\n');
  const lostStart = full.slice(full.findIndex((l) => l.startsWith('# tests'))).join('\n');
  const joined = unitSuite.joinUnitShardOutputs([{ stdout: shardOutput('/tmp/tmp.A') }, { stdout: lostStart }]);
  const parts = unitSuite.failureOutcomeParts(joined.stdout, '');
  assert.deepEqual(parts.named.tests, [{ file: 'tests/b.test.js', test: 'lost line' }]);
});

test('progress: the shards\' counts add up, and the suite is done when every shard is', () => {
  const snap = unitSuite.combineUnitSnapshots([
    { phase: 'running', ran: 100, passed: 99, failed: 1, skipped: 0 },
    { phase: 'installing', ran: 0, passed: 0, failed: 0, skipped: 0 },
    { phase: 'done', ran: 300, passed: 300, failed: 0, skipped: 2 },
  ], 23000);
  assert.equal(snap.phase, 'installing', 'the furthest-behind shard');
  assert.deepEqual([snap.ran, snap.passed, snap.failed, snap.skipped, snap.expected, snap.shards], [400, 399, 1, 2, 23000, 3]);
  assert.equal(snap.done, false);
  assert.equal(unitSuite.combineUnitSnapshots([{ phase: 'done' }, { phase: 'done' }]).done, true);
});

test('how many shards, and who has them', () => {
  assert.equal(unitSuite.unitSuiteShardCount(undefined), 3);
  assert.equal(unitSuite.unitSuiteShardCount('1'), 1);
  assert.equal(unitSuite.unitSuiteShardCount('5'), 5);
  assert.equal(unitSuite.unitSuiteShardCount('99'), 8);
  assert.equal(unitSuite.unitSuiteShardCount('x'), 3);
  assert.equal(unitSuite.hasShardScript('{"scripts":{"test":"node --test","test:shard":"node --test --test-shard=$TEST_SHARD"}}'), true);
  assert.equal(unitSuite.hasShardScript('{"scripts":{"test":"node --test"}}'), false);
  assert.equal(unitSuite.hasShardScript('{"scripts":{"test:shard":"  "}}'), false);
  assert.equal(unitSuite.hasShardScript('{not json'), false);
});

// ── Running the shards ───────────────────────────────────────────────────

function shardRunner(answer = {}) {
  const calls = [];
  const runJob = async (opts) => {
    calls.push(opts);
    const shard = Number(opts.env.TEST_SHARD.split('/')[0]);
    const a = answer[shard];
    if (a instanceof Error) throw a;
    return { stdout: a || shardOutput(`/tmp/tmp.${shard}`) };
  };
  return { calls, runJob };
}
const options = { previewRunId: 'run-1', namePrefix: 'sv-unit-early', env: { REPO_URL: 'u', GIT_REF: 'r' }, signal: null };

test('each Job is told its shard, named and labelled as one, and asks for a shard\'s CPU', async () => {
  const { calls, runJob } = shardRunner();
  const tracker = unitSuite.makeUnitSuiteTracker(null);
  const out = await unitSuite.runUnitSuiteShards({}, { sessionId: 7, options, shards: 3, tracker, runJob });
  assert.deepEqual(calls.map((c) => c.env.TEST_SHARD), ['1/3', '2/3', '3/3']);
  assert.deepEqual(calls.map((c) => c.nameSuffix), [null, 'u2', 'u3']);
  assert.deepEqual(calls.map((c) => c.unitShard), ['1-of-3', '2-of-3', '3-of-3']);
  assert.ok(calls.every((c) => c.cpuRequest === '1500m' && c.memory === '3g'), 'a shard\'s share of the quota');
  assert.ok(calls.every((c) => c.previewRunId === 'run-1' && c.namePrefix === 'sv-unit-early'));
  assert.ok(calls.every((c) => c.env.REPO_URL === 'u' && c.env.GIT_REF === 'r'), 'the same checkout everywhere');
  assert.match(out.stdout, /^# tests 9$/m);
});

test('a shard that failed makes a failed suite carrying every shard\'s output; one that could not run, a suite that could not run', async () => {
  const red = Object.assign(new Error('exit 1'), { code: 1,
    stdout: shardOutput('/tmp/tmp.2', { failures: [['broken', 'tests/x.test.js']] }) });
  const failing = shardRunner({ 2: red });
  const err = await unitSuite.runUnitSuiteShards({}, {
    sessionId: 7, options, shards: 3, tracker: unitSuite.makeUnitSuiteTracker(null), runJob: failing.runJob,
  }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.shardNotRun, undefined);
  assert.match(err.stdout, /^# tests 10$/m, 'all three shards\' tests');
  assert.match(unitSuite.failureOutcomeParts(err.stdout, err.stderr).reason, /^tests\/x\.test\.js \(1\): broken \| /);

  const refused = Object.assign(new Error('exceeded quota'), { checkJobNotCreated: true, stdout: '', stderr: '' });
  const blocked = shardRunner({ 3: refused });
  const err2 = await unitSuite.runUnitSuiteShards({}, {
    sessionId: 7, options, shards: 3, tracker: unitSuite.makeUnitSuiteTracker(null), runJob: blocked.runJob,
  }).catch((e) => e);
  assert.equal(err2, refused);
  assert.equal(err2.shardNotRun, true);
});

test('maybeRunUnitSuite splits a repo with test:shard on Kubernetes, and reads it as one suite', async (t) => {
  const github = require('../src/services/github');
  const history = require('../src/services/check-history');
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'getCloneUrl', async () => 'https://example.test/repo');
  t.mock.method(history, 'loadGraduated', async () => new Set());
  const pool = { query: async () => ({ rows: [] }) };
  const pkg = { scripts: { test: 'node --test', 'test:shard': 'node --test --test-shard=$TEST_SHARD' } };
  const calls = [];
  t.mock.method(kubernetes, 'runUnitSuiteJob', async (config, opts) => {
    calls.push(opts);
    const shard = opts.env.TEST_SHARD ? Number(opts.env.TEST_SHARD.split('/')[0]) : 1;
    if (shard === 2) {
      throw Object.assign(new Error('exit 1'), { code: 1,
        stdout: shardOutput('/tmp/tmp.2', { failures: [['broken', 'tests/x.test.js']] }) });
    }
    return { stdout: shardOutput(`/tmp/tmp.${shard}`) };
  });
  const args = { config: { workerRuntime: 'kubernetes' }, pool, appId: 1, sessionId: 9, repoOwner: 'o', repoName: 'r', ref: 'a'.repeat(40) };

  t.mock.method(github, 'getFileContent', async () => JSON.stringify(pkg));
  const red = await unitSuite.maybeRunUnitSuite(args);
  assert.equal(calls.length, 3);
  assert.equal(red.row.status, 'fail');
  assert.match(red.row.failureReason, /^tests\/x\.test\.js \(1\): broken \| # tests 10 \| # pass 9 \| # fail 1/);
  assert.equal(red.row.summary.tests, 10, 'the summary adds the shards up');
  assert.deepEqual(red.failingTests, { tests: [{ file: 'tests/x.test.js', test: 'broken' }], complete: true });

  calls.length = 0;
  process.env.UNIT_SUITE_SHARDS = '1';
  try {
    await unitSuite.maybeRunUnitSuite(args).catch(() => {});
    assert.equal(calls.length, 1, 'UNIT_SUITE_SHARDS=1: one Job');
    assert.equal(calls[0].env.TEST_SHARD, undefined);
  } finally { delete process.env.UNIT_SUITE_SHARDS; }

  calls.length = 0;
  t.mock.method(github, 'getFileContent', async () => JSON.stringify({ scripts: { test: 'node --test' } }));
  await unitSuite.maybeRunUnitSuite(args).catch(() => {});
  assert.equal(calls.length, 1, 'no test:shard, no split');
});

// ── The run script ───────────────────────────────────────────────────────

const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;

test('a shard runs the pretest, then test:shard; without TEST_SHARD, npm test as always', { skip: !hasBash && 'no bash' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-shard-script-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x', 'test:shard': 'y' } }));
    const tail = unitSuite.RUN_SCRIPT.slice(unitSuite.RUN_SCRIPT.indexOf('TEST_CMD='));
    // The environment this test runs in may be a shard's own: a split suite
    // sets TEST_SHARD on every Job, and the "whole suite" case below must
    // not inherit it (10 Oct 2026: main went red on exactly that).
    const run = (shard) => {
      const env = { ...process.env };
      delete env.TEST_SHARD;
      if (shard) env.TEST_SHARD = shard;
      return spawnSync('bash', ['-c',
        `set -eu\nWS="${dir}"\ncd "${dir}"\nnpm() { echo "npm $*"; }\n${tail}`],
      { encoding: 'utf8', env });
    };
    const sharded = run('2/3');
    assert.equal(sharded.status, 0);
    assert.deepEqual(sharded.stdout.trim().split('\n'), ['npm run pretest --if-present', 'npm run test:shard']);
    const whole = run(null);
    assert.deepEqual(whole.stdout.trim().split('\n'), ['npm test']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.match(unitSuite.RUN_SCRIPT, /if \[ -z "\$\{TEST_SHARD:-\}" \] \|\| \[ "\$\{TEST_SHARD%%\/\*\}" = "1" \]; then\s+npm run lint:sql\s+fi/,
    'the SQL is validated once, in the first shard');
});

test('the platform\'s own test:shard is its test script, sharded', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['test:shard'], scripts.test.replace(' tests/*.test.js', ' --test-shard=${TEST_SHARD:-1/1} tests/*.test.js'));
});

// ── Jobs and harvest ─────────────────────────────────────────────────────

test('a unit shard\'s Job: suffixed name, shard label, its requests', async (t) => {
  const created = [];
  kubernetes._setClientsForTest({
    batch: {
      createNamespacedJob: async ({ body }) => { created.push(body); return { metadata: { uid: 'u' } }; },
      readNamespacedJob: async () => ({ status: { succeeded: 1 } }),
      deleteNamespacedJob: async () => {},
    },
    core: {
      createNamespacedSecret: async ({ body }) => body,
      readNamespacedSecret: async () => ({ metadata: {} }),
      replaceNamespacedSecret: async () => ({}),
      deleteNamespacedSecret: async () => {},
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'p' }, status: {} }] }),
      readNamespacedPodLog: async () => '',
    },
  });
  t.after(() => kubernetes._setClientsForTest(null));
  const config = { kubernetes: { captureImage: 'c@sha256:a', workerImage: 'w@sha256:b', workerNamespace: 'w', workerServiceAccount: 's' } };
  await kubernetes.runUnitSuiteJob(config, { sessionId: 7, env: { TEST_SHARD: '2/3' }, cmd: ['true'], previewRunId: 'r1',
    nameSuffix: 'u2', unitShard: '2-of-3', cpuRequest: '1500m', memory: '3g', cpus: '8' });
  const [job] = created;
  assert.equal(job.metadata.name, 'sv-unit-suite-s7-r1-u2');
  assert.equal(job.metadata.labels['social.usernode.io/unit-shard'], '2-of-3');
  const { resources } = job.spec.template.spec.containers[0];
  assert.equal(resources.requests.cpu, '1500m');
  assert.equal(resources.limits.cpu, '8');
  assert.equal(resources.limits.memory, '3Gi');
});

test('the shards of a run with a UUID id each get an input Secret of their own (10 Oct 2026)', async (t) => {
  // Cut from the Job's name, `-input` pushed the shard's suffix off the end
  // of the 63-character limit, every shard asked for the same Secret, and
  // only the first could start: every proposal's split unit suite was a
  // suite that could not run.
  const secrets = [];
  const jobs = [];
  kubernetes._setClientsForTest({
    batch: {
      createNamespacedJob: async ({ body }) => { jobs.push(body); return { metadata: { uid: `u${jobs.length}` } }; },
      readNamespacedJob: async () => ({ status: { succeeded: 1 } }),
      deleteNamespacedJob: async () => {},
    },
    core: {
      createNamespacedSecret: async ({ body }) => {
        if (secrets.includes(body.metadata.name)) throw Object.assign(new Error('already exists'), { code: 409 });
        secrets.push(body.metadata.name);
        return body;
      },
      readNamespacedSecret: async () => ({ metadata: {} }),
      replaceNamespacedSecret: async () => ({}),
      deleteNamespacedSecret: async () => {},
      listNamespacedPod: async () => ({ items: [{ metadata: { name: 'p' }, status: {} }] }),
      readNamespacedPodLog: async () => '',
    },
  });
  t.after(() => kubernetes._setClientsForTest(null));
  const config = { kubernetes: { captureImage: 'c@sha256:a', workerImage: 'w@sha256:b', workerNamespace: 'w', workerServiceAccount: 's' } };
  const runId = '3e9bc660-fd0a-4ed4-9bb0-a07942694a33';
  for (const namePrefix of [null, 'sv-unit-early']) {
    secrets.length = 0;
    jobs.length = 0;
    await Promise.all([1, 2, 3].map((k) => kubernetes.runUnitSuiteJob(config, {
      sessionId: 7736, env: { TEST_SHARD: `${k}/3` }, cmd: ['true'], previewRunId: runId,
      ...(namePrefix ? { namePrefix } : {}), nameSuffix: k === 1 ? null : `u${k}`, unitShard: `${k}-of-3`,
    })));
    assert.equal(new Set(secrets).size, 3, `${namePrefix || 'sv-unit-suite'}: ${secrets.join(', ')}`);
    assert.ok(secrets.every((n) => n.length <= 63 && n.endsWith('-input')));
    const shardSecret = (job) => job.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.name;
    assert.equal(new Set(jobs.map(shardSecret)).size, 3, 'each Job reads its own');
  }
});

test('findCheckJobs: every unit shard, and how many the run had', async (t) => {
  const job = (name, shard) => ({ metadata: { name, labels: shard ? { 'social.usernode.io/unit-shard': shard } : {} }, status: {} });
  kubernetes._setClientsForTest({ batch: { listNamespacedJob: async () => ({ items: [
    job('sv-unit-suite-s7-r1-u3', '3-of-3'), job('sv-unit-suite-s7-r1', '1-of-3'), job('sv-unit-suite-s7-r1-u2', '2-of-3'),
  ] }) }, core: {} });
  t.after(() => kubernetes._setClientsForTest(null));
  const found = await kubernetes.findCheckJobs({ kubernetes: { workerNamespace: 'w' } }, { sessionId: 7, previewRunId: 'r1' });
  assert.deepEqual(found.unitSuites.map((j) => j.name), ['sv-unit-suite-s7-r1', 'sv-unit-suite-s7-r1-u2', 'sv-unit-suite-s7-r1-u3']);
  assert.equal(found.unitSuite.name, 'sv-unit-suite-s7-r1');
  assert.equal(found.unitShards, 3);
});

test('a split suite counts once among running unit suites', async (t) => {
  const job = (name, run) => ({ metadata: { name, labels: { 'social.usernode.io/preview-run-id': run } }, status: {} });
  kubernetes._setClientsForTest({ batch: { listNamespacedJob: async () => ({ items: [
    job('sv-unit-early-s7-a', 'a'), job('sv-unit-early-s7-a-u2', 'a'), job('sv-unit-early-s7-a-u3', 'a'),
    job('sv-unit-suite-s8-b', 'b'), job('sv-capture-s8-b', 'b'),
  ] }) }, core: {} });
  t.after(() => kubernetes._setClientsForTest(null));
  assert.equal(await kubernetes.countRunningUnitSuiteJobs({ kubernetes: { workerNamespace: 'w' } }), 2);
});

test('the harvest joins a run\'s unit shards, and a missing shard is no suite at all', () => {
  const ok = (root) => ({ state: 'succeeded', stdout: shardOutput(root), stderr: '', exitCode: 0, timedOut: false });
  const one = ok('/tmp/tmp.A');
  assert.equal(checkHarvest.joinUnitResults([one]), one, 'one Job reads as it always has');
  const joined = checkHarvest.joinUnitResults([ok('/tmp/tmp.A'), ok('/tmp/tmp.B'), ok('/tmp/tmp.C')], 3);
  assert.equal(joined.state, 'succeeded');
  assert.match(joined.stdout, /^# tests 9$/m);
  const red = checkHarvest.joinUnitResults([ok('/tmp/tmp.A'),
    { state: 'failed', stdout: shardOutput('/tmp/tmp.B', { failures: [['x', 'tests/x.test.js']] }), exitCode: 1 }], 2);
  assert.equal(red.state, 'failed');
  assert.equal(red.exitCode, 1);
  assert.equal(checkHarvest.joinUnitResults([ok('/tmp/tmp.A'), ok('/tmp/tmp.B')], 3), null, 'part of a suite is not the suite');
  assert.equal(checkHarvest.joinUnitResults([ok('/tmp/tmp.A'), { state: 'gone', stdout: '' }], 2).state, 'gone');
});
