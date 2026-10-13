'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Client, Pool } = require('pg');
const { seedStagingGeneralChannel } = require('../src/db/migrate');
const { demoConversations, demoMessages } = require('../src/routes/conversations');
const { moderationRoutes } = require('../src/routes/moderation');

const savedEnvironment = process.env.USERNODE_ENV;
test.after(() => {
  if (savedEnvironment === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = savedEnvironment;
});

test('message report fixtures never write to production', async () => {
  process.env.USERNODE_ENV = 'production';
  await seedStagingGeneralChannel({ query() { assert.fail('must not seed production'); } });
});

test('demo inbox users can be reported through the real API with multiline details (PostgreSQL)', async t => {
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const root = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await root.connect(); }
  catch (err) { await root.end().catch(() => {}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const database = `demo_report_${crypto.randomBytes(6).toString('hex')}`;
  let pool, server;
  const connectionsClosed = [];
  try {
    await root.query(`CREATE DATABASE ${database}`);
    const url = new URL(dsn); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.toString() });
    pool.on('connect', client => connectionsClosed.push(new Promise(resolve => client.once('end', resolve))));
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const reporter = (await pool.query("INSERT INTO users(username,password) VALUES ('fixture-reporter','unused') RETURNING id,username")).rows[0];
    const unrelated = (await pool.query("INSERT INTO users(username,password,profile_published) VALUES ('ada','unused',TRUE) RETURNING id")).rows[0];
    const web = express(); web.use(express.json());
    web.use((req, _res, next) => { req.user = reporter; next(); });
    web.use(moderationRoutes({}, { pool }));
    server = await new Promise(resolve => { const s = web.listen(0, '127.0.0.1', () => resolve(s)); });
    const endpoint = `http://127.0.0.1:${server.address().port}/api/reports`;
    const send = username => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'user', target: username, reason: 'hate', detail: 'First line\n\nSecond line.' }) });
    const actors = new Map();
    for (const conversation of demoConversations(reporter)) {
      for (const user of [...conversation.members, conversation.peer, conversation.requester,
        ...demoMessages(reporter, conversation.id).map(message => message.sender)]) {
        if (user && user.id !== reporter.id) actors.set(user.id, user);
      }
    }
    assert.equal(actors.size, 2);
    const first = actors.values().next().value;
    assert.equal((await send(first.username)).status, 404, 'missing fixture reproduces Target unavailable');
    process.env.USERNODE_ENV = 'staging';
    await seedStagingGeneralChannel(pool);
    for (const actor of actors.values()) {
      const response = await send(actor.username);
      const receipt = await response.json();
      assert.equal(response.status, 202, JSON.stringify(receipt));
      assert.equal(receipt.blockUserId, actor.id);
      const report = (await pool.query(
        'SELECT c.target_user_id, r.detail, r.evidence FROM moderation_reports r JOIN moderation_cases c ON c.id = r.case_id WHERE r.id = $1',
        [receipt.id])).rows[0];
      assert.ok(report, 'the visible demo account reaches the moderation queue');
      assert.equal(report.detail, 'First line\n\nSecond line.');
      assert.equal(report.evidence.username, actor.username);
      assert.notEqual(report.target_user_id, unrelated.id, 'a real cloned account called ada is never targeted');
    }
    await pool.query('UPDATE users SET profile_published = FALSE WHERE id = $1', [first.id]);
    await seedStagingGeneralChannel(pool);
    assert.equal((await send(first.username)).status, 202, 'an existing preview fixture is repaired on restart');
    await pool.query('UPDATE users SET profile_published = FALSE, profile_disabled_at = NOW() WHERE id = $1', [first.id]);
    await seedStagingGeneralChannel(pool);
    assert.equal((await pool.query('SELECT profile_published FROM users WHERE id = $1', [first.id])).rows[0].profile_published, false,
      'boot never republishes a moderated profile');
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (pool) { await pool.end(); await Promise.all(connectionsClosed); }
    await root.query(`DROP DATABASE IF EXISTS ${database}`);
    await root.end();
  }
});
