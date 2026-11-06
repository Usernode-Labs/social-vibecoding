'use strict';

// src/routes/email-images.js: the images an admin uploads from the email
// template editor, and the public route mail clients load them from.
//
// The table is a plain array behind a fake pool that answers the two queries
// the module makes; tests/email-images-postgres.test.js runs the same round
// trip against the real email_images table. The admin gates and the same-site
// guard are mounted the way server.js and routes/admin.js mount them.
//
// Run with: node --test tests/email-images.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { adminMiddleware } = require('../src/middleware/admin');
const { sameOriginBrowserWrites } = require('../src/middleware/same-site-browser');
const { PRODUCTION_ORIGIN } = require('../src/services/cli-auth-constants');
const { emailImageRoutes, emailImageAdminRoutes, imageOrigin, IMAGE_CSP } = require('../src/routes/email-images');

const ROOT = path.join(__dirname, '..');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

let rows = [];
const pool = {
  async query(rawSql, params = []) {
    const sql = collapse(rawSql);
    if (sql.startsWith('INSERT INTO email_images (id, content_type, data, filename, created_by)')) {
      const [id, contentType, data, filename, createdBy] = params;
      rows.push({ id, content_type: contentType, data, filename, created_by: createdBy });
      return { rows: [] };
    }
    if (sql === 'SELECT content_type, data FROM email_images WHERE id = $1') {
      const row = rows.find((r) => r.id === params[0]);
      return { rows: row ? [{ content_type: row.content_type, data: row.data }] : [] };
    }
    throw new Error(`Unhandled SQL in mock: ${sql}`);
  },
};

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>');
const HTML_AS_PNG = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');

function withUser(role) {
  return (req, _res, next) => {
    if (role === 'readonly') req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false };
    else if (role === 'user') req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false };
    else if (role === 'admin') req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

// The public route ahead of any session, then the admin prefix's same-site
// guard and gate, as server.js and routes/admin.js order them.
async function start(role = 'admin') {
  const app = express();
  app.use(emailImageRoutes(pool));
  app.use(express.json());
  app.use(withUser(role));
  app.use('/api/admin', sameOriginBrowserWrites);
  app.use('/api/admin', adminMiddleware);
  app.use(emailImageAdminRoutes(pool));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
    upload: (body, { query = '', headers = {} } = {}) => fetch(`${base}/api/admin/email-images${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body, redirect: 'manual',
    }),
  };
}

test.beforeEach(() => { rows = []; });

test('PNG, JPEG, GIF and WebP are stored as given, with the type their bytes say', async () => {
  const api = await start();
  try {
    for (const [file, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [GIF, 'image/gif'], [WEBP, 'image/webp']]) {
      const res = await api.upload(file, { query: '?filename=logo.bin' });
      assert.equal(res.status, 201, type);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ['id', 'url']);
      assert.match(body.id, /^[a-f0-9]{32}$/);
      const row = rows.find((r) => r.id === body.id);
      assert.equal(row.content_type, type, 'the type comes from the bytes, not the request');
      assert.deepEqual(Buffer.from(row.data), file, 'never re-encoded');
      assert.equal(row.filename, 'logo.bin');
      assert.equal(row.created_by, 902);
    }
  } finally { await api.close(); }
});

test('the returned url is absolute', async () => {
  const api = await start();
  try {
    const body = await (await api.upload(PNG)).json();
    assert.equal(body.url, `${api.base}/email-images/${body.id}`, 'outside production, the origin the editor is on');
    assert.ok(new URL(body.url).protocol.startsWith('http'));
  } finally { await api.close(); }
  // Production names its canonical origin, never the Host header; a staging
  // preview names its own, so an image uploaded there loads there.
  const req = { protocol: 'http', headers: { host: 'preview-1.apps.example.test', 'x-forwarded-proto': 'https' } };
  assert.equal(imageOrigin(req, { NODE_ENV: 'production' }), PRODUCTION_ORIGIN);
  assert.equal(imageOrigin(req, { NODE_ENV: 'production', USERNODE_ENV: 'staging' }), 'https://preview-1.apps.example.test');
  assert.equal(imageOrigin({ protocol: 'http', headers: { host: 'bad host' } }, {}), PRODUCTION_ORIGIN, 'a host that is not one falls back');
});

test('HTML disguised as PNG is refused', async () => {
  const api = await start();
  try {
    for (const file of [HTML_AS_PNG, SVG, Buffer.from('not an image at all, just text'), Buffer.alloc(0)]) {
      const res = await api.upload(file, { headers: { 'Content-Type': 'application/octet-stream', 'X-Declared-Type': 'image/png' } });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /PNG, JPEG, GIF or WebP/);
    }
    assert.equal(rows.length, 0, 'nothing is stored');
  } finally { await api.close(); }
});

test('over 1 MB is refused with the 400 envelope', async () => {
  const api = await start();
  try {
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    const res = await api.upload(big);
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { error: 'The image must be 1 MB or smaller.' });
    const exact = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 - PNG.length)]);
    assert.equal((await api.upload(exact)).status, 201, '1 MB itself is fine');
  } finally { await api.close(); }
});

test('served without a session, with CSP', async () => {
  const api = await start('none');
  const admin = await start();
  try {
    const { id, url } = await (await admin.upload(GIF)).json();
    const res = await fetch(`${api.base}${new URL(url).pathname}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/gif');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('content-security-policy'), IMAGE_CSP);
    assert.equal(IMAGE_CSP, "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), GIF);
    assert.match(id, /^[a-f0-9]{32}$/);
  } finally { await api.close(); await admin.close(); }
});

