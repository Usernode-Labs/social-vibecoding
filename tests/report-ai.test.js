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

test('buildReportInput feeds the newest locked snapshot as previousReport', async () => {
  dispatch([[/FROM app_report_snapshots/i, [{
    ai_json: { narrative: 'last time', highlights: ['did x', ''], risks: [], owners: [] },
    locked_at: '2026-08-05T10:00:00Z',
  }]]]);
  const { input } = await reportAi.buildReportInput(pool, APP);
  assert.ok(input.previousReport, 'previousReport must be present');
  assert.equal(input.previousReport.lockedAt, '2026-08-05');
  assert.equal(input.previousReport.narrative, 'last time');
  assert.deepEqual(input.previousReport.highlights, ['did x']);
  const snapSql = queries.map((q) => q.sql).find((s) => /app_report_snapshots/.test(s));
  assert.match(snapSql, /ai_json IS NOT NULL/);
});

test('buildReportInput sets previousReport null with no snapshots, and it changes the fingerprint', async () => {
  dispatch([]);
  const { input: bare } = await reportAi.buildReportInput(pool, APP);
  assert.equal(bare.previousReport, null);
  dispatch([[/FROM app_report_snapshots/i, [{
    ai_json: { narrative: 'last time', highlights: [], risks: [], owners: [] },
    locked_at: '2026-08-05T10:00:00Z',
  }]]]);
  const { input: withPrev } = await reportAi.buildReportInput(pool, APP);
  assert.notEqual(reportAi.fingerprint(bare), reportAi.fingerprint(withPrev));
});

test('generateForApp persists and returns highlights', async () => {
  dispatch([
    [/INSERT INTO app_report_ai/i, [{ ...INSERTED_ROW, highlights_json: ['h1'] }]],
    [/FROM app_report_ai/i, []],
  ]);
  const prev = llm._setClientForTests({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ narrative: 'Fresh.', highlights: ['h1'], risks: [], owners: [] }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  });
  try {
    queries.length = 0;
    const out = await reportAi.generateForApp({ pool, config: { dataEncryptionKey: 'k' }, app: APP, userId: 42 });
    assert.deepEqual(out.summary.highlights, ['h1']);
    const ins = queries.find((q) => /INSERT INTO app_report_ai/i.test(q.sql));
    assert.match(ins.sql, /highlights_json/);
  } finally { llm._setClientForTests(prev); }
});

