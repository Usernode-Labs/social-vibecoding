// The recovered build tail ends a turn the way the live tail does.
//
// A restart can land between any two steps of a build's tail, and recovery
// (server.js finalizeRecoveredTurn) repeats whatever the live tail
// (routes/sessions.js runClaudeCodeTool) had not finished. Four places where
// the two had drifted apart:
//
//   (a) the vote reset ran before staging, whatever its outcome; the live
//       tail resets only once the new commit's preview is up;
//   (b) recovery also posted the reset with no thread, which writes nothing
//       (a platform line names its thread or is not written);
//   (c) reusing a healthy preview for the SAME commit reset its checks
//       anyway, wiping a passing verdict and running the capture again;
//   (d) the live "Staging deployed!" card had no receipt and recovery's card
//       had its own, so a restart after the live card posted a second one.
//
// Driven through the real finalizeRecoveredTurn with recording fakes, the
// way tests/recovered-turn-push-heal.test.js drives it.
//
// Run with: node --test tests/recovered-turn-tail-parity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

// One ordered log of everything the tail did, across all the fakes.
const log = [];

const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  destroyWorker: async () => {},
  execPushFromWorker: async () => ({ sha: 'x' }),
  noteTailMilestone: async (_sessionId, milestone) => { log.push(['milestone', milestone]); return true; },
};

const prMetadataPath = require.resolve('../src/services/pr-metadata');
const realPrMetadata = require(prMetadataPath);
require.cache[prMetadataPath].exports = {
  ...realPrMetadata,
  applyPrMetadata: async () => ({ prNumber: 7, prUrl: 'https://example/pr/7' }),
};

const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
let finalizeRecoveredTurn;
try {
  ({ finalizeRecoveredTurn } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}
const sessionsRoutes = require('../src/routes/sessions');
const visuals = require('../src/services/visuals');
const stagingRecovery = require('../src/services/staging-recovery');
const voteRevision = require('../src/services/vote-revision');
const appAdmins = require('../src/services/app-admins');
const ws = require('../src/services/ws');

// Module properties the tail reads at call time.
function patch(t, target, name, fn) {
  const original = target[name];
  target[name] = fn;
  t.after(() => { target[name] = original; });
}

function fakes(t, { needsRebuild = true } = {}) {
  log.length = 0;
  patch(t, visuals, 'setChecksPending', async (_pool, sessionId, sha, phase, trigger) => {
    log.push(['setChecksPending', sha, trigger]);
    return true;
  });
  patch(t, visuals, 'captureForSession', async (_config, _session, _app, sha) => { log.push(['capture', sha]); });
  patch(t, stagingRecovery, 'stagingNeedsRebuild', async () => needsRebuild);
  patch(t, stagingRecovery, 'recordStagingBootFailure', async () => { log.push(['recordStagingBootFailure']); });
  patch(t, appAdmins, 'refreshExplicitApproval', async () => false);
  patch(t, voteRevision, 'retireAndRecheck', async (_pool, session, sha, { announce }) => {
    log.push(['retireVotes', session.id, sha]);
    await announce({ retired: 2 });
    return { bumped: true, retired: 2 };
  });
  patch(t, ws, 'sendSystemMessage', async (...args) => { log.push(['sendSystemMessage', args]); });
  patch(t, ws, 'pushVoteUpdate', () => {});
}

function makePool({ activeTurn = null, live = {}, checks = null } = {}) {
  const calls = [];
  const effects = new Map();
  const query = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text.trim())) return { rows: [], rowCount: 0 };
    if (/INSERT INTO turn_effects/i.test(text)) {
      const key = `${params[0]}:${params[1]}`;
      if (effects.has(key)) return { rows: [], rowCount: 0 };
      effects.set(key, { state: 'pending', result: null });
      return { rows: [{ state: 'pending' }], rowCount: 1 };
    }
    if (/SELECT state, result FROM turn_effects/i.test(text)) {
      const row = effects.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE turn_effects/i.test(text)) {
      const row = effects.get(`${params[0]}:${params[1]}`);
      if (!row || row.state !== 'pending') return { rows: [], rowCount: 0 };
      row.state = 'completed';
      row.result = JSON.parse(params[2]);
      return { rows: [{ result: row.result }], rowCount: 1 };
    }
    if (/SET active_turn = jsonb_set/i.test(text) && activeTurn) {
      activeTurn.tail = { ...(activeTurn.tail || {}), ...JSON.parse(params[1]) };
      return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
    }
    if (/SELECT active_turn FROM chat_sessions/i.test(text)) {
      return { rows: [{ active_turn: activeTurn }], rowCount: 1 };
    }
    if (/SELECT staging_url, staging_container_id FROM chat_sessions/i.test(text)) {
      return { rows: [{ staging_url: live.stagingUrl || null, staging_container_id: 'c-1' }], rowCount: 1 };
    }
    if (/SELECT checks_commit_sha, check_state FROM chat_sessions/i.test(text)) {
      return { rows: checks ? [checks] : [], rowCount: checks ? 1 : 0 };
    }
    if (/INSERT INTO chat_session_messages/i.test(text)) {
      log.push(['row', params[1]]);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT content FROM chat_session_messages/i.test(text)) return { rows: [{ content: 'do it' }] };
    return { rows: [], rowCount: 0 };
  };
  return { calls, effects, query, async connect() { return { query, release() {} }; } };
}

