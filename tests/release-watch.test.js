// services/release-watch.js: a merged commit of the platform's own app that
// has not become the running release.
//
// The self-hosted row's main_sha is the build that is serving; GitHub's main
// is what should be. Everything between — the image workflow, the Helm
// release, Argo CD, the rollout — runs outside the platform, and when a link
// fails the merge reads "merged" here while production serves the previous
// commit. #2589 did for half an hour after one registry connection dropped
// during the image build. The drift poller hands that row's drift here; this
// pins what is said, when, and how many times.
//
// Run with: node --test tests/release-watch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const logged = [];
stub(require.resolve('../src/services/logger'), {
  info: (...a) => logged.push(['info', ...a]),
  warn: (...a) => logged.push(['warn', ...a]),
  error: (...a) => logged.push(['error', ...a]),
  debug: (...a) => logged.push(['debug', ...a]),
});
const posted = [];
stub(require.resolve('../src/services/ws'), {
  sendSystemMessage: async (pool, appId, content, kind) => { posted.push({ appId, content, kind }); },
  broadcastGlobal: () => {},
});
const notified = [];
const pushed = [];
stub(require.resolve('../src/services/notifications'), {
  createAppHealthNotification: async (pool, args) => { notified.push(args); return [{ id: 1, ...args }]; },
  hydrateAndPush: async (pool, row) => { pushed.push(row); },
});
stub(require.resolve('../src/services/github'), {
  parseGithubUrl: (url) => {
    const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(url || ''));
    return m ? { owner: m[1], repo: m[2] } : null;
  },
});

const releaseWatch = require('../src/services/release-watch');

const MERGED = '7817d05e0169594c5ad3affea1afd5af51521a5c';
const RUNNING = '741b8f75b9ce10a3c10cb60f4a0f72e5c48bd24c';
const RUN_URL = 'https://github.com/Usernode-Labs/social-vibecoding/actions/runs/35461203746';
const T0 = Date.parse('2026-09-19T18:26:31Z'); // when #2589 merged
const MIN = 60 * 1000;

function makePool() {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      return { rows: [], rowCount: 1 };
    },
  };
}

function selfApp(overrides = {}) {
  return {
    id: 10, slug: 'usernode-2d5619', self_hosted: true, main_sha: RUNNING,
    repo_url: 'https://github.com/Usernode-Labs/social-vibecoding', release_stall: null, ...overrides,
  };
}

const HEAD = {
  sha: MERGED, committedAt: new Date(T0).toISOString(),
  subject: 'Do not fail a proposal for a check that has no page (#2589)\n\nbody',
};

