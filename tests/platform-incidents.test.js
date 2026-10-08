'use strict';

// Unexpected errors (services/platform-incidents.js), the parts that need no
// database: the day clamp, the record path's never-fail contract, and the
// words the page and the alerts say. The database behaviour — the filtered
// read, the burst threshold and the daily digest — is pinned against real
// PostgreSQL in tests/platform-incidents-postgres.test.js.
//
// Run with: node --test tests/platform-incidents.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const incidents = require('../src/services/platform-incidents');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('the day clamp keeps the page to the ranges it offers', () => {
  assert.deepEqual(incidents.RANGES, [1, 7, 30]);
  assert.equal(incidents.clampDays(7), 7);
  assert.equal(incidents.clampDays(1), 1);
  assert.equal(incidents.clampDays(30), 30);
  assert.equal(incidents.clampDays('7'), 7, 'a query string is a number first');
  assert.equal(incidents.clampDays('banana'), 7, 'a hand-typed value is the default');
  assert.equal(incidents.clampDays(45), 7, 'an off-range number is the default too');
  assert.equal(incidents.clampDays(undefined), 7);
});

test('a new kind stays a single call: one entry in each word map, a threshold default', () => {
  assert.equal(incidents.LABELS.build_interrupted, 'Build interrupted');
  assert.equal(incidents.BURST_NOUNS.build_interrupted, 'builds interrupted');
  assert.equal(incidents.BURST_THRESHOLD_DEFAULT, 3);
  assert.equal(incidents.BURST_WINDOW_HOURS, 1);
  assert.equal(incidents.DIGEST_HOUR_UTC, 9);
});

test('record() writes the row and never lets the burst check fail it', async () => {
  const queries = [];
  const pool = {
    query(sql, params) {
      queries.push({ sql, params });
      // Everything the burst check needs to run fails, loudly.
      if (/pg_advisory_xact_lock|BEGIN|COMMIT/.test(sql)) {
        return Promise.reject(new Error('burst check exploded'));
      }
      return Promise.resolve({ rows: [] });
    },
  };
  await assert.doesNotReject(() => incidents.record(pool, {
    kind: 'build_interrupted', appId: 7, sessionId: 3,
    detail: { why: 'the worker is gone', outcome: 'resumed', runId: 9 },
  }));
  const insert = queries.find((q) => /INSERT INTO events/.test(q.sql));
  assert.ok(insert, 'the incident is written');
  const metadata = JSON.parse(insert.params[4]);
  assert.equal(metadata.kind, 'build_interrupted');
  assert.equal(metadata.why, 'the worker is gone');
  assert.equal(insert.params[1], 7);
  assert.equal(insert.params[2], 3);
  // And the row-write's promise is the one record() resolves, so a caller
  // that awaits it waits for the incident, not for the alert.
  const resolved = await incidents.record(pool, { kind: 'build_interrupted' });
  assert.equal(resolved, undefined);
});

test('record() with no kind writes nothing', async () => {
  const queries = [];
  const pool = { query: (sql, params) => { queries.push({ sql, params }); return Promise.resolve({ rows: [] }); } };
  await incidents.record(pool, {});
  await incidents.record(pool, { kind: null });
  assert.equal(queries.length, 0);
});

test('record() chains the burst check after the insert resolves, out of the caller\'s way', () => {
  const source = read('src/services/platform-incidents.js');
  const recordBody = source.slice(source.indexOf('function record(pool'), source.indexOf('Count one kind in the burst window'));
  assert.match(recordBody, /Promise\.resolve\(written\)/, 'the burst check is chained, not awaited');
  assert.match(recordBody, /\.catch\(\(err\) => \{/, 'a failed burst check is caught, best-effort');
});