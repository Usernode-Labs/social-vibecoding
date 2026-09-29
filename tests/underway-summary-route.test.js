// #3344: an author can rewrite a native proposal's plain-language summary
// while it is Underway or In review, with the same owner-only, native-only
// contract the title route above it has.

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let candidate = null;
let updateQuery = null;
let lockCalls = 0;
poolMod.getPool = () => ({
  query: async (sql, params) => {
    const text = String(sql);
    if (/SELECT a\.id, a\.collab_visibility/.test(text)) {
      return { rows: [{ id: 1, collab_visibility: 'public', view_visibility: 'public' }] };
    }
    if (/UPDATE chat_sessions cs/.test(text) && /pr_summary_md/.test(text)) {
      updateQuery = { sql: text, params };
      const allowed = candidate
        && candidate.user_id === params[2]
        && ['active', 'paused', 'promoted', 'merging'].includes(candidate.status)
        && candidate.is_headless === false
        && candidate.source !== 'imported';
      return { rows: allowed ? [{ id: candidate.id, app_id: 1, app_slug: 'demo' }] : [] };
    }
    return { rows: [] };
  },
});

const proposalUpdate = require('../src/services/proposal-update');
const github = require('../src/services/github');
const ws = require('../src/services/ws');
const originalWithProposalLock = proposalUpdate.withProposalLock;
const originalUpdatePR = github.updatePR;
const originalPushSessionUpdate = ws.pushSessionUpdate;
let lockOrder = [];
let githubCalls = [];
let pushes = [];
proposalUpdate.withProposalLock = async (poolArg, sessionId, fn) => {
  lockCalls += 1;
  lockOrder.push('lock:start');
  const result = await fn();
  lockOrder.push('lock:end');
  return result;
};
github.updatePR = async (...args) => { githubCalls.push(args); };
ws.pushSessionUpdate = (payload) => pushes.push(payload);

after(() => {
  proposalUpdate.withProposalLock = originalWithProposalLock;
  github.updatePR = originalUpdatePR;
  ws.pushSessionUpdate = originalPushSessionUpdate;
});

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');
const OWNER = { id: 7, username: 'builder' };

beforeEach(() => {
  candidate = {
    id: 42,
    user_id: OWNER.id,
    status: 'active',
    is_headless: false,
    source: 'cli_handoff',
    pr_number: null,
  };
  updateQuery = null;
  lockCalls = 0;
  lockOrder = [];
  githubCalls = [];
  pushes = [];
});

function startServer(user = OWNER) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function saveSummary(server, summary, id = 42) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${id}/summary`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ summary }),
  });
  return { res, body: await res.json() };
}

test('saves the owner summary with author freshness inside the proposal lock', async () => {
  const server = await startServer();
  try {
    const { res, body } = await saveSummary(server, '  Previews\r\nwait for sign-in.  ');
    assert.equal(res.status, 200);
    assert.deepEqual(body, {
      ok: true,
      proposalId: 42,
      summary: 'Previews\nwait for sign-in.',
      source: 'author',
      stale: false,
    });
    assert.deepEqual(updateQuery.params, ['Previews\nwait for sign-in.', 42, OWNER.id]);
    assert.match(updateQuery.sql, /pr_summary_md = \$1::text/);
    assert.match(updateQuery.sql, /pr_summary_source = 'author'/);
    assert.match(updateQuery.sql, /pr_summary_stale = FALSE/);
    assert.match(updateQuery.sql, /pr_summary_input_version = pr_summary_input_version \+ 1/);
    assert.match(updateQuery.sql, /pr_summary_previous_md = COALESCE\(cs\.pr_summary_md, cs\.pr_summary_previous_md\)/);
    assert.match(updateQuery.sql, /pr_summary_source_head_sha = NULL/);
    assert.match(updateQuery.sql, /pr_summary_source_body_hash = NULL/);
    assert.match(updateQuery.sql, /cs\.user_id = \$3/);
    assert.match(updateQuery.sql, /status IN \('active', 'paused', 'promoted', 'merging'\)/);
    assert.match(updateQuery.sql, /is_headless = FALSE/);
    assert.match(updateQuery.sql, /source IS DISTINCT FROM 'imported'/);
    assert.equal(lockCalls, 1);
    assert.deepEqual(lockOrder, ['lock:start', 'lock:end']);
    assert.deepEqual(githubCalls, [], 'the summary edit must not touch GitHub');
    assert.deepEqual(pushes, [{
      action: 'summary', sessionId: 42, appId: 1,
      appSlug: 'demo', summary: 'Previews\nwait for sign-in.',
    }]);
  } finally {
    server.close();
  }
});

test('keeps the same edit contract while a proposal is in review', async () => {
  candidate.pr_number = 91;
  const server = await startServer();
  try {
    for (const status of ['promoted', 'merging']) {
      candidate.status = status;
      const { res, body } = await saveSummary(server, `Summary while ${status}`);
      assert.equal(res.status, 200, status);
      assert.equal(body.summary, `Summary while ${status}`);
    }
    assert.equal(pushes.length, 2);
    assert.deepEqual(githubCalls, []);
  } finally {
    server.close();
  }
});

test('foreign, imported, headless and completed rows all stay non-enumerable', async () => {
  const variants = [
    { user_id: 99 },
    { source: 'imported' },
    { is_headless: true },
    { status: 'merged' },
    { status: 'archived' },
  ];
  const server = await startServer();
  try {
    for (const patch of variants) {
      candidate = { ...candidate, user_id: OWNER.id, source: 'cli_handoff', is_headless: false, status: 'active', ...patch };
      const { res, body } = await saveSummary(server, 'Nope');
      assert.equal(res.status, 404, JSON.stringify(patch));
      assert.equal(body.error, 'Session not found');
    }
    assert.equal(updateQuery && updateQuery.params[0], 'Nope');
    assert.deepEqual(pushes, []);
    assert.deepEqual(githubCalls, []);
  } finally {
    server.close();
  }
});

test('rejects missing, empty and overlong summaries before touching the session', async () => {
  const server = await startServer();
  try {
    for (const summary of [undefined, '', ' \r\n ', 'x'.repeat(601)]) {
      updateQuery = null;
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/42/summary`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: summary === undefined ? '{}' : JSON.stringify({ summary }),
      });
      await res.json();
      assert.equal(res.status, 400, JSON.stringify(summary));
      assert.equal(updateQuery, null);
    }
    assert.equal(lockCalls, 0);
  } finally {
    server.close();
  }
});

test('a malformed or missing id is a 404, not a 400', async () => {
  const server = await startServer();
  try {
    for (const id of ['abc', '0', '-3']) {
      const { res, body } = await saveSummary(server, 'Nope', id);
      assert.equal(res.status, 404, id);
      assert.equal(body.error, 'Session not found');
    }
    assert.equal(lockCalls, 0);
  } finally {
    server.close();
  }
});
