'use strict';

// Homeroom mobile polish, item 05 (24 Nov 2026): the Homeroom bot list's
// visits (src/services/ai-visits.js), against the FULL PostgreSQL schema in
// a throwaway database.
//
// What this pins:
//   1. A first visit has nothing before it: no time, nothing seen.
//   2. Leaving and coming back measures the next visit from when this one
//      ended, with what its bands held then.
//   3. A reload of the same tab carries the visit on (its marks stay); a
//      return after the gap, or from anywhere else, starts the next visit.
//   4. Per person: a second device opened while the first has the list open
//      shares its last visit; one of them leaving leaves the visit going.
//   5. A tab that stopped being heard from without leaving has left once
//      the gap is past.
//   6. The routes: 401 signed out, 400 for a `seen` that is not one, and one
//      person's visit is never another's.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/ai-visits-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a person\'s visits to the Homeroom bot list', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `ai_visits_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username) => one(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [username]);
  const ada = await user('av_ada');
  const bob = await user('av_bob');
  const visits = require('../src/services/ai-visits');
  const gapMinutes = visits.VISIT_GAP_MS / 60000;
  const seenA = { needs: { 'need:proposal:1': '', 'root:5': '' }, busy: { 'thread:9': 'next:building' }, done: { 'thread:3': '' } };
  const seenB = { needs: { 'need:proposal:1': '', 'need:proposal:2': '' }, busy: { 'thread:9': 'waiting:checking' }, done: {} };
  // The row as the clock would leave it `minutes` later: every time in it moved back.
  const later = (userId, minutes) => pool.query(
    `UPDATE ai_list_visits
        SET current_at = current_at - make_interval(mins => $2),
            left_at = left_at - make_interval(mins => $2),
            current_tabs = COALESCE((SELECT jsonb_object_agg(k, (v::text::float8 - $2 * 60000)::float8)
                                       FROM jsonb_each(current_tabs) AS e(k, v)), '{}'::jsonb)
      WHERE user_id = $1`,
    [userId, minutes]);

  // 1. A first visit: nothing before it.
  const first = await visits.openVisit(pool, { userId: ada.id });
  assert.equal(first.since, null);
  assert.equal(first.seen, null);
  assert.match(first.visit, /^[A-Za-z0-9_-]{8,64}$/);
  // Reopened before it has seen anything, it still has nothing before it.
  assert.equal((await visits.openVisit(pool, { userId: ada.id, token: first.visit })).since, null);

  // 2. It sees the list, leaves, and comes back from elsewhere: the next
  // visit is measured from when that one ended, with what it held.
  assert.deepEqual(await visits.noteVisit(pool, { userId: ada.id, token: first.visit, seen: seenA }), { ok: true });
  const leftAt = Date.now();
  assert.deepEqual(await visits.noteVisit(pool, { userId: ada.id, token: first.visit, seen: seenA, left: true }), { ok: true });
  const second = await visits.openVisit(pool, { userId: ada.id });
  assert.ok(second.since, 'the next visit has a last visit');
  assert.ok(Math.abs(Date.parse(second.since) - leftAt) < 5000, 'measured from when the last one ended');
  assert.deepEqual(second.seen, seenA);
  assert.notEqual(second.visit, first.visit, 'a new tab is a new visit');

  // 3. A reload of that tab: it says it left (pagehide), then comes back
  // with its token. The visit carries on: the same last visit, so the
  // same marks.
  await visits.noteVisit(pool, { userId: ada.id, token: second.visit, seen: seenB });
  await visits.noteVisit(pool, { userId: ada.id, token: second.visit, seen: seenB, left: true });
  const reloaded = await visits.openVisit(pool, { userId: ada.id, token: second.visit });
  assert.equal(reloaded.since, second.since, 'a reload keeps the last visit');
  assert.deepEqual(reloaded.seen, seenA);
  assert.equal(reloaded.visit, second.visit);
  // The same tab put away past the gap is the next visit.
  await visits.noteVisit(pool, { userId: ada.id, token: second.visit, seen: seenB, left: true });
  await later(ada.id, gapMinutes + 1);
  const back = await visits.openVisit(pool, { userId: ada.id, token: second.visit });
  assert.notEqual(back.since, second.since, 'after the gap, the next visit');
  assert.deepEqual(back.seen, seenB);

  // 4. A phone opened while the computer has the list open shares its last
  // visit. The phone leaving leaves the visit going on the computer; a
  // third tab opened then still shares it.
  await visits.noteVisit(pool, { userId: ada.id, token: back.visit, seen: seenA });
  const phone = await visits.openVisit(pool, { userId: ada.id });
  assert.equal(phone.since, back.since, 'the phone and the computer measure from the same visit');
  assert.deepEqual(phone.seen, back.seen);
  await visits.noteVisit(pool, { userId: ada.id, token: phone.visit, seen: seenA, left: true });
  const third = await visits.openVisit(pool, { userId: ada.id });
  assert.equal(third.since, back.since, 'the computer still has it open: the same visit');
  // Every tab leaves: the next visit measures from then.
  await visits.noteVisit(pool, { userId: ada.id, token: back.visit, seen: seenA, left: true });
  await visits.noteVisit(pool, { userId: ada.id, token: third.visit, seen: seenA, left: true });
  const next = await visits.openVisit(pool, { userId: ada.id });
  assert.ok(Date.parse(next.since) > Date.parse(back.since), 'measured from the last tab to leave');
  assert.deepEqual(next.seen, seenA);

  // 5. A tab that stops being heard from without leaving (a closed phone
  // page): within the gap it is still open; past it, it has left.
  await visits.noteVisit(pool, { userId: ada.id, token: next.visit, seen: seenB });
  const stillOpen = await visits.openVisit(pool, { userId: ada.id });
  assert.equal(stillOpen.since, next.since);
  await visits.noteVisit(pool, { userId: ada.id, token: stillOpen.visit, seen: seenB, left: true });
  await later(ada.id, gapMinutes + 1);
  const afterQuiet = await visits.openVisit(pool, { userId: ada.id });
  assert.notEqual(afterQuiet.since, next.since);
  assert.deepEqual(afterQuiet.seen, seenB);

  // 5b. A row opened: the last visit's record learns it, and a reload in
  // the same visit returns it, so the dot does not come back. The line's
  // time does not move.
  const ended = await one('SELECT last_visit_seen FROM ai_list_visits WHERE user_id = $1', [ada.id]);
  assert.ok(ended.last_visit_seen, 'the visit just left is the last one');
  assert.deepEqual(await visits.noteOpened(pool, {
    userId: ada.id, token: afterQuiet.visit, band: 'needs', identity: 'need:proposal:9', standing: '',
  }), { ok: true });
  const resumed = await visits.openVisit(pool, { userId: ada.id, token: afterQuiet.visit });
  assert.equal(resumed.seen.needs['need:proposal:9'], '', 'a reload in the visit has the opened row');
  assert.equal(resumed.since, afterQuiet.since, 'the line keeps its time');
  // A first visit has no record to learn it: nothing is written.
  const solo = await user('av_solo');
  const soloFirst = await visits.openVisit(pool, { userId: solo.id });
  assert.deepEqual(await visits.noteOpened(pool, {
    userId: solo.id, token: soloFirst.visit, band: 'done', identity: 'thread:1', standing: '',
  }), { ok: true });
  const soloRow = await one('SELECT last_visit_seen FROM ai_list_visits WHERE user_id = $1', [solo.id]);
  assert.equal(soloRow.last_visit_seen, null, 'a first visit writes nothing');
  // The next visit still measures from what this one held, not the patch.
  const seenC = { needs: {}, busy: { 'thread:9': 'next:building' }, done: {} };
  await visits.noteVisit(pool, { userId: ada.id, token: afterQuiet.visit, seen: seenC });
  await visits.noteVisit(pool, { userId: ada.id, token: afterQuiet.visit, seen: seenC, left: true });
  const promoted = await visits.openVisit(pool, { userId: ada.id });
  assert.deepEqual(promoted.seen, seenC, 'a promoted visit measures from current_seen as before');
  assert.equal('need:proposal:9' in promoted.seen.needs, false);

  // A `seen` that is not one is refused and changes nothing.
  assert.equal(await visits.noteVisit(pool, { userId: ada.id, token: afterQuiet.visit, seen: { later: {} } }), null);
  assert.equal(await visits.noteVisit(pool, { userId: ada.id, token: 'short', seen: seenA }), null);

  // 6. The routes.
  require('../src/db/pool').getPool = () => pool;
  const httpApp = express();
  httpApp.use(express.json());
  httpApp.use((req, _res, next) => { req.user = req.get('x-test-user') ? { id: Number(req.get('x-test-user')) } : null; next(); });
  httpApp.use(require('../src/routes/ai-work').aiWorkRoutes({}));
  server = await new Promise((resolve) => { const s = httpApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, who, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(who ? { 'x-test-user': String(who) } : {}) },
    body: JSON.stringify(body || {}),
  });
  assert.equal((await post('/api/ai/visit')).status, 401);
  assert.equal((await post('/api/ai/visit/seen', null, { visit: 'tabAAAAAAAA', seen: seenA })).status, 401);
  const opened = await post('/api/ai/visit', bob.id, {});
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get('cache-control'), 'private, no-store');
  const bobFirst = await opened.json();
  assert.equal(bobFirst.since, null, 'one person\'s visits are never another\'s');
  assert.equal((await post('/api/ai/visit/seen', bob.id, { visit: bobFirst.visit, seen: 'everything' })).status, 400);
  assert.equal((await post('/api/ai/visit/seen', bob.id, { visit: bobFirst.visit, seen: seenB, left: true })).status, 200);
  const bobNext = await (await post('/api/ai/visit', bob.id, {})).json();
  assert.ok(bobNext.since);
  assert.deepEqual(bobNext.seen, seenB);
  // A row opened through the route: 401 signed out, 400 for a row that is
  // not one, 200 and the record learns it otherwise.
  assert.equal((await post('/api/ai/visit/opened')).status, 401);
  assert.equal((await post('/api/ai/visit/opened', bob.id, {
    visit: bobNext.visit, band: 'later', identity: 'thread:1', standing: '',
  })).status, 400);
  const bobOpened = await post('/api/ai/visit/opened', bob.id, {
    visit: bobNext.visit, band: 'done', identity: 'thread:77', standing: '',
  });
  assert.equal(bobOpened.status, 200);
  assert.deepEqual(await bobOpened.json(), { ok: true });
  const bobAgain = await (await post('/api/ai/visit', bob.id, { visit: bobNext.visit })).json();
  assert.equal(bobAgain.seen.done['thread:77'], '', 'a reload in the visit has the opened row');
  // A page on a sibling subdomain cannot write a person's visits.
  const crossSite = await fetch(`${base}/api/ai/visit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': String(bob.id), 'sec-fetch-site': 'same-site' },
    body: '{}',
  });
  assert.equal(crossSite.status, 403);
});
