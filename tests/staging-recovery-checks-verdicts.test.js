// #461 "run checks, or skip them explicitly": rebuildSessionStaging's no-op
// paths used to `return 'skipped'` with NO verdict written, leaving
// check_state NULL — the merge gate blocks NULL as "still running its tests"
// and the stuck-checks sweeper re-picked the row every pass, re-skipped, and
// the proposal stayed merge-blocked forever. Now every no-op hands an
// explicit terminal verdict to the preview machine:
//
//   - unparseable repo_url → refused; missing read access → handed off;
//   - branch not ahead of main → 'skipped' ("nothing to test");
//   - compareCommits throw → the head the row knows is handed to the
//     machine, whose build (and error lane) settles it.
//
// rebuildSessionStaging, recordChecksSkipped and recheckSessionChecks only
// hand over: the preview machine (services/preview-workflow.js) records the
// verdict, broadcasts it, re-drives the merge and posts any note. So these
// tests stub preview-workflow and assert what is handed over.
//
// Also covers the visuals helpers behind those verdicts:
// storeChecksSkipped (writes 'skipped' + reason, clears the failure streak)
// and setChecksPending (a later push returns a 'skipped' row to 'pending').
//
// Same require.cache stubbing pattern as ensure-staging.test.js — nothing
// real spins up; the compare goes through a stubbed services/github.
//
// Run with: node --test tests/staging-recovery-checks-verdicts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// services/visuals pulls in jsonwebtoken / pg at load time (paths these
// tests never reach). They aren't installed in the test environment, so shim
// them the same way checks-auto-merge-trigger.test.js does.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'jsonwebtoken') return { sign: () => 'tok', verify: () => ({}) };
  if (request === 'pg') return { Pool: class { async query() { return { rows: [] }; } } };
  return _origLoad.call(this, request, ...rest);
};

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

function makeRecordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: [], rowCount: 1 };
    },
  };
}

// Whether the stubbed GitHub client has the App (hasApp); withToken turns it on.
const githubApp = { on: false };

// Load staging-recovery with the preview machine's front door
// (services/preview-workflow), GitHub, ws and the workflow platform stubbed,
// so every hand-off is observable without touching Postgres.
function loadRecovery({ held = false, lost = false, working = false, compare = null } = {}) {
  const paths = {
    logger: require.resolve('../src/services/logger'),
    workflow: require.resolve('../src/services/preview-workflow'),
    github: require.resolve('../src/services/github'),
    ws: require.resolve('../src/services/ws'),
    platform: require.resolve('../src/workflow/platform.ts'),
    subject: require.resolve('../src/services/staging-recovery'),
  };
  // Every call into the machine, in order: [name, argument].
  const handed = [];
  const compares = [];
  const broadcasts = [];
  const take = (name, out) => async (arg) => { handed.push([name, arg]); return typeof out === 'function' ? out(arg) : out; };
  const originals = [
    [paths.logger, stubModule(paths.logger, { info() {}, warn() {}, error() {}, debug() {} })],
    [paths.workflow, stubModule(paths.workflow, {
      held: take('held', held),
      lost: take('lost', lost),
      working: take('working', working),
      revision: take('revision', undefined),
      request: take('request', { status: 'accepted' }),
      skipped: take('skipped', true),
      recheck: take('recheck', undefined),
    })],
    [paths.github, stubModule(paths.github, {
      hasApp: () => githubApp.on,
      getReadOctokit: async () => ({ rest: { repos: { compareCommits: async (args) => {
        compares.push(args);
        if (compare instanceof Error) throw compare;
        return { data: compare };
      } } } }),
      describeGithubError: (err) => ({ message: err.message }),
    })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: (m) => broadcasts.push(m),
      pushSessionUpdate: () => {},
      sendSystemMessage: async () => { throw new Error('the machine posts its own notes'); },
    })],
    [paths.platform, stubModule(paths.platform, {
      conflictResolved: async (...args) => { handed.push(['conflictResolved', args]); },
    })],
  ];
  delete require.cache[paths.subject];
  const subject = require('../src/services/staging-recovery');
  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.subject];
  };
  // The machine calls other than the probes (held / lost / working).
  const handoffs = () => handed.filter(([name]) => !['held', 'lost', 'working'].includes(name));
  return { subject, handed, handoffs, compares, broadcasts, restore };
}

