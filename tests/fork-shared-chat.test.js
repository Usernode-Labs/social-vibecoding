// Route tests for POST /api/sessions/:id/fork (src/routes/sessions.js) —
// forking someone else's SHARED dev chat into your own new session.
//
// Three things these tests exist to hold still:
//   1. The source predicate. A fork is only allowed off a session that is
//      both visible AND transcript-published, and never off your own.
//   2. The caps. A fork is an ordinary dev session, so it must consume a
//      slot under the same per-user / global ceilings as any other.
//   3. The CC-volume asymmetry. Unlike clone-headless, a fork must NOT copy
//      the source's Claude Code memory volume — that would hand the fork's
//      agent everything the transcript sanitiser withholds from the reader.
//      This is the one difference between the two routes, so it gets a test
//      rather than only a comment.
//
// Same harness shape as tests/shared-sessions.test.js.
//
// Run with: node --test tests/fork-shared-chat.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql, params });
    return poolQueryHandler(sql, params);
  },
});

const worker = require('../src/services/worker');
const github = require('../src/services/github');
const events = require('../src/services/events');

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const FORKER = { id: 7, username: 'forker' };
const OWNER_ID = 99;

const APP_ROW = {
  id: 42, slug: 'demo', created_by: 7, self_hosted: false,
  collab_visibility: 'public', view_visibility: 'public',
};

// config passed to sessionRoutes: generous caps unless a test overrides.
const CONFIG = {
  maxUserSessions: 3, maxGlobalSessions: 25, maxAdminUserSessions: 5,
  maxUserPromotedSessions: 3, maxAdminUserPromotedSessions: 5,
  sessionPressureGraceMs: 1000,
};

function startServer(config = CONFIG) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = FORKER; next(); });
  app.use(sessionRoutes(config));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function post(server, path) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' });
  return { res, body: await res.json() };
}

function srcRow(overrides = {}) {
  return {
    id: 5, app_id: 42, user_id: OWNER_ID, branch_name: 'dev/them-1',
    session_title: 'Their shared session', pr_title: null,
    status: 'paused', spec_md: '# Their spec', linked_issues: [11],
    testing_md: null, testing_path: null, testing_paths: null,
    cc_session_id: 'cc-abc-123',
    shared_at: '2026-07-01T00:00:00Z',
    transcript_shared_at: '2026-07-01T00:05:00Z',
    is_headless: false,
    app_slug: 'demo', app_name: 'Demo', repo_url: 'https://github.com/o/r',
    owner_username: 'them',
    ...overrides,
  };
}

// `src: null` models the source predicate not matching (not shared, only
// half-shared, headless, or missing) — all of it lives in the WHERE clause.
function makeDispatcher({
  src = srcRow(), userActiveCount = 0, globalCount = 0,
  srcMessages = [], insertedSession = { id: 77, app_id: 42, user_id: FORKER.id },
} = {}) {
  return async (sql) => {
    if (/FROM apps WHERE slug = \$1/.test(sql)) return { rows: [APP_ROW] };
    if (/FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id/.test(sql)
        && /collab_visibility/.test(sql)) {
      return { rows: [APP_ROW] }; // sessionCollabGuard resolve
    }
    if (/owner_username/.test(sql) && /transcript_shared_at IS NOT NULL/.test(sql)) {
      return { rows: src ? [src] : [] };
    }
    if (/COUNT\(\*\) as cnt/.test(sql) && /user_id = \$1/.test(sql)) {
      return { rows: [{ cnt: String(userActiveCount) }] };
    }
    if (/COUNT\(\*\) as cnt/.test(sql) && /status IN \('active', 'promoted'\)/.test(sql)) {
      return { rows: [{ cnt: String(globalCount) }] };
    }
    if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [insertedSession] };
    if (/SELECT id, role, content, model, metadata FROM chat_session_messages/.test(sql)) {
      return { rows: srcMessages };
    }
    return { rows: [] };
  };
}

// github.createBranch / events.record are stubbed per test so nothing tries
// to reach the network or a real events table.
function withStubs(fn, { cloneCcVolume } = {}) {
  const realCreateBranch = github.createBranch;
  const realIsEnabled = github.isEnabled;
  const realRecord = events.record;
  const realClone = worker.cloneCcVolume;
  const branchCalls = [];
  let cloneCalled = 0;
  github.isEnabled = () => true;
  github.createBranch = async (...args) => { branchCalls.push(args); };
  events.record = () => {};
  worker.cloneCcVolume = async (...args) => {
    cloneCalled++;
    if (cloneCcVolume) return cloneCcVolume(...args);
    return undefined;
  };
  return Promise.resolve(fn({ branchCalls, cloneCount: () => cloneCalled }))
    .finally(() => {
      github.createBranch = realCreateBranch;
      github.isEnabled = realIsEnabled;
      events.record = realRecord;
      worker.cloneCcVolume = realClone;
    });
}