function stagingFake({ fails = false } = {}) {
  const calls = [];
  return {
    calls,
    buildAndDeployStaging: async (...args) => {
      calls.push(args);
      log.push(['buildStaging']);
      if (fails) throw new Error('container refused to boot');
      return { containerId: 'c', stagingUrl: 'https://x.example', hostname: 'x.example' };
    },
    verifyStagingEdge: async () => {},
  };
}

const SHA = 'feedface00112233';
const SESSION = {
  id: 510, status: 'promoted', is_headless: false, user_id: 1, app_id: 3,
  username: 'evan', app_slug: 'leaderboard', app_name: 'Leaderboard',
  repo_url: 'https://github.com/acme/leaderboard', branch_name: 'dev/evan-1',
  pr_number: 7, pr_url: 'https://example/pr/7', cc_session_id: 'cc-1',
};

function args(over = {}) {
  return {
    config: {},
    session: { ...SESSION },
    sessionId: 510,
    result: { ahead: 1, sha: SHA, pushOk: true, lastResultText: 'Sorted it.', sessionId: 'cc-1' },
    repoOwner: 'acme', repoName: 'leaderboard',
    emit: (event, data) => log.push(['emit', event, data]),
    containerName: 'usernode-worker-510',
    keepWorker: true,
    ...over,
  };
}

const at = (pred) => log.findIndex(pred);

// ── (a) the vote reset waits for the preview, and needs it ──────────────

test('a promoted proposal\'s votes are reset only after its new preview is up', async (t) => {
  fakes(t);
  const pool = makePool();
  await finalizeRecoveredTurn(args({ pool, staging: stagingFake() }));

  const card = at((e) => e[0] === 'row' && e[1] === 'Staging deployed!');
  const retired = at((e) => e[0] === 'retireVotes');
  assert.ok(card >= 0 && retired >= 0);
  assert.ok(card < retired, 'the reset follows the staging card, as in the live tail');
  assert.ok(at((e) => e[0] === 'milestone' && e[1].votesResetFor === SHA) < retired,
    'claimed before the votes are touched');
});

test('a preview that fails leaves the votes alone, as the live tail does', async (t) => {
  fakes(t);
  const pool = makePool();
  const ret = await finalizeRecoveredTurn(args({ pool, staging: stagingFake({ fails: true }) }));
  assert.match(ret.summary, /Staging build failed/);
  assert.equal(at((e) => e[0] === 'retireVotes'), -1, 'no vote reset for a commit nobody can preview');
  assert.equal(at((e) => e[0] === 'milestone' && 'votesResetFor' in e[1]), -1);
});

// ── (b) the reset's line goes to the proposal's thread, once ────────────

