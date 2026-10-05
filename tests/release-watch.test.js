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

// `queue` is the release workflow's finished runs on main as GitHub lists
// them (listWorkflowRuns), or an Error that read throws; `queueReads`
// records each read. Without it the client cannot list them at all.
function actions(run, queue = null, queueReads = []) {
  return {
    rest: { actions: {
      listWorkflowRunsForRepo: async ({ head_sha }) => ({
        data: { workflow_runs: run && head_sha === MERGED ? [
          { id: 1, name: 'Deploy', path: '.github/workflows/deploy.yml', status: 'completed', conclusion: 'success', html_url: 'https://github.com/x/y/actions/runs/1' },
          { id: 35461203746, name: 'Build Kubernetes images', path: releaseWatch.WORKFLOW_PATH, html_url: RUN_URL, ...run },
        ] : [] },
      }),
      ...(queue ? { listWorkflowRuns: async (params) => {
        queueReads.push(params);
        if (queue instanceof Error) throw queue;
        return { data: { workflow_runs: queue } };
      } } : {}),
    } },
  };
}

// A finished run of the release workflow, as listWorkflowRuns returns it.
function finished(at) {
  return { status: 'completed', conclusion: 'success', updated_at: new Date(at).toISOString() };
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

test('classify: a release waiting behind a moving queue, or rolling out, is not late yet', () => {
  const grace = 10 * MIN;
  // #3860, 5 Oct 2026: the last of ten merges in two minutes. Its run waits
  // for the nine ahead of it, and one of them finished two minutes ago.
  for (const status of ['pending', 'queued', 'waiting', 'in_progress']) {
    assert.equal(releaseWatch.classify({ ageMs: 16 * MIN, run: { status, conclusion: null }, idleMs: 2 * MIN, grace }), null, status);
  }
  // The queue has stood still for the grace: nothing is moving it.
  assert.equal(releaseWatch.classify({ ageMs: 16 * MIN, run: { status: 'pending', conclusion: null }, idleMs: grace, grace }), 'workflow_running');
  assert.equal(releaseWatch.classify({ ageMs: 40 * MIN, run: { status: 'in_progress', conclusion: null }, idleMs: 25 * MIN, grace }), 'workflow_running');
  // A run that finished a minute ago, for a merge half an hour old: Argo CD
  // is rolling it out. That grace runs from the run, not from the merge.
  assert.equal(releaseWatch.classify({ ageMs: 30 * MIN, run: { status: 'completed', conclusion: 'success' }, doneAgoMs: MIN, grace }), null);
  assert.equal(releaseWatch.classify({ ageMs: 30 * MIN, run: { status: 'completed', conclusion: 'success' }, doneAgoMs: grace, grace }), 'rollout_missing');
  // Neither clock softens a red run, nor hurries a merge inside its grace.
  assert.equal(releaseWatch.classify({ ageMs: 30 * MIN, run: { status: 'completed', conclusion: 'failure' }, doneAgoMs: MIN, grace }), 'workflow_failed');
  assert.equal(releaseWatch.classify({ ageMs: 3 * MIN, run: { status: 'pending', conclusion: null }, idleMs: 30 * MIN, grace }), null);
});

test('the PR comes off the squash subject, and only from its first line', () => {
  assert.equal(releaseWatch.prNumberFrom(HEAD.subject), 2589);
  assert.equal(releaseWatch.prNumberFrom('fix: a direct push'), null);
  assert.equal(releaseWatch.prNumberFrom('fix: something\n\nRefs (#12)'), null);
  assert.equal(releaseWatch.prNumberFrom(null), null);
});

test('a red release workflow is reported at once: the record and the admins notified', async () => {
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

  // No channel line: a channel carries no activity. The board's banner words
  // the record (dev-board/release-stall-store.ts) and the admins are told.
  assert.equal(posted.length, 0);
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
  // What each kind SAYS is the board banner's (release-stall-store.ts).
  const cases = [
    [{ status: 'in_progress', conclusion: null }, 'workflow_running'],
    [{ status: 'completed', conclusion: 'success' }, 'rollout_missing'],
    [null, 'unknown'],
  ];
  for (const [run, kind] of cases) {
    reset();
    const pool = makePool();
    const result = await releaseWatch.observe({}, pool, selfApp(), HEAD, {
      now: T0 + 12 * MIN, octokit: run ? actions(run) : actions(null),
    });
    assert.equal(result.status, 'release_stalled', kind);
    assert.equal(result.kind, kind);
    assert.equal(written(pool)[0].kind, kind);
    assert.equal(posted.length, 0, kind);
    assert.equal(notified.length, 1, kind);
  }
});

test('several merges in one burst: the newest waits its turn and is not called stuck', async () => {
  // #3860 was the last of ten merges in two minutes (5 Oct 2026). The
  // workflow runs them one at a time, so sixteen minutes on its run is still
  // waiting while the runs ahead of it finish, one two minutes ago.
  reset();
  const pool = makePool();
  const reads = [];
  const now = T0 + 16 * MIN;
  const queue = [finished(now - 2 * MIN), finished(now - 5 * MIN)];
  const result = await releaseWatch.observe({}, pool, selfApp(), HEAD, {
    now, octokit: actions({ status: 'pending', conclusion: null }, queue, reads),
  });
  assert.equal(result.status, 'release_pending');
  assert.equal(result.idleMs, 2 * MIN);
  assert.equal(written(pool).length, 0, 'no record, so no row reads "Stuck going live"');
  assert.equal(notified.length, 0);
  assert.deepEqual(reads, [{
    owner: 'Usernode-Labs', repo: 'social-vibecoding', workflow_id: 'build-kubernetes-images.yml',
    branch: 'main', status: 'completed', per_page: 5,
  }], 'one read of the release queue on main, the newest finished runs');

  // Its own run starts once the one ahead finishes, and runs: still moving.
  const running = await releaseWatch.observe({}, pool, selfApp(), HEAD, {
    now: now + 3 * MIN, octokit: actions({ status: 'in_progress', conclusion: null }, [finished(now + MIN)]),
  });
  assert.equal(running.status, 'release_pending');

  // The queue stands still past the grace: that is stuck, and said once.
  const stuck = await releaseWatch.observe({}, pool, selfApp(), HEAD, {
    now: now + 13 * MIN, octokit: actions({ status: 'in_progress', conclusion: null }, [finished(now + 2 * MIN)]),
  });
  assert.equal(stuck.status, 'release_stalled');
  assert.equal(stuck.kind, 'workflow_running');
  assert.equal(written(pool).length, 1);
  assert.equal(notified.length, 1);
});

test('a release read only within its own grace: no queue read for a merge still on time', async () => {
  reset();
  const reads = [];
  const result = await releaseWatch.observe({}, makePool(), selfApp(), HEAD, {
    now: T0 + 4 * MIN, octokit: actions({ status: 'pending', conclusion: null }, [], reads),
  });
  assert.equal(result.status, 'release_pending');
  assert.equal(reads.length, 0, 'the second read is spent only on a run late by the merge\'s clock');
});

test('a queue that cannot be read falls back to the merge\'s clock', async () => {
  for (const queue of [new Error('Resource not accessible by integration'), []]) {
    reset();
    const pool = makePool();
    const result = await releaseWatch.observe({}, pool, selfApp(), HEAD, {
      now: T0 + 12 * MIN, octokit: actions({ status: 'pending', conclusion: null }, queue),
    });
    assert.equal(result.status, 'release_stalled', String(queue));
    assert.equal(result.kind, 'workflow_running');
    assert.equal(result.record.kind, 'workflow_running');
    assert.equal(logged.some(([level, , msg]) => level === 'debug' && /Could not read the release workflow queue/.test(msg)),
      queue instanceof Error, 'a refused read is logged, never thrown');
  }
});

test('a run that finished moments ago gives the rollout its own grace', async () => {
  // The burst's release finished a minute ago, twenty-five minutes after the
  // merge: Argo CD is rolling it out, not missing it.
  reset();
  const pool = makePool();
  const now = T0 + 25 * MIN;
  const run = { status: 'completed', conclusion: 'success', updated_at: new Date(now - MIN).toISOString() };
  const rolling = await releaseWatch.observe({}, pool, selfApp(), HEAD, { now, octokit: actions(run) });
  assert.equal(rolling.status, 'release_pending');
  assert.equal(written(pool).length, 0);
  const missing = await releaseWatch.observe({}, pool, selfApp(), HEAD, { now: now + 10 * MIN, octokit: actions(run) });
  assert.equal(missing.status, 'release_stalled');
  assert.equal(missing.kind, 'rollout_missing');
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
  assert.equal(notified.length, 2, 'the admins are told of each');
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

test('converged: the recorded stall is cleared; nothing recorded, nothing written', async () => {
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
  assert.equal(posted.length, 0, 'the banner goes; no channel line says so');

  // A later merge carried it.
  reset();
  result = await releaseWatch.converged({}, pool, selfApp({ main_sha: 'c8462e98aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', release_stall: record }));
  assert.equal(result.cleared, true);
  assert.equal(posted.length, 0);

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

// A pool that answers the apps column with `record` and the merge-order
// question (carriedBy) with `carried`; anything else is a test failure.
function stallPool(record, carried) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (/SELECT release_stall FROM apps WHERE id = \$1/.test(sql)) {
        assert.deepEqual(params, [10]);
        return { rows: [{ release_stall: record }] };
      }
      if (/FROM chat_sessions recorded\s+JOIN chat_sessions serving/.test(sql)) {
        if (carried instanceof Error) throw carried;
        return { rows: carried ? [{ '?column?': 1 }] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('readStall reads the one column and never throws', async () => {
  const pool = stallPool({ sha: MERGED, kind: 'unknown' }, false);
  assert.equal((await releaseWatch.readStall(pool, 10, RUNNING)).stalled, true);
  assert.equal((await releaseWatch.readStall(pool, 10, MERGED)).stalled, false, 'resolved against the answering build');
  const broken = { query: async () => { throw new Error('connection refused'); } };
  assert.equal((await releaseWatch.readStall(broken, 10)).stalled, false);
  assert.equal((await releaseWatch.readStall(null, 10)).stalled, false);
});

test('readStall: a later release that carried the recorded commit resolves it', async () => {
  // Several merges, one release: the record names a commit that never ran by
  // itself, and the build answering is a later merge with it inside.
  const carried = stallPool({ sha: MERGED, kind: 'workflow_running' }, true);
  assert.equal((await releaseWatch.readStall(carried, 10, RUNNING)).stalled, false);
  const order = carried.queries.find((q) => /FROM chat_sessions recorded/.test(q.sql));
  assert.deepEqual(order.params, [10, MERGED, RUNNING]);
  // An older build, or one the merge order cannot place: still stalled.
  assert.equal((await releaseWatch.readStall(stallPool({ sha: MERGED, kind: 'workflow_running' }, false), 10, RUNNING)).stalled, true);
  assert.equal((await releaseWatch.readStall(stallPool({ sha: MERGED, kind: 'workflow_running' }, new Error('timeout')), 10, RUNNING)).stalled, true,
    'a failed read is no evidence the release landed');
});

test('carriedBy orders the two merges; the same commit needs no read', async () => {
  const none = { query: async () => { throw new Error('no read expected'); } };
  assert.equal(await releaseWatch.carriedBy(none, 10, MERGED, MERGED.toUpperCase()), true);
  assert.equal(await releaseWatch.carriedBy(none, 10, MERGED, null), false);
  assert.equal(await releaseWatch.carriedBy(none, 10, null, RUNNING), false);
  assert.equal(await releaseWatch.carriedBy(null, 10, MERGED, RUNNING), false);

  const pool = stallPool(null, true);
  assert.equal(await releaseWatch.carriedBy(pool, 10, MERGED, RUNNING), true);
  const [q] = pool.queries;
  // Both are merged changes of the app; the recorded one merged no later
  // than the running one, in the Done column's own order.
  assert.match(q.sql, /recorded\.app_id = \$1/);
  assert.match(q.sql, /recorded\.status = 'merged' AND serving\.status = 'merged'/);
  assert.match(q.sql, /LOWER\(recorded\.merge_commit_sha\) = LOWER\(\$2\)/);
  assert.match(q.sql, /LOWER\(serving\.merge_commit_sha\) = LOWER\(\$3\)/);
  assert.match(q.sql, /\(COALESCE\(recorded\.merged_at, recorded\.created_at\), recorded\.id\)\s+<= \(COALESCE\(serving\.merged_at, serving\.created_at\), serving\.id\)/);
  assert.equal(await releaseWatch.carriedBy(stallPool(null, false), 10, MERGED, RUNNING), false);
});
