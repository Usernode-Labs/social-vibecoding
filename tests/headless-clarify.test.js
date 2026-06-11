// Tests for the #150 clarifying-questions plumbing around headless
// auto-solve runs.
//
// Three layers:
//   1. Unit tests for buildHeadlessSeed — issue comments appended to the
//      seed, bot-authored comments tagged, per-comment truncation, the
//      most-recent-N cap, and the empty-comments fallback.
//   2. Route tests for POST /api/apps/:slug/issues/:number/headless-session
//      blocking: a ready run with outcome 'question' no longer 409s,
//      while 'generating' and ready 'spec'/'code' runs still do.
//   3. Integration tests for question-comment posting: a pure-text
//      phase-1 turn posts exactly one comment (questions + footer) after
//      the terminal status write; a throwing createIssueComment doesn't
//      change the run's terminal state; and the gate predicate excludes
//      the dispatch-error path (which also ends outcome='question').
//
// Like session-done-notifications.test.js, the pool is an in-memory mock
// that pattern-matches SQL, and the github/llm/ws/app-access/limits/events
// modules are stubbed via require.cache. No real Postgres / GitHub / LLM.
//
// Run with: node --test tests/headless-clarify.test.js

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

// Load ../src/routes/sessions fresh against a mock pool + stubbed
// services. `overrides.github` / `overrides.llm` / `overrides.worker`
// shadow the default stubs.
function loadSessions(mockPool, overrides = {}) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    llm: require.resolve('../src/services/llm'),
    worker: require.resolve('../src/services/worker'),
    appAccess: require.resolve('../src/services/app-access'),
    limits: require.resolve('../src/services/limits'),
    events: require.resolve('../src/services/events'),
    sessions: require.resolve('../src/routes/sessions'),
    notifications: require.resolve('../src/services/notifications'),
  };

  const githubStub = {
    isEnabled: () => true,
    fetchPublicIssue: async () => ({ issue: { number: 5, title: 'Make it better', body: 'please' } }),
    fetchIssueComments: async () => ({ comments: [] }),
    getBotUsername: async () => 'usernode-bot',
    createBranch: async () => {},
    createIssueComment: async () => {},
    safeMention: (s) => s,
    ...(overrides.github || {}),
  };
  const llmStub = {
    isEnabled: () => true,
    streamChat: async () => ({
      text: '1. Which screen? (default: home)',
      toolUses: [],
      usage: { input_tokens: 10, output_tokens: 5 },
      rawContent: [],
    }),
    estimateCostCents: () => 0,
    ...(overrides.llm || {}),
  };
  // The scout/build container plumbing. Default stubs satisfy
  // runScoutTool's call shape but are only reached by tests that make
  // the Mayor dispatch (the original suite never does).
  const workerStub = {
    ensureWorkerImage: async () => {},
    ensureWorker: async () => 'stub-worker',
    execInWorker: async () => ({ lastResultText: '' }),
    resumeTurnFromJournal: async () => ({}),
    clearActiveTurn: async () => {},
    stopTurn: async () => false,
    ...(overrides.worker || {}),
  };

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => mockPool })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: () => {},
      pushNotificationToUser: () => 0,
    })],
    [paths.github, stubModule(paths.github, githubStub)],
    [paths.llm, stubModule(paths.llm, llmStub)],
    [paths.worker, stubModule(paths.worker, workerStub)],
    // Keep the real module's other exports (sessionRoutes wires several
    // guards at setup time) — only the app lookup is faked.
    [paths.appAccess, stubModule(paths.appAccess, {
      ...require('../src/services/app-access'),
      getAppForUser: async () => ({
        id: 1, slug: 'my-app', name: 'My App',
        repo_url: 'https://github.com/owner/repo', self_hosted: false,
      }),
    })],
    [paths.limits, stubModule(paths.limits, {
      checkBudget: async () => ({}),
      recordSpend: async () => {},
    })],
    [paths.events, stubModule(paths.events, {
      record: () => {},
      EVENT_TYPES: { DEV_SESSION_STARTED: 'dev_session_started' },
    })],
  ];
  // Force fresh resolution against the stubs.
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
  return { subject, github: githubStub, restore };
}

