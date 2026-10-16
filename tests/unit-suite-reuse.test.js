'use strict';

// services/unit-suite-reuse.js — a checks run of a commit whose unit suite
// already passed, under the same conditions, copies that pass instead of
// starting the suite's Jobs again. Pinned here:
//
//   * the key: app, repository, full commit, the worker image by digest and
//     the Job definition, with an age limit; any one differing means no reuse;
//   * only a pass is recorded, only by the process that saw it end, and only
//     when every shard checked out exactly the judged commit;
//   * a person's "Run checks again" (trigger 'manual-recheck') never reuses,
//     nor a run whose trigger is unknown;
//   * the reused row says so, and the merge gate reads it as the pass it
//     copies; it records no check-history observation;
//   * the pass lives in the database, so a restart finds it; a checks run
//     collected by its retry settles a reused run without looking for
//     unit-suite Jobs (tests/check-harvest-workflow-collect.test.js);
//   * a person's request is a durable marker on the proposal, which the
//     verdict store, the merge gate, the preview machine and recovery honour
//     (the machine's side: tests/unit-suite-reuse-machine-postgres.test.js);
//   * UNIT_SUITE_REUSE=0 turns it off.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.NODE_ENV = 'test';
delete process.env.UNIT_SUITE_REUSE;

const reuse = require('../src/services/unit-suite-reuse');
const unitSuite = require('../src/services/unit-suite');
const unitSuiteRow = require('../src/services/unit-suite-row');
const visuals = require('../src/services/visuals');
const kubernetes = require('../src/services/kubernetes');
const github = require('../src/services/github');
const checkHistory = require('../src/services/check-history');
const checkStore = require('../src/workflow/rules/check-store.ts');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const read_ = read;

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const DIGEST = `registry.example/usernode-worker@sha256:${'c'.repeat(64)}`;
const NEW_DIGEST = `registry.example/usernode-worker@sha256:${'d'.repeat(64)}`;
const config = { workerRuntime: 'kubernetes', kubernetes: { workerImage: DIGEST, workerNamespace: 'w' } };
const keyArgs = { appId: 10, repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding', commitSha: SHA, jobHash: 'h'.repeat(64) };

function withEnv(name, value, fn) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return fn(); } finally {
    if (before === undefined) delete process.env[name]; else process.env[name] = before;
  }
}

// ── The key ──────────────────────────────────────────────────────────────

test('the image is known only by digest, and only on Kubernetes', () => {
  assert.equal(reuse.imageOf(config), DIGEST);
  assert.equal(reuse.imageOf({ ...config, workerRuntime: 'docker' }), null, 'Docker runs a tag');
  assert.equal(reuse.imageOf({ ...config, kubernetes: { workerImage: 'usernode-worker:latest' } }), null, 'a tag is not a digest');
  assert.equal(reuse.imageOf({ workerRuntime: 'kubernetes', kubernetes: {} }), null);
});

test('a key needs every part: reuse on, a digest, the repository and a full commit', () => {
  const key = reuse.keyFor(config, keyArgs);
  assert.deepEqual(key, {
    appId: 10, repo: 'usernode-labs/social-vibecoding', commitSha: SHA, image: DIGEST, jobHash: keyArgs.jobHash,
  });
  assert.equal(reuse.keyFor(config, { ...keyArgs, commitSha: 'main' }), null, 'a branch name is not a commit');
  assert.equal(reuse.keyFor(config, { ...keyArgs, commitSha: SHA.slice(0, 12) }), null, 'a short SHA is not enough');
  assert.equal(reuse.keyFor(config, { ...keyArgs, repoName: null }), null);
  assert.equal(reuse.keyFor(config, { ...keyArgs, appId: null }), null);
  assert.equal(reuse.keyFor(config, { ...keyArgs, jobHash: null }), null);
  assert.equal(reuse.keyFor({ ...config, workerRuntime: 'docker' }, keyArgs), null);
  withEnv('UNIT_SUITE_REUSE', '0', () => assert.equal(reuse.keyFor(config, keyArgs), null, 'the off switch'));
  withEnv('UNIT_SUITE_REUSE', 'off', () => assert.equal(reuse.isEnabled(), false));
  withEnv('UNIT_SUITE_REUSE', undefined, () => assert.equal(reuse.isEnabled(), true, 'on by default'));
});

test('the job definition covers what the platform wraps around the tests, and each part changes the hash', () => {
  const def = unitSuite.jobDefinition();
  assert.deepEqual(Object.keys(def).sort(),
    ['cpus', 'env', 'memory', 'runtime', 'script', 'shardCpuRequest', 'shardMemory', 'shards', 'timeoutMs', 'v']);
  assert.equal(def.script, require('crypto').createHash('sha256').update(unitSuite.RUN_SCRIPT).digest('hex'));
  assert.deepEqual(def.env, { CI: 'true', NODE_ENV: 'test', npm_config_update_notifier: 'false' });
  const base = reuse.jobHashOf(def);
  assert.equal(unitSuite.jobHash(), base);
  const changes = {
    script: 'x'.repeat(64), shards: def.shards + 1, cpus: '4', memory: '2g', shardCpuRequest: '1000m',
    shardMemory: '4g', timeoutMs: def.timeoutMs + 1, env: { ...def.env, NODE_OPTIONS: '--max-old-space-size=1' }, v: 2,
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(reuse.jobHashOf({ ...def, [field]: value }), base, `${field} is part of the definition`);
  }
  // The shard count is read when the hash is taken, as the run reads it.
  withEnv('UNIT_SUITE_SHARDS', '1', () => assert.notEqual(unitSuite.jobHash(), base));
});

test('the job env the suite runs with is the one the definition hashes', () => {
  const src = read('src/services/unit-suite.js');
  assert.match(src, /GIT_REF: ref,\n\s+PR_NUMBER: prNumber \? String\(prNumber\) : '',\n\s+\.\.\.JOB_ENV,\n\s+\},/);
});

const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;

test('the run script prints the commit it checked out', { skip: (!hasBash || !hasGit) && 'no bash or git' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-reuse-head-'));
  try {
    const repo = path.join(dir, 'repo');
    const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    fs.mkdirSync(repo);
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'f'), 'x');
    git('add', 'f');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    git('config', 'uploadpack.allowReachableSHA1InWant', 'true');
    // The script up to the line after the head, then stop: no npm here.
    const script = unitSuite.RUN_SCRIPT;
    const upTo = script.indexOf('\n', script.indexOf(`${unitSuite.HEAD_SENTINEL}=`)) + 1;
    const run = spawnSync('bash', ['-c', script.slice(0, upTo)], {
      encoding: 'utf8', env: { ...process.env, REPO_URL: `file://${repo}`, GIT_REF: head, PR_NUMBER: '' },
    });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines[lines.length - 1], `${unitSuite.HEAD_SENTINEL}=${head}`);
    assert.equal(reuse.checkedOutCommit(lines, unitSuite.HEAD_SENTINEL, 1), head);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkout counts only when every shard named the same full commit', () => {
  const S = unitSuite.HEAD_SENTINEL;
  assert.equal(reuse.checkedOutCommit([`${S}=${SHA}`, `${S}=${SHA}`, `${S}=${SHA}`], S, 3), SHA);
  assert.equal(reuse.checkedOutCommit([`${S}=${SHA}`, `${S}=${SHA}`], S, 3), null, 'a shard that said nothing');
  assert.equal(reuse.checkedOutCommit([`${S}=${SHA}`, `${S}=${OTHER}`, `${S}=${SHA}`], S, 3), null, 'a shard on another commit');
  assert.equal(reuse.checkedOutCommit([`${S}=main`], S, 1), null);
  assert.equal(reuse.checkedOutCommit([], S, 1), null);
});

// ── Who may reuse ────────────────────────────────────────────────────────

test('only automatic re-runs reuse: a person\'s request, no trigger or an unknown one runs the suite', () => {
  assert.equal(reuse.isAutomaticTrigger('manual-recheck'), false);
  assert.equal(reuse.isAutomaticTrigger(null), false);
  assert.equal(reuse.isAutomaticTrigger(undefined), false);
  assert.equal(reuse.isAutomaticTrigger('preview-ready'), false, 'not a checks trigger at all');
  for (const t of ['boot-reconcile', 'stuck-sweep', 'promote-kick', 'conflict-resolved', 'commit-push']) {
    assert.equal(reuse.isAutomaticTrigger(t), true, t);
  }
  // Every automatic trigger is a real one, so a rename cannot leave it here
  // matching nothing.
  const triggers = read('src/workflow/rules/check-store.ts').match(/export const CHECK_TRIGGERS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\);/)[1];
  const known = [...triggers.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  for (const t of reuse.AUTOMATIC_TRIGGERS) assert.ok(known.includes(t), `${t} is a check trigger`);
  assert.deepEqual(known.filter((t) => !reuse.AUTOMATIC_TRIGGERS.has(t)), ['manual-recheck']);
});

