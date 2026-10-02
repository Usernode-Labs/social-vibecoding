'use strict';

// Under staging with ?demo=1 every admin Journey route answers a whole,
// labelled demo payload (#3369), in the same shape as the real one: the
// top-level keys pinned in tests/fixtures/journey-route-shapes.json, which
// tests/journey-routes.test.js checks the real payloads against.

process.env.USERNODE_ENV = 'staging';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'journey-route-shapes.json'), 'utf8'));

require('../src/db/pool').getPool = () => ({
  async query() { throw new Error('a demo answer must not read the database'); },
  async connect() { throw new Error('a demo answer must not read the database'); },
});
const express = require('express');
const { adminRoutes } = require('../src/routes/admin');

test('every Journey route has a labelled demo payload with the real shape', async (t) => {
  const appX = express();
  appX.use((req, _res, next) => { req.user = { id: 1, username: 'lead', isAdmin: true }; next(); });
  appX.use(adminRoutes({ jwtSecret: 'test' }));
  const server = appX.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const paths = {
    summary: '/api/admin/journey/summary',
    cohorts: '/api/admin/journey/cohorts',
    firstMile: '/api/admin/journey/first-mile?admitted=2026-10-05',
    stages: '/api/admin/journey/stages',
    loops: '/api/admin/journey/loops',
    nextSteps: '/api/admin/journey/next-steps',
    person: '/api/admin/journey/people/900102',
    leftOut: '/api/admin/journey/left-out',
  };
  for (const [key, p] of Object.entries(paths)) {
    const res = await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}demo=1`);
    assert.equal(res.status, 200, key);
    const body = await res.json();
    assert.equal(body.demo, true, `${key} says it is a demo`);
    const keys = Object.keys(body).filter((k) => k !== 'demo').sort();
    assert.deepEqual(keys, Object.keys(pinned[key]).sort(), `${key}: same top-level keys as the real payload`);
  }
  const loops = await (await fetch(`${base}/api/admin/journey/loops?demo=1`)).json();
  assert.deepEqual(loops.change.atStep.hear_back, { status: 'coming' }, 'Hear back is coming in the demo too');
});
