'use strict';

// The waitlist idea, against the REAL schema in a throwaway PostgreSQL
// database, through the real session middleware and the new me-scoped read
// (src/routes/onboarding.js → services/waitlist.js waitlistIdeaFor). What
// the fakePool test above its seams cannot say: which ROW the linked and
// the email fallback actually pick.
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is
// set, like tests/first-session-persists-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the waitlist idea is read from the person\'s own row only, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 30000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'waitlist_idea_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6, connectionTimeoutMillis: 30000 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  require('../src/db/pool').getPool = () => pool;
  const ws = require('../src/services/ws');
  ws.pushNotificationToUser = () => {};
  ws.sendSystemMessage = async () => {};
  require('../src/services/events').record = async () => {};
  const cookieParser = require('cookie-parser');
  const { authMiddleware } = require('../src/middleware/auth');
  const { onboardingRoutes } = require('../src/routes/onboarding');

  const person = async (username, email = null) => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, email)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username, email`,
      [username, email]);
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [token, u.id]);
    return { ...u, token };
  };
  const row = async (email, answers, linkedTo = null) => {
    const { rows: [w] } = await pool.query(
      `INSERT INTO waitlist_signups (email, answers, linked_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [email, answers, linkedTo]);
    return w;
  };

  const server = express();
  server.use(express.json(), cookieParser());
  server.use(authMiddleware({}));
  server.use(onboardingRoutes({}));
  const listener = await new Promise((resolve) => { const s = server.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const get = async (who) => {
    const res = await fetch(`${base}/api/me/waitlist-idea`, { headers: { Cookie: `session=${who.token}` } });
    assert.equal(res.status, 200);
    return res.json();
  };

  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  // Linked: their row's answer, trimmed.
  const maya = await person('maya_wl', 'maya-wl@example.com');
  await row('maya-wl@example.com', { group: { need: '  A tracker for our run club.  ' } }, maya.id);
  assert.deepEqual(await get(maya), { idea: 'A tracker for our run club.' });

  // No link yet: the email fallback reads the unlinked row — the stage-2
  // survey was filled before the account existed.
  const owen = await person('owen_wl', 'owen-wl@example.com');
  await row('owen-wl@example.com', { group: { need: 'A poll for our movie nights.' } }, null);
  assert.deepEqual(await get(owen), { idea: 'A poll for our movie nights.' });

  // A row linked to a DIFFERENT account under the same address is never
  // read: the fallback matches unlinked rows only. (The waitlist row is
  // one per email; another person's account was linked to it in error, or
  // the address changed hands — either way it is not this person's idea.)
  const lena = await person('lena_wl', 'lena-wl@example.com');
  const bob = await person('bob_wl', null);
  await row('lena-wl@example.com', { group: { need: 'Bob\'s idea, not Lena\'s.' } }, bob.id);
  assert.deepEqual(await get(lena), { idea: null });

  // The row without the free-text answer: nothing to prefill. Answers
  // null, a group without a need, and whitespace only.
  const noor = await person('noor_wl', 'noor-wl@example.com');
  await row('noor-wl@example.com', null, noor.id);
  assert.deepEqual(await get(noor), { idea: null });
  const petra = await person('petra_wl', 'petra-wl@example.com');
  await row('petra-wl@example.com', { group: { name: 'Petra\'s club', need: '   ' } }, petra.id);
  assert.deepEqual(await get(petra), { idea: null });

  // An account with no email at all (users.email is nullable), matched on
  // linked_user_id alone.
  const hal = await person('hal_wl', null);
  await row('hal-wl@example.com', { group: { need: 'A trip planner for the troop.' } }, hal.id);
  assert.deepEqual(await get(hal), { idea: 'A trip planner for the troop.' });

  // No waitlist row at all.
  const wren = await person('wren_wl', 'wren-wl@example.com');
  assert.deepEqual(await get(wren), { idea: null });

  // And it serves the signed-in person only: no session, no answer.
  const res = await fetch(`${base}/api/me/waitlist-idea`);
  assert.equal(res.status, 401);
});