const SESSION = {
  id: 42, app_id: 5, app_slug: 'whiteboard', app_name: 'Whiteboard',
  branch_name: 'feat/x', status: 'promoted',
  checks_commit_sha: 'cafe1234',
};

test('the error lane\'s scope includes submitted active CLI handoffs without widening to drafts or ordinary sessions', async () => {
  // The scope the preview machine's error lane and its ChecksDue deadline
  // read (preview/facts.ts retryScope), and the connector's "a re-run is
  // coming" (mcp-tools.erroredRunWillRetry). The leader's stuck-checks sweep
  // that selected it in SQL is gone: the machine runs what a row owes.
  const { subject, restore } = loadRecovery();
  const submitted = {
    id: 2,
    status: 'active',
    source: 'cli_handoff',
    checks_commit_sha: 'head-2',
    handoff_head_sha: 'head-2',
    handoff_uploaded_sha: 'head-2',
    handoff_upload_checked_sha: null,
  };
  const candidates = [
    [{ id: 1, status: 'promoted', source: 'native' }, true],
    [submitted, true],
    [{ id: 3, status: 'active', source: 'native', checks_commit_sha: 'head-3' }, false],
    [{ id: 4, status: 'active', source: 'cli_handoff', checks_commit_sha: null }, false],
    [{
      id: 5,
      status: 'active',
      source: 'cli_handoff',
      checks_commit_sha: 'old-head',
      handoff_head_sha: 'old-head',
      handoff_uploaded_sha: 'new-upload',
      handoff_upload_checked_sha: 'old-head',
    }, false],
    // A person's "Run checks again" on the current head, native or paused.
    [{ id: 6, status: 'paused', source: 'native', checks_commit_sha: 'HEAD-6', unit_suite_fresh_sha: 'head-6' }, true],
    [{ id: 7, status: 'active', source: 'native', checks_commit_sha: 'head-7', unit_suite_fresh_sha: 'head-old' }, false],
  ];
  try {
    for (const [session, inScope] of candidates) {
      assert.equal(subject.isStuckCheckRecoveryScope(session), inScope, `session ${session.id}`);
    }
    assert.equal(subject.findStuckCheckSessions, undefined, 'no sweep selects them any more');
  } finally { restore(); }
});

test('checkRunOverdue requires a submitted head and treats a missing timestamp as stalled', () => {
  const { subject, restore } = loadRecovery();
  try {
    const now = Date.now();
    assert.equal(subject.checkRunOverdue({
      check_state: null, checks_commit_sha: 'head', checks_checked_at: null,
    }, { now, staleMs: 600000 }), true);
    assert.equal(subject.checkRunOverdue({
      check_state: null, checks_commit_sha: 'head',
      checks_checked_at: new Date(now - 1000),
    }, { now, staleMs: 600000 }), false);
    assert.equal(subject.checkRunOverdue({ check_state: null }, {
      now, staleMs: 600000,
    }), false, 'a draft with no submitted head has no check run to recover');
  } finally { restore(); }
});

test("a 'pending' run is the preview machine's, alive while its lease is: never overdue by clock", () => {
  const { subject, restore } = loadRecovery();
  try {
    const now = Date.now();
    for (const phase of ['building', 'testing', 'queued', 'deferred', null]) {
      for (const checkedAt of [null, new Date(now - 6 * 3600 * 1000)]) {
        assert.equal(subject.checkRunOverdue({
          check_state: 'pending', check_phase: phase, checks_commit_sha: 'head', checks_checked_at: checkedAt,
        }, { now, staleMs: 600000 }), false, `phase ${phase}, ${checkedAt ? 'hours old' : 'no timestamp'}`);
      }
    }
  } finally { restore(); }
});

test('a deferred verdict is waiting on a conflict, not on a runner: never overdue', () => {
  const { subject, restore } = loadRecovery();
  try {
    // Phase 'deferred' says no run was ever started for it
    // (services/check-admission.js). Re-driving one would only defer again;
    // the conflict's resolution resumes it (conflict-resolved).
    const now = Date.now();
    for (const state of ['pending', null, 'error']) {
      assert.equal(subject.checkRunOverdue({
        check_state: state, check_phase: 'deferred', checks_commit_sha: 'head',
        checks_checked_at: new Date(now - 6 * 3600 * 1000),
      }, { now, staleMs: 600000 }), false, `check_state ${state}`);
    }
  } finally { restore(); }
});