test('every way a person asks for the checks again reaches the manual-recheck trigger', () => {
  const sessions = read('src/routes/sessions.js');
  // The "Re-run checks" button, the connector's recheck_change and the CLI's
  // proposal_recheck all POST this route.
  const route = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/recheck'"));
  assert.match(route.slice(0, 12000), /recheckSessionChecks\(\{ config, pool, session, reason: 'manual-recheck' \}\)/);
  assert.match(read('src/services/mcp-tools.js'), /callPlatform\(baseUrl, accessToken, 'POST', `\/api\/sessions\/\$\{changeId\}\/recheck`/);
  assert.match(read('src/cli/main.js'), /target: `\/api\/sessions\/\$\{sessionId\}\/recheck`/);
  // Deploying a preview by hand, and every other preview a person asks for:
  // the preview machine runs its checks as 'manual-recheck'.
  assert.match(read('src/workflow/preview/machine.ts'), /to: \(s, e, f, ctx\) => \{\s+const trigger = 'manual-recheck';\s+const only = e\.payload\.reason === 'preview';/);
  const recovery = read('src/services/staging-recovery.js');
  assert.match(recovery, /'manual-recheck': 'manual-recheck',/);
  assert.match(recovery, /'testing-update': 'manual-recheck',/);
  // submit_work / proposal_submit_build with `recheck: true` is a manual
  // re-run even when its shots changed too.
  assert.match(read('src/services/proposal-update.js'),
    /const shotsOnly = shotsApplied\.changed && !applied\.changed && !ctx\.recheck;\s+[\s\S]{0,120}reason: shotsOnly \? 'shots-update' : 'testing-update',/);
});

// ── Recording and finding a pass ─────────────────────────────────────────

function recordingPool(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/^\s*SELECT/.test(sql)) return { rows };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('a lookup matches every part of the key and the age limit, and a person\'s run never asks', async () => {
  const key = reuse.keyFor(config, keyArgs);
  const pool = recordingPool([{ id: 3, session_id: 8401, run_id: 'run-a', summary: { tests: 5, pass: 5 }, passed_at: new Date('2026-10-14T10:00:00Z') }]);
  const found = await reuse.findPass(pool, key, { trigger: 'boot-reconcile' });
  assert.deepEqual(found, { id: 3, sessionId: 8401, runId: 'run-a', summary: { tests: 5, pass: 5 }, passedAt: '2026-10-14T10:00:00.000Z' });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE p\.app_id = \$1 AND p\.repo = \$2 AND p\.commit_sha = \$3 AND p\.image = \$4 AND p\.job_definition = \$5/);
  assert.match(sql, /AND p\.observed_at IS NOT NULL/);
  assert.match(sql, /WHERE cs\.id = \$7::int AND lower\(cs\.unit_suite_fresh_sha\) = \$3\)/);
  assert.match(sql, /p\.passed_at > NOW\(\) - make_interval\(secs => \$6::double precision\)/);
  assert.deepEqual(params, [10, 'usernode-labs/social-vibecoding', SHA, DIGEST, keyArgs.jobHash, 3 * 3600, null]);

  const asked = recordingPool([{ id: 3, passed_at: new Date() }]);
  assert.equal(await reuse.findPass(asked, key, { trigger: 'manual-recheck' }), null);
  assert.equal(await reuse.findPass(asked, key, { trigger: null }), null);
  assert.equal(asked.calls.length, 0, 'nothing is even looked up');

  const broken = { async query() { throw new Error('db down'); } };
  assert.equal(await reuse.findPass(broken, key, { trigger: 'stuck-sweep' }), null, 'a failed lookup runs the suite');
});

test('the age limit: 3 hours, set in one named constant', () => {
  assert.equal(reuse.MAX_AGE_HOURS, 3);
  assert.equal(reuse.MAX_AGE_MS, 3 * 60 * 60 * 1000);
  const src = read('src/services/unit-suite-reuse.js');
  assert.equal((src.match(/MAX_AGE_HOURS = /g) || []).length, 1);
});

