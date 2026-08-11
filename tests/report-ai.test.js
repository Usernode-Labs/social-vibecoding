// services/report-ai.js + routes/report-ai.js — the server half of the
// Reporting tab's AI layer. The properties locked in here:
//
//   * The LLM input is built from SHARED-VISIBILITY data only: the
//     sessions query must carry `shared_at IS NOT NULL` (the cache is
//     one row per app, read by every viewer).
//   * The fingerprint is canonical (key-order independent) so an
//     unchanged app short-circuits to the cache with NO LLM call.
//   * A fresh generation upserts the cache row and debits the clicking
//     user (llm_usage upsert via limits.recordSpend).
//   * Routes: 404 on unknown app (the appAccess convention), staleness
//     flag on GET, no inputHash/generatedBy leakage in responses.
//
// Harness: same shape as tests/app-contributors-route.test.js — getPool
// overridden BEFORE the service/route requires, heavy services stubbed
// via require.cache, LLM stubbed via llm._setClientForTests.
//
// Run with: node --test tests/report-ai.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Stub the GitHub issues cache and the attribute summarizer: unit tests
// must not load the real fetch/cache machinery.
let publicIssues = { issues: [], truncatedList: false };
stub(require.resolve('../src/services/github'), {
  fetchPublicIssues: async () => publicIssues,
});
stub(require.resolve('../src/services/topic-attributes'), {
  summarizeForTargets: async () => new Map(),
});

const poolMod = require('../src/db/pool');
let queryHandler = async () => ({ rows: [] });
const queries = [];
poolMod.getPool = () => ({
  query: (sql, params) => { queries.push({ sql, params }); return queryHandler(sql, params); },
});
const pool = poolMod.getPool();

const llm = require('../src/services/llm');
const reportAi = require('../src/services/report-ai');

const APP = { id: 7, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/acme/demo' };

function dispatch(map) {
  queryHandler = async (sql) => {
    for (const [re, rows] of map) if (re.test(sql)) return { rows };
    return { rows: [] };
  };
}

// ── service half ─────────────────────────────────────────────────────

test('buildReportInput excludes private sessions by construction', async () => {
  dispatch([[/shared_at IS NOT NULL/i, [{ session_title: 'S', username: 'alice', created_at: '2026-08-01T00:00:00Z' }]]]);
  queries.length = 0;
  const { input, knownUsernames } = await reportAi.buildReportInput(pool, APP);
  const sessionSql = queries.map((q) => q.sql).find((s) => /chat_sessions/.test(s) && /shared_at/.test(s));
  assert.ok(sessionSql, 'sessions query must filter on shared_at');
  assert.match(sessionSql, /shared_at IS NOT NULL/);
  assert.match(sessionSql, /is_headless = FALSE/);
  assert.equal(input.sessions.length, 1);
  assert.equal(input.sessions[0].by, 'alice');
  assert.ok(knownUsernames.includes('alice'));
});

test('fingerprint is stable across key order', () => {
  const a = reportAi.fingerprint({ b: 1, a: [{ y: 2, x: 1 }] });
  const b = reportAi.fingerprint({ a: [{ x: 1, y: 2 }], b: 1 });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, reportAi.fingerprint({ b: 2, a: [{ y: 2, x: 1 }] }));
});

test('buildReportInput caps, clips and day-granularizes', async () => {
  publicIssues = {
    issues: Array.from({ length: 200 }, (_, i) => ({
      number: i + 1, title: 't'.repeat(300), updatedAt: '2026-08-01T05:06:07Z', user: 'alice',
    })),
    truncatedList: false,
  };
  dispatch([]);
  const { input } = await reportAi.buildReportInput(pool, APP);
  assert.equal(input.issues.length, 150);
  assert.ok(input.issues[0].title.length <= 140);
  assert.equal(input.issues[0].updated, '2026-08-01');
  assert.equal(input.truncated.issues, true);
  publicIssues = { issues: [], truncatedList: false };
});

test('generateForApp short-circuits on matching fingerprint (no LLM call)', async () => {
  dispatch([]);
  const { input } = await reportAi.buildReportInput(pool, APP);
  const hash = reportAi.fingerprint(input);
  dispatch([[/FROM app_report_ai/i, [{
    input_hash: hash, narrative: 'cached', risks_json: [], owners_json: [],
    model: 'claude-haiku-4-5', generated_by: 1, generated_at: '2026-08-10T00:00:00Z',
  }]]]);
  let llmCalled = false;
  const prev = llm._setClientForTests({
    messages: { create: async () => { llmCalled = true; throw new Error('no'); } },
  });
  try {
    const out = await reportAi.generateForApp({ pool, config: { dataEncryptionKey: 'k' }, app: APP, userId: 1 });
    assert.equal(out.cached, true);
    assert.equal(out.summary.narrative, 'cached');
    assert.equal(llmCalled, false);
  } finally { llm._setClientForTests(prev); }
});

