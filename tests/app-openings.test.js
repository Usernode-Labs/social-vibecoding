'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const openings = require('../src/services/app-openings');
const { appRoutes } = require('../src/routes/apps');

const OPENING_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = new Date('2026-10-01T10:00:00.000Z');

test('opening payloads are exact and bound the browser clock', () => {
  const accepted = openings.parseOpening({
    openingId: OPENING_ID.toUpperCase(),
    occurredAt: '2026-10-01T09:58:00.000Z',
  }, NOW);
  assert.deepEqual(accepted, {
    openingId: OPENING_ID,
    occurredAt: '2026-10-01T09:58:00.000Z',
    receivedAt: NOW.toISOString(),
    timestampSource: 'client',
  });

  const tooOld = openings.parseOpening({
    openingId: OPENING_ID,
    occurredAt: new Date(NOW.getTime() - openings.MAX_OCCURRENCE_AGE_MS - 1).toISOString(),
  }, NOW);
  assert.equal(tooOld.occurredAt, NOW.toISOString());
  assert.equal(tooOld.timestampSource, 'received');

  const tooFuture = openings.parseOpening({
    openingId: OPENING_ID,
    occurredAt: new Date(NOW.getTime() + openings.MAX_FUTURE_SKEW_MS + 1).toISOString(),
  }, NOW);
  assert.equal(tooFuture.occurredAt, NOW.toISOString());
  assert.equal(tooFuture.timestampSource, 'received');

  const slightlyFuture = openings.parseOpening({
    openingId: OPENING_ID,
    occurredAt: new Date(NOW.getTime() + 30_000).toISOString(),
  }, NOW);
  assert.equal(slightlyFuture.occurredAt, NOW.toISOString(),
    'a fast browser clock cannot order the opening after later server events');
  assert.equal(slightlyFuture.timestampSource, 'received');

  assert.throws(() => openings.parseOpening({ openingId: 'nope', occurredAt: NOW.toISOString() }, NOW), /UUID/);
  assert.throws(() => openings.parseOpening({
    openingId: OPENING_ID, occurredAt: NOW.toISOString(), source: 'forged',
  }, NOW), /only openingId and occurredAt/);
});

function routePool({ blocked = false } = {}) {
  const rowsByOpening = new Map();
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/FROM apps WHERE slug = \$1/.test(text)) {
        return { rows: [{
          id: 22,
          slug: params[0],
          created_by: 7,
          self_hosted: false,
          collab_visibility: 'public',
          view_visibility: 'public',
          moderation_suspended_at: null,
        }] };
      }
      if (/FROM user_app_blocks/.test(text)) {
        return { rows: blocked ? [{ app_id: 22 }] : [] };
      }
      if (/INSERT INTO events/.test(text)) {
        const metadata = JSON.parse(params[3]);
        const key = `${params[0]}:${params[1]}:${metadata.openingId}`;
        if (rowsByOpening.has(key)) return { rows: [], rowCount: 0 };
        const row = { created_at: new Date(params[4]), metadata };
        rowsByOpening.set(key, row);
        return { rows: [row], rowCount: 1 };
      }
      if (/FROM events/.test(text) && /openingId/.test(text)) {
        const key = `${params[0]}:${params[1]}:${params[2]}`;
        return { rows: rowsByOpening.has(key) ? [rowsByOpening.get(key)] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function withRoute(pool, user, run) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(appRoutes({}, { pool }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, body) {
  const response = await fetch(`${base}/api/apps/coffee/openings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('opening collection is authenticated, access-guarded, awaited and idempotent', async () => {
  const unauthenticated = routePool();
  await withRoute(unauthenticated, null, async (base) => {
    const { response } = await post(base, { openingId: OPENING_ID, occurredAt: new Date().toISOString() });
    assert.equal(response.status, 401);
    assert.equal(unauthenticated.calls.length, 0, 'authentication fails before app lookup or analytics write');
  });

  const blocked = routePool({ blocked: true });
  await withRoute(blocked, { id: 7 }, async (base) => {
    const { response } = await post(base, { openingId: OPENING_ID, occurredAt: new Date().toISOString() });
    assert.equal(response.status, 404);
    assert.equal(blocked.calls.some(({ sql }) => /INSERT INTO events/.test(sql)), false);
  });

  const allowed = routePool();
  await withRoute(allowed, { id: 7 }, async (base) => {
    const input = { openingId: OPENING_ID, occurredAt: new Date().toISOString() };
    const first = await post(base, input);
    const replay = await post(base, input);
    assert.equal(first.response.status, 201);
    assert.equal(replay.response.status, 200);
    assert.equal(first.body.duplicate, false);
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.openedAt, first.body.openedAt);
    assert.equal(replay.body.receivedAt, first.body.receivedAt);

    const insert = allowed.calls.find(({ sql }) => /INSERT INTO events/.test(sql));
    assert.equal(insert.params[2], 'dapp_opened');
    const metadata = JSON.parse(insert.params[3]);
    assert.deepEqual({ ...metadata, receivedAt: '<timestamp>' }, {
      openingId: OPENING_ID,
      source: 'app_tab',
      receivedAt: '<timestamp>',
      timestampSource: 'client',
    });
    assert.match(metadata.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('the real unique index collapses a repeated opening', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE events (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER,
      app_id INTEGER,
      event_type VARCHAR(64) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE UNIQUE INDEX idx_test_dapp_opening_key
      ON events (user_id, app_id, (metadata->>'openingId'))
      WHERE event_type = 'dapp_opened' AND metadata ? 'openingId'`);
    const opening = openings.parseOpening({
      openingId: OPENING_ID,
      occurredAt: NOW.toISOString(),
    }, NOW);
    const first = await openings.record(client, { userId: 7, appId: 22, opening });
    const replay = await openings.record(client, { userId: 7, appId: 22, opening });
    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    const stored = await client.query('SELECT event_type, metadata, created_at FROM events');
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].event_type, 'dapp_opened');
    assert.equal(stored.rows[0].created_at.toISOString(), NOW.toISOString());
    assert.deepEqual(stored.rows[0].metadata, {
      openingId: OPENING_ID,
      source: 'app_tab',
      receivedAt: NOW.toISOString(),
      timestampSource: 'client',
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
