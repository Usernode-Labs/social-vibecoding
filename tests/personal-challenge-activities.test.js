'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const { personalChallengeActivities, activityView, sourceRef, PAGE_SIZE } = require('../src/services/topochain/personal-challenge-activities');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const components = loadTsx('frontend/src/features/leaderboard/challenge-activity.tsx');

function record(id, metadata = {}) {
  return { id, points: 150, description: 'Accepted proposal', activity_at: '2026-09-28T12:00:00Z', metadata };
}

test('date-only sources retain their calendar date, exact actions retain the timestamp', () => {
  const daily = activityView(record(1, { measure: 'TRY_APPS' }));
  assert.equal(daily.precision, 'date');
  assert.equal(daily.date, '2026-09-28');
  assert.equal(components.activityTime(daily), '2026-09-28 (date only)');
  const exact = activityView(record(2, { measure: 'PROPOSAL_ACCEPTED' }));
  assert.equal(exact.precision, 'timestamp');
  assert.equal(exact.activityAt, '2026-09-28T12:00:00.000Z');
  assert.doesNotMatch(components.activityTime(exact), /date only/);
  assert.equal(components.activityTime({ activityAt: null, precision: 'timestamp' }), 'Time not recorded');
});

test('only recorded explanation and selected fields leave the service', () => {
  const view = activityView(record(1, { secret: 'not for clients', grade: { reason: 'Useful improvement', model: 'internal', prompt: 'private' } }));
  assert.equal(view.explanation, 'Useful improvement');
  assert.doesNotMatch(JSON.stringify(view), /secret|internal|private|metadata|prompt/);
  assert.equal(activityView(record(2)).explanation, null);
  assert.equal(activityView(record(3, { grade: { reason: 'x'.repeat(300) } })).explanation.length, 200);
});

test('source keys cannot smuggle arbitrary ids, SQL or URLs into links', () => {
  for (const key of ['session:0', 'session:-2', 'session:1 OR 1=1', 'https://example.test', 'merged:99999999999999']) {
    assert.equal(sourceRef({ source_key: key }), null);
  }
  assert.deepEqual(sourceRef({ source_key: 'merged:4' }), { kind: 'merged', id: 4, key: 'merged:4' });
});

test('own credited proposals resolve both source forms and inaccessible projects get no title or link', async () => {
  const calls = [];
  const pool = { query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('FROM user_activities')) return { rows: [record(3, { source_key: 'session:11' }), record(2, { source_key: 'merged:22' })] };
    if (sql.includes('FROM events')) return { rows: [{ id: 22, session_id: 12 }] };
    if (sql.includes('FROM chat_sessions')) return { rows: [
      { id: 11, app_id: 8, view_visibility: 'public', slug: 'my-app', pr_title: 'A useful fix' },
      { id: 12, app_id: 9, view_visibility: 'private', slug: 'private-app', pr_title: 'Private title' },
    ] };
    if (sql.includes('FROM app_collaborators')) return { rows: [] };
    throw new Error('Unexpected query');
  } };
  const data = await personalChallengeActivities(pool, { id: 7 }, 10);
  assert.equal(data.items[0].proposal.href, '#app/my-app/dev/proposals/11');
  assert.equal(data.items[1].proposal, null);
  assert.doesNotMatch(JSON.stringify(data), /Private title|private-app/);
  assert.deepEqual(calls[0].args, [7, 10, null, PAGE_SIZE + 1]);
  assert.match(calls[0].sql, /ua.user_id = \$1 AND ua.challenge_id = \$2/);
  assert.match(calls[0].sql, /se.internal = FALSE/);
  assert.match(calls[1].sql, /user_id = \$2 AND event_type = 'pr_merged'/);
  assert.match(calls[2].sql, /cs.user_id = \$2/);
});

test('history is bounded, stable for equal timestamps and uses a separate next cursor', async () => {
  let params;
  const pool = { query: async (sql, args) => { params = args; return { rows: Array.from({ length: 26 }, (_, i) => record(100 - i)) }; } };
  const data = await personalChallengeActivities(pool, { id: 7 }, 10, '110');
  assert.equal(data.items.length, 25);
  assert.equal(data.nextBefore, '76');
  assert.equal(params[2], '110');
  assert.equal(data.items[0].id, 100);
});

test('private activity endpoint requires authentication and rejects invalid cursors', async (t) => {
  const poolModule = require('../src/db/pool');
  const original = poolModule.getPool;
  let calls = 0;
  poolModule.getPool = () => ({ query: async () => { calls++; return { rows: [] }; } });
  const path = require.resolve('../src/routes/profile'); delete require.cache[path];
  const { profileRoutes } = require(path); poolModule.getPool = original; delete require.cache[path];
  const app = express();
  app.use((req, res, next) => { if (req.headers['x-test-user']) req.user = { id: 7 }; next(); });
  app.use(profileRoutes({}));
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve)); t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/me/challenges/10/activities`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(`${url}?before=-1`, { headers: { 'x-test-user': '7' } })).status, 400);
  assert.equal(calls, 0);
  const response = await fetch(`${url}?user_id=99`, { headers: { 'x-test-user': '7' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('window copy uses effective dates before event fallback and includes a timezone', () => {
  const sandbox = { window: { TopochainEventContext: { selectedEvent: () => ({ starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-01-08T00:00:00Z' }) } }, console, setTimeout, clearTimeout, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('frontend/src/features/leaderboard/topochain-challenges.js', 'utf8'), sandbox);
  const controller = sandbox.window.TopochainChallenges;
  const normal = controller._exactWindow({ effective: {} });
  assert.match(normal, /Starts.*2026.*Ends.*2026/);
  const own = controller._exactWindow({ effective: { schedule_start: '2027-02-01T00:00:00Z', schedule_end: '2027-02-08T00:00:00Z' } });
  assert.match(own, /2027/); assert.doesNotMatch(own, /2026/);
  assert.match(own, /(?:UTC|GMT)/);
});

test('rewards explanation does not promise a fixed currency conversion', () => {
  const html = renderToHtml(createElement(components.PointsExplainer));
  assert.match(html, /Points and tokens/);
  assert.match(html, /provisional allocation/);
  assert.match(html, /not a token or a fixed token amount/);
});
