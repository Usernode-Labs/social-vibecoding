'use strict';

// A recheck judges the head a proposal is up for approval on, never the
// commit its checks were last pinned to (services/staging-recovery.js
// recheckHeadSha, approvedHeadSha, recheckSessionChecks).
//
// Club Votes (newcomer run four, 12 October 2026). The review's fix turn
// pushed 394d7494, and its commit push pinned the checks to it and started
// a run. Restart recovery then rolled the branch back to 83d22f05, the
// commit before the fix, and proposed it. The promote route's kick asked
// the cluster for a run of the PIN (394d7494), found the fix's run, and
// left it to the harvest without marking the new head pending. That run
// passed, its verdict was stored against the pin, and the App tab read
// "Ready to try" about a commit nobody was voting on. Checks of 83d22f05
// itself then failed on the bug the fix had fixed.
//
// Now the recheck reads the row as it stands (the promote route's own copy
// still says 'active'), takes the reviewed head, asks the cluster only about
// a run of THAT commit, marks it pending (which moves the pin off the old
// commit, so the old run's verdict is never stored), and checks it: a
// preview of the old commit is rebuilt at the head.
//
// Run with: node --test tests/recheck-moved-head.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OLD = `394d7494${'b'.repeat(32)}`;
const NEW = `83d22f05${'a'.repeat(32)}`;
const TIP = `c0ffee00${'c'.repeat(32)}`;
const RUN = { runId: 'f7895663', owner: 'old-pod:1:exited', capture: 'running', unitSuite: 'running' };

// ── The head a recheck judges ────────────────────────────────────────────

test('the head: an imported PR\'s own head, a proposal\'s reviewed head, else the checks pin', () => {
  const rec = require('../src/services/staging-recovery');
  const promoted = { status: 'promoted', source: 'native', reviewed_head_sha: NEW, checks_commit_sha: OLD };
  assert.equal(rec.recheckHeadSha(promoted), NEW, 'the head people vote on, not the run\'s old commit');
  assert.equal(rec.recheckHeadSha({ ...promoted, status: 'merging' }), NEW);
  assert.equal(rec.recheckHeadSha({ ...promoted, reviewed_head_sha: null }), OLD, 'none recorded: the pin, as before');
  // Underway (or moved back to it): its reviewed head can be left over from
  // an earlier review, so the pin it is building is the head.
  assert.equal(rec.recheckHeadSha({ ...promoted, status: 'paused' }), OLD);
  assert.equal(rec.recheckHeadSha({ ...promoted, status: 'active' }), OLD);
  assert.equal(rec.recheckHeadSha({ source: 'cli_handoff', status: 'active', handoff_head_sha: 'h' }), 'h');
  assert.equal(rec.recheckHeadSha({ source: 'imported', status: 'promoted', imported_pr_head_sha: 'imp', reviewed_head_sha: NEW, checks_commit_sha: OLD }), 'imp');
  assert.equal(rec.recheckHeadSha({ source: 'imported', status: 'promoted', checks_commit_sha: OLD }), null);
  assert.equal(rec.approvedHeadSha({ ...promoted, status: 'paused' }), null);
  assert.equal(rec.approvedHeadSha(promoted), NEW);
});

// ── Run four, end to end through the recheck ─────────────────────────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return () => { if (original) require.cache[id] = original; else delete require.cache[id]; };
}