test('GET report-ai serves highlights', async () => {
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/FROM app_report_ai/i, [{
      input_hash: 'h', narrative: 'n', highlights_json: ['point one'],
      risks_json: [], owners_json: [], model: 'claude-haiku-4-5',
      generated_by: 1, generated_at: '2026-08-01T00:00:00Z',
    }]],
  ]);
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/report-ai`);
    const body = await res.json();
    assert.deepEqual(body.summary.highlights, ['point one']);
  } finally { server.close(); }
});

// ── Report period (reporting-period) ─────────────────────────────────

test('buildReportInput with since scopes merged work and the previousReport baseline', async () => {
  dispatch([[/FROM app_report_snapshots/i, [{
    ai_json: { narrative: 'the june report', highlights: [], risks: [], owners: [] },
    locked_at: '2026-06-12T10:00:00Z',
  }]]]);
  queries.length = 0;
  const { input } = await reportAi.buildReportInput(pool, APP, { since: '2026-06-12T10:00:00Z' });
  const mergedSql = queries.find((q) => /cs\.status = 'merged'/.test(q.sql));
  assert.ok(mergedSql, 'must query merged sessions');
  assert.match(mergedSql.sql, /cs\.created_at >= \$2/);
  assert.deepEqual(Array.from(mergedSql.params), [7, '2026-06-12T10:00:00Z']);
  // Inclusive baseline: selecting a previous report feeds THAT report.
  const snapSql = queries.find((q) => /app_report_snapshots/.test(q.sql));
  assert.match(snapSql.sql, /locked_at <= \$2/);
  assert.equal(input.previousReport.narrative, 'the june report');
  // Day-granular, like every other date in the input.
  assert.equal(input.periodStart, '2026-06-12');
});

test('buildReportInput without since keeps the unscoped shape (no periodStart key)', async () => {
  dispatch([]);
  queries.length = 0;
  const { input } = await reportAi.buildReportInput(pool, APP);
  assert.ok(!('periodStart' in input), 'unscoped inputs must hash exactly as before');
  const mergedSql = queries.find((q) => /cs\.status = 'merged'/.test(q.sql));
  assert.ok(!/created_at >= \$2/.test(mergedSql.sql));
  const snapSql = queries.find((q) => /app_report_snapshots/.test(q.sql));
  assert.ok(!/locked_at <= \$2/.test(snapSql.sql));
});

test('periodStart changes the fingerprint, but sub-day noise does not', async () => {
  dispatch([]);
  const { input: bare } = await reportAi.buildReportInput(pool, APP);
  const { input: scoped } = await reportAi.buildReportInput(pool, APP, { since: '2026-06-12T00:00:00Z' });
  const { input: scopedLater } = await reportAi.buildReportInput(pool, APP, { since: '2026-06-12T09:30:00Z' });
  assert.notEqual(reportAi.fingerprint(bare), reportAi.fingerprint(scoped));
  assert.equal(reportAi.fingerprint(scoped), reportAi.fingerprint(scopedLater));
});

test('generateForApp persists period_start and returns it via shapeRow', async () => {
  const SINCE = '2026-06-12T00:00:00.000Z';
  dispatch([
    [/INSERT INTO app_report_ai/i, [{ ...INSERTED_ROW, period_start: SINCE }]],
    [/FROM app_report_ai/i, []],
  ]);
  const prev = llm._setClientForTests({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ narrative: 'Fresh.', risks: [], owners: [] }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  });
  try {
    queries.length = 0;
    const out = await reportAi.generateForApp({
      pool, config: { dataEncryptionKey: 'k' }, app: APP, userId: 42, since: SINCE,
    });
    assert.equal(out.summary.periodStart, SINCE);
    const ins = queries.find((q) => /INSERT INTO app_report_ai/i.test(q.sql));
    assert.match(ins.sql, /period_start/);
    assert.ok(ins.params.includes(SINCE), 'the period start must be bound into the upsert');
  } finally { llm._setClientForTests(prev); }
});

test('GET report-ai serves periodStart and validates ?since', async () => {
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/FROM app_report_ai/i, [{
      input_hash: 'h', narrative: 'n', highlights_json: [], risks_json: [],
      owners_json: [], model: 'claude-haiku-4-5', generated_by: 1,
      generated_at: '2026-08-01T00:00:00Z', period_start: '2026-06-12T00:00:00Z',
    }]],
  ]);
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetch(`${base}/api/apps/demo/report-ai?since=2026-06-12T00:00:00Z`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.summary.periodStart, '2026-06-12T00:00:00Z');
    // Garbage and future dates are rejected, never silently coerced.
    assert.equal((await fetch(`${base}/api/apps/demo/report-ai?since=not-a-date`)).status, 400);
    const future = new Date(Date.now() + 7 * 86400000).toISOString();
    assert.equal((await fetch(`${base}/api/apps/demo/report-ai?since=${encodeURIComponent(future)}`)).status, 400);
  } finally { server.close(); }
});

test('POST generate validates body.since', async () => {
  dispatch([[/FROM apps WHERE slug/i, [appRow]], [/FROM app_report_ai/i, []]]);
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const bad = await fetch(`${base}/api/apps/demo/report-ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: 'garbage' }),
    });
    assert.equal(bad.status, 400);
    const future = new Date(Date.now() + 86400000).toISOString();
    const bad2 = await fetch(`${base}/api/apps/demo/report-ai/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since: future }),
    });
    assert.equal(bad2.status, 400);
  } finally { server.close(); }
});
