// #3181: a dev-session turn that ends WITHOUT finishing notifies its owner
// ("stopped before finishing", kind session_stalled) instead of saying it
// finished (session_done).
//
// A user came back to a session a day later and found it had quietly
// stopped; nothing had told them. The chat turn's done hook
// (src/services/mayor/turn.js) used to create session_done on every ending,
// a failed one included. It now picks the kind from how the turn ended:
//
//   - a failure row (sendStatus with turnError: an agent run that errored,
//     timed out or lost its worker, the catch-all turn error) → session_stalled;
//   - a stop a person pressed → session_done, whatever failed on the way;
//   - a turn the platform is recovering on its own → session_done (the
//     recovery reports its own ending);
//   - anything else → session_done, as before.
//
// Two layers: the pure decision (turnStalled), and runMayorTurn driven end to
// end against recording fakes with the two notify helpers as spies. Then the
// server.js paths that end a turn outside the chat handler, pinned at source
// level (they live behind boot-only code that tests/restart-recovery-pills-
// server.test.js drives where it can).
//
// Run with: node --test tests/session-stalled-turn-end.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every turn exit schedules a 30s session-bus cleanup; unref the timers so
// this file never waits on them.
const origSetTimeout = global.setTimeout;
global.setTimeout = (...args) => {
  const t = origSetTimeout(...args);
  if (t && t.unref) t.unref();
  return t;
};

// ── Fakes, installed before the turn module is required ──────────────────

const llm = require('../src/services/llm');
let llmStep = null;
llm.isEnabled = () => true;
llm.estimateCostCents = () => 1;
llm.streamChat = async (args) => {
  const step = llmStep;
  llmStep = null;
  if (typeof step === 'function') return step(args);
  if (!step) throw new Error('unexpected streamChat call');
  return JSON.parse(JSON.stringify(step));
};
llm.requireQuickReplies = async () => null;
llm.generateQuickReplies = async () => null;

const limits = require('../src/services/limits');
limits.resolveBillingPath = async () => ({ apiKey: null });
limits.checkBudget = async () => ({});
limits.recordSpend = async () => {};
limits.settleTurnSpend = async () => ({ applied: true });

const sessionTitles = require('../src/services/session-title');
sessionTitles.titleAtTurnEnd = () => {};
sessionTitles.titleFromFirstMessage = () => {};

const ws = require('../src/services/ws');
ws.broadcastGlobal = () => {};

const stopRegistry = require('../src/services/stop-registry');
const { runMayorTurn, turnStalled } = require('../src/services/mayor/turn');
const { MAYOR_TURN_DEPS } = require('../src/routes/sessions');

const SESSION = {
  id: 3181,
  app_id: 31,
  user_id: 7,
  app_slug: 'whiteboard',
  app_name: 'Whiteboard',
  repo_url: 'https://github.com/usernode-bot/whiteboard',
  branch_name: 'dev/tester-3181',
  status: 'active',
  is_headless: false,
  session_title: 'Dark mode',
  pr_number: null,
  cloned_from_session_id: 1,
};