// One shard's passing output, as the run script prints it.
const shardOut = (root, head, { ok = 2 } = {}) => [
  `${unitSuite.ROOT_SENTINEL}=${root}`, unitSuite.CLONED_SENTINEL, `${unitSuite.HEAD_SENTINEL}=${head}`,
  unitSuite.SETUP_DONE_SENTINEL, ...Array.from({ length: ok }, (_, i) => `ok ${i + 1} - t${i + 1}`),
  `# tests ${ok}`, `# pass ${ok}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 900',
].join('\n');

function mockRun(t, { heads = [SHA, SHA, SHA], fail = false } = {}) {
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'getCloneUrl', async () => 'https://example.test/repo');
  t.mock.method(github, 'getFileContent', async () => JSON.stringify({ scripts: { test: 'node --test', 'test:shard': 'node --test --test-shard=$TEST_SHARD' } }));
  t.mock.method(checkHistory, 'loadGraduated', async () => new Set());
  const jobs = [];
  t.mock.method(kubernetes, 'runUnitSuiteJob', async (cfg, opts) => {
    jobs.push(opts);
    const shard = opts.env.TEST_SHARD ? Number(opts.env.TEST_SHARD.split('/')[0]) : 1;
    const out = shardOut(`/tmp/w${shard}`, heads[shard - 1] || 'none');
    for (const line of out.split('\n')) opts.onStdoutLine?.(line);
    if (fail && shard === 2) throw Object.assign(new Error('exit 1'), { code: 1, stdout: out.replace('ok 1', 'not ok 1') });
    return { stdout: out };
  });
  return jobs;
}
const runArgs = (pool, extra = {}) => ({
  config, pool, appId: 10, sessionId: 8401, repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
  ref: 'some-branch', previewRunId: 'run-a', commitSha: SHA, ...extra,
});
const inserts = (pool) => pool.calls.filter((c) => /INSERT INTO unit_suite_passes/.test(c.sql));

test('a pass is recorded with the run, the commit every shard checked out, the digest and the job hash', async (t) => {
  delete process.env.UNIT_SUITE_SHARDS;
  const jobs = mockRun(t);
  const pool = recordingPool();
  const outcome = await unitSuite.maybeRunUnitSuite(runArgs(pool));
  assert.equal(jobs.length, 3);
  assert.equal(outcome.row.status, 'pass');
  const [ins] = inserts(pool);
  assert.ok(ins, 'recorded');
  assert.deepEqual(ins.params.slice(0, 7),
    [10, 'usernode-labs/social-vibecoding', SHA, DIGEST, unitSuite.jobHash(), 8401, 'run-a']);
  assert.equal(JSON.parse(ins.params[7]).tests, 6, 'the summary of the whole suite');
});

test('nothing is recorded for a red suite, another checkout, no commit, Docker, or with reuse off', async (t) => {
  const cases = [
    ['a red suite', { fail: true }, {}],
    ['a shard on another commit (the branch moved)', { heads: [SHA, OTHER, SHA] }, {}],
    ['a shard that never said', { heads: [SHA, SHA] }, {}],
    ['no judged commit (main-watch)', {}, { commitSha: null }],
    ['Docker', {}, { config: { workerRuntime: 'docker' } }],
  ];
  for (const [why, run, extra] of cases) {
    await t.test(why, async (st) => {
      mockRun(st, run);
      if (extra.config && extra.config.workerRuntime === 'docker') {
        st.mock.method(require('../src/services/docker'), 'runOneShot', async () => ({ stdout: shardOut('/tmp/w', SHA) }));
      }
      const pool = recordingPool();
      await unitSuite.maybeRunUnitSuite(runArgs(pool, extra));
      assert.equal(inserts(pool).length, 0);
    });
  }
  await t.test('reuse off', async (st) => {
    mockRun(st);
    const pool = recordingPool();
    process.env.UNIT_SUITE_REUSE = '0';
    try { await unitSuite.maybeRunUnitSuite(runArgs(pool)); } finally { delete process.env.UNIT_SUITE_REUSE; }
    assert.equal(inserts(pool).length, 0);
  });
});

test('a harvested outcome is never recorded: the harvesting process cannot know the image', () => {
  const src = read('src/services/unit-suite.js');
  const harvest = src.slice(src.indexOf('async function outcomeFromLog('), src.indexOf('module.exports'));
  assert.doesNotMatch(harvest, /recordPass/);
});

// ── The reused row ───────────────────────────────────────────────────────

const PASS = { id: 3, sessionId: 8401, runId: 'run-a', summary: { tests: 23402, pass: 23380, fail: 0, skipped: 22 }, passedAt: '2026-10-14T10:00:00.000Z' };

test('the reused row is the pass row, marked with where it came from, and records no history', async (t) => {
  t.mock.method(github, 'isEnabled', () => true);
  const pool = recordingPool([{ id: 3, session_id: 8401, run_id: 'run-a', summary: PASS.summary, passed_at: new Date(PASS.passedAt) }]);
  const outcome = await unitSuite.reusablePass({
    config, pool, appId: 10, repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding', commitSha: SHA, trigger: 'boot-reconcile',
  });
  // The row any pass has, from the harvest's own shaping of a green Job.
  const ran = await unitSuite.outcomeFromLog({
    pool: recordingPool(), appId: 10, sessionId: 8401, succeeded: true,
    stdout: '# tests 23402\n# pass 23380\n# fail 0\n# skipped 22',
  });
  const copied = { ...outcome.row };
  delete copied.reused;
  assert.deepEqual(copied, ran.row, 'the same row as a pass that ran, beside its marking');
  assert.equal(outcome.row.status, 'pass');
  assert.equal(outcome.row.advisory, false);
  assert.equal(outcome.row.index, unitSuite.UNIT_CHECK_INDEX);
  assert.equal(outcome.row.name, unitSuite.UNIT_CHECK_NAME);
  assert.deepEqual(outcome.row.summary, PASS.summary);
  assert.deepEqual(outcome.row.reused, { runId: 'run-a', sessionId: 8401, passedAt: PASS.passedAt });
  assert.equal(outcome.history, null, 'copying a pass is not a second observation of it');
  assert.equal(outcome.snapshot.done, true);
  assert.equal(outcome.snapshot.exitOk, true);
  assert.equal(outcome.snapshot.passed, 23380);
  assert.deepEqual(outcome.snapshot.reused, outcome.row.reused);

  assert.equal(await unitSuite.reusablePass({
    config, pool, appId: 10, repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding', commitSha: SHA, trigger: 'manual-recheck',
  }), null);
  process.env.UNIT_SUITE_CHECK_ENABLED = '0';
  try {
    assert.equal(await unitSuite.reusablePass({
      config, pool, appId: 10, repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding', commitSha: SHA, trigger: 'boot-reconcile',
    }), null, 'no unit suite at all, no row');
  } finally { delete process.env.UNIT_SUITE_CHECK_ENABLED; }
});

test('the merge gate reads a reused row exactly as the pass it copies', async () => {
  const plain = await unitSuite.outcomeFromLog({
    pool: recordingPool(), appId: 10, sessionId: 8401, succeeded: true, stdout: '# tests 3\n# pass 3\n# fail 0',
  });
  const plainRow = plain.row;
  const ran = { row: { ...plainRow, reused: { runId: 'run-a', sessionId: 8401, passedAt: PASS.passedAt } } };
  const frames = [{ name: 'a check', path: '/', status: 'pass' }];
  const withReused = visuals.classifyTests(frames, 1, { extraRows: [ran.row] });
  const withPlain = visuals.classifyTests(frames, 1, { extraRows: [plainRow] });
  assert.equal(withReused.state, 'passing');
  assert.equal(withReused.state, withPlain.state);
  assert.equal(unitSuite.passedIn([frames[0], ran.row]), true);
  assert.equal(unitSuite.passedIn(JSON.stringify([ran.row])), unitSuite.passedIn([plainRow]));
});

test('readers can say a run reused its unit suite: the row, the connector and the CLI status', () => {
  const row = reuse.reusedOutcome(() => ({ row: { index: -3, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', status: 'pass' }, history: null }), PASS).row;
  assert.deepEqual(unitSuiteRow.reusedFrom([row]), { runId: 'run-a', sessionId: 8401, passedAt: PASS.passedAt });
  assert.deepEqual(unitSuiteRow.reusedFrom(JSON.stringify([row])), unitSuiteRow.reusedFrom([row]));
  assert.equal(unitSuiteRow.reusedFrom([{ ...row, reused: undefined }]), null, 'a suite this run ran');
  assert.equal(unitSuiteRow.reusedFrom([{ ...row, status: 'fail' }]), null, 'never a failure');
  assert.equal(unitSuiteRow.reusedFrom(null), null);
  assert.match(read('src/services/mcp-tools.js'), /unitSuiteReused: unitSuiteRow\.reusedFrom\(results\),/);
  assert.match(read('src/routes/proposal-handoff.js'), /unitSuiteReused: require\('\.\.\/services\/unit-suite-row'\)\.reusedFrom\(session\.test_results\),/);
});

test('the card keeps the reused unit suite after the verdict, and says so', () => {
  const src = read('src/workflow/rules/check-store.ts');
  assert.match(src, /'unit', CASE WHEN checks_progress #> '\{unit,reused\}' IS NOT NULL\s+THEN checks_progress -> 'unit' END,/);
  const en = JSON.parse(read('frontend/locales/en/project.json'));
  assert.match(en['topic.run.unit.reused_other'].text, /^Reused: \{\{passed\}\} passed \{\{when\}\} \(run \{\{run\}\}\)$/);
  const changes = JSON.parse(read('frontend/locales/en/changes.json'));
  assert.match(changes['progress.unit.sentence.reused_other'].text, /did not run again/);
  assert.match(read('frontend/src/features/dev-board/topic/topic-head.tsx'), /t\('project:topic\.run\.unit\.reused'/);
});

// ── The checks run and the harvest ───────────────────────────────────────

test('captureForSession copies the pass instead of launching the suite, and records it in the manifest', () => {
  const src = read('src/services/visuals.js');
  const at = src.indexOf('let reusedUnit = null;');
  assert.ok(at > 0);
  const tail = src.slice(at, at + 6000);
  // Not when the attempt's early suite is on the cluster: that one is read.
  assert.match(tail, /if \(!shotsOnly && !earlyUnitRunId\) \{\s+reusedUnit = await unitSuite\.reusablePass\(\{\s+config, pool, appId: app\.id, sessionId: session\.id, repoOwner, repoName, commitSha: commitHash, trigger,/);
  assert.match(tail, /progress\.observeUnit\(reusedUnit\.snapshot\)/);
  assert.match(tail, /unitReused: \{ row: reusedUnit\.row, earned: reusedUnit\.earned \|\| null, snapshot: reusedUnit\.snapshot \}/);
  assert.match(tail, /: reusedUnit\s+\? Promise\.resolve\(\{ row: reusedUnit\.row, history: null, earned: reusedUnit\.earned \|\| null \}\) : earlyUnitRunId/);
  // The suite it runs itself records its pass for the commit it judges; so
  // does the early one (tests/workflow-preview-services.test.js), which
  // also starts no Jobs for a head whose pass will be copied.
  assert.match(tail, /const ownUnitSuite = \(\) => unitSuite\.maybeRunUnitSuite\(\{[\s\S]{0,700}commitSha: commitHash,/);
});

// The retry of a run that copied a pass (check-harvest.collectForWorkflow)
// settles it from its manifest, with no unit-suite Job to find:
// tests/check-harvest-workflow-collect.test.js.

// ── Against a real PostgreSQL: the table in schema.sql, across a restart ──

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';
const SCHEMA_SQL = read('src/db/schema.sql');
const DDL = (() => {
  const start = SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS unit_suite_passes');
  if (start < 0) throw new Error('unit_suite_passes is not in schema.sql');
  const end = SCHEMA_SQL.indexOf("COMMENT ON TABLE unit_suite_passes IS 'staging:private';", start);
  return SCHEMA_SQL.slice(start, end).replace(/\s*REFERENCES apps\(id\) ON DELETE CASCADE/, '');
})();

async function connect() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return null; }
  const pool = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    return { error: err.message || err.code || String(err) };
  }
  return { pool };
}

test('a reused pass earns the receiving proposal the unit-suite gate, without a history observation', async (t) => {
  t.mock.method(github, 'isEnabled', () => true);
  const pool = recordingPool([{ id: 3, session_id: 8401, run_id: 'run-a', summary: PASS.summary, passed_at: new Date(PASS.passedAt) }]);
  const outcome = await unitSuite.reusablePass({
    config, pool, appId: 10, repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding', commitSha: SHA, trigger: 'stuck-sweep',
  });
  const unitKey = require('../src/services/app-manifest').checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH);
  assert.equal(outcome.history, null, 'no observation');
  assert.equal(outcome.earned, unitKey, 'but the gate the pass earns');
  // The settlement hands it to the transition that stores the verdict
  // (visuals.settleCaptureRun's `unitEarned`), which grants it to the
  // proposal that copied the pass, the live run and the collected one alike
  // (tests/unit-suite-reuse-machine-postgres.test.js).
  const src = read('src/services/visuals.js');
  assert.match(src, /unitEarned: unitOutcome && !unitOutcome\.history && unitOutcome\.earned \? unitOutcome\.earned : null,/);
  assert.match(src, /Promise\.resolve\(\{ row: reusedUnit\.row, history: null, earned: reusedUnit\.earned \|\| null \}\)/);
  assert.match(read('src/services/check-harvest.js'), /\{ row: reusedUnit\.row, history: null, earned: reusedUnit\.earned \|\| null \}/);
  assert.match(read('src/workflow/preview/machine.ts'), /if \(w\.unitEarned\) await store\.recordEarned\(tx, w\.appId, w\.sessionId, \[w\.unitEarned\]\);/);
});

test('postgres: a proposal that reused a pass blocks its own later head that fails the suite', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { pool } = conn;
  const schema = `unit_suite_earned_test_${process.pid}`;
  const start = SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS app_check_history');
  const create = SCHEMA_SQL.slice(start, SCHEMA_SQL.indexOf(');', start) + 2)
    .replace(/\s*REFERENCES apps\(id\) ON DELETE CASCADE/, '');
  const alters = SCHEMA_SQL.match(/^ALTER TABLE app_check_history[^;]*;/gm) || [];
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query([create, ...alters].join('\n'));
    await pool.query(`CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, app_id INTEGER, status TEXT,
      checks_earned_keys TEXT[], checks_earned_settled_at TIMESTAMPTZ)`);
    await pool.query(`INSERT INTO chat_sessions (id, app_id, status) VALUES (8401, 10, 'active'), (8402, 10, 'active')`);
    const unitKey = require('../src/services/app-manifest').checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH);
    // Proposal A ran the suite and passed: an observation, and its own gate.
    await checkHistory.recordRun(pool, 10, [{ checkKey: unitKey, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', passed: true }], { sessionId: 8401 });
    const counts = async () => (await pool.query('SELECT pass_count FROM app_check_history WHERE app_id = 10')).rows[0].pass_count;
    assert.equal(await counts(), 1);
    assert.equal((await checkHistory.loadGraduated(pool, 10, { sessionId: 8402 })).has(unitKey), false,
      'nothing merged: B has not earned the gate yet');
    // Proposal B copied that pass: no new observation, but B earns the gate.
    assert.equal(await checkStore.recordEarned(pool, 10, 8402, [unitKey]), true);
    assert.equal(await counts(), 1, 'the app\'s counts did not move');
    const graduated = (await checkHistory.loadGraduated(pool, 10, { sessionId: 8402 })).has(unitKey);
    assert.equal(graduated, true, 'B\'s later heads are judged with the suite blocking');
    // B's next head fails the suite: the row blocks and the run fails.
    const red = await unitSuite.outcomeFromLog({
      pool: recordingPool(), appId: 10, sessionId: 8402, succeeded: false, graduated,
      stdout: `${unitSuite.SETUP_DONE_SENTINEL}\nnot ok 1 - broken\n# tests 1\n# pass 0\n# fail 1`,
    });
    assert.equal(red.row.status, 'fail');
    assert.equal(red.row.advisory, false);
    assert.equal(visuals.classifyTests([{ name: 'a check', path: '/', status: 'pass' }], 1, { extraRows: [red.row] }).state, 'failing');
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await pool.end().catch(() => {});
  }
});

