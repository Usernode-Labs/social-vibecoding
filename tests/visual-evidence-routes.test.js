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
const appAdmins = require('../src/services/app-admins');
const github = require('../src/services/github');
const orchestrator = require('../src/services/visual-evidence-orchestrator');
const state = require('../src/services/visual-evidence-state');
const planContract = require('../src/services/visual-evidence-plan');

test('retry classifies the original exact revisions before deciding a no-impact claim', async (t) => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const runId = '1'.repeat(32);
  const declaration = { version: 1, impact: 'none', rationale: 'Server-only change.', stories: [] };
  const session = {
    id: 42, app_id: 9, user_id: 7, source: 'imported', status: 'merged',
    imported_pr_head_sha: head, visual_evidence_state: 'failed', visual_evidence_run_id: runId,
  };
  const pool = { query: async (sql) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [session] };
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  const saved = {
    pool: db.getPool, access: appAccess.getAppForUser, compare: github.compareRefs,
    getRun: state.getRun, rerun: state.rerunSameHead, schedule: orchestrator.scheduleForSession,
  };
  db.getPool = () => pool;
  appAccess.getAppForUser = async () => ({ id: 9, slug: 'demo', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' });
  state.getRun = async () => ({ id: runId, base_sha: base, head_sha: head, intent: declaration });
  const comparisons = [];
  let files = ['src/routes/sessions.js'];
  github.compareRefs = async (owner, repo, range) => {
    comparisons.push({ owner, repo, range });
    return { files, filesComplete: true };
  };
  const decisions = [];
  state.rerunSameHead = async (_pool, _runId, options) => {
    decisions.push(options.heuristicUi);
    return { id: '2'.repeat(32), head_sha: head, state: options.heuristicUi ? 'planned' : 'not_required' };
  };
  orchestrator.scheduleForSession = async () => ({ scheduled: false, reason: 'not_required' });
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
    db.getPool = saved.pool;
    appAccess.getAppForUser = saved.access;
    github.compareRefs = saved.compare;
    state.getRun = saved.getRun;
    state.rerunSameHead = saved.rerun;
    orchestrator.scheduleForSession = saved.schedule;
    delete require.cache[routePath];
  });
  const url = `http://127.0.0.1:${server.address().port}/api/apps/demo/proposals/42/evidence/rerun`;
  const retry = async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await retry(), {
    status: 202, body: { ok: true, runId: '2'.repeat(32), visualEvidenceState: 'not_required' },
  });
  files = ['frontend/src/features/dev-board/topic/topic-head.tsx'];
  assert.equal((await retry()).body.visualEvidenceState, 'planned');
  assert.deepEqual(decisions, [false, true]);
  assert.deepEqual(comparisons, [
    { owner: 'Usernode-Labs', repo: 'social-vibecoding', range: `${base}...${head}` },
    { owner: 'Usernode-Labs', repo: 'social-vibecoding', range: `${base}...${head}` },
  ]);
  github.compareRefs = async () => ({ files: [], filesComplete: false });
  const incomplete = await retry();
  assert.equal(incomplete.status, 409);
  assert.equal(incomplete.body.error, 'evidence_change_set_incomplete');
  assert.deepEqual(decisions, [false, true], 'an incomplete changed-file list cannot reclassify a run');
});

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

