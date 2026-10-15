// #451: when a proposal's checks reach a terminal verdict, the preview
// machine's verdict follow-ups (WORK.followUps in
// src/workflow/preview/services.ts) re-drive the app-level auto-merge drain
// — so a PR that already had a winning vote merges the moment its checks
// turn green (the ordering the vote-triggered path never covered). This
// pins the trigger's gating: only a 'passing' (or 'skipped') verdict that
// was not deferred, only a still-'promoted' row, only when GitHub is
// enabled, and it hands the drain the verdict's app_id. Same require.cache
// stubbing pattern as the votes tests — nothing real spins up.
//
// Run with: node --test tests/checks-auto-merge-trigger.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// The follow-ups reach these through legacy(), i.e. the shared require
// cache, so the stubs below are what the handler calls.
const drainCalls = [];
const botCalls = [];
const github = { enabled: true };
stub('../src/services/github', { isEnabled: () => github.enabled });
stub('../src/services/conflict-resolver', {
  checkAndResolveConflicts: async (_config, trigger) => { drainCalls.push(trigger); },
});
stub('../src/services/homeroom-bot-dm', {
  async noteChangeReady(_pool, sessionId) { botCalls.push(['ready', sessionId]); },
});
stub('../src/services/homeroom-bot', {
  async noteProposalChecks(_pool, o) { botCalls.push(['checks', o.sessionId]); },
});
stub('../src/services/shots-orchestrator', { async scheduleForSession() {} });

const { previewServices } = require('../src/workflow/preview/services.ts');
const { WORK } = require('../src/workflow/preview/machine.ts');

// A pool that returns the given chat_sessions row for the status re-read,
// and records the queries it saw.
function poolReturning(row) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/SELECT status FROM chat_sessions/.test(String(sql))) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function followUps(pool, input) {
  drainCalls.length = 0;
  botCalls.length = 0;
  const handlers = previewServices({ config: { jwtSecret: 's' }, pool });
  return handlers[WORK.followUps].run({ input: { sessionId: 7, appId: 42, head: null, ...input } });
}

test('passing verdict on a still-promoted session drives the drain with the app_id', async () => {
  github.enabled = true;
  const pool = poolReturning({ status: 'promoted' });
  await followUps(pool, { state: 'passing' });
  assert.equal(drainCalls.length, 1, 'drain fired exactly once');
  assert.deepEqual(drainCalls[0], { app_id: 42 }, 'drain got the app_id');
});

test('a skipped verdict drives the drain as a passing one does', async () => {
  github.enabled = true;
  await followUps(poolReturning({ status: 'promoted' }), { state: 'skipped' });
  assert.deepEqual(drainCalls, [{ app_id: 42 }]);
});

test('a failing verdict never touches the drain (no status read either)', async () => {
  github.enabled = true;
  const pool = poolReturning({ status: 'promoted' });
  await followUps(pool, { state: 'failing' });
  assert.equal(drainCalls.length, 0, 'no drain for a non-passing verdict');
  assert.equal(pool.queries.length, 0, 'short-circuits before the status re-read');
  assert.deepEqual(botCalls, [['checks', 7]], 'the failing verdict goes to the bot instead');
});

test('a deferred verdict never touches the drain', async () => {
  github.enabled = true;
  const pool = poolReturning({ status: 'promoted' });
  await followUps(pool, { state: 'passing', deferred: true });
  assert.equal(drainCalls.length, 0);
  assert.equal(pool.queries.length, 0);
});

test('a passing verdict on a session that is no longer promoted is a no-op', async () => {
  github.enabled = true;
  // The capture took minutes; the row was force-merged in the meantime.
  const pool = poolReturning({ status: 'merged' });
  await followUps(pool, { state: 'passing' });
  assert.equal(drainCalls.length, 0, 'never re-merges a non-promoted row');
  assert.ok(pool.queries.some((q) => /SELECT status FROM chat_sessions/.test(q.sql)),
    're-read the live status rather than trusting the snapshot');
});

test('a vanished session row (archived/deleted mid-capture) is a no-op', async () => {
  github.enabled = true;
  await followUps(poolReturning(null), { state: 'passing' });
  assert.equal(drainCalls.length, 0);
});

test('passing verdict is a no-op when GitHub is disabled (staging / standalone)', async () => {
  github.enabled = false;
  await followUps(poolReturning({ status: 'promoted' }), { state: 'passing' });
  assert.equal(drainCalls.length, 0, 'nothing to merge without GitHub');
});