test('the source predicate requires visible AND transcript-published, non-headless', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher();
  const server = await startServer();
  await withStubs(async () => {
    await post(server, '/api/sessions/5/fork');
    const q = capturedQueries.find((c) => /owner_username/.test(c.sql));
    assert.ok(q, 'source lookup was issued');
    assert.match(q.sql, /cs\.shared_at IS NOT NULL/);
    assert.match(q.sql, /cs\.transcript_shared_at IS NOT NULL/);
    assert.match(q.sql, /cs\.is_headless = FALSE/);
  });
  server.close();
});

test('404 when the source chat is not shared for reading', async () => {
  poolQueryHandler = makeDispatcher({ src: null });
  const server = await startServer();
  await withStubs(async () => {
    const { res, body } = await post(server, '/api/sessions/5/fork');
    assert.strictEqual(res.status, 404);
    assert.match(body.error, /not shared/i);
  });
  server.close();
});

test('400 when forking your OWN chat (that is what "Start a new change" is for)', async () => {
  poolQueryHandler = makeDispatcher({ src: srcRow({ user_id: FORKER.id }) });
  const server = await startServer();
  await withStubs(async () => {
    const { res, body } = await post(server, '/api/sessions/5/fork');
    assert.strictEqual(res.status, 400);
    assert.match(body.error, /your own chat/i);
  });
  server.close();
});

test('429 when the forker is at their per-user active-session cap', async () => {
  poolQueryHandler = makeDispatcher({ userActiveCount: 3 });
  const server = await startServer();
  await withStubs(async () => {
    const { res, body } = await post(server, '/api/sessions/5/fork');
    assert.strictEqual(res.status, 429);
    assert.match(body.error, /Pause or archive one first/);
  });
  server.close();
});

test('429 when the platform is at the global session cap and no slot frees', async () => {
  poolQueryHandler = makeDispatcher({ globalCount: 25 });
  const sessionLifecycle = require('../src/services/session-lifecycle');
  const realFree = sessionLifecycle.freeGlobalSlot;
  sessionLifecycle.freeGlobalSlot = async () => ({ freed: false });
  const server = await startServer();
  try {
    await withStubs(async () => {
      const { res, body } = await post(server, '/api/sessions/5/fork');
      assert.strictEqual(res.status, 429);
      assert.match(body.error, /at capacity/i);
    });
  } finally {
    sessionLifecycle.freeGlobalSlot = realFree;
    server.close();
  }
});

test('creates the fork: own branch off theirs, cloned_from_session_id set', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher();
  const server = await startServer();
  await withStubs(async ({ branchCalls }) => {
    const { res, body } = await post(server, '/api/sessions/5/fork');
    assert.strictEqual(res.status, 201);
    assert.strictEqual(body.session.id, 77);

    // Branch forked OFF the source branch so pushed commits carry over.
    assert.strictEqual(branchCalls.length, 1);
    const [owner, repo, newBranch, from] = branchCalls[0];
    assert.strictEqual(owner, 'o');
    assert.strictEqual(repo, 'r');
    assert.match(newBranch, /^dev\/forker-\d+$/);
    assert.strictEqual(from, 'dev/them-1');

    const ins = capturedQueries.find((c) => /INSERT INTO chat_sessions/.test(c.sql));
    assert.ok(ins, 'session insert was issued');
    assert.match(ins.sql, /cloned_from_session_id/);
    // Owned by the FORKER, seeded with the source's spec + issue links.
    assert.strictEqual(ins.params[1], FORKER.id);
    assert.strictEqual(ins.params[3], '# Their spec');
    assert.deepStrictEqual(ins.params[4], [11]);
    // cloned_from_session_id = the source id.
    assert.strictEqual(ins.params[8], 5);
  });
  server.close();
});