test('every manual entry marks the head as owed a fresh suite, durably, before it can be answered', async () => {
  const pool = recordingPool();
  assert.equal(await reuse.markFreshOwed(pool, { sessionId: 8465, commitSha: SHA.toUpperCase() }), true);
  assert.match(pool.calls[0].sql, /UPDATE chat_sessions SET unit_suite_fresh_sha = \$2 WHERE id = \$1/);
  assert.deepEqual(pool.calls[0].params, [8465, SHA]);
  assert.equal(await reuse.markFreshOwed(recordingPool(), { sessionId: 8465, commitSha: 'latest' }), false);
  const sessions = read('src/routes/sessions.js');
  const route = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/recheck'"), sessions.indexOf("router.post('/api/sessions/:id/recheck'") + 9000);
  const mark = route.indexOf('markFreshOwed(pool, {');
  assert.ok(mark > 0 && mark < route.indexOf('if (recheckInFlight.has(sessionId))'), 'set before any coalesced answer');
  // Deploying a preview by hand.
  assert.match(sessions, /markFreshOwed\(pool, \{\s+sessionId: session\.id, commitSha: commitHash === 'latest' \? null : commitHash,\s+\}\);\s+return res\.json\(\{ ok: true, status: 'deploying' \}\);/);
  // Every recheck a person asks for (the route, testing-update), before the
  // machine is asked: tests/recheck-moved-head.test.js.
  assert.match(read('src/services/staging-recovery.js'), /if \(checkTriggerForReason\(reason\) === 'manual-recheck'\) \{[\s\S]{0,200}markFreshOwed\(pool, \{ sessionId: session\.id, commitSha: session\.checks_commit_sha \|\| null \}\);/);
  // And the machine's 'manual-recheck' pending stamp, every way it starts
  // a run for a person.
  assert.match(read('src/workflow/rules/check-store.ts'), /unit_suite_fresh_sha = CASE WHEN \$4::text = 'manual-recheck' AND \$2::text IS NOT NULL\s+THEN lower\(\$2::text\) ELSE unit_suite_fresh_sha END,/,
    'and the manual pending stamp sets it');
});

test('postgres: found by the same key alone, within the age limit, and still there after a restart', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const schema = `unit_suite_reuse_test_${process.pid}`;
  let { pool } = conn;
  const use = async (p) => { await p.query(`SET search_path TO ${schema}`); };
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await use(pool);
    await pool.query(DDL);
    await pool.query('CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, unit_suite_fresh_sha TEXT)');
    await pool.query('INSERT INTO chat_sessions (id) VALUES (8401), (8402)');
    const key = reuse.keyFor(config, keyArgs);
    assert.equal(await reuse.recordPass(pool, key, { sessionId: 8401, runId: 'run-a', summary: { tests: 3, pass: 3 } }), true);
    assert.equal(await reuse.findPass(pool, key, { trigger: 'boot-reconcile' }), null,
      'not reused until its run stored its verdict and recorded it in history');
    assert.equal(await checkStore.markUnitPassObserved(pool, { appId: 10, sessionId: 8401, commitSha: SHA }), 1);

    // A restart: a new process has nothing in memory, only the database.
    await pool.end();
    ({ pool } = await connect());
    await use(pool);
    const found = await reuse.findPass(pool, key, { trigger: 'boot-reconcile' });
    assert.equal(found.runId, 'run-a');
    assert.equal(found.sessionId, 8401);
    assert.deepEqual(found.summary, { tests: 3, pass: 3 });

    const differs = {
      'another commit': { ...key, commitSha: OTHER },
      'another image digest': { ...key, image: NEW_DIGEST },
      'another job definition': { ...key, jobHash: 'j'.repeat(64) },
      'another repository': { ...key, repo: 'someone/fork' },
      'another app': { ...key, appId: 11 },
    };
    for (const [why, other] of Object.entries(differs)) {
      assert.equal(await reuse.findPass(pool, other, { trigger: 'boot-reconcile' }), null, why);
    }
    assert.equal(await reuse.findPass(pool, key, { trigger: 'manual-recheck' }), null, 'a person asked');
    // A person asked for this head again on proposal 8402: whatever the
    // trigger of the run that answers, 8402 copies nothing, while another
    // proposal still may.
    await reuse.markFreshOwed(pool, { sessionId: 8402, commitSha: SHA });
    assert.equal(await reuse.findPass(pool, key, { trigger: 'commit-push', sessionId: 8402 }), null, 'owed a fresh run');
    assert.ok(await reuse.findPass(pool, key, { trigger: 'commit-push', sessionId: 8401 }));
    // A suite that was already running records a pass after the press: still
    // not copied for 8402.
    await reuse.recordPass(pool, key, { sessionId: 8401, runId: 'run-late' });
    await checkStore.markUnitPassObserved(pool, { appId: 10, sessionId: 8401, commitSha: SHA });
    assert.equal(await reuse.findPass(pool, key, { trigger: 'boot-reconcile', sessionId: 8402 }), null, 'the overlapping writer');
    await pool.query("DELETE FROM unit_suite_passes WHERE run_id = 'run-late'");

    // Older than the limit: not reused; older than twice it: deleted with
    // the app's next pass.
    await pool.query(`UPDATE unit_suite_passes SET passed_at = NOW() - interval '2 hours 50 minutes'`);
    assert.ok(await reuse.findPass(pool, key, { trigger: 'boot-reconcile' }), 'inside 3 hours');
    await pool.query(`UPDATE unit_suite_passes SET passed_at = NOW() - interval '3 hours 10 minutes'`);
    assert.equal(await reuse.findPass(pool, key, { trigger: 'boot-reconcile' }), null, 'too old');
    await pool.query(`UPDATE unit_suite_passes SET passed_at = NOW() - interval '6 hours 10 minutes'`);
    await reuse.recordPass(pool, { ...key, commitSha: OTHER }, { sessionId: 8402, runId: 'run-b' });
    const { rows } = await pool.query('SELECT commit_sha FROM unit_suite_passes ORDER BY id');
    assert.deepEqual(rows.map((r) => r.commit_sha), [OTHER], 'the stale pass went with the next one');
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await pool.end().catch(() => {});
  }
});

// ── Against the real schema: a person's request and the verdict store ────

