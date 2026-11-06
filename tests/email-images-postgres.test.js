'use strict';

// src/routes/email-images.js against the real email_images table
// (src/db/migrations/email-templates.sql): the bytes an admin uploads come
// back byte for byte from the public route, and the uploader is recorded.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('email images against PostgreSQL', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('Set TEST_DATABASE_URL for PostgreSQL'); return;
  }
  const name = 'mail_img_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  let server = null;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
  });
  const config = { databaseUrl: String(url), adminUsername: 'img-admin', adminPassword: 'only-for-tests', selfAppSlug: 'img-platform', platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };
  const { migrate } = require('../src/db/migrate');
  await migrate(config);
  const { rows: [{ id: userId }] } = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');

  const { emailImageRoutes, emailImageAdminRoutes } = require('../src/routes/email-images');
  const app = express();
  app.use(emailImageRoutes(pool));
  app.use((req, _res, next) => { if (req.path.startsWith('/api/')) req.user = { id: userId, isAdmin: true, canAdminWrite: true }; next(); });
  app.use(emailImageAdminRoutes(pool));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Every byte value, after a JPEG's magic, so a text round trip would show.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
  const res = await fetch(`${base}/api/admin/email-images?filename=${encodeURIComponent('Fête.jpg')}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: jpeg,
  });
  assert.equal(res.status, 201);
  const { id, url: imageUrl } = await res.json();
  assert.equal(imageUrl, `${base}/email-images/${id}`);

  const { rows } = await pool.query('SELECT content_type, filename, created_by, data FROM email_images WHERE id = $1', [id]);
  assert.equal(rows[0].content_type, 'image/jpeg');
  assert.equal(rows[0].filename, 'Fête.jpg');
  assert.equal(rows[0].created_by, userId);
  assert.deepEqual(rows[0].data, jpeg);

  const served = await fetch(imageUrl);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), jpeg);
  assert.equal((await fetch(`${base}/email-images/${'0'.repeat(32)}`)).status, 404);
});