test('rebuildSessionStaging requires usable repository metadata', async () => {
  const { subject, handoffs, compares, restore } = loadRecovery();
  try {
    await assert.rejects(subject.rebuildSessionStaging({
      config: {}, pool: makeRecordingPool(), session: { ...SESSION, repo_url: 'not-a-repository' }, reason: 'test',
    }), { code: 'repo_unavailable' });
    assert.deepEqual(handoffs(), []); assert.deepEqual(compares, []);
  } finally { restore(); }
});

test('rebuildSessionStaging delegates the revision when this process has no App', async () => {
  const { subject, handoffs, compares, restore } = loadRecovery({ compare: new Error('read access unavailable') });
  githubApp.on = false;
  try {
    assert.equal(await subject.rebuildSessionStaging({
      config: {}, pool: makeRecordingPool(), session: { ...SESSION, repo_url: 'https://github.com/acme/whiteboard' }, reason: 'test',
    }), 'handed_off');
    assert.deepEqual(handoffs().map(([name]) => name), ['revision']);
    assert.equal(compares.length, 1);
    assert.equal(handoffs()[0][1].head, SESSION.checks_commit_sha);
  } finally { restore(); }
});

test('recordChecksSkipped: hands the verdict to the machine, which records, broadcasts and re-drives the merge', async () => {
  const { subject, handoffs, broadcasts, restore } = loadRecovery();
  try {
    await subject.recordChecksSkipped({
      session: { ...SESSION }, commitSha: 'beef5678',
      reason: 'branch has no commits beyond main, so there is nothing to test',
    });
    assert.deepEqual(handoffs(), [['skipped', {
      session: { ...SESSION }, head: 'beef5678',
      reason: 'branch has no commits beyond main, so there is nothing to test',
    }]]);
    assert.deepEqual(broadcasts, [], 'the machine tells open clients, not this module');
  } finally { restore(); }
});

test('recordChecksSkipped is best-effort: a machine that refuses does not throw', async () => {
  const { subject, restore } = loadRecovery();
  try {
    require.cache[require.resolve('../src/services/preview-workflow')].exports.skipped =
      async () => { throw new Error('no instance'); };
    await subject.recordChecksSkipped({ session: { ...SESSION }, commitSha: 'beef5678', reason: 'x' });
  } finally { restore(); }
});

// ── what a rebuild hands to the machine ──────────────────────────────────

const AHEAD = { ahead_by: 2, base_commit: { sha: 'base0000' }, commits: [{ sha: 'tip-1' }, { sha: 'tip-2' }] };

// With the GitHub App configured (services/github.js hasApp), so a GitHub
// repository can be compared.
function withToken(fn) {
  return async () => {
    githubApp.on = true;
    try { await fn(); } finally { githubApp.on = false; }
  };
}

const NATIVE = { ...SESSION, repo_url: 'https://github.com/acme/whiteboard', pr_number: 7 };

test('a turn\'s recovery leaves a preview the machine is preparing, retiring or failing to it; a Preview click still asks', withToken(async () => {
  for (const reason of ['tail_worker_gone', 'dangling_tail']) {
    const { subject, handoffs, compares, restore } = loadRecovery({ held: true, lost: false, working: true, compare: AHEAD });
    try {
      assert.equal(await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session: NATIVE, reason }),
        'left_to_machine', reason);
      assert.deepEqual(handoffs(), [], `${reason}: nothing handed over`);
      assert.equal(compares.length, 0, `${reason}: not even a compare`);
    } finally { restore(); }
  }
  const { subject, handed, handoffs, restore } = loadRecovery({ held: true, lost: false, working: true, compare: AHEAD });
  try {
    assert.equal(await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session: NATIVE, reason: 'preview-click' }),
      'handed_off');
    assert.ok(!handed.some(([name]) => name === 'working'), 'a click does not ask whether the machine is busy');
    assert.deepEqual(handoffs().map(([name, arg]) => [name, arg.head, arg.reason]), [['request', 'tip-2', 'ensure']]);
  } finally { restore(); }
}));

test('a preview the machine is retrying is not rebuilt by a turn\'s recovery, though its runtime is gone', withToken(async () => {
  // A failed rebuild keeps the older attempt's receipt: reporting that
  // runtime lost would start another build inside the backoff, past the cap.
  for (const reason of ['tail_worker_gone', 'dangling_tail']) {
    const { subject, handed, handoffs, restore } = loadRecovery({ held: true, lost: true, working: true, compare: AHEAD });
    try {
      assert.equal(await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session: NATIVE, reason }),
        'left_to_machine', reason);
      assert.ok(!handed.some(([name]) => name === 'lost'), `${reason}: not reported lost`);
      assert.deepEqual(handoffs(), []);
    } finally { restore(); }
  }
}));

