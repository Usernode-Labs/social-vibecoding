// Tests for #174 — restart-recovered coding turns must debit their
// self-reported costUsd into the spend ledger, routed to the bucket the
// turn actually billed.
//
// Drives the real resume path (resumeHeadlessRuns → resumeOneHeadlessRun,
// cc_running branch) with a stubbed worker whose resumeTurnFromJournal
// returns a recovered result carrying costUsd, and asserts on the
// limits.recordSpend call it produces:
//   1. active_turn.byok: true  → debit lands in the BYOK bucket, even if
//      the user has no key on file at resume time.
//   2. active_turn.byok: false → debit lands in the capped bucket, even
//      if the user HAS a key on file at resume time (the persisted flag
//      reflects what the turn actually billed).
//   3. active_turn.byok absent (pre-#174 rows) → falls back to
//      key-on-file: key present → BYOK bucket, key absent → capped.
//   4. costUsd of 0 (turn killed before any result event) → no debit.
//
// Like headless-clarify.test.js, services are stubbed via require.cache
// and the pool is an in-memory mock that pattern-matches SQL. No real
// Postgres / GitHub / LLM / Docker.
//
// Run with: node --test tests/recovered-turn-spend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ── require.cache stubbing ──────────────────────────────────────────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = {
    id, filename: id, loaded: true, exports,
    paths: original ? original.paths : [],
  };
  return original;
}

// Load ../src/routes/sessions fresh against a mock pool + stubbed
// services. Captures every limits.recordSpend call into `spendCalls`.
function loadSessions(mockPool, { recoveredResult, userKeyEnc } = {}) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    llm: require.resolve('../src/services/llm'),
    limits: require.resolve('../src/services/limits'),
    events: require.resolve('../src/services/events'),
    worker: require.resolve('../src/services/worker'),
    secrets: require.resolve('../src/services/secrets'),
    sessions: require.resolve('../src/routes/sessions'),
    notifications: require.resolve('../src/services/notifications'),
  };

  const spendCalls = [];
  mockPool.state.userKeyEnc = userKeyEnc || null;

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => mockPool })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: () => {},
      pushNotificationToUser: () => 0,
    })],
    [paths.github, stubModule(paths.github, {
      isEnabled: () => true,
      safeMention: (s) => s,
      fetchPublicIssue: async () => ({ issue: { number: 5, title: 'T', body: 'B' } }),
      fetchIssueComments: async () => ({ comments: [] }),
      getBotUsername: async () => 'usernode-bot',
      createIssueComment: async () => {},
    })],
    [paths.llm, stubModule(paths.llm, {
      isEnabled: () => true,
      streamChat: async () => ({
        text: 'Wrap-up after restart.',
        toolUses: [],
        usage: { input_tokens: 10, output_tokens: 5 },
        rawContent: [],
      }),
      estimateCostCents: () => 0,
    })],
    [paths.limits, stubModule(paths.limits, {
      checkBudget: async () => ({}),
      recordSpend: async (_pool, userId, costCents, opts) => {
        spendCalls.push({ userId, costCents, byok: !!(opts && opts.byok) });
      },
    })],
    [paths.events, stubModule(paths.events, {
      record: () => {},
      EVENT_TYPES: { DEV_SESSION_STARTED: 'dev_session_started' },
    })],
    // Keep the real worker exports (sessions.js touches several at call
    // time) — only the journal resume + active-turn clear are faked.
    [paths.worker, stubModule(paths.worker, {
      ...require('../src/services/worker'),
      resumeTurnFromJournal: async () => recoveredResult,
      clearActiveTurn: async () => {},
    })],
    // Pretend decryption of the stored key always works in tests.
    [paths.secrets, stubModule(paths.secrets, {
      ...require('../src/services/secrets'),
      decrypt: () => 'sk-ant-test-key',
    })],
  ];
  delete require.cache[paths.sessions];
  delete require.cache[paths.notifications];

  const subject = require('../src/routes/sessions');

  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.sessions];
    delete require.cache[paths.notifications];
  };
  return { subject, spendCalls, restore };
}

