const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { mobileAppLinkRoutes } = require('../src/routes/mobile-app-links');
const associations = require('../src/config/mobile-app-associations.json');

async function withServer(t) {
  const app = express();
  app.use(mobileAppLinkRoutes());
  // Reproduce the authenticated shell's fallback: crawlers have no session.
  app.use((_req, res) => res.redirect('/'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Android association is public JSON, with the exact release identity', async t => {
  const base = await withServer(t);
  const response = await fetch(`${base}/.well-known/assetlinks.json`, { redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  const document = await response.json();
  assert.deepEqual(document, [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.onhomeroom.app',
      sha256_cert_fingerprints: associations.androidSigningCertificateSha256,
    },
  }]);
  assert.ok(document[0].target.sha256_cert_fingerprints.length > 0, 'verified Play app-signing certificate required');
  for (const fingerprint of document[0].target.sha256_cert_fingerprints) {
    assert.match(fingerprint, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  }
});

test('Apple association is anonymous JSON at the extensionless well-known path', async t => {
  const base = await withServer(t);
  const response = await fetch(`${base}/.well-known/apple-app-site-association`, { redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), {
    applinks: { details: [{
      appIDs: ['STJZ54FRX7.com.onhomeroom.app'],
      components: [{ '/': '/*' }],
    }] },
  });
  const head = await fetch(`${base}/.well-known/apple-app-site-association`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('association routes leave all other requests to existing handlers', async t => {
  const base = await withServer(t);
  for (const [method, route] of [
    ['GET', '/app/example'],
    ['GET', '/.well-known/unrelated'],
    ['POST', '/.well-known/assetlinks.json'],
  ]) {
    const response = await fetch(`${base}${route}`, { method, redirect: 'manual' });
    assert.equal(response.status, 302);
  }
});

test('server mounts association routes before authentication and static fallbacks', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const mount = server.indexOf('app.use(mobileAppLinkRoutes());');
  assert.ok(mount > 0);
  for (const boundary of ['app.use(authMiddleware(config))', 'express.static(']) {
    assert.ok(mount < server.indexOf(boundary), `association must precede ${boundary}`);
  }
});