const INSERTED_ROW = {
  input_hash: 'h', narrative: 'Fresh.', risks_json: [], owners_json: [],
  model: 'claude-haiku-4-5', generated_by: 42, generated_at: '2026-08-11T00:00:00Z',
};

test('generateForApp calls LLM, upserts, and debits on fresh data', async () => {
  dispatch([
    [/INSERT INTO app_report_ai/i, [INSERTED_ROW]],
    [/FROM app_report_ai/i, []],
  ]);
  const prev = llm._setClientForTests({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ narrative: 'Fresh.', risks: [], owners: [] }) }],
        usage: { input_tokens: 500, output_tokens: 100 },
      }),
    },
  });
  try {
    queries.length = 0;
    const out = await reportAi.generateForApp({ pool, config: { dataEncryptionKey: 'k' }, app: APP, userId: 42 });
    assert.equal(out.cached, false);
    assert.equal(out.summary.narrative, 'Fresh.');
    assert.ok(queries.some((q) => /INSERT INTO app_report_ai/i.test(q.sql)), 'must upsert cache row');
    assert.ok(queries.some((q) => /llm_usage/i.test(q.sql) && /INSERT/i.test(q.sql)), 'must record spend');
  } finally { llm._setClientForTests(prev); }
});

test('generateForApp maps a missing client to llm_unavailable', async () => {
  dispatch([[/FROM app_report_ai/i, []]]);
  const prev = llm._setClientForTests(null);
  try {
    await assert.rejects(
      reportAi.generateForApp({ pool, config: { dataEncryptionKey: 'k' }, app: APP, userId: 1 }),
      (err) => err.code === 'llm_unavailable'
    );
  } finally { llm._setClientForTests(prev); }
});

// ── route half ───────────────────────────────────────────────────────

const express = require('express');
const { reportAiRoutes } = require('../src/routes/report-ai');

let currentUser = { id: 42, username: 'alice', isAdmin: false };
function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(reportAiRoutes({ dataEncryptionKey: 'k' }));
  return new Promise((r) => { const s = app.listen(0, () => r(s)); });
}
const appRow = {
  id: 7, slug: 'demo', name: 'Demo', created_by: 1, self_hosted: false,
  collab_visibility: 'open', view_visibility: 'public',
  repo_url: 'https://github.com/acme/demo',
};

test('GET report-ai returns null summary and stale=false when never generated', async () => {
  dispatch([[/FROM apps WHERE slug/i, [appRow]], [/FROM app_report_ai/i, []]]);
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/report-ai`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.summary, null);
    assert.equal(body.stale, false);
  } finally { server.close(); }
});

test('GET report-ai flags staleness and hides internals', async () => {
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/FROM app_report_ai/i, [{
      input_hash: 'not-the-current-hash', narrative: 'old', risks_json: [{ title: 'r', detail: 'd', severity: 'low' }],
      owners_json: [], model: 'claude-haiku-4-5', generated_by: 1, generated_at: '2026-08-01T00:00:00Z',
    }]],
  ]);
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/report-ai`);
    const body = await res.json();
    assert.equal(body.summary.narrative, 'old');
    assert.equal(body.summary.risks.length, 1);
    assert.equal(body.stale, true);
    assert.equal(body.summary.inputHash, undefined);
    assert.equal(body.summary.generatedBy, undefined);
  } finally { server.close(); }
});

test('GET report-ai 404s on unknown app', async () => {
  dispatch([[/FROM apps WHERE slug/i, []]]);
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/nope/report-ai`);
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('POST generate returns the fresh summary', async () => {
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/INSERT INTO app_report_ai/i, [INSERTED_ROW]],
    [/FROM app_report_ai/i, []],
  ]);
  const prev = llm._setClientForTests({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ narrative: 'New.', risks: [], owners: [] }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  });
  const server = await startServer();
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/report-ai/generate`,
      { method: 'POST' }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.summary.narrative, 'Fresh.');
    assert.equal(body.cached, false);
  } finally { server.close(); llm._setClientForTests(prev); }
});

test('POST generate maps llm_unavailable to 503', async () => {
  dispatch([[/FROM apps WHERE slug/i, [appRow]], [/FROM app_report_ai/i, []]]);
  const prev = llm._setClientForTests(null);
  const server = await startServer();
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/report-ai/generate`,
      { method: 'POST' }
    );
    assert.equal(res.status, 503);
  } finally { server.close(); llm._setClientForTests(prev); }
});
