'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const media = require('../src/services/media-store');

test('public and invite still routes stream keyed bytes with their existing cache policies and access refusals', async (t) => {
  const store = require('./lib/media-store').useMemoryMedia(t);
  const data = Buffer.from('public still bytes');
  const key = media.objectKey(data);
  await store.putObject(key, data, 'image/png');
  let allowed = true;
  const asked = [];
  t.mock.method(require('../src/db/pool'), 'getPool', () => ({}));
  const result = () => allowed ? { data: null, objectKey: key, sizeBytes: data.length,
    contentType: 'image/png', sha256: key.slice(media.PREFIX.length) } : null;
  t.mock.method(require('../src/services/shots-public'), 'publicStillBytes', async (_db, input) => {
    asked.push(input); return result();
  });
  t.mock.method(require('../src/services/community-invites'), 'pictureBytes', async (_db, token) => {
    asked.push(token); return result();
  });
  const app = express();
  app.use(require('../src/routes/public-api').publicApiRoutes({}));
  app.use(require('../src/routes/community-invites')({}));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const paths = [
    `/api/public/apps/media/changes/42/stills/${'a'.repeat(32)}`,
    `/api/public/invites/${'a'.repeat(22)}/picture`,
  ];
  for (const [i, path] of paths.entries()) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), `"${key.slice(media.PREFIX.length)}"`);
    assert.equal(response.headers.get('cache-control'), i ? 'private, max-age=300' : 'public, max-age=300');
    assert.equal(response.headers.get('content-length'), String(data.length));
    assert.equal(response.headers.get('location'), null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  }
  assert.deepEqual(asked, [{ slug: 'media', changeId: 42, artifactId: 'a'.repeat(32) }, 'a'.repeat(22)]);
  // fetch adds Cache-Control: no-cache to conditional requests; use HTTP
  // directly to exercise a normal browser's matching cache validator.
  const cached = await new Promise((resolve, reject) => {
    require('node:http').get(origin + paths[0], { headers: { 'if-none-match': `"${key.slice(media.PREFIX.length)}"` } }, (response) => {
      response.resume(); response.on('end', () => resolve(response));
    }).on('error', reject);
  });
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.headers['content-length'], undefined);
  allowed = false;
  for (const path of paths) assert.equal((await fetch(origin + path)).status, 404);
  assert.equal(store.calls.filter((c) => c.op === 'get').length, 2, 'refused media never opens the object');
});
