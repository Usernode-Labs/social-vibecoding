// The recovered build tail ends a turn the way the live tail does.
//
// A restart can land between any two steps of a build's tail, and recovery
// (server.js finalizeRecoveredTurn) repeats whatever the live tail
// (routes/sessions.js runClaudeCodeTool) had not finished. Neither tail
// builds anything now: both retire a promoted proposal's votes, hand the
// commit to the preview machine (services/preview-workflow.js revision) and
// post a "Building staging preview..." card. Where the two must agree:
//
//   (a) the votes are retired before the hand-off, since the proposal's
//       reviewed head is the pin the machine checks a revision against;
//   (b) the reset is posted in the proposal's own thread, once (a platform
//       line names its thread or is not written);
//   (c) the card is written under one receipt across the live and recovered
//       tails, so a restart after the live card never posts a second one,
//       and a failure card an earlier release's tail posted is honoured.
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
const previewWorkflow = require('../src/services/preview-workflow');
const voteRevision = require('../src/services/vote-revision');
const appAdmins = require('../src/services/app-admins');
const ws = require('../src/services/ws');

// Module properties the tail reads at call time.
function patch(t, target, name, fn) {
  const original = target[name];
  target[name] = fn;
  t.after(() => { target[name] = original; });
}

function fakes(t) {
  log.length = 0;
  patch(t, previewWorkflow, 'revision', async ({ session, head, source, trigger }) => {
    log.push(['revision', session.id, head, source, trigger]);
  });
  patch(t, appAdmins, 'refreshExplicitApproval', async () => false);
  patch(t, voteRevision, 'retireAndRecheck', async (_pool, session, sha, { announce }) => {
    log.push(['retireVotes', session.id, sha]);
    await announce({ retired: 2 });
    return { bumped: true, retired: 2 };
  });
  patch(t, ws, 'sendSystemMessage', async (...args) => { log.push(['sendSystemMessage', args]); });
  patch(t, ws, 'pushVoteUpdate', () => {});
}

function makePool({ activeTurn = null } = {}) {
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
    if (/INSERT INTO chat_session_messages/i.test(text)) {
      log.push(['row', params[1]]);
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT content FROM chat_session_messages/i.test(text)) return { rows: [{ content: 'do it' }] };
    return { rows: [], rowCount: 0 };
  };
  return { calls, effects, query, async connect() { return { query, release() {} }; } };
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
    staging: {},
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

const TURN_ID = '66666666-6666-4666-8666-666666666666';

// ── (a) the votes are retired, then the commit is handed off ────────────

test('a promoted proposal\'s votes are retired before the commit goes to the preview machine', async (t) => {
  fakes(t);
  const activeTurn = { turnId: TURN_ID, phase: 'tail_pending', journal: '/j', tail: {} };
  const ret = await finalizeRecoveredTurn(args({ pool: makePool({ activeTurn }), activeTurn }));

  const claimed = at((e) => e[0] === 'milestone' && e[1].votesResetFor === SHA);
  const retired = at((e) => e[0] === 'retireVotes');
  const handed = at((e) => e[0] === 'revision');
  const card = at((e) => e[0] === 'row' && e[1] === 'Building staging preview...');
  assert.ok(claimed >= 0 && retired >= 0 && handed >= 0 && card >= 0);
  assert.ok(claimed < retired, 'claimed before the votes are touched');
  assert.ok(retired < handed, 'the reviewed head moves before the machine checks the revision');
  assert.ok(handed < card, 'the card follows the hand-off');
  assert.deepEqual(log[handed].slice(1), [510, SHA, 'turn', 'boot-reconcile']);
  assert.match(ret.summary, /The staging preview is building/);
  assert.equal(at((e) => e[0] === 'row' && /^Staging (deployed|build failed)/.test(e[1])), -1,
    'the tail no longer reports a build: the machine writes those rows itself');
});

test('an active session\'s votes are left alone; the commit is still handed off', async (t) => {
  fakes(t);
  await finalizeRecoveredTurn(args({ pool: makePool(), session: { ...SESSION, status: 'active' } }));
  assert.equal(at((e) => e[0] === 'retireVotes'), -1);
  assert.equal(at((e) => e[0] === 'milestone' && 'votesResetFor' in e[1]), -1);
  assert.ok(at((e) => e[0] === 'revision') >= 0);
});

// ── (b) the reset's line goes to the proposal's thread, once ────────────

test('the reset announcement names the proposal\'s thread and is posted once', async (t) => {
  fakes(t);
  await finalizeRecoveredTurn(args({ pool: makePool() }));
  const lines = log.filter((e) => e[0] === 'sendSystemMessage').map((e) => e[1]);
  assert.equal(lines.length, 1, 'no second, thread-less copy');
  assert.deepEqual(lines[0][5], { type: 'session', ref: 510 });
  assert.match(lines[0][2], /An update was pushed to PR #7 \(commit feedface\)/);
});

// ── (c) one staging card per turn, across the live and recovered tails ──

test('a restart after the live "Building staging preview..." card does not post a second one', async (t) => {
  fakes(t);
  const activeTurn = { turnId: TURN_ID, phase: 'tail_pending', journal: '/j', tail: {} };
  const pool = makePool({ activeTurn });

  // The live tail's card, written as runClaudeCodeTool writes it.
  const live = await sessionsRoutes.publishStagingOutcome({
    pool, sessionId: 510, turnId: TURN_ID, tailIdentity: { turnId: TURN_ID }, outcome: 'building',
    metadata: { changesReady: true, stagingBuild: 'running', prNumber: 7, prUrl: SESSION.pr_url },
  });
  assert.equal(live.applied, true);

  // …then the restart, and the recovered tail handing the commit off again.
  await finalizeRecoveredTurn(args({
    pool, activeTurn, session: { ...SESSION, status: 'active' },
    alreadyDone: { ...activeTurn.tail, completionRowPosted: true, prNumber: 7 },
  }));

  assert.equal(log.filter((e) => e[0] === 'row' && e[1] === 'Building staging preview...').length, 1, 'one card');
  assert.ok(at((e) => e[0] === 'revision') >= 0, 'the machine joins a preview it already has');
  assert.equal(pool.effects.get(`${TURN_ID}:recovered_staging_publication`).state, 'completed');
});

test('a restart after an earlier release\'s failure card neither hands off nor posts it again', async (t) => {
  fakes(t);
  const activeTurn = { turnId: TURN_ID, phase: 'tail_pending', journal: '/j', tail: {} };
  const pool = makePool({ activeTurn });
  await sessionsRoutes.publishStagingOutcome({
    pool, sessionId: 510, turnId: TURN_ID, tailIdentity: { turnId: TURN_ID }, outcome: 'failed',
    metadata: { error: 'boom', changesReady: true, stagingFailed: true },
    failure: { fix: 'Set the secret.', missingKeys: [], errMsg: 'boom', errName: 'Error' },
  });
  assert.equal(typeof activeTurn.tail.stagingFailed, 'object', 'the checkpoint commits with the card');

  const ret = await finalizeRecoveredTurn(args({
    pool, activeTurn, alreadyDone: { ...activeTurn.tail, completionRowPosted: true, prNumber: 7 },
  }));
  assert.equal(at((e) => e[0] === 'revision'), -1, 'a preview known to fail is not handed off again');
  assert.equal(log.filter((e) => e[0] === 'row' && /^Staging/.test(e[1])).length, 1);
  assert.match(ret.summary, /Set the secret\./);
  assert.equal(at((e) => e[0] === 'retireVotes'), -1);
});