test('run diagnostics are private to the author or app manager, available live, and retain retry history', async (t) => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const runId = '1'.repeat(32);
  const session = {
    id: 42, app_id: 9, user_id: 7, source: 'imported',
    imported_pr_head_sha: head, visual_evidence_state: 'failed',
    visual_evidence_run_id: runId,
  };
  const run = {
    id: runId, base_sha: base, head_sha: head, state: 'failed',
    trigger: 'preview-ready', author_plan_supplied: false,
    fixture_fingerprint: 'fixture-1', base_image_digest: 'sha256:base',
    head_image_digest: 'sha256:head', repair_attempt: 1,
    created_at: new Date('2026-09-01T00:00:00Z'),
    started_at: new Date('2026-09-01T00:01:00Z'),
    completed_at: new Date('2026-09-01T00:02:00Z'),
    updated_at: new Date('2026-09-01T00:02:00Z'),
    replay_plan: fixtures.plan(), plan_hash: planContract.planHash(fixtures.plan()),
    failure_code: 'assertion_failed', failure_reason: 'Sort was not visible.',
    trace_summary: {
      heartbeat: { processId: 'a'.repeat(16), poolWaiting: 3 },
      replayPasses: [{ pass: 1, durationMs: 20 }], replayRuntime: 'kubernetes', agentAttempts: 1,
      agentDispatches: [{ requestedBackend: 'codex_openrouter', requestedModel: 'glm-4', backend: 'claude_code', model: 'claude-sonnet', fallbackReason: 'model_without_tools', outcome: 'completed' }],
      agentActivity: { budgetMs: 240000, events: [{ atMs: 1200, kind: 'agent_deadline' }] },
      agentFinalResponse: { excerpt: 'The model stopped after context.', characters: 32 },
      lastReplayEvent: { pass: 2, type: 'viewport_started', storyId: 'invite-suggestions', viewport: 'desktop' },
      replayEvents: [{ pass: 2, type: 'action_started', actionId: 'open-settings', side: 'head' }],
      planSource: 'hosted_planner', tokenUsage: { inputTokens: 123 }, artifactBytes: 345,
      failure: { phase: 'pass_2', code: 'assertion_failed', detail: { side: 'head', phase: 'assertion' } },
      control: { planCalls: 1, finishStatus: 'failed', finishReason: 'The checkpoint did not render.' },
    },
  };
  const pool = { query: async (sql, params) => {
    if (String(sql).includes('FROM chat_sessions cs')) return { rows: [session] };
    if (String(sql).includes('FROM visual_evidence_runs')) {
      assert.doesNotMatch(String(sql), /state IN/);
      return { rows: params[0] === runId && params[1] === session.id ? [run] : [] };
    }
    if (String(sql).includes('FROM visual_evidence_artifacts')) {
      assert.deepEqual(params, [runId]);
      return { rows: [{
        story_id: 'invite-suggestions', viewport: 'desktop', side: 'head', variant: 'focus',
        media: 'png', bytes: 345, width: 640, height: 480, sha256: 'c'.repeat(64),
      }] };
    }
    throw new Error(`Unexpected query: ${String(sql).slice(0, 80)}`);
  } };
  const savedPool = db.getPool;
  const savedAccess = appAccess.getAppForUser;
  const savedManage = appAdmins.canManageApp;
  db.getPool = () => pool;
  appAccess.getAppForUser = async () => ({ id: 9, slug: 'demo' });
  appAdmins.canManageApp = async (_pool, app, user) => app.id === 9 && user.id === 8;
  const routePath = require.resolve('../src/routes/visual-evidence');
  delete require.cache[routePath];
  const isolatedRoutes = require('../src/routes/visual-evidence');
  let userId = 7;
  const app = express();
  app.use((req, _res, next) => { req.user = { id: userId }; next(); });
  app.use(isolatedRoutes.visualEvidenceRoutes({ visualEvidence: { present: true } }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    db.getPool = savedPool;
    appAccess.getAppForUser = savedAccess;
    appAdmins.canManageApp = savedManage;
    delete require.cache[routePath];
  });
  const url = `http://127.0.0.1:${server.address().port}/api/apps/demo/proposals/42/evidence/diagnostics`;
  const ownerResponse = await fetch(url);
  assert.equal(ownerResponse.status, 200);
  assert.match(ownerResponse.headers.get('cache-control'), /no-store/);
  const { diagnostics } = await ownerResponse.json();
  assert.equal(diagnostics.runId, runId);
  assert.equal(diagnostics.currentRun, true);
  assert.equal(diagnostics.replayPlan.stories[0].id, fixtures.plan().stories[0].id);
  assert.deepEqual(diagnostics.trace.replayPasses, [{ pass: 1, durationMs: 20 }]);
  assert.equal(diagnostics.trace.heartbeat.poolWaiting, 3);
  assert.match(diagnostics.observer.processId, /^[0-9a-f]{16}$/);
  assert.equal(diagnostics.observer.ownsRun, false);
  assert.equal(diagnostics.observer.heartbeatWrite, null);
  assert.equal(diagnostics.trace.agentDispatches[0].backend, 'claude_code');
  assert.equal(diagnostics.trace.agentDispatches[0].fallbackReason, 'model_without_tools');
  assert.equal(diagnostics.trace.agentActivity.events[0].kind, 'agent_deadline');
  assert.equal(diagnostics.trace.agentFinalResponse.excerpt, 'The model stopped after context.');
  assert.equal(diagnostics.trace.lastReplayEvent.pass, 2);
  assert.equal(diagnostics.trace.replayEvents[0].actionId, 'open-settings');
  assert.equal(diagnostics.trace.replayRuntime, 'kubernetes');
  assert.equal(diagnostics.trace.planSource, 'hosted_planner');
  assert.equal(diagnostics.trace.tokenUsage.inputTokens, 123);
  assert.equal(diagnostics.trigger, 'preview-ready');
  assert.equal(diagnostics.repairAttempt, 1);
  assert.equal(diagnostics.provenance.fixtureFingerprint, 'fixture-1');
  assert.equal(diagnostics.artifacts[0].bytes, 345);
  assert.equal(diagnostics.trace.failure.detail.side, 'head');
  assert.equal(diagnostics.trace.control.planCalls, 1);

  userId = 8;
  assert.equal((await fetch(url)).status, 200, 'app manager can diagnose another author’s run');
  run.state = 'replaying';
  assert.equal((await (await fetch(url)).json()).diagnostics.state, 'replaying', 'the private trace is available while a run is active');
  run.state = 'failed';
  userId = 9;
  assert.equal((await fetch(url)).status, 404);
  userId = 8;
  session.imported_pr_head_sha = 'd'.repeat(40);
  session.visual_evidence_run_id = '2'.repeat(32);
  run.state = 'stale';
  assert.equal((await fetch(url)).status, 404);
  const historical = await fetch(`${url}?runId=${runId}`);
  assert.equal(historical.status, 200);
  const historicalDiagnostics = (await historical.json()).diagnostics;
  assert.equal(historicalDiagnostics.headSha, head);
  assert.equal(historicalDiagnostics.state, 'stale');
  assert.equal((await fetch(`${url}?runId=${'3'.repeat(32)}`)).status, 404);

  run.state = 'verified';
  run.failure_code = null;
  run.failure_reason = null;
  const verified = (await (await fetch(`${url}?runId=${runId}`)).json()).diagnostics;
  assert.equal(verified.state, 'verified');
  assert.equal(verified.failureCode, null);
  assert.equal(verified.trace.agentDispatches[0].backend, 'claude_code');
  session.visual_evidence_run_id = null;
  session.visual_evidence_state = 'planned';
  session.visual_evidence_detail = { notStartedReason: 'No staging preview was built.' };
  const notStarted = (await (await fetch(url)).json()).diagnostics;
  assert.equal(notStarted.runId, null);
  assert.equal(notStarted.notStartedReason, 'No staging preview was built.');
  assert.equal((await fetch(`${url}?runId=bad`)).status, 404);
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

for (const status of ['active', 'paused', 'promoted']) {
  test(`${status}: only the change author can submit a matching plan for the current revision`, async (t) => {
    const head = 'b'.repeat(40);
    const session = {
      id: 42, user_id: 7, app_id: 9, status, source: 'imported',
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
    assert.equal(session.status, status, 'evidence submission does not resume coding');
    for (const closed of ['archived', 'merged', 'merging']) {
      session.status = closed;
      assert.equal((await submit({ headSha: head, plan: fixtures.plan() })).body.error, 'proposal_not_open');
    }
    session.status = status;
    session.visual_evidence_run_id = '4'.repeat(32);
    session.visual_evidence_state = 'provisioning';
    assert.equal((await submit({ headSha: head, plan: fixtures.plan() })).body.error, 'evidence_run_in_progress');
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
    assert.deepEqual(retries, [{ runId: '2'.repeat(32), options: {
      trigger: 'author-plan', authorPlan: planContract.parseReplayPlan(fixtures.plan()),
    } }]);
    assert.equal(scheduled.length, 2);
  });
}