test('unknown id is 404', async () => {
  const api = await start('none');
  try {
    for (const bad of ['xyz', 'A'.repeat(32), 'a'.repeat(31), `${'a'.repeat(32)}.png`, 'f'.repeat(32)]) {
      assert.equal((await fetch(`${api.base}/email-images/${bad}`)).status, 404, bad);
    }
  } finally { await api.close(); }
});

test('view-only admin can\'t upload, nor anyone who is not an admin', async () => {
  // A view-only admin hears 403 from requireAdminWrite; anyone else is sent
  // away by the admin prefix's adminMiddleware, as on every admin route.
  for (const [role, status] of [['readonly', 403], ['user', 302], ['none', 302]]) {
    const api = await start(role);
    try {
      const res = await api.upload(PNG);
      assert.equal(res.status, status, role);
    } finally { await api.close(); }
  }
  assert.equal(rows.length, 0);
});

test('the same-site guard refuses an upload another site sends', async () => {
  const api = await start();
  try {
    for (const site of ['cross-site', 'same-site', 'none']) {
      assert.equal((await api.upload(PNG, { headers: { 'Sec-Fetch-Site': site } })).status, 403, site);
    }
    assert.equal((await api.upload(PNG, { headers: { Origin: 'https://evil.example' } })).status, 403, 'a foreign Origin');
    assert.equal((await api.upload(PNG, { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 201);
  } finally { await api.close(); }
});

test('wiring: public before the session, listed in PUBLIC_PATHS, the upload under the admin gates, and no delete', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const image = server.indexOf('app.use(emailImageRoutes(getPool(config)));');
  const auth = server.indexOf('app.use(authMiddleware(config));');
  const guard = server.indexOf("app.use(['/api/admin', '/api/v4/admin'], require('./src/middleware/same-site-browser').sameOriginBrowserWrites);");
  assert.ok(image > -1 && image < auth, 'the image route mounts before authMiddleware');
  assert.ok(guard > auth, 'the admin writes keep their same-site guard');

  const auth2 = fs.readFileSync(path.join(ROOT, 'src/middleware/auth.js'), 'utf8');
  const m = auth2.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(entries.filter((p) => p.startsWith('/email') || '/email-images/'.startsWith(p)), ['/email-images/']);

  const admin = fs.readFileSync(path.join(ROOT, 'src/routes/admin.js'), 'utf8');
  assert.match(admin, /router\.use\(emailImageAdminRoutes\(pool\)\);/);
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/email-images.js'), 'utf8');
  assert.match(route, /router\.post\('\/api\/admin\/email-images', requireAdminWrite, attachmentUploadLimiter, readUpload,/);
  assert.doesNotMatch(route, /router\.(delete|patch|put)\(/, 'images are never deleted, so archived versions keep drawing them');
  assert.doesNotMatch(route, /DELETE FROM|UPDATE email_images/);
});