// ── In-memory mock pool ─────────────────────────────────────────────────
// Answers the SQL shapes the headless route + runner issue and records
// every call so tests can assert on inserts/updates.
function makeMockPool(initial = {}) {
  const state = {
    // Existing headless sessions for the blocking query, as plain rows:
    // { id, headless_status, headless_outcome }.
    headlessRows: (initial.headlessRows || []).slice(),
    messages: [],      // chat_session_messages inserts: { role, content }
    terminal: null,    // { status, outcome } once the run finishes
    specMd: '',        // chat_sessions.spec_md written by the scout
    nextId: 1000,
  };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    // Blocking query — evaluate the SQL's own semantics over the rows so
    // the test proves the question-exclusion clause is really there.
    if (/SELECT id, headless_status FROM chat_sessions/i.test(s)
        && /headless_issue_number/i.test(s)) {
      let rows = state.headlessRows.filter(
        (r) => r.headless_status === 'generating' || r.headless_status === 'ready'
      );
      if (/NOT \(headless_status = 'ready' AND headless_outcome = 'question'\)/.test(s)) {
        rows = rows.filter(
          (r) => !(r.headless_status === 'ready' && r.headless_outcome === 'question')
        );
      }
      return { rows: rows.slice(0, 1) };
    }
    // Global session cap.
    if (/SELECT COUNT\(\*\) as cnt FROM chat_sessions/i.test(s)) {
      return { rows: [{ cnt: '0' }] };
    }
    // BYOK key lookup.
    if (/SELECT anthropic_key_enc FROM users/i.test(s)) {
      return { rows: [] };
    }
    // New headless session row.
    if (/INSERT INTO chat_sessions/i.test(s)) {
      const row = {
        id: state.nextId++, app_id: params[0], user_id: params[1],
        branch_name: params[2], status: 'active', is_headless: true,
        headless_status: 'generating', headless_issue_number: params[3],
      };
      return { rows: [row] };
    }
    // Transcript inserts (seed, statuses, assistant turns, progress rows).
    if (/INSERT INTO chat_session_messages/i.test(s)) {
      state.messages.push({ role: /'user'/.test(s) ? 'user' : (/'system'/.test(s) ? 'system' : 'assistant'), content: params[1] });
      return { rows: [{ id: state.nextId++ }] };
    }
    // Scout output → spec doc (runScoutTool), read back by loadSessionSpec.
    if (/UPDATE chat_sessions SET spec_md/i.test(s)) {
      state.specMd = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT spec_md FROM chat_sessions/i.test(s)) {
      return { rows: [{ spec_md: state.specMd }] };
    }
    // Terminal ready / failed writes.
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

// ── 1. Seed construction ────────────────────────────────────────────────

test('buildHeadlessSeed: no comments → title + body only', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const seed = loaded.subject.buildHeadlessSeed(
      5, { title: 'Fix the thing', body: 'It is broken.' }, [], 'usernode-bot'
    );
    assert.equal(seed, 'Please work on GitHub issue #5: "Fix the thing".\n\nIt is broken.');
    assert.ok(!seed.includes('ISSUE COMMENTS'));
  } finally {
    loaded.restore();
  }
});

test('buildHeadlessSeed: appends comments oldest-first and tags bot-authored ones', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const seed = loaded.subject.buildHeadlessSeed(5, { title: 'T', body: 'B' }, [
      { author: 'usernode-bot', body: '1. Which screen?', createdAt: '2026-06-01T00:00:00Z' },
      { author: 'reporter', body: 'The home screen.', createdAt: '2026-06-02T00:00:00Z' },
    ], 'usernode-bot');
    assert.ok(seed.includes('ISSUE COMMENTS (oldest first):'));
    assert.ok(seed.includes('[bot — earlier auto-solve questions, 2026-06-01] 1. Which screen?'));
    assert.ok(seed.includes('[reporter, 2026-06-02] The home screen.'));
    // Bot questions come before the reporter's answer (oldest first).
    assert.ok(seed.indexOf('Which screen?') < seed.indexOf('The home screen.'));
  } finally {
    loaded.restore();
  }
});

