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

// The verdict's writers: the preview machine's own (its transitions run them).
const rowStore = require('../src/workflow/preview/check-store.ts');
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
// A tree, and a merge commit that lands it under another id.
const TREE = 'e'.repeat(40);
const OTHER_TREE = 'f'.repeat(40);
const MERGE = '9'.repeat(40);
const DIGEST = `registry.example/usernode-worker@sha256:${'c'.repeat(64)}`;
const NEW_DIGEST = `registry.example/usernode-worker@sha256:${'d'.repeat(64)}`;
// The platform's own app (config.js SELF_APP_SLUG), the one whose tests
// were audited for tree reuse.
const SELF = 'usernode-2d5619';
const config = { workerRuntime: 'kubernetes', selfAppSlug: SELF, kubernetes: { workerImage: DIGEST, workerNamespace: 'w' } };
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
    appId: 10, repo: 'usernode-labs/social-vibecoding', commitSha: SHA, treeSha: null, image: DIGEST, jobHash: keyArgs.jobHash,
  });
  assert.equal(reuse.keyFor(config, { ...keyArgs, treeSha: TREE.toUpperCase() }).treeSha, TREE, 'a tree, when known');
  assert.equal(reuse.keyFor(config, { ...keyArgs, treeSha: 'HEAD^{tree}' }).treeSha, null, 'never anything but a full tree id');
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

function mockRun(t, { heads = [SHA, SHA, SHA], fail = false, tree = TREE } = {}) {
  reuse._clearTreeCache();
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'getCommitTree', async () => {
    if (tree instanceof Error) throw tree;
    return tree;
  });
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
  assert.match(ins.sql, /INSERT INTO unit_suite_passes \(app_id, repo, commit_sha, image, job_definition, session_id, run_id, summary, tree_sha\)/);
  assert.equal(ins.params[8], null, 'recorded by commit first: nothing waits on GitHub');
  // Then the commit's tree, as GitHub has it, on the rows of that commit.
  await unitSuite.settleTreeReads();
  const set = pool.calls.filter((c) => /UPDATE unit_suite_passes SET tree_sha = \$3/.test(c.sql));
  assert.equal(set.length, 1);
  assert.match(set[0].sql, /WHERE app_id = \$1 AND commit_sha = \$2 AND tree_sha IS NULL/, 'never another column, its observation included');
  assert.deepEqual(set[0].params, [10, SHA, TREE]);
});

test('a pass whose tree cannot be read is still recorded, for its commit alone', async (t) => {
  mockRun(t, { tree: new Error('GitHub 502') });
  const pool = recordingPool();
  await unitSuite.maybeRunUnitSuite(runArgs(pool));
  const [ins] = inserts(pool);
  assert.ok(ins, 'recorded');
  assert.equal(ins.params[2], SHA);
  assert.equal(ins.params[8], null, 'no tree: main-watch cannot copy it, a re-run of the commit still can');
  await unitSuite.settleTreeReads();
  assert.equal(pool.calls.filter((c) => /SET tree_sha/.test(c.sql)).length, 0);
});

test('a GitHub that never answers holds no verdict: the pass is recorded by commit and the tree read gives up', async (t) => {
  let release;
  mockRun(t);
  t.mock.method(github, 'getCommitTree', () => new Promise((res) => { release = res; }));
  const pool = recordingPool();
  const before = process.env.UNIT_SUITE_TREE_LOOKUP_MS;
  // A deadline well past what the verdict may take: the verdict must not
  // wait for the read at all, not merely for its deadline.
  process.env.UNIT_SUITE_TREE_LOOKUP_MS = '1500';
  try {
    const outcome = await Promise.race([
      unitSuite.maybeRunUnitSuite(runArgs(pool)),
      new Promise((res) => setTimeout(() => res('held'), 700)),
    ]);
    assert.notEqual(outcome, 'held', 'the verdict did not wait for GitHub');
    assert.equal(outcome.row.status, 'pass');
    assert.equal(inserts(pool).length, 1, 'recorded by commit');
    await unitSuite.settleTreeReads();
    assert.equal(pool.calls.filter((c) => /SET tree_sha/.test(c.sql)).length, 0, 'gave up at the deadline');
    release(TREE);
  } finally {
    if (before === undefined) delete process.env.UNIT_SUITE_TREE_LOOKUP_MS; else process.env.UNIT_SUITE_TREE_LOOKUP_MS = before;
  }
});

