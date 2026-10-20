'use strict';

// First-run marks for the admin Journey page (#3369). Two facts the account
// keeps, the first time only, in users.getting_started_seen: how the welcome
// tour ended (with the furthest step), and whether the join screen was
// answered with Join or "Skip for now". "Shown, not answered" is not stored
// here: each sheet and the tour report themselves as steps of the person's
// navigation path (public/js/ui-telemetry.js), which this file also pins.
//
// The database half runs against the real schema in a throwaway database,
// required when TEST_DATABASE_URL is set, skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the tour keeps how it ended and the join screen keeps join or skip, the first time only', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'journey_marks_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const onboarding = require('../src/services/onboarding');

  const { rows: people } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, needs_communities_choice) VALUES
       ('finisher', 'x', TRUE, TRUE), ('skipper', 'x', TRUE, TRUE), ('old_browser', 'x', TRUE, FALSE)
     RETURNING id`
  );
  const [finisher, skipper, oldBrowser] = people;
  const seen = async (id) => (await pool.query(
    'SELECT getting_started_seen AS seen, tour_done_at FROM users WHERE id = $1', [id])).rows[0];

  await onboarding.markTourDone(pool, finisher.id, { ended: 'finish', step: 3 });
  await onboarding.markTourDone(pool, finisher.id, { ended: 'skip', step: 0 });
  const f = await seen(finisher.id);
  assert.ok(f.tour_done_at);
  assert.equal(f.seen.tour_ended, 'finish', 'a replay never rewrites how the first tour ended');
  assert.equal(f.seen.tour_step, 3);

  await onboarding.markTourDone(pool, skipper.id, { ended: 'skip', step: 1, extra: 'x' });
  assert.deepEqual((await seen(skipper.id)).seen, { tour_ended: 'skip', tour_step: 1 });

  await onboarding.markTourDone(pool, oldBrowser.id, { ended: 'nonsense', step: 99 });
  const o = await seen(oldBrowser.id);
  assert.ok(o.tour_done_at, 'an unknown end still records the tour as done');
  assert.equal(o.seen, null, 'and stores no mark it cannot name');

  const offerNothing = { showSelfHosted: false, acceptInvite: async () => {} };
  const answered = await onboarding.answerJoin(pool, { id: skipper.id }, { skip: true }, offerNothing);
  assert.equal(answered.ok, true);
  assert.equal((await seen(skipper.id)).seen.join_answer, 'skipped');
  assert.equal((await seen(skipper.id)).seen.tour_ended, 'skip', 'other marks are kept');
  await onboarding.answerJoin(pool, { id: finisher.id }, { join: [] }, offerNothing);
  assert.equal((await seen(finisher.id)).seen.join_answer, 'joined');
  const again = await onboarding.answerJoin(pool, { id: finisher.id }, { skip: true }, offerNothing);
  assert.equal(again.ok, false, 'a second answer is refused');
  assert.equal((await seen(finisher.id)).seen.join_answer, 'joined', 'and changes nothing');
});

// The first session's walk on Home, kept by the account (Evan, 20 Oct 2026)
// so every device agrees on the app's ✕ and the menu's "Go to Homeroom".
test('the walk owed and Homeroom reached are kept once, and nothing is owed after it is reached', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'home_walk_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const onboarding = require('../src/services/onboarding');
  const { rows: [maker, other] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('maker', 'x', TRUE), ('other', 'x', TRUE) RETURNING id`);
  const seen = async (id) => (await pool.query('SELECT getting_started_seen AS seen FROM users WHERE id = $1', [id])).rows[0].seen || {};
  // What /api/auth/me reads (src/routes/auth.js).
  const me = async (id) => (await pool.query(
    `SELECT (u.getting_started_seen->>'home_walk_owed' IS NOT NULL
              AND u.getting_started_seen->>'homeroom_reached' IS NULL) AS owed,
            (u.getting_started_seen->>'homeroom_reached' IS NOT NULL) AS reached
       FROM users u WHERE u.id = $1`, [id])).rows[0];

  assert.deepEqual(await me(maker.id), { owed: false, reached: false });
  assert.deepEqual(await onboarding.markHomeWalk(pool, maker.id, 'owed'), { ok: true, written: true });
  const first = (await seen(maker.id)).home_walk_owed;
  assert.ok(first);
  assert.deepEqual(await onboarding.markHomeWalk(pool, maker.id, 'owed'), { ok: true, written: false }, 'kept once');
  assert.equal((await seen(maker.id)).home_walk_owed, first);
  assert.deepEqual(await me(maker.id), { owed: true, reached: false });
  assert.deepEqual(await onboarding.markHomeWalk(pool, maker.id, 'reached'), { ok: true, written: true });
  assert.deepEqual(await me(maker.id), { owed: false, reached: true });
  assert.deepEqual(await onboarding.markHomeWalk(pool, maker.id, 'reached'), { ok: true, written: false });

  // Reached first: never owed after it.
  await onboarding.markHomeWalk(pool, other.id, 'reached');
  assert.deepEqual(await onboarding.markHomeWalk(pool, other.id, 'owed'), { ok: true, written: false });
  assert.deepEqual(await me(other.id), { owed: false, reached: true });
  assert.equal((await seen(other.id)).home_walk_owed, undefined);

  // Nothing but the two states, and other marks are kept beside them.
  assert.deepEqual(await onboarding.markHomeWalk(pool, other.id, 'tour_ended'), { ok: false, written: false });
  await onboarding.markTourDone(pool, other.id, { ended: 'finish', step: 2 });
  assert.equal((await seen(other.id)).tour_ended, 'finish');
  assert.ok((await seen(other.id)).homeroom_reached);

  // Reset first run clears them with the rest of the column.
  await onboarding.resetFirstRun(pool, maker.id);
  assert.deepEqual(await me(maker.id), { owed: false, reached: false });
});

test('each first-run sheet and the tour report themselves as steps, and hand back the screen under them', () => {
  const username = read('frontend/src/features/auth/username-first-run.js');
  const join = read('frontend/src/features/auth/communities-first-run.js');
  const terms = read('frontend/src/features/settings/terms-first-run.js');
  const tour = read('frontend/src/features/home/tour/index.tsx');
  assert.match(username, /if \(!\(opts && opts\.demo\)\) window\.UITelemetry\?\.navigate\?\.\('username_sheet'\);/);
  assert.match(join, /if \(!\(opts && opts\.demo\)\) window\.UITelemetry\?\.navigate\?\.\('join_sheet'\);/);
  // The terms are accepted by continuing now (terms-first-run.js): no sheet, so no step.
  assert.doesNotMatch(terms, /'terms_sheet'/);
  assert.match(tour, /if \(!isTourShot\(\)\) \(window as any\)\.UITelemetry\?\.navigate\?\.\('tour'\);/);
  for (const [label, src] of [['username', username], ['join', join], ['tour', tour]]) {
    assert.match(src, /App\?\._renotifyNavigation\?\.\(\)/, `${label}: closing it re-reports the screen under it`);
  }
  assert.match(tour, /onClick=\{\(\) => finish\('skip'\)\}/, 'Skip is told apart from Next on the last step');
  assert.match(read('frontend/src/features/home/tour/tour-done.ts'),
    /body: JSON\.stringify\(end \? \{ ended: end\.ended/);
  assert.match(read('public/js/app.js'), /_renotifyNavigation\(\) \{[\s\S]{0,300}App\._reportNavigation\(screen, inApp\);/);
});