// ── In-memory mock pool ─────────────────────────────────────────────────
// Answers the SQL shapes the cc_running resume path issues.
function makeMockPool(sessionRow) {
  const state = { terminal: null, userKeyEnc: null };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    // Boot sweep for in-flight headless runs.
    if (/FROM chat_sessions cs/i.test(s) && /headless_status = 'generating'/i.test(s)) {
      return { rows: [sessionRow] };
    }
    // BYOK key-on-file lookup (loadUserApiKey).
    if (/SELECT anthropic_key_enc FROM users/i.test(s)) {
      return { rows: state.userKeyEnc ? [{ anthropic_key_enc: state.userKeyEnc }] : [] };
    }
    // Terminal states — both let tests wait for the run to finish.
    if (/UPDATE chat_sessions SET headless_status = 'ready'/i.test(s)) {
      state.terminal = { status: 'ready', outcome: params[0] };
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE chat_sessions SET headless_status = 'failed'/i.test(s)) {
      state.terminal = { status: 'failed' };
      return { rows: [], rowCount: 1 };
    }
    // Model reuse, transcript reads, spec load, inserts, progress
    // rebuilds, step updates: empty defaults are all valid answers.
    return { rows: [], rowCount: 0 };
  }

  return { query, state, calls };
}

function makeSessionRow(activeTurn) {
  return {
    id: 42, app_id: 1, user_id: 7, username: 'alice',
    app_slug: 'my-app', app_name: 'My App',
    repo_url: 'https://github.com/owner/repo',
    app_self_hosted: false,
    branch_name: 'dev/auto-42',
    is_headless: true,
    headless_status: 'generating',
    headless_step: 'cc_running',
    headless_outcome: null,
    headless_issue_number: 5,
    active_turn: activeTurn,
    cc_session_id: null,
    spec_md: null,
  };
}

// A recovered scout turn that produced no spec text but cost $1.23 —
// the invoice-is-paid case the debit must cover.
const RECOVERED = {
  costUsd: 1.23,
  execExitSeen: true,
  resultSeen: true,
  lastResultText: '',
  sessionId: null,
  initSessionId: null,
  fatalError: null,
  ahead: 0,
  sha: null,
};

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

// Run the resume path to completion and return the recovered-cost debit
// calls (the wrap-up Mayor debit is 0¢ in these tests; filter it out).
async function runResume(activeTurn, { recoveredResult = RECOVERED, userKeyEnc = null } = {}) {
  const pool = makeMockPool(makeSessionRow(activeTurn));
  const loaded = loadSessions(pool, { recoveredResult, userKeyEnc });
  try {
    await loaded.subject.resumeHeadlessRuns({ jwtSecret: 'test' });
    assert.ok(await waitFor(() => pool.state.terminal), 'run reached a terminal state');
    return loaded.spendCalls.filter((c) => c.costCents > 0);
  } finally {
    loaded.restore();
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

test('recovered cost lands in the BYOK bucket when active_turn.byok is true', async () => {
  const debits = await runResume(
    { mode: 'scout', journal: '/home/node/.claude/turn-1.log', byok: true },
    { userKeyEnc: null } // key removed since the turn started — flag wins
  );
  assert.equal(debits.length, 1);
  assert.deepEqual(debits[0], { userId: 7, costCents: 123, byok: true });
});

test('recovered cost lands in the capped bucket when active_turn.byok is false', async () => {
  const debits = await runResume(
    { mode: 'scout', journal: '/home/node/.claude/turn-1.log', byok: false },
    { userKeyEnc: 'v1:enc' } // key added since the turn started — flag wins
  );
  assert.equal(debits.length, 1);
  assert.deepEqual(debits[0], { userId: 7, costCents: 123, byok: false });
});

test('missing byok flag falls back to key-on-file: key present → BYOK bucket', async () => {
  const debits = await runResume(
    { mode: 'scout', journal: '/home/node/.claude/turn-1.log' }, // pre-#174 record
    { userKeyEnc: 'v1:enc' }
  );
  assert.equal(debits.length, 1);
  assert.deepEqual(debits[0], { userId: 7, costCents: 123, byok: true });
});

test('missing byok flag falls back to key-on-file: no key → capped bucket', async () => {
  const debits = await runResume(
    { mode: 'scout', journal: '/home/node/.claude/turn-1.log' },
    { userKeyEnc: null }
  );
  assert.equal(debits.length, 1);
  assert.deepEqual(debits[0], { userId: 7, costCents: 123, byok: false });
});

test('zero recovered cost issues no debit', async () => {
  const debits = await runResume(
    { mode: 'scout', journal: '/home/node/.claude/turn-1.log', byok: true },
    { recoveredResult: { ...RECOVERED, costUsd: 0 } }
  );
  assert.equal(debits.length, 0);
});
