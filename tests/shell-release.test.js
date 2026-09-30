'use strict';
// test:changed: always (generated release/upgrade contract for every proposal)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, harness } = require('./lib/shell-release-fixture');
const { buildShellRelease } = require('../scripts/build-shell-release');
const { loadShellRelease } = require('../src/services/shell-release');

test('every interface asset changes the generated worker without editing its source', t => {
  const release = fixture(t, 'a');
  const source = release.read('/sw.js');
  for (const url of ['/shell/assets/shell.js', '/js/app.js', '/css/app.css', '/shell/assets/shell-lazy.js']) {
    const before = release.read('/shell/worker.js').toString();
    release.put(url, release.read(url).toString() + '\n/* interface change */');
    const manifest = buildShellRelease(release.root, { revision: release.revision });
    assert.notEqual(release.read('/shell/worker.js').toString(), before, url);
    assert.notEqual(manifest.id, release.manifest.id);
    assert.deepEqual(release.read('/sw.js'), source, 'no handwritten cache bump');
  }
});

test('generated releases validate build/runtime identity and reject incomplete hosted images', t => {
  const release = fixture(t, 'a');
  assert.equal(loadShellRelease(path.join(release.root, 'public'), { NODE_ENV: 'production' }).revision, release.revision);
  assert.throws(() => loadShellRelease(path.join(release.root, 'public'), { GIT_SHA: 'b'.repeat(40) }), /Inconsistent/);
  assert.throws(() => buildShellRelease(release.root, { revision: 'b'.repeat(40) }), /disagree/);
  fs.unlinkSync(path.join(release.root, 'public/shell/worker.js'));
  assert.throws(() => loadShellRelease(path.join(release.root, 'public'), { NODE_ENV: 'production' }), /Inconsistent/);
});

test('a dev-stamped image cannot deploy with a production revision; rebuilding with that revision fixes it', t => {
  const release = fixture(t, 'a');
  const publicDir = path.join(release.root, 'public');
  const document = release.read('/index.html').toString();
  const runtime = { NODE_ENV: 'production', GIT_SHA: release.revision };
  // Reproduce the Kubernetes workflow omitting the Docker GIT_SHA build arg.
  release.put('/index.html', document.replace(`content="${release.revision}"`, 'content="dev"'));
  buildShellRelease(release.root, { revision: 'dev' });
  assert.throws(() => loadShellRelease(publicDir, runtime), /Inconsistent shell release artifacts/);

  release.put('/index.html', document);
  buildShellRelease(release.root, { revision: release.revision });
  assert.equal(loadShellRelease(publicDir, runtime).revision, release.revision);
});

test('warm upgrade reuses unchanged bytes, leaves lazy chunks lazy, and preserves sign-in', async t => {
  const a = fixture(t, 'a');
  const b = fixture(t, 'b');
  const env = harness(a);
  const api = await env.caches.open('usernode-api');
  await api.put('/api/auth/me', new Response('{"id":3}'));
  await env.caches.open('another-app');
  const first = env.worker(a);
  await first.install(); await first.activate();
  env.requests.length = 0;
  env.serve(b);
  const second = env.worker(b);
  await second.install(); await second.activate();
  assert.deepEqual(env.requests.sort(), ['/index.html', `/b/${b.revision}/js/app.js`].sort());
  assert.deepEqual(second.lifecycle, ['skipWaiting', 'claim']);
  assert.equal(await (await (await env.caches.open('usernode-api')).match('/api/auth/me')).text(), '{"id":3}');
  assert.ok((await env.caches.keys()).includes('another-app'));
  env.requests.length = 0;
  assert.match(await (await second.get(`/b/${b.revision}/js/app.js`)).text(), /textContent = 'b'/);
  assert.equal(env.requests.length, 0, 'warm assets never hit the network');
  assert.match(await (await second.get(`/b/${b.revision}/shell/assets/shell-lazy.js`)).text(), /version = 'b'/);
  assert.equal(env.requests.length, 1, 'lazy chunk downloads on first use only');
});

