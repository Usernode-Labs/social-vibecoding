// #6776: "Let it try again" says a try is already waiting only when one
// really is queued or running. A grant with nothing behind it (its queueing
// failed, its round was dropped) has its round queued again, on the press
// and on the bot's own sweep; when it cannot be queued at all (the change
// merged or closed, the bot is off) the grant is closed and the reason said.
//
// Run with: node --test tests/homeroom-bot-retry-grants.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const grants = require('../src/services/homeroom-bot-retry-grants');

const MINUTE = 60 * 1000;
const NOW = Date.UTC(2026, 10, 17, 16, 0, 0);

/**
 * A pool that answers the reads a grant and the sweep make, keyed by SQL.
 * `sessions` maps a change id to what chat_sessions says about it; `queue`
 * maps a request number to its homeroom_bot_queue row; `queueOrder` is the ids of the
 * waiting queue, in the order the bot page draws them.
 */
function grantPool({
  sessions = { 5: { status: 'promoted', check_state: 'failing', app_id: 9, linked_issues: [7], active_turn: null } },
  openGrant = { 5: 41 },
  queue = {},
  queueOrder = [],
  pendingAsk = null,
  work = null,
  requesterId = 11,
} = {}) {
  const state = { inserted: 0, closed: [], queued: [], asked: [] };
  return {
    state,
    query: async (sql, params = []) => {
      const text = String(sql);
      if (/SELECT id, app_id, linked_issues FROM chat_sessions WHERE id = \$1/.test(text)) {
        return { rows: [{ id: Number(params[0]), app_id: 9, linked_issues: [7] }] };
      }
      if (/FROM homeroom_bot_requesters/.test(text)) return { rows: [{ user_id: requesterId, username: 'evan' }] };
      if (/SELECT id FROM homeroom_bot_revision_grants WHERE session_id = \$1 AND used_at IS NULL/.test(text)) {
        const id = openGrant[Number(params[0])];
        return { rows: id ? [{ id }] : [] };
      }
      if (/INSERT INTO homeroom_bot_revision_grants/.test(text)) {
        state.inserted += 1;
        return { rows: [{ id: 900 }] };
      }
      if (/UPDATE homeroom_bot_revision_grants\s+SET used_at = now\(\)/.test(text)) {
        state.closed.push(Number(params[0]));
        return { rows: [] };
      }
      if (/status, active_turn FROM chat_sessions WHERE id = \$1/.test(text)) {
        const s = sessions[Number(params[0])];
        return { rows: s ? [{ app_id: s.app_id, linked_issues: s.linked_issues, status: s.status, active_turn: s.active_turn }] : [] };
      }
      if (/SELECT status FROM chat_sessions WHERE id = \$1/.test(text)) {
        const s = sessions[Number(params[0])];
        return { rows: s ? [{ status: s.status }] : [] };
      }
      if (/SELECT id, started_at FROM homeroom_bot_queue/.test(text)) {
        const row = queue[Number(Array.isArray(params[1]) ? params[1][0] : params[0])];
        return { rows: row ? [row] : [] };
      }
      if (/SELECT q\.id FROM homeroom_bot_queue q JOIN apps a/.test(text)) {
        return { rows: queueOrder.map((id) => ({ id })) };
      }
      if (/SELECT 1 FROM wf_work/.test(text)) return { rows: work === null ? [] : [{ id: 1 }] };
      if (/SELECT 1 FROM wf_events/.test(text)) return { rows: pendingAsk === null ? [] : [{ id: 1 }] };
      return { rows: [] };
    },
  };
}

/** The bot with queueChecksFix stubbed, which is what the grant calls. */
function botDeps(answer = { queued: true }) {
  const calls = [];
  return {
    calls,
    deps: { homeroomBot: { queueChecksFix: async (_pool, args) => { calls.push(args); return answer; } } },
  };
}

const user = { id: 11 };

test('a stranded grant is queued again, and the person is told so', async () => {
  const pool = grantPool();
  const bot = botDeps();
  const out = await grants.grant(pool, { sessionId: 5, user, deps: bot.deps });
  assert.deepEqual(out, { ok: true, grantId: 41, requeued: true });
  assert.equal(bot.calls.length, 1, 'the round was queued again');
  assert.match(bot.calls[0].again, /^press:/, 'a fresh ask, so the earlier receipt does not swallow it');
  assert.equal(grants.grantDoneText(out), 'Your earlier try never started, so I queued it again.');
  assert.equal(pool.state.inserted, 0, 'the open grant is reused, never a second one');
  assert.deepEqual(pool.state.closed, [], 'nothing closed');
});

test('a grant whose round is queued answers already, with its place in line', async () => {
  const pool = grantPool({ queue: { 7: { id: 31, started_at: null } }, queueOrder: [100, 31] });
  const bot = botDeps();
  const out = await grants.grant(pool, { sessionId: 5, user, deps: bot.deps });
  assert.deepEqual(out, { ok: false, why: 'already', running: false, place: 2 });
  assert.equal(
    grants.grantRefusalText(out.why, out),
    'A try is already queued for this change, 2nd in line. Nothing more was queued.',
  );
  assert.equal(bot.calls.length, 0, 'nothing more was queued');
});

