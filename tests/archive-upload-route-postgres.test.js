'use strict';

// #6994: the archive upload route and the create that links it, against the
// FULL PostgreSQL schema. The zip is built in memory, so the suite needs no
// fixture file.
//
// It pins:
//   * POST /api/apps/archive stores the bytes and answers { id, fileCount, name };
//   * it refuses a connector token and a disabled code host;
//   * POST /api/apps links the upload, refuses someone else's or a used one,
//     refuses one alongside a brief or a template, and starts no first version.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

// A create limiter would throttle the suite's own presses: this tests the
// route, not the per-minute bucket.
const rateLimits = require('../src/middleware/rate-limits');
rateLimits.appCreateLimiter = (_req, _res, next) => next();
const { appRoutes } = require('../src/routes/apps');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A store-only zip of a tiny site with a top-level index.html. */
function makeZip() {
  const entries = [
    { name: 'index.html', data: '<!doctype html><html><head></head><body>Ghost</body></html>' },
    { name: 'style.css', data: 'body{}' },
  ];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('archive upload and the create that links it', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `archive_upload_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  // The route uses the module-level pool from src/db/pool.
  require('../src/db/pool').getPool = () => pool;
  // No pushes, and a code host that exists (the archive route needs one).
  require('../src/services/notifications').hydrateAndPush = async () => {};
  require('../src/services/ws').pushNotificationToUser = () => {};
  const github = require('../src/services/github');
  let codeHost = true;
  github.isEnabled = () => codeHost;

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`,
    [username]
  )).rows[0];

  const express = require('express');
  let current = null;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = current;
    if (req.get('x-connector')) req.connectorClientId = req.get('x-connector');
    next();
  });
  app.use(appRoutes({ maxApps: 0 }, { pool }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const upload = async (person, filename = 'ghost-site.zip', bytes = makeZip()) => {
    current = person;
    const response = await fetch(`${base}/api/apps/archive?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    return { status: response.status, data: await response.json() };
  };
  const create = async (person, body) => {
    current = person;
    const response = await fetch(`${base}/api/apps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  const alice = await user('archive-alice');
  const bob = await user('archive-bob');
  alice.canAdminWrite = false;
  bob.canAdminWrite = false;

  await t.test('an archive is checked and stored, and answers its id, count and name', async () => {
    const result = await upload(alice);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.match(result.data.id, /^[0-9a-f]{32}$/);
    assert.equal(result.data.fileCount, 2);
    assert.equal(result.data.name, 'ghost-site');
    const { rows } = await pool.query('SELECT user_id, filename, size_bytes, app_id FROM app_archive_uploads WHERE id = $1', [result.data.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, alice.id);
    assert.equal(rows[0].filename, 'ghost-site.zip');
    assert.equal(rows[0].app_id, null);
  });

  await t.test('a connector token and a disabled code host are refused', async () => {
    current = alice;
    const connector = await fetch(`${base}/api/apps/archive?filename=ghost-site.zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-connector': 'claude-code' },
      body: makeZip(),
    });
    assert.equal(connector.status, 400);
    assert.equal((await connector.json()).error, 'invalid_request');

    codeHost = false;
    const disabled = await upload(alice);
    assert.equal(disabled.status, 503);
    codeHost = true;
  });

  await t.test('one person’s upload cannot seed another person’s project', async () => {
    const result = await upload(alice);
    assert.equal(result.status, 200);
    const refused = await create(bob, { name: 'Ghost Site', audience: 'invited', archive: result.data.id, from: 'create' });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /expired/i);
  });

  await t.test('the create links the upload, and the same upload cannot be used twice', async () => {
    const uploaded = await upload(alice);
    assert.equal(uploaded.status, 200);
    const made = await create(alice, { name: 'Ghost Site', audience: 'invited', archive: uploaded.data.id, from: 'create' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    assert.equal(made.data.archived, true);
    assert.equal(made.data.homeroomBot, undefined, 'nothing is built from an archive');
    const { rows } = await pool.query('SELECT app_id FROM app_archive_uploads WHERE id = $1', [uploaded.data.id]);
    assert.equal(rows[0].app_id, made.data.app.id);

    const again = await create(alice, { name: 'Ghost Again', audience: 'invited', archive: uploaded.data.id, from: 'create' });
    assert.equal(again.status, 400);
    assert.match(again.data.error, /expired/i);
  });

  await t.test('an archive is refused alongside a brief or a template', async () => {
    const uploaded = await upload(alice);
    assert.equal(uploaded.status, 200);
    const withBrief = await create(alice, {
      name: 'Ghost Brief', audience: 'invited', archive: uploaded.data.id, brief: 'A ghost site', from: 'create',
    });
    assert.equal(withBrief.status, 400);
    const withTemplate = await create(alice, {
      name: 'Ghost Template', audience: 'invited', archive: uploaded.data.id, template: 'game-blocks', from: 'create',
    });
    assert.equal(withTemplate.status, 400);
  });
});