test('failed download leaves the previous complete shell available offline and can retry', async t => {
  const a = fixture(t, 'a'); const b = fixture(t, 'b');
  const env = harness(a); const first = env.worker(a);
  await first.install(); await first.activate();
  env.serve(b); env.fail('/js/app.js');
  await assert.rejects(env.worker(b).install(), /unavailable/);
  const reply = await first.prefetch(b.revision);
  assert.equal(reply.ok, false);
  env.offline(true);
  assert.match(await (await first.get('/', 'tab-a', true)).text(), new RegExp(a.revision));
  assert.match(await (await first.get(`/b/${a.revision}/js/app.js`)).text(), /textContent = 'a'/);
  env.offline(false); env.fail(null);
  assert.equal((await first.prefetch(b.revision)).ok, true);
  assert.match(await (await first.get('/', 'tab-a', true)).text(), new RegExp(b.revision));
});

test('mismatched bytes cannot replace a required asset or be served as an old lazy chunk', async t => {
  const a = fixture(t, 'a'); const b = fixture(t, 'b');
  const env = harness(a); const first = env.worker(a);
  await first.install(); await first.activate();
  env.serve(b);
  assert.equal((await first.get(`/b/${a.revision}/shell/assets/shell-lazy.js`)).status, 503);
  b.put('/js/app.js', '/* wrong rollout */');
  await assert.rejects(env.worker(b).install(), /another release/);
  assert.match(await (await first.get(`/b/${a.revision}/js/app.js`)).text(), /textContent = 'a'/);
});

test('open tabs keep their assets across multiple releases; closed tabs allow cleanup', async t => {
  const a = fixture(t, 'a'); const env = harness(a);
  let worker = env.worker(a);
  await worker.install(); await worker.activate();
  env.clients.push({ id: 'tab-a' }); await worker.note('tab-a', a.revision);
  await worker.get(`/b/${a.revision}/shell/assets/shell-lazy.js`);
  for (const letter of ['b', 'c', 'd']) {
    const release = fixture(t, letter); env.serve(release); worker = env.worker(release);
    await worker.install(); await worker.activate();
  }
  env.offline(true);
  assert.match(await (await worker.get(`/b/${a.revision}/shell/assets/shell-lazy.js`)).text(), /version = 'a'/);
  env.clients.length = 0; env.offline(false);
  const e = fixture(t, 'e'); env.serve(e); worker = env.worker(e);
  await worker.install(); await worker.activate();
  const meta = await env.caches.open('usernode-shell-releases-v1');
  const releases = (await meta.keys()).filter(key => key.url.includes('/release/'));
  assert.equal(releases.length, 2, 'only current and previous release remain without old tabs');
});

test('rollback can reuse a previously cached shell without downloading unchanged files', async t => {
  const a = fixture(t, 'a'); const b = fixture(t, 'b');
  const env = harness(a); const worker = env.worker(a);
  await worker.install(); await worker.activate();
  env.serve(b); assert.equal((await worker.prefetch(b.revision)).ok, true);
  env.serve(a); env.requests.length = 0;
  assert.equal((await worker.prefetch(a.revision)).ok, true);
  assert.deepEqual(env.requests, ['/shell/release.json']);
  assert.match(await (await worker.get('/', 'tab-a', true)).text(), new RegExp(a.revision));
});

test('a late worker activation cannot replace a newer completed update', async t => {
  const a = fixture(t, 'a'); const b = fixture(t, 'b'); const c = fixture(t, 'c');
  const env = harness(a); const first = env.worker(a);
  await first.install(); await first.activate();
  env.serve(b); const installing = env.worker(b); await installing.install();
  env.serve(c); assert.equal((await first.prefetch(c.revision)).ok, true);
  await installing.activate();
  env.offline(true);
  assert.match(await (await installing.get('/', 'tab-c', true)).text(), new RegExp(c.revision));
});

test('an older rollout response or worker cannot downgrade the cached shell', async t => {
  const a = fixture(t, 'a'); const b = fixture(t, 'b');
  const env = harness(b); const worker = env.worker(b);
  await worker.install(); await worker.activate();
  env.serve(a);
  assert.match(await (await worker.get('/', 'tab-b', true)).text(), new RegExp(b.revision));
  const stale = env.worker(a); await stale.install(); await stale.activate();
  env.offline(true);
  assert.match(await (await stale.get('/', 'tab-b', true)).text(), new RegExp(b.revision));
});