test('buildHeadlessSeed: tolerates the GitHub `[bot]` actor suffix', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const seed = loaded.subject.buildHeadlessSeed(5, { title: 'T', body: '' }, [
      { author: 'usernode-bot[bot]', body: 'Q?', createdAt: '2026-06-01T00:00:00Z' },
    ], 'usernode-bot');
    assert.ok(seed.includes('[bot — earlier auto-solve questions, 2026-06-01] Q?'));
  } finally {
    loaded.restore();
  }
});

test('buildHeadlessSeed: truncates long comments and caps to the most recent 20', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const comments = [];
    for (let i = 1; i <= 25; i++) {
      comments.push({ author: `user${i}`, body: `comment ${i}`, createdAt: '2026-06-01T00:00:00Z' });
    }
    comments[24].body = 'x'.repeat(3000);
    const seed = loaded.subject.buildHeadlessSeed(5, { title: 'T', body: '' }, comments, null);

    // Only the most recent 20 survive, with the omission marker first.
    assert.ok(seed.includes('[earlier comments omitted]'));
    assert.ok(!seed.includes('comment 5'));
    assert.ok(seed.includes('comment 6'));
    assert.ok(seed.includes('comment 24'));
    // Per-comment truncation at ~2000 chars.
    assert.ok(seed.includes('x'.repeat(2000) + '… [truncated]'));
    assert.ok(!seed.includes('x'.repeat(2001)));
  } finally {
    loaded.restore();
  }
});

// ── 2. Route blocking ───────────────────────────────────────────────────

