// Route test for GET /app-icons/:id (src/routes/app-icons.js): the
// public homescreen-icon image endpoint. Contracts pinned here: a
// stored icon is served with its content type and the year-long
// immutable cache header; anything that isn't a 32-hex id (or doesn't
// exist) 404s without touching more than one query.
//
// Same harness shape as tests/home-app-activity-counts.test.js:
// override getPool BEFORE requiring the route module, mount the router
// on a real express app, and hit it over HTTP.
//
// Run with: node --test tests/app-icons-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

const { appIconRoutes } = require('../src/routes/app-icons');
const express = require('express');

function startServer() {
  const app = express();
  app.use(appIconRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GOOD_ID = 'a'.repeat(32);

test('serves a stored icon with content type and immutable cache header', async () => {
  poolQueryHandler = async (sql, params) => {
    assert.deepEqual(params, [GOOD_ID]);
    return { rows: [{ content_type: 'image/png', data: PNG_BYTES }] };
  };
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-icons/${GOOD_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(PNG_BYTES));
  } finally {
    server.close();
  }
});

test('unknown id 404s', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-icons/${'f'.repeat(32)}`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('malformed ids 404 without querying the DB', async () => {
  let queried = false;
  poolQueryHandler = async () => { queried = true; return { rows: [] }; };
  const server = await startServer();
  try {
    for (const bad of ['short', 'Z'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/app-icons/${bad}`);
      assert.equal(res.status, 404, `expected 404 for ${bad}`);
    }
    assert.equal(queried, false);
  } finally {
    server.close();
  }
});

// ── An emoji app's home-screen icon (/app-icons/emoji/…) ────────────────

test('an emoji tile is drawn by its name alone, immutable, and reads no row', async () => {
  let reads = 0;
  poolQueryHandler = async () => { reads += 1; return { rows: [] }; };
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/app-icons/emoji`;
  try {
    const res = await fetch(`${base}/1f4ca-0ea5e9.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const { PNG } = require('pngjs');
    const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    assert.equal(png.width, 480);
    assert.deepEqual([...png.data.subarray(0, 4)], [0x0e, 0xa5, 0xe9, 255], 'on the colour it names');
    assert.equal((await fetch(`${base}/1f5f3.png`)).status, 200, 'no colour: the cream ground');
    // Only the one spelling of a committed picture.
    for (const bad of ['1f5f3_fe0f.png', '1F4CA.png', '1fa81.png', '1f4ca-0EA5E9.png', '1f4ca-fff.png',
      '1f4ca.svg', '110000.png', '..%2F1f4ca.png', 'x.png']) {
      assert.equal((await fetch(`${base}/${bad}`)).status, 404, bad);
    }
    assert.equal(reads, 0);
  } finally {
    server.close();
  }
});

test('the tile path the install page offers is the one this serves', () => {
  const tile = require('../src/services/emoji-tile');
  assert.equal(tile.tilePath('📊', '#0EA5E9'), '/app-icons/emoji/1f4ca-0ea5e9.png');
  assert.equal(tile.tilePath('🗳️'), '/app-icons/emoji/1f5f3.png', 'without the variation selector');
  assert.equal(tile.tilePath('📊', 'red'), '/app-icons/emoji/1f4ca.png', 'a colour that is not hex is no colour');
  assert.equal(tile.tilePath('🪁'), null, 'no picture, no path');
  const fs = require('node:fs');
  const route = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'routes', 'app-icons.js'), 'utf8');
  assert.match(route, /router\.get\('\/app-icons\/emoji\/:file', emojiTileLimiter,/, 'rate limited: it draws on the server');
});
