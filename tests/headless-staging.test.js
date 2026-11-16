// Tests for #183's propose-from-clone flow, which creates the PR lazily, and
// the guard that keeps a headless auto-solve row (no longer created, still in
// the table) from being promoted.
//
// /promote: headless rows are rejected outright by the route; a clone is
// handed to the proposal machine (src/workflow/platform.ts promoteProposal)
// and the route answers with what it reports. The lazy PR creation on the
// clone's own branch is the machine's review.open work
// (src/workflow/proposal/services.ts), tested here directly: it opens the PR
// (and the answer carries the PR info), a failed creation refuses the promote
// with the code the route answers 502 for, and an existing PR is not
// re-created. The preview of the reviewed head is the machine's message to
// the preview machine, sent once the proposal is in review
// (tests/workflow-proposal-postgres).
//
// The pool is an in-memory mock that pattern-matches SQL and services are
// stubbed via require.cache. No real Postgres / GitHub / LLM / Docker.
//
// Run with: node --test tests/headless-staging.test.js

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

// Error classes sessions.js checks with `instanceof` when describing a
// staging failure — the stub must export real constructors.
class PrivateSecretMissingStagingDefaultError extends Error {}
class MissingSecretsError extends Error {}

// ── /promote: headless guard + lazy PR creation ─────────────────────────

function loadVotes(mockPool, overrides = {}) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    prMetadata: require.resolve('../src/services/pr-metadata'),
    votes: require.resolve('../src/routes/votes'),
    previewWorkflow: require.resolve('../src/services/preview-workflow'),
    platform: require.resolve('../src/workflow/platform.ts'),
  };

  // The proposal machine: what the route asks it, and what it answers.
  const promoteCalls = [];
  const platformStub = {
    async promoteProposal(args) {
      promoteCalls.push(args);
      return overrides.promote ? overrides.promote(args) : { status: 200, body: { ok: true, prNumber: null, prUrl: null, prTitle: null } };
    },
  };

  const stagingStub = {
    PrivateSecretMissingStagingDefaultError,
    MissingSecretsError,
    verifyStagingEdge: async () => {},
    ...(overrides.staging || {}),
  };
  const previewCalls = [];
  const previewWorkflowStub = {
    revision: async ({ session, head, source, trigger }) => {
      previewCalls.push({ sessionId: session.id, head, source, trigger });
    },
  };
  const prMetadataStub = {
    applyPrMetadata: async () => null,
    ...(overrides.prMetadata || {}),
  };

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => mockPool })],
    [paths.ws, stubModule(paths.ws, {
      sendSystemMessage: async () => {},
      pushNotificationToUser: () => 0,
      pushSessionUpdate: () => {},
      pushVoteUpdate: () => {},
      broadcastGlobal: () => {},
    })],
    [paths.github, stubModule(paths.github, {
      isEnabled: () => false,
      safeMention: (s) => s,
      ...(overrides.github || {}),
    })],
    [paths.staging, stubModule(paths.staging, stagingStub)],
    [paths.previewWorkflow, stubModule(paths.previewWorkflow, previewWorkflowStub)],
    [paths.docker, stubModule(paths.docker, {})],
    [paths.conflictResolver, stubModule(paths.conflictResolver, {
      checkAndResolveConflicts: async () => ({}),
      resolveAndMaybeRetry: async () => ({}),
    })],
    [paths.activeUsers, stubModule(paths.activeUsers, {
      getActiveUserStats: async () => ({ activeUsers: 1, majority: 1 }),
      isUserActive: () => true,
    })],
    [paths.notifications, stubModule(paths.notifications, {
      createPrProposedNotifications: async () => [],
      serialize: (x) => x,
      markReadForAction: async () => 0,
    })],
    [paths.adminApproval, stubModule(paths.adminApproval, {
      isAppLocked: async () => false,
      hasAdminYesVote: async () => false,
    })],
    [paths.events, stubModule(paths.events, {
      record: () => {},
      EVENT_TYPES: { PR_PROMOTED: 'pr_promoted' },
    })],
    [paths.appAccess, stubModule(paths.appAccess, {
      sessionCollabGuard: () => (_req, _res, next) => next(),
    })],
    [paths.prMetadata, stubModule(paths.prMetadata, prMetadataStub)],
    [paths.platform, stubModule(paths.platform, platformStub)],
  ];
  delete require.cache[paths.votes];

  const subject = require('../src/routes/votes');

  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.votes];
  };
  return { subject, previewCalls, promoteCalls, restore };
}