test('POST headless-session: ready + question outcome does NOT block a re-run', async () => {
  const pool = makeMockPool({
    headlessRows: [{ id: 10, headless_status: 'ready', headless_outcome: 'question' }],
  });
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/apps/my-app/issues/5/headless-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 201);
    // The fire-and-forget runner reaches a terminal state (we don't care
    // which here) — just let it settle so restore() is safe.
    await waitFor(() => pool.state.terminal !== null);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('POST headless-session: generating and ready spec/code outcomes still 409', async () => {
  for (const row of [
    { id: 10, headless_status: 'generating', headless_outcome: null },
    { id: 11, headless_status: 'ready', headless_outcome: 'spec' },
    { id: 12, headless_status: 'ready', headless_outcome: 'code' },
  ]) {
    const pool = makeMockPool({ headlessRows: [row] });
    const loaded = loadSessions(pool);
    const srv = await startTestServer(loaded);
    try {
      const res = await fetch(`${srv.baseUrl}/api/apps/my-app/issues/5/headless-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 409, `expected 409 for ${row.headless_status}/${row.headless_outcome}`);
      assert.equal(pool.state.terminal, null);
    } finally {
      await srv.close();
      loaded.restore();
    }
  }
});

// ── 3. Question-comment posting ─────────────────────────────────────────

test('pure-text phase-1 turn posts the questions to the issue exactly once', async () => {
  const commentCalls = [];
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    github: {
      fetchIssueComments: async () => ({
        comments: [
          { author: 'usernode-bot', body: 'Old question?', createdAt: '2026-06-01T00:00:00Z' },
          { author: 'reporter', body: 'An answer.', createdAt: '2026-06-02T00:00:00Z' },
        ],
      }),
      createIssueComment: async (owner, repo, issueNumber, body) => {
        commentCalls.push({ owner, repo, issueNumber, body });
      },
    },
  });
  const srv = await startTestServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/apps/my-app/issues/5/headless-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 201);

    await waitFor(() => pool.state.terminal !== null);
    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'question' });

    // Exactly one comment: the Mayor's questions plus the re-run footer.
    assert.equal(commentCalls.length, 1);
    assert.equal(commentCalls[0].owner, 'owner');
    assert.equal(commentCalls[0].repo, 'repo');
    assert.equal(commentCalls[0].issueNumber, 5);
    assert.ok(commentCalls[0].body.startsWith('1. Which screen? (default: home)'));
    assert.ok(commentCalls[0].body.includes('press **Auto-solve** on the issue again'));

    // The transcript shows the post happened…
    assert.ok(pool.state.messages.some(
      (m) => m.role === 'system' && /Posted clarifying questions to issue #5/.test(m.content || '')
    ));
    // …and the seed the run saw carries the comments, bot-tagged.
    const seedMsg = pool.state.messages.find((m) => m.role === 'user');
    assert.ok(seedMsg, 'seed user message persisted');
    assert.ok(seedMsg.content.includes('ISSUE COMMENTS (oldest first):'));
    assert.ok(seedMsg.content.includes('[bot — earlier auto-solve questions, 2026-06-01] Old question?'));
    assert.ok(seedMsg.content.includes('[reporter, 2026-06-02] An answer.'));
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('a throwing createIssueComment does not change the run terminal state', async () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    github: {
      createIssueComment: async () => { throw new Error('github down'); },
    },
  });
  const srv = await startTestServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/apps/my-app/issues/5/headless-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 201);

    await waitFor(() => pool.state.terminal !== null);
    // Still ready/question — the failed post is swallowed.
    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'question' });
    // And no "posted" status was written.
    assert.ok(!pool.state.messages.some(
      (m) => /Posted clarifying questions/.test(m.content || '')
    ));
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('shouldPostHeadlessQuestionComment: only pure-text question outcomes qualify', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const gate = loaded.subject.shouldPostHeadlessQuestionComment;
    // Pure-text phase-1 questions → post.
    assert.equal(gate({ outcome: 'question', dispatchedTool: null, mayorText: 'Q?' }), true);
    // Dispatch-error path: outcome is 'question' but a tool WAS dispatched
    // — the text is an error summary, not questions. No post.
    assert.equal(gate({ outcome: 'question', dispatchedTool: { id: 't1' }, mayorText: 'Q?' }), false);
    // Non-question outcomes and empty text never post.
    assert.equal(gate({ outcome: 'spec', dispatchedTool: null, mayorText: 'Q?' }), false);
    assert.equal(gate({ outcome: 'question', dispatchedTool: null, mayorText: '   ' }), false);
  } finally {
    loaded.restore();
  }
});

// ── 4. specHasBlockingQuestions (#178) ──────────────────────────────────

test('specHasBlockingQuestions: matches Questions/Open questions ATX headings only', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const has = loaded.subject.specHasBlockingQuestions;
    assert.equal(has('# Goal\n\n## Questions\n\n1. Soft or hard delete?'), true);
    assert.equal(has('## Goal\n\n### Open questions\n\n1. Which screen?'), true);
    assert.equal(has('#### QUESTIONS'), true);
    assert.equal(has('# Open Question\n\n1. One blocker.'), true);
    // Prose mentions and non-heading lines don't count.
    assert.equal(has('Questions arise when reading this code.'), false);
    assert.equal(has('# Goal\n\nNo open items.'), false);
    assert.equal(has(''), false);
    assert.equal(has(null), false);
    // Chosen semantics: the regex keys on the heading PREFIX, so a heading
    // like "Questions we answered" still matches (a safe false positive —
    // it only downgrades a buildable spec to a questions round-trip).
    assert.equal(has('## Questions we answered'), true);
  } finally {
    loaded.restore();
  }
});

// ── 5. Decision-turn question routing (#178) ────────────────────────────
// Drive the full route → runner → scout-dispatch → decision-turn path with
// a sequenced llm stub and a worker stub whose execInWorker returns the
// "spec" the scout supposedly wrote.

const SPEC_WITH_QUESTIONS = '# Fix the thing\n\n## Plan\n\nDo it.\n\n## Questions\n\n1. Soft or hard delete? (default: soft)';
const SPEC_WITHOUT_QUESTIONS = '# Fix the thing\n\n## Plan\n\nDo it.\n\n## Considerations\n\nNone blocking.';

// llm.streamChat stub that replays `responses` in order (repeating the
// last one if called again).
function sequencedLlm(responses) {
  let i = 0;
  return {
    streamChat: async () => responses[Math.min(i++, responses.length - 1)],
  };
}

const USAGE = { input_tokens: 10, output_tokens: 5 };
const SCOUT_CALL_TURN = {
  text: 'The issue is ambiguous but repo-answerable — investigating first.',
  toolUses: [{ id: 'tu-scout', name: 'dispatch_scout', input: { prompt: 'Resolve: which delete semantics exist today.' } }],
  usage: USAGE,
  rawContent: [],
};

async function startHeadlessRun(srv) {
  const res = await fetch(`${srv.baseUrl}/api/apps/my-app/issues/5/headless-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 201);
}

test('scout leaves Questions in the spec → decision text posted, outcome question', async () => {
  const commentCalls = [];
  const execCalls = [];
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([
      SCOUT_CALL_TURN,
      // Decision turn: text-only reporter-facing questions.
      { text: '1. Soft or hard delete? (default: soft)', toolUses: [], usage: USAGE, rawContent: [] },
    ]),
    worker: {
      execInWorker: async (sessionId, opts) => {
        execCalls.push(opts.mode);
        return { lastResultText: SPEC_WITH_QUESTIONS, sessionId: 'cc-1' };
      },
    },
    github: {
      createIssueComment: async (owner, repo, issueNumber, body) => {
        commentCalls.push({ issueNumber, body });
      },
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => commentCalls.length > 0);

    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'question' });
    assert.deepEqual(execCalls, ['scout']);
    assert.equal(pool.state.specMd, SPEC_WITH_QUESTIONS);
    // Exactly one comment: the decision-turn questions plus the footer.
    assert.equal(commentCalls.length, 1);
    assert.equal(commentCalls[0].issueNumber, 5);
    assert.ok(commentCalls[0].body.startsWith('1. Soft or hard delete? (default: soft)'));
    assert.ok(commentCalls[0].body.includes('press **Auto-solve** on the issue again'));
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('build dispatched over an open Questions section is rejected; phase-3 text posted', async () => {
  const commentCalls = [];
  const execCalls = [];
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([
      SCOUT_CALL_TURN,
      // Decision turn violates the prompt and dispatches a build anyway.
      {
        text: 'Looks simple, implementing now.',
        toolUses: [{ id: 'tu-build', name: 'dispatch_claude_code', input: { prompt: 'Build it.' } }],
        usage: USAGE,
        rawContent: [],
      },
      // Phase-3 wrap-up after the hard-rail rejection: the questions.
      { text: '1. Soft or hard delete? (default: soft)', toolUses: [], usage: USAGE, rawContent: [] },
    ]),
    worker: {
      execInWorker: async (sessionId, opts) => {
        execCalls.push(opts.mode);
        return { lastResultText: SPEC_WITH_QUESTIONS, sessionId: 'cc-1' };
      },
    },
    github: {
      createIssueComment: async (owner, repo, issueNumber, body) => {
        commentCalls.push({ issueNumber, body });
      },
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => commentCalls.length > 0);

    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'question' });
    // The build never ran — only the scout reached the worker.
    assert.deepEqual(execCalls, ['scout']);
    assert.equal(commentCalls.length, 1);
    assert.ok(commentCalls[0].body.startsWith('1. Soft or hard delete? (default: soft)'));
    assert.ok(commentCalls[0].body.includes('press **Auto-solve** on the issue again'));
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('scout resolves everything (no Questions section) → outcome spec, no comment', async () => {
  const commentCalls = [];
  const pool = makeMockPool();
  const loaded = loadSessions(pool, {
    llm: sequencedLlm([
      SCOUT_CALL_TURN,
      // Decision turn declines to build; plain wrap-up text.
      { text: 'Spec drafted — a human should review before building.', toolUses: [], usage: USAGE, rawContent: [] },
    ]),
    worker: {
      execInWorker: async () => ({ lastResultText: SPEC_WITHOUT_QUESTIONS, sessionId: 'cc-1' }),
    },
    github: {
      createIssueComment: async (owner, repo, issueNumber, body) => {
        commentCalls.push({ issueNumber, body });
      },
    },
  });
  const srv = await startTestServer(loaded);
  try {
    await startHeadlessRun(srv);
    await waitFor(() => pool.state.terminal !== null);

    assert.deepEqual(pool.state.terminal, { status: 'ready', outcome: 'spec' });
    assert.equal(pool.state.specMd, SPEC_WITHOUT_QUESTIONS);
    // Settle briefly: the (absent) comment post would happen right after
    // the terminal write.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(commentCalls.length, 0);
    assert.ok(!pool.state.messages.some(
      (m) => /Posted clarifying questions/.test(m.content || '')
    ));
  } finally {
    await srv.close();
    loaded.restore();
  }
});