// A staging preview keeps one hostname across rebuilds, so the worker from a
// reviewer's previous visit answers the first open of the rebuilt preview.
// 80ms is a good link, but a new build is a document, a manifest and its
// changed assets in series: past the 200ms deadline even at that latency.
test('a rebuilt preview shows its new build on the first navigation over a real round trip', async t => {
  const a = fixture(t, 'a'); const b = fixture(t, 'b');
  const env = harness(a); env.policy('latest');
  const worker = env.worker(a);
  await worker.install(); await worker.activate();
  env.serve(b); env.latency(80);
  assert.match(await (await worker.get('/index.html', 'tab-a', true)).text(), new RegExp(b.revision));
});

test('production keeps time-to-page: the previous build paints and the new one is ready next time', async t => {
  const a = fixture(t, 'a'); const b = fixture(t, 'b');
  const env = harness(a); const worker = env.worker(a);
  await worker.install(); await worker.activate();
  env.serve(b); env.latency(80);
  assert.match(await (await worker.get('/index.html', 'tab-a', true)).text(), new RegExp(a.revision));
  assert.match(await (await worker.get('/index.html', 'tab-b', true)).text(), new RegExp(b.revision));
});

test('a preview document that misses the deadline still paints from cache', async t => {
  const a = fixture(t, 'a'); const b = fixture(t, 'b');
  const env = harness(a); env.policy('latest');
  const worker = env.worker(a);
  await worker.install(); await worker.activate();
  env.serve(b); env.latency(250);
  assert.match(await (await worker.get('/index.html', 'tab-a', true)).text(), new RegExp(a.revision));
});

test('only a staging preview document asks the worker for the latest build', () => {
  const { applyShellDocumentHeaders, SHELL_BUILD_POLICY_HEADER } = require('../src/services/static-cache');
  const headers = env => {
    const set = {};
    applyShellDocumentHeaders({ setHeader: (k, v) => { set[k.toLowerCase()] = v; } }, __filename, env);
    return set;
  };
  const name = SHELL_BUILD_POLICY_HEADER.toLowerCase();
  assert.match(fs.readFileSync(path.join(__dirname, '../public/sw-release.js'), 'utf8'),
    new RegExp(`headers\\.get\\('${name}'\\) === 'latest'`), 'the worker reads the header the server sends');
  assert.equal(headers({ GIT_SHA: 'abc1234', USERNODE_ENV: 'staging' })[name], 'latest');
  assert.equal(headers({ GIT_SHA: 'abc1234', USERNODE_ENV: 'production' })[name], undefined);
  // No build id means no generated release, so there is no worker to ask.
  assert.equal(headers({ USERNODE_ENV: 'staging' })[name], undefined);
});

test('migration retains legacy open-tab assets until those tabs have moved to generated releases', async t => {
  const a = fixture(t, 'a'); const env = harness(a);
  const oldPath = `/b/${'f'.repeat(40)}/js/app.js`;
  const legacy = await env.caches.open('usernode-shell-v36');
  await legacy.put(oldPath, new Response('old tab code'));
  env.clients.push({ id: 'old-tab' });
  const worker = env.worker(a); await worker.install(); await worker.activate();
  env.offline(true);
  assert.equal(await (await worker.get(oldPath, 'old-tab')).text(), 'old tab code');
  assert.ok((await env.caches.keys()).includes('usernode-shell-v36'));
  await worker.note('old-tab', a.revision);
  assert.ok(!(await env.caches.keys()).includes('usernode-shell-v36'));
});

test('every image path generates the release after CSS and retains its revision at runtime', () => {
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  for (const file of ['Dockerfile', 'Dockerfile.kubernetes']) {
    const source = read(file);
    assert.ok(source.lastIndexOf('ARG GIT_SHA=dev') > source.indexOf('FROM node:22-alpine\n'));
    assert.ok(source.indexOf('node scripts/build-shell-release.js') > source.indexOf('build-tailwind.js'));
    assert.ok(source.indexOf('ENV GIT_SHA=$GIT_SHA') < source.indexOf('node frontend/scripts/build-shell.mjs'));
  }
  const ensure = read('scripts/ensure-shell-artifacts.js');
  assert.ok(ensure.indexOf("runNode('scripts/build-shell-release.js')") > ensure.indexOf("runNode('scripts/build-tailwind.js')"));
  assert.match(read('src/services/application-runtime.js'), /buildImage\(sourceDir, dockerImage, \{ GIT_SHA: revision \}/);
});
