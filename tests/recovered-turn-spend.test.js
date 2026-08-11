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
//   3. active_turn.byok absent (pre-#174 rows) → falls back to the
//      resume-time payer, which since #212 is limit-first: allowance
//      headroom → capped bucket (even with a key on file), allowance
//      exhausted + key → BYOK bucket.
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
function loadSessions(mockPool, {
  recoveredResult,
  userKeyEnc,
  billing,
  turnByokCents,
  finishTurnImpl,
  workerCalls = {},
} = {}) {
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
      fetchIssueComments: async () => ({ comments: [], truncated: false }),
      getBotUsername: async () => 'usernode-bot',
      createIssueComment: async () => {},
    })],
    [paths.llm, stubModule(paths.llm, {
      isEnabled: () => true,
      streamChat: async () => {
        workerCalls.mayorCalls = (workerCalls.mayorCalls || 0) + 1;
        return {
          text: 'Wrap-up after restart.',
          toolUses: [],
          usage: { input_tokens: 10, output_tokens: 5 },
          rawContent: [],
        };
      },
      estimateCostCents: () => 0,
    })],
    [paths.limits, stubModule(paths.limits, {
      checkBudget: async () => ({}),
      // Resume-time payer decision (#212). Defaults to "allowance has
      // headroom" (platform path); tests simulating spillover override
      // it with a BYOK result.
      resolveBillingPath: async () => billing || { apiKey: null, byok: false },
      recordSpend: async (_pool, userId, costCents, opts) => {
        spendCalls.push({ userId, costCents, byok: !!(opts && opts.byok) });
      },
      // #664: the resume path settles through settleTurnSpend now —
      // mirror the real split so bucket assertions stay meaningful.
      settleTurnSpend: async (_pool, userId, totalCents, { turnByok = false, byokObservedCents = 0 } = {}) => {
        if (!(totalCents > 0)) return { platformCents: 0, byokCents: 0 };
        const byokCents = turnByok
          ? totalCents
          : Math.min(Math.max(byokObservedCents, 0), totalCents);
        const platformCents = totalCents - byokCents;
        if (platformCents > 0) spendCalls.push({ userId, costCents: platformCents, byok: false });
        if (byokCents > 0) spendCalls.push({ userId, costCents: byokCents, byok: true });
        return { platformCents, byokCents };
      },
    })],
    [paths.events, stubModule(paths.events, {
      record: () => {},
      EVENT_TYPES: { DEV_SESSION_STARTED: 'dev_session_started' },
    })],
    // Keep the real worker exports (sessions.js touches several at call
    // time) — only journal resume + successful durable cleanup are faked.
    [paths.worker, stubModule(paths.worker, {
      ...require('../src/services/worker'),
      resumeTurnFromJournal: async (...args) => {
        workerCalls.resumes = (workerCalls.resumes || 0) + 1;
        workerCalls.resumeArgs = args;
        return recoveredResult;
      },
      clearActiveTurn: async () => {},
      finishTurn: async (...args) => {
        workerCalls.finishes = (workerCalls.finishes || 0) + 1;
        const cleared = finishTurnImpl ? await finishTurnImpl(...args) : true;
        if (!cleared && mockPool.state.sessionRow?.active_turn) {
          // Model the production failure boundary: finishTurn committed the
          // cleanup_pending transition but its identity-safe NULL update did
          // not land. The retry must derive cleanup-only work from this row.
          mockPool.state.sessionRow.active_turn = {
            ...mockPool.state.sessionRow.active_turn,
            phase: 'cleanup_pending',
          };
        } else if (cleared && mockPool.state.sessionRow) {
          mockPool.state.sessionRow.active_turn = null;
        }
        return cleared;
      },
      // #664: proxy-observed BYOK spillover for the resumed turn.
      getTurnByokCents: () => turnByokCents || 0,
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
  const state = {
    terminal: null,
    userKeyEnc: null,
    sessionRow,
    effects: new Map(),
  };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s.trim())) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO turn_effects/i.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      if (state.effects.has(key)) return { rows: [], rowCount: 0 };
      const effect = { state: 'pending', result: null };
      state.effects.set(key, effect);
      return { rows: [{ state: effect.state }], rowCount: 1 };
    }
    if (/UPDATE turn_effects/i.test(s)) {
      const key = `${params[0]}:${params[1]}`;
      const effect = state.effects.get(key);
      if (!effect || effect.state !== 'pending') return { rows: [], rowCount: 0 };
      effect.state = 'completed';
      effect.result = params[2] == null ? null : JSON.parse(params[2]);
      return { rows: [{ result: effect.result }], rowCount: 1 };
    }
    if (/SELECT state(?:, result)? FROM turn_effects/i.test(s)) {
      const effect = state.effects.get(`${params[0]}:${params[1]}`);
      return { rows: effect ? [{ ...effect }] : [], rowCount: effect ? 1 : 0 };
    }

    // Boot sweep for in-flight headless runs.
    if (/FROM chat_sessions cs/i.test(s) && /headless_status = 'generating'/i.test(s)) {
      return { rows: [sessionRow] };
    }
    // BYOK key-on-file lookup (limits.loadUserApiKey — only reached when
    // a test lets the real limits module run).
    if (/SELECT anthropic_key_enc FROM users/i.test(s)) {
      return { rows: state.userKeyEnc ? [{ anthropic_key_enc: state.userKeyEnc }] : [] };
    }
    // Terminal states — both let tests wait for the run to finish.
    if (/SET headless_status = \$4/i.test(s)) {
      sessionRow.active_turn = {
        ...sessionRow.active_turn,
        ...JSON.parse(params[2]),
      };
      sessionRow.headless_status = params[3];
      sessionRow.headless_outcome = params[4] || sessionRow.headless_outcome;
      sessionRow.headless_step = null;
      sessionRow.headless_turn_id = null;
      state.terminal = { status: params[3], outcome: params[4] || null };
      return { rows: [{ active_turn: sessionRow.active_turn }], rowCount: 1 };
    }
    if (/UPDATE chat_sessions SET headless_status = 'ready'/i.test(s)) {
      state.terminal = { status: 'ready', outcome: params[0] };
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE chat_sessions SET headless_status = 'failed'/i.test(s)) {
      state.terminal = { status: 'failed' };
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE chat_sessions SET headless_step/i.test(s)) {
      sessionRow.headless_step = params[0];
      const outcomeAssignment = s.match(/headless_outcome = \$(\d+)/i);
      const turnAssignment = s.match(/headless_turn_id = \$(\d+)/i);
      if (outcomeAssignment) sessionRow.headless_outcome = params[Number(outcomeAssignment[1]) - 1];
      if (turnAssignment) sessionRow.headless_turn_id = params[Number(turnAssignment[1]) - 1];
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
    headless_turn_id: null,
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
async function runResume(activeTurn, {
  recoveredResult = RECOVERED,
  userKeyEnc = null,
  billing = null,
  turnByokCents = 0,
  finishTurnImpl = null,
  workerCalls = {},
  waitForCleanupRetry = false,
  sessionOverrides = null,
} = {}) {
  const sessionRow = makeSessionRow(activeTurn);
  if (sessionOverrides) Object.assign(sessionRow, sessionOverrides);
  const pool = makeMockPool(sessionRow);
  const loaded = loadSessions(pool, {
    recoveredResult,
    userKeyEnc,
    billing,
    turnByokCents,
    finishTurnImpl,
    workerCalls,
  });
  try {
    await loaded.subject.resumeHeadlessRuns({ jwtSecret: 'test' });
    assert.ok(await waitFor(() => pool.state.terminal), 'run reached a terminal state');
    if (waitForCleanupRetry) {
      const recoveryRetry = require('../src/services/recovery-retry');
      assert.ok(await waitFor(
        () => workerCalls.finishes >= 2 && !recoveryRetry.isScheduled('headless:42'),
        3000,
      ), 'cleanup-only retry completed');
    }
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
    // Resume-time payer is the user's key (allowance exhausted since the
    // turn started) — the persisted flag still wins.
    { billing: { apiKey: 'sk-ant-test-key', byok: true } }
  );
  assert.equal(debits.length, 1);
  assert.deepEqual(debits[0], { userId: 7, costCents: 123, byok: false });
});

