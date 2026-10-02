'use strict';

// The Journey page's left-out list (#3369): test accounts, and people who
// objected to being recorded. Real schema in a throwaway database, required
// when TEST_DATABASE_URL is set, skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const leftOut = require('../src/services/journey-left-out');

test('entries parse defensively: one per person, known reasons, bounded notes', () => {
  const entries = leftOut.parseEntries(JSON.stringify([
    { userId: 5, reason: 'test', note: 'x'.repeat(500), addedBy: 1, addedAt: '2026-10-02T10:00:00Z' },
    { userId: 5, reason: 'objected' },
    { userId: 6, reason: 'something' },
    { userId: -1, reason: 'test' },
    'junk',
  ]));
  assert.deepEqual(entries.map((e) => [e.userId, e.reason]), [[5, 'test']], 'the first entry for a person wins');
  assert.equal(entries[0].note.length, leftOut.NOTE_MAX);
  assert.deepEqual(leftOut.parseEntries('not json'), []);
  assert.deepEqual(leftOut.parseEntries('{}'), []);
});

test('the list: add, replace, object (erasing and stopping telemetry), remove, and who may change it',
  { timeout: 120000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'journey_left_out_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    let server = null;
    t.after(async () => {
      if (server) await new Promise((r) => server.close(r));
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    const { rows: people } = await pool.query(
      `INSERT INTO users (username, password, is_admin, admin_readonly) VALUES
         ('lead', 'x', TRUE, FALSE), ('viewer', 'x', TRUE, TRUE), ('tester', 'x', FALSE, FALSE),
         ('objector', 'x', FALSE, FALSE), ('member', 'x', FALSE, FALSE)
       RETURNING id, username`
    );
    const [lead, viewer, tester, objector, member] = people;
    const telemetry = require('../src/services/ui-telemetry');
    for (const who of [objector, member]) {
      await pool.query(
        `INSERT INTO events (user_id, event_type, metadata) VALUES
           ($1, 'ui_experience', '{"kind":"screen_visit","screen":"home"}'),
           ($1, 'ui_telemetry_delivery', '{"batchId":"b"}'),
           ($1, 'pr_vote_cast', '{}')`,
        [who.id]
      );
    }

    await leftOut.add(pool, { userId: tester.id, reason: 'test', note: 'QA phone' }, { actorId: lead.id });
    assert.equal(await telemetry.isRecordable(pool, { id: tester.id, username: 'tester' }), true,
      'a test account is left out of the numbers but still recorded');

    const objected = await leftOut.add(pool, { userId: objector.id, reason: 'objected', note: 'asked by email' },
      { actorId: lead.id });
    assert.equal(objected.erased, 2, 'both observations and receipts are erased');
    const left = await pool.query('SELECT event_type FROM events WHERE user_id = $1', [objector.id]);
    assert.deepEqual(left.rows.map((r) => r.event_type), ['pr_vote_cast'], 'nothing else of theirs is touched');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM events WHERE user_id = $1', [member.id])).rows[0].n, 3,
      'nobody else is touched');
    assert.equal(await telemetry.isRecordable(pool, { id: objector.id, username: 'objector' }), false,
      'an objector is no longer recorded');
    assert.equal(await telemetry.isRecordable(pool, { id: member.id, username: 'member' }), true);

    await leftOut.add(pool, { userId: tester.id, reason: 'test', note: 'renamed' }, { actorId: lead.id });
    const listed = await leftOut.list(pool);
    assert.deepEqual(listed.map((e) => [e.username, e.reason, e.note, e.addedBy]).sort(), [
      ['objector', 'objected', 'asked by email', 'lead'],
      ['tester', 'test', 'renamed', 'lead'],
    ], 'one entry per person; adding again replaces it');
    const ids = await leftOut.idsByReason(pool);
    assert.deepEqual([[...ids.test], [...ids.objected]], [[tester.id], [objector.id]]);

    await assert.rejects(leftOut.add(pool, { userId: 999999, reason: 'test' }), /no such person/);
    await assert.rejects(leftOut.add(pool, { userId: member.id, reason: 'vip' }), /Choose a reason/);
    await assert.rejects(leftOut.add(pool, { userId: member.id, reason: 'test', note: 'x'.repeat(201) }), /under 200/);

    // The routes, mounted as the server mounts them.
    require('../src/db/pool').getPool = () => pool;
    const express = require('express');
    const { adminRoutes } = require('../src/routes/admin');
    let current = null;
    const appX = express();
    appX.use(express.json());
    appX.use((req, _res, next) => { req.user = current; next(); });
    appX.use(adminRoutes({ jwtSecret: 'test' }));
    server = appX.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (who, method, pathName, body) => {
      current = who;
      const res = await fetch(base + pathName, {
        method, redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch { /* not JSON */ }
      return { status: res.status, json };
    };
    const asAdmin = { id: lead.id, username: 'lead', isAdmin: true, canAdminWrite: true };
    const asViewer = { id: viewer.id, username: 'viewer', isAdmin: true, canAdminWrite: false };
    const asMember = { id: member.id, username: 'member', isAdmin: false };

    const read = await call(asViewer, 'GET', '/api/admin/journey/left-out');
    assert.equal(read.status, 200, 'a view-only admin can read the list');
    assert.equal(read.json.people.length, 2);
    const viewerAdd = await call(asViewer, 'POST', '/api/admin/journey/left-out', { userId: member.id, reason: 'test' });
    assert.ok(viewerAdd.status >= 400, 'a view-only admin cannot change it');
    const memberRead = await call(asMember, 'GET', '/api/admin/journey/left-out');
    assert.notEqual(memberRead.status, 200, 'it is not served to a non-admin');

    const added = await call(asAdmin, 'POST', '/api/admin/journey/left-out', { userId: member.id, reason: 'test', note: 'x' });
    assert.equal(added.status, 200);
    assert.equal(added.json.erased, 0);
    const bad = await call(asAdmin, 'POST', '/api/admin/journey/left-out', { userId: member.id, reason: 'nope' });
    assert.equal(bad.status, 400);
    const removed = await call(asAdmin, 'DELETE', `/api/admin/journey/left-out/${objector.id}`);
    assert.equal(removed.status, 200);
    assert.equal(await telemetry.isRecordable(pool, { id: objector.id, username: 'objector' }), true,
      'removing an objection starts recording again');
    const again = await call(asAdmin, 'DELETE', `/api/admin/journey/left-out/${objector.id}`);
    assert.equal(again.status, 404);
  });