function actions(run) {
  return {
    rest: { actions: { listWorkflowRunsForRepo: async ({ head_sha }) => ({
      data: { workflow_runs: run && head_sha === MERGED ? [
        { id: 1, name: 'Deploy', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/y/actions/runs/1' },
        { id: 35461203746, name: 'Build Kubernetes images', path: releaseWatch.WORKFLOW_PATH, html_url: RUN_URL, ...run },
      ] : [] },
    }) } },
  };
}

function reset() {
  posted.length = 0; notified.length = 0; pushed.length = 0; logged.length = 0;
  releaseWatch._forTest.resetFirstSeen();
}

const written = (pool) => pool.queries.filter((q) => /SET release_stall = \$1/.test(q.sql))
  .map((q) => JSON.parse(q.params[0]));

test('classify: a red workflow is a stall at once; anything else only past the grace', () => {
  const grace = 10 * MIN;
  const failed = { status: 'completed', conclusion: 'failure' };
  assert.equal(releaseWatch.classify({ ageMs: 30 * 1000, run: failed, grace }), 'workflow_failed');
  for (const conclusion of ['cancelled', 'timed_out', 'startup_failure']) {
    assert.equal(releaseWatch.classify({ ageMs: 0, run: { status: 'completed', conclusion }, grace }), 'workflow_failed');
  }
  // Within the grace, a release still on its way says nothing.
  assert.equal(releaseWatch.classify({ ageMs: 3 * MIN, run: { status: 'in_progress', conclusion: null }, grace }), null);
  assert.equal(releaseWatch.classify({ ageMs: 3 * MIN, run: { status: 'completed', conclusion: 'success' }, grace }), null);
  assert.equal(releaseWatch.classify({ ageMs: 3 * MIN, run: null, grace }), null);
  // Past it, what GitHub says about the run decides which stall it is.
  assert.equal(releaseWatch.classify({ ageMs: grace, run: { status: 'in_progress', conclusion: null }, grace }), 'workflow_running');
  assert.equal(releaseWatch.classify({ ageMs: grace, run: { status: 'queued', conclusion: null }, grace }), 'workflow_running');
  assert.equal(releaseWatch.classify({ ageMs: grace, run: { status: 'completed', conclusion: 'success' }, grace }), 'rollout_missing');
  assert.equal(releaseWatch.classify({ ageMs: grace, run: null, grace }), 'unknown');
});

test('the PR comes off the squash subject, and only from its first line', () => {
  assert.equal(releaseWatch.prNumberFrom(HEAD.subject), 2589);
  assert.equal(releaseWatch.prNumberFrom('fix: a direct push'), null);
  assert.equal(releaseWatch.prNumberFrom('fix: something\n\nRefs (#12)'), null);
  assert.equal(releaseWatch.prNumberFrom(null), null);
});

test('a red release workflow is reported at once: record, group message, admins notified', async () => {
  reset();
  const pool = makePool();
  const now = T0 + 90 * 1000; // ninety seconds in — well inside the grace
  const result = await releaseWatch.observe({}, pool, selfApp(), HEAD, {
    now, octokit: actions({ status: 'completed', conclusion: 'failure' }),
  });
  assert.equal(result.status, 'release_stalled');
  assert.equal(result.kind, 'workflow_failed');
  assert.equal(result.reported, true);

  const [record] = written(pool);
  assert.deepEqual(record, {
    sha: MERGED, prNumber: 2589, kind: 'workflow_failed',
    since: new Date(T0).toISOString(), detectedAt: new Date(now).toISOString(),
    running: RUNNING, runUrl: RUN_URL, runStatus: 'completed', runConclusion: 'failure',
  });
  assert.equal(pool.queries.find((q) => /SET release_stall = \$1/.test(q.sql)).params[1], 10);

  assert.equal(posted.length, 1);
  assert.equal(posted[0].appId, 10);
  assert.equal(posted[0].kind, 'system');
  assert.equal(posted[0].content,
    '⚠️ PR #2589 merged (7817d05) 2 minutes ago but was not released: the "Build Kubernetes images" workflow did not complete. '
    + `${RUN_URL} The platform is still running 741b8f7. Run it on main to release the latest commit; a later merge would also carry this change.`);
  assert.deepEqual(notified, [{ appId: 10, detail: 'release_stalled' }]);
  assert.equal(pushed.length, 1, 'the notification is pushed, not only inserted');
});

test('a release still within its normal time says nothing', async () => {
  reset();
  const pool = makePool();
  for (const run of [{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'success' }, null]) {
    const result = await releaseWatch.observe({}, pool, selfApp(), HEAD, {
      now: T0 + 4 * MIN, octokit: run ? actions(run) : null,
    });
    assert.equal(result.status, 'release_pending', JSON.stringify(run));
    assert.equal(result.sha, MERGED);
  }
  assert.equal(written(pool).length, 0);
  assert.equal(posted.length, 0);
  assert.equal(notified.length, 0);
});

test('past the grace, the workflow\'s own state names the stall', async () => {
  const cases = [
    [{ status: 'in_progress', conclusion: null }, 'workflow_running', /release workflow is still running; a release normally takes a couple of minutes\. https:/],
    [{ status: 'completed', conclusion: 'success' }, 'rollout_missing', /release workflow succeeded, but the platform has not rolled onto it\. The platform is still running 741b8f7\. Check Argo CD/],
    [null, 'unknown', /no release workflow run could be found for it\. The platform is still running 741b8f7\. Check the repository's Actions\./],
  ];
  for (const [run, kind, message] of cases) {
    reset();
    const pool = makePool();
    const result = await releaseWatch.observe({}, pool, selfApp(), HEAD, {
      now: T0 + 12 * MIN, octokit: run ? actions(run) : actions(null),
    });
    assert.equal(result.status, 'release_stalled', kind);
    assert.equal(result.kind, kind);
    assert.equal(written(pool)[0].kind, kind);
    assert.equal(posted.length, 1, kind);
    assert.match(posted[0].content, /^⚠️ PR #2589 merged \(7817d05\) 12 minutes ago/);
    assert.match(posted[0].content, message);
    assert.equal(notified.length, 1, kind);
  }
});

test('a token that cannot list Actions is not an error; the stall reads unknown once late', async () => {
  reset();
  const pool = makePool();
  const forbidden = { rest: { actions: { listWorkflowRunsForRepo: async () => {
    throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
  } } } };
  const early = await releaseWatch.observe({}, pool, selfApp(), HEAD, { now: T0 + 2 * MIN, octokit: forbidden });
  assert.equal(early.status, 'release_pending');
  const late = await releaseWatch.observe({}, pool, selfApp(), HEAD, { now: T0 + 15 * MIN, octokit: forbidden });
  assert.equal(late.status, 'release_stalled');
  assert.equal(late.kind, 'unknown');
  assert.equal(written(pool)[0].runUrl, null);
  assert.ok(logged.some(([level, , msg]) => level === 'debug' && /Could not read the release workflow run/.test(msg)));
});

test('the same stall is said once; a later tick for the same commit and kind is quiet', async () => {
  reset();
  const pool = makePool();
  const octokit = actions({ status: 'completed', conclusion: 'failure' });
  const first = await releaseWatch.observe({}, pool, selfApp(), HEAD, { now: T0 + 2 * MIN, octokit });
  assert.equal(first.reported, true);
  // The next tick sees the row it just wrote.
  const again = await releaseWatch.observe({}, pool, selfApp({ release_stall: first.record }), HEAD, {
    now: T0 + 7 * MIN, octokit,
  });
  assert.equal(again.status, 'release_stalled');
  assert.equal(again.reported, false);
  assert.deepEqual(again.record, first.record);
  // Rows read back from JSONB may arrive as strings.
  const asText = await releaseWatch.observe({}, pool, selfApp({ release_stall: JSON.stringify(first.record) }), HEAD, {
    now: T0 + 12 * MIN, octokit,
  });
  assert.equal(asText.reported, false);
  assert.equal(written(pool).length, 1);
  assert.equal(posted.length, 1);
  assert.equal(notified.length, 1);
});

test('the same commit escalating to a different kind is news again', async () => {
  reset();
  const pool = makePool();
  const running = await releaseWatch.observe({}, pool, selfApp(), HEAD, {
    now: T0 + 11 * MIN, octokit: actions({ status: 'in_progress', conclusion: null }),
  });
  assert.equal(running.kind, 'workflow_running');
  const failed = await releaseWatch.observe({}, pool, selfApp({ release_stall: running.record }), HEAD, {
    now: T0 + 14 * MIN, octokit: actions({ status: 'completed', conclusion: 'failure' }),
  });
  assert.equal(failed.kind, 'workflow_failed');
  assert.equal(failed.reported, true);
  assert.deepEqual(written(pool).map((r) => r.kind), ['workflow_running', 'workflow_failed']);
  assert.equal(posted.length, 2);
});

test('main moving on to a further commit starts over for that commit', async () => {
  reset();
  const pool = makePool();
  const octokit = actions({ status: 'completed', conclusion: 'failure' });
  const first = await releaseWatch.observe({}, pool, selfApp(), HEAD, { now: T0 + 2 * MIN, octokit });
  const NEXT = 'c8462e98aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const later = { sha: NEXT, committedAt: new Date(T0 + 30 * MIN).toISOString(), subject: 'Next (#2591)' };
  // Its own workflow, still running two minutes in: nothing to say yet, and
  // the old record is left for the next verdict or the converge to replace.
  const pending = await releaseWatch.observe({}, pool, selfApp({ release_stall: first.record }), later, {
    now: T0 + 32 * MIN, octokit: { rest: { actions: { listWorkflowRunsForRepo: async () => ({
      data: { workflow_runs: [{ path: releaseWatch.WORKFLOW_PATH, status: 'in_progress', conclusion: null, html_url: RUN_URL, id: 2 }] },
    }) } } },
  });
  assert.equal(pending.status, 'release_pending');
  assert.equal(pending.sha, NEXT);
  assert.equal(written(pool).length, 1);
});

test('a head the API could not date is measured from when this process first saw it', async () => {
  reset();
  const pool = makePool();
  const undated = { sha: MERGED, committedAt: null, subject: HEAD.subject };
  const t = T0 + 60 * MIN;
  const first = await releaseWatch.observe({}, pool, selfApp(), undated, { now: t, octokit: actions(null) });
  assert.equal(first.status, 'release_pending');
  assert.equal(first.ageMs, 0);
  const later = await releaseWatch.observe({}, pool, selfApp(), undated, { now: t + 9 * MIN, octokit: actions(null) });
  assert.equal(later.status, 'release_pending');
  const late = await releaseWatch.observe({}, pool, selfApp(), undated, { now: t + 10 * MIN, octokit: actions(null) });
  assert.equal(late.status, 'release_stalled');
  assert.equal(written(pool)[0].since, new Date(t).toISOString());
});

test('converged: the recorded stall is cleared and the thread closed; nothing recorded, nothing said', async () => {
  reset();
  const pool = makePool();
  const record = {
    sha: MERGED, prNumber: 2589, kind: 'workflow_failed', since: new Date(T0).toISOString(),
    detectedAt: new Date(T0 + 2 * MIN).toISOString(), running: RUNNING, runUrl: RUN_URL,
  };
  // The new build, at the commit itself.
  let result = await releaseWatch.converged({}, pool, selfApp({ main_sha: MERGED, release_stall: record }));
  assert.equal(result.cleared, true);
  assert.match(pool.queries[0].sql, /SET release_stall = NULL WHERE id = \$1 AND release_stall IS NOT NULL/);
  assert.deepEqual(pool.queries[0].params, [10]);
  assert.deepEqual(posted.map((p) => p.content), ['✅ PR #2589 (7817d05) is live now.']);

  // A later merge carried it.
  reset();
  result = await releaseWatch.converged({}, pool, selfApp({ main_sha: 'c8462e98aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', release_stall: record }));
  assert.equal(result.cleared, true);
  assert.deepEqual(posted.map((p) => p.content), ['✅ PR #2589 (7817d05) is live now, carried by c8462e9.']);

  // Nothing recorded: no query, no message.
  reset();
  const quiet = makePool();
  result = await releaseWatch.converged({}, quiet, selfApp({ main_sha: MERGED }));
  assert.equal(result.cleared, false);
  assert.equal(quiet.queries.length, 0);
  assert.equal(posted.length, 0);

  // Someone else cleared it between the read and the write: no message either.
  reset();
  const raced = { queries: [], query: async (sql, params) => { raced.queries.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
  result = await releaseWatch.converged({}, raced, selfApp({ main_sha: MERGED, release_stall: record }));
  assert.equal(result.cleared, false);
  assert.equal(posted.length, 0);
});

test('describe: the API block, resolved against the build that is answering', () => {
  const record = {
    sha: MERGED, prNumber: 2589, kind: 'workflow_failed', since: new Date(T0).toISOString(),
    detectedAt: new Date(T0 + 2 * MIN).toISOString(), running: RUNNING, runUrl: RUN_URL,
  };
  const quiet = { stalled: false, sha: null, prNumber: null, kind: null, since: null, detectedAt: null, running: null, runUrl: null };
  assert.deepEqual(releaseWatch.describe(null, RUNNING), quiet);
  assert.deepEqual(releaseWatch.describe({}, RUNNING), quiet, 'a row from before the column');
  assert.deepEqual(releaseWatch.describe({ release_stall: null }, RUNNING), quiet);
  assert.deepEqual(releaseWatch.describe({ release_stall: record }, RUNNING), {
    stalled: true, sha: MERGED, prNumber: 2589, kind: 'workflow_failed',
    since: record.since, detectedAt: record.detectedAt, running: RUNNING, runUrl: RUN_URL,
  });
  assert.deepEqual(releaseWatch.describe({ release_stall: JSON.stringify(record) }, RUNNING).stalled, true, 'JSONB as text');
  // The build that is answering IS the stalled commit: the release landed
  // and the poller has not cleared the row yet. Resolved.
  assert.equal(releaseWatch.describe({ release_stall: record }, MERGED).stalled, false);
  assert.equal(releaseWatch.describe({ release_stall: record }, MERGED.toUpperCase()).stalled, false);
  // Only a github.com run URL is handed to the client as a link.
  assert.equal(releaseWatch.describe({ release_stall: { ...record, runUrl: 'https://evil.example/x' } }, RUNNING).runUrl, null);
  assert.equal(releaseWatch.describe({ release_stall: { ...record, runUrl: null } }, RUNNING).runUrl, null);
});

test('readStall reads the one column and never throws', async () => {
  const pool = { query: async (sql, params) => {
    assert.match(sql, /SELECT release_stall FROM apps WHERE id = \$1/);
    assert.deepEqual(params, [10]);
    return { rows: [{ release_stall: { sha: MERGED, kind: 'unknown' } }] };
  } };
  assert.equal((await releaseWatch.readStall(pool, 10, RUNNING)).stalled, true);
  assert.equal((await releaseWatch.readStall(pool, 10, MERGED)).stalled, false, 'resolved against the answering build');
  const broken = { query: async () => { throw new Error('connection refused'); } };
  assert.equal((await releaseWatch.readStall(broken, 10)).stalled, false);
  assert.equal((await releaseWatch.readStall(null, 10)).stalled, false);
});