test('missing byok flag falls back to the resume-time payer: spillover → BYOK bucket', async () => {
  const debits = await runResume(
    { mode: 'scout', journal: '/home/node/.claude/turn-1.log' }, // pre-#174 record
    // Allowance exhausted + key on file at resume → the run continues
    // on the key, so the recovered cost is attributed to it too.
    { billing: { apiKey: 'sk-ant-test-key', byok: true } }
  );
  assert.equal(debits.length, 1);
  assert.deepEqual(debits[0], { userId: 7, costCents: 123, byok: true });
});

test('missing byok flag falls back to the resume-time payer: allowance headroom → capped bucket', async () => {
  const debits = await runResume(
    { mode: 'scout', journal: '/home/node/.claude/turn-1.log' },
    // #212 limit-first: a key on file is irrelevant while the allowance
    // has headroom — the platform is the payer.
    { userKeyEnc: 'v1:enc' }
  );
  assert.equal(debits.length, 1);
  assert.deepEqual(debits[0], { userId: 7, costCents: 123, byok: false });
});

test('#664: a mid-turn payer switch splits the recovered cost across both buckets', async () => {
  // active_turn.byok: false (platform dispatch) but the proxy observed
  // 23¢ of spillover onto the owner's key before/after the restart.
  const debits = await runResume(
    { mode: 'scout', journal: '/home/node/.claude/turn-1.log', byok: false, byokCents: 23 },
    { turnByokCents: 23 }
  );
  assert.equal(debits.length, 2);
  assert.deepEqual(debits[0], { userId: 7, costCents: 100, byok: false });
  assert.deepEqual(debits[1], { userId: 7, costCents: 23, byok: true });
});

