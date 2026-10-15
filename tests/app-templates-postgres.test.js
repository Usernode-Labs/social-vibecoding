'use strict';

// Each ready-made app (services/app-templates.js), generated exactly as a
// new project's repository is, then RUN: `node server.js` against a
// throwaway PostgreSQL database, signed in with a platform-shaped token, and
// driven through its API. This is the proof that a project made from one
// works on its first deploy, with nothing built first, not only that its
// files look right (tests/app-templates.test.js).
//
// Per app: a production boot seeds nothing; a staging boot seeds the rows
// its declared checks read, and a second boot does not seed them again; the
// screen is served to a signed-in visitor and the API refuses anyone else;
// the app's own flows work, "now" included where it decides what shows
// (x-usernode-now, which only a staging container reads); SIGTERM drains
// and exits 0.
//
// The chore list asks the platform who is in the group (GET /members, the
// platform conventions' "Members"): a stand-in platform answers it here,
// for members only, as the real one does.
//
// The game starters play over a WebSocket (game/live.js): their flows open
// real ones, as a page does, beside the plain requests.
//
// The app's dependencies (express, pg, jsonwebtoken, and ws for a game)
// resolve from this repository's node_modules through NODE_PATH. Skipped when no server is
// reachable, required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
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

const ada = token(101, 'ada');
const grace = token(102, 'grace');
const sam = token(103, 'sam');
const DAY = 24 * 60 * 60 * 1000;

/**
 * A game's live connection, as its page opens one (/api/live?token=):
 * `opened` resolves once connected, or rejects with the refusal's status;
 * `next(test)` reads on from the last message it returned and resolves with
 * the first that passes `test`, skipping the rest.
 *
 * A message that arrives while nobody is waiting is kept until it is read.
 * The ws client hands over every frame of one socket read in a single
 * synchronous run, before the code awaiting the first of them resumes, so
 * two messages sent back to back (a winning roll's view, then the room's
 * "over") both land before the test asks for the second whenever the test
 * process reads late, as it does on a loaded runner. Dropping them timed the
 * board game out there.
 */
function liveOf(app, tok) {
  const WebSocket = require('ws');
  const ws = new WebSocket(`${app.base.replace(/^http/, 'ws')}/api/live${tok ? `?token=${encodeURIComponent(tok)}` : ''}`);
  const unread = [];
  let waiter = null;
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (!waiter) unread.push(msg);
    else if (waiter.test(msg)) { const w = waiter; waiter = null; w.resolve(msg); }
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.once('error', (err) => reject(err));
  });
  opened.catch(() => {});
  return {
    opened,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(test, ms = 6000) {
      assert.equal(waiter, null, 'one next() at a time on a live connection');
      while (unread.length) {
        const msg = unread.shift();
        if (test(msg)) return Promise.resolve(msg);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiter = null; reject(new Error('no such message in time')); }, ms);
        waiter = { test, resolve: (m) => { clearTimeout(timer); resolve(m); } };
      });
    },
    close: () => ws.close(),
  };
}
const isView = (test = () => true) => (m) => m.t === 'view' && test(m.view);

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

/**
 * The platform's members route, as the real one answers it: the project's
 * members to a member's user token, 403 not_a_member to anyone else.
 */