// The proposal's row, with the two writes that matter done as Postgres does
// them: the pending stamp moves the pin, and a verdict is stored only for
// the commit the row is pinned to (visuals.storeChecks' guard, pinned below).
function fakeDb(row) {
  const db = {
    row: { ...row },
    async query(sql, params = []) {
      const s = String(sql);
      if (/SELECT id, status, source, reviewed_head_sha, imported_pr_head_sha, checks_commit_sha, handoff_head_sha\s+FROM chat_sessions WHERE id = \$1/.test(s)) {
        return { rows: [{
          id: db.row.id, status: db.row.status, source: db.row.source, reviewed_head_sha: db.row.reviewed_head_sha,
          imported_pr_head_sha: db.row.imported_pr_head_sha, checks_commit_sha: db.row.checks_commit_sha,
          handoff_head_sha: db.row.handoff_head_sha,
        }] };
      }
      if (/SET check_state = 'pending', checks_commit_sha = \$2::text/.test(s)) {
        db.row.check_state = 'pending';
        db.row.checks_commit_sha = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/SET check_state = \$1, test_results = \$2, checks_commit_sha = \$3::text/.test(s)) {
        if ((db.row.checks_commit_sha || null) !== (params[2] || null)) return { rows: [], rowCount: 0 };
        db.row.check_state = params[0];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return db;
}

function harness(t, { stagingCommit, tip = NEW }) {
  const calls = [];
  const restores = [];
  const svc = (name) => require.resolve(`../src/services/${name}`);
  restores.push(stubModule(svc('docker'), { inspectContainer: async () => ({ status: 'running', labels: {} }) }));
  restores.push(stubModule(svc('staging'), {
    buildAndDeployStaging: async (_config, s, _app, commit) => {
      calls.push(['build', commit]);
      return { containerId: 'c2', stagingUrl: 'https://preview.example/2', commitSha: commit };
    },
  }));
  restores.push(stubModule(svc('ws'), {
    broadcastGlobal() {}, pushSessionUpdate() {}, sendSystemMessage: async () => {},
  }));
  restores.push(stubModule(svc('github'), {
    getReadOctokit: async () => ({ rest: { repos: { compareCommits: async () => ({ data: { ahead_by: 2, commits: [{ sha: OLD }, { sha: tip }] } }) } } }),
  }));
  const recPath = svc('staging-recovery');
  delete require.cache[recPath];
  const rec = require('../src/services/staging-recovery');
  const harvest = require('../src/services/check-harvest');
  const visuals = require('../src/services/visuals');
  const log = require('../src/services/logger');
  const saved = { runToCollect: harvest.runToCollect, captureForSession: visuals.captureForSession, info: log.info, warn: log.warn };
  // The fix's run of the old commit is still on the cluster.
  harvest.runToCollect = async (_config, _pool, sessionId, commit) => {
    calls.push(['runToCollect', sessionId, commit]);
    return commit === OLD ? RUN : null;
  };
  visuals.captureForSession = async (_config, s, _app, commit) => { calls.push(['capture', s.id, commit]); };
  log.info = () => {};
  log.warn = () => {};
  const savedToken = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'test-token';
  t.after(() => {
    harvest.runToCollect = saved.runToCollect;
    visuals.captureForSession = saved.captureForSession;
    log.info = saved.info;
    log.warn = saved.warn;
    if (savedToken == null) delete process.env.GITHUB_BOT_TOKEN; else process.env.GITHUB_BOT_TOKEN = savedToken;
    delete require.cache[recPath];
    for (const restore of restores.reverse()) restore();
  });
  // The row in the database, promoted on the rolled-back head while the
  // checks are still pinned to the fix's commit and its preview.
  const db = fakeDb({
    id: 8031, status: 'promoted', source: 'native', reviewed_head_sha: NEW, imported_pr_head_sha: null,
    checks_commit_sha: OLD, handoff_head_sha: null, check_state: 'pending',
  });
  // The promote route's own copy: read before it promoted, its reviewed head
  // set in memory, its status still the one it was promoted from.
  const copy = {
    id: 8031, app_id: 77, app_slug: 'club-votes-0e42b6', app_name: 'Club Votes', repo_url: 'https://github.com/usernode-bot/club-votes-0e42b6',
    branch_name: 'dev/homeroom_bot-homeroom-bot-1-first-version', pr_number: 2, status: 'active', source: 'native',
    reviewed_head_sha: NEW, checks_commit_sha: OLD, check_state: 'pending',
    staging_url: 'https://preview.example/1', staging_container_id: 'c1', staging_commit_sha: stagingCommit,
  };
  return { rec, visuals, db, copy, calls };
}

test('run four: a promote kick after the head moved checks the new head; the old head\'s run is neither collected nor stored', async (t) => {
  const { rec, visuals, db, copy, calls } = harness(t, { stagingCommit: OLD });
  const out = await rec.recheckSessionChecks({ config: null, pool: db, session: copy, reason: 'promote-kick' });
  assert.equal(out, 'built', 'not "collecting": the run on the cluster is of another commit');
  assert.deepEqual(calls.filter((c) => c[0] === 'runToCollect'), [['runToCollect', 8031, NEW]], 'only a run of the head is asked about');
  assert.equal(db.row.checks_commit_sha, NEW, 'the head is marked pending');
  assert.equal(db.row.check_state, 'pending');
  // The preview was of the old commit: rebuilt at the head, and checked there.
  assert.deepEqual(calls.filter((c) => c[0] !== 'runToCollect'), [['build', NEW], ['capture', 8031, NEW]]);

  // The old run finishes and passes: its verdict is about a commit the row
  // is no longer pinned to, and is not stored.
  assert.equal(await visuals.storeChecks(db, 8031, OLD, { state: 'passing', results: [] }), false);
  assert.equal(db.row.check_state, 'pending', 'still waiting on the head');
  // The head's own verdict is.
  assert.equal(await visuals.storeChecks(db, 8031, NEW, { state: 'failing', results: [{ name: 'post a decision', status: 'fail' }] }), true);
  assert.equal(db.row.check_state, 'failing');
});

test('a preview already of the head is re-run directly at the head', async (t) => {
  const { rec, db, copy, calls } = harness(t, { stagingCommit: NEW });
  assert.equal(await rec.recheckSessionChecks({ config: null, pool: db, session: copy, reason: 'promote-kick' }), 'rechecked');
  assert.deepEqual(calls, [['runToCollect', 8031, NEW], ['capture', 8031, NEW]]);
  assert.equal(db.row.checks_commit_sha, NEW);
});

test('a rebuild of a proposal builds its reviewed head, not a tip past it; an underway change builds its tip', async (t) => {
  const { rec, db, copy, calls } = harness(t, { stagingCommit: OLD, tip: TIP });
  assert.equal(await rec.rebuildSessionStaging({ config: null, pool: db, session: { ...copy, status: 'promoted' }, reason: 'heal' }), 'built');
  assert.deepEqual(calls.find((c) => c[0] === 'build'), ['build', NEW]);
  calls.length = 0;
  assert.equal(await rec.rebuildSessionStaging({ config: null, pool: db, session: { ...copy, status: 'paused' }, reason: 'heal' }), 'built');
  assert.deepEqual(calls.find((c) => c[0] === 'build'), ['build', TIP], 'recovery still claims the newest tip of a change underway');
});

test('the recheck reads the row before it decides, and the verdict store keeps to the pinned commit', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/staging-recovery.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function recheckSessionChecks('), src.indexOf('module.exports = {', src.indexOf('async function recheckSessionChecks(')));
  assert.ok(fn.indexOf('session = await currentPins(pool, session);') < fn.indexOf('const head = recheckHeadSha(session);'));
  assert.match(fn, /runToCollect\(config, pool, session\.id, head, \{ forManual: manual \}\)/);
  assert.match(fn, /setChecksPending\(pool, session\.id, head, 'building'/);
  assert.match(fn, /rebuildSessionStaging\(\{ config, pool, session, reason, headSha: approvedHeadSha\(session\) \}\)/);
  assert.match(fn, /captureForSession\(config, session, app, head, null,/);
  // What fakeDb emulates: both verdict writes are guarded on the pinned commit.
  const visuals = fs.readFileSync(path.join(ROOT, 'src/services/visuals.js'), 'utf8');
  const store = visuals.slice(visuals.indexOf('async function storeChecks('), visuals.indexOf('async function storeChecksSkipped('));
  assert.equal((store.match(/AND checks_commit_sha IS NOT DISTINCT FROM \$3::text`/g) || []).length, 2);
});

test('a re-driven "Run checks again" stays manual: its commit\'s cached unit-suite passes are forgotten, and its run is manual-recheck', async (t) => {
  const { rec, visuals, db, copy } = harness(t, { stagingCommit: NEW });
  const forgotten = [];
  const query = db.query.bind(db);
  db.query = async (sql, params) => {
    if (/DELETE FROM unit_suite_passes/.test(String(sql))) { forgotten.push(params); return { rows: [], rowCount: 1 }; }
    return query(sql, params);
  };
  const captured = [];
  visuals.captureForSession = async (_config, s, _app, commit, _staging, opts) => { captured.push({ commit, trigger: opts.trigger }); };
  assert.equal(await rec.recheckSessionChecks({ config: null, pool: db, session: copy, reason: 'orphaned-manual-run' }), 'rechecked');
  assert.deepEqual(captured, [{ commit: NEW, trigger: 'manual-recheck' }]);
  assert.equal(forgotten.length, 1);
  assert.equal(forgotten[0][0], 77);
  assert.ok(forgotten[0][1].includes(NEW), 'the head this run judges');

  // An automatic re-drive forgets nothing.
  forgotten.length = 0;
  await rec.recheckSessionChecks({ config: null, pool: db, session: copy, reason: 'orphaned-run' });
  assert.equal(forgotten.length, 0);
});