test('another project\'s pass is recorded by commit and its tree is never read', async (t) => {
  mockRun(t);
  const pool = recordingPool();
  await unitSuite.maybeRunUnitSuite(runArgs(pool, { repoOwner: 'someone', repoName: 'their-app' }));
  await unitSuite.settleTreeReads();
  assert.equal(inserts(pool).length, 1);
  assert.equal(github.getCommitTree.mock.callCount(), 0);
  assert.equal(pool.calls.filter((c) => /SET tree_sha/.test(c.sql)).length, 0);
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
  const src = read('src/workflow/preview/check-store.ts');
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
  // On the head the request is for, read from the row now, which the busy
  // drain also waits on (not a checks pin an older run left).
  assert.match(route, /const requestedHead = await stagingRecovery\.requestedRecheckHead\(pool, session\);\s+await require\('\.\.\/services\/unit-suite-reuse'\)\.markFreshOwed\(pool, \{\s+sessionId, commitSha: requestedHead,/);
  // Deploying a preview by hand.
  // On the exact head, resolved once, and before the machine is asked
  // (behaviourally: tests/unit-suite-reuse-machine-postgres.test.js).
  assert.match(sessions, /const head = await previewWorkflow\.exactHead\(pool, session, commitHash === 'latest' \? null : commitHash\);[\s\S]{0,600}markFreshOwed\(pool, \{ sessionId: session\.id, commitSha: head \}\);[\s\S]{0,300}const out = await previewWorkflow\.request\(\{\s+pool, session, head, reason: 'deploy'/);
  // Every recheck a person asks for (the route, testing-update), before the
  // machine is asked: tests/recheck-moved-head.test.js.
  assert.match(read('src/services/staging-recovery.js'), /if \(checkTriggerForReason\(reason\) === 'manual-recheck'\) \{[\s\S]{0,700}markFreshOwed\(pool, \{\s+sessionId: session\.id, commitSha: await requestedRecheckHead\(pool, session\),\s+\}\);/);
  // And the machine's 'manual-recheck' pending stamp, every way it starts
  // a run for a person.
  assert.match(read('src/workflow/preview/check-store.ts'), /unit_suite_fresh_sha = CASE WHEN \$4::text = 'manual-recheck' AND \$2::text IS NOT NULL\s+THEN lower\(\$2::text\) ELSE unit_suite_fresh_sha END,/,
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
    await rowStore.setChecksPending(pool, s.id, SHA, 'testing', 'boot-reconcile');
    assert.equal((await read()).unit_suite_fresh_sha, null);
    assert.equal(await rowStore.storeChecks(pool, s.id, SHA, { state: 'passing', results: [reusedRow] }), true);

    // A person presses "Run checks again" on that head.
    await rowStore.setChecksPending(pool, s.id, SHA, 'building', 'manual-recheck');
    assert.equal((await read()).unit_suite_fresh_sha, SHA, 'the request is on the row, durably');
    // The run that answers copied a pass (it decided before the press, or
    // it was collected): its verdict is refused, the head stays pending.
    assert.equal(await rowStore.storeChecks(pool, s.id, SHA, { state: 'passing', results: [reusedRow] }), false);
    assert.equal(await rowStore.storeChecks(pool, s.id, SHA, { state: 'error', results: [reusedRow] }), false);
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
    assert.equal(await rowStore.storeChecks(pool, s.id, SHA, { state: 'error', results: [unitRow({ status: 'fail', couldNotRun: true })] }), true);
    assert.equal((await read()).unit_suite_fresh_sha, SHA);
    // The suite really runs: stored, and the request is settled.
    await rowStore.setChecksPending(pool, s.id, SHA, 'testing', 'manual-recheck');
    assert.equal(await rowStore.storeChecks(pool, s.id, SHA, { state: 'passing', results: [unitRow({})] }), true);
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
  await rowStore.storeChecks(storePool, run.session.id, run.commitHash, {
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
  await rowStore.setChecksPending(pool, s.id, SHA, 'testing', 'commit-push');
  assert.equal(await rowStore.storeChecks(pool, s.id, SHA, { state: 'passing', results: [realUnit] }), true);

  // The press, folded into a busy session (the route's busy branch).
  await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: SHA });
  assert.equal((await row()).check_state, 'passing');
  assert.equal(unitSuiteRow.freshSuiteOwed(await row()), true, 'the merge gate reads it as not checked, real old pass or not');
  let busy = 2;
  const rechecks = [];
  // The stamp is the preview machine's (RecheckFolded, through the real
  // runtime in tests/unit-suite-reuse-machine-postgres.test.js); here its
  // write stands in for it.
  const folded = [];
  const platform = { recheckFolded: async (o) => {
    folded.push(o);
    await rowStore.setChecksPending(pool, o.sessionId, o.head, null, 'manual-recheck');
  } };
  await reuse.owePendingRun({
    pool, platform, config: {}, session: { ...s, checks_commit_sha: SHA }, busy: () => busy-- > 0, pollMs: 10,
    stagingRecovery: { recheckSessionChecks: async (args) => { rechecks.push(args.reason); } },
  });
  assert.deepEqual(folded, [{ sessionId: s.id, appId: app.id, head: SHA }], 'the machine is asked, for the head they asked about');
  let r = await row();
  assert.equal(r.check_state, 'pending', 'the old pass no longer stands');
  assert.equal(r.check_trigger, 'manual-recheck');
  assert.equal(unitSuiteRow.freshSuiteOwed(r), true);
  // Pending and owed: in the error lane's scope, and the machine's own
  // ChecksDue runs it if this process goes (the drain test below).
  assert.equal(require('../src/services/staging-recovery').isStuckCheckRecoveryScope({ ...r, status: 'active', source: 'native' }), true);
  for (let i = 0; i < 100 && !rechecks.length; i += 1) await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(rechecks, ['manual-recheck'], 'idle again: the owed run starts');

  // The owed run's real suite settles it.
  assert.equal(await rowStore.storeChecks(pool, s.id, SHA, { state: 'passing', results: [realUnit] }), true);
  r = await row();
  assert.equal(r.unit_suite_fresh_sha, null);
  assert.equal(unitSuiteRow.freshSuiteOwed(r), false);

  // Already answered by the time the session is idle: nothing more starts.
  await reuse.markFreshOwed(pool, { sessionId: s.id, commitSha: SHA });
  const more = [];
  await reuse.owePendingRun({
    pool, platform, config: {}, session: { ...s, checks_commit_sha: SHA }, busy: () => false, pollMs: 10,
    stagingRecovery: { recheckSessionChecks: async (args) => { more.push(args.reason); } },
  });
  await rowStore.storeChecks(pool, s.id, SHA, { state: 'passing', results: [realUnit] });
  await new Promise((res) => setTimeout(res, 60));
  assert.deepEqual(more, []);

  const route = read('src/routes/sessions.js');
  const recheck = route.slice(route.indexOf("router.post('/api/sessions/:id/recheck'"), route.indexOf("router.post('/api/sessions/:id/recheck'") + 9000);
  assert.match(recheck, /const busyNow = \(\) => isSessionBusyAnywhere\(sessionId, \{ pool \}\);\s+if \(await busyNow\(\)\) \{\s+await require\('\.\.\/services\/unit-suite-reuse'\)\.owePendingRun\(\{\s+pool, stagingRecovery, config, session, busy: busyNow, head: requestedHead,\s+\}\);\s+return res\.json\(\{ status: 'running' \}\);/);
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
  await rowStore.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
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
  await rowStore.setChecksPending(pool, session.id, SHA, 'testing', 'boot-reconcile');
  assert.equal(await rowStore.storeChecks(pool, session.id, SHA, { state: 'error', results: [] }, 'preview not ready'), true);
  assert.equal((await read()).unit_suite_fresh_sha, SHA);
  // Nor does an automatic run then copy a pass for it.
  const pass = await unitSuite.reusablePass({
    config, pool, appId: app.id, sessionId: session.id, repoOwner: 'o', repoName: 'r', commitSha: SHA, trigger: 'stuck-sweep',
  });
  assert.equal(pass, null);

  // The repository has no runnable test script: confirmed absent, answered.
  await rowStore.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
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
  await rowStore.setChecksPending(pool, session.id, SHA, 'testing', 'commit-push');
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

test('postgres: once the in-process drain is gone, the preview machine itself runs every open proposal\'s owed fresh run of its head', async (t) => {
  // The route's busy branch folds a person's request into what the session
  // is doing (owePendingRun → the machine's RecheckFolded) and waits in
  // process for it to be idle. When that process goes, the machine's own
  // deadline (ChecksDue, src/workflow/preview/machine.ts) runs the request
  // once nobody works on the session. It replaced the leader's stuck-checks
  // sweeps. The real machine and kernel; the work kinds are faked, as in
  // tests/unit-suite-reuse-machine-postgres.test.js.
  const pool = await fullSchemaDb(t);
  if (!pool) return;
  const { createRuntime } = require('../src/workflow/kernel/index.ts');
  const { preview, sessionKey, MACHINE, WORK } = require('../src/workflow/preview/machine.ts');
  await pool.query(`INSERT INTO wf_settings (key, value) VALUES ('enabled:${MACHINE}', '1') ON CONFLICT DO NOTHING`);
  const unitKey = require('../src/services/app-manifest').checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH);
  const browser = { index: 0, name: 'Loads /', path: '/', status: 'pass' };
  const verdict = (extra = {}) => ({
    outcome: 'verdict', state: 'passing', results: [browser], console: { state: 'clean', errors: [] },
    history: [{ checkKey: 'k1', name: 'Loads /', path: '/', passes: 1, fails: 0 }],
    capture: { state: 'console_only', detail: { media: false } }, visuals: false, ...extra,
  });
  // A person's run really runs the suite.
  const fresh = verdict({
    results: [browser, { index: -3, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', status: 'pass', advisory: false }],
    unitObserved: unitKey,
    history: [{ checkKey: 'k1', name: 'Loads /', path: '/', passes: 1, fails: 0 },
      { checkKey: unitKey, name: unitSuite.UNIT_CHECK_NAME, path: 'package.json', passed: true }],
  });
  const asked = [];
  const fake = (kind) => ({
    maxAttempts: 2, backoffMs: () => 0, leaseMs: 600,
    async run({ input }) {
      if (kind === WORK.prepare) {
        return { ok: true, url: `https://pv--s${input.sessionId}.apps.test`, runtimeKind: 'kubernetes',
          runtimeName: `sv-preview-1-s${input.sessionId}`, containerId: null, imageRef: `img@sha256:${input.n}`, buildRef: `b-${input.n}` };
      }
      if (kind === WORK.run) {
        asked.push([input.sessionId, input.trigger]);
        return input.trigger === 'manual-recheck' ? fresh : verdict();
      }
      if (kind === WORK.retire) return { closed: true };
      return { ok: true };
    },
  });
  const machine = preview({ maxRetries: 6, retireAfterMs: 0 });
  const rt = createRuntime({
    pool, machines: [machine], pollMs: 50, publish: async () => {},
    services: Object.fromEntries(Object.values(WORK).map((k) => [k, fake(k)])),
  });
  t.after(() => rt.stop());
  let rk = 0;
  const send = (id, appId, type, payload, source = { kind: 'system' }) => rt.append(machine, sessionKey(id), { type, payload },
    { requestKey: `t-${++rk}`, source, appId });
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const instance = async (id) => (await pool.query(
    'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [MACHINE, sessionKey(id)])).rows[0];
  const row = async (id) => (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [id])).rows[0];
  // Bring the deadlines that are set forward, as the pipeline would write them.
  const due = async (ids) => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await c.query(`UPDATE wf_instances SET deadline_at = now()
                      WHERE machine = $1 AND key = ANY($2::text[]) AND deadline_at IS NOT NULL`, [MACHINE, ids.map(sessionKey)]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };

  const { rows: [u] } = await pool.query("INSERT INTO users (username, password) VALUES ('scope-test', 'x') RETURNING id");
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (slug, name, repo_url, created_by) VALUES ('scope-test', 'T', 'https://github.com/o/r', $1) RETURNING id", [u.id]);
  let pr = 0;
  // A proposal whose preview the machine built and checked on SHA.
  const add = async (status, source) => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (user_id, app_id, status, source, branch_name, pr_number)
       VALUES ($1, $2, $3, $4, 'b-' || md5(random()::text), $5) RETURNING id`, [u.id, app.id, status, source, ++pr]);
    await send(s.id, app.id, 'RevisionSubmitted', { sessionId: s.id, head: SHA, source: 'test', trigger: 'commit-push' });
    await settle();
    assert.deepEqual([(await instance(s.id)).state, (await row(s.id)).check_state], ['settled', 'passing'], `${status} ${source}`);
    return s.id;
  };
  const pausedCli = await add('paused', 'cli_handoff');
  const activeNative = await add('active', 'native');
  const notOwed = await add('active', 'native');
  const otherHead = await add('active', 'native');
  assert.deepEqual(asked.map(([, trigger]) => trigger), ['commit-push', 'commit-push', 'commit-push', 'commit-push']);
  for (const id of [pausedCli, activeNative, notOwed, otherHead]) {
    assert.equal((await instance(id)).deadline_at, null, 'a settled preview owing nothing has no deadline');
  }

  // A person presses "Run checks again" while the session is busy: the head
  // is marked owed, and the request folded into the machine. The process
  // that would have started the run when the session went idle is gone.
  await pool.query("UPDATE chat_sessions SET active_turn = jsonb_build_object('id', 'turn-1', 'startedAt', now()) WHERE id = $1", [activeNative]);
  for (const id of [pausedCli, activeNative]) {
    await reuse.markFreshOwed(pool, { sessionId: id, commitSha: SHA });
    await send(id, app.id, 'RecheckFolded', { head: SHA, sessionId: id }, { kind: 'route', name: 'manual-recheck' });
  }
  // A request about another head is not this head's.
  await reuse.markFreshOwed(pool, { sessionId: otherHead, commitSha: OTHER });
  await rt.drain();
  for (const id of [pausedCli, activeNative]) {
    const r = await row(id);
    assert.deepEqual([r.check_state, r.check_trigger, r.unit_suite_fresh_sha], ['pending', 'manual-recheck', SHA]);
    const i = await instance(id);
    assert.equal(i.deadline_event?.type, 'ChecksDue', 'the machine owes the run itself');
    const inMs = new Date(i.deadline_at).getTime() - Date.now();
    assert.ok(inMs > 9 * 60 * 1000 && inMs <= 10 * 60 * 1000, `ten minutes on: ${inMs}`);
  }
  // Any transition reads what the row owes: the release's IdleDue to an
  // instance with no deadline arms nothing for one that owes nothing.
  for (const id of [notOwed, otherHead]) await send(id, app.id, 'IdleDue', {});
  await rt.drain();
  for (const id of [notOwed, otherHead]) assert.equal((await instance(id)).deadline_at, null, `session ${id} owes nothing`);

  // The deadline comes. A session someone works on is looked at again a
  // minute later, with nothing started; the other runs the owed request as
  // the person's.
  await due([pausedCli, activeNative]);
  await rt.fireTimers();
  await settle();
  assert.deepEqual(asked.slice(4), [[pausedCli, 'manual-recheck']]);
  let r = await row(pausedCli);
  assert.deepEqual([r.check_state, r.unit_suite_fresh_sha], ['passing', null], 'their run answered them');
  const waiting = await instance(activeNative);
  assert.equal(waiting.state, 'settled');
  assert.equal(waiting.deadline_event?.type, 'ChecksDue');
  assert.ok(new Date(waiting.deadline_at).getTime() - Date.now() <= 60 * 1000, 'a minute on, while the turn runs');

  // The turn ends: the next look runs it.
  await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [activeNative]);
  await due([activeNative]);
  await rt.fireTimers();
  await settle();
  assert.deepEqual(asked.slice(5), [[activeNative, 'manual-recheck']]);
  r = await row(activeNative);
  assert.deepEqual([r.check_state, r.unit_suite_fresh_sha], ['passing', null]);
  assert.equal((await row(otherHead)).check_state, 'passing', 'nothing ran for a request about another head');

  // Answered, nothing more is owed: a deadline still set finds nothing to
  // run, and leaves none behind.
  await due([pausedCli, activeNative, notOwed, otherHead]);
  await rt.fireTimers();
  await settle();
  assert.equal(asked.length, 6);
  for (const id of [pausedCli, activeNative, notOwed, otherHead]) {
    const i = await instance(id);
    assert.deepEqual([i.state, i.deadline_at], ['settled', null], `session ${id}`);
  }
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
    await rowStore.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
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
    await rowStore.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
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
  await rowStore.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
  await settle(flaky);
  assert.equal(failMarkerRead, false, 'the read did fail');
  const { rows: [r] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [session.id]);
  assert.equal(r.check_state, 'pending', 'no stored pass for a request nothing answered');
  assert.equal(r.unit_suite_fresh_sha, SHA);
  // Pending and owed: in the error lane's scope, so the machine's own
  // ChecksDue runs it.
  assert.equal(require('../src/services/staging-recovery').isStuckCheckRecoveryScope(r), true);

  // The same failed read on a repository whose package.json has no test
  // script (and no recorded pass): the suite is confirmed absent, which
  // answers the request even though the marker could not be read.
  t.mock.method(github, 'getFileContent', async () => JSON.stringify({ scripts: {} }));
  failMarkerRead = true;
  await rowStore.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
  await settle(flaky);
  assert.equal(failMarkerRead, false);
  const { rows: [answered] } = await pool.query('SELECT check_state, unit_suite_fresh_sha FROM chat_sessions WHERE id = $1', [session.id]);
  assert.deepEqual([answered.check_state, answered.unit_suite_fresh_sha], ['passing', null]);

  // A run of a head nobody asked about is stored as it always was.
  const { session: other, app: app2 } = await settleFixture(pool, 'markerread-control');
  await rowStore.setChecksPending(pool, other.id, SHA, 'testing', 'commit-push');
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
    await rowStore.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
    await settle();
  } finally { delete process.env.UNIT_SUITE_CHECK_ENABLED; }
  assert.deepEqual(Object.values(await read()), ['passing', null], 'switched off: nothing to run, the request is answered');
  // Switched on, the same recorded pass still keeps an unreadable
  // repository from being taken as having no suite.
  t.mock.method(github, 'getFileContent', async () => null);
  t.mock.method(github, 'listRepoFiles', async () => ({ files: [], truncated: false }));
  await rowStore.setChecksPending(pool, session.id, SHA, 'testing', 'manual-recheck');
  await settle();
  assert.deepEqual(Object.values(await read()), ['error', SHA]);
});

// ── The same tree under another commit (main-watch) ──────────────────────
//
// A squash merge of a proposal that was level with main lands the
// proposal's tree under a new commit, minutes after the proposal passed the
// suite on it. Main-watch's first run of that merge copies the pass by tree
// (services/unit-suite-reuse.js findTreePass); everything else in the key,
// the age limit and the observation still hold.

test('the tree is read from GitHub by commit, once per commit, and never trusted when it is not a tree id', async () => {
  reuse._clearTreeCache();
  const asked = [];
  const gh = { getCommitTree: async (owner, repo, sha) => { asked.push([owner, repo, sha]); return TREE.toUpperCase(); } };
  assert.equal(await reuse.treeOf({ github: gh, owner: 'Usernode-Labs', repo: 'social-vibecoding', commitSha: SHA }), TREE);
  assert.equal(await reuse.treeOf({ github: gh, owner: 'usernode-labs', repo: 'Social-Vibecoding', commitSha: SHA.toUpperCase() }), TREE);
  assert.deepEqual(asked, [['Usernode-Labs', 'social-vibecoding', SHA]], 'a commit names its tree for good: asked once');
  assert.equal(await reuse.treeOf({ github: gh, owner: 'o', repo: 'r', commitSha: 'main' }), null, 'never a ref that moves');
  assert.equal(asked.length, 1);
  const broken = { getCommitTree: async () => { throw new Error('GitHub 502'); } };
  assert.equal(await reuse.treeOf({ github: broken, owner: 'o', repo: 'r', commitSha: OTHER }), null, 'unreadable: no tree');
  const odd = { getCommitTree: async () => 'not-a-tree' };
  assert.equal(await reuse.treeOf({ github: odd, owner: 'o', repo: 'r', commitSha: MERGE }), null);
  // Nothing unreadable is remembered: the next ask asks again.
  assert.equal(await reuse.treeOf({ github: gh, owner: 'o', repo: 'r', commitSha: OTHER }), TREE);
  reuse._clearTreeCache();
});

test('a tree lookup matches the tree in place of the commit, and every other part of the key, the age and the observation', async () => {
  const key = reuse.keyFor(config, { ...keyArgs, commitSha: MERGE, treeSha: TREE });
  const pool = recordingPool([{ id: 4, session_id: 8726, run_id: 'run-p', summary: { tests: 9, pass: 9 }, passed_at: new Date('2026-10-16T08:15:46Z'), commit_sha: SHA }]);
  const found = await reuse.findTreePass(pool, key);
  assert.deepEqual(found, {
    id: 4, sessionId: 8726, runId: 'run-p', summary: { tests: 9, pass: 9 }, passedAt: '2026-10-16T08:15:46.000Z', commitSha: SHA, treeSha: TREE,
  });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE p\.app_id = \$1 AND p\.repo = \$2 AND p\.tree_sha = \$3 AND p\.image = \$4 AND p\.job_definition = \$5/);
  assert.doesNotMatch(sql, /p\.commit_sha = /, 'any commit');
  assert.match(sql, /p\.passed_at > NOW\(\) - make_interval\(secs => \$6::double precision\)/);
  assert.match(sql, /AND p\.observed_at IS NOT NULL/);
  assert.match(sql, /WHERE cs\.id = p\.session_id AND lower\(cs\.unit_suite_fresh_sha\) = p\.commit_sha\)/, 'not a pass its proposal was asked to re-run');
  assert.deepEqual(params, [10, 'usernode-labs/social-vibecoding', TREE, DIGEST, keyArgs.jobHash, 3 * 3600]);

  const none = recordingPool([]);
  assert.equal(await reuse.findTreePass(none, reuse.keyFor(config, { ...keyArgs, commitSha: MERGE })), null);
  assert.equal(none.calls.length, 0, 'no tree, nothing looked up');
  const broken = { async query() { throw new Error('db down'); } };
  assert.equal(await reuse.findTreePass(broken, key), null, 'a failed lookup runs the suite');
  withEnv('UNIT_SUITE_REUSE', '0', () => assert.equal(reuse.keyFor(config, { ...keyArgs, treeSha: TREE }), null, 'the off switch covers it'));
});

test('a proposal\'s run still matches by its own commit only: its row says "this commit passed it"', async () => {
  const key = reuse.keyFor(config, { ...keyArgs, treeSha: TREE });
  const pool = recordingPool([]);
  await reuse.findPass(pool, key, { trigger: 'boot-reconcile' });
  assert.match(pool.calls[0].sql, /p\.commit_sha = \$3/);
  assert.doesNotMatch(pool.calls[0].sql, /tree_sha/);
  const src = read('src/services/visuals.js') + read('src/workflow/preview/services.ts');
  assert.doesNotMatch(src, /reusableTreePass/, 'only main-watch copies by tree');
});

// reusableTreePass, as main-watch calls it, with the real reuse module.
function treeRun(t, { tree = TREE, rows = null, fail = null } = {}) {
  reuse._clearTreeCache();
  t.mock.method(github, 'isEnabled', () => true);
  const trees = [];
  t.mock.method(github, 'getCommitTree', async (owner, repo, sha) => {
    trees.push(sha);
    if (tree instanceof Error) throw tree;
    return tree;
  });
  const pool = fail ? { calls: [], async query() { throw fail; } }
    : recordingPool(rows || [{ id: 5, session_id: 8726, run_id: 'run-p', summary: PASS.summary, passed_at: new Date(PASS.passedAt), commit_sha: SHA }]);
  return { pool, trees };
}
const treeArgs = (pool, extra = {}) => ({ config, pool, appId: 10, appSlug: SELF, repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding', commitSha: MERGE, ...extra });

test('reusableTreePass: a merge copies the pass of its tree, and the row names the commit and tree it came from', async (t) => {
  const { pool, trees } = treeRun(t);
  const out = await unitSuite.reusableTreePass(treeArgs(pool));
  assert.deepEqual(trees, [MERGE], 'the merge\'s own tree, read by its commit');
  assert.equal(out.row.status, 'pass');
  assert.deepEqual(out.row.reused, { runId: 'run-p', sessionId: 8726, passedAt: PASS.passedAt, commitSha: SHA, treeSha: TREE });
  assert.deepEqual(out.reused, out.row.reused);
  assert.equal(out.history, null, 'copying is not an observation');
  assert.deepEqual(pool.calls[0].params.slice(0, 5), [10, 'usernode-labs/social-vibecoding', TREE, DIGEST, unitSuite.jobHash()]);
});

test('reusableTreePass: no tree, no pass, a failed lookup, Docker, or reuse off all run the suite', async (t) => {
  await t.test('the tree cannot be read', async (st) => {
    const { pool } = treeRun(st, { tree: new Error('GitHub 502') });
    assert.equal(await unitSuite.reusableTreePass(treeArgs(pool)), null);
    assert.equal(pool.calls.length, 0);
  });
  await t.test('no pass of that tree', async (st) => {
    const { pool } = treeRun(st, { rows: [] });
    assert.equal(await unitSuite.reusableTreePass(treeArgs(pool)), null);
  });
  await t.test('the database cannot be read', async (st) => {
    const { pool } = treeRun(st, { fail: new Error('connection reset') });
    assert.equal(await unitSuite.reusableTreePass(treeArgs(pool)), null);
  });
  await t.test('Docker runs a tag: no digest to match', async (st) => {
    const { pool } = treeRun(st);
    assert.equal(await unitSuite.reusableTreePass({ ...treeArgs(pool), config: { workerRuntime: 'docker' } }), null);
  });
  await t.test('reuse off', async (st) => {
    const { pool, trees } = treeRun(st);
    await withEnv('UNIT_SUITE_REUSE', '0', () => unitSuite.reusableTreePass(treeArgs(pool))).then((out) => assert.equal(out, null));
    assert.deepEqual(trees, [], 'not even the tree is read');
  });
});

test('postgres: a pass is found by its tree under another commit, and only under the same image, job, age and observation', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const schema = `unit_suite_tree_test_${process.pid}`;
  const { pool } = conn;
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query(DDL);
    await pool.query('CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, unit_suite_fresh_sha TEXT)');
    await pool.query('INSERT INTO chat_sessions (id) VALUES (8726), (8727)');
    // Proposal 8726 passed on its head SHA, whose tree is TREE.
    const head = reuse.keyFor(config, { ...keyArgs, treeSha: TREE });
    assert.equal(await reuse.recordPass(pool, head, { sessionId: 8726, runId: 'run-p', summary: { tests: 3, pass: 3 } }), true);
    // The squash merge MERGE landed the same tree.
    const merge = reuse.keyFor(config, { ...keyArgs, commitSha: MERGE, treeSha: TREE });
    assert.equal(await reuse.findTreePass(pool, merge), null, 'not until its run stored its verdict and history');
    await checkStore.markUnitPassObserved(pool, { appId: 10, sessionId: 8726, commitSha: SHA });
    const found = await reuse.findTreePass(pool, merge);
    assert.deepEqual([found.runId, found.sessionId, found.commitSha, found.treeSha], ['run-p', 8726, SHA, TREE], 'a tree hit across commits');
    assert.equal(await reuse.findPass(pool, merge, { trigger: 'boot-reconcile' }), null, 'by commit, the merge has no pass of its own');

    const differs = {
      'another tree': { ...merge, treeSha: OTHER_TREE },
      'another image digest': { ...merge, image: NEW_DIGEST },
      'another job definition': { ...merge, jobHash: 'j'.repeat(64) },
      'another repository': { ...merge, repo: 'someone/fork' },
      'another app': { ...merge, appId: 11 },
      'no tree known': { ...merge, treeSha: null },
    };
    for (const [why, other] of Object.entries(differs)) {
      assert.equal(await reuse.findTreePass(pool, other), null, why);
    }
    // A person asked proposal 8726 to run its head again: that pass is
    // doubted, and main runs the suite itself.
    await reuse.markFreshOwed(pool, { sessionId: 8726, commitSha: SHA });
    assert.equal(await reuse.findTreePass(pool, merge), null, 'its proposal owes a fresh run of it');
    await pool.query('UPDATE chat_sessions SET unit_suite_fresh_sha = NULL');
    // A request on another proposal is not about this pass.
    await reuse.markFreshOwed(pool, { sessionId: 8727, commitSha: SHA });
    assert.ok(await reuse.findTreePass(pool, merge));
    // The age limit.
    await pool.query(`UPDATE unit_suite_passes SET passed_at = NOW() - interval '2 hours 50 minutes'`);
    assert.ok(await reuse.findTreePass(pool, merge), 'inside 3 hours');
    await pool.query(`UPDATE unit_suite_passes SET passed_at = NOW() - interval '3 hours 10 minutes'`);
    assert.equal(await reuse.findTreePass(pool, merge), null, 'too old');
    // The newest of several passes of the tree.
    await reuse.recordPass(pool, { ...head, commitSha: OTHER }, { sessionId: 8727, runId: 'run-q' });
    await checkStore.markUnitPassObserved(pool, { appId: 10, sessionId: 8727, commitSha: OTHER });
    assert.equal((await reuse.findTreePass(pool, merge)).runId, 'run-q');
    // The lookup the index is for.
    const { rows: [plan] } = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_unit_suite_passes_tree'", [schema]);
    assert.match(plan.indexdef, /\(app_id, tree_sha, passed_at DESC\) WHERE \(tree_sha IS NOT NULL\)/);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await pool.end().catch(() => {});
  }
});

test('postgres: the tree column arrives on a table that already holds passes, as often as the schema runs', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const schema = `unit_suite_tree_migrate_${process.pid}`;
  const { pool } = conn;
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    // The table as it was before the column: CREATE TABLE and its first index.
    const before = DDL.slice(0, DDL.indexOf('ALTER TABLE unit_suite_passes ADD COLUMN IF NOT EXISTS tree_sha'));
    assert.doesNotMatch(before, /tree_sha/);
    await pool.query(before);
    await pool.query('CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, unit_suite_fresh_sha TEXT)');
    await pool.query(`INSERT INTO unit_suite_passes (app_id, repo, commit_sha, image, job_definition, session_id, run_id, observed_at)
      VALUES (10, 'usernode-labs/social-vibecoding', $1, $2, $3, 8401, 'run-old', NOW())`, [SHA, DIGEST, keyArgs.jobHash]);
    // Boot runs the whole schema, every time.
    await pool.query(DDL);
    await pool.query(DDL);
    const { rows: cols } = await pool.query(
      "SELECT data_type, character_maximum_length FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'unit_suite_passes' AND column_name = 'tree_sha'", [schema]);
    assert.deepEqual(cols, [{ data_type: 'character varying', character_maximum_length: 40 }]);
    // The pass from before still answers by commit, and by tree nothing.
    const key = reuse.keyFor(config, { ...keyArgs, treeSha: TREE });
    assert.equal((await reuse.findPass(pool, key, { trigger: 'boot-reconcile' })).runId, 'run-old');
    assert.equal(await reuse.findTreePass(pool, key), null, 'an old row has no tree');
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await pool.end().catch(() => {});
  }
});

// ── Only the audited repository, and never waiting on GitHub ─────────────
//
// Review of #5430: tree reuse was open to every project, but only the
// platform's own tests were audited for not reading the commit. And a slow
// GitHub held verdicts. Both pinned here.

test('tree reuse is for the platform\'s own app on the audited repository only', () => {
  const ok = { appSlug: SELF, repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding' };
  assert.equal(reuse.treeReuseAudited(config, ok), true);
  assert.equal(reuse.treeReuseAudited(config, { ...ok, repoOwner: 'usernode-labs', repoName: 'SOCIAL-VIBECODING' }), true, 'GitHub names ignore case');
  assert.equal(reuse.treeReuseAudited(config, { ...ok, appSlug: 'another-app' }), false, 'another app on the same repository');
  assert.equal(reuse.treeReuseAudited(config, { ...ok, repoOwner: 'someone' }), false, 'a fork, whose tests nobody audited');
  assert.equal(reuse.treeReuseAudited(config, { ...ok, repoName: 'their-app' }), false, 'another project');
  assert.equal(reuse.treeReuseAudited({ ...config, selfAppSlug: undefined }, ok), false, 'no platform app known');
  assert.equal(reuse.treeReuseAudited(config, { ...ok, appSlug: null }), false);
  assert.deepEqual([...reuse.TREE_AUDITED_REPOS], ['usernode-labs/social-vibecoding']);
  // The platform's own app is config.js's SELF_APP_SLUG.
  assert.match(read('src/config.js'), /const SELF_APP_SLUG = 'usernode-2d5619';/);
  assert.match(read('src/services/main-watch.js'), /appSlug: app\.slug, repoOwner: parsed\.owner, repoName: parsed\.repo,\s+commitSha: mergeSha, signal,/);
});

test('regression: a project whose test reads the commit passes one commit of a tree and fails the other, so it never reuses by tree', { skip: (!hasBash || !hasGit) && 'no bash or git' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-reuse-meta-'));
  try {
    const repo = path.join(dir, 'repo');
    const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    fs.mkdirSync(repo);
    git('init', '-q');
    // The test fails unless the commit's subject is the proposal's.
    fs.writeFileSync(path.join(repo, 'test.cjs'), [
      "const s = require('child_process').execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();",
      "if (s !== 'proposal head') { console.error('subject: ' + s); process.exit(1); }",
    ].join('\n'));
    git('add', 'test.cjs');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'proposal head');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    const tree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
    // The squash merge: the same tree, another commit.
    const merge = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'Squash merge (#1)'],
      { encoding: 'utf8' }).stdout.trim();
    git('update-ref', 'refs/heads/merged', merge);
    assert.equal(git('rev-parse', `${merge}^{tree}`).stdout.trim(), tree);
    git('config', 'uploadpack.allowReachableSHA1InWant', 'true');
    // The production checkout of each, then the project's test in it.
    const script = unitSuite.RUN_SCRIPT;
    const upTo = script.indexOf('\n', script.indexOf(`${unitSuite.HEAD_SENTINEL}=`)) + 1;
    const run = (ref) => spawnSync('bash', ['-c', `${script.slice(0, upTo)}node test.cjs`], {
      encoding: 'utf8', env: { ...process.env, REPO_URL: `file://${repo}`, GIT_REF: ref, PR_NUMBER: '' },
    }).status;
    assert.deepEqual([run(head), run(merge)], [0, 1], 'one tree, two verdicts');

    // Its proposal head passed and was observed; main-watch's run of the
    // merge copies nothing for it, and asks GitHub nothing.
    t.mock.method(github, 'isEnabled', () => true);
    const asked = t.mock.method(github, 'getCommitTree', async () => tree);
    const pool = recordingPool([{ id: 9, session_id: 1, run_id: 'run-p', summary: { tests: 1, pass: 1 }, passed_at: new Date(), commit_sha: head }]);
    const args = { config, pool, appId: 1234, appSlug: 'commit-reader', repoOwner: 'someone', repoName: 'commit-reader', commitSha: merge };
    assert.equal(await unitSuite.reusableTreePass(args), null);
    assert.equal(asked.mock.callCount(), 0);
    assert.equal(pool.calls.length, 0);
    // The same project as the platform's app slug still fails the repository test.
    assert.equal(await unitSuite.reusableTreePass({ ...args, appSlug: SELF }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reusableTreePass gives up at its deadline or when the run is cancelled, and the suite runs', async (t) => {
  reuse._clearTreeCache();
  t.mock.method(github, 'isEnabled', () => true);
  t.mock.method(github, 'getCommitTree', () => new Promise(() => {}));
  const pool = recordingPool([]);
  const before = process.env.UNIT_SUITE_TREE_LOOKUP_MS;
  try {
    process.env.UNIT_SUITE_TREE_LOOKUP_MS = '50';
    let started = Date.now();
    assert.equal(await unitSuite.reusableTreePass(treeArgs(pool)), null, 'GitHub never answered');
    assert.ok(Date.now() - started < 1000, 'bounded');
    process.env.UNIT_SUITE_TREE_LOOKUP_MS = '600000';
    const ac = new AbortController();
    started = Date.now();
    const pending = unitSuite.reusableTreePass({ ...treeArgs(pool), signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    assert.equal(await pending, null, 'cancelled with its run');
    assert.ok(Date.now() - started < 1000);
    const gone = new AbortController();
    gone.abort();
    assert.equal(await unitSuite.reusableTreePass({ ...treeArgs(pool), signal: gone.signal }), null, 'already cancelled');
    assert.equal(pool.calls.length, 0);
  } finally {
    if (before === undefined) delete process.env.UNIT_SUITE_TREE_LOOKUP_MS; else process.env.UNIT_SUITE_TREE_LOOKUP_MS = before;
  }
  assert.equal(reuse.treeDeadlineMs(), 5000, 'five seconds unless set');
});

test('postgres: the tree set after the pass keeps its observation, whichever comes first', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const schema = `unit_suite_tree_enrich_${process.pid}`;
  const { pool } = conn;
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query(DDL);
    await pool.query('CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, unit_suite_fresh_sha TEXT)');
    await pool.query('INSERT INTO chat_sessions (id) VALUES (8726), (8727)');
    const key = reuse.keyFor(config, keyArgs);
    const merge = reuse.keyFor(config, { ...keyArgs, commitSha: MERGE, treeSha: TREE });
    // Observed first, tree after.
    await reuse.recordPass(pool, key, { sessionId: 8726, runId: 'run-p' });
    await checkStore.markUnitPassObserved(pool, { appId: 10, sessionId: 8726, commitSha: SHA });
    const { rows: [o1] } = await pool.query('SELECT observed_at FROM unit_suite_passes');
    assert.equal(await reuse.findTreePass(pool, merge), null, 'no tree yet');
    assert.equal(await reuse.recordTree(pool, { appId: 10, commitSha: SHA, treeSha: TREE }), 1);
    const { rows: [o2] } = await pool.query('SELECT observed_at, tree_sha FROM unit_suite_passes');
    assert.deepEqual([o2.observed_at.getTime(), o2.tree_sha], [o1.observed_at.getTime(), TREE], 'the observation stands');
    assert.equal((await reuse.findTreePass(pool, merge)).runId, 'run-p');
    assert.equal(await reuse.recordTree(pool, { appId: 10, commitSha: SHA, treeSha: OTHER_TREE }), 0, 'a tree once set is not replaced');
    // Tree first, observed after.
    await reuse.recordPass(pool, { ...key, commitSha: OTHER }, { sessionId: 8727, runId: 'run-q' });
    assert.equal(await reuse.recordTree(pool, { appId: 10, commitSha: OTHER, treeSha: TREE }), 1);
    assert.equal((await reuse.findTreePass(pool, merge)).runId, 'run-p', 'unobserved: not copied');
    await checkStore.markUnitPassObserved(pool, { appId: 10, sessionId: 8727, commitSha: OTHER });
    assert.equal((await reuse.findTreePass(pool, merge)).runId, 'run-q');
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await pool.end().catch(() => {});
  }
});