test('a runtime observed gone, on a session the machine serves, is reported lost and nothing else', withToken(async () => {
  // A Preview click is the one observation left here; the preview-runtimes
  // clock reports the others itself (lookForLostPreviews).
  const { subject, handed, handoffs, compares, restore } = loadRecovery({ held: true, lost: true, compare: AHEAD });
  try {
    assert.equal(await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session: NATIVE, reason: 'preview-click' }),
      'handed_off');
    const lost = handed.find(([name]) => name === 'lost');
    assert.deepEqual(lost[1], { session: NATIVE, detail: 'preview-click' });
    assert.deepEqual(handoffs(), []);
    assert.equal(compares.length, 0);
  } finally { restore(); }
  // Any other reason is not an observation: it goes the ordinary way.
  for (const reason of ['tail_worker_gone', 'dangling_tail']) {
    const other = loadRecovery({ held: true, lost: true, compare: AHEAD });
    try {
      await other.subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session: NATIVE, reason });
      assert.ok(!other.handed.some(([name]) => name === 'lost'), reason);
      assert.deepEqual(other.handoffs().map(([name]) => name), ['revision'], reason);
    } finally { other.restore(); }
  }
}));

test('a branch ahead of main is handed over as a revision of its tip, with the trigger its reason maps to', withToken(async () => {
  const { subject, handoffs, compares, restore } = loadRecovery({ compare: AHEAD });
  try {
    const session = { ...NATIVE, status: 'active' };
    assert.equal(await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session, reason: 'heal' }),
      'handed_off');
    assert.deepEqual(compares, [{ owner: 'acme', repo: 'whiteboard', base: 'main', head: 'feat/x' }]);
    const [[name, arg]] = handoffs();
    assert.equal(name, 'revision');
    assert.equal(arg.head, 'tip-2');
    assert.equal(arg.source, 'heal');
    assert.equal(arg.trigger, 'stuck-sweep');
  } finally { restore(); }
}));

test('a proposal up for approval is rebuilt at its reviewed head, not a tip past it; an explicit head wins over both', withToken(async () => {
  const { subject, handoffs, restore } = loadRecovery({ compare: AHEAD });
  try {
    const session = { ...NATIVE, status: 'promoted', reviewed_head_sha: 'reviewed' };
    await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session, reason: 'tail_worker_gone' });
    await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session, reason: 'tail_worker_gone', headSha: 'asked' });
    assert.deepEqual(handoffs().map(([, arg]) => [arg.head, arg.trigger]), [['reviewed', 'boot-reconcile'], ['asked', 'boot-reconcile']]);
  } finally { restore(); }
}));

test("a branch level with main hands over a 'skipped' verdict on main's commit", withToken(async () => {
  const { subject, handoffs, restore } = loadRecovery({ compare: { ahead_by: 0, base_commit: { sha: 'base0000' }, commits: [] } });
  try {
    assert.equal(await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session: NATIVE, reason: 'heal' }),
      'skipped');
    const [[name, arg]] = handoffs();
    assert.equal(name, 'skipped');
    assert.equal(arg.head, 'base0000');
    assert.match(arg.reason, /^branch has no commits beyond main/);
  } finally { restore(); }
}));

test('a compare that fails hands over the head the row knows; the machine\'s build settles it', withToken(async () => {
  const { subject, handoffs, restore } = loadRecovery({ compare: new Error('Not Found') });
  try {
    assert.equal(await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session: NATIVE, reason: 'heal' }),
      'handed_off');
    assert.deepEqual(handoffs().map(([name, arg]) => [name, arg.head, arg.trigger]), [['revision', 'cafe1234', 'stuck-sweep']]);
  } finally { restore(); }
}));