async function platform() {
  const members = [{ id: 101, username: 'ada' }, { id: 102, username: 'grace' }];
  const asked = [];
  const server = http.createServer((req, res) => {
    const who = jwt.decode(String(req.headers['x-usernode-user-token'] || ''));
    asked.push(req.url);
    if (!req.url.startsWith('/v1/members')) { res.writeHead(404); return res.end(); }
    if (!who || !members.some((m) => m.id === who.id)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 'not_a_member' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ members, has_more: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, asked, close: () => new Promise((r) => server.close(r)) };
}

/** `node server.js` in `dir`, resolved once it is listening. */
async function boot(dir, dbUrl, env, extra = {}) {
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
      ...extra,
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
  async function call(method, url, { as, body, raw, now } = {}) {
    const headers = {};
    if (as) headers['x-usernode-token'] = as;
    if (now) headers['x-usernode-now'] = now;
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

test('every ready-made app runs: seeds in staging only, serves its screen, refuses strangers, works, and drains', { timeout: 240000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const made = [];
  const dirs = [];
  const members = await platform();
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
    await members.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const env = { USERNODE_PLATFORM_API_V1_URL: members.url };

  // What every app shares: the screen for a signed-in visitor, nothing for
  // anyone else, and a clean exit on SIGTERM.
  async function common(app, apiPath) {
    const page = await app.call('GET', `/?token=${encodeURIComponent(ada)}`, { raw: true });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<script (?:type="module" )?src="\/app\.js"><\/script>/);
    const script = await app.call('GET', '/app.js', { raw: true });
    assert.equal(script.status, 200, 'the screen\'s script is served as a static file');
    assert.equal((await app.call('GET', apiPath)).status, 401, 'no token, no data');
    assert.equal((await app.call('GET', apiPath, { as: token(101, 'ada', 'usernode:app:999') })).status, 401,
      'a token minted for another app is refused');
    assert.equal((await app.call('GET', '/health')).status, 200);
  }

  async function run(template, apiPath, seeded, flows) {
    const dir = writeRepo(template);
    dirs.push(dir);
    // Production: the tables and nothing in them.
    const prodDb = await database();
    let app = await boot(dir, prodDb, 'production', env);
    assert.equal(seeded((await app.call('GET', apiPath, { as: ada })).data), 0, 'production seeds nothing');
    assert.equal(await app.stop(), 0, `SIGTERM drains and exits 0:\n${app.output()}`);
    assert.match(app.output(), /\[shutdown\] SIGTERM received, draining/);

    // Staging: the seed, once, however many times the preview boots.
    const stagingDb = await database();
    app = await boot(dir, stagingDb, 'staging', env);
    const first = seeded((await app.call('GET', apiPath, { as: ada })).data);
    assert.ok(first > 0, 'staging seeds what its checks read');
    assert.equal(await app.stop(), 0);
    app = await boot(dir, stagingDb, 'staging', env);
    assert.equal(seeded((await app.call('GET', apiPath, { as: ada })).data), first, 'a second boot does not seed again');
    await common(app, apiPath);
    await flows(app);
    assert.equal(await app.stop(), 0, app.output());
  }

  const demo = (rows, key = 'name') => rows.filter((r) => String(r[key]).startsWith('Staging demo')).length;

  await t.test('a tier list: anyone adds, each ranks, the group\'s tier is where the average lands', async () => {
    await run('tier-list-restaurants', '/api/items', (d) => demo(d.items), async (app) => {
      const seeded = (await app.call('GET', '/api/items', { as: ada })).data;
      assert.deepEqual(seeded.items.find((i) => i.id === 900001).tier, 'S', 'the group\'s S row has an item');
      assert.equal(seeded.items.find((i) => i.id === 900005).tier, null, 'one nobody has ranked yet');
      // The board opens on Yours: whoever the check signs in as has ranked
      // nothing, so every item waits in the tray as a chip to drag.
      assert.ok(seeded.items.length > 0 && seeded.items.every((i) => i.yours === null), 'the check\'s tray has items');

      assert.equal((await app.call('POST', '/api/items', { as: ada, body: { name: '   ' } })).status, 400);
      const added = await app.call('POST', '/api/items', { as: ada, body: { name: '  Noodle   Bar ' } });
      assert.equal(added.status, 201);
      const id = added.data.id;
      const again = await app.call('POST', '/api/items', { as: grace, body: { name: 'noodle bar' } });
      assert.equal(again.status, 409, 'the same name twice is one item');
      assert.match(again.data.error, /is already on the list/);

      assert.equal((await app.call('PUT', `/api/items/${id}/tier`, { as: ada, body: { tier: 'Z' } })).status, 400);
      assert.equal((await app.call('PUT', '/api/items/999999/tier', { as: ada, body: { tier: 'S' } })).status, 404);
      await app.call('PUT', `/api/items/${id}/tier`, { as: ada, body: { tier: 'S' } });
      await app.call('PUT', `/api/items/${id}/tier`, { as: grace, body: { tier: 'B' } });
      let item = (await app.call('GET', '/api/items', { as: grace })).data.items.find((i) => i.id === id);
      assert.deepEqual([item.name, item.by, item.mine, item.votes, item.average, item.tier, item.yours],
        ['Noodle Bar', 'ada', false, 2, 4, 'A', 'B']);
      // A tie goes up: 4.5 is S.
      await app.call('PUT', `/api/items/${id}/tier`, { as: grace, body: { tier: 'A' } });
      item = (await app.call('GET', '/api/items', { as: ada })).data.items.find((i) => i.id === id);
      assert.deepEqual([item.average, item.tier, item.yours], [4.5, 'S', 'S']);
      // Tapping your tier again takes it back out.
      assert.deepEqual((await app.call('PUT', `/api/items/${id}/tier`, { as: ada, body: { tier: null } })).data, { tier: null });
      item = (await app.call('GET', '/api/items', { as: ada })).data.items.find((i) => i.id === id);
      assert.deepEqual([item.votes, item.tier, item.yours], [1, 'A', null]);

      assert.equal((await app.call('DELETE', `/api/items/${id}`, { as: grace })).status, 403, 'only whoever added it removes it');
      assert.equal((await app.call('DELETE', `/api/items/${id}`, { as: ada })).status, 200);
      assert.ok(!(await app.call('GET', '/api/items', { as: ada })).data.items.some((i) => i.id === id));
    });
  });

  await t.test('a grocery list: Todo List\'s rules for one shared list', async () => {
    // Production has no staging rows, so its first visitor is offered the
    // examples instead; a staging list already has rows, so it is not.
    const staged = (d) => {
      const n = demo(d.items, 'text');
      if (!n) {
        assert.deepEqual(d.items.map((i) => [i.text, i.checked, i.category_id]),
          [['Milk', false], ['Eggs', false], ['Coffee', false], ['Bread', true]].map((r) => r.concat(d.categories[0].id)),
          'a new list starts with a few examples in General, offered once');
      }
      return n;
    };
    await run('grocery-list', '/api/list', staged, async (app) => {
      const get = async (as = ada) => (await app.call('GET', '/api/list', { as })).data;
      const item = (list, id) => list.items.find((i) => i.id === id);
      let list = await get();
      const general = list.categories[0];
      assert.equal(general.is_default, true, 'General first');
      assert.deepEqual(list.categories.slice(1).map((c) => c.id), [900001, 900002, 900003]);
      assert.equal(list.list.due_dates_enabled, false);

      // Quick-add goes to the top of General; a retried add is the same item.
      const coffee = item(list, 900001);
      const oat = await app.call('POST', '/api/items', { as: ada, body: { text: ' Oat milk ', client_op_id: 'op-1' } });
      assert.equal(oat.status, 200);
      assert.deepEqual([oat.data.item.text, oat.data.item.category_id, oat.data.item.created_by], ['Oat milk', general.id, 'ada']);
      assert.ok(oat.data.item.sort_order < coffee.sort_order, 'at the top');
      const again = await app.call('POST', '/api/items', { as: ada, body: { text: 'Oat milk', client_op_id: 'op-1' } });
      assert.equal(again.data.item.id, oat.data.item.id, 'idempotent');
      assert.equal((await get()).items.filter((i) => i.text === 'Oat milk').length, 1);
      assert.equal((await app.call('POST', '/api/items', { as: ada, body: { text: '  ' } })).status, 400);

      // Into a category: its top.
      const lemons = (await app.call('POST', '/api/categories/900001/items', { as: ada, body: { text: 'Lemons' } })).data.item;
      assert.deepEqual([lemons.category_id, lemons.sort_order], [900001, 0]);
      assert.equal((await app.call('POST', '/api/categories/999/items', { as: ada, body: { text: 'x' } })).status, 404);

      // Ticking keeps the place and says who; the activity line is somebody else's.
      const ticked = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: grace, body: { checked: true } })).data.item;
      assert.deepEqual([ticked.checked, ticked.last_checked_by, ticked.sort_order], [true, 'grace', 0]);
      list = await get();
      assert.deepEqual(list.activity, { actor: 'grace', verb: 'checked', text: 'Lemons' });
      assert.equal((await get(grace)).activity.actor !== 'grace', true, 'never your own');
      const order = list.items.map((i) => i.checked);
      assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'open items first, then ticked');
      const unticked = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { checked: false } })).data.item;
      assert.deepEqual([unticked.checked, unticked.completed_at, unticked.last_checked_by, unticked.sort_order], [false, null, 'ada', 0]);

      // Edit, and move to another category: its end.
      assert.equal((await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { text: 'Limes' } })).data.item.text, 'Limes');
      assert.equal((await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { text: ' ' } })).status, 400);
      const moved = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { category_id: 900002 } })).data.item;
      assert.equal(moved.category_id, 900002);
      assert.ok(moved.sort_order > item(list, 900005).sort_order, 'at the end');
      assert.equal((await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { category_id: 999 } })).status, 400);
      assert.equal((await app.call('PATCH', '/api/items/999999', { as: ada, body: { text: 'x' } })).status, 404);

      // Due dates: wall-clock values, a time only with a date, off keeps them.
      assert.equal((await app.call('PATCH', '/api/list', { as: grace, body: { due_dates_enabled: true } })).status, 200);
      assert.equal((await get()).list.due_dates_enabled, true);
      assert.equal((await app.call('PATCH', '/api/list', { as: grace, body: {} })).status, 400);
      let due = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { due_date: '2026-10-10', due_time: '18:30' } })).data.item;
      assert.deepEqual([due.due_date, due.due_time], ['2026-10-10', '18:30']);
      assert.equal((await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { due_date: '10/10/2026' } })).status, 400);
      assert.equal((await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { due_time: '25:00' } })).status, 400);
      await app.call('PATCH', '/api/list', { as: grace, body: { due_dates_enabled: false } });
      assert.equal(item(await get(), lemons.id).due_date, '2026-10-10', 'switching due dates off keeps them');
      due = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { due_date: null } })).data.item;
      assert.deepEqual([due.due_date, due.due_time], [null, null], 'clearing the date clears the time');
      due = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { due_time: '09:00' } })).data.item;
      assert.equal(due.due_time, null, 'no time without a date');

      // Removing says who removed what, after the item is gone.
      assert.equal((await app.call('DELETE', `/api/items/${oat.data.item.id}`, { as: grace })).status, 200, 'it is everyone\'s list');
      assert.equal((await app.call('DELETE', `/api/items/${oat.data.item.id}`, { as: grace })).status, 404);
      assert.deepEqual((await get()).activity, { actor: 'grace', verb: 'removed', text: 'Oat milk' });

      // Categories: add at the end, rename, reorder with General pinned.
      const bakery = (await app.call('POST', '/api/categories', { as: ada, body: { name: 'Bakery' } })).data.category;
      assert.equal(bakery.is_default, false);
      assert.equal((await app.call('POST', '/api/categories', { as: ada, body: { name: '' } })).status, 400);
      await app.call('PATCH', `/api/categories/${bakery.id}`, { as: grace, body: { name: 'Bread' } });
      const ids = [900003, bakery.id, general.id, 900001, 900002];
      assert.equal((await app.call('POST', '/api/categories/reorder', { as: ada, body: { categoryIds: ids } })).status, 200);
      list = await get();
      assert.deepEqual(list.categories.map((c) => c.id), [general.id, 900003, bakery.id, 900001, 900002]);
      assert.equal(list.categories[2].name, 'Bread');
      assert.equal((await app.call('POST', '/api/categories/reorder', { as: ada, body: { categoryIds: ['x'] } })).status, 400);

      // Reorder one section of a category by hand.
      await app.call('POST', '/api/categories/900001/reorder-items', { as: ada, body: { itemIds: [900004, 900002] } });
      list = await get();
      assert.deepEqual(list.items.filter((i) => i.category_id === 900001 && !i.checked).map((i) => i.id), [900004, 900002]);

      // Deleting a category deletes its items, and records each removal.
      assert.equal((await app.call('DELETE', '/api/categories/900002', { as: grace })).status, 200);
      list = await get();
      assert.ok(!list.items.some((i) => i.id === lemons.id || i.id === 900005));
      assert.equal(list.activity.verb, 'removed');

      // Markdown import: add merges by name (General is the General part);
      // replace starts again. The last category cannot go.
      const imported = await app.call('POST', '/api/import', { as: ada, body: { mode: 'add', categories: [
        { name: 'bread', items: [{ text: 'Sourdough' }, { text: 'Bagels', checked: true }] },
        { name: 'General', items: [{ text: 'Salt' }] },
      ] } });
      assert.equal(imported.status, 200);
      list = await get();
      assert.equal(list.categories.length, 4, 'nothing new: both merged');
      assert.deepEqual(list.items.filter((i) => i.category_id === bakery.id).map((i) => [i.text, i.checked]), [['Sourdough', false], ['Bagels', true]]);
      assert.ok(list.items.some((i) => i.text === 'Salt' && i.category_id === general.id));
      assert.equal((await app.call('POST', '/api/import', { as: ada, body: { categories: [] } })).status, 400);
      await app.call('POST', '/api/import', { as: ada, body: { mode: 'replace', categories: [{ name: 'General', items: [{ text: 'Only this' }] }] } });
      list = await get();
      assert.deepEqual([list.categories.length, list.categories[0].is_default, list.items.map((i) => i.text)], [1, true, ['Only this']]);
      const last = await app.call('DELETE', `/api/categories/${list.categories[0].id}`, { as: ada });
      assert.deepEqual([last.status, last.data.error], [400, "Can't delete the only category: a list needs at least one"]);
    });
  });

  await t.test('a chore list: always one person\'s or taking turns round the project\'s members, moving on every Monday', async () => {
    await run('chore-list', '/api/chores', (d) => demo(d.chores), async (app) => {
      const thursday = '2026-10-08T12:00:00Z';
      const nextMonday = '2026-10-12T09:00:00Z';
      const week = await app.call('GET', '/api/chores', { as: ada, now: thursday });
      assert.equal(week.data.week, '2026-10-05', 'the Monday of the week, UTC');
      assert.equal(week.data.rota, 'ok');
      assert.equal(week.data.people, 2);
      assert.deepEqual(week.data.members.map((m) => m.username), ['ada', 'grace'], 'the platform\'s member list, for the picker');
      const turning = week.data.chores.filter((c) => !c.fixed);
      assert.ok(turning.every((c) => c.turn === 'ada' || c.turn === 'grace'), 'only the project\'s members');
      assert.ok(turning.some((c) => c.turn === 'ada') && turning.some((c) => c.turn === 'grace'), 'shared out');
      const first = turning[0];
      assert.equal(first.yours, first.turn === 'ada');
      assert.equal(first.next, first.turn === 'ada' ? 'grace' : 'ada', 'next week is the next member');
      const plants = week.data.chores.find((c) => c.id === 900005);
      assert.deepEqual([plants.fixed, plants.turn, plants.next], [true, 'staging-demo-user', null], 'always the same person\'s');
      const later = await app.call('GET', '/api/chores', { as: ada, now: nextMonday });
      assert.equal(later.data.week, '2026-10-12');
      assert.equal(later.data.chores.find((c) => c.id === first.id).turn, first.next, 'on Monday it moves on');

      // Always Grace's, then taking turns again.
      const mow = await app.call('POST', '/api/chores', { as: ada, body: { name: 'Mow the lawn', assigneeId: 102 } });
      assert.equal(mow.status, 201);
      let chore = (await app.call('GET', '/api/chores', { as: ada, now: thursday })).data.chores.find((c) => c.id === mow.data.id);
      assert.deepEqual([chore.fixed, chore.turn, chore.yours], [true, 'grace', false]);
      chore = (await app.call('GET', '/api/chores', { as: grace, now: thursday })).data.chores.find((c) => c.id === mow.data.id);
      assert.equal(chore.yours, true);
      assert.equal((await app.call('POST', '/api/chores', { as: ada, body: { name: 'Bins', assigneeId: 103 } })).status, 400,
        'nobody outside the project gets a chore');
      await app.call('PATCH', `/api/chores/${mow.data.id}`, { as: grace, body: { name: 'Mow the lawn and edges', assigneeId: null } });
      chore = (await app.call('GET', '/api/chores', { as: ada, now: thursday })).data.chores.find((c) => c.id === mow.data.id);
      assert.deepEqual([chore.name, chore.fixed], ['Mow the lawn and edges', false]);
      assert.ok(chore.turn === 'ada' || chore.turn === 'grace');

      // Done this week only.
      assert.deepEqual((await app.call('PUT', `/api/chores/${mow.data.id}/done`, { as: grace, body: { done: true }, now: thursday })).data, { done: true });
      chore = (await app.call('GET', '/api/chores', { as: ada, now: thursday })).data.chores.find((c) => c.id === mow.data.id);
      assert.deepEqual([chore.done, chore.doneBy], [true, 'grace']);
      chore = (await app.call('GET', '/api/chores', { as: ada, now: nextMonday })).data.chores.find((c) => c.id === mow.data.id);
      assert.equal(chore.done, false, 'a new week starts undone');
      assert.equal((await app.call('PUT', '/api/chores/999999/done', { as: ada, body: { done: true } })).status, 404);

      // Somebody the platform does not count as a member sees the chores, not the rota.
      const outsider = await app.call('GET', '/api/chores', { as: sam });
      assert.equal(outsider.data.rota, 'not_member');
      assert.deepEqual(outsider.data.members, []);
      assert.ok(outsider.data.chores.filter((c) => !c.fixed).every((c) => c.turn === null && !c.yours));
      // The declared check's fixed rota, in staging and on ?demo=1 only.
      const fixed = await app.call('GET', '/api/chores?demo=1', { as: sam });
      assert.deepEqual([...new Set(fixed.data.chores.filter((c) => !c.fixed).map((c) => c.turn))].sort(), ['sam', 'staging-demo-ana', 'staging-demo-ben']);
      assert.ok(members.asked.every((u) => u === '/v1/members?limit=200'), 'one route, the conventions\' own');
      assert.equal((await app.call('DELETE', `/api/chores/${mow.data.id}`, { as: ada })).status, 200);
    });
  });

  await t.test('a lending library: who has it now, asking for it, handing it on, and back with its owner', async () => {
    await run('lending-library', '/api/things', (d) => demo(d.things), async (app) => {
      const seeded = (await app.call('GET', '/api/things', { as: ada })).data.things;
      assert.ok(seeded.some((x) => !x.atHome), 'one with somebody else');
      assert.ok(seeded.some((x) => x.asks.length), 'and one somebody asked for');

      const drill = await app.call('POST', '/api/things', { as: ada, body: { name: 'Drill', note: 'Bits in the case' } });
      assert.equal(drill.status, 201);
      const id = drill.data.id;
      const now = '2026-10-08T12:00:00.000Z';
      let thing = (await app.call('GET', '/api/things', { as: ada })).data.things.find((x) => x.id === id);
      assert.deepEqual([thing.atHome, thing.withMe, thing.mine, thing.holder], [true, true, true, 'ada'], 'it starts on your shelf');
      assert.equal((await app.call('POST', `/api/things/${id}/ask`, { as: ada })).status, 400, 'you have it already');

      // Grace and Sam ask; Ada hands it to Grace.
      assert.equal((await app.call('POST', `/api/things/${id}/ask`, { as: grace, now })).status, 201);
      assert.equal((await app.call('POST', `/api/things/${id}/ask`, { as: grace, now })).status, 201, 'asking again does nothing');
      await app.call('POST', `/api/things/${id}/ask`, { as: sam, now: '2026-10-08T13:00:00.000Z' });
      thing = (await app.call('GET', '/api/things', { as: ada })).data.things[0];
      assert.equal(thing.id, id, 'what you have and somebody asked for comes first');
      assert.deepEqual(thing.asks.map((a) => a.username), ['grace', 'sam'], 'first come, first served');
      assert.equal((await app.call('POST', `/api/things/${id}/hand`, { as: sam, body: { to: 102 } })).status, 403, 'not yours to hand on');
      assert.equal((await app.call('POST', `/api/things/${id}/hand`, { as: ada, body: { to: 999 } })).status, 400, 'only to somebody who asked');
      assert.equal((await app.call('POST', `/api/things/${id}/hand`, { as: ada, body: { to: 102 }, now })).status, 200);
      thing = (await app.call('GET', '/api/things', { as: grace })).data.things.find((x) => x.id === id);
      assert.deepEqual([thing.atHome, thing.withMe, thing.holder, thing.since, thing.asks.map((a) => a.username)],
        [false, true, 'grace', now, ['sam']], 'with Grace, and Sam is still in line');

      // Grace hands it on to Sam; Sam takes his ask back meanwhile is not needed.
      assert.equal((await app.call('POST', `/api/things/${id}/hand`, { as: grace, body: { to: 103 } })).status, 200);
      thing = (await app.call('GET', '/api/things', { as: sam })).data.things.find((x) => x.id === id);
      assert.deepEqual([thing.holder, thing.asks.length], ['sam', 0]);
      // Grace asks again, then takes it back.
      await app.call('POST', `/api/things/${id}/ask`, { as: grace });
      assert.equal((await app.call('DELETE', `/api/things/${id}/ask`, { as: grace })).status, 200);
      assert.equal((await app.call('GET', '/api/things', { as: grace })).data.things.find((x) => x.id === id).askedByMe, false);

      assert.equal((await app.call('DELETE', `/api/things/${id}`, { as: ada })).status, 403, 'not while somebody else has it');
      assert.equal((await app.call('POST', `/api/things/${id}/back`, { as: grace })).status, 403);
      assert.equal((await app.call('POST', `/api/things/${id}/back`, { as: ada })).status, 200, 'its owner says it is back');
      thing = (await app.call('GET', '/api/things', { as: ada })).data.things.find((x) => x.id === id);
      assert.equal(thing.atHome, true);
      assert.equal((await app.call('DELETE', `/api/things/${id}`, { as: grace })).status, 403, 'only its owner takes it out');
      assert.equal((await app.call('DELETE', `/api/things/${id}`, { as: ada })).status, 200);
    });
  });

  await t.test('a potluck planner: who brings what by course, coming up by "now"', async () => {
    await run('potluck-planner', '/api/potlucks', (d) => demo(d.upcoming, 'title'), async (app) => {
      const seeded = (await app.call('GET', '/api/potlucks', { as: ada })).data;
      const demoPotluck = seeded.upcoming.find((p) => p.id === 900001);
      assert.ok(demoPotluck.courses.some((c) => c.dishes.length), 'the check\'s dishes');
      assert.ok(demoPotluck.courses.some((c) => c.course !== 'Other' && !c.dishes.length), 'and a course nobody has taken');
      assert.ok(demoPotluck.messages.length, 'and its chat');

      const now = '2026-10-08T12:00:00.000Z';
      const startsAt = '2026-10-10T18:00:00.000Z';
      assert.equal((await app.call('POST', '/api/potlucks', { as: ada, body: { title: 'x', startsAt: 'soon' } })).status, 400);
      assert.equal((await app.call('POST', '/api/potlucks', { as: ada, body: { title: 'x', startsAt: '2026-10-01T18:00:00Z' }, now })).status, 400, 'not in the past');
      const plan = await app.call('POST', '/api/potlucks', { as: ada, body: { title: 'Harvest potluck', startsAt, place: 'Ada\'s place' }, now });
      assert.equal(plan.status, 201);
      const id = plan.data.id;
      assert.equal((await app.call('POST', `/api/potlucks/${id}/dishes`, { as: grace, body: { course: 'Snacks', dish: 'Crisps' } })).status, 400);
      const pie = await app.call('POST', `/api/potlucks/${id}/dishes`, { as: grace, body: { course: 'Desserts', dish: 'Apple pie' } });
      assert.equal(pie.status, 201);
      await app.call('POST', `/api/potlucks/${id}/dishes`, { as: sam, body: { course: 'Mains', dish: 'Chili' } });

      let p = (await app.call('GET', '/api/potlucks', { as: grace, now })).data.upcoming.find((x) => x.id === id);
      assert.deepEqual([p.title, p.startsAt, p.place, p.host, p.mine, p.dishes], ['Harvest potluck', startsAt, 'Ada\'s place', 'ada', false, 2]);
      assert.deepEqual(p.messages, [], 'a new potluck\'s chat is empty');
      const desserts = p.courses.find((c) => c.course === 'Desserts');
      assert.deepEqual(desserts.dishes.map((d) => [d.dish, d.by, d.mine, d.canRemove]), [['Apple pie', 'grace', true, true]]);
      assert.deepEqual(p.courses.map((c) => c.course), ['Mains', 'Sides', 'Salads', 'Desserts', 'Drinks', 'Other']);
      // Coming up until six hours after it starts, then past.
      const after = (await app.call('GET', '/api/potlucks', { as: ada, now: '2026-10-10T22:00:00Z' })).data;
      assert.ok(after.upcoming.some((x) => x.id === id), 'still on that evening');
      const gone = (await app.call('GET', '/api/potlucks', { as: ada, now: '2026-10-12T12:00:00Z' })).data;
      assert.ok(!gone.upcoming.some((x) => x.id === id) && gone.past.some((x) => x.id === id), 'then past');

      // Reactions toggle; comments and the chat are kept in order.
      assert.equal((await app.call('POST', `/api/dishes/${pie.data.id}/reactions`, { as: ada, body: { emoji: '🍕' } })).status, 400);
      assert.deepEqual((await app.call('POST', `/api/dishes/${pie.data.id}/reactions`, { as: ada, body: { emoji: '😋' } })).data, { on: true });
      await app.call('POST', `/api/dishes/${pie.data.id}/reactions`, { as: sam, body: { emoji: '😋' } });
      await app.call('POST', `/api/dishes/${pie.data.id}/reactions`, { as: sam, body: { emoji: '🔥' } });
      assert.deepEqual((await app.call('POST', `/api/dishes/${pie.data.id}/reactions`, { as: sam, body: { emoji: '🔥' } })).data, { on: false }, 'again takes it back');
      assert.equal((await app.call('POST', `/api/dishes/${pie.data.id}/comments`, { as: ada, body: { text: ' ' } })).status, 400);
      await app.call('POST', `/api/dishes/${pie.data.id}/comments`, { as: ada, body: { text: 'Is it the one with cinnamon?' }, now });
      await app.call('POST', `/api/dishes/${pie.data.id}/comments`, { as: grace, body: { text: 'Yes!' }, now: '2026-10-08T12:05:00.000Z' });
      assert.equal((await app.call('POST', `/api/potlucks/${id}/messages`, { as: sam, body: { text: '' } })).status, 400);
      await app.call('POST', `/api/potlucks/${id}/messages`, { as: sam, body: { text: 'Who has a big table?' }, now });
      await app.call('POST', `/api/potlucks/${id}/messages`, { as: ada, body: { text: 'Mine folds out' }, now: '2026-10-08T12:01:00.000Z' });
      assert.equal((await app.call('POST', '/api/potlucks/999999/messages', { as: ada, body: { text: 'hi' } })).status, 404);
      p = (await app.call('GET', '/api/potlucks', { as: grace, now })).data.upcoming.find((x) => x.id === id);
      const pieNow = p.courses.find((c) => c.course === 'Desserts').dishes[0];
      assert.deepEqual(pieNow.reactions.map((r) => [r.emoji, r.count, r.mine, r.people]), [['😋', 2, false, ['ada', 'sam']]]);
      assert.deepEqual(pieNow.comments.map((c) => [c.by, c.text, c.mine]), [['ada', 'Is it the one with cinnamon?', false], ['grace', 'Yes!', true]]);
      assert.deepEqual(p.messages.map((m) => [m.by, m.text]), [['sam', 'Who has a big table?'], ['ada', 'Mine folds out']], 'oldest first');

      const chili = p.courses.find((c) => c.course === 'Mains').dishes.find((d) => d.dish === 'Chili');
      assert.equal((await app.call('DELETE', `/api/dishes/${chili.id}`, { as: grace })).status, 403, 'not somebody else\'s dish');
      assert.equal((await app.call('DELETE', `/api/dishes/${chili.id}`, { as: ada })).status, 200, 'the host can');
      assert.equal((await app.call('DELETE', `/api/potlucks/${id}`, { as: grace })).status, 403, 'only the host calls it off');
      assert.equal((await app.call('DELETE', `/api/potlucks/${id}`, { as: ada })).status, 200);
      p = (await app.call('GET', '/api/potlucks', { as: ada, now })).data.upcoming.find((x) => x.id === id);
      assert.equal(p, undefined);
    });
  });

  // A study timer through its own flow, not run(): it seeds nothing, so
  // `run`'s staging assertions do not apply. Its only data is each viewer's
  // own count of finished sessions (its table is staging:private), which
  // the staging conventions keep out of a preview: a preview's Today card
  // starts empty, which is the honest state for it.
  await t.test('a study timer: one count per person, a retried session counts once, the day where the person is', async () => {
    const dir = writeRepo('study-timer');
    dirs.push(dir);

    // The zone's wall-clock "yesterday 23:30" as of PINNED NOW, as an ISO
    // instant: what x-usernode-now sends, and what finished_at then stores.
    const PINNED_NOW = '2026-10-11T12:00:00Z';
    function yesterdayEnd(zone) {
      const offsetOf = (at) => {
        const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
          .formatToParts(at).find((p) => p.type === 'timeZoneName').value; // "GMT+02:00"
        const sign = part.startsWith('GMT-') ? -1 : 1;
        const [h, m] = part.replace(/^GMT[+-]/, '').split(':').map(Number);
        return sign * (h * 60 + m) * 60000;
      };
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(Date.parse(PINNED_NOW) - DAY));
      const get = (type) => parts.find((p) => p.type === type).value;
      const wall = `${get('year')}-${get('month')}-${get('day')}T23:30:00Z`;
      const first = Date.parse(wall);
      return new Date(first - offsetOf(new Date(first))).toISOString();
    }

    // Production: the table, and nothing in it.
    const prodDb = await database();
    let app = await boot(dir, prodDb, 'production', env);
    let today = (await app.call('GET', '/api/today?tz=Europe/Berlin', { as: ada })).data;
    assert.deepEqual([today.me.id, today.me.username, today.count], [101, 'ada', 0], 'production seeds nothing');
    assert.match(today.day, /^\d{4}-\d{2}-\d{2}$/, 'the day is the viewer’s own');
    assert.equal(await app.stop(), 0, `SIGTERM drains and exits 0:\n${app.output()}`);
    assert.match(app.output(), /\[shutdown\] SIGTERM received, draining/);

    // Staging: no seed, and the app still works for whoever opens it.
    const stagingDb = await database();
    app = await boot(dir, stagingDb, 'staging', env);
    await common(app, '/api/today');
    assert.equal((await app.call('GET', '/api/today', { as: ada })).data.count, 0, 'a preview starts empty');

    // A session that runs out is counted once, however many times the same
    // key arrives; each person's count is their own. Posted and read as of
    // the pinned "now", so every session lands on Oct 11 in every zone
    // named below.
    let posted = await app.call('POST', '/api/sessions', { as: ada, body: { key: 'session-ada-1', tz: 'Europe/Berlin' }, now: PINNED_NOW });
    assert.equal(posted.status, 201);
    assert.equal(posted.data.count, 1);
    posted = await app.call('POST', '/api/sessions', { as: ada, body: { key: 'session-ada-1', tz: 'Europe/Berlin' }, now: PINNED_NOW });
    assert.equal(posted.status, 201, 'the same key again is accepted, and counts no more');
    assert.equal(posted.data.count, 1);
    await app.call('POST', '/api/sessions', { as: ada, body: { key: 'session-ada-2', tz: 'Europe/Berlin' }, now: PINNED_NOW });
    assert.equal((await app.call('GET', '/api/today?tz=Europe/Berlin', { as: ada, now: PINNED_NOW })).data.count, 2);
    assert.equal((await app.call('GET', '/api/today', { as: grace })).data.count, 0, 'nobody else’s sessions');
    assert.equal((await app.call('POST', '/api/sessions', { as: ada, body: { key: 'short' } })).status, 400, 'a key that is not a key');
    assert.equal((await app.call('POST', '/api/sessions', { as: ada, body: {} })).status, 400);

    // The day is the viewer's own. The reads are pinned to a fixed "now"
    // (Oct 11, midday UTC) so the day each session lands in is the same
    // whenever this runs.
    const berlin = yesterdayEnd('Europe/Berlin');
    await app.call('POST', '/api/sessions', { as: ada, body: { key: 'session-berlin-late', tz: 'Europe/Berlin' }, now: berlin });
    assert.equal((await app.call('GET', '/api/today?tz=Europe/Berlin', { as: ada, now: PINNED_NOW })).data.count, 2, 'not today where they are');
    assert.equal((await app.call('GET', '/api/today?tz=Not/AZone', { as: ada, now: PINNED_NOW })).data.count, 2, 'an unknown zone falls back to UTC');

    // And one that is yesterday on the US west coast is already today in
    // UTC: the fallback really does count by UTC.
    const angeles = yesterdayEnd('America/Los_Angeles');
    await app.call('POST', '/api/sessions', { as: ada, body: { key: 'session-angeles-late', tz: 'America/Los_Angeles' }, now: angeles });
    assert.equal((await app.call('GET', '/api/today?tz=America/Los_Angeles', { as: ada, now: PINNED_NOW })).data.count, 2, 'yesterday there');
    assert.equal((await app.call('GET', '/api/today?tz=Not/AZone', { as: ada, now: PINNED_NOW })).data.count, 3, 'and today in UTC');
    assert.equal(await app.stop(), 0, app.output());
  });

  await t.test('a group poll: options from anyone, ticks or one pick, closing by time or by hand, and the winner kept', async () => {
    const polls = (d) => d.open.concat(d.decided);
    await run('poll-dinner', '/api/polls', (d) => demo(polls(d), 'question'), async (app) => {
      const get = async (as = ada, now) => (await app.call('GET', '/api/polls', { as, now })).data;
      const find = (d, id) => polls(d).find((p) => p.id === id);
      const opt = (p, label) => p.options.find((o) => o.label === label);

      // The seed: an open poll whose bars differ, and a decided one with a winner.
      let d = await get();
      const seeded = find(d, 900001);
      assert.deepEqual([seeded.closed, seeded.closesAt, seeded.mode], [false, null, 'approval'], 'open whenever a preview is opened');
      assert.deepEqual(seeded.options.map((o) => [o.votes, o.leading]), [[4, true], [3, false], [2, false], [1, false]]);
      assert.deepEqual([seeded.turnout.voted, seeded.turnout.of, seeded.turnout.ofVoted, seeded.turnout.waitingOn],
        [5, 2, 0, ['ada', 'grace']], 'the platform\'s members, none of whom voted');
      assert.deepEqual(d.decided.find((p) => p.id === 900002).winners, ['Staging demo winner']);
      // Somebody the platform does not count as a member (the check runner) gets a plain count.
      const outside = await get(sam);
      assert.equal(outside.members, 'not_member');
      assert.deepEqual([find(outside, 900001).turnout.voted, find(outside, 900001).turnout.of], [5, null]);

      // Starting one: a question, two different options at least, a mode, a closing time still to come.
      const now = '2026-10-15T12:00:00.000Z';
      const start = (body, as = ada) => app.call('POST', '/api/polls', { as, body, now });
      assert.equal((await start({ question: ' ', options: ['A', 'B'] })).status, 400);
      assert.equal((await start({ question: 'Lunch?', options: ['Tacos', '  '] })).status, 400, 'two options at least');
      assert.equal((await start({ question: 'Lunch?', options: ['Tacos', ' tacos '] })).status, 400, 'each once');
      assert.equal((await start({ question: 'Lunch?', options: 'Tacos, Pho' })).status, 400);
      assert.equal((await start({ question: 'Lunch?', options: ['Tacos', 'Pho'], mode: 'ranked' })).status, 400);
      assert.equal((await start({ question: 'Lunch?', options: ['Tacos', 'Pho'], closesAt: 'tonight' })).status, 400);
      assert.equal((await start({ question: 'Lunch?', options: ['Tacos', 'Pho'], closesAt: '2026-10-15T11:59:00.000Z' })).status, 400, 'not in the past');
      assert.equal((await start({ question: 'Lunch?', options: ['Tacos', 'Pho'], closesAt: '2028-10-15T12:00:00.000Z' })).status, 400, 'not years away');
      const closesAt = '2026-10-15T21:00:00.000Z';
      const lunch = await start({ question: '  Where   for lunch? ', options: ['Tacos', 'Pho', ''], closesAt });
      assert.equal(lunch.status, 201);
      const id = lunch.data.id;
      let p = find(await get(grace, now), id);
      assert.deepEqual([p.question, p.mode, p.secret, p.closesAt, p.closed, p.by, p.mine, p.canClose],
        ['Where for lunch?', 'approval', false, closesAt, false, 'ada', false, false]);
      assert.deepEqual(p.options.map((o) => [o.label, o.by, o.votes, o.canRemove]), [['Tacos', 'ada', 0, false], ['Pho', 'ada', 0, false]]);

      // Anyone adds options; the same one twice, whatever its case or spacing, is refused.
      assert.equal((await app.call('POST', `/api/polls/${id}/options`, { as: grace, body: { label: ' Ramen  bar ' }, now })).status, 201);
      const dup = await app.call('POST', `/api/polls/${id}/options`, { as: sam, body: { label: 'RAMEN bar' }, now });
      assert.equal(dup.status, 409);
      assert.match(dup.data.error, /already an option/);
      assert.equal((await app.call('POST', `/api/polls/${id}/options`, { as: sam, body: { label: '  ' }, now })).status, 400);
      assert.equal((await app.call('POST', '/api/polls/999999/options', { as: sam, body: { label: 'Sushi' }, now })).status, 404);

      // Tick any they like: every option you would be happy with, and take a tick back.
      p = find(await get(ada, now), id);
      const [tacos, pho, ramen] = ['Tacos', 'Pho', 'Ramen bar'].map((l) => opt(p, l));
      const vote = (as, optionId, on) => app.call('PUT', `/api/options/${optionId}/vote`, { as, body: { on }, now });
      assert.deepEqual((await vote(ada, tacos.id, true)).data, { on: true });
      await vote(ada, pho.id, true);
      await vote(grace, pho.id, true);
      await vote(ada, pho.id, true);
      p = find(await get(ada, now), id);
      assert.deepEqual(p.options.map((o) => [o.label, o.votes, o.yours, o.leading]),
        [['Tacos', 1, true, false], ['Pho', 2, true, true], ['Ramen bar', 0, false, false]]);
      assert.deepEqual(opt(p, 'Pho').voters, ['ada', 'grace'], 'not secret: who voted for what');
      assert.deepEqual([p.turnout.voted, p.turnout.of, p.turnout.ofVoted, p.turnout.waitingOn], [2, 2, 2, []]);
      await vote(ada, tacos.id, false);
      assert.equal(opt(find(await get(ada, now), id), 'Tacos').votes, 0);
      assert.equal((await vote(ada, 999999, true)).status, 404);

      // Taking an option off: whoever added it, while two are left.
      assert.equal((await app.call('DELETE', `/api/options/${ramen.id}`, { as: ada, now })).status, 403);
      assert.equal(opt(find(await get(grace, now), id), 'Ramen bar').canRemove, true);
      assert.equal((await app.call('DELETE', `/api/options/${ramen.id}`, { as: grace, now })).status, 200);
      assert.equal((await app.call('DELETE', `/api/options/${ramen.id}`, { as: grace, now })).status, 404);
      assert.equal((await app.call('DELETE', `/api/options/${tacos.id}`, { as: ada, now })).status, 409, 'a poll keeps two options');

      // The closing time decides, read at "now": open before it, decided from it, and nothing changes after.
      assert.ok((await get(ada, '2026-10-15T20:59:00.000Z')).open.some((x) => x.id === id));
      const later = closesAt;
      d = await get(ada, later);
      assert.ok(!d.open.some((x) => x.id === id));
      p = d.decided.find((x) => x.id === id);
      assert.deepEqual([p.closed, p.decidedAt, p.winners, p.canClose], [true, closesAt, ['Pho'], false]);
      assert.equal((await app.call('PUT', `/api/options/${pho.id}/vote`, { as: grace, body: { on: false }, now: later })).status, 409);
      assert.equal((await app.call('POST', `/api/polls/${id}/options`, { as: grace, body: { label: 'Sushi' }, now: later })).status, 409);
      assert.equal((await app.call('POST', `/api/polls/${id}/close`, { as: ada, now: later })).status, 409);

      // Pick one, secret, closed by its starter: a pick moves, no names show, a tie names both.
      const film = await start({ question: 'Which film?', options: ['Arrival', 'Heat', 'Up'], mode: 'single', secret: true, closesAt: null }, grace);
      assert.equal(film.status, 201);
      const fid = film.data.id;
      p = find(await get(grace, now), fid);
      assert.deepEqual([p.mode, p.secret, p.closesAt, p.canClose], ['single', true, null, true], 'open until its starter closes it');
      const [arrival, heat, up] = p.options;
      await vote(ada, arrival.id, true);
      await vote(ada, heat.id, true);
      await vote(grace, arrival.id, true);
      await vote(sam, up.id, true);
      p = find(await get(ada, now), fid);
      assert.deepEqual(p.options.map((o) => [o.votes, o.yours]), [[1, false], [1, true], [1, false]], 'a pick moves');
      assert.ok(p.options.every((o) => o.voters === null), 'no names by an option');
      assert.deepEqual([p.turnout.voted, p.turnout.ofVoted, p.turnout.votedBy, p.turnout.waitingOn], [3, 2, null, null], 'counts only');
      assert.ok(!JSON.stringify(await get(grace, now)).includes('"sam"'), 'not even who has voted');
      await vote(sam, up.id, false);
      assert.equal((await app.call('POST', `/api/polls/${fid}/close`, { as: ada, now })).status, 403, 'only its starter closes it');
      assert.equal((await app.call('POST', `/api/polls/${fid}/close`, { as: grace, now })).status, 200);
      p = (await get(ada, now)).decided.find((x) => x.id === fid);
      assert.deepEqual([p.decidedAt, p.winners], [now, ['Arrival', 'Heat']], 'a tie names every option on top');
      assert.equal((await vote(ada, arrival.id, true)).status, 409);
      assert.equal((await app.call('POST', '/api/polls/999999/close', { as: grace, now })).status, 404);

      // Its starter deletes a poll, open or decided.
      assert.equal((await app.call('DELETE', `/api/polls/${fid}`, { as: ada })).status, 403);
      assert.equal((await app.call('DELETE', `/api/polls/${fid}`, { as: grace })).status, 200);
      assert.equal((await app.call('DELETE', `/api/polls/${fid}`, { as: grace })).status, 404);
      assert.equal(find(await get(ada, now), fid), undefined);
      assert.equal((await app.call('DELETE', `/api/polls/${id}`, { as: ada })).status, 200);
    });
  });

  await t.test('find a time: suggested times, everyone\'s marks, the best rising, the starter setting it, and past by "now"', async () => {
    await run('find-a-time-book-club', '/api/plans', (d) => demo(d.plans), async (app) => {
      const get = async (as = ada, now) => (await app.call('GET', '/api/plans', { as, now })).data;
      const plan = async (id, as = ada, now) => (await get(as, now)).plans.find((p) => p.id === id);
      const slotAt = (p, iso) => p.slots.find((s) => s.startsAt === iso);

      // The seed: an open plan with its grid filled in and a best time.
      let d = await get();
      const seeded = d.plans.find((p) => p.id === 900001);
      assert.deepEqual([seeded.open, seeded.answered, seeded.slots.length, seeded.best], [true, 5, 4, 900002]);
      assert.deepEqual(seeded.people.map((p) => p.username),
        ['staging-demo-user', 'staging-demo-ana', 'staging-demo-ben', 'staging-demo-cy', 'staging-demo-dee'], 'in the order they answered');
      assert.ok(seeded.slots.every((s) => Object.keys(s.marks).length === 5), 'every cell of the check\'s grid is marked');
      assert.match(seeded.slots.find((s) => s.allDay).startsAt, /T00:00:00\.000Z$/, 'a whole day is its date\'s midnight UTC');
      // Who still has to answer is the platform's member list, never the fake people.
      assert.equal(d.members, 'ok');
      assert.deepEqual(seeded.waiting.map((w) => [w.username, w.me]), [['ada', true], ['grace', false]]);
      const outsider = await get(sam);
      assert.equal(outsider.members, 'not_member');
      assert.equal(outsider.plans.find((p) => p.id === 900001).waiting, null, 'not a member: no list, and the grid all the same');

      // Starting a plan: a name and two to eight times, none of them passed.
      const now = '2030-03-02T12:00:00.000Z';
      const t1 = '2030-03-05T19:00:00.000Z';
      const t2 = '2030-03-06T19:00:00.000Z';
      const day = '2030-03-07T00:00:00.000Z';
      const start = (body, as = ada) => app.call('POST', '/api/plans', { as, body, now });
      const many = Array.from({ length: 9 }, (_, i) => ({ startsAt: `2030-03-1${i}T10:00:00.000Z` }));
      for (const [body, why] of [
        [{ name: ' ', times: [{ startsAt: t1 }, { startsAt: t2 }] }, 'a name'],
        [{ name: 'x', times: [{ startsAt: t1 }] }, 'two times at least'],
        [{ name: 'x', times: many }, 'eight at most'],
        [{ name: 'x', times: [{ startsAt: t1 }, { startsAt: 'soon' }] }, 'a real time'],
        [{ name: 'x', times: [{ startsAt: t1 }, { startsAt: '2030-03-01T19:00:00Z' }] }, 'not passed'],
        [{ name: 'x', times: [{ startsAt: t1 }, { startsAt: '2030-03-05T20:00:00+01:00' }] }, 'two different times'],
      ]) assert.equal((await start(body)).status, 400, why);
      // A whole day is kept as its date, whatever time came with it.
      const made = await start({ name: '  November   book club ', times: [{ startsAt: t2 }, { startsAt: t1 }, { startsAt: '2030-03-07T13:45:00.000Z', allDay: true }] });
      assert.equal(made.status, 201);
      const id = made.data.id;
      let p = await plan(id, grace, now);
      assert.deepEqual([p.name, p.by, p.mine, p.open, p.answered, p.best, p.set], ['November book club', 'ada', false, true, 0, null, null]);
      assert.deepEqual(p.slots.map((s) => [s.startsAt, s.allDay, s.passed]), [[t1, false, false], [t2, false, false], [day, true, false]], 'earliest first');
      assert.ok(p.slots.every((s) => !s.canRemove), 'grace started none of it');
      assert.ok((await plan(id, ada, now)).slots.every((s) => s.canRemove), 'its starter may take any time off');
      const [s1, s2, s3] = p.slots.map((s) => s.id);

      // Marking: free, maybe (if needed) or no (can't), changed any time.
      const mark = (as, marks, at = now, planId = id) => app.call('PUT', `/api/plans/${planId}/marks`, { as, body: { marks }, now: at });
      assert.equal((await mark(ada, [])).status, 400);
      assert.equal((await mark(ada, [{ slotId: s1, mark: 'yes' }])).status, 400);
      assert.equal((await mark(ada, [{ slotId: 900001, mark: 'free' }])).status, 400, 'only this plan\'s times');
      assert.equal((await mark(ada, [{ slotId: s1, mark: 'free' }], now, 999999)).status, 404);
      assert.equal((await mark(ada, [{ slotId: s1, mark: 'free' }, { slotId: s2, mark: 'maybe' }, { slotId: s3, mark: 'free' }])).status, 200);
      await mark(grace, [{ slotId: s1, mark: 'maybe' }, { slotId: s2, mark: 'free' }, { slotId: s3, mark: 'free' }], '2030-03-02T12:01:00.000Z');
      await mark(sam, [{ slotId: s1, mark: 'no' }, { slotId: s2, mark: 'free' }], '2030-03-02T12:02:00.000Z');
      p = await plan(id, grace, now);
      assert.deepEqual(p.people.map((x) => [x.username, x.me]), [['grace', true], ['ada', false], ['sam', false]], 'you first, then in the order they answered');
      assert.deepEqual(p.slots.map((s) => [s.free, s.maybe]), [[1, 1], [2, 1], [2, 0]]);
      assert.deepEqual(slotAt(p, t1).marks, { 101: 'free', 102: 'maybe', 103: 'no' });
      assert.deepEqual(slotAt(p, day).marks, { 101: 'free', 102: 'free' }, 'sam has not marked the whole day');
      assert.deepEqual(slotAt(p, t2).maybeNames, ['ada']);
      assert.equal(p.best, s2, 'the most free, then the most if needed');
      assert.deepEqual(p.waiting, [], 'every member has answered');
      // Everyone changes their mind, until two times tie: the earliest wins.
      await mark(ada, [{ slotId: s1, mark: 'free' }, { slotId: s2, mark: 'free' }, { slotId: s3, mark: 'maybe' }], '2030-03-02T13:00:00.000Z');
      p = await plan(id, ada, now);
      assert.deepEqual(p.slots.map((s) => [s.free, s.maybe]), [[1, 1], [3, 0], [1, 1]]);
      assert.equal(p.best, s2);
      await mark(grace, [{ slotId: s1, mark: 'free' }, { slotId: s3, mark: 'free' }], '2030-03-02T14:00:00.000Z');
      await mark(sam, [{ slotId: s1, mark: 'free' }, { slotId: s3, mark: 'free' }], '2030-03-02T14:01:00.000Z');
      p = await plan(id, ada, now);
      assert.deepEqual(p.slots.map((s) => s.free), [3, 3, 2]);
      assert.equal(p.best, s1, 'a tie goes to the earliest');
      assert.deepEqual(p.people.map((x) => x.username), ['ada', 'grace', 'sam'], 'changing a mark keeps your place');
      // A time that has passed is never the best.
      assert.equal((await plan(id, ada, '2030-03-05T20:00:00.000Z')).best, s2);
      assert.equal(slotAt(await plan(id, ada, '2030-03-05T20:00:00.000Z'), t1).passed, true);

      // Anyone suggests another time while it is open; its suggester or the
      // plan's starter can take one off; a plan keeps at least two.
      const suggest = (as, body, planId = id) => app.call('POST', `/api/plans/${planId}/slots`, { as, body, now });
      assert.equal((await suggest(grace, { startsAt: '2030-03-01T18:30:00.000Z' })).status, 400, 'not passed');
      assert.equal((await suggest(grace, { startsAt: 'later' })).status, 400);
      assert.equal((await suggest(grace, { startsAt: t1 })).status, 409, 'already suggested');
      assert.equal((await suggest(grace, { startsAt: '2030-03-07T09:00:00.000Z', allDay: true })).status, 409, 'that whole day is already suggested');
      assert.equal((await suggest(grace, { startsAt: t1 }, 999999)).status, 404);
      const t4 = '2030-03-08T18:30:00.000Z';
      const added = await suggest(grace, { startsAt: t4 });
      assert.equal(added.status, 201);
      p = await plan(id, grace, now);
      assert.deepEqual([slotAt(p, t4).by, slotAt(p, t4).canRemove, slotAt(p, t4).free, slotAt(p, t1).canRemove], ['grace', true, 0, false]);
      assert.equal((await app.call('DELETE', `/api/slots/${added.data.id}`, { as: sam })).status, 403, 'not sam\'s to take off');
      assert.equal((await app.call('DELETE', `/api/slots/${added.data.id}`, { as: grace })).status, 200);
      assert.equal((await app.call('DELETE', `/api/slots/${added.data.id}`, { as: grace })).status, 404);
      assert.equal((await app.call('DELETE', `/api/slots/${s3}`, { as: ada })).status, 200, 'the starter can');
      assert.equal((await app.call('DELETE', `/api/slots/${s2}`, { as: ada })).status, 400, 'two left');
      p = await plan(id, ada, now);
      assert.deepEqual([p.slots.map((s) => s.id), p.slots.some((s) => s.canRemove)], [[s1, s2], false]);

      // Only the starter sets the time (any of its times), which closes it.
      const set = (as, slotId, planId = id) => app.call('PUT', `/api/plans/${planId}/set`, { as, body: { slotId }, now });
      assert.equal((await set(grace, s1)).status, 403);
      assert.equal((await set(ada, 900001)).status, 400, 'one of its own times');
      assert.equal((await set(ada, s1, 999999)).status, 404);
      assert.deepEqual((await set(ada, s2)).data, { set: s2 }, 'not only the best');
      p = await plan(id, grace, now);
      assert.deepEqual([p.open, p.set, p.waiting], [false, s2, null]);
      assert.equal((await mark(grace, [{ slotId: s1, mark: 'no' }])).status, 409, 'closed: no more marks');
      assert.equal((await suggest(grace, { startsAt: t4 })).status, 409, 'nor times');
      assert.equal((await app.call('DELETE', `/api/slots/${s1}`, { as: ada })).status, 409);
      assert.deepEqual((await set(ada, null)).data, { set: null }, 'reopened');
      assert.equal((await mark(grace, [{ slotId: s1, mark: 'maybe' }])).status, 200);
      assert.equal((await set(ada, s1)).status, 200);

      // Past by "now": a set plan once its time has passed; an open one once
      // every time has, a whole day once that date is over everywhere.
      assert.ok((await get(ada, '2030-03-05T18:59:00.000Z')).plans.some((x) => x.id === id), 'coming up');
      let later = await get(ada, '2030-03-05T19:01:00.000Z');
      assert.ok(!later.plans.some((x) => x.id === id));
      assert.deepEqual(later.past.find((x) => x.id === id), { id, name: 'November book club', by: 'ada', mine: true, set: { id: s1, startsAt: t1, allDay: false } });
      const trip = await start({ name: 'Lake weekend', times: [{ startsAt: '2030-03-31T10:00:00.000Z' }, { startsAt: '2030-04-01T00:00:00.000Z', allDay: true }] }, grace);
      assert.ok((await get(ada, '2030-04-02T11:59:00.000Z')).plans.some((x) => x.id === trip.data.id), 'that day still goes on in UTC-12');
      later = await get(ada, '2030-04-02T12:01:00.000Z');
      assert.deepEqual(later.past.find((x) => x.id === trip.data.id), { id: trip.data.id, name: 'Lake weekend', by: 'grace', mine: false, set: null });
      assert.ok(later.past.findIndex((x) => x.id === trip.data.id) < later.past.findIndex((x) => x.id === id), 'the latest first');

      // Only the starter deletes a plan, with its times and marks.
      assert.equal((await app.call('DELETE', `/api/plans/${id}`, { as: grace })).status, 403);
      assert.equal((await app.call('DELETE', `/api/plans/${id}`, { as: ada })).status, 200);
      assert.equal((await app.call('DELETE', `/api/plans/${id}`, { as: ada })).status, 404);
      assert.equal((await app.call('PUT', `/api/plans/${id}/marks`, { as: ada, body: { marks: [{ slotId: s1, mark: 'free' }] } })).status, 404);
      assert.equal((await app.call('DELETE', `/api/plans/${trip.data.id}`, { as: grace })).status, 200);
      d = await get();
      assert.deepEqual(d.plans.map((x) => x.id), [900001], 'the seed is still there');
    });
  });

  // One app, two ways to answer (SHEET_MODE): each entry seeds and makes
  // events of its own kind. Its events are counted by their names.
  const sheets = (d) => demo(d.upcoming.concat(d.past));

  await t.test('a sign-up sheet: slots with a size, one spot each, a full slot closes, coming up by "now"', async () => {
    await run('signup-shifts', '/api/events', sheets, async (app) => {
      const get = async (as, now) => (await app.call('GET', '/api/events', { as, now })).data;
      // The seed: a sheet coming up with five slots of different sizes, some
      // taken by fake people and one full, and one sheet that is past.
      const seeded = await get(sam);
      assert.equal(seeded.mode, 'slots');
      const park = seeded.upcoming.find((e) => e.id === 900001);
      assert.equal(park.kind, 'slots');
      assert.equal(park.slots.length, 5);
      assert.equal(new Set(park.slots.map((s) => s.size)).size, 5, 'five different sizes');
      assert.ok(park.slots.some((s) => s.taken && !s.full) && park.slots.some((s) => !s.taken), 'some taken, some not');
      assert.deepEqual(park.slots.filter((s) => s.full).map((s) => s.id), [900005], 'one full');
      assert.ok(seeded.past.some((e) => e.id === 900002 && e.over), 'and one past');
      assert.equal((await app.call('PUT', '/api/slots/900005/signup', { as: ada })).status, 409, 'a full slot is closed');

      // Making one: a name and a time that has not passed; a place if known.
      const now = '2026-10-08T12:00:00.000Z';
      const startsAt = '2026-10-10T09:00:00.000Z';
      const post = (body, as = ada) => app.call('POST', '/api/events', { as, body, now });
      assert.equal((await post({ name: '  ', startsAt })).status, 400);
      assert.equal((await post({ name: 'Cleanup', startsAt: 'soon' })).status, 400);
      assert.equal((await post({ name: 'Cleanup', startsAt: '2026-10-01T09:00:00Z' })).status, 400, 'not in the past');
      assert.equal((await post({ name: 'Cleanup', startsAt, kind: 'potluck' })).status, 400);
      const made = await post({ name: '  River   cleanup ', startsAt, place: 'The boat ramp' });
      assert.equal(made.status, 201);
      assert.equal(made.data.kind, 'slots', 'a new event is the app\'s kind');
      const id = made.data.id;

      // Anyone adds a slot: a name and a size from 1 to 50.
      const slot = (body, as = ada, event = id) => app.call('POST', `/api/events/${event}/slots`, { as, body, now });
      assert.equal((await slot({ name: '', size: 2 })).status, 400);
      for (const size of [0, 51, 2.5, 'two']) assert.equal((await slot({ name: 'Bags', size })).status, 400, String(size));
      assert.equal((await slot({ name: 'Bags', size: 2 }, ada, 999999)).status, 404);
      const morning = (await slot({ name: 'Morning shift', size: 2 }, grace)).data.id;
      const van = (await slot({ name: 'Drive the van', size: 1 })).data.id;
      assert.ok(morning && van);

      // One spot per person per slot; the last spot closes it.
      const signUp = (slotId, as) => app.call('PUT', `/api/slots/${slotId}/signup`, { as, now });
      assert.equal((await signUp(morning, ada)).status, 201);
      const again = await signUp(morning, ada);
      assert.deepEqual([again.status, again.data], [200, { on: true }], 'asking again takes no second spot');
      assert.equal((await signUp(morning, grace)).status, 201);
      const full = await signUp(morning, sam);
      assert.equal(full.status, 409);
      assert.match(full.data.error, /full/);
      let sheet = (await get(ada, now)).upcoming.find((e) => e.id === id);
      assert.deepEqual([sheet.name, sheet.place, sheet.startsAt, sheet.by, sheet.mine], ['River cleanup', 'The boat ramp', startsAt, 'ada', true]);
      let m = sheet.slots.find((s) => s.id === morning);
      assert.deepEqual([m.size, m.taken, m.open, m.full, m.mine], [2, 2, 0, true, true]);
      assert.deepEqual(m.people.map((p) => [p.username, p.mine]), [['ada', true], ['grace', false]], 'in the order they signed up');
      assert.deepEqual([sheet.spots, sheet.open, sheet.yours], [3, 1, ['Morning shift']], 'the line at the top');
      sheet = (await get(sam, now)).upcoming.find((e) => e.id === id);
      assert.deepEqual([sheet.mine, sheet.yours, sheet.slots[0].mine], [false, [], false]);

      // Leaving opens the spot again.
      assert.deepEqual((await app.call('DELETE', `/api/slots/${morning}/signup`, { as: ada, now })).data, { on: false });
      assert.equal((await signUp(morning, sam)).status, 201);
      assert.equal((await signUp(999999, ada)).status, 404);
      assert.equal((await app.call('DELETE', '/api/slots/999999/signup', { as: ada, now })).status, 404);
      assert.equal((await app.call('PUT', `/api/events/${id}/answer`, { as: ada, body: { answer: 'going' }, now })).status, 400,
        'a sheet of slots asks no question');
      // Two people tapping the last spot at once: one of them gets it.
      const race = await Promise.all([signUp(van, grace), signUp(van, sam)]);
      assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);

      // Only whoever made the event removes a slot, or the event.
      assert.equal((await app.call('DELETE', `/api/slots/${van}`, { as: grace })).status, 403);
      assert.equal((await app.call('DELETE', `/api/slots/${van}`, { as: ada })).status, 200);
      assert.equal((await app.call('DELETE', `/api/slots/${van}`, { as: ada })).status, 404);

      // Coming up until twelve hours after it starts, then past and closed.
      assert.ok((await get(ada, '2026-10-10T20:00:00.000Z')).upcoming.some((e) => e.id === id), 'still on that evening');
      const later = '2026-10-11T12:00:00.000Z';
      const gone = await get(ada, later);
      assert.ok(!gone.upcoming.some((e) => e.id === id) && gone.past.some((e) => e.id === id && e.over), 'then past');
      assert.equal((await app.call('PUT', `/api/slots/${morning}/signup`, { as: grace, now: later })).status, 409, 'too late to sign up');
      assert.equal((await app.call('POST', `/api/events/${id}/slots`, { as: grace, body: { name: 'Late', size: 1 }, now: later })).status, 409);

      assert.equal((await app.call('DELETE', `/api/events/${id}`, { as: grace })).status, 403, 'only whoever made it deletes it');
      assert.equal((await app.call('DELETE', `/api/events/${id}`, { as: ada })).status, 200);
      assert.equal((await app.call('DELETE', `/api/events/${id}`, { as: ada })).status, 404);
      assert.equal((await app.call('PUT', `/api/slots/${morning}/signup`, { as: grace, now })).status, 404, 'its slots went with it');
    });
  });

  await t.test('who\'s coming: going, maybe or can\'t with a note, and who has not said from the member list', async () => {
    await run('signup-rsvp', '/api/events', sheets, async (app) => {
      const get = async (as, now) => (await app.call('GET', '/api/events', { as, now })).data;
      // The seed: an event coming up that fake people answered every way.
      const seeded = await get(sam);
      assert.equal(seeded.mode, 'rsvp');
      const night = seeded.upcoming.find((e) => e.id === 900001);
      assert.equal(night.kind, 'rsvp');
      assert.deepEqual([night.counts.going, night.counts.maybe, night.counts.cant], [5, 2, 1]);
      assert.ok(night.going.some((p) => p.note), 'with notes');
      // Somebody the platform does not count as a member sees no "hasn't said".
      assert.deepEqual([seeded.members, night.counts.unsaid, night.answer], ['not_member', null, null]);
      assert.equal((await get(ada)).upcoming.find((e) => e.id === 900001).counts.unsaid, 2, 'neither member has answered');

      const now = '2026-10-08T12:00:00.000Z';
      const startsAt = '2026-10-10T19:00:00.000Z';
      const made = await app.call('POST', '/api/events', { as: ada, body: { name: 'Game night', startsAt, place: 'Jo\'s' }, now });
      assert.deepEqual([made.status, made.data.kind], [201, 'rsvp']);
      const id = made.data.id;
      assert.equal((await app.call('POST', `/api/events/${id}/slots`, { as: ada, body: { name: 'Snacks', size: 2 }, now })).status, 400,
        'an event that asks who is coming has no slots');

      const answer = (body, as, event = id) => app.call('PUT', `/api/events/${event}/answer`, { as, body, now });
      assert.equal((await answer({ answer: 'yes' }, ada)).status, 400);
      assert.equal((await answer({ answer: 'going' }, ada, 999999)).status, 404);
      assert.deepEqual((await answer({ answer: 'going', note: ' +1 ' }, ada)).data, { answer: 'going', note: '+1' });
      // Changing the answer keeps the note unless it is sent too.
      assert.deepEqual((await answer({ answer: 'maybe' }, ada)).data, { answer: 'maybe', note: '+1' });
      assert.deepEqual((await answer({ answer: 'going', note: '' }, ada)).data, { answer: 'going', note: null });
      let ev = (await get(ada, now)).upcoming.find((e) => e.id === id);
      assert.deepEqual(ev.answer, { answer: 'going', note: null });
      assert.deepEqual(ev.counts, { going: 1, maybe: 0, cant: 0, unsaid: 1 }, 'grace has not said');
      assert.deepEqual(ev.going.map((p) => [p.username, p.mine]), [['ada', true]]);

      await answer({ answer: 'cant', note: 'Away that weekend' }, grace);
      await answer({ answer: 'going', note: 'Bringing snacks' }, sam);
      ev = (await get(grace, now)).upcoming.find((e) => e.id === id);
      assert.deepEqual(ev.counts, { going: 2, maybe: 0, cant: 1, unsaid: 0 }, 'everyone in the project has said');
      assert.deepEqual(ev.answer, { answer: 'cant', note: 'Away that weekend' });
      assert.deepEqual(ev.going.map((p) => [p.username, p.note, p.mine]), [['ada', null, false], ['sam', 'Bringing snacks', false]]);
      assert.deepEqual(ev.cant.map((p) => [p.username, p.mine]), [['grace', true]]);

      // Answers close once it is past.
      const later = '2026-10-11T12:00:00.000Z';
      assert.equal((await app.call('PUT', `/api/events/${id}/answer`, { as: grace, body: { answer: 'going' }, now: later })).status, 409);
      const gone = await get(ada, later);
      assert.ok(gone.past.some((e) => e.id === id && e.counts.going === 2 && e.counts.unsaid === null));

      assert.equal((await app.call('DELETE', `/api/events/${id}`, { as: sam })).status, 403);
      assert.equal((await app.call('DELETE', `/api/events/${id}`, { as: ada })).status, 200);
      assert.ok(!(await get(ada, now)).upcoming.some((e) => e.id === id));
    });
  });

  await t.test('a group challenge: logged by hand, a leaderboard and a group goal, a fresh start every month', async () => {
    const seededLately = (d) => d.lately.filter((e) => /^Staging demo /.test(e.note || '')).length;
    await run('challenge-miles', '/api/challenge', seededLately, async (app) => {
      // The staging seed: this month's board, goal bar and Lately, from made-up
      // people, readable by somebody who is not a member (the check runner).
      const seeded = (await app.call('GET', '/api/challenge', { as: sam })).data;
      assert.ok(seeded.current && seeded.leaderboard.length >= 4, 'the check\'s leaderboard');
      assert.ok(seeded.leaderboard.every((p) => p.username.startsWith('staging-demo-') && p.total > 0));
      assert.ok(seeded.total > 0 && seeded.progress > 0, 'and the goal bar');
      assert.deepEqual(seeded.goal, { amount: 200, custom: false, setBy: null }, 'the entry\'s default goal');
      assert.ok(seeded.pastMonths.length >= 1, 'last month is kept as a past month');
      assert.deepEqual([seeded.members, seeded.notYet], ['not_member', null], 'no member list for a stranger');

      // March 2025, UTC: far from the seed, which is relative to the real clock.
      const MARCH = '2025-03-20T12:00:00.000Z';
      const get = async (as, now, query = '') => (await app.call('GET', `/api/challenge?tz=UTC${query}`, { as, now })).data;
      const log = (as, body, now = MARCH) => app.call('POST', '/api/entries?tz=UTC', { as, body, now });
      let d = await get(ada, MARCH);
      assert.deepEqual([d.month, d.today, d.daysInMonth, d.dayOfMonth, d.daysLeft], ['2025-03', '2025-03-20', 31, 20, 11]);
      assert.deepEqual([d.total, d.progress, d.leaderboard, d.lately, d.yours, d.pace, d.results], [0, 0, [], [], [], null, null]);
      assert.deepEqual(d.notYet, [{ username: 'ada', me: true }, { username: 'grace', me: false }], 'the platform\'s member list');
      assert.equal(d.maxAmount, 100, 'half the usual goal per entry');

      // An amount: positive, a number, at most the maximum; a day this month, up to today.
      for (const bad of [{}, { amount: '' }, { amount: 'lots' }, { amount: 0 }, { amount: -2 }, { amount: '1e3' }, { amount: 100.5 }]) {
        assert.equal((await log(ada, bad)).status, 400, JSON.stringify(bad));
      }
      assert.match((await log(ada, { amount: 150 })).data.error, /^One entry can be up to 100 miles\./);
      assert.match((await log(ada, { amount: 0 })).data.error, /^Log more than zero miles\.$/);
      for (const day of ['2025-03-21', '2025-02-28', '2025-02-30', 'yesterday']) {
        assert.equal((await log(ada, { amount: 1, day })).status, 400, day);
      }
      assert.equal((await get(ada, MARCH)).leaderboard.length, 0, 'nothing refused was logged');

      const first = await log(ada, { amount: '5.2', note: '  Lunch   walk ' }, '2025-03-20T08:00:00.000Z');
      assert.equal(first.status, 201);
      assert.deepEqual([first.data.entry.amount, first.data.entry.day, first.data.entry.note, first.data.entry.mine], [5.2, '2025-03-20', 'Lunch walk', true]);
      await log(grace, { amount: 3.1, day: '2025-03-18' }, '2025-03-20T09:00:00.000Z');
      await log(ada, { amount: 4, day: '2025-03-01' }, '2025-03-20T10:00:00.000Z');
      assert.equal((await log(sam, { amount: 2.555 }, '2025-03-20T11:00:00.000Z')).data.entry.amount, 2.56, 'two decimals at most');

      d = await get(ada, MARCH);
      assert.deepEqual(d.leaderboard.map((p) => [p.username, p.total, p.days, p.rank, p.me]),
        [['ada', 9.2, 2, 1, true], ['grace', 3.1, 1, 2, false], ['sam', 2.56, 1, 3, false]]);
      assert.deepEqual([d.total, d.progress, d.beaten], [14.86, 7, false]);
      assert.ok(Math.abs(d.pace.projected - (14.86 / 20) * 31) < 1e-9, 'where the group finishes at this rate');
      assert.ok(Math.abs(d.pace.perDay - (200 - 14.86) / 12) < 1e-9, 'and what it takes a day, today included');
      assert.deepEqual(d.lately.map((e) => [e.username, e.amount, e.day, e.mine]),
        [['sam', 2.56, '2025-03-20', false], ['ada', 4, '2025-03-01', true], ['grace', 3.1, '2025-03-18', false], ['ada', 5.2, '2025-03-20', true]],
        'newest logged first');
      assert.deepEqual(d.yours.map((e) => e.amount), [5.2, 4], 'your own, by day');
      assert.deepEqual(d.notYet, [], 'both members are on the board');
      // A tie shares its rank.
      await log(grace, { amount: 6.1 }, MARCH);
      d = await get(grace, MARCH);
      assert.deepEqual(d.leaderboard.map((p) => [p.username, p.total, p.rank, p.me]),
        [['ada', 9.2, 1, false], ['grace', 9.2, 1, true], ['sam', 2.56, 3, false]]);

      // Only whoever logged an entry removes it.
      const oops = (await log(ada, { amount: 50 }, '2025-03-20T12:30:00.000Z')).data.id;
      assert.equal((await app.call('DELETE', `/api/entries/${oops}?tz=UTC`, { as: grace, now: MARCH })).status, 403);
      assert.equal((await app.call('DELETE', `/api/entries/${oops}?tz=UTC`, { as: ada, now: MARCH })).status, 200);
      assert.equal((await app.call('DELETE', `/api/entries/${oops}?tz=UTC`, { as: ada, now: MARCH })).status, 404);
      assert.equal((await app.call('DELETE', '/api/entries/nope', { as: ada })).status, 404);
      assert.equal((await get(ada, MARCH)).total, 20.96);

      // Anyone changes this month's goal, for this month only; null is the usual one again.
      const setGoal = (as, goal, now = MARCH) => app.call('PUT', '/api/goal?tz=UTC', { as, body: { goal }, now });
      for (const bad of ['x', 0, -5, 2e9]) assert.equal((await setGoal(grace, bad)).status, 400, String(bad));
      assert.equal((await setGoal(grace, null)).data.goal.custom, false);
      const changed = await setGoal(grace, '20');
      assert.deepEqual([changed.status, changed.data.month, changed.data.goal], [200, '2025-03', { amount: 20, custom: true, setBy: 'grace' }]);
      d = await get(ada, MARCH);
      assert.deepEqual([d.goal.amount, d.progress, d.beaten], [20, 100, true]);

      // April: a fresh start at zero with the usual goal, and March's results
      // on its first days.
      const APRIL = '2025-04-02T09:00:00.000Z';
      d = await get(ada, APRIL);
      assert.deepEqual([d.month, d.total, d.leaderboard, d.goal.amount, d.goal.custom], ['2025-04', 0, [], 200, false]);
      const r = d.results;
      assert.deepEqual([r.month, r.total, r.goal, r.beaten, r.people], ['2025-03', 20.96, 20, true, 3]);
      assert.deepEqual(r.top.map((p) => [p.username, p.rank]), [['ada', 1], ['grace', 1], ['sam', 3]]);
      assert.deepEqual(r.mostDays, { days: 2, of: 31, people: [{ username: 'ada', me: true }, { username: 'grace', me: false }] });
      assert.deepEqual(d.pastMonths, [{ month: '2025-03', total: 20.96, goal: 20, beaten: true }]);
      assert.equal((await get(ada, '2025-04-08T09:00:00.000Z')).results, null, 'the card is for the first week');
      assert.equal((await get(ada, '2025-04-07T09:00:00.000Z')).results.month, '2025-03');

      // A past month can be looked at, and stays as it was.
      d = await get(ada, APRIL, '&month=2025-03');
      assert.deepEqual([d.current, d.month, d.results.month, d.leaderboard.length, d.lately, d.yours], [false, '2025-03', '2025-03', 3, [], []]);
      assert.equal((await app.call('GET', '/api/challenge?tz=UTC&month=2025-05', { as: ada, now: APRIL })).status, 400, 'not yet');
      assert.equal((await app.call('GET', '/api/challenge?month=March', { as: ada, now: APRIL })).status, 400);
      const march = d.leaderboard.find((p) => p.username === 'ada');
      assert.ok(march);
      const adaMarch = (await get(ada, MARCH)).yours[0].id;
      assert.equal((await app.call('DELETE', `/api/entries/${adaMarch}?tz=UTC`, { as: ada, now: APRIL })).status, 403, 'a month that is over keeps its entries');
      assert.equal((await log(ada, { amount: 1, day: '2025-03-31' }, APRIL)).status, 400);
      await setGoal(ada, 300, APRIL);
      assert.equal((await get(ada, APRIL)).goal.amount, 300);
      assert.equal((await get(ada, APRIL, '&month=2025-03')).goal.amount, 20, 'each month keeps its own goal');

      // "This month" is where the viewer is: 23:30 on March 31 in Los
      // Angeles is already April in UTC. An unknown zone is UTC.
      const lateMarch = '2025-04-01T06:30:00.000Z';
      const la = (await app.call('GET', '/api/challenge?tz=America/Los_Angeles', { as: ada, now: lateMarch })).data;
      assert.deepEqual([la.month, la.today, la.daysLeft], ['2025-03', '2025-03-31', 0]);
      assert.equal((await app.call('GET', '/api/challenge?tz=Not/AZone', { as: ada, now: lateMarch })).data.month, '2025-04');
      const late = await app.call('POST', '/api/entries?tz=America/Los_Angeles', { as: ada, body: { amount: 1 }, now: lateMarch });
      assert.equal(late.data.entry.day, '2025-03-31', 'today, where they are');
    });
  });

  // ── The game starters ──────────────────────────────────────────────────

  // Nobody without a token, nor with another app's, gets a live connection.
  async function refusesStrangers(app) {
    for (const bad of [null, token(101, 'ada', 'usernode:app:999'), 'not-a-token']) {
      await assert.rejects(liveOf(app, bad).opened, (err) => err.status === 401, String(bad && bad.slice(0, 8)));
    }
  }

  await t.test('a board game: the lobby, turns over the live connection, a roll made for somebody away, a winner kept', async () => {
    const roomCount = (d) => d.players.length + d.leaders.length;
    await run('game-board', '/api/room', roomCount, async (app) => {
      await refusesStrangers(app);
      const a = liveOf(app, ada);
      let first = a.next(isView());
      await a.opened;
      let v = (await first).view;
      assert.deepEqual([v.phase, v.players.map((p) => p.username), v.you.joined], ['lobby', ['staging-demo-ana'], false]);
      assert.deepEqual(v.leaders.map((l) => [l.username, l.wins]), [['staging-demo-ana', 1], ['staging-demo-user', 1]]);
      let p = a.next(isView((x) => x.players.length === 2));
      a.send({ t: 'join' });
      await p;
      // A plain request is the same room, and the socket hears it.
      p = a.next(isView((x) => x.players.length === 3));
      assert.equal((await app.call('POST', '/api/room/join', { as: grace })).status, 200);
      v = (await p).view;
      assert.deepEqual(v.players.map((x) => [x.username, x.here]), [['staging-demo-ana', false], ['ada', true], ['grace', true]]);
      p = a.next(isView((x) => x.phase === 'playing'));
      a.send({ t: 'start' });
      v = (await p).view;
      assert.equal(v.game.order[v.game.turn], 900001, 'the first seat starts');
      p = a.next((m) => m.t === 'error');
      a.send({ t: 'act', action: { type: 'roll' } });
      assert.equal((await p).error, 'It is not your turn yet.');
      v = (await a.next(isView((x) => x.game && x.game.rollNo >= 1))).view;
      assert.match(v.game.log[0].text, /^@staging-demo-ana rolled \d \(rolled for them\)/, 'away: rolled for her');
      assert.equal((await app.call('POST', '/api/room/act', { as: sam, body: { action: { type: 'roll' } } })).status, 409, 'watching, not playing');
      a.close();
    });
    // A game to its winner, on a fresh production room, kept across a restart.
    const dir = writeRepo('game-board');
    dirs.push(dir);
    const db = await database();
    let prod = await boot(dir, db, 'production', env);
    const a = liveOf(prod, ada);
    await a.opened;
    let p = a.next(isView((x) => x.players.length === 1));
    a.send({ t: 'join' });
    await p;
    p = a.next(isView((x) => x.phase === 'playing'));
    a.send({ t: 'start' });
    await p;
    let over = null;
    for (let i = 0; i < 80 && !over; i += 1) {
      p = a.next(isView((x) => x.game && x.game.rollNo === i + 1));
      a.send({ t: 'act', action: { type: 'roll' } });
      const after = (await p).view;
      if (after.phase === 'over') over = after;
      else if (after.game.winner != null) over = (await a.next(isView((x) => x.phase === 'over'))).view;
    }
    assert.ok(over, 'somebody reaches the finish');
    assert.deepEqual(over.results.map((r) => [r.username, r.place, r.score]), [['ada', 1, 30]]);
    const leaders = (await a.next(isView((x) => x.leaders.length === 1))).view.leaders;
    assert.deepEqual(leaders.map((l) => [l.username, l.wins, l.played]), [['ada', 1, 1]]);
    a.close();
    await new Promise((r) => setTimeout(r, 600)); // the room saves a moment after a change
    assert.equal(await prod.stop(), 0, prod.output());
    prod = await boot(dir, db, 'production', env);
    const back = (await prod.call('GET', '/api/room', { as: ada })).data;
    assert.deepEqual([back.phase, back.players.map((x) => x.username), back.leaders.length], ['over', ['ada'], 1], 'saved across a restart');
    assert.equal((await prod.call('POST', '/api/room/again', { as: ada })).data.phase, 'lobby');
    assert.equal(await prod.stop(), 0);
  });

  await t.test('trivia: questions about each other, the answer hidden until it shows, scored live', async () => {
    const roomCount = (d) => d.players.length + d.leaders.length;
    await run('game-trivia', '/api/room', roomCount, async (app) => {
      await refusesStrangers(app);
      // The bank: your own questions in full, everyone else's only counted.
      assert.equal((await app.call('POST', '/api/questions', { as: grace, body: { text: 'My first job?', answer: 'Baker', wrong: [] } })).status, 400);
      assert.equal((await app.call('POST', '/api/questions', { as: grace, body: { text: 'My first job?', answer: 'Baker', wrong: ['baker'] } })).status, 400, 'every answer different');
      const q = await app.call('POST', '/api/questions', { as: grace, body: { text: 'My first job?', answer: 'Baker', wrong: ['Lifeguard', 'Paper round'] } });
      assert.equal(q.status, 201);
      const graceBank = (await app.call('GET', '/api/questions', { as: grace })).data;
      assert.deepEqual(graceBank.mine.map((x) => [x.text, x.answer, x.wrong]), [['My first job?', 'Baker', ['Lifeguard', 'Paper round']]]);
      const adaBank = (await app.call('GET', '/api/questions', { as: ada })).data;
      assert.deepEqual(adaBank.mine, []);
      assert.ok(!JSON.stringify(adaBank).includes('Baker'), 'nobody else sees the answer');
      assert.equal((await app.call('GET', '/api/questions')).status, 401);
      // A game: everyone here answers, then the answer shows with the points.
      const a = liveOf(app, ada);
      const g = liveOf(app, grace);
      await Promise.all([a.opened, g.opened]);
      let p = a.next(isView((x) => x.players.length === 3));
      a.send({ t: 'join' });
      g.send({ t: 'join' });
      await p;
      p = a.next(isView((x) => x.phase === 'playing'));
      a.send({ t: 'start' });
      let v = (await p).view;
      assert.equal(v.game.of, 6, 'every question in the bank, up to eight');
      assert.equal(v.game.question.correct, null, 'not before it shows');
      const author = v.game.question.authorId;
      const answers = [[a, 101], [g, 102]].filter(([, id]) => id !== author);
      if (answers.length < 2) {
        p = g.next((m) => m.t === 'error');
        g.send({ t: 'act', action: { type: 'answer', choice: 0 } });
        assert.match((await p).error, /about you/);
      }
      p = a.next(isView((x) => x.game && x.game.stage === 'reveal'));
      for (const [s] of answers) s.send({ t: 'act', action: { type: 'answer', choice: 0 } });
      v = (await p).view;
      assert.equal(typeof v.game.question.correct, 'number', 'it shows once everyone here answered');
      assert.equal(Object.keys(v.game.picks).length, answers.length);
      const right = Object.entries(v.game.picks).filter(([, c]) => c === v.game.question.correct).map(([id]) => Number(id));
      for (const id of right) assert.ok(v.game.points[id] >= 100, 'a right answer scores');
      a.close();
      g.close();
      assert.equal((await app.call('DELETE', `/api/questions/${q.data.id}`, { as: ada })).status, 404, 'only its author');
      assert.equal((await app.call('DELETE', `/api/questions/${q.data.id}`, { as: grace })).status, 200);
    });
  });

  await t.test('the space game: a run ticks live, ships fly by their own page, and the run is kept when it ends', async () => {
    await run('game-space', '/api/room', (d) => d.leaders.length, async (app) => {
      await refusesStrangers(app);
      const a = liveOf(app, ada);
      await a.opened;
      let p = a.next(isView((x) => x.players.length === 1));
      a.send({ t: 'join' });
      await p;
      p = a.next(isView((x) => x.phase === 'playing'));
      a.send({ t: 'start' });
      const v = (await p).view;
      const ship = v.game.ships.find((s) => s[0] === 101);
      // Frames arrive about twenty times a second.
      let frames = 0;
      const started = Date.now();
      while (Date.now() - started < 1000) {
        // eslint-disable-next-line no-await-in-loop
        await a.next((m) => m.t === 'frame');
        frames += 1;
      }
      assert.ok(frames >= 12, `${frames} frames in a second`);
      // A storm is the numbers every page works its sparks out from.
      const stormy = await a.next((m) => m.t === 'frame' && m.frame.storms.length);
      assert.ok(['interval', 'n', 'v', 'a0'].every((k) => k in stormy.frame.storms[0]));
      a.send({ t: 'input', input: { x: ship[1] + 15, y: ship[2] - 5 } });
      const moved = await a.next((m) => m.t === 'frame' && m.frame.ships.some((s) => s[0] === 101 && s[1] === ship[1] + 15 && s[2] === ship[2] - 5));
      assert.ok(moved, 'the server takes the page\'s word for where its ship is');
      a.send({ t: 'input', input: { x: ship[1] + 315, y: ship[2] - 5 } });
      const later = await a.next((m) => m.t === 'frame');
      assert.equal(later.frame.ships.find((s) => s[0] === 101)[1], ship[1] + 15, 'but not a jump');
      // Its page saw a spark touch it: a shield goes, and everyone hears.
      await a.next((m) => m.t === 'frame' && m.frame.now > m.frame.ships.find((s) => s[0] === 101)[5]);
      const p2 = a.next((m) => m.t === 'event');
      a.send({ t: 'act', action: { type: 'hit' } });
      assert.deepEqual((await p2).event, { type: 'hit', id: 101, shields: 2 });
      // Grace drops in mid-run; then both leave and the run is over and kept.
      assert.equal((await app.call('POST', '/api/room/join', { as: grace })).status, 200);
      const both = await a.next((m) => m.t === 'frame' && m.frame.ships.length === 2);
      assert.ok(both);
      p = a.next(isView((x) => x.phase === 'over'));
      await app.call('POST', '/api/room/leave', { as: grace });
      a.send({ t: 'leave' });
      const over = (await p).view;
      assert.deepEqual(over.results.map((r) => r.username).sort(), ['ada', 'grace'], 'everyone who flew');
      const kept = await a.next(isView((x) => x.leaders.some((l) => l.username === 'ada')));
      assert.ok(kept);
      a.close();
    });
  });

  await t.test('the block world: always on, every block sent to everyone as it is placed, and checked', async () => {
    await run('game-blocks', '/api/room', (d) => (d.game ? d.game.count : 0), async (app) => {
      await refusesStrangers(app);
      const a = liveOf(app, ada);
      const g = liveOf(app, grace);
      const first = a.next(isView());
      await Promise.all([a.opened, g.opened]);
      const v = (await first).view;
      assert.equal(v.phase, 'playing', 'no lobby');
      assert.ok(v.game.blocks.length > 50, 'the staging demo world');
      const empty = [5, 0, 25];
      assert.ok(!v.game.blocks.some((b) => b[0] === empty[0] && b[1] === empty[1] && b[2] === empty[2]));
      let p = g.next((m) => m.t === 'event');
      a.send({ t: 'act', action: { type: 'place', x: empty[0], y: empty[1], z: empty[2], c: 4 } });
      assert.deepEqual((await p).event, { type: 'place', x: 5, y: 0, z: 25, c: 4, by: 'ada' }, 'grace sees it at once');
      p = g.next((m) => m.t === 'error');
      g.send({ t: 'act', action: { type: 'place', x: 5, y: 0, z: 25, c: 1 } });
      assert.match((await p).error, /already/);
      g.send({ t: 'act', action: { type: 'place', x: 99, y: 0, z: 0, c: 1 } });
      assert.match((await g.next((m) => m.t === 'error')).error, /outside/);
      // Where ada is flying shows on grace's screen.
      a.send({ t: 'input', input: { x: 6.5, y: 3, z: 25, yaw: 1.25, c: 2 } });
      const there = await g.next((m) => m.t === 'frame' && m.frame.builders.length);
      assert.deepEqual(there.frame.builders[0], [101, 'ada', 6.5, 3, 25, 1.25, 2]);
      const room = (await app.call('GET', '/api/room', { as: grace })).data;
      assert.ok(room.game.blocks.some((b) => b.join() === '5,0,25,4'), 'a plain request sees the same world');
      assert.equal((await app.call('POST', '/api/room/act', { as: grace, body: { action: { type: 'remove', x: 5, y: 0, z: 25 } } })).status, 200);
      assert.equal((await app.call('POST', '/api/room/act', { body: { action: { type: 'remove', x: 6, y: 0, z: 25 } } })).status, 401, 'no account, no building');
      a.close();
      g.close();
    });
  });
});
