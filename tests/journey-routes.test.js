'use strict';

// The admin Journey routes (#3369), mounted as the server mounts them, over
// the real schema in a throwaway database: required when TEST_DATABASE_URL is
// set, skipped when no server is reachable. The demo payloads are pinned
// against these same shapes in tests/journey-routes-demo.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SHAPES = path.join(__dirname, 'fixtures', 'journey-route-shapes.json');

// The keys of a payload, two levels down, for the shape comparison.
function shape(value, depth = 0) {
  if (Array.isArray(value)) return value.length && depth < 2 ? [shape(value[0], depth + 1)] : [];
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = depth < 2 ? shape(value[k], depth + 1) : typeof value[k];
    return out;
  }
  return typeof value;
}

test('every Journey route answers, refuses bad input, and is admins only', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'journey_routes_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server = null;
  t.after(async () => {
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows } = await pool.query(
    `INSERT INTO users (username, password, is_admin, has_platform_access, platform_access_granted_at) VALUES
       ('lead', 'x', TRUE, TRUE, NOW()), ('mia', 'x', FALSE, TRUE, NOW() - INTERVAL '1 day') RETURNING id`);
  const [lead, mia] = rows.map((r) => r.id);
  await pool.query("INSERT INTO waitlist_signups (email, released_at, linked_user_id) VALUES ('mia@example.test', NOW() - INTERVAL '2 days', $1)", [mia]);

  require('../src/db/pool').getPool = () => pool;
  const express = require('express');
  const { adminRoutes } = require('../src/routes/admin');
  let current = { id: lead, username: 'lead', isAdmin: true, canAdminWrite: false };
  const appX = express();
  appX.use(express.json());
  appX.use((req, _res, next) => { req.user = current; next(); });
  appX.use(adminRoutes({ jwtSecret: 'test' }));
  server = appX.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p, { headers: { Accept: 'application/json' }, redirect: 'manual' });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, json };
  };

  const admitted = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const paths = {
    summary: '/api/admin/journey/summary',
    cohorts: '/api/admin/journey/cohorts',
    firstMile: `/api/admin/journey/first-mile?admitted=${admitted}`,
    stages: '/api/admin/journey/stages',
    loops: '/api/admin/journey/loops',
    nextSteps: '/api/admin/journey/next-steps',
    person: `/api/admin/journey/people/${mia}`,
    leftOut: '/api/admin/journey/left-out',
  };
  const shapes = {};
  for (const [key, p] of Object.entries(paths)) {
    const res = await get(p);
    assert.equal(res.status, 200, `${key} answers a view-only admin`);
    assert.equal(res.json.demo, undefined, `${key} is real data outside staging`);
    shapes[key] = shape(res.json);
  }
  assert.equal((await get(paths.firstMile)).json.people[0].name, 'mia');
  assert.equal((await get('/api/admin/journey/cohorts')).json.cohorts[0].day, admitted);

  // The page's filters: all time, and one admit cohort.
  const allStages = (await get('/api/admin/journey/stages?week=all')).json;
  assert.equal(allStages.week, 'all');
  assert.equal(typeof allStages.counts.stay, 'number', 'Stay over all time is a count, not "known next week"');
  const allSummary = (await get('/api/admin/journey/summary?week=all')).json;
  assert.equal(allSummary.allTime, true);
  assert.notEqual(allSummary.groups.week, 'all', 'the North Star headline stays a week');
  assert.equal((await get('/api/admin/journey/loops?week=all')).status, 200);
  const cohortStages = (await get(`/api/admin/journey/stages?cohort=${admitted}`)).json;
  assert.ok(cohortStages.people.every((x) => x.userId === mia), 'a cohort narrows to its members');
  assert.equal((await get('/api/admin/journey/summary?week=all&cohort=other_way')).status, 200);

  for (const bad of ['/api/admin/journey/stages?week=2026-10-06', '/api/admin/journey/summary?week=monday',
    '/api/admin/journey/stages?cohort=yesterday', '/api/admin/journey/loops?cohort=2026-02-30',
    '/api/admin/journey/summary?week=all&cohort=x',
    '/api/admin/journey/first-mile', '/api/admin/journey/first-mile?admitted=2026-02-30',
    '/api/admin/journey/next-steps?admitted=x']) {
    assert.equal((await get(bad)).status, 400, bad);
  }
  assert.equal((await get('/api/admin/journey/people/999999')).status, 404);

  current = { id: mia, username: 'mia', isAdmin: false };
  for (const p of Object.values(paths)) assert.notEqual((await get(p)).status, 200, `${p} is not served to a non-admin`);

  // Kept for the demo comparison; regenerated whenever the shapes change.
  if (process.env.JOURNEY_WRITE_SHAPES === '1') fs.writeFileSync(SHAPES, `${JSON.stringify(shapes, null, 2)}\n`);
  const pinned = JSON.parse(fs.readFileSync(SHAPES, 'utf8'));
  for (const key of Object.keys(paths)) {
    assert.deepEqual(Object.keys(shapes[key]).sort(), Object.keys(pinned[key]).sort(),
      `${key}: the real payload's top-level keys match the pinned shapes the demo is checked against`);
  }
});