// Run one turn and report which notification its done hook asked for.
async function runTurn({ session = {}, step = null, recovering = false } = {}) {
  const notified = [];
  const statuses = [];
  llmStep = step;
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO chat_session_messages/.test(sql) && /'system'/.test(sql)) {
        statuses.push({ text: params[1], metadata: JSON.parse(params[2] || '{}') });
      }
      if (/SELECT id, role, content, metadata FROM chat_session_messages/.test(sql)) {
        return { rows: [{ id: 1, role: 'user', content: 'Add a dark mode toggle', metadata: {} }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const res = { write() {}, end() {}, destroyed: false, writableEnded: false };
  await runMayorTurn({
    session: { ...SESSION, ...session },
    isOpenRouterSession: false,
    res,
    pool,
    config: { dataEncryptionKey: 'k' },
    req: { user: { id: 7, username: 'tester' } },
    messageText: 'Add a dark mode toggle',
    selectedModel: 'claude-test',
    turnAttachments: [],
    scheduleInteractiveRecovery: () => {},
    userApiKey: null,
  }, {
    ...MAYOR_TURN_DEPS,
    loadSessionSpec: async () => '',
    buildSessionDiscussionBlock: async () => '',
    scheduleRetainedInteractiveTurn: async () => recovering,
    notifySessionDone: (_pool, id) => { notified.push({ kind: 'session_done', id }); },
    notifySessionStalled: (_pool, id) => { notified.push({ kind: 'session_stalled', id }); },
  });
  return { notified, statuses };
}

// ── 1. The decision ──────────────────────────────────────────────────────

test('turnStalled: only a failure the user did not stop, and nobody is recovering', () => {
  assert.equal(turnStalled({ failed: false, recovering: false, stopHandle: {} }), false,
    'a clean end is a finish');
  assert.equal(turnStalled({ failed: true, recovering: false, stopHandle: {} }), true,
    'a failure row is a stall');
  assert.equal(turnStalled({
    failed: true, recovering: false, stopHandle: { stopped: true, stoppedBy: 'tester' },
  }), false, 'a person pressing stop is never a stall');
  assert.equal(turnStalled({
    failed: true, recovering: false, stopHandle: { stopped: true, stoppedBy: 'agent_error' },
  }), true, 'a configuration refusal borrows the stop flag; it is not a person');
  assert.equal(turnStalled({ failed: true, recovering: true, stopHandle: {} }), false,
    'the platform is finishing the turn on its own');
});

// ── 2. The turn, end to end ──────────────────────────────────────────────

test('a clean turn ends in session_done', async () => {
  const { notified } = await runTurn({
    step: {
      text: 'A toggle in the toolbar would do it. Want a spec first?',
      toolUses: [{ id: 'tu-pills', name: 'suggest_replies', input: { replies: ['Write the spec', 'Build it'] } }],
      usage: { input_tokens: 10, output_tokens: 5 },
      rawContent: [],
      stopReason: 'tool_use',
    },
  });
  assert.deepEqual(notified, [{ kind: 'session_done', id: 3181 }]);
});

test('a turn that errors ends in session_stalled, not session_done', async () => {
  const { notified, statuses } = await runTurn({
    step: () => { throw Object.assign(new Error('overloaded'), { status: 529 }); },
  });
  assert.ok(statuses.some((s) => s.metadata.turnError), 'the failure row was persisted');
  assert.deepEqual(notified, [{ kind: 'session_stalled', id: 3181 }]);
});

test('a turn that cannot run at all ends in session_stalled', async () => {
  const { notified } = await runTurn({ session: { repo_url: null } });
  assert.deepEqual(notified, [{ kind: 'session_stalled', id: 3181 }]);
});

test('a turn the user stopped ends in session_done, never session_stalled', async () => {
  const { notified, statuses } = await runTurn({
    step: () => {
      // POST /stop, landing mid-stream: the handle is marked and the stream
      // unwinds with an abort.
      const handle = stopRegistry.get(3181);
      handle.stopped = true;
      handle.stoppedBy = 'tester';
      throw new Error('aborted');
    },
  });
  assert.ok(statuses.some((s) => /^Stopped by @tester/.test(s.text)), 'the stop row was persisted');
  assert.deepEqual(notified, [{ kind: 'session_done', id: 3181 }]);
});

test('a failed turn the platform is recovering does not claim a stall', async () => {
  const { notified, statuses } = await runTurn({
    recovering: true,
    step: () => { throw new Error('socket hang up'); },
  });
  assert.ok(statuses.some((s) => /recovering it automatically/.test(s.text)));
  assert.deepEqual(notified, [{ kind: 'session_done', id: 3181 }],
    'the recovery sends its own notification when it ends');
});

// ── 3. The endings outside the chat handler ─────────────────────────────

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const SESSIONS_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');

test('every "didn\'t finish" breadcrumb after a lost worker notifies the owner', () => {
  // mid_exec_killed, worker_gone, dangling_tail, resume_failed and the
  // missed-reply backfill each call the one helper beside their breadcrumb.
  const calls = SERVER_SRC.match(/await notifyTurnStalled\(pool, (?:sessionId|session\.id)\);/g) || [];
  assert.equal(calls.length, 5, 'one call per unfinished-turn breadcrumb');
  assert.match(SERVER_SRC,
    /async function notifyTurnStalled\(pool, sessionId\) \{\s*\n\s*await require\('\.\/src\/routes\/sessions'\)\.notifySessionStalled\(pool, sessionId\);/);
  assert.match(SERVER_SRC, /if \(!landed\) await notifyTurnStalled\(pool, sessionId\);/,
    'a dangling tail whose code landed is not a stall');
});

test('the watchdog and the recovered tail pick the kind from how the turn ended', () => {
  assert.match(SERVER_SRC,
    /const create = reapCodeLanded\s*\n\s*\? notifications\.createSessionDoneNotification\s*\n\s*: notifications\.createSessionStalledNotification;/,
    'a reaped exec never finished; a reaped tail whose commit landed did');
  assert.match(SERVER_SRC,
    /const create = recoveredStalled\s*\n\s*\? notifications\.createSessionStalledNotification\s*\n\s*: notifications\.createSessionDoneNotification;/);
  assert.match(SERVER_SRC, /recoveredStalled = finalizeOutcome === 'push_failed';/);
});

test('a build that died or exited non-zero is marked as a failed turn', () => {
  // The marker is what the done hook reads; a clean exit that changed nothing
  // is an answer, not a failure.
  assert.match(SESSIONS_SRC,
    /await sendStatus\(msg, result\.exitCode === 0\s*\n\s*\? executionAgentMeta\s*\n\s*: turnFailure\(executionAgentMeta\)\);/);
});