test('postgres, full schema: while a fresh run is owed, a verdict with a copied pass is refused and the gate reads pending', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const admin = conn.pool;
  const dbName = `unit_suite_fresh_${process.pid}`;
  const { Pool } = require('pg');
  let pool = null;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(DSN);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString(), max: 2 });
    await pool.query(SCHEMA_SQL);
    const { rows: [u] } = await pool.query("INSERT INTO users (username, password) VALUES ('fresh-test', 'x') RETURNING id");
    const { rows: [app] } = await pool.query("INSERT INTO apps (slug, name, repo_url) VALUES ('fresh-test', 'T', 'https://github.com/o/r') RETURNING id");
    const { rows: [s] } = await pool.query(
      "INSERT INTO chat_sessions (user_id, app_id, status, source) VALUES ($1, $2, 'promoted', 'cli_handoff') RETURNING id",
      [u.id, app.id]);
    const unitRow = (extra) => ({ index: -3, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', status: 'pass', advisory: false, ...extra });
    const reusedRow = unitRow({ reused: { runId: 'run-a', sessionId: 1, passedAt: new Date().toISOString() } });
    const read = async () => (await pool.query(
      'SELECT check_state, checks_commit_sha, unit_suite_fresh_sha, test_results FROM chat_sessions WHERE id = $1', [s.id])).rows[0];

    // An automatic run of the head: no fresh run owed, a copied pass stores.
    await visuals.setChecksPending(pool, s.id, SHA, 'testing', 'boot-reconcile');
    assert.equal((await read()).unit_suite_fresh_sha, null);
    assert.equal(await visuals.storeChecks(pool, s.id, SHA, { state: 'passing', results: [reusedRow] }), true);

    // A person presses "Run checks again" on that head.
    await visuals.setChecksPending(pool, s.id, SHA, 'building', 'manual-recheck');
    assert.equal((await read()).unit_suite_fresh_sha, SHA, 'the request is on the row, durably');
    // The run that answers copied a pass (it decided before the press, or
    // it was collected): its verdict is refused, the head stays pending.
    assert.equal(await visuals.storeChecks(pool, s.id, SHA, { state: 'passing', results: [reusedRow] }), false);
    assert.equal(await visuals.storeChecks(pool, s.id, SHA, { state: 'error', results: [reusedRow] }), false);
    let row = await read();
    assert.equal(row.check_state, 'pending', 'merge-blocked');
    // The gate's reading of a stored copied pass while the request stands.
    assert.equal(unitSuiteRow.freshSuiteOwed({ ...row, test_results: [reusedRow] }), true);
    assert.match(read_('src/routes/votes.js'), /const freshSuiteOwed = require\('\.\.\/services\/unit-suite-row'\)\.freshSuiteOwed\(checkRows\[0\]\);/);
    assert.match(read_('src/routes/votes.js'), /const checkState = checksRevisionMismatch \|\| freshSuiteOwed\s+\? 'pending'/);
    // The gate's own read of the row carries the request (one column of
    // its SELECT, wherever in the list).
    const gateSelect = read_('src/routes/votes.js').match(/const \{ rows: checkRows \} = await pool\.query\(\s+`SELECT check_state, test_results, checks_checked_at,([\s\S]*?)FROM chat_sessions WHERE id = \$1`/);
    assert.ok(gateSelect, 'the gate reads the row');
    assert.match(gateSelect[1], /\bunit_suite_fresh_sha\b/);

    // A suite that could not run does not settle the request either.
    assert.equal(await visuals.storeChecks(pool, s.id, SHA, { state: 'error', results: [unitRow({ status: 'fail', couldNotRun: true })] }), true);
    assert.equal((await read()).unit_suite_fresh_sha, SHA);
    // The suite really runs: stored, and the request is settled.
    await visuals.setChecksPending(pool, s.id, SHA, 'testing', 'manual-recheck');
    assert.equal(await visuals.storeChecks(pool, s.id, SHA, { state: 'passing', results: [unitRow({})] }), true);
    row = await read();
    assert.equal(row.check_state, 'passing');
    assert.equal(row.unit_suite_fresh_sha, null);
    assert.equal(unitSuiteRow.freshSuiteOwed(row), false);
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test('the verdict store reads a verdict\'s answer to a person\'s request from its unit-suite row, as the readers know the row', () => {
  const unit = { index: unitSuite.UNIT_CHECK_INDEX, name: unitSuite.UNIT_CHECK_NAME, path: unitSuite.UNIT_CHECK_PATH, status: 'pass' };
  for (const r of [unit, { ...unit, index: 5 }, { ...unit, name: 'other' }, { ...unit, index: 0, path: 'x' }, { index: 0, name: 'Loads /', path: '/' }, null]) {
    assert.equal(checkStore.isUnitSuiteRow(r), unitSuiteRow.isUnitSuiteRow(r), JSON.stringify(r));
  }
  const answer = (state, rows, extra = {}) => checkStore.unitAnswer({ state, results: rows, ...extra });
  const browser = { index: 0, name: 'Loads /', path: '/', status: 'pass' };
  assert.deepEqual(answer('passing', [browser, unit]), { reused: false, unanswered: false, ran: true }, 'a suite that ran');
  assert.deepEqual(answer('failing', [browser, { ...unit, status: 'fail' }]), { reused: false, unanswered: false, ran: true });
  assert.deepEqual(answer('passing', [browser, { ...unit, reused: { runId: 'r' } }]), { reused: true, unanswered: true, ran: false }, 'a copied pass');
  assert.deepEqual(answer('passing', [browser]), { reused: false, unanswered: true, ran: false }, 'no row, absence not shown');
  assert.deepEqual(answer('passing', [browser], { unitSuiteAbsent: true }), { reused: false, unanswered: false, ran: true }, 'confirmed absent');
  assert.deepEqual(answer('error', [browser, { ...unit, status: 'fail', couldNotRun: true }]), { reused: false, unanswered: false, ran: false },
    'a suite that could not run, on an error');
});

test('a refused verdict starts the run the person asked for; only an observed pass is reusable', () => {
  // The preview machine's side, behaviourally: tests/unit-suite-reuse-machine-postgres.test.js.
  const machine = read('src/workflow/preview/machine.ts');
  assert.match(machine, /const owed = !!f\.session && f\.session\.unitFreshSha === run\.head;\s+const answer = store\.unitAnswer\(\{ state, results, unitSuiteAbsent \}\);\s+const refused = owed && \(state === 'error' \? answer\.reused : answer\.unanswered\);/);
  assert.match(machine, /if \(refused && d0\.trigger !== 'manual-recheck' && d0\.serving && d0\.serving\.head === run\.head\) \{\s+return startRun\(\{ name: 'checking', data: \{ \.\.\.d0, run: null \} \}, 'manual-recheck', ctx, \{ writes: \[settle\] \}\);/);
  assert.match(machine, /await store\.markUnitPassObserved\(tx, \{ appId: w\.appId, sessionId: w\.sessionId, commitSha: w\.head \}\);/);
});

// A request that joins a run which copied a pass (the run was going when
// the person pressed) is not answered by it: the machine refuses its
// verdict and starts their run as a checks run of its own, a work item with
// its own lease (tests/unit-suite-reuse-machine-postgres.test.js). The
// preview lifecycle and runToCollect that carried this before are gone.

// A fresh database holding the whole schema, for the tests that drive the
// real settlement and verdict store.
async function fullSchemaDb(t) {
  const conn = await connect();
  if (!conn) { t.skip('the pg driver is not installed in this environment'); return null; }
  if (conn.error) { t.skip(`no postgres reachable at ${DSN}: ${conn.error}`); return null; }
  const admin = conn.pool;
  const dbName = `unit_suite_settle_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN);
  url.pathname = `/${dbName}`;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url.toString(), max: 3 });
  await pool.query(SCHEMA_SQL);
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  return pool;
}

// The settlement and the verdict store, as the preview machine's checks run
// and its settling transition call them (visuals.settleCaptureRun shapes the
// result; src/workflow/preview/machine.ts WRITES.settled stores it through
// rules/check-store.ts storeChecks, whose fences read the same result).
// `settlePool` is what the settlement reads through; the store writes
// through `storePool`.
async function settleAndStore(settlePool, run, storePool = settlePool) {
  const { result } = await visuals.settleCaptureRun({}, settlePool, { collect: { runId: `run-${run.session.id}` }, ...run });
  await visuals.storeChecks(storePool, run.session.id, run.commitHash, {
    state: result.state, results: result.results,
    ...(result.platformFault ? { platformFault: true } : {}),
    ...(result.unitSuiteAbsent ? { unitSuiteAbsent: true } : {}),
  }, result.errorDetail);
  return result;
}

test('postgres, real settlement: a pass becomes reusable only when its history observation was written', async (t) => {
  const pool = await fullSchemaDb(t);
  if (!pool) return;
  const { rows: [app] } = await pool.query("INSERT INTO apps (slug, name, repo_url) VALUES ('observe-test', 'T', 'https://github.com/o/r') RETURNING id, slug, name, repo_url");
  const { rows: [u] } = await pool.query("INSERT INTO users (username, password) VALUES ('observe-test', 'x') RETURNING id");
  const { rows: [session] } = await pool.query(
    "INSERT INTO chat_sessions (user_id, app_id, status, source) VALUES ($1, $2, 'active', 'cli_handoff') RETURNING *",
    [u.id, app.id]);
  const unitKey = require('../src/services/app-manifest').checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH);
  const unitRow = { index: -3, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', status: 'pass', advisory: false, consoleErrors: [], failureReason: '' };
  const frame = [`__USERNODE_TEST__ index=0 status=pass loadStatus=200`,
    Buffer.from(JSON.stringify({ name: 'home', path: '/' })).toString('base64'), '__USERNODE_TEST_END__'].join('\n');
  const settle = (unitOutcome) => visuals.settleCaptureRun({}, pool, {
    session, app, commitHash: SHA, trigger: 'commit-push', media: false, capturePaths: ['/'], pathDefaulted: true,
    visualScenarios: [], prodRunning: false, stagingOrigin: '', targets: [], testsCount: 1, stdout: frame,
    unitOutcome, collect: { runId: 'run-o' },
  });
  // A suite that ran and passed: its history row rides the result, and the
  // transition that writes it marks the pass observed in the same
  // transaction (src/workflow/preview/machine.ts WRITES.settled; a write
  // that fails rolls the whole settlement back, verdict included).
  let { result } = await settle({ row: unitRow, history: { checkKey: unitKey, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', passed: true } });
  assert.equal(result.state, 'passing');
  assert.equal(result.unitObserved, unitKey);
  assert.ok(result.history.some((h) => h.checkKey === unitKey && h.passed), 'the observation it is marked on');
  assert.equal(result.unitEarned, null);
  // A failing suite records no pass, so there is nothing to observe.
  ({ result } = await settle({ row: { ...unitRow, status: 'fail', advisory: true }, history: { checkKey: unitKey, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', passed: false } }));
  assert.equal(result.unitObserved, null);
  // A copied pass observes nothing, and earns its proposal the gate.
  ({ result } = await settle({ row: { ...unitRow, reused: { runId: 'run-a', sessionId: 1, passedAt: PASS.passedAt } }, history: null, earned: unitKey }));
  assert.deepEqual([result.unitObserved, result.unitEarned], [null, unitKey]);
  assert.ok(!result.history.some((h) => h.checkKey === unitKey), 'no second observation');
  // The transition writes it, with the verdict: behaviourally in
  // tests/unit-suite-reuse-machine-postgres.test.js.
  assert.match(read('src/workflow/preview/machine.ts'), /if \(w\.unitObserved && history\.some\(\(h: any\) => h && h\.checkKey === w\.unitObserved\s+&& \(Number\.isInteger\(h\.passes\) \? h\.passes > 0 : !!h\.passed\)\)\) \{\s+await store\.markUnitPassObserved/);
});

test('postgres: a request folded into a busy session stamps the head pending and starts the owed run once idle', async (t) => {
  const pool = await fullSchemaDb(t);
  if (!pool) return;
  const { rows: [app] } = await pool.query("INSERT INTO apps (slug, name, repo_url) VALUES ('busy-test', 'T', 'https://github.com/o/r') RETURNING id");
  const { rows: [u] } = await pool.query("INSERT INTO users (username, password) VALUES ('busy-test', 'x') RETURNING id");
  const { rows: [s] } = await pool.query(
    "INSERT INTO chat_sessions (user_id, app_id, status, source) VALUES ($1, $2, 'promoted', 'cli_handoff') RETURNING *", [u.id, app.id]);
  const realUnit = { index: -3, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', status: 'pass', advisory: false };
  const row = async () => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
  // An old REAL pass of the head is stored.
  await visuals.setChecksPending(pool, s.id, SHA, 'testing', 'commit-push');
  assert.equal(await visuals.storeChecks(pool, s.id, SHA, { state: 'passing', results: [realUnit] }), true);

  // The press, folded into a busy session (the route's busy branch).
  await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: SHA });
  assert.equal((await row()).check_state, 'passing');
  assert.equal(unitSuiteRow.freshSuiteOwed(await row()), true, 'the merge gate reads it as not checked, real old pass or not');
  let busy = 2;
  const rechecks = [];
  await reuse.owePendingRun({
    pool, visuals, config: {}, session: { ...s, checks_commit_sha: SHA }, busy: () => busy-- > 0, pollMs: 10,
    stagingRecovery: { recheckSessionChecks: async (args) => { rechecks.push(args.reason); } },
  });
  let r = await row();
  assert.equal(r.check_state, 'pending', 'the old pass no longer stands');
  assert.equal(r.check_trigger, 'manual-recheck');
  assert.equal(unitSuiteRow.freshSuiteOwed(r), true);
  // Pending and owed: the stale sweep's scope takes it if this process goes.
  assert.equal(require('../src/services/staging-recovery').isStuckCheckRecoveryScope({ ...r, status: 'active', source: 'native' }), true);
  for (let i = 0; i < 100 && !rechecks.length; i += 1) await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(rechecks, ['manual-recheck'], 'idle again: the owed run starts');

  // The owed run's real suite settles it.
  assert.equal(await visuals.storeChecks(pool, s.id, SHA, { state: 'passing', results: [realUnit] }), true);
  r = await row();
  assert.equal(r.unit_suite_fresh_sha, null);
  assert.equal(unitSuiteRow.freshSuiteOwed(r), false);

  // Already answered by the time the session is idle: nothing more starts.
  await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: SHA });
  const more = [];
  await reuse.owePendingRun({
    pool, visuals, config: {}, session: { ...s, checks_commit_sha: SHA }, busy: () => false, pollMs: 10,
    stagingRecovery: { recheckSessionChecks: async (args) => { more.push(args.reason); } },
  });
  await visuals.storeChecks(pool, s.id, SHA, { state: 'passing', results: [realUnit] });
  await new Promise((res) => setTimeout(res, 60));
  assert.deepEqual(more, []);

  const route = read('src/routes/sessions.js');
  const recheck = route.slice(route.indexOf("router.post('/api/sessions/:id/recheck'"), route.indexOf("router.post('/api/sessions/:id/recheck'") + 9000);
  assert.match(recheck, /const busyNow = \(\) => isSessionBusy\(sessionId\);\s+if \(busyNow\(\)\) \{\s+await require\('\.\.\/services\/unit-suite-reuse'\)\.owePendingRun\(\{\s+pool, visuals, stagingRecovery, config, session, busy: busyNow,\s+\}\);\s+return res\.json\(\{ status: 'running' \}\);/);
});

// The settlement's view of a run with no unit-suite row while a fresh run is
// owed, and of the history cap.
async function settleFixture(pool, slug) {
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (slug, name, repo_url) VALUES ($1, 'T', 'https://github.com/o/r') RETURNING id, slug, name, repo_url", [slug]);
  const { rows: [u] } = await pool.query("INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id", [slug]);
  const { rows: [sess] } = await pool.query(
    "INSERT INTO chat_sessions (user_id, app_id, status, source) VALUES ($1, $2, 'promoted', 'cli_handoff') RETURNING *", [u.id, app.id]);
  return { app, session: sess };
}
const frameFor = (i) => [`__USERNODE_TEST__ index=${i} status=pass loadStatus=200`,
  Buffer.from(JSON.stringify({ name: `check ${i}`, path: '/' })).toString('base64'), '__USERNODE_TEST_END__'].join('\n');

test('postgres, real settlement: a manual run whose unit suite never started keeps the request and is retried; a suite confirmed absent answers it', async (t) => {
  const pool = await fullSchemaDb(t);
  if (!pool) return;
  const { app, session } = await settleFixture(pool, 'absent-test');
  const settle = () => settleAndStore(pool, {
    session, app, commitHash: SHA, trigger: 'manual-recheck', media: false, capturePaths: ['/'], pathDefaulted: true,
    visualScenarios: [], prodRunning: false, stagingOrigin: '', targets: [], testsCount: 1, stdout: frameFor(0),
    unitOutcome: null,
  });
  const read = async () => (await pool.query(
    'SELECT check_state, check_error_platform, unit_suite_fresh_sha FROM chat_sessions WHERE id = $1', [session.id])).rows[0];
  t.mock.method(github, 'isEnabled', () => true);

  // package.json could not be read (a metadata outage): 0 unit Jobs, no row.
  await visuals.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
  const outage = t.mock.method(github, 'getFileContent', async () => { throw new Error('GitHub 502'); });
  await settle();
  let r = await read();
  assert.equal(r.check_state, 'error', 'not a pass: the suite asked for did not run');
  assert.equal(r.check_error_platform, true, 'retried by the error lane');
  assert.equal(r.unit_suite_fresh_sha, SHA, 'the request stands');
  assert.equal(unitSuiteRow.freshSuiteOwed({ ...r, checks_commit_sha: SHA }), true);
  outage.mock.restore();

  // A run that failed before any unit Job (a lifecycle readiness error):
  // stored as an error with no rows; the request stands.
  await visuals.setChecksPending(pool, session.id, SHA, 'testing', 'boot-reconcile');
  assert.equal(await visuals.storeChecks(pool, session.id, SHA, { state: 'error', results: [] }, 'preview not ready'), true);
  assert.equal((await read()).unit_suite_fresh_sha, SHA);
  // Nor does an automatic run then copy a pass for it.
  const pass = await unitSuite.reusablePass({
    config, pool, appId: app.id, sessionId: session.id, repoOwner: 'o', repoName: 'r', commitSha: SHA, trigger: 'stuck-sweep',
  });
  assert.equal(pass, null);

  // The repository has no runnable test script: confirmed absent, answered.
  await visuals.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
  t.mock.method(github, 'getFileContent', async () => JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  await settle();
  r = await read();
  assert.equal(r.check_state, 'passing');
  assert.equal(r.unit_suite_fresh_sha, null);
});

test('postgres, real settlement: a unit pass behind as many browser checks as the old history cap still carries its observation', async (t) => {
  // services/check-history.js recordRun keeps MAX_ROWS_PER_RUN rows, and the
  // unit row comes after the browser checks: a pass it dropped was never to
  // be observed. The preview machine records every row of a settlement, in
  // the transaction that stores it (no cap), so the unit row is written and
  // its pass observed however many checks run before it
  // (tests/unit-suite-reuse-machine-postgres.test.js, the same with real rows).
  const pool = await fullSchemaDb(t);
  if (!pool) return;
  const n = checkHistory.MAX_ROWS_PER_RUN;
  const unitKey = require('../src/services/app-manifest').checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH);
  const { app, session } = await settleFixture(pool, 'cap-full');
  await visuals.setChecksPending(pool, session.id, SHA, 'testing', 'commit-push');
  const dispatched = Array.from({ length: n }, (_, i) => ({ index: i, checkKey: `k${i}`, name: `check ${i}`, path: '/', graduated: false }));
  const { result } = await visuals.settleCaptureRun({}, pool, {
    session, app, commitHash: SHA, trigger: 'commit-push', media: false, capturePaths: ['/'], pathDefaulted: true,
    visualScenarios: [], prodRunning: false, stagingOrigin: '', targets: [], testsCount: n,
    stdout: Array.from({ length: n }, (_, i) => frameFor(i)).join('\n'), dispatched, collect: { runId: 'run-cap' },
    unitOutcome: {
      row: { index: -3, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', status: 'pass', advisory: false, consoleErrors: [], failureReason: '' },
      history: { checkKey: unitKey, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', passed: true },
    },
  });
  assert.equal(result.history.findIndex((h) => h.checkKey === unitKey), n, 'after every browser check');
  assert.equal(result.unitObserved, unitKey);
  assert.match(read('src/workflow/preview/machine.ts'), /await store\.recordRun\(tx, w\.appId, history, \{ sessionId: w\.sessionId \}\);/,
    'the machine passes no row cap');
});

test('postgres: once the in-process drain is gone, recovery still finds every open proposal owed a fresh run of its head', async (t) => {
  const pool = await fullSchemaDb(t);
  if (!pool) return;
  const recovery = require('../src/services/staging-recovery');
  const { rows: [app] } = await pool.query("INSERT INTO apps (slug, name, repo_url) VALUES ('scope-test', 'T', 'https://github.com/o/r') RETURNING id");
  const { rows: [u] } = await pool.query("INSERT INTO users (username, password) VALUES ('scope-test', 'x') RETURNING id");
  const add = async (status, source, marker, sha = SHA) => (await pool.query(
    `INSERT INTO chat_sessions (user_id, app_id, status, source, branch_name, checks_commit_sha, check_state,
                                check_phase, checks_checked_at, unit_suite_fresh_sha)
     VALUES ($1, $2, $3, $4, 'b-' || md5(random()::text), $5, 'pending', 'building', NOW() - INTERVAL '1 hour', $6)
     RETURNING id`, [u.id, app.id, status, source, sha, marker])).rows[0].id;
  const pausedCli = await add('paused', 'cli_handoff', SHA);
  const activeNative = await add('active', 'native', SHA);
  const notOwed = await add('active', 'native', null);
  const otherHead = await add('active', 'native', OTHER);
  const archived = await add('archived', 'native', SHA);
  const { rows } = await recovery.findStuckCheckSessions({ pool, staleMs: 60_000, maxAutoRetries: 6 });
  const ids = rows.map((r) => Number(r.id));
  assert.ok(ids.includes(pausedCli), 'a paused CLI proposal owed a run');
  assert.ok(ids.includes(activeNative), 'an active native proposal owed a run');
  assert.ok(!ids.includes(notOwed), 'an ordinary active session is still its turn tail\'s');
  assert.ok(!ids.includes(otherHead), 'a request about another head is not this head\'s');
  assert.ok(!ids.includes(archived), 'a closed proposal is not');
  // The boot and live sweeps skip a session whose pipeline is running
  // (server.js checkRecoveryInFlight), so ownership is respected.
  assert.match(read('server.js'), /if \(checkRecoveryInFlight\(session\.id\)\) continue;[\s\S]{0,400}reason: 'stuck-checks-boot'/);
});

test('postgres, real settlement and the real GitHub reader: a 404 on package.json is not taken as no suite without proof', async (t) => {
  const pool = await fullSchemaDb(t);
  if (!pool) return;
  const { app, session } = await settleFixture(pool, 'gh404-test');
  t.mock.method(github, 'isEnabled', () => true);
  // The real reader. Its client answers 404 for package.json (as GitHub
  // does for a repository the caller cannot reach), and for the tree either
  // 404 too, a tree without package.json, or a package.json with no test.
  let mode = 'all-404';
  github._setOctokitFactoryForTests(() => ({ rest: {
    repos: { getContent: async ({ path: file }) => {
      if (mode === 'no-test' && file === 'package.json') {
        return { data: { content: Buffer.from(JSON.stringify({ scripts: {} })).toString('base64'), encoding: 'base64' } };
      }
      throw Object.assign(new Error('Not Found'), { status: 404 });
    } },
    git: { getTree: async () => {
      if (mode === 'all-404') throw Object.assign(new Error('Not Found'), { status: 404 });
      return { data: { tree: [{ type: 'blob', path: 'index.html', size: 10, sha: 'x' }], truncated: false } };
    } },
  } }));
  t.after(() => github._setOctokitFactoryForTests(null));
  assert.equal(await github.getFileContent('o', 'r', 'package.json', SHA), null, 'the real reader turns the 404 into null');
  assert.equal(await unitSuite.suiteApplies({ repoOwner: 'o', repoName: 'r', ref: SHA }), null, 'a 404 alone proves nothing');
  mode = 'tree-without';
  assert.equal(await unitSuite.suiteApplies({ repoOwner: 'o', repoName: 'r', ref: SHA }), false, 'a readable tree without package.json does');

  const settle = () => settleAndStore(pool, {
    session, app, commitHash: SHA, trigger: 'manual-recheck', media: false, capturePaths: ['/'], pathDefaulted: true,
    visualScenarios: [], prodRunning: false, stagingOrigin: '', targets: [], testsCount: 1, stdout: frameFor(0),
    unitOutcome: null,
  });
  const read = async () => (await pool.query(
    'SELECT check_state, check_error_detail, unit_suite_fresh_sha FROM chat_sessions WHERE id = $1', [session.id])).rows[0];
  // The commit had passed its suite.
  const key = reuse.keyFor(config, { ...keyArgs, appId: app.id, repoOwner: 'o', repoName: 'r' });
  await reuse.recordPass(pool, key, { sessionId: session.id, runId: 'run-old' });
  await checkStore.markUnitPassObserved(pool, { appId: app.id, sessionId: session.id, commitSha: SHA });

  for (const m of ['all-404', 'tree-without']) {
    mode = m;
    await visuals.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
    await settle();
    const r = await read();
    assert.equal(r.check_state, 'error', m);
    assert.equal(r.check_error_detail, unitSuiteRow.MISSING_UNIT_DETAIL, m);
    assert.equal(r.unit_suite_fresh_sha, SHA, `${m}: the request stands`);
    assert.equal(await unitSuite.reusablePass({
      config, pool, appId: app.id, sessionId: session.id, repoOwner: 'o', repoName: 'r', commitSha: SHA, trigger: 'stuck-sweep',
    }), null, `${m}: and the old pass is not copied for it`);
  }

  // No recorded pass, and established absence: the request is answered.
  await pool.query('DELETE FROM unit_suite_passes WHERE app_id = $1', [app.id]);
  for (const m of ['tree-without', 'no-test']) {
    mode = m;
    await reuse.markFreshOwed(pool, { sessionId: session.id, commitSha: SHA });
    await visuals.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
    await settle();
    const r = await read();
    assert.deepEqual([r.check_state, r.unit_suite_fresh_sha], ['passing', null], m);
  }
});

test('postgres, real settlement: one failed marker read keeps an owed head pending and recoverable; unmarked runs are unchanged', async (t) => {
  const pool = await fullSchemaDb(t);
  if (!pool) return;
  const { app, session } = await settleFixture(pool, 'markerread-test');
  t.mock.method(github, 'isEnabled', () => true);
  // A repository whose package.json could not be read: the suite cannot be
  // confirmed absent.
  t.mock.method(github, 'getFileContent', async () => { throw new Error('GitHub 502'); });
  // The marker read fails once; every other statement goes through.
  let failMarkerRead = true;
  const flaky = {
    query: (sql, params) => {
      if (failMarkerRead && /SELECT unit_suite_fresh_sha FROM chat_sessions WHERE id = \$1/.test(String(sql))) {
        failMarkerRead = false;
        return Promise.reject(new Error('connection reset'));
      }
      return pool.query(sql, params);
    },
    connect: () => pool.connect(),
  };
  const settle = (p) => settleAndStore(p, {
    session, app, commitHash: SHA, trigger: 'boot-reconcile', media: false, capturePaths: ['/'], pathDefaulted: true,
    visualScenarios: [], prodRunning: false, stagingOrigin: '', targets: [], testsCount: 1, stdout: frameFor(0),
    unitOutcome: null,
  }, pool);
  await visuals.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
  await settle(flaky);
  assert.equal(failMarkerRead, false, 'the read did fail');
  const { rows: [r] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [session.id]);
  assert.equal(r.check_state, 'pending', 'no stored pass for a request nothing answered');
  assert.equal(r.unit_suite_fresh_sha, SHA);
  // Pending and owed: the stale sweep's scope takes it once it ages.
  assert.equal(require('../src/services/staging-recovery').isStuckCheckRecoveryScope(r), true);

  // The same failed read on a repository whose package.json has no test
  // script (and no recorded pass): the suite is confirmed absent, which
  // answers the request even though the marker could not be read.
  t.mock.method(github, 'getFileContent', async () => JSON.stringify({ scripts: {} }));
  failMarkerRead = true;
  await visuals.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
  await settle(flaky);
  assert.equal(failMarkerRead, false);
  const { rows: [answered] } = await pool.query('SELECT check_state, unit_suite_fresh_sha FROM chat_sessions WHERE id = $1', [session.id]);
  assert.deepEqual([answered.check_state, answered.unit_suite_fresh_sha], ['passing', null]);

  // A run of a head nobody asked about is stored as it always was.
  const { session: other, app: app2 } = await settleFixture(pool, 'markerread-control');
  await visuals.setChecksPending(pool, other.id, SHA, 'testing', 'commit-push');
  await settleAndStore(pool, {
    session: other, app: app2, commitHash: SHA, trigger: 'commit-push', media: false, capturePaths: ['/'], pathDefaulted: true,
    visualScenarios: [], prodRunning: false, stagingOrigin: '', targets: [], testsCount: 1, stdout: frameFor(0),
    unitOutcome: null,
  });
  assert.equal((await pool.query('SELECT check_state FROM chat_sessions WHERE id = $1', [other.id])).rows[0].check_state, 'passing');
});

test('the connector explains a missing-unit error as a retry, not a broken build (both shapers)', () => {
  const tools = require('../src/services/mcp-tools');
  const ORIGIN = 'https://social-vibecoding.usernodelabs.org';
  // Both browser rows passed; the run was stored as the missing-unit error
  // with a retry scheduled.
  const row = {
    id: 8465, app_slug: 'usernode-2d5619', status: 'promoted', pr_number: 41, branch_name: 'usernode/s8465',
    check_state: 'error', check_error_detail: unitSuiteRow.MISSING_UNIT_DETAIL, check_error_platform: true,
    consecutive_check_failures: 1, check_next_retry_at: new Date(Date.now() + 120000).toISOString(),
    first_check_failure_at: new Date().toISOString(),
    test_results: [{ name: 'Board loads', path: '/', status: 'pass', consoleErrors: [] }, { name: 'Vote', path: '/', status: 'pass', consoleErrors: [] }],
  };
  assert.equal(unitSuiteRow.missingUnitError(row), true);
  const shaped = tools.shapeProposal(row, ORIGIN);
  assert.match(shaped.nextStep, /asked to run the repo unit suite \(npm test\) again, and it did not run/);
  assert.match(shaped.nextStep, /The build did not fail and no test failed, so there is nothing to fix in the change\. Homeroom runs the checks again on its own/);
  assert.doesNotMatch(shaped.nextStep, /Fix the build|ERRORED before any test reported|push a new commit to/);
  const change = tools.changeNextStep(row, tools.shapeChecks(row), {}, 'external');
  assert.match(change, /did not run, so there is no verdict yet; the build did not fail and no test failed\. Homeroom runs the checks again on its own/);
  assert.doesNotMatch(change, /preview build itself broke/);

  // Any other error keeps the build-failure advice.
  const broken = { ...row, check_error_detail: 'The staging build failed: npm ERR!', check_error_platform: false };
  assert.match(tools.shapeProposal(broken, ORIGIN).nextStep, /ERRORED before any test reported/);
  assert.match(tools.changeNextStep(broken, tools.shapeChecks(broken), {}, 'external'), /preview build itself broke/);
});

test('missing-unit advice acknowledges browser checks that failed in the same run (both shapers)', () => {
  const tools = require('../src/services/mcp-tools');
  const row = {
    id: 8465, app_slug: 'usernode-2d5619', status: 'promoted', pr_number: 41, branch_name: 'usernode/s8465',
    check_state: 'error', check_error_detail: unitSuiteRow.MISSING_UNIT_DETAIL, check_error_platform: true,
    consecutive_check_failures: 1, check_next_retry_at: new Date(Date.now() + 120000).toISOString(),
    first_check_failure_at: new Date().toISOString(),
    test_results: [
      { name: 'Board loads', path: '/', status: 'pass', consoleErrors: [] },
      { name: 'Vote button', path: '/', status: 'fail', failureReason: 'Expected Vote, got nothing', consoleErrors: [] },
    ],
  };
  const shaped = tools.shapeProposal(row, 'https://social-vibecoding.usernodelabs.org');
  assert.match(shaped.nextStep, /asked to run the repo unit suite \(npm test\) again, and it did not run/);
  assert.match(shaped.nextStep, /1 check\(s\) did fail in that run: `failures` names them/);
  assert.match(shaped.nextStep, /Fix those checks/);
  assert.doesNotMatch(shaped.nextStep, /no test failed|nothing to fix|Do not push a new commit/);
  assert.equal(shaped.checks.failures[0].name.includes('Vote button'), true, 'and the failure is listed');
  const change = tools.changeNextStep(row, tools.shapeChecks(row), {}, 'external');
  assert.match(change, /did not run, and 1 check\(s\) failed in that run \(named in checks\.failing\)/);
  assert.doesNotMatch(change, /no test failed/);
});

test('postgres, real settlement: with the unit suite switched off, a manual request is answered even for a commit with a recorded pass', async (t) => {
  const pool = await fullSchemaDb(t);
  if (!pool) return;
  const { app, session } = await settleFixture(pool, 'switched-off-test');
  t.mock.method(github, 'isEnabled', () => true);
  const key = reuse.keyFor(config, { ...keyArgs, appId: app.id, repoOwner: 'o', repoName: 'r' });
  await reuse.recordPass(pool, key, { sessionId: session.id, runId: 'run-old' });
  const settle = () => settleAndStore(pool, {
    session, app, commitHash: SHA, trigger: 'manual-recheck', media: false, capturePaths: ['/'], pathDefaulted: true,
    visualScenarios: [], prodRunning: false, stagingOrigin: '', targets: [], testsCount: 1, stdout: frameFor(0),
    unitOutcome: null,
  });
  const read = async () => (await pool.query(
    'SELECT check_state, unit_suite_fresh_sha FROM chat_sessions WHERE id = $1', [session.id])).rows[0];
  process.env.UNIT_SUITE_CHECK_ENABLED = '0';
  try {
    await visuals.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
    await settle();
  } finally { delete process.env.UNIT_SUITE_CHECK_ENABLED; }
  assert.deepEqual(Object.values(await read()), ['passing', null], 'switched off: nothing to run, the request is answered');
  // Switched on, the same recorded pass still keeps an unreadable
  // repository from being taken as having no suite.
  t.mock.method(github, 'getFileContent', async () => null);
  t.mock.method(github, 'listRepoFiles', async () => ({ files: [], truncated: false }));
  await visuals.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
  await settle();
  assert.deepEqual(Object.values(await read()), ['error', SHA]);
});
