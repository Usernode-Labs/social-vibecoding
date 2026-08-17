// routes/report-snapshots.js — locked report snapshots + public share
// links. Properties locked in:
//
//   * Lock/share/unshare are canManageApp-gated (403 for a plain member);
//     list/read need only 'view' (404 on unknown app, the appAccess deny).
//   * The lock POST validates the payload is a standalone report document
//     and caps it at 2 MB; ai_json comes from the SERVER's own draft
//     cache, never from the request body.
//   * Snapshot HTML is only ever served with the sandbox CSP and
//     no-store — on the authed /html route AND the public /reports/:token
//     route — and a revoked/unknown/malformed token 404s.
//   * The share token is minted once (idempotent share) and unshare
//     nulls it.
//
// Harness: same as tests/report-ai.test.js — getPool overridden before
// requires, github/topic-attributes stubbed, ephemeral express app.
//
// Run with: node --test tests/report-snapshots.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}
stub(require.resolve('../src/services/github'), {
  fetchPublicIssues: async () => ({ issues: [], truncatedList: false }),
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

const express = require('express');
const { reportSnapshotRoutes, reportShareRoutes } = require('../src/routes/report-snapshots');

function dispatch(map) {
  queryHandler = async (sql) => {
    for (const [re, rows] of map) if (re.test(sql)) return { rows };
    return { rows: [] };
  };
}

// NOTE: reportSnapshotLimiter is per-user, 10/min, and its window
// persists across the tests in this file (module-level limiter state).
// The file currently issues ~8 gated POSTs; if you add more, reset
// `currentUser` to a fresh id for the new tests.
let currentUser = { id: 42, username: 'member', isAdmin: false };
function startServer() {
  const app = express();
  app.use(reportShareRoutes({}));
  // Mirror server.js's parser gate: the lock POST is skipped by the
  // global 100kb parser (the route owns a 3mb one) — without this skip
  // the oversized-payload test would 413 in the wrong layer.
  app.use((req, res, next) => {
    if (req.method === 'POST' && /^\/api\/apps\/[^/]+\/report-snapshots$/.test(req.path)) return next();
    express.json()(req, res, next);
  });
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(reportSnapshotRoutes({}));
  return new Promise((r) => { const s = app.listen(0, () => r(s)); });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

// created_by 1: currentUser 42 is a plain member; switching currentUser
// to id 1 makes canManageApp pass on the creator branch with no
// app_admins lookup (which the app-admins TTL cache would otherwise
// bleed across tests).
const appRow = {
  id: 7, slug: 'demo', name: 'Demo', created_by: 1, self_hosted: false,
  collab_visibility: 'open', view_visibility: 'public',
};
const SNAP = {
  id: 3, locked_at: '2026-08-11T10:00:00Z', share_token: null,
  locked_by_username: 'alice',
};
const DOC = '<!doctype html><html><head><title>r</title></head><body>report</body></html>';

test('GET list returns rows newest-first shape and canManage=false for a member', async () => {
  currentUser = { id: 42, username: 'member', isAdmin: false };
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/FROM app_report_snapshots/i, [
      { ...SNAP, id: 4, share_token: 'a'.repeat(32) },
      SNAP,
    ]],
  ]);
  const s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.canManage, false);
    assert.equal(body.snapshots.length, 2);
    assert.equal(body.snapshots[0].shared, true);
    assert.equal(body.snapshots[0].sharePath, `/reports/${'a'.repeat(32)}`);
    assert.equal(body.snapshots[1].shared, false);
    assert.equal(body.snapshots[1].sharePath, null);
    assert.equal(body.snapshots[1].lockedBy, 'alice');
    assert.equal(body.snapshots[1].htmlPath, '/api/apps/demo/report-snapshots/3/html');
    assert.equal(body.snapshots[1].html, undefined, 'list must not carry html');
  } finally { s.close(); }
});

test('POST lock 403s for a non-admin member', async () => {
  currentUser = { id: 42, username: 'member', isAdmin: false };
  dispatch([[/FROM apps WHERE slug/i, [appRow]]]);
  const s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: DOC }),
    });
    assert.equal(res.status, 403);
  } finally { s.close(); }
});

test('POST lock inserts with server-cached ai_json for the creator', async () => {
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/FROM app_report_ai/i, [{
      input_hash: 'h', narrative: 'n', highlights_json: ['h1'], risks_json: [],
      owners_json: [], model: 'claude-haiku-4-5', generated_by: 1,
      generated_at: '2026-08-10T00:00:00Z',
    }]],
    [/INSERT INTO app_report_snapshots/i, [{ id: 9, locked_at: '2026-08-11T12:00:00Z', share_token: null }]],
  ]);
  queries.length = 0;
  const s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: DOC, ai: { narrative: 'CLIENT SUPPLIED' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.snapshot.id, 9);
    assert.equal(body.snapshot.shared, false);
    const ins = queries.find((q) => /INSERT INTO app_report_snapshots/i.test(q.sql));
    assert.ok(ins, 'must insert');
    // params: [app_id, html, ai_json, locked_by] — ai_json from the
    // server cache, ignoring the client-posted `ai`.
    assert.equal(ins.params[0], 7);
    assert.equal(ins.params[1], DOC);
    assert.match(ins.params[2], /"narrative":"n"/);
    assert.ok(!/CLIENT SUPPLIED/.test(ins.params[2]));
    assert.equal(ins.params[3], 1);
  } finally { s.close(); }
});

