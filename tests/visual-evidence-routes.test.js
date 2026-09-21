'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const routes = require('../src/routes/visual-evidence');
const fixtures = require('./fixtures/visual-evidence');
const db = require('../src/db/pool');
const appAccess = require('../src/services/app-access');
const orchestrator = require('../src/services/visual-evidence-orchestrator');
const state = require('../src/services/visual-evidence-state');

test('artifact range parsing supports full, open, and suffix ranges and fails closed', () => {
  assert.equal(routes.parseRange(undefined, 100), null);
  assert.deepEqual(routes.parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(routes.parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(routes.parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(routes.parseRange('bytes=95-500', 100), { start: 95, end: 99 });
  for (const value of ['items=0-1', 'bytes=', 'bytes=20-10', 'bytes=100-', 'bytes=1-2,4-5']) {
    assert.equal(routes.parseRange(value, 100), false, value);
  }
});

test('artifact ids and proposal ids are canonical and traversal-proof', () => {
  assert.equal(routes.sessionId('42'), 42);
  assert.equal(routes.sessionId('0'), null);
  assert.equal(routes.sessionId('../42'), null);
  assert.equal(routes.sessionId(String(2 ** 40)), null);
});

test('the binary route is authenticated, current-run fenced, exact-head fenced, and private', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/visual-evidence.js'), 'utf8');
  assert.match(src, /loadContext\(pool, req\.params\.slug, id, req\.user, 'view'\)/);
  assert.match(src, /!config\.visualEvidence\?\.present/);
  assert.match(src, /s\.visual_evidence_run_id = r\.id/);
  assert.match(src, /s\.visual_evidence_state = 'verified' AND r\.state = 'verified'/);
  assert.match(src, /r\.head_sha = COALESCE/);
  assert.match(src, /Cache-Control': 'private, max-age=31536000, immutable'/);
  assert.match(src, /Vary: 'Cookie, Authorization'/);
  assert.match(src, /res\.status\(206\)/);
  assert.match(src, /res\.status\(416\)/);
  assert.doesNotMatch(src, /\/visuals\//, 'evidence never uses the public legacy media route');
});

test('the change author can submit only a matching plan for the current proposal revision', async (t) => {
  const head = 'b'.repeat(40);
  const session = {
    id: 42, user_id: 7, app_id: 9, status: 'promoted', source: 'imported',
    imported_pr_head_sha: head, visual_evidence_state: 'planned',
    visual_evidence_run_id: null, visual_evidence_detail: { intent: fixtures.intent() },
  };
  const pool = { query: async () => ({ rows: [{ ...session }] }) };
  const savedPool = db.getPool;
  const savedAccess = appAccess.getAppForUser;
  const savedSchedule = orchestrator.scheduleForSession;
  const savedRerun = state.rerunSameHead;
  db.getPool = () => pool;
  appAccess.getAppForUser = async () => ({ id: 9, slug: 'demo' });
  const scheduled = [];
  orchestrator.scheduleForSession = async (_config, options) => {
    scheduled.push(options);
    return { scheduled: true, runId: '1'.repeat(32) };
  };
  const routePath = require.resolve('../src/routes/visual-evidence');
  delete require.cache[routePath];
  const isolatedRoutes = require('../src/routes/visual-evidence');
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use(isolatedRoutes.visualEvidenceRoutes({ visualEvidence: { execute: true } }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    db.getPool = savedPool;
    appAccess.getAppForUser = savedAccess;
    orchestrator.scheduleForSession = savedSchedule;
    state.rerunSameHead = savedRerun;
    delete require.cache[routePath];
  });
  const submit = async (body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/proposals/42/evidence/plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const stale = await submit({ headSha: 'c'.repeat(40), plan: fixtures.plan() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'evidence_head_moved');
  const changed = fixtures.plan({ rationale: 'A different claim' });
  const mismatch = await submit({ headSha: head, plan: changed });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error, 'evidence_intent_mismatch');
  const accepted = await submit({ headSha: head, plan: fixtures.plan() });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.runId, '1'.repeat(32));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].headSha, head);
  assert.equal(scheduled[0].authorPlan.version, 1);
  session.user_id = 8;
  const otherUser = await submit({ headSha: head, plan: fixtures.plan() });
  assert.equal(otherUser.status, 404);
  assert.equal(scheduled.length, 1);
  session.user_id = 7;
  session.visual_evidence_state = 'failed';
  session.visual_evidence_run_id = '2'.repeat(32);
  const retries = [];
  state.rerunSameHead = async (_pool, runId, options) => {
    retries.push({ runId, options });
    return { id: '3'.repeat(32), head_sha: head, state: 'planned' };
  };
  const retry = await submit({ headSha: head, plan: fixtures.plan() });
  assert.equal(retry.status, 202);
  assert.deepEqual(retries, [{ runId: '2'.repeat(32), options: { trigger: 'author-plan' } }]);
  assert.equal(scheduled.length, 2);
});