test('recheckSessionChecks hands the recheck to the machine, as a person\'s or the system\'s', async () => {
  const { subject, handoffs, restore } = loadRecovery();
  try {
    for (const reason of ['manual-recheck', 'testing-update', 'preview-click', 'stale-pending-vote-kick', 'shots-update']) {
      assert.equal(await subject.recheckSessionChecks({ pool: makeRecordingPool(), session: SESSION, reason }), 'handed_off');
    }
    assert.deepEqual(handoffs().map(([name, arg]) => [name, arg.reason, arg.trigger, arg.system]), [
      ['recheck', 'manual-recheck', 'manual-recheck', false],
      ['recheck', 'testing-update', 'manual-recheck', false],
      ['recheck', 'preview-click', 'manual-recheck', false],
      // The system's own: the machine's map names their trigger.
      ['recheck', 'stale-pending-vote-kick', null, true],
      ['recheck', 'shots-update', null, true],
    ]);
  } finally { restore(); }
});

test('a deferred head that now merges cleanly resumes the machine\'s own episode', async () => {
  const held = loadRecovery({ held: true });
  try {
    await held.subject.recheckSessionChecks({ pool: makeRecordingPool(), session: SESSION, reason: 'conflict-resolved' });
    assert.deepEqual(held.handoffs(), [['conflictResolved', [42, 5, 'cafe1234']]]);
  } finally { held.restore(); }
  // A session the machine does not hold yet goes through the ordinary recheck.
  const free = loadRecovery({ held: false });
  try {
    await free.subject.recheckSessionChecks({ pool: makeRecordingPool(), session: SESSION, reason: 'conflict-resolved' });
    assert.deepEqual(free.handoffs().map(([name, arg]) => [name, arg.trigger]), [['recheck', 'conflict-resolved']]);
  } finally { free.restore(); }
});

// ── visuals helpers: the SQL behind the verdicts ─────────────────────────

function loadVisuals() {
  const paths = {
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/visuals'),
  };
  const origLogger = stubModule(paths.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[paths.subject];
  const subject = require('../src/workflow/preview/check-store.ts');
  const restore = () => {
    if (origLogger) require.cache[paths.logger] = origLogger; else delete require.cache[paths.logger];
    delete require.cache[paths.subject];
  };
  return { subject, restore };
}

test("storeChecksSkipped: writes 'skipped' + reason and clears the failure streak", async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.storeChecksSkipped(pool, 42, 'cafe1234', 'branch has no commits beyond main, so there is nothing to test');
    assert.equal(pool.queries.length, 1);
    const q = pool.queries[0];
    assert.match(q.sql, /check_state = 'skipped'/);
    assert.match(q.sql, /consecutive_check_failures = 0/);
    assert.match(q.sql, /first_check_failure_at = NULL/);
    assert.match(q.sql, /last_check_failure_at = NULL/);
    assert.match(q.sql, /check_next_retry_at = NULL/);
    assert.match(q.sql, /check_error_notified_at = NULL/);
    assert.match(q.sql, /status IN \('active', 'paused', 'promoted', 'merging'\)/,
      'an archived or merged session cannot regain a terminal checks verdict');
    assert.match(q.sql, /checks_commit_sha IS NOT DISTINCT FROM \$4::text/);
    assert.deepEqual(q.params, [
      'cafe1234', 'branch has no commits beyond main, so there is nothing to test', 42, 'cafe1234',
    ]);
  } finally { restore(); }
});

test('storeChecksSkipped: a null commit degrades to NULL, a missing reason to the fallback line (#3180)', async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    assert.equal(subject.DEFAULT_CHECKS_SKIPPED_REASON, 'there was nothing to test');
    for (const reason of [null, undefined, '', '   ']) {
      await subject.storeChecksSkipped(pool, 42, null, reason);
      assert.deepEqual(pool.queries.at(-1).params, [null, 'there was nothing to test', 42, null],
        `a skipped verdict always says why (reason ${JSON.stringify(reason)})`);
    }
  } finally { restore(); }
});

test('storeChecksSkipped can atomically move a no-commit verdict to the compared base SHA', async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.storeChecksSkipped(
      pool, 42, 'new-main-sha', 'nothing to test', 'previous-reviewed-sha'
    );
    const q = pool.queries[0];
    assert.deepEqual(q.params, [
      'new-main-sha', 'nothing to test', 42, 'previous-reviewed-sha',
    ]);
  } finally { restore(); }
});

test("setChecksPending returns a 'skipped' row to 'pending' for the next commit (same SQL path)", async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.setChecksPending(pool, 42, 'feed0042');
    assert.equal(pool.queries.length, 1);
    const q = pool.queries[0];
    assert.match(q.sql, /SET check_state = 'pending'/);
    assert.match(q.sql, /status IN \('active', 'paused', 'promoted', 'merging'\)/,
      'a delayed retry cannot resurrect checks on archived or merged rows');
    // $3 is check_phase and $4 is check_trigger — both NULL when the caller
    // names neither a stage nor a reason.
    assert.deepEqual(q.params, [42, 'feed0042', null, null]);
  } finally { restore(); }
});

