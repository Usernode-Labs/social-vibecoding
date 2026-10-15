'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const { precompress, DIRECTORY, artifactDir } = require('../scripts/precompress-static-assets');
const { precompressedAssets } = require('../src/middleware/precompressed-assets');
const { responseCompression } = require('../src/middleware/response-compression');
const { buildScopedAssetHandler, REVALIDATE, IMMUTABLE } = require('../src/services/static-cache');
const SHA = 'f04a349936798bbe041ab98248dd49c7767d24ba';
const JS = `window.example = ${JSON.stringify('static data '.repeat(4000))};\n`;
const CSS = '.example { color: blue; }\n'.repeat(200);
const ENV = { NODE_ENV: 'production', GIT_SHA: SHA };

function files(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precompressed-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(artifactDir(dir), { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'js'));
  fs.mkdirSync(path.join(dir, 'css'));
  fs.writeFileSync(path.join(dir, 'js/app.js'), JS);
  fs.writeFileSync(path.join(dir, 'css/app.css'), CSS);
  fs.writeFileSync(path.join(dir, 'small.js'), 'small');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>hello</html>'.repeat(100));
  fs.writeFileSync(path.join(dir, 'sw.js'), JS);
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ data: JS }));
  return dir;
}

async function fixture(t, { env = ENV, generated = true, before, afterBuild } = {}) {
  const dir = files(t);
  const manifest = generated ? precompress(dir, SHA) : null;
  if (afterBuild) afterBuild(dir, manifest);
  const app = express();
  app.use(responseCompression());
  if (before) app.use(before);
  app.get('/api/data', (_req, res) => res.json({ data: JS }));
  app.use(precompressedAssets(dir, env));
  app.use(buildScopedAssetHandler(dir, env));
  app.use(express.static(dir, { setHeaders(res) { res.setHeader('Cache-Control', REVALIDATE); } }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { dir, manifest, get(url, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject); req.end();
    });
  } };
}
const decode = (res) => res.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(res.body).toString()
  : res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.body).toString() : res.body.toString();

test('builder limits output to eligible assets and rebuilds without retaining obsolete variants', (t) => {
  const dir = files(t);
  const m = precompress(dir, SHA);
  assert.deepEqual(Object.keys(m.assets).sort(), ['/css/app.css', '/js/app.js']);
  for (const [url, entry] of Object.entries(m.assets)) {
    for (const [encoding, hash] of Object.entries(entry.variants)) {
      const bytes = fs.readFileSync(path.join(artifactDir(dir), `${hash}.${encoding}`));
      const decoded = encoding === 'br' ? zlib.brotliDecompressSync(bytes) : zlib.gunzipSync(bytes);
      assert.deepEqual(decoded, fs.readFileSync(path.join(dir, url)));
    }
  }
  const old = m.assets['/js/app.js'].variants.br + '.br';
  fs.unlinkSync(path.join(dir, 'js/app.js'));
  const next = precompress(dir, SHA);
  assert.equal(next.assets['/js/app.js'], undefined);
  assert.equal(fs.existsSync(path.join(artifactDir(dir), old)), false);
});

test('existing plain and build-scoped URLs serve exact bytes with the same cache and build policy', async (t) => {
  const app = await fixture(t);
  for (const [url, policy] of [
    ['/js/app.js?any=query', REVALIDATE], [`/b/${SHA}/js/app.js`, IMMUTABLE],
    ['/b/abcdef012345/js/app.js', REVALIDATE],
  ]) {
    for (const encoding of ['br', 'gzip']) {
      const res = await app.get(url, { 'Accept-Encoding': encoding });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-encoding'], encoding);
      assert.equal(Number(res.headers['content-length']), res.body.length, 'prebuilt bytes have a known length');
      assert.match(res.headers['content-type'], /javascript/);
      assert.equal(res.headers['cache-control'], policy);
      assert.equal(res.headers['x-platform-build'], SHA);
      assert.match(res.headers.vary, /Accept-Encoding/);
      assert.equal(decode(res), JS);
    }
  }
  const css = await app.get('/css/app.css', { 'Accept-Encoding': 'br' });
  assert.match(css.headers['content-type'], /^text\/css/);
  assert.equal(decode(css), CSS);
});

test('negotiation respects q-values, explicit exclusions, identity and clients without Accept-Encoding', async (t) => {
  const app = await fixture(t);
  for (const [accept, expected] of [
    ['gzip, br', 'br'], ['gzip;q=1,br;q=0.5', 'gzip'], ['br;q=0,gzip', 'gzip'],
    ['br;q=0.5,identity;q=1', undefined], ['br;q=0,gzip;q=0', undefined],
    ['identity', undefined], [null, undefined], ['*;q=0', undefined],
  ]) {
    const res = await app.get('/js/app.js', accept === null ? {} : { 'Accept-Encoding': accept });
    assert.equal(res.headers['content-encoding'], expected, String(accept));
    assert.equal(decode(res), JS);
  }
});