test('a grant whose round is running says so', async () => {
  const pool = grantPool({ queue: { 7: { id: 31, started_at: new Date(NOW) } } });
  const bot = botDeps();
  const out = await grants.grant(pool, { sessionId: 5, user, deps: bot.deps });
  assert.deepEqual(out, { ok: false, why: 'already', running: true, place: null });
  assert.equal(
    grants.grantRefusalText(out.why, out),
    'A try is already queued for this change, and running now. Nothing more was queued.',
  );
  assert.equal(bot.calls.length, 0);
});

test('a fix asked for and not picked up yet counts as queued', async () => {
  const pool = grantPool({ pendingAsk: 1 });
  const out = await grants.grant(pool, { sessionId: 5, user, deps: botDeps().deps });
  assert.equal(out.ok, false);
  assert.equal(out.why, 'already');
  assert.equal(grants.grantRefusalText(out.why, out), 'A try is already queued for this change. Nothing more was queued.');
});

test('the sweep queues a grant left open with nothing behind it', async () => {
  const pool = grantPool({
    sessions: {
      5: { status: 'promoted', check_state: 'failing', app_id: 9, linked_issues: [7], active_turn: null },
      6: { status: 'promoted', check_state: 'failing', app_id: 9, linked_issues: [8], active_turn: null },
      7: { status: 'promoted', check_state: 'pending', app_id: 9, linked_issues: [9], active_turn: null },
    },
    openGrant: { 5: 41, 6: 42, 7: 43 },
  });
  const rows = [
    { id: 41, session_id: 5, created_at: new Date(NOW - 6 * MINUTE), status: 'promoted', check_state: 'failing' },
    { id: 42, session_id: 6, created_at: new Date(NOW - 2 * MINUTE), status: 'promoted', check_state: 'failing' },
    { id: 43, session_id: 7, created_at: new Date(NOW - 60 * MINUTE), status: 'promoted', check_state: 'pending' },
  ];
  const base = pool.query;
  pool.query = async (sql, params) => {
    if (/FROM homeroom_bot_revision_grants g/.test(String(sql))) return { rows };
    return base(sql, params);
  };
  const bot = botDeps();
  const out = await grants.sweepStrandedGrants(pool, null, { ...bot.deps, now: () => NOW });
  assert.deepEqual(out, { requeued: 1, closed: 0 });
  assert.equal(bot.calls.length, 1, 'only the stranded one was asked again');
  assert.equal(bot.calls[0].sessionId, 5);
  assert.match(bot.calls[0].again, /^sweep:/);
});

test('a grant whose change merged is closed, and the refusal said', async () => {
  const pool = grantPool({ sessions: { 5: { status: 'merged', check_state: 'failing', app_id: 9, linked_issues: [7], active_turn: null } } });
  const bot = botDeps();
  const out = await grants.grant(pool, { sessionId: 5, user, deps: bot.deps });
  assert.deepEqual(out, { ok: false, why: 'merged' });
  assert.deepEqual(pool.state.closed, [41], 'the try was closed');
  assert.equal(bot.calls.length, 0);
  assert.equal(
    grants.grantRefusalText(out.why, out),
    'This change has already merged, so there is nothing left to try. Nothing was queued.',
  );
});

test('a grant the bot cannot queue (bot off) is closed with that reason', async () => {
  const pool = grantPool();
  const bot = botDeps({ queued: false, why: 'off' });
  const out = await grants.grant(pool, { sessionId: 5, user, deps: bot.deps });
  assert.deepEqual(out, { ok: false, why: 'bot_off' });
  assert.deepEqual(pool.state.closed, [41]);
  assert.equal(
    grants.grantRefusalText(out.why, out),
    'Homeroom bot is off for this project right now, so it cannot try again. Nothing was queued.',
  );
});

test('a read that fails answers already, so a database error never doubles a grant', async () => {
  const pool = {
    query: async (sql) => {
      const text = String(sql);
      if (/SELECT id, app_id, linked_issues FROM chat_sessions WHERE id = \$1/.test(text)) return { rows: [{ app_id: 9, linked_issues: [7] }] };
      if (/FROM homeroom_bot_requesters/.test(text)) return { rows: [{ user_id: 11 }] };
      if (/SELECT id FROM homeroom_bot_revision_grants/.test(text)) return { rows: [{ id: 41 }] };
      if (/status, active_turn FROM chat_sessions WHERE id = \$1/.test(text)) throw new Error('down');
      return { rows: [] };
    },
  };
  const bot = botDeps();
  const out = await grants.grant(pool, { sessionId: 5, user, deps: bot.deps });
  assert.deepEqual(out, { ok: false, why: 'already', running: false, place: null });
  assert.equal(bot.calls.length, 0);
});