// Mock pool for /promote: holds one session row and answers the route's
// queries against it — evaluating the is_headless clause for real.
function makePromotePool(sessionRow) {
  const state = { promoted: false };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    if (/FROM chat_sessions cs JOIN apps a/i.test(s) && /status IN \('active', 'paused'\)/i.test(s)) {
      let ok = ['active', 'paused'].includes(sessionRow.status) && sessionRow.user_id === params[1];
      if (/is_headless = FALSE/i.test(s) && sessionRow.is_headless) ok = false;
      return { rows: ok ? [{ ...sessionRow }] : [] };
    }
    if (/SELECT COUNT\(\*\) AS cnt FROM chat_sessions/i.test(s)) {
      return { rows: [{ cnt: '0' }] };
    }
    if (/SELECT content FROM chat_session_messages/i.test(s)) {
      return { rows: [{ content: 'please ship the bot change' }] };
    }
    if (/UPDATE chat_sessions[\s\S]*SET status = 'promoted'/i.test(s)) {
      state.promoted = true;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  return { query, state, calls };
}

async function startVotesServer(loaded, user = { id: 1, username: 'alice' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(loaded.subject.voteRoutes({ jwtSecret: 'test' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const CLONE_ROW = {
  id: 99, app_id: 1, user_id: 1, status: 'active', is_headless: false,
  branch_name: 'dev/alice-1700000000000',
  app_slug: 'my-app', app_name: 'My App',
  repo_url: 'https://github.com/owner/repo',
  pr_number: null, pr_url: null, pr_title: null,
  staging_url: null, staging_container_id: null,
};

test('POST /promote rejects headless sessions with 404', async () => {
  const pool = makePromotePool({ ...CLONE_ROW, is_headless: true });
  const loaded = loadVotes(pool);
  const srv = await startVotesServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/99/promote`, { method: 'POST' });
    assert.equal(res.status, 404);
    assert.equal(pool.state.promoted, false);
    assert.equal(loaded.promoteCalls.length, 0, 'the machine is never asked');
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('POST /promote on a PR-less clone hands it to the proposal machine and answers with the PR it opened', async () => {
  const prCalls = [];
  const pool = makePromotePool({ ...CLONE_ROW });
  const loaded = loadVotes(pool, {
    prMetadata: { applyPrMetadata: async (args) => { prCalls.push(args); return null; } },
    promote: async () => ({
      status: 200,
      body: { ok: true, prNumber: 77, prUrl: 'https://github.com/owner/repo/pull/77', prTitle: 'Ship the bot change' },
    }),
  });
  const srv = await startVotesServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/99/promote`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, prNumber: 77, prUrl: 'https://github.com/owner/repo/pull/77', prTitle: 'Ship the bot change' });

    // One ask, from the status the route read, by the proposing user. With
    // GitHub off there is no pull request to read first.
    assert.equal(loaded.promoteCalls.length, 1);
    const asked = loaded.promoteCalls[0];
    assert.deepEqual(
      { sessionId: asked.sessionId, appId: asked.appId, userId: asked.userId, username: asked.username, from: asked.from, pr: asked.pr },
      { sessionId: 99, appId: 1, userId: 1, username: 'alice', from: 'active', pr: null },
    );
    // Opening the PR, the status move and the preview are the machine's.
    assert.equal(prCalls.length, 0, 'the route opens no pull request itself');
    assert.equal(pool.state.promoted, false, 'the route writes no status');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(loaded.previewCalls, [], 'and kicks no preview after answering');
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('POST /promote answers the machine\'s refusal as it reports it', async () => {
  const pool = makePromotePool({ ...CLONE_ROW });
  const loaded = loadVotes(pool, {
    promote: async () => ({ status: 502, body: { error: 'Could not create the pull request for this change.' } }),
  });
  const srv = await startVotesServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/99/promote`, { method: 'POST' });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Could not create the pull request/);
    assert.equal(loaded.previewCalls.length, 0);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

// ── review.open: the lazy PR creation, now the proposal machine's work ──

const { proposalServices } = require('../src/workflow/proposal/services.ts');
const { WORK: PROPOSAL_WORK } = require('../src/workflow/proposal/machine.ts');

// Runs review.open for `row` with the legacy modules it reaches (through
// src/workflow/legacy.ts, the shared require cache) stubbed: GitHub off, no
// model key, no explicit-approval read, and `applyPrMetadata` as given.
async function reviewOpen(row, applyPrMetadata) {
  const ids = {
    github: require.resolve('../src/services/github'),
    prMetadata: require.resolve('../src/services/pr-metadata'),
    limits: require.resolve('../src/services/limits'),
    appAdmins: require.resolve('../src/services/app-admins'),
  };
  const originals = [
    [ids.github, stubModule(ids.github, { isEnabled: () => false })],
    [ids.prMetadata, stubModule(ids.prMetadata, { applyPrMetadata })],
    [ids.limits, stubModule(ids.limits, { resolveBillingPath: async () => ({ error: 'no key in tests' }) })],
    [ids.appAdmins, stubModule(ids.appAdmins, { refreshExplicitApproval: async () => {} })],
  ];
  const pool = {
    async query(sql) {
      const q = String(sql);
      if (/FROM chat_sessions cs JOIN apps a/i.test(q)) return { rows: [{ ...row }] };
      if (/SELECT content FROM chat_session_messages/i.test(q)) return { rows: [{ content: 'please ship the bot change' }] };
      if (/SELECT username FROM users WHERE id = \$1/i.test(q)) return { rows: [{ username: 'alice' }] };
      return { rows: [], rowCount: 0 };
    },
  };
  try {
    const handler = proposalServices({ config: {}, pool })[PROPOSAL_WORK.open];
    try {
      return { result: await handler.run({ input: { sessionId: row.id, n: 1, userId: 1, expectedHead: null, imported: false } }), error: null };
    } catch (error) {
      return { result: null, error };
    }
  } finally {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
  }
}

test('review.open on a PR-less clone creates the PR lazily on the clone branch and reports it', async () => {
  const prCalls = [];
  const { result, error } = await reviewOpen({ ...CLONE_ROW }, async ({ session, userMessage, username, userId }) => {
    prCalls.push({ branch: session.branch_name, userMessage, username, userId });
    session.pr_number = 77;
    session.pr_url = 'https://github.com/owner/repo/pull/77';
    session.pr_title = 'Ship the bot change';
    return { prNumber: 77, prUrl: session.pr_url, prTitle: session.pr_title };
  });
  assert.equal(error, null);
  assert.deepEqual(result, {
    head: null, prNumber: 77, prUrl: 'https://github.com/owner/repo/pull/77', prTitle: 'Ship the bot change', issueLinkSeeded: false,
  });
  // The PR was created on the CLONE's branch, attributed + debited to the
  // proposing user, with the latest user message as context.
  assert.equal(prCalls.length, 1);
  assert.equal(prCalls[0].branch, 'dev/alice-1700000000000');
  assert.equal(prCalls[0].username, 'alice');
  assert.equal(prCalls[0].userId, 1);
  assert.equal(prCalls[0].userMessage, 'please ship the bot change');
});

test('review.open refuses the promote (502 at the route) when lazy PR creation fails', async () => {
  const { result, error } = await reviewOpen({ ...CLONE_ROW }, async () => null);
  assert.equal(result, null);
  assert.equal(error.code, 'pr_create_failed');
  assert.equal(error.permanent, true, 'a refusal, not a retry: the proposal goes back to Underway');
  // The route answers that code 502 (src/workflow/platform.ts promoteAnswer).
  const platformSrc = require('node:fs').readFileSync(require.resolve('../src/workflow/platform.ts'), 'utf8');
  assert.match(platformSrc, /\['pr_create_failed', 502\]/);
});

test('review.open with an existing PR does not re-create it', async () => {
  const prCalls = [];
  const { result, error } = await reviewOpen({
    ...CLONE_ROW,
    pr_number: 12, pr_url: 'https://github.com/owner/repo/pull/12', pr_title: 'Existing',
    staging_url: 'https://already.example', staging_container_id: 'c1',
  }, async (args) => { prCalls.push(args); return null; });
  assert.equal(error, null);
  assert.equal(result.prNumber, 12);
  assert.equal(prCalls.length, 0, 'no lazy PR creation when a PR exists');
});