test('HEAD and conditional requests retain representation-specific validators and no body', async (t) => {
  const app = await fixture(t);
  const first = await app.get('/js/app.js', { 'Accept-Encoding': 'br' });
  const head = await app.get('/js/app.js', { 'Accept-Encoding': 'br' }, 'HEAD');
  assert.equal(head.body.length, 0);
  for (const name of ['content-length', 'content-type', 'content-encoding', 'etag', 'last-modified']) {
    assert.equal(head.headers[name], first.headers[name], name);
  }
  for (const validator of [{ 'If-None-Match': first.headers.etag }, { 'If-Modified-Since': first.headers['last-modified'] }]) {
    const again = await app.get('/js/app.js', { 'Accept-Encoding': 'br', ...validator });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.match(again.headers.vary, /Accept-Encoding/);
  }
  const gzip = await app.get('/js/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag });
  assert.equal(gzip.status, 200);
  assert.notEqual(gzip.headers.etag, first.headers.etag);
});

test('missing output, wrong build and editable development sources use runtime compression', async (t) => {
  for (const options of [{ generated: false }, { env: { ...ENV, GIT_SHA: '1234567' } }, { env: { ...ENV, NODE_ENV: 'development' } }]) {
    const app = await fixture(t, options);
    const res = await app.get('/js/app.js', { 'Accept-Encoding': 'br' });
    assert.equal(res.headers['content-encoding'], 'br');
    assert.equal(res.headers['content-length'], undefined, 'runtime compression fallback');
    assert.equal(decode(res), JS);
  }
});

test('a changed or removed source is never masked by a previously validated sidecar', async (t) => {
  const app = await fixture(t);
  await app.get('/js/app.js', { 'Accept-Encoding': 'br' });
  const changed = JS + '// changed source\n';
  fs.writeFileSync(path.join(app.dir, 'js/app.js'), changed);
  assert.equal(decode(await app.get('/js/app.js', { 'Accept-Encoding': 'br' })), changed);
  fs.unlinkSync(path.join(app.dir, 'js/app.js'));
  assert.equal((await app.get('/js/app.js', { 'Accept-Encoding': 'br' })).status, 404);
});

test('a missing variant falls through without changing the response', async (t) => {
  const app = await fixture(t, { afterBuild(dir, m) { fs.unlinkSync(path.join(artifactDir(dir), `${m.assets['/js/app.js'].variants.br}.br`)); } });
  const res = await app.get('/js/app.js', { 'Accept-Encoding': 'br' });
  assert.equal(decode(res), JS);
  assert.equal(res.headers['content-length'], undefined);
});

test('range requests and no-transform keep the existing serving behavior', async (t) => {
  const app = await fixture(t);
  const range = await app.get('/js/app.js', { Range: 'bytes=0-9', 'Accept-Encoding': 'identity' });
  assert.equal(range.status, 206);
  assert.equal(range.body.toString(), JS.slice(0, 10));
  const plain = await fixture(t, { before(_req, res, next) { res.setHeader('Cache-Control', 'no-transform'); next(); } });
  // The test's fallback static handler sets its own policy; the prebuilt
  // variant must still be skipped before that handler runs.
  const res = await plain.get('/js/app.js', { 'Accept-Encoding': 'br' });
  assert.equal(res.headers['content-length'], undefined);
});

test('dynamic responses and internal artifact paths cannot use precompressed files', async (t) => {
  const app = await fixture(t);
  const dynamic = await app.get('/api/data', { 'Accept-Encoding': 'br' });
  assert.deepEqual(JSON.parse(decode(dynamic)), { data: JS });
  assert.equal(dynamic.headers['content-length'], undefined);
  for (const url of [`/${DIRECTORY}/manifest.json`, `/b/${SHA}/../${DIRECTORY}/manifest.json`, '/%2e%2e/server.js', '/bad%ZZ.js']) {
    const res = await app.get(url, { 'Accept-Encoding': 'br' });
    assert.ok([400, 403, 404].includes(res.status), `${url}: ${res.status}`);
  }
});

test('both image builds generate variants after final assets and exclude host-generated output', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['Dockerfile', 'Dockerfile.kubernetes']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(src.indexOf('RUN node scripts/precompress-static-assets.js') > src.indexOf('RUN node scripts/build-shell-release.js'), file);
  }
  for (const file of ['.gitignore', '.dockerignore']) assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /public\.precompressed\//);
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(server.indexOf("app.use(require('./src/middleware/precompressed-assets')") < server.indexOf('app.use(buildScopedAssetHandler'));
});
