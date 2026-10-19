'use strict';
// #5102: a child-safety report is the first reason, its case sorts to the top
// of the moderation queue, it is marked preserve_evidence when it is made,
// and the retention purge leaves a preserved case's evidence alone until a
// full administrator releases it (an audited moderation action).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');
const express = require('express');
const moderation = require('../src/services/moderation');
const { moderationRoutes } = require('../src/routes/moderation');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('child_safety is a known reason, listed first', () => {
  assert.equal(moderation.CHILD_SAFETY, 'child_safety');
  assert.equal([...moderation.REASONS][0], 'child_safety');
});

test('child-safety cases come first, keep their evidence, and only an audited release lets it expire (PostgreSQL)', async (t) => {
  const root = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await root.connect(); } catch (err) { await root.end().catch(() => {}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const name = `moderation_child_safety_${process.pid}`;
  const connectionsClosed = [];
  let pool, server;
  try {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    pool = new Pool({ connectionString: url.toString(), max: 5 });
    pool.on('connect', (client) => connectionsClosed.push(new Promise((resolve) => client.once('end', resolve))));
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    await pool.query(schema);
    await pool.query(schema); // idempotent: the column is added once
    const addUser = async (username) => (await pool.query(
      "INSERT INTO users (username,password,profile_published) VALUES ($1,'unused-test-password',TRUE) RETURNING id,username", [username])).rows[0];
    const reporter = await addUser('reporter');
    const flagged = await addUser('flagged-person');
    const spammer = await addUser('spam-person');
    const adminRow = (await pool.query("INSERT INTO users (username,password,is_admin) VALUES ('moderator','unused-test-password',TRUE) RETURNING id,username")).rows[0];
    const admin = { ...adminRow, isAdmin: true, canAdminWrite: true };
    await pool.query("INSERT INTO user_avatars (id,user_id,content_type,size_bytes,data,sha256) VALUES ('avatarflagged',$1,'image/png',5,$2,'x')", [flagged.id, Buffer.from('proof')]);

    // Created with the flag: a child-safety report marks its case; any other
    // reason does not.
    const childReport = await moderation.submitReport(pool, reporter, { targetType: 'user', target: flagged.username, reason: 'child_safety', detail: 'Fixture detail' });
    const spamReport = await moderation.submitReport(pool, reporter, { targetType: 'user', target: spammer.username, reason: 'spam' });
    const caseOf = async (reportId) => (await pool.query('SELECT c.* FROM moderation_cases c JOIN moderation_reports r ON r.case_id = c.id WHERE r.id = $1', [reportId])).rows[0];
    let childCase = await caseOf(childReport.id);
    let spamCase = await caseOf(spamReport.id);
    assert.equal(childCase.preserve_evidence, true, 'a child-safety report preserves its case');
    assert.equal(spamCase.preserve_evidence, false, 'other reasons keep the ordinary retention');

    // Many newer ordinary cases, so the child-safety case would be on page 2
    // if the queue were ordered by id alone.
    await pool.query(`INSERT INTO moderation_cases (target_type,target_id,target_label)
      SELECT 'app', 100000 + n, 'Fixture app ' || n FROM generate_series(1,60) n`);
    await pool.query(`INSERT INTO moderation_reports (case_id,cycle,reporter_user_id,reason)
      SELECT id, 1, NULL, 'spam' FROM moderation_cases WHERE target_type = 'app'`);

    const web = express(); web.use(express.json());
    const identities = { admin, readonly: { ...admin, canAdminWrite: false } };
    web.use((req, res, next) => { req.user = identities[req.get('x-test-user')]; next(); });
    web.use(moderationRoutes({}, { pool }));
    server = await new Promise((resolve) => { const s = web.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (route, who = 'admin', init = {}) => fetch(base + route, { ...init, headers: { 'x-test-user': who, 'Content-Type': 'application/json', ...init.headers } });

    const first = await (await get('/api/admin/moderation', 'readonly')).json();
    assert.equal(first.cases[0].id, childCase.id, 'the child-safety case leads the queue');
    assert.equal(first.cases[0].child_safety, true);
    assert.equal(first.cases[0].preserve_evidence, true, 'the queue carries the flag for the mark');
    assert.ok(first.cases.slice(1).every((c) => c.child_safety === false));
    assert.equal(first.cases.length, 50);
    assert.ok(first.next && !first.next.startsWith('c'), 'the cursor is past the child-safety group');
    const second = await (await get(`/api/admin/moderation?before=${first.next}`, 'readonly')).json();
    const all = [...first.cases, ...second.cases].map((c) => Number(c.id));
    assert.equal(all.length, 62, 'every open case appears once across the pages');
    assert.equal(new Set(all).size, 62);
    const rest = all.slice(1);
    assert.deepEqual(rest, [...rest].sort((a, b) => b - a), 'newest first after the child-safety group');
    // A cursor inside the child-safety group continues it, then the rest.
    const fromGroup = await (await get(`/api/admin/moderation?before=c${childCase.id}`, 'readonly')).json();
    assert.equal(fromGroup.cases.length, 50);
    assert.ok(fromGroup.cases.every((c) => !c.child_safety));
    // The reason filter knows the new reason.
    const filtered = await (await get('/api/admin/moderation?reason=child_safety', 'readonly')).json();
    assert.deepEqual(filtered.cases.map((c) => Number(c.id)), [Number(childCase.id)]);

    // Close both, then let the 180-day and one-year clocks run out.
    const act = async (caseId, action, who = admin) => {
      const c = (await pool.query('SELECT revision FROM moderation_cases WHERE id = $1', [caseId])).rows[0];
      return moderation.moderate(pool, who, caseId, { action, reason: 'Reviewed by a moderator', revision: c.revision });
    };
    await act(childCase.id, 'dismiss');
    await act(spamCase.id, 'dismiss');
    await pool.query("UPDATE moderation_cases SET closed_at = NOW() - INTERVAL '400 days' WHERE id = ANY($1)", [[childCase.id, spamCase.id]]);
    await pool.query("UPDATE moderation_actions SET created_at = NOW() - INTERVAL '400 days' WHERE case_id = ANY($1)", [[childCase.id, spamCase.id]]);
    await moderation.purgeExpired(pool);

    const reportsOf = async (caseId) => (await pool.query('SELECT * FROM moderation_reports WHERE case_id = $1', [caseId])).rows;
    const childRows = await reportsOf(childCase.id);
    assert.equal(childRows.length, 1, 'a preserved case keeps its reports past a year');
    assert.equal(childRows[0].evidence.username, 'flagged-person', 'and its evidence snapshot');
    assert.equal(childRows[0].detail, 'Fixture detail');
    const files = await pool.query('SELECT f.data FROM moderation_report_files rf JOIN moderation_evidence_files f ON f.id = rf.file_id WHERE rf.report_id = $1', [childReport.id]);
    assert.equal(files.rows[0].data.toString(), 'proof', 'and its evidence files');
    assert.equal((await pool.query('SELECT 1 FROM moderation_actions WHERE case_id = $1', [childCase.id])).rowCount, 1, 'and its audit');
    assert.equal((await reportsOf(spamCase.id)).length, 0, 'an ordinary case past a year is gone');
    assert.equal((await pool.query('SELECT 1 FROM moderation_actions WHERE case_id = $1', [spamCase.id])).rowCount, 0);

    // Releasing the hold: a full administrator, with a reason, on a preserved
    // case only; it is recorded and leaves the case's status alone.
    await assert.rejects(act(childCase.id, 'release_evidence', { ...admin, canAdminWrite: false }), { status: 403 });
    const ordinary = await moderation.submitReport(pool, reporter, { targetType: 'user', target: spammer.username, reason: 'spam' });
    await assert.rejects(act((await caseOf(ordinary.id)).id, 'release_evidence'), { status: 409 });
    const readonlyHttp = await get(`/api/admin/moderation/${childCase.id}/actions`, 'readonly', { method: 'POST', body: JSON.stringify({ action: 'release_evidence', reason: 'x', revision: 1 }) });
    assert.equal(readonlyHttp.status, 403);
    const released = await act(childCase.id, 'release_evidence');
    assert.equal(released.status, 'dismissed');
    childCase = (await pool.query('SELECT * FROM moderation_cases WHERE id = $1', [childCase.id])).rows[0];
    assert.equal(childCase.preserve_evidence, false);
    const audit = (await pool.query("SELECT actor_id, reason FROM moderation_actions WHERE case_id = $1 AND action = 'release_evidence'", [childCase.id])).rows;
    assert.deepEqual(audit, [{ actor_id: admin.id, reason: 'Reviewed by a moderator' }]);
    await assert.rejects(act(childCase.id, 'release_evidence'), { status: 409 });
    await moderation.purgeExpired(pool);
    assert.equal((await reportsOf(childCase.id)).length, 0, 'once released, the ordinary clock applies');

    // A new child-safety report on a released case preserves it again.
    await moderation.submitReport(pool, reporter, { targetType: 'user', target: flagged.username, reason: 'child_safety' });
    assert.equal((await pool.query('SELECT preserve_evidence FROM moderation_cases WHERE id = $1', [childCase.id])).rows[0].preserve_evidence, true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    await Promise.all(connectionsClosed);
    await root.query(`DROP DATABASE IF EXISTS ${name}`);
    await root.end();
  }
});
