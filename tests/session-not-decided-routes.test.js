// What a session route answers when Homeroom has not decided the move yet.
//
// Workflow decisions are made by a separate process: a route that appends a
// proposal event and waits sees `pending` whenever that process is slow or
// restarting, and a move with a deadline it reaches too late is refused as
// `expired`. Either way nothing changed and asking again may work, so the
// route says exactly that: 503, `code: 'not_decided'`, Retry-After. Never a
// 404 ("cannot be paused"), a 409 ("already merging") or "still being
// closed", which were each false for a move nobody had decided.
//
// Same harness as tests/session-cap-enforcement.test.js: getPool is replaced
// before the route module loads, the lifecycle service's functions are
// swapped for the answer under test, and the router is mounted on express.
//
// Run with: node --test tests/session-not-decided-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
const SESSION_ID = 41;
let rowStatus = 'paused';
poolMod.getPool = () => ({
  query: async (sql) => {
    const s = String(sql);
    if (/SELECT id, status FROM chat_sessions WHERE id = \$1 AND user_id = \$2/.test(s)) {
      return { rows: [{ id: SESSION_ID, status: rowStatus }] };
    }
    if (/SELECT id, app_id, status FROM chat_sessions WHERE id = \$1 AND user_id = \$2/.test(s)) {
      return { rows: [{ id: SESSION_ID, app_id: 5, status: rowStatus }] };
    }
    if (/SELECT cs\.\*, a\.slug AS app_slug/.test(s)) {
      return { rows: [{ id: SESSION_ID, app_id: 5, user_id: 7, status: rowStatus, app_slug: 'demo' }] };
    }
    return { rows: [] };
  },
});

const lifecycle = require('../src/services/session-lifecycle');
// The resume asks the proposal machine itself (platform.ts resumeProposal),
// read at call time, so the module's exports are swapped in the cache.
const platformId = require.resolve('../src/workflow/platform.ts');
const realPlatform = require(platformId);
let resumeAnswer = { status: 'pending', requestKey: 'k' };
const resumeCalls = [];
require.cache[platformId].exports = {
  ...realPlatform,
  resumeProposal: async (p) => { resumeCalls.push(p); return typeof resumeAnswer === 'function' ? resumeAnswer(p) : resumeAnswer; },
};

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const USER = { id: 7, username: 'tester' };

async function post(path) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = USER; next(); });
  app.use(sessionRoutes({ maxGlobalSessions: 100 }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}',
    });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() };
  } finally {
    server.close();
  }
}

const restores = [];
function swap(obj, key, value) {
  restores.push([obj, key, obj[key]]);
  obj[key] = value;
}
test.afterEach(() => {
  while (restores.length) { const [obj, key, val] = restores.pop(); obj[key] = val; }
});
test.after(() => { require.cache[platformId].exports = realPlatform; });

function assertNotDecided(r, what) {
  assert.equal(r.status, 503, `${what}: 503`);
  assert.equal(r.retryAfter, '5', `${what}: Retry-After`);
  assert.equal(r.body.code, 'not_decided', `${what}: its code`);
  assert.match(r.body.error, /Homeroom has not (decided|freed)/, `${what}: says Homeroom has not decided`);
  assert.match(r.body.error, /Try again/, `${what}: says to try again`);
}

test('unpromote: not decided yet is a retryable 503, never "already merging"', async () => {
  swap(lifecycle, 'unpromoteSession', async () => ({ ok: false, code: 'not_decided' }));
  const r = await post(`/api/sessions/${SESSION_ID}/unpromote`);
  assertNotDecided(r, 'unpromote');
  assert.doesNotMatch(r.body.error, /merging/);
  swap(lifecycle, 'unpromoteSession', async () => ({ ok: false, code: 'merging' }));
  assert.equal((await post(`/api/sessions/${SESSION_ID}/unpromote`)).status, 409, 'a real merge is still a conflict');
});

test('unarchive: not decided yet is told apart from a session still being closed', async () => {
  swap(lifecycle, 'unarchiveSession', async () => ({ unarchived: false, notDecided: true }));
  const r = await post(`/api/sessions/${SESSION_ID}/unarchive`);
  assertNotDecided(r, 'unarchive');
  assert.doesNotMatch(r.body.error, /being closed/);
  swap(lifecycle, 'unarchiveSession', async () => ({ unarchived: false, busy: true }));
  const closing = await post(`/api/sessions/${SESSION_ID}/unarchive`);
  assert.equal(closing.status, 503);
  assert.match(closing.body.error, /still being closed/);
});

test('pause: not decided yet is a retryable 503, not "cannot be paused"', async () => {
  rowStatus = 'active';
  try {
    swap(lifecycle, 'pauseSession', async () => ({ paused: false, reason: 'not_decided' }));
    assertNotDecided(await post(`/api/sessions/${SESSION_ID}/pause`), 'pause');
    swap(lifecycle, 'pauseSession', async () => ({ paused: false, reason: 'worked_on' }));
    assert.equal((await post(`/api/sessions/${SESSION_ID}/pause`)).status, 404, 'a refusal is still a 404');
  } finally { rowStatus = 'paused'; }
});

test('resume, and the sync that resumes first: a resume not decided yet is a retryable 503', async () => {
  resumeCalls.length = 0;
  for (const answer of [{ status: 'pending', requestKey: 'k' }, { status: 'rejected', reason: 'expired' }]) {
    resumeAnswer = answer;
    assertNotDecided(await post(`/api/sessions/${SESSION_ID}/resume`), `resume (${answer.status})`);
    assertNotDecided(await post(`/api/sessions/${SESSION_ID}/sync-main`), `sync-main (${answer.status})`);
  }
  assert.equal(resumeCalls.length, 4, 'each asked the machine once, and did not loop');
});

test('resume at a cap: a slot not freed in time is a retryable 503, not "at capacity"', async () => {
  resumeAnswer = { status: 'rejected', reason: 'global_cap' };
  swap(lifecycle, 'freeGlobalSlot', async () => ({ freed: false, notDecided: true }));
  assertNotDecided(await post(`/api/sessions/${SESSION_ID}/resume`), 'resume at the global cap');
  swap(lifecycle, 'freeGlobalSlot', async () => ({ freed: false }));
  swap(lifecycle, 'recordCapacityRefusal', async () => {});
  const full = await post(`/api/sessions/${SESSION_ID}/resume`);
  assert.equal(full.status, 429, 'a cap nothing could be freed under is still a 429');
  assert.equal(full.body.error, lifecycle.PLATFORM_AT_CAPACITY);
});
