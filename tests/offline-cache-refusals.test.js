'use strict';

// services/offline-cache-refusals.js: a page that did not open at the
// cacheable address, learned for the app's current build. Pins the build
// guard, the two-person threshold, that only the live build's reports are
// kept, and that the switch-off only lands while the app is on that build.

const test = require('node:test');
const assert = require('node:assert/strict');

const refusals = require('../src/services/offline-cache-refusals');

const LIVE = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

// A pool that keeps the table and the app row in memory and answers the
// four statements the service sends.
function fakePool({ mainSha = LIVE, rows = [] } = {}) {
  const state = { rows: rows.slice(), app: { id: 7, main_sha: mainSha, offline_cache_off_sha: null }, sql: [] };
  return {
    state,
    async query(sql, params) {
      state.sql.push(sql.replace(/\s+/g, ' ').trim());
      if (/^DELETE FROM app_offline_cache_refusals/.test(sql)) {
        state.rows = state.rows.filter((r) => !(r.app_id === params[0] && r.main_sha !== params[1]));
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO app_offline_cache_refusals/.test(sql)) {
        const [appId, sha, userId] = params;
        if (!state.rows.some((r) => r.app_id === appId && r.main_sha === sha && r.user_id === userId)) {
          state.rows.push({ app_id: appId, main_sha: sha, user_id: userId });
        }
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT COUNT\(\*\)::int AS people/.test(sql)) {
        const people = state.rows.filter((r) => r.app_id === params[0] && r.main_sha === params[1]).length;
        return { rows: [{ people }] };
      }
      if (/^UPDATE apps SET offline_cache_off_sha/.test(sql)) {
        const [id, sha] = params;
        const a = state.app;
        if (a.id === id && a.main_sha === sha && a.offline_cache_off_sha !== sha) {
          a.offline_cache_off_sha = sha;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

const APP = { id: 7, slug: 'notes-9206f8', main_sha: LIVE };

test('a build is a full commit sha, nothing else', () => {
  assert.equal(refusals.parseBuild(LIVE.toUpperCase()), LIVE);
  assert.equal(refusals.parseBuild('b1'), null);
  assert.equal(refusals.parseBuild(''), null);
  assert.equal(refusals.parseBuild(null), null);
});

test('one person is not enough; a second person on the same build switches it off', async () => {
  const pool = fakePool();
  const first = await refusals.recordRefusal(pool, { app: APP, userId: 1, build: LIVE });
  assert.deepEqual(first, { recorded: true, people: 1, off: false });
  assert.equal(pool.state.app.offline_cache_off_sha, null);

  const again = await refusals.recordRefusal(pool, { app: APP, userId: 1, build: LIVE });
  assert.equal(again.people, 1, 'the same person twice is still one');
  assert.equal(pool.state.app.offline_cache_off_sha, null);

  const second = await refusals.recordRefusal(pool, { app: APP, userId: 2, build: LIVE });
  assert.deepEqual(second, { recorded: true, people: 2, off: true });
  assert.equal(pool.state.app.offline_cache_off_sha, LIVE);
});

test('a report on another build is ignored and writes nothing', async () => {
  const pool = fakePool();
  const out = await refusals.recordRefusal(pool, { app: APP, userId: 1, build: OLD });
  assert.deepEqual(out, { recorded: false, people: 0, off: false });
  assert.deepEqual(pool.state.sql, []);
});

test('only the live build\'s reports count: an older build\'s are dropped', async () => {
  const pool = fakePool({ rows: [{ app_id: 7, main_sha: OLD, user_id: 2 }] });
  const out = await refusals.recordRefusal(pool, { app: APP, userId: 1, build: LIVE });
  assert.equal(out.people, 1);
  assert.equal(out.off, false);
  assert.deepEqual(pool.state.rows, [{ app_id: 7, main_sha: LIVE, user_id: 1 }]);
});

test('a deploy that landed in between keeps its own chance', async () => {
  // The row the route read was still on LIVE; the app has since moved on.
  const pool = fakePool({ mainSha: OLD, rows: [{ app_id: 7, main_sha: LIVE, user_id: 2 }] });
  await refusals.recordRefusal(pool, { app: APP, userId: 1, build: LIVE });
  assert.equal(pool.state.app.offline_cache_off_sha, null, 'the UPDATE names the build it switches off');
});

test('no app, no person or no build: nothing is recorded', async () => {
  const pool = fakePool();
  assert.equal((await refusals.recordRefusal(pool, { app: null, userId: 1, build: LIVE })).recorded, false);
  assert.equal((await refusals.recordRefusal(pool, { app: APP, userId: null, build: LIVE })).recorded, false);
  assert.equal((await refusals.recordRefusal(pool, { app: APP, userId: 1, build: '' })).recorded, false);
  assert.deepEqual(pool.state.sql, []);
});