test('copied messages are SANITISED and stamped inheritedFrom, with zero cost', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({
    srcMessages: [
      {
        id: 1, role: 'user', content: 'Fix the cards', model: null,
        metadata: {
          attachments: [{ id: 'a'.repeat(32), filename: 'shot.png', kind: 'image', sizeBytes: 9 }],
          suggestions: ['leaked chip'],
        },
      },
      {
        id: 2, role: 'system', content: 'Claude Code log', model: null,
        metadata: { ccLog: 'SECRET stderr' },
      },
      {
        id: 3, role: 'assistant', content: 'Done.', model: 'claude-opus-5',
        metadata: { ccOutput: 'Split the card in two rows.' },
      },
    ],
  });
  const server = await startServer();
  await withStubs(async () => {
    const { res } = await post(server, '/api/sessions/5/fork');
    assert.strictEqual(res.status, 201);

    const msgInserts = capturedQueries.filter(
      (c) => /INSERT INTO chat_session_messages/.test(c.sql) && /VALUES \(\$1, \$2, \$3, \$4, \$5\)/.test(c.sql)
    );
    assert.strictEqual(msgInserts.length, 3, 'one insert per source message');

    // Every copied row carries inheritedFrom (drives the collapsed
    // agent-block + greyed-history rendering) …
    for (const ins of msgInserts) {
      const meta = JSON.parse(ins.params[4]);
      assert.strictEqual(meta.inheritedFrom, 5);
    }
    // … and none carries what the sanitiser withholds. This is the
    // load-bearing assertion: an INSERT…SELECT copy would smuggle these
    // across even though the READ path strips them.
    const allMeta = msgInserts.map((i) => i.params[4]).join('|');
    assert.ok(!allMeta.includes('SECRET stderr'), 'ccLog not copied');
    assert.ok(!allMeta.includes('a'.repeat(32)), 'attachment id not copied');
    assert.ok(!allMeta.includes('leaked chip'), 'suggestions not copied');
    assert.ok(allMeta.includes('Split the card in two rows.'), 'agent summary IS copied');

    // Costs are not written at all — they default to 0, so the forker isn't
    // charged for work they didn't pay for and figures aren't double-counted.
    for (const ins of msgInserts) {
      assert.doesNotMatch(ins.sql, /cost_cents/);
      assert.doesNotMatch(ins.sql, /token_count/);
    }
  });
  server.close();
});

test('does NOT clone the source Claude Code volume', async () => {
  // The deliberate asymmetry with clone-headless. Cloning the volume would
  // give the fork's agent the raw logs and attachment bytes the sanitiser
  // just stripped from the transcript.
  poolQueryHandler = makeDispatcher();
  const server = await startServer();
  await withStubs(async ({ cloneCount }) => {
    const { res } = await post(server, '/api/sessions/5/fork');
    assert.strictEqual(res.status, 201);
    assert.strictEqual(cloneCount(), 0, 'worker.cloneCcVolume must not be called');
  });
  server.close();
});

test('does not carry the source cc_session_id onto the fork', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher();
  const server = await startServer();
  await withStubs(async () => {
    await post(server, '/api/sessions/5/fork');
    // No UPDATE pinning the fork to the source's CC session — a fork starts
    // with fresh agent memory, matching the skipped volume clone.
    const pin = capturedQueries.find(
      (c) => /UPDATE chat_sessions SET cc_session_id/.test(c.sql)
    );
    assert.strictEqual(pin, undefined);
    const ins = capturedQueries.find((c) => /INSERT INTO chat_sessions/.test(c.sql));
    assert.doesNotMatch(ins.sql, /cc_session_id/);
  });
  server.close();
});

test('appends exactly one follow-up assistant message, without inheritedFrom', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({
    srcMessages: [{ id: 1, role: 'user', content: 'hi', model: null, metadata: {} }],
  });
  const server = await startServer();
  await withStubs(async () => {
    await post(server, '/api/sessions/5/fork');
    const followUps = capturedQueries.filter(
      (c) => /INSERT INTO chat_session_messages/.test(c.sql) && /'assistant'/.test(c.sql)
    );
    assert.strictEqual(followUps.length, 1, 'exactly one follow-up');
    const [, content, metaJson] = followUps[0].params;
    // Names the owner, and states the memory caveat that stops the new owner
    // assuming the agent remembers the original run.
    assert.match(content, /them/);
    assert.match(content, /own branch/);
    assert.match(content, /not the coding agent's own memory/);
    const meta = JSON.parse(metaJson);
    assert.ok(!('inheritedFrom' in meta), 'the follow-up belongs to THIS session');
    assert.ok(Array.isArray(meta.quickReplies) && meta.quickReplies.length,
      'next-step pills are populated from the first screen');
  });
  server.close();
});

test('copies the spec version history', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher();
  const server = await startServer();
  await withStubs(async () => {
    await post(server, '/api/sessions/5/fork');
    const specCopy = capturedQueries.find((c) => /INSERT INTO chat_session_specs/.test(c.sql));
    assert.ok(specCopy, 'spec history copy was issued');
    assert.deepStrictEqual(specCopy.params, [77, 5]);
  });
  server.close();
});

test('falls back to a main-rooted branch when the source branch is gone', async () => {
  poolQueryHandler = makeDispatcher();
  const server = await startServer();
  const realCreate = github.createBranch;
  const realEnabled = github.isEnabled;
  const realRecord = events.record;
  const calls = [];
  github.isEnabled = () => true;
  events.record = () => {};
  github.createBranch = async (...args) => {
    calls.push(args);
    if (args[3]) throw new Error('no such branch'); // fork-off attempt fails
  };
  try {
    const { res } = await post(server, '/api/sessions/5/fork');
    assert.strictEqual(res.status, 201, 'a pruned source branch must not fail the fork');
    assert.strictEqual(calls.length, 2, 'retried without a base branch');
    assert.strictEqual(calls[1][3], undefined);
  } finally {
    github.createBranch = realCreate;
    github.isEnabled = realEnabled;
    events.record = realRecord;
    server.close();
  }
});
