'use strict';

// #4482: a C comment's pin and words stored as DATA beside the clean
// screenshot, and read back for the request page's toggleable overlay.
//
//   * validateScreenshotPin's rules (both-or-neither, bounds, 600-char cap);
//   * the upload route's INSERT carrying the three new columns — against a
//     REAL PostgreSQL, the way the row is actually written and read;
//   * GET /issue-images/:id/pin answering JSON, 404 for a row without a
//     pin, and public on the same pre-auth router as the image.
//
// The pure rules run standalone; the route halves hit the routers over
// HTTP, and the INSERT's round trip runs against a throwaway database
// (schema.sql applied), skipped when no server is reachable — the same
// contract as tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const poolMod = require('../src/db/pool');
let poolQueries = [];
let poolHandler = async () => ({ rows: [] });
// feedback.js destructures `const { getPool } = require('../db/pool')` at
// require time, so the route holds THIS binding, not the module property:
// the throwaway database is handed over through poolOverride below, never
// by reassigning poolMod.getPool.
let poolOverride = null;
poolMod.getPool = () => poolOverride ?? {
  query: async (sql, params) => {
    poolQueries.push({ sql: String(sql), params });
    return poolHandler(String(sql), params);
  },
};

const llm = require('../src/services/llm');
llm.generateIssueTitle = async () => ({ title: 'Generated title', usage: undefined, model: 'claude-haiku-4-5' });

const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};

process.env.GITHUB_BOT_TOKEN = 'test-pat';
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('api.github.com')) {
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 42, html_url: 'https://github.com/plat/repo/issues/42' }),
    };
  }
  return realFetch(url, opts);
};

const {
  feedbackRoutes,
  validateScreenshotPin,
  MAX_PIN_COORD,
  MAX_PIN_COMMENT_CHARS,
} = require('../src/routes/feedback');
const { issueImageRoutes } = require('../src/routes/issue-images');
const express = require('express');

