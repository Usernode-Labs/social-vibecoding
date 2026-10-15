// #461 "run checks, or skip them explicitly": rebuildSessionStaging's no-op
// paths used to `return 'skipped'` with NO verdict written, leaving
// check_state NULL — the merge gate blocks NULL as "still running its tests"
// and the stuck-checks sweeper re-picked the row every pass, re-skipped, and
// the proposal stayed merge-blocked forever. Now every no-op hands an
// explicit terminal verdict to the preview machine:
//
//   - unparseable repo_url / missing GITHUB_BOT_TOKEN → 'skipped'
//     ("checks unavailable: GitHub is not configured"), gate-passing;
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

test('stuck-check recovery includes submitted active CLI handoffs without widening to drafts or ordinary sessions', async () => {
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
    { id: 1, status: 'promoted', source: 'native' },
    submitted,
    { id: 3, status: 'active', source: 'native', checks_commit_sha: 'head-3' },
    { id: 4, status: 'active', source: 'cli_handoff', checks_commit_sha: null },
    {
      id: 5,
      status: 'active',
      source: 'cli_handoff',
      checks_commit_sha: 'old-head',
      handoff_head_sha: 'old-head',
      handoff_uploaded_sha: 'new-upload',
      handoff_upload_checked_sha: 'old-head',
    },
    { id: 6, status: 'promoted', source: 'native' },
  ];
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      // The second read: which of them the preview machine is building or
      // checking right now (its work is alive while its lease is).
      if (/FROM wf_work/.test(String(sql))) return { rows: [{ key: 'session:6' }] };
      return { rows: candidates };
    },
  };
  try {
    assert.equal(subject.isStuckCheckRecoveryScope(submitted), true);
    const { rows } = await subject.findStuckCheckSessions({
      pool, staleMs: 600000, maxAutoRetries: 6,
    });
    assert.deepEqual(rows.map((row) => row.id), [1, 2], 'a session the machine is working on is left to it');
    assert.equal(queries.length, 2);
    assert.match(queries[0].sql,
      /cs\.status = 'active'[\s\S]*cs\.source = 'cli_handoff'/,
      'submitted pre-vote handoffs are selected alongside promoted proposals');
    assert.match(queries[0].sql, /COALESCE\(cs\.checks_commit_sha, cs\.handoff_head_sha\) IS NOT NULL/,
      'a fresh proposal draft is not mistaken for a lost check run');
    assert.match(queries[0].sql, /handoff_upload_checked_sha/,
      'an upload awaiting proposal_submit_build stays out of recovery');
    assert.match(queries[0].sql,
      /cs\.check_state = 'pending'[\s\S]*cs\.checks_checked_at IS NULL/,
      'legacy pending rows with no timestamp are recoverable');
    // The fourth is how long a platform fault is retried past the cap
    // (tests/platform-fault-retry.test.js).
    assert.deepEqual(queries[0].params, [600000, 6, 50, subject.PLATFORM_FAULT_RETRY_MS]);
    assert.match(queries[1].sql, /kind IN \('preview\.prepare', 'checks\.run'\)/);
    assert.deepEqual(queries[1].params, [['session:1', 'session:2', 'session:6']], 'only the rows in scope are looked up');
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

test('a deferred verdict is waiting on a conflict, not on a runner: never swept', async () => {
  const { subject, restore } = loadRecovery();
  try {
    // Phase 'deferred' says no run was ever started for it
    // (services/check-admission.js). Re-driving one would only defer again.
    const queries = [];
    const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
    await subject.findStuckCheckSessions({ pool, staleMs: 600000, maxAutoRetries: 6 });
    assert.match(queries[0].sql, /cs\.check_phase IS DISTINCT FROM 'deferred'/,
      'the pending branch of the sweep leaves deferred rows alone');
    // An 'error' on a session the machine holds is the machine's own timer's.
    assert.match(queries[0].sql,
      /cs\.check_state = 'error'\s+AND NOT EXISTS \(SELECT 1 FROM wf_instances w[\s\S]*?w\.deadline_at IS NOT NULL\)/);
  } finally { restore(); }
});

test("rebuildSessionStaging: unparseable repo_url hands a 'skipped' verdict to the machine (GitHub not configured)", async () => {
  const { subject, handoffs, compares, restore } = loadRecovery();
  try {
    const r = await subject.rebuildSessionStaging({
      config: {}, pool: makeRecordingPool(),
      session: { ...SESSION, repo_url: 'not-a-github-url' },
      reason: 'test',
    });
    assert.equal(r, 'skipped');
    const [[name, arg], ...rest] = handoffs();
    assert.equal(name, 'skipped');
    assert.equal(rest.length, 0, 'nothing is built');
    assert.equal(arg.session.id, 42);
    assert.match(arg.reason, /GitHub is not configured/);
    assert.equal(arg.head, 'cafe1234', 'stamps the last-known commit');
    assert.equal(compares.length, 0);
  } finally { restore(); }
});

test("rebuildSessionStaging: missing GITHUB_BOT_TOKEN hands a 'skipped' verdict to the machine", async () => {
  const { subject, handoffs, restore } = loadRecovery();
  const prev = process.env.GITHUB_BOT_TOKEN;
  delete process.env.GITHUB_BOT_TOKEN;
  try {
    const r = await subject.rebuildSessionStaging({
      config: {}, pool: makeRecordingPool(),
      session: { ...SESSION, repo_url: 'https://github.com/acme/whiteboard' },
      reason: 'test',
    });
    assert.equal(r, 'skipped');
    assert.deepEqual(handoffs().map(([name]) => name), ['skipped']);
    assert.match(handoffs()[0][1].reason, /GitHub is not configured/);
  } finally {
    if (prev !== undefined) process.env.GITHUB_BOT_TOKEN = prev;
    restore();
  }
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

function withToken(fn) {
  return async () => {
    const prev = process.env.GITHUB_BOT_TOKEN;
    process.env.GITHUB_BOT_TOKEN = 'tok';
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.GITHUB_BOT_TOKEN; else process.env.GITHUB_BOT_TOKEN = prev;
    }
  };
}

const NATIVE = { ...SESSION, repo_url: 'https://github.com/acme/whiteboard', pr_number: 7 };

test('a heal or a boot leaves a preview the machine is preparing, retiring or failing to it; a Preview click still asks', withToken(async () => {
  for (const reason of ['heal', 'startup']) {
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

test('a runtime observed gone, on a session the machine serves, is reported lost and nothing else', withToken(async () => {
  for (const reason of ['heal', 'startup', 'preview-click']) {
    const { subject, handed, handoffs, compares, restore } = loadRecovery({ held: true, lost: true, compare: AHEAD });
    try {
      assert.equal(await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session: NATIVE, reason }),
        'handed_off');
      const lost = handed.find(([name]) => name === 'lost');
      assert.deepEqual(lost[1], { session: NATIVE, detail: reason });
      assert.deepEqual(handoffs(), []);
      assert.equal(compares.length, 0);
    } finally { restore(); }
  }
  // Any other reason is not an observation: it goes the ordinary way.
  const { subject, handed, handoffs, restore } = loadRecovery({ held: true, lost: true, compare: AHEAD });
  try {
    await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session: NATIVE, reason: 'stuck-checks-sweep' });
    assert.ok(!handed.some(([name]) => name === 'lost'));
    assert.deepEqual(handoffs().map(([name]) => name), ['revision']);
  } finally { restore(); }
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
    await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session, reason: 'startup' });
    await subject.rebuildSessionStaging({ config: {}, pool: makeRecordingPool(), session, reason: 'startup', headSha: 'asked' });
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
    for (const reason of ['manual-recheck', 'testing-update', 'preview-click', 'stuck-checks-sweep', 'startup']) {
      assert.equal(await subject.recheckSessionChecks({ pool: makeRecordingPool(), session: SESSION, reason }), 'handed_off');
    }
    assert.deepEqual(handoffs().map(([name, arg]) => [name, arg.reason, arg.trigger, arg.system]), [
      ['recheck', 'manual-recheck', 'manual-recheck', false],
      ['recheck', 'testing-update', 'manual-recheck', false],
      ['recheck', 'preview-click', 'manual-recheck', false],
      ['recheck', 'stuck-checks-sweep', 'stuck-sweep', true],
      ['recheck', 'startup', 'boot-reconcile', true],
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
  const subject = require('../src/services/visuals');
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
    assert.match(q.sql, /consecutive_check_failures = consecutive_check_failures \+ 1/);
    assert.match(q.sql, /check_next_retry_at = NOW\(\) \+ make_interval/);
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