test("storeChecks 'error' branch keeps the backoff bookkeeping the error lane relies on", async () => {
  const { subject, restore } = loadVisuals();
  const pool = makeRecordingPool();
  try {
    await subject.storeChecks(pool, 42, 'cafe1234', { state: 'error', results: [] },
      'could not compare feat/x with main: boom');
    const q = pool.queries[0];
    // Unless another rule counts the retries (the preview machine's
    // lostAgain), the row's own streak and backoff.
    assert.match(q.sql, /consecutive_check_failures = COALESCE\(\$9::int, consecutive_check_failures \+ 1\)/);
    assert.match(q.sql, /check_next_retry_at = CASE WHEN \$9::int IS NOT NULL THEN \$10::timestamptz ELSE NOW\(\) \+ make_interval/);
    assert.deepEqual(q.params.slice(8), [null, null]);
    assert.match(q.sql, /status IN \('active', 'paused', 'promoted', 'merging'\)/,
      'a detached failure cannot mutate a withdrawn session');
    assert.match(q.sql, /checks_commit_sha IS NOT DISTINCT FROM \$3::text/);
    assert.equal(q.params[0], 'error');
    assert.match(String(q.params[4]), /could not compare/);
  } finally { restore(); }
});

test('terminal check writes are discarded after a newer commit owns the session', async () => {
  const { subject, restore } = loadVisuals();
  const pool = {
    async query() { return { rows: [], rowCount: 0 }; },
  };
  try {
    assert.equal(await subject.storeChecks(
      pool, 42, 'old-head', { state: 'passing', results: [] }
    ), false);
    assert.equal(await subject.storeChecksSkipped(
      pool, 42, 'old-head', 'stale no-op'
    ), false);
  } finally { restore(); }
});

// ── #866: imported proposals heal by SHA ─────────────────────────────────
//
// An imported PR reaches this file the moment its preview is GC'd or lost to a
// restart, and every assumption the heal made about a session was a native
// one: compare `main...<branch_name>` (a fork's head ref isn't in the base
// repo → permanent 'error' verdict) and open a PR if none exists (there always
// is one — it's someone else's). Where its notes go is the machine's
// (src/workflow/preview/machine.ts: buildStarted, published, prepareFailed).

test('an imported proposal is compared and rebuilt at its recorded head sha, never its fork branch name', withToken(async () => {
  const { subject, handoffs, compares, restore } = loadRecovery({ compare: AHEAD });
  try {
    const session = { ...NATIVE, source: 'imported', branch_name: 'fork-feature', imported_pr_head_sha: 'abc123', pr_number: null };
    assert.equal(await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session, reason: 'heal' }),
      'handed_off');
    assert.equal(compares[0].head, 'abc123', 'a fork head ref is not in this repo');
    assert.deepEqual(handoffs().map(([name, arg]) => [name, arg.head]), [['revision', 'abc123']],
      'pinned to the head the votes describe, not the compare tip; and no PR opened for someone else\'s fork');
  } finally { restore(); }
}));

const RECOVERY_SRC = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'src', 'services', 'staging-recovery.js'), 'utf8'
);

test('an imported row with no recorded head sha records a terminal skip', () => {
  assert.match(RECOVERY_SRC, /if \(imported && !importedHead\) \{[\s\S]*?reason: 'imported PR has no recorded head commit, so there is nothing to preview'/,
    'nothing to pin → an explicit gate-passing verdict, not a NULL that the sweeper re-picks forever');
});

test('the heal never opens a PR for an imported or unattended headless proposal', () => {
  assert.match(RECOVERY_SRC, /if \(!session\.pr_number && !imported && !session\.is_headless\)/,
    'only a human-owned native session may gain a draft PR during recovery');
});

test('recovery only hands over: it never builds, never posts a chat row, never stamps a verdict itself', () => {
  const code = RECOVERY_SRC.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\b(buildAndDeployStaging|captureForSession|setChecksPending|storeChecks\w*)\(/);
  assert.doesNotMatch(code, /INSERT INTO chat_session_messages|INSERT INTO chat_messages|sendSystemMessage/);
});
