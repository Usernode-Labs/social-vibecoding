'use strict';

// Each starter template (#3521), generated exactly as a new project's
// repository is, then RUN: `node server.js` against a throwaway PostgreSQL
// database, signed in with a platform-shaped token, and driven through its
// API. This is the proof that a project created from a starter works on its
// first deploy, not only that its files look right
// (tests/app-templates.test.js).
//
// Per starter: a production boot seeds nothing; a staging boot seeds the
// rows its declared checks read, and a second boot does not seed them again;
// the screen is served to a signed-in visitor and the API refuses anyone
// else; the starter's own flows work; SIGTERM drains and exits 0.
//
// The app's dependencies (express, pg, jsonwebtoken) resolve from this
// repository's node_modules through NODE_PATH. Skipped when no server is
// reachable, required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const { getTemplateFiles } = require('../src/services/template');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const APP_ID = '77';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function token(id, username, audience = `usernode:app:${APP_ID}`) {
  return jwt.sign({ id, username, pur: 'iframe' }, privateKey, {
    algorithm: 'RS256', issuer: 'usernode', audience, expiresIn: '10m',
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function writeRepo(template) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `starter-${template}-`));
  for (const f of getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://unused', null, { template })) {
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.content);
  }
  return dir;
}

/** `node server.js` in `dir`, resolved once it is listening. */
async function boot(dir, dbUrl, env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
      DATABASE_URL: dbUrl,
      USERNODE_JWT_PUBLIC_KEY: publicKey,
      USERNODE_APP_ID: APP_ID,
      USERNODE_ENV: env,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    child.stdout.on('data', () => { if (out.includes('Listening on :')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function call(method, url, { as, body, raw } = {}) {
    const headers = {};
    if (as) headers['x-usernode-token'] = as;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return res;
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  async function stop() {
    if (child.exitCode !== null) return child.exitCode;
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
    if (code === 'timeout') child.kill('SIGKILL');
    return code;
  }
  return { call, stop, base, output: () => out };
}

test('every starter runs: seeds in staging only, serves its screen, refuses strangers, works, and drains', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const made = [];
  const dirs = [];
  async function database() {
    const name = 'starter_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    made.push(name);
    const url = new URL(DSN); url.pathname = '/' + name;
    return String(url);
  }
  t.after(async () => {
    for (const name of made) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  const ada = token(101, 'ada');
  const grace = token(102, 'grace');

  // What every starter shares: the screen for a signed-in visitor, nothing
  // for anyone else, and a clean exit on SIGTERM.
  async function common(app, apiPath) {
    const page = await app.call('GET', `/?token=${encodeURIComponent(ada)}`, { raw: true });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<script src="\/app\.js"><\/script>/);
    const script = await app.call('GET', '/app.js', { raw: true });
    assert.equal(script.status, 200, 'the screen\'s script is served as a static file');
    assert.equal((await app.call('GET', apiPath)).status, 401, 'no token, no data');
    assert.equal((await app.call('GET', apiPath, { as: token(101, 'ada', 'usernode:app:999') })).status, 401,
      'a token minted for another app is refused');
    assert.equal((await app.call('GET', '/health')).status, 200);
  }

  async function run(template, flows, apiPath, seeded) {
    const dir = writeRepo(template);
    dirs.push(dir);

    // Production: the tables and nothing in them.
    const prodDb = await database();
    let app = await boot(dir, prodDb, 'production');
    assert.deepEqual(seeded(await app.call('GET', apiPath, { as: ada })), 0, 'production seeds nothing');
    assert.equal(await app.stop(), 0, `SIGTERM drains and exits 0:\n${app.output()}`);
    assert.match(app.output(), /\[shutdown\] SIGTERM received, draining/);

    // Staging: the seed, once, however many times the preview boots.
    const stagingDb = await database();
    app = await boot(dir, stagingDb, 'staging');
    const first = seeded(await app.call('GET', apiPath, { as: ada }));
    assert.ok(first > 0, 'staging seeds what its checks read');
    assert.equal(await app.stop(), 0);
    app = await boot(dir, stagingDb, 'staging');
    assert.equal(seeded(await app.call('GET', apiPath, { as: ada })), first, 'a second boot does not seed again');
    await common(app, apiPath);
    await flows(app);
    assert.equal(await app.stop(), 0);
  }

  await t.test('social productivity: lists people add to, claim and tick off', async () => {
    const count = (r) => (r.data.lists.find((l) => l.title.startsWith('Staging demo')) || { tasks: [] }).tasks.length;
    await run('social-productivity', async (app) => {
      assert.equal((await app.call('POST', '/api/lists', { as: ada, body: { title: '   ' } })).status, 400);
      const list = await app.call('POST', '/api/lists', { as: ada, body: { title: '  Trip   packing ' } });
      assert.equal(list.status, 201);
      const listId = list.data.id;
      assert.equal((await app.call('POST', `/api/lists/${listId}/tasks`, { as: grace, body: { text: '' } })).status, 400);
      assert.equal((await app.call('POST', '/api/lists/999999/tasks', { as: grace, body: { text: 'x' } })).status, 404);
      const task = await app.call('POST', `/api/lists/${listId}/tasks`, { as: grace, body: { text: 'Pack the tent' } });
      assert.equal(task.status, 201);
      const taskId = task.data.id;
      assert.deepEqual((await app.call('POST', `/api/tasks/${taskId}/claim`, { as: ada })).data, { claimed: true });
      assert.equal((await app.call('POST', `/api/tasks/${taskId}/claim`, { as: grace })).status, 409, 'a claimed task stays its claimer\'s');
      assert.deepEqual((await app.call('POST', `/api/tasks/${taskId}/done`, { as: ada, body: { done: true } })).data, { done: true });
      const board = await app.call('GET', '/api/lists', { as: grace });
      const mine = board.data.lists.find((l) => l.id === listId);
      assert.equal(mine.title, 'Trip packing');
      assert.equal(mine.by, 'ada');
      assert.equal(mine.mine, false);
      assert.deepEqual(mine.tasks.map((x) => [x.text, x.by, x.claimedBy, x.done, x.doneBy, x.canRemove]),
        [['Pack the tent', 'grace', 'ada', true, 'ada', true]]);
      assert.equal(board.data.lists[0].id, listId, 'newest list first');
      assert.equal((await app.call('DELETE', `/api/lists/${listId}`, { as: grace })).status, 403, 'only its author removes a list');
      const other = await app.call('POST', `/api/lists/${listId}/tasks`, { as: ada, body: { text: 'Maps' } });
      assert.equal((await app.call('DELETE', `/api/tasks/${other.data.id}`, { as: token(103, 'sam') })).status, 403);
      assert.equal((await app.call('DELETE', `/api/tasks/${other.data.id}`, { as: ada })).status, 200);
      assert.equal((await app.call('DELETE', `/api/lists/${listId}`, { as: ada })).status, 200);
      assert.ok(!(await app.call('GET', '/api/lists', { as: ada })).data.lists.some((l) => l.id === listId));
    }, '/api/lists', count);
  });

  await t.test('multimedia social: posts with photos, likes, reports that hide, and deletes', async () => {
    const count = (r) => r.data.posts.filter((p) => p.by === 'staging-demo-user').length;
    await run('multimedia-social', async (app) => {
      const feed = await app.call('GET', '/api/posts', { as: ada });
      assert.ok(feed.data.posts[0].imageUrl.startsWith('data:image/svg+xml,'), 'the newest seed carries a placeholder photo');
      assert.equal((await app.call('POST', '/api/posts', { as: ada, body: { caption: '  ' } })).status, 400);
      for (const bad of ['javascript:alert(1)', 'http://x/y.jpg', 'https://x/"onerror="1', 'https://' + 'x'.repeat(600)]) {
        assert.equal((await app.call('POST', '/api/posts', { as: ada, body: { caption: 'hi', imageUrl: bad } })).status, 400, bad);
      }
      const photo = await app.call('POST', '/api/posts', {
        as: ada, body: { caption: 'Garden today', imageUrl: 'https://homeroom.example/app-files/' + 'a'.repeat(32) },
      });
      assert.equal(photo.status, 201);
      const id = photo.data.id;
      assert.deepEqual((await app.call('POST', `/api/posts/${id}/like`, { as: grace })).data, { liked: true });
      let top = (await app.call('GET', '/api/posts', { as: grace })).data.posts[0];
      assert.deepEqual([top.id, top.by, top.likes, top.liked, top.mine], [id, 'ada', 1, true, false], 'newest first');
      assert.deepEqual((await app.call('POST', `/api/posts/${id}/like`, { as: grace })).data, { liked: false }, 'pressing again takes it back');
      assert.equal((await app.call('DELETE', `/api/posts/${id}`, { as: grace })).status, 403, 'only the author deletes');
      // Three different people's reports hide it; one person reporting
      // twice counts once.
      await app.call('POST', `/api/posts/${id}/report`, { as: grace });
      await app.call('POST', `/api/posts/${id}/report`, { as: grace });
      await app.call('POST', `/api/posts/${id}/report`, { as: token(103, 'sam') });
      top = (await app.call('GET', '/api/posts', { as: ada })).data.posts;
      assert.ok(top.some((p) => p.id === id), 'two people is not yet enough');
      await app.call('POST', `/api/posts/${id}/report`, { as: token(104, 'lee') });
      assert.ok(!(await app.call('GET', '/api/posts', { as: ada })).data.posts.some((p) => p.id === id), 'three hides it');
      const text = await app.call('POST', '/api/posts', { as: grace, body: { caption: 'Words only' } });
      assert.equal((await app.call('DELETE', `/api/posts/${text.data.id}`, { as: grace })).status, 200);
      // Paging continues after the last post shown.
      const page = (await app.call('GET', '/api/posts', { as: ada })).data.posts;
      const after = (await app.call('GET', `/api/posts?before=${page[0].id}`, { as: ada })).data.posts;
      assert.deepEqual(after.map((p) => p.id), page.slice(1).map((p) => p.id));
    }, '/api/posts', count);
  });

  for (const template of ['game-2d', 'game-3d']) {
    await t.test(`${template}: scores, each player's best on the leaderboard`, async () => {
      const count = (r) => r.data.leaderboard.filter((row) => row.username.startsWith('staging-demo-')).length;
      await run(template, async (app) => {
        for (const bad of [-1, 1.5, '7', 100001, null]) {
          assert.equal((await app.call('POST', '/api/scores', { as: ada, body: { score: bad } })).status, 400, String(bad));
        }
        await app.call('POST', '/api/scores', { as: ada, body: { score: 30 } });
        const after = await app.call('POST', '/api/scores', { as: ada, body: { score: 4 } });
        assert.equal(after.status, 201);
        assert.equal(after.data.best, 30, 'a worse round does not lower your best');
        assert.deepEqual(after.data.leaderboard[0], { username: 'ada', best: 30 });
        assert.equal(after.data.leaderboard.filter((r) => r.username === 'ada').length, 1, 'one row per player');
        assert.equal((await app.call('GET', '/api/leaderboard', { as: grace })).data.best, null, 'no rounds, no best');
      }, '/api/leaderboard', count);
    });
  }
});
