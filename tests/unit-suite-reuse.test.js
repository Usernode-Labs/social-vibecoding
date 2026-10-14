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
//   * the pass lives in the database, so a restart finds it; a harvest
//     settles a reused run without looking for unit-suite Jobs;
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
  const triggers = read('src/services/visuals.js').match(/const CHECK_TRIGGERS = new Set\(\[([\s\S]*?)\]\);/)[1];
  const known = [...triggers.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  for (const t of reuse.AUTOMATIC_TRIGGERS) assert.ok(known.includes(t), `${t} is a check trigger`);
  assert.deepEqual(known.filter((t) => !reuse.AUTOMATIC_TRIGGERS.has(t)), ['manual-recheck']);
});

test('every way a person asks for the checks again reaches the manual-recheck trigger', () => {
  const sessions = read('src/routes/sessions.js');
  // The "Re-run checks" button, the connector's recheck_change and the CLI's
  // proposal_recheck all POST this route.
  const route = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/recheck'"));
  assert.match(route.slice(0, 6000), /recheckSessionChecks\(\{ config, pool, session, reason: 'manual-recheck' \}\)/);
  assert.match(read('src/services/mcp-tools.js'), /callPlatform\(baseUrl, accessToken, 'POST', `\/api\/sessions\/\$\{changeId\}\/recheck`/);
  assert.match(read('src/cli/main.js'), /target: `\/api\/sessions\/\$\{sessionId\}\/recheck`/);
  // Deploying a preview by hand.
  assert.match(sessions, /captureForSession\(config, session, app, commitHash === 'latest' \? null : commitHash, result, \{ send: null, trigger: 'manual-recheck' \}\)/);
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
  const src = read('src/services/visuals.js');
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
  assert.match(tail, /if \(!shotsOnly && !earlyUnit\) \{\s+reusedUnit = await unitSuite\.reusablePass\(\{\s+config, pool, appId: app\.id, sessionId: session\.id, repoOwner, repoName, commitSha: commitHash, trigger,/);
  assert.match(tail, /progress\.observeUnit\(reusedUnit\.snapshot\)/);
  assert.match(tail, /unitReused: \{ row: reusedUnit\.row, earned: reusedUnit\.earned \|\| null, snapshot: reusedUnit\.snapshot \}/);
  assert.match(tail, /: reusedUnit\s+\? Promise\.resolve\(\{ row: reusedUnit\.row, history: null, earned: reusedUnit\.earned \|\| null \}\) : unitSuite\.maybeRunUnitSuite\(/);
  assert.match(tail, /previewRunId: runId, commitSha: commitHash,/);
});

test('the early suite is not started for a head that will reuse a pass, and records its own pass', async (t) => {
  const early = require('../src/services/early-unit-suite');
  early._runs.clear();
  t.mock.method(kubernetes, 'countRunningUnitSuiteJobs', async () => 0);
  const started = [];
  const asked = [];
  const fake = (reusable) => ({
    isEnabled: () => true,
    reusablePass: async (args) => { asked.push(args); return reusable ? { reused: { runId: 'run-a' } } : null; },
    maybeRunUnitSuite: (args) => { started.push(args); return new Promise(() => {}); },
  });
  const pool = { async query() { return { rows: [{ id: 7, status: 'active', check_state: 'pending', checks_commit_sha: SHA, check_trigger: 'stuck-sweep', source: 'cli_handoff', pr_number: 1 }] }; } };
  const app = { id: 10, repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' };
  const deps = { unitSuite: fake(true), sessionGitRef: () => SHA, checksQueue: { maxConcurrentRuns: () => 4 } };
  assert.equal(await early.maybeStart(config, { session: { id: 7 }, app, commitHash: SHA, pool, deps }), null);
  assert.equal(started.length, 0);
  assert.equal(asked[0].trigger, 'stuck-sweep', 'asked with the pending run\'s trigger');
  assert.equal(asked[0].commitSha, SHA);

  const entry = await early.maybeStart(config, { session: { id: 7 }, app, commitHash: SHA, pool, deps: { ...deps, unitSuite: fake(false) } });
  assert.ok(entry);
  assert.equal(started[0].commitSha, SHA, 'its pass is recorded for the commit it judges');
  early.cancel(config, 7, 'test over');
  early._runs.clear();
});

test('a harvest settles a reused run from its manifest, with no unit-suite Job to find', () => {
  const src = read('src/services/check-harvest.js');
  assert.match(src, /const reusedUnit = manifest\.unitReused && manifest\.unitReused\.row && manifest\.unitReused\.row\.reused\s+&& manifest\.unitReused\.row\.status === 'pass' \? manifest\.unitReused : null;/);
  assert.match(src, /!reusedUnit && unitJobs\.length \? Promise\.all/);
  assert.match(src, /let unitOutcome = reusedUnit \? \{ row: reusedUnit\.row, history: null, earned: reusedUnit\.earned \|\| null \} : null;/);
});

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
  // The settlement grants it to the proposal that copied the pass, the
  // live run and the harvest alike.
  const src = read('src/services/visuals.js');
  assert.match(src, /if \(unitOutcome && !unitOutcome\.history && unitOutcome\.earned\) \{\s+await checkHistory\.recordEarned\(pool, app\.id, session\.id, \[unitOutcome\.earned\]\);/);
  assert.match(src, /Promise\.resolve\(\{ row: reusedUnit\.row, history: null, earned: reusedUnit\.earned \|\| null \}\)/);
  assert.match(read('src/services/check-harvest.js'), /\{ row: reusedUnit\.row, history: null, earned: reusedUnit\.earned \|\| null \}/);
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
    assert.equal(await checkHistory.recordEarned(pool, 10, 8402, [unitKey]), true);
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
  assert.match(route, /\(visuals\.hasInFlightCapture\(sessionId\) && !visuals\.inFlightReusedUnit\(sessionId\)\)/);
  assert.match(route, /runToCollect\(config, pool, sessionId, session\.checks_commit_sha \|\| null, \{ forManual: true \}\)/);
  assert.match(sessions, /markFreshOwed\(pool, \{\s+sessionId: session\.id, commitSha: commitHash,\s+\}\);\s+\/\/ Build and deploy staging/);
  assert.match(read('src/services/staging-recovery.js'), /if \(manual\) \{\s+await require\('\.\/unit-suite-reuse'\)\.markFreshOwed\(pool, \{ sessionId: session\.id, commitSha: head \}\);/);
  const visualsSrc = read('src/services/visuals.js');
  assert.match(visualsSrc, /unit_suite_fresh_sha = CASE WHEN \$4::text = 'manual-recheck' AND \$2::text IS NOT NULL\s+THEN lower\(\$2::text\) ELSE unit_suite_fresh_sha END,/,
    'and the manual pending stamp sets it');
  assert.match(read('src/services/check-harvest.js'), /if \(forManual && row\.manifest && row\.manifest\.unitReused\) continue;/);
  // The lifecycle boundary carries the same intent.
  assert.match(visualsSrc, /runToCollect\(config, getPool\(config\), session\.id, commitHash,\s+\{ forManual: opts\.trigger === 'manual-recheck' \}\)/);
  assert.match(visualsSrc, /manual: opts\.trigger === 'manual-recheck', onError:/);
  assert.match(read('src/services/preview-lifecycle.js'), /runToCollect\(config, pool, session\.id, revision, \{ forManual: manual \}\)/);
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
    assert.equal(await reuse.markObserved(pool, { appId: 10, sessionId: 8401, commitSha: SHA }), 1);

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
    await reuse.markObserved(pool, { appId: 10, sessionId: 8401, commitSha: SHA });
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
    assert.match(read_('src/routes/votes.js'), /checks_commit_sha, check_phase, unit_suite_fresh_sha\s+FROM chat_sessions WHERE id = \$1/);

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

test('a refused copied verdict starts the run the person asked for; only an observed pass is reusable', () => {
  const src = read_('src/services/visuals.js');
  assert.match(src, /if \(unitOutcome && unitOutcome\.row && unitOutcome\.row\.reused\) \{\s+await requestOwedFreshRun\(config, pool, session, commitHash\);/);
  assert.match(src, /recheckSessionChecks\(\{ config, pool, session, reason: 'manual-recheck' \}\)/);
  assert.match(src, /if \(unitOutcome && unitOutcome\.history && unitOutcome\.history\.passed\) \{\s+await require\('\.\/unit-suite-reuse'\)\.markObserved\(pool, \{ appId: app\.id, sessionId: session\.id, commitSha: commitHash \}\);/);
});

test('with the preview lifecycle on, a manual capture does not take a run that copied a pass as its answer', async (t) => {
  const savedRuntime = process.env.APP_RUNTIME;
  const savedFlag = process.env.PREVIEW_LIFECYCLE_ENABLED;
  process.env.APP_RUNTIME = 'kubernetes';
  process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
  t.after(() => {
    if (savedRuntime === undefined) delete process.env.APP_RUNTIME; else process.env.APP_RUNTIME = savedRuntime;
    if (savedFlag === undefined) delete process.env.PREVIEW_LIFECYCLE_ENABLED; else process.env.PREVIEW_LIFECYCLE_ENABLED = savedFlag;
  });
  const harvest = require('../src/services/check-harvest');
  const lifecycle = require('../src/services/preview-lifecycle');
  assert.equal(lifecycle.enabled({}), true);
  const asked = [];
  // A run of this head is on the cluster; collection is the harvest's.
  t.mock.method(harvest, 'runToCollect', async (_c, _p, _id, _sha, opts) => { asked.push(opts || {}); return { runId: 'r', capture: 'running' }; });
  const session = { id: 99001, app_id: 10 };
  const app = { id: 10, slug: 'x', repo_url: 'https://github.com/o/r' };
  const cfg = { databaseUrl: 'postgres://unused/none' };
  await visuals.captureForSession(cfg, session, app, SHA, null, { trigger: 'manual-recheck', force: true });
  await visuals.captureForSession(cfg, session, app, SHA, null, { trigger: 'stuck-sweep' });
  assert.deepEqual(asked.map((o) => !!o.forManual), [true, false]);
  assert.match(read('src/services/preview-lifecycle.js'), /async function run\(config, session, revision, phase, fn, \{ force = false, onError = null, resolveRevision = null, manual = false \} = \{\}\)/);
});
