// Route-level tests for the headless auto-retry of markerless coding
// turns plus the cause-specific failure messages that replaced the bare
// "Claude Code exited with code -1" wording.
//
// Follows the headless-clarify.test.js pattern: the pool is an in-memory
// mock that pattern-matches SQL, and the github/llm/ws/worker/staging/
// app-access/limits/events modules are stubbed via require.cache. The
// full route → headless runner → runClaudeCodeTool/runScoutTool path is
// driven over HTTP against an ephemeral express server.
//
// Run with: node --test tests/headless-cc-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// ── require.cache stubbing ──────────────────────────────────────────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = {
    id, filename: id, loaded: true, exports,
    paths: original ? original.paths : [],
  };
  return original;
}

// Error classes the staging stub must expose — describeStagingFailure
// branches on `instanceof staging.…Error`.
class PrivateSecretMissingStagingDefaultError extends Error {}
class MissingSecretsError extends Error {}

function loadSessions(mockPool, overrides = {}) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    llm: require.resolve('../src/services/llm'),
    worker: require.resolve('../src/services/worker'),
    staging: require.resolve('../src/services/staging'),
    appAccess: require.resolve('../src/services/app-access'),
    limits: require.resolve('../src/services/limits'),
    events: require.resolve('../src/services/events'),
    sessions: require.resolve('../src/routes/sessions'),
    notifications: require.resolve('../src/services/notifications'),
  };

  const githubStub = {
    isEnabled: () => true,
    fetchPublicIssue: async () => ({ issue: { number: 5, title: 'Make it better', body: 'please' } }),
    fetchIssueComments: async () => ({ comments: [], truncated: false }),
    getBotUsername: async () => 'usernode-bot',
    createBranch: async () => {},
    createIssueComment: async () => {},
    safeMention: (s) => s,
    ...(overrides.github || {}),
  };
  const llmStub = {
    isEnabled: () => true,
    streamChat: async () => ({ text: 'ok', toolUses: [], usage: { input_tokens: 1, output_tokens: 1 }, rawContent: [] }),
    estimateCostCents: () => 0,
    ...(overrides.llm || {}),
  };
  const workerStub = {
    ensureWorkerImage: async () => {},
    ensureWorker: async () => 'stub-worker',
    execInWorker: async () => ({ lastResultText: '' }),
    resumeTurnFromJournal: async () => ({}),
    clearActiveTurn: async () => {},
    stopTurn: async () => {},
    isWorkerExecuting: async () => false,
    workerContainerName: (id) => `usernode-worker-${id}`,
    ...(overrides.worker || {}),
  };
  // Staging always fails fast in these tests — on the headless path that
  // is non-fatal (the pushed commit is the deliverable), so the run still
  // finalizes with outcome 'code'.
  const stagingStub = {
    PrivateSecretMissingStagingDefaultError,
    MissingSecretsError,
    buildAndDeployStaging: async () => { throw new Error('staging disabled in tests'); },
    verifyStagingEdge: async () => {},
    ...(overrides.staging || {}),
  };

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => mockPool })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: () => {},
      pushNotificationToUser: () => 0,
      pushSessionUpdate: () => {},
    })],
    [paths.github, stubModule(paths.github, githubStub)],
    [paths.llm, stubModule(paths.llm, llmStub)],
    [paths.worker, stubModule(paths.worker, workerStub)],
    [paths.staging, stubModule(paths.staging, stagingStub)],
    [paths.appAccess, stubModule(paths.appAccess, {
      ...require('../src/services/app-access'),
      getAppForUser: async () => ({
        id: 1, slug: 'my-app', name: 'My App',
        repo_url: 'https://github.com/owner/repo', self_hosted: false,
      }),
    })],
    [paths.limits, stubModule(paths.limits, {
      checkBudget: async () => ({}),
      resolveBillingPath: async () => ({ apiKey: null, byok: false }),
      recordSpend: async () => {},
    })],
    [paths.events, stubModule(paths.events, {
      record: () => {},
      EVENT_TYPES: { DEV_SESSION_STARTED: 'dev_session_started', PR_OPENED: 'pr_opened' },
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
  return { subject, restore };
}

// ── In-memory mock pool (same shapes as headless-clarify.test.js) ───────

function makeMockPool() {
  const state = {
    messages: [],      // chat_session_messages inserts: { role, content }
    terminal: null,    // { status, outcome } once the run finishes
    specMd: '',
    nextId: 1000,
  };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    if (/SELECT id, headless_status FROM chat_sessions/i.test(s)
        && /headless_issue_number/i.test(s)) {
      return { rows: [] };
    }
    if (/SELECT COUNT\(\*\) as cnt FROM chat_sessions/i.test(s)) {
      return { rows: [{ cnt: '0' }] };
    }
    if (/SELECT anthropic_key_enc FROM users/i.test(s)) {
      return { rows: [] };
    }
    if (/INSERT INTO chat_sessions/i.test(s)) {
      return {
        rows: [{
          id: state.nextId++, app_id: params[0], user_id: params[1],
          branch_name: params[2], status: 'active', is_headless: true,
          headless_status: 'generating', headless_issue_number: params[3],
        }],
      };
    }
    if (/INSERT INTO chat_session_messages/i.test(s)) {
      state.messages.push({
        role: /'user'/.test(s) ? 'user' : (/'system'/.test(s) ? 'system' : 'assistant'),
        content: params[1],
      });
      return { rows: [{ id: state.nextId++ }] };
    }
    if (/UPDATE chat_sessions SET spec_md/i.test(s)) {
      state.specMd = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT spec_md FROM chat_sessions/i.test(s)) {
      return { rows: [{ spec_md: state.specMd }] };
    }
    if (/UPDATE chat_sessions SET headless_status = 'ready'/i.test(s)) {
      state.terminal = { status: 'ready', outcome: params[0] };
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE chat_sessions SET headless_status = 'failed'/i.test(s)) {
      state.terminal = { status: 'failed' };
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { query, state, calls };
}

async function startTestServer(loaded, user = { id: 1, username: 'alice' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(loaded.subject.sessionRoutes({ jwtSecret: 'test' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

async function startHeadlessRun(srv) {
  const res = await fetch(`${srv.baseUrl}/api/apps/my-app/issues/5/headless-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 201);
}

const USAGE = { input_tokens: 10, output_tokens: 5 };
// Phase-1 Mayor turn that dispatches a build directly.
const BUILD_CALL_TURN = {
  text: 'Straightforward fix — implementing now.',
  toolUses: [{ id: 'tu-build', name: 'dispatch_claude_code', input: { prompt: 'Build it.' } }],
  usage: USAGE,
  rawContent: [],
};
const SCOUT_CALL_TURN = {
  text: 'Investigating first.',
  toolUses: [{ id: 'tu-scout', name: 'dispatch_scout', input: { prompt: 'Look around.' } }],
  usage: USAGE,
  rawContent: [],
};
const WRAP_TURN = { text: 'Wrapped up.', toolUses: [], usage: USAGE, rawContent: [] };

function sequencedLlm(responses) {
  let i = 0;
  return {
    streamChat: async () => responses[Math.min(i++, responses.length - 1)],
  };
}

const MARKERLESS_FAILURE = {
  lastResultText: '', exitCode: -1, resultSeen: false, ahead: 0, behind: 0,
  sha: null, pushOk: false, rawStderr: '', markerlessCause: 'probe_unobservable',
};
const BUILD_SUCCESS = {
  lastResultText: 'Done — built the thing.', exitCode: 0, resultSeen: true,
  ahead: 1, behind: 0, sha: 'abc1234def5678', pushOk: true, rawStderr: '',
  sessionId: 'cc-1', markerlessCause: null,
};

// ── 1. Headless build retry: first attempt markerless, second succeeds ──

test('headless build: markerless first attempt re-dispatches once and succeeds', async () => {
  const execCalls = [];
  const stopCalls = [];
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([BUILD_CALL_TURN, WRAP_TURN]),
    worker: {
      execInWorker: async (sessionId, opts) => {
        execCalls.push(opts.mode);
        return execCalls.length === 1 ? { ...MARKERLESS_FAILURE } : { ...BUILD_SUCCESS };
      },
      stopTurn: async (sessionId) => { stopCalls.push(sessionId); },
      isWorkerExecuting: async () => false,
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    // Exactly one retry — two dispatches total, both builds.
    assert.deepEqual(execCalls, ['build', 'build']);
    // The retry killed the zombie turn before re-dispatching.
    assert.equal(stopCalls.length, 1);
    // The retry status line is in the persisted transcript.
    assert.ok(pool.state.messages.some(
      (m) => /The coding step failed unexpectedly — retrying once/.test(m.content || '')
    ));
    // The run finalized as a successful code run despite the first death.
    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'code' });
    // And no bare "-1" message ever surfaced.
    assert.ok(!pool.state.messages.some(
      (m) => /exited with code -1/.test(m.content || '')
    ));
  } finally {
    await srv.close();
    loaded.restore();
  }
});

// ── 2. Both attempts fail → cause-specific message, no third attempt ────

test('headless build: second identical failure surfaces the cause-specific message', async () => {
  const execCalls = [];
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([BUILD_CALL_TURN, WRAP_TURN]),
    worker: {
      execInWorker: async (sessionId, opts) => {
        execCalls.push(opts.mode);
        return { ...MARKERLESS_FAILURE, markerlessCause: 'oom_killed' };
      },
      stopTurn: async () => {},
      isWorkerExecuting: async () => false,
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    // One retry, never a third attempt.
    assert.deepEqual(execCalls, ['build', 'build']);
    // The failure message names the cause instead of a bare "-1".
    assert.ok(pool.state.messages.some(
      (m) => /The coding agent was killed — most likely it ran out of memory\. No changes were made\./.test(m.content || '')
    ));
    assert.ok(!pool.state.messages.some(
      (m) => /exited with code -1/.test(m.content || '')
    ));
    // A produced-nothing build run finalizes as 'question' (a human
    // picks it up), not 'code'.
    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'question' });
  } finally {
    await srv.close();
    loaded.restore();
  }
});

// ── 3. Headless scout retry ─────────────────────────────────────────────

const SPEC = '# Fix the thing\n\n## User-facing changes\n\nStuff.\n\n## Technical implementation\n\nDetails.';

test('headless scout: markerless first attempt re-dispatches once and stores the spec', async () => {
  const execCalls = [];
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([SCOUT_CALL_TURN, WRAP_TURN]),
    worker: {
      execInWorker: async (sessionId, opts) => {
        execCalls.push(opts.mode);
        return execCalls.length === 1
          ? { ...MARKERLESS_FAILURE }
          : { lastResultText: SPEC, exitCode: 0, resultSeen: true, sessionId: 'cc-1' };
      },
      stopTurn: async () => {},
      isWorkerExecuting: async () => false,
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    assert.deepEqual(execCalls, ['scout', 'scout']);
    assert.equal(pool.state.specMd, SPEC);
    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'spec' });
    assert.ok(pool.state.messages.some(
      (m) => /The coding step failed unexpectedly — retrying once/.test(m.content || '')
    ));
  } finally {
    await srv.close();
    loaded.restore();
  }
});

// ── 4. Unit coverage of the retry predicate + message mapping ───────────

test('shouldRetryHeadlessTurn: only markerless produced-nothing unstopped turns qualify', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const should = loaded.subject.shouldRetryHeadlessTurn;
    const dead = { exitCode: -1, resultSeen: false };
    assert.equal(should(dead, null, false), true);
    // Stopped turns are a deliberate end, not a failure to retry.
    assert.equal(should(dead, { stopped: true }, false), false);
    // A turn that produced output (commit / spec text) is not retried.
    assert.equal(should(dead, null, true), false);
    // A real exit code is a real answer — no retry.
    assert.equal(should({ exitCode: 2, resultSeen: false }, null, false), false);
    // A turn that reached __USERNODE_RESULT__ reported for itself.
    assert.equal(should({ exitCode: -1, resultSeen: true }, null, false), false);
    assert.equal(should(null, null, false), false);
  } finally {
    loaded.restore();
  }
});

test('describeMarkerlessExit maps every cause to plain terms', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const d = loaded.subject.describeMarkerlessExit;
    assert.match(d('oom_killed'), /ran out of memory/);
    assert.match(d('container_gone'), /worker container disappeared/);
    assert.match(d('probe_unobservable'), /lost contact/);
    assert.match(d('turn_process_gone'), /ended without reporting a result/);
    // Unknown/legacy causes still get a sentence, never "-1".
    assert.match(d(null), /without reporting a result/);
  } finally {
    loaded.restore();
  }
});

// ── #358: the "Claude Code finished" completion row is reserved for runs
// that actually changed code. A run that committed nothing emits an honest
// non-success status instead, so a no-op never reads as a completed build.

const BUILD_NOOP = {
  lastResultText: 'I reviewed the relevant files; nothing needed changing.',
  exitCode: 0, resultSeen: true, ahead: 0, behind: 0,
  sha: null, pushOk: false, rawStderr: '', sessionId: 'cc-1', markerlessCause: null,
};

test('headless build success persists the "Claude Code finished" completion row', async () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([BUILD_CALL_TURN, WRAP_TURN]),
    worker: {
      execInWorker: async () => ({ ...BUILD_SUCCESS }),
      stopTurn: async () => {},
      isWorkerExecuting: async () => false,
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    assert.ok(pool.state.messages.some((m) => m.content === 'Claude Code finished'));
    assert.ok(!pool.state.messages.some((m) => m.content === 'Claude Code made no changes'));
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('headless build that changes nothing emits an honest non-success status, never "finished"', async () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([BUILD_CALL_TURN, WRAP_TURN]),
    worker: {
      execInWorker: async () => ({ ...BUILD_NOOP }),
      stopTurn: async () => {},
      isWorkerExecuting: async () => false,
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    // The honest no-op status carries the agent's words; the green
    // "Claude Code finished" completion row is never written.
    assert.ok(pool.state.messages.some((m) => m.content === 'Claude Code made no changes'));
    assert.ok(!pool.state.messages.some((m) => m.content === 'Claude Code finished'));
  } finally {
    await srv.close();
    loaded.restore();
  }
});
