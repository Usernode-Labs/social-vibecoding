const test = require('node:test');
const assert = require('node:assert/strict');
const poolMod = require('../src/db/pool');
let session;
let privateApp = false;
let queries;
poolMod.getPool = () => ({ query: async (sql) => {
  queries.push(sql);
  if (sql.includes('SELECT a.id, a.collab_visibility')) return { rows: [{ id: 1,
    view_visibility: privateApp ? 'private' : 'public', collab_visibility: 'public' }] };
  if (sql.includes('FROM chat_sessions cs')) return { rows: session ? [session] : [] };
  return { rows: [] };
} });
const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

async function get(user, endpoint = 'checks') {
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(sessionRoutes({}));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/123/${endpoint}`);
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

function reset(patch = {}) {
  queries = []; privateApp = false;
  session = { id: 123, user_id: 42, status: 'active', shared_at: null,
    check_state: 'failing', test_results: [{ name: 'Settings', status: 'fail', failureReason: 'Missing button' }], ...patch };
}

test('owner reads full failed results without exposing transcript or selecting the full session', async () => {
  reset();
  const result = await get({ id: 42 });
  assert.equal(result.status, 200);
  assert.equal(result.body.session.user_id, 42);
  assert.equal(result.body.session.test_results[0].failureReason, 'Missing button');
  assert.equal(result.cache, 'no-store');
  const detail = queries.find((sql) => sql.includes('cs.test_results'));
  assert.ok(detail);
  assert.doesNotMatch(detail, /cs\.\*|messages|cc_session|api_key/);
});

test('a private underway session is hidden from another app collaborator', async () => {
  reset();
  assert.equal((await get({ id: 99 })).status, 404);
});

test('shared active/paused sessions and published proposals expose checks to app viewers', async () => {
  for (const status of ['active', 'paused', 'promoted', 'merging', 'merged']) {
    reset({ status, shared_at: ['active', 'paused'].includes(status) ? '2026-09-08' : null });
    assert.equal((await get({ id: 99 })).status, 200, status);
  }
});

test('archiving removes shared check access, while owners and read admins can still inspect', async () => {
  reset({ status: 'archived', shared_at: '2026-09-08' });
  assert.equal((await get({ id: 99 })).status, 404);
  assert.equal((await get({ id: 42 })).status, 200);
  assert.equal((await get({ id: 99, isAdmin: true, canAdminWrite: false })).status, 200);
});

test('shared results still require access to their app', async () => {
  reset({ shared_at: '2026-09-08' }); privateApp = true;
  assert.equal((await get({ id: 99 })).status, 404);
  assert.ok(!queries.some((sql) => sql.includes('cs.test_results')));
});

test('missing sessions return 404', async () => {
  reset(); session = null;
  assert.equal((await get({ id: 42 })).status, 404);
});


test('change details use the same privacy gate and an explicit public projection', async () => {
  reset();
  assert.equal((await get({ id: 99 }, 'details')).status, 404);
  assert.ok(!queries.some((sql) => sql.includes('cs.pr_summary_md')));
  reset({ shared_at: '2026-09-11', app_id: 1, linked_issues: [], pr_summary_md: 'Preview authentication fix' });
  const result = await get({ id: 99 }, 'details');
  assert.equal(result.status, 200);
  assert.equal(result.body.session.pr_summary_md, 'Preview authentication fix');
  assert.equal(result.cache, 'no-store');
  const projection = queries.find((sql) => sql.includes('cs.pr_summary_md'));
  assert.match(projection, /cs\.testing_md/);
  assert.match(projection, /cs\.test_results/);
  assert.doesNotMatch(projection, /cs\.\*|cs\.spec_md|chat_session_messages|cc_session|api_key/);
});