test('the reset announcement names the proposal\'s thread and is posted once', async (t) => {
  fakes(t);
  await finalizeRecoveredTurn(args({ pool: makePool(), staging: stagingFake() }));
  const lines = log.filter((e) => e[0] === 'sendSystemMessage').map((e) => e[1]);
  assert.equal(lines.length, 1, 'no second, thread-less copy');
  assert.deepEqual(lines[0][5], { type: 'session', ref: 510 });
  assert.match(lines[0][2], /An update was pushed to PR #7 \(commit feedface\)/);
});

// ── (c) a reused preview keeps its commit's verdict ─────────────────────

const REUSE = { stagingUrl: 'https://kept.example' };
const reuseArgs = (pool) => args({
  pool, staging: stagingFake(), alreadyDone: { stagingUrl: REUSE.stagingUrl, completionRowPosted: true, prNumber: 7 },
  session: { ...SESSION, status: 'active' },
});

test('a reused preview whose checks already passed for this commit is not re-checked', async (t) => {
  fakes(t, { needsRebuild: false });
  const pool = makePool({ live: REUSE, checks: { checks_commit_sha: SHA, check_state: 'passing' } });
  const ret = await finalizeRecoveredTurn(reuseArgs(pool));
  assert.match(ret.summary, /Staging preview is live: https:\/\/kept\.example/);
  assert.equal(at((e) => e[0] === 'buildStaging'), -1, 'the healthy preview is reused');
  assert.equal(at((e) => e[0] === 'setChecksPending'), -1, 'the passing verdict is kept');
  assert.equal(at((e) => e[0] === 'capture'), -1, 'and not re-run');
});

test('a reused preview whose capture the restart took is captured again, without a reset', async (t) => {
  fakes(t, { needsRebuild: false });
  const pool = makePool({ live: REUSE, checks: { checks_commit_sha: SHA, check_state: 'pending' } });
  await finalizeRecoveredTurn(reuseArgs(pool));
  assert.equal(at((e) => e[0] === 'setChecksPending'), -1);
  assert.ok(at((e) => e[0] === 'capture' && e[1] === SHA) >= 0, 'the lost capture runs');
});

test('a reused preview whose checks are for an older head is reset and re-checked', async (t) => {
  fakes(t, { needsRebuild: false });
  const pool = makePool({ live: REUSE, checks: { checks_commit_sha: 'olderhead', check_state: 'passing' } });
  await finalizeRecoveredTurn(reuseArgs(pool));
  const reset = at((e) => e[0] === 'setChecksPending');
  assert.ok(reset >= 0, 'a stale passing verdict cannot satisfy the merge gate');
  assert.deepEqual(log[reset].slice(1), [SHA, 'boot-reconcile']);
  assert.ok(at((e) => e[0] === 'capture') > reset);
});

test('a rebuilt preview always pends its checks first, as the live tail does', async (t) => {
  fakes(t);
  const pool = makePool({ checks: { checks_commit_sha: SHA, check_state: 'passing' } });
  await finalizeRecoveredTurn(args({ pool, staging: stagingFake(), session: { ...SESSION, status: 'active' } }));
  assert.ok(at((e) => e[0] === 'setChecksPending') < at((e) => e[0] === 'buildStaging'));
});

// ── (d) one staging card per turn, across the live and recovered tails ──

const TURN_ID = '66666666-6666-4666-8666-666666666666';

test('a restart after the live "Staging deployed!" card does not post a second one', async (t) => {
  fakes(t, { needsRebuild: false });
  const activeTurn = { turnId: TURN_ID, phase: 'tail_pending', journal: '/j', tail: {} };
  const pool = makePool({ activeTurn, live: REUSE, checks: { checks_commit_sha: SHA, check_state: 'passing' } });

  // The live tail's card, written as runClaudeCodeTool writes it.
  const live = await sessionsRoutes.publishStagingOutcome({
    pool, sessionId: 510, turnId: TURN_ID, tailIdentity: { turnId: TURN_ID }, outcome: 'success',
    metadata: { stagingUrl: REUSE.stagingUrl, changesReady: true, prNumber: 7, prUrl: SESSION.pr_url },
  });
  assert.equal(live.applied, true);

  // …then the restart, and the recovered tail reusing that preview.
  await finalizeRecoveredTurn(args({
    pool, staging: stagingFake(), activeTurn, session: { ...SESSION, status: 'active' },
    alreadyDone: { ...activeTurn.tail, stagingUrl: REUSE.stagingUrl, completionRowPosted: true, prNumber: 7 },
  }));

  assert.equal(log.filter((e) => e[0] === 'row' && e[1] === 'Staging deployed!').length, 1, 'one card');
  assert.equal(at((e) => e[0] === 'emit' && e[1] === 'staging_ready'), -1, 'and no second reveal');
  assert.equal(pool.effects.get(`${TURN_ID}:recovered_staging_publication`).state, 'completed');
});

test('a restart after the live failure card neither rebuilds nor posts it again', async (t) => {
  fakes(t);
  const activeTurn = { turnId: TURN_ID, phase: 'tail_pending', journal: '/j', tail: {} };
  const pool = makePool({ activeTurn });
  await sessionsRoutes.publishStagingOutcome({
    pool, sessionId: 510, turnId: TURN_ID, tailIdentity: { turnId: TURN_ID }, outcome: 'failed',
    metadata: { error: 'boom', changesReady: true, stagingFailed: true },
    failure: { fix: 'Set the secret.', missingKeys: [], errMsg: 'boom', errName: 'Error' },
  });
  assert.equal(typeof activeTurn.tail.stagingFailed, 'object', 'the checkpoint commits with the card');

  const staging = stagingFake();
  const ret = await finalizeRecoveredTurn(args({
    pool, staging, activeTurn, alreadyDone: { ...activeTurn.tail, completionRowPosted: true, prNumber: 7 },
  }));
  assert.equal(staging.calls.length, 0, 'a preview known to fail is not rebuilt');
  assert.equal(log.filter((e) => e[0] === 'row' && /^Staging/.test(e[1])).length, 1);
  assert.match(ret.summary, /Set the secret\./);
  assert.equal(at((e) => e[0] === 'retireVotes'), -1);
});