test('POST lock rejects junk and oversized payloads', async () => {
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  dispatch([[/FROM apps WHERE slug/i, [appRow]], [/FROM app_report_ai/i, []]]);
  const s = await startServer();
  try {
    let res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<script>alert(1)</script>' }),
    });
    assert.equal(res.status, 400);
    res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: `<!doctype html>${'x'.repeat(2 * 1024 * 1024)}` }),
    });
    assert.equal(res.status, 400);
  } finally { s.close(); }
});

test('authed /html serves the doc with the sandbox CSP', async () => {
  currentUser = { id: 42, username: 'member', isAdmin: false };
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/SELECT html FROM app_report_snapshots/i, [{ html: DOC }]],
  ]);
  const s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots/3/html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.match(res.headers.get('content-security-policy'), /allow-popups-to-escape-sandbox/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), DOC);
  } finally { s.close(); }
});

test('share mints an idempotent token and unshare revokes; both are admin-gated', async () => {
  currentUser = { id: 42, username: 'member', isAdmin: false };
  dispatch([[/FROM apps WHERE slug/i, [appRow]]]);
  let s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots/3/share`, { method: 'POST' });
    assert.equal(res.status, 403);
  } finally { s.close(); }

  currentUser = { id: 1, username: 'creator', isAdmin: false };
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/UPDATE app_report_snapshots[\s\S]*COALESCE/i, [{ share_token: 'b'.repeat(32) }]],
  ]);
  s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots/3/share`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sharePath, `/reports/${'b'.repeat(32)}`);
    const upd = queries.find((q) => /COALESCE\(share_token/i.test(q.sql));
    assert.ok(upd, 'share must COALESCE the existing token (idempotent)');
  } finally { s.close(); }

  // Direct handler: unshare checks rowCount, which dispatch() doesn't carry.
  queryHandler = async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM apps WHERE slug/i.test(sql)) return { rows: [appRow] };
    if (/SET share_token = NULL/i.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  };
  s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots/3/unshare`, { method: 'POST' });
    assert.equal(res.status, 200);
  } finally { s.close(); }
});

test('public /reports/:token serves shared html and 404s malformed/unknown tokens', async () => {
  dispatch([[/WHERE share_token/i, [{ html: DOC }]]]);
  const s = await startServer();
  try {
    let res = await fetch(`${base(s)}/reports/${'c'.repeat(32)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.match(res.headers.get('content-security-policy'), /allow-popups-to-escape-sandbox/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), DOC);

    res = await fetch(`${base(s)}/reports/not-a-token`);
    assert.equal(res.status, 404);

    dispatch([[/WHERE share_token/i, []]]);
    res = await fetch(`${base(s)}/reports/${'d'.repeat(32)}`);
    assert.equal(res.status, 404);
  } finally { s.close(); }
});

test('list/lock 404 on unknown app', async () => {
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  dispatch([[/FROM apps WHERE slug/i, []]]);
  const s = await startServer();
  try {
    let res = await fetch(`${base(s)}/api/apps/nope/report-snapshots`);
    assert.equal(res.status, 404);
    res = await fetch(`${base(s)}/api/apps/nope/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: DOC }),
    });
    assert.equal(res.status, 404);
  } finally { s.close(); }
});

// ── Report period (reporting-period) ─────────────────────────────────

test('POST lock copies period_start into the frozen ai_json', async () => {
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/FROM app_report_ai/i, [{
      input_hash: 'h', narrative: 'n', highlights_json: [], risks_json: [],
      owners_json: [], model: 'claude-haiku-4-5', generated_by: 1,
      generated_at: '2026-08-10T00:00:00Z', period_start: '2026-06-12T00:00:00Z',
    }]],
    [/INSERT INTO app_report_snapshots/i, [{ id: 10, locked_at: '2026-08-11T12:00:00Z', share_token: null }]],
  ]);
  queries.length = 0;
  const s = await startServer();
  try {
    const res = await fetch(`${base(s)}/api/apps/demo/report-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: DOC }),
    });
    assert.equal(res.status, 200);
    const ins = queries.find((q) => /INSERT INTO app_report_snapshots/i.test(q.sql));
    assert.ok(ins, 'must insert');
    // The frozen ai_json says which period it was generated for, so a
    // locked "since June" report reads as exactly that.
    assert.match(ins.params[2], /"periodStart":"2026-06-12T00:00:00Z"/);
  } finally { s.close(); }
});

// The share route is only public because of WHERE it mounts: server.js
// wires reportShareRoutes before authMiddleware (the visuals.js pattern),
// and src/middleware/auth.js lists /reports/ in PUBLIC_PATHS as
// belt-and-braces should that order ever change. Neither guarantee is
// visible from this file's stub harness, so pin both in source — a
// reorder that put the share link behind auth would otherwise ship
// silently and turn every circulated report link into a login redirect.
test('share links stay public: pre-auth mount order and PUBLIC_PATHS entry', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const shareMount = serverSrc.indexOf('app.use(reportShareRoutes(');
  const authMount = serverSrc.indexOf('app.use(authMiddleware(');
  assert.ok(shareMount !== -1, 'server.js mounts reportShareRoutes');
  assert.ok(authMount !== -1, 'server.js mounts authMiddleware');
  assert.ok(shareMount < authMount,
    'reportShareRoutes must mount BEFORE authMiddleware — /reports/:token is a public share link');

  const authSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'auth.js'), 'utf8');
  const m = authSrc.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m, 'PUBLIC_PATHS array found');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(entries.includes('/reports/'),
    '/reports/ must stay in PUBLIC_PATHS (belt-and-braces for the share link)');
});
