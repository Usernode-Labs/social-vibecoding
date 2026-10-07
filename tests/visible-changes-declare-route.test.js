'use strict';

// The hosted build turn's declare_visible_changes reaches
// POST /api/internal/sessions/:id/visible-changes (src/routes/internal.js).
// Besides recording the declaration, it tells the building agent whose
// browser the shots agent will use when that cannot show the change, while
// the agent can still declare again.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'declare-route-test-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'declare-route-test-secret';

const queries = [];
let appRow = { id: 7, slug: 'vote-inbox' };
require('../src/db/pool').getPool = () => ({
  async query(sql, params) {
    queries.push({ sql, params });
    return { rows: appRow ? [appRow] : [] };
  },
});

const shotsState = require('../src/services/shots-state');
const shotsIdentities = require('../src/services/shots-identities');
const platformJwt = require('../src/services/platform-jwt');
const { internalRoutes } = require('../src/routes/internal');

async function serve(t) {
  const app = express();
  app.use(express.json());
  app.use(internalRoutes({ jwtSecret: process.env.JWT_SECRET, selfAppSlug: 'usernode-self', shots: { collect: true } }));
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/internal/sessions/42/visible-changes`;
}

function stub(t, object, key, value) {
  const original = object[key];
  object[key] = value;
  t.after(() => { object[key] = original; });
}

const declare = async (url, intent) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${platformJwt.signWorkerToken({ sessionId: 42 })}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ intent }),
  });
  return { status: response.status, body: await response.json() };
};

test('a recorded declaration carries the persona warnings for its app', async (t) => {
  const intent = { version: 1, impact: 'ui', stories: [{ id: 'summary-line', persona: 'guest', claim: 'A line.' }] };
  stub(t, shotsState, 'recordIntent', async (_pool, sessionId, raw) => ({
    accepted: true, unchanged: false, required: true, state: 'planned', intent: raw, runId: null, sessionId,
  }));
  const seen = [];
  stub(t, shotsIdentities, 'personaWarnings', async (_pool, app, declared, options) => {
    seen.push({ app, declared, options });
    return ['summary-line is declared for guest, but this app is private.'];
  });
  const url = await serve(t);

  const answered = await declare(url, intent);
  assert.equal(answered.status, 200);
  assert.equal(answered.body.ok, true);
  assert.equal(answered.body.shots.state, 'planned');
  assert.deepEqual(answered.body.warnings, ['summary-line is declared for guest, but this app is private.']);
  assert.deepEqual(seen[0].app, appRow, 'the proposal\'s own app');
  assert.deepEqual(seen[0].declared, intent);
  assert.deepEqual(seen[0].options, { selfApp: false });
  assert.deepEqual(queries.at(-1).params, [42]);

  // No warnings, no field; a lookup that fails never fails the declaration.
  stub(t, shotsIdentities, 'personaWarnings', async () => []);
  assert.equal(Object.hasOwn((await declare(url, intent)).body, 'warnings'), false);
  stub(t, shotsIdentities, 'personaWarnings', async () => { throw new Error('visibility lookup failed'); });
  const failedLookup = await declare(url, intent);
  assert.equal(failedLookup.status, 200);
  assert.equal(failedLookup.body.ok, true);
  assert.equal(Object.hasOwn(failedLookup.body, 'warnings'), false);
});
