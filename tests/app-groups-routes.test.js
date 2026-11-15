'use strict';

// #6669: the app-groups route against the real schema. An app creates a
// group, replaces its whole member list, and the governance read sees the
// new list at once (the write clears the facts cache). The 5,000 cap and
// unknown ids are checked through the real route, not a query string match.
//
// Run with: node --test tests/app-groups-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('an app creates and keeps a group its rules can name', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = 'app_groups_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  const token = 'e'.repeat(64);
  const { rows: [owner] } = await pool.query(
    "INSERT INTO users (username, password, has_platform_access) VALUES ('groups_owner', 'x', TRUE) RETURNING id, username"
  );
  const { rows: [maya] } = await pool.query(
    "INSERT INTO users (username, password, has_platform_access) VALUES ('groups_maya', 'x', TRUE) RETURNING id"
  );
  const { rows: [snait] } = await pool.query(
    "INSERT INTO users (username, password, has_platform_access) VALUES ('groups_snait', 'x', TRUE) RETURNING id"
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, status, groups_api_token, governance_rules)
     VALUES ('Gym Tracker', 'gym-tracker-6669', $1, 'running', $2, $3) RETURNING id`,
    [owner.id, token, {
      preset: null,
      groups: [{ name: 'App users', people: [], keptByApp: true, ids: [] }],
      rules: [{ group: 'app users', kind: 'atLeast', n: 1 }],
    }]
  );

  const { appGroupRoutes } = require('../src/routes/app-groups');
  const server = http.createServer(express().use(appGroupRoutes({}, { pool })));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/app-groups`;
  const call = (method, path, body) => fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-usernode-app-token': token },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  // Create is idempotent.
  assert.equal((await call('PUT', '/App%20users')).status, 200);
  assert.equal((await call('PUT', '/App%20users')).status, 200);

  const listed = await call('GET', '');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.groups.map((g) => [g.name, g.size, g.named, g.reportedAt]),
    [['App users', 0, true, null]]);

  // A built-in name and an over-long name are refused.
  assert.equal((await call('PUT', '/members')).status, 400);
  assert.equal((await call('PUT', `/${encodeURIComponent('x'.repeat(33))}`)).status, 400);

  // Replace whole: an unknown id is ignored and the list is exactly what
  // the app sent.
  const first = await call('PUT', '/App%20users/members', { userIds: [maya.id, 999999] });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, size: 1, ignored: 1 });
  const afterFirst = await call('GET', '');
  assert.equal(afterFirst.body.groups[0].size, 1);
  assert.ok(afterFirst.body.groups[0].reportedAt);

  // The governance read sees the reported people, then the replacement, at
  // once: the write cleared the cached facts.
  const governance = require('../src/services/governance');
  const gov = await governance.getGovernance(pool, app.id);
  const factsNow = await governance.rulesFacts(pool, app.id, gov, { fresh: true });
  assert.deepEqual(factsNow.groups.get('app users'), [maya.id]);

  await call('PUT', '/App%20users/members', { userIds: [snait.id] });
  const factsNext = await governance.rulesFacts(pool, app.id, gov, { fresh: true });
  assert.deepEqual(factsNext.groups.get('app users'), [snait.id]);

  // A list over the cap is refused.
  const tooMany = await call('PUT', '/App%20users/members', { userIds: new Array(5001).fill(maya.id) });
  assert.equal(tooMany.status, 413);

  // An empty list is valid and empties the group.
  const empty = await call('PUT', '/App%20users/members', { userIds: [] });
  assert.deepEqual(empty.body, { ok: true, size: 0, ignored: 0 });
});