function startServer(userId, username) {
  const app = express();
  app.use((req, res, next) => { req.user = { id: userId, username }; next(); });
  app.use(express.json());
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  app.use(issueImageRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

// ── The pin's rules ───────────────────────────────────────────────────

test('validateScreenshotPin: no params, no pin', () => {
  assert.deepEqual(validateScreenshotPin({}), { ok: true, pin: null });
  assert.deepEqual(validateScreenshotPin(undefined), { ok: true, pin: null });
});

test('validateScreenshotPin: both or neither', () => {
  assert.equal(validateScreenshotPin({ pin_x: '10' }).ok, false);
  assert.equal(validateScreenshotPin({ pin_y: '10' }).ok, false);
  assert.deepEqual(validateScreenshotPin({ pin_x: '10', pin_y: '20' }), { ok: true, pin: { x: 10, y: 20, comment: null } });
});

test('validateScreenshotPin: integers inside the bounds', () => {
  assert.equal(validateScreenshotPin({ pin_x: '10.5', pin_y: '20' }).ok, false);
  assert.equal(validateScreenshotPin({ pin_x: '-1', pin_y: '20' }).ok, false);
  assert.equal(validateScreenshotPin({ pin_x: `${MAX_PIN_COORD + 1}`, pin_y: '20' }).ok, false);
  assert.equal(validateScreenshotPin({ pin_x: 'abc', pin_y: '20' }).ok, false);
  assert.equal(validateScreenshotPin({ pin_x: '', pin_y: '20' }).ok, false, 'an empty string is not a number');
  assert.deepEqual(validateScreenshotPin({ pin_x: '0', pin_y: `${MAX_PIN_COORD}` }), { ok: true, pin: { x: 0, y: MAX_PIN_COORD, comment: null } });
});

test('validateScreenshotPin: the comment is optional, trimmed, capped', () => {
  const withWords = validateScreenshotPin({ pin_x: '1', pin_y: '2', comment: '  words here  ' });
  assert.deepEqual(withWords, { ok: true, pin: { x: 1, y: 2, comment: 'words here' } });
  const long = 'x'.repeat(MAX_PIN_COMMENT_CHARS + 1);
  assert.equal(validateScreenshotPin({ pin_x: '1', pin_y: '2', comment: long }).ok, false);
  assert.equal(validateScreenshotPin({ pin_x: '1', pin_y: '2', comment: 'x'.repeat(MAX_PIN_COMMENT_CHARS) }).ok, true);
  assert.deepEqual(validateScreenshotPin({ pin_x: '1', pin_y: '2', comment: '   ' }), { ok: true, pin: { x: 1, y: 2, comment: null } }, 'blank words are no words');
});

// ── The upload stores the pin; the round trip against real PostgreSQL ──

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the upload INSERT stores pin_x, pin_y and pin_comment, read back through the pin route', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  let up = false;
  try { await admin.query('SELECT 1'); up = true; } catch { /* no server */ }
  if (!up) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL set but unreachable');
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = 'pins_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema, []); // the boot migration is idempotent

  // One real user to own the rows.
  const { rows: users } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('pin_tester', 'x') RETURNING id`
  );
  const userId = users[0].id;

  // Point the route's pool at the throwaway database (through the stub
  // above — reassigning poolMod.getPool cannot reach the route).
  poolOverride = pool;
  t.after(() => { poolOverride = null; });

  const server = await startServer(userId, 'pin_tester');
  const port = server.address().port;
  t.after(() => server.close());

  let pinnedId = null;

  const upload = async (query) => realFetch(`http://127.0.0.1:${port}/api/feedback/screenshot${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: PNG,
  });

  await t.test('a pinned upload stores the three columns beside the clean bytes', async () => {
    const res = await upload('?pin_x=640&pin_y=512&comment=' + encodeURIComponent('Keep this toggleable'));
    assert.equal(res.status, 200);
    const { id } = await res.json();
    pinnedId = id;
    const { rows } = await pool.query(
      'SELECT pin_x, pin_y, pin_comment, size_bytes FROM issue_screenshots WHERE id = $1', [id]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].pin_x, 640);
    assert.equal(rows[0].pin_y, 512);
    assert.equal(rows[0].pin_comment, 'Keep this toggleable');
    assert.equal(rows[0].size_bytes, PNG.length);
  });

  await t.test('an unpinned upload keeps the columns null', async () => {
    const res = await upload('');
    assert.equal(res.status, 200);
    const { id } = await res.json();
    const { rows } = await pool.query(
      'SELECT pin_x, pin_y, pin_comment FROM issue_screenshots WHERE id = $1', [id]
    );
    assert.equal(rows[0].pin_x, null);
    assert.equal(rows[0].pin_y, null);
    assert.equal(rows[0].pin_comment, null);
  });

  await t.test('the pin route answers the stored pin as JSON, publicly', async () => {
    const pinRes = await realFetch(`http://127.0.0.1:${port}/issue-images/${pinnedId}/pin`);
    assert.equal(pinRes.status, 200);
    assert.deepEqual(await pinRes.json(), { pinX: 640, pinY: 512, comment: 'Keep this toggleable' });
    assert.equal(pinRes.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(pinRes.headers.get('content-type'), 'application/json; charset=utf-8');
  });

  await t.test('a row without a pin 404s, as does a missing row or a bad id', async () => {
    const { rows } = await pool.query(
      `INSERT INTO issue_screenshots (id, user_id, content_type, size_bytes, data)
       VALUES ($1, $2, 'image/png', $3, $4) RETURNING id`,
      [crypto.randomBytes(16).toString('hex'), userId, PNG.length, PNG]
    );
    const bare = await realFetch(`http://127.0.0.1:${port}/issue-images/${rows[0].id}/pin`);
    assert.equal(bare.status, 404, 'no pin stored');
    const gone = await realFetch(`http://127.0.0.1:${port}/issue-images/${'f'.repeat(32)}/pin`);
    assert.equal(gone.status, 404, 'no such row');
    const bad = await realFetch(`http://127.0.0.1:${port}/issue-images/nope/pin`);
    assert.equal(bad.status, 404, 'malformed id');
  });

  await t.test('a malformed pin is a 400 and stores nothing', async () => {
    const res = await upload('?pin_x=99999');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /pin_x and pin_y/);
    const res2 = await upload('?pin_x=notanumber&pin_y=5');
    assert.equal(res2.status, 400);
    const res3 = await upload(`?pin_x=1&pin_y=2&comment=${encodeURIComponent('y'.repeat(MAX_PIN_COMMENT_CHARS + 1))}`);
    assert.equal(res3.status, 400);
  });
});