test('recovered journal resume restores the durable turn id used by BYOK mirroring', async () => {
  const workerCalls = {};
  const turnId = '33333333-3333-4333-8333-333333333333';
  await runResume(
    {
      turnId,
      mode: 'scout',
      journal: '/home/node/.claude/turn-1.log',
      byok: false,
    },
    { workerCalls },
  );

  assert.equal(workerCalls.resumeArgs[1].turnId, turnId);
  assert.equal(workerCalls.resumeArgs[1].byokCentsSoFar, 0);
});

test('zero recovered cost issues no debit', async () => {
  const debits = await runResume(
    { mode: 'scout', journal: '/home/node/.claude/turn-1.log', byok: true },
    { recoveredResult: { ...RECOVERED, costUsd: 0 } }
  );
  assert.equal(debits.length, 0);
});

test('a failed durable cleanup retries only cleanup, never recovered spend', async () => {
  const workerCalls = {};
  const debits = await runResume(
    { mode: 'scout', journal: '/home/node/.claude/turn-1.log', byok: false },
    {
      workerCalls,
      finishTurnImpl: async () => workerCalls.finishes >= 2,
      waitForCleanupRetry: true,
    },
  );

  assert.equal(workerCalls.resumes, 1, 'the journal and settlement are not replayed');
  assert.equal(workerCalls.finishes, 2, 'only the durable cleanup is retried');
  assert.deepEqual(debits, [{ userId: 7, costCents: 123, byok: false }]);
});

test('cleanup_pending hands a generating wrapping row back to its receipt-backed wrap-up', async () => {
  const workerCalls = {};
  await runResume(
    {
      turnId: '22222222-2222-4222-8222-222222222222',
      mode: 'build',
      phase: 'cleanup_pending',
      journal: '/home/node/.claude/turn-1.log',
    },
    {
      workerCalls,
      sessionOverrides: {
        headless_step: 'wrapping',
        headless_outcome: 'code',
        headless_turn_id: '11111111-1111-4111-8111-111111111111',
      },
    },
  );

  assert.equal(workerCalls.finishes, 1, 'the obsolete coding owner is cleared once');
  assert.equal(workerCalls.resumes || 0, 0, 'a completed coding journal is never replayed');
  assert.equal(workerCalls.mayorCalls, 1, 'the persisted wrap-up continues after cleanup');
});
