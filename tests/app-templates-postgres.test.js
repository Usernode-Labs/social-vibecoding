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
// The app's dependencies (express, pg, jsonwebtoken) resolve from this
// repository's node_modules through NODE_PATH. Skipped when no server is
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
    assert.match(await page.text(), /<script src="\/app\.js"><\/script>/);
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
      assert.deepEqual(seeded.items.find((i) => i.id === 900001).tier, 'S', 'the check\'s S row has an item');
      assert.equal(seeded.items.find((i) => i.id === 900005).tier, null, 'one nobody has ranked yet');

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

  await t.test('a grocery list: aisles, ticked in place, aisles in the store\'s order, and who did what', async () => {
    const all = (d) => d.aisles.flatMap((a) => a.items).concat(d.other);
    await run('grocery-list', '/api/list', (d) => demo(all(d)), async (app) => {
      let list = (await app.call('GET', '/api/list', { as: ada })).data;
      assert.deepEqual(list.aisles.map((a) => a.name),
        ['Produce', 'Bakery', 'Dairy & eggs', 'Meat & fish', 'Pantry', 'Frozen', 'Drinks', 'Household'], 'a new list has the usual aisles');
      const dairy = list.aisles.find((a) => a.name === 'Dairy & eggs').id;
      const milk = await app.call('POST', '/api/items', { as: ada, body: { name: 'Oat milk', note: ' 2 cartons ', aisleId: dairy } });
      assert.equal(milk.status, 201);
      const twice = await app.call('POST', '/api/items', { as: grace, body: { name: 'oat MILK' } });
      assert.deepEqual(twice.data, { id: milk.data.id, already: true }, 'still needed, so it is not added twice');
      assert.equal((await app.call('POST', '/api/items', { as: ada, body: { name: '' } })).status, 400);
      const loose = await app.call('POST', '/api/items', { as: ada, body: { name: 'Candles', aisleId: 999999 } });
      assert.equal(loose.status, 201, 'an aisle that is not one puts it under Other');

      assert.deepEqual((await app.call('PATCH', `/api/items/${milk.data.id}`, { as: grace, body: { bought: true } })).data, { ok: true });
      list = (await app.call('GET', '/api/list', { as: ada })).data;
      const row = list.aisles.find((a) => a.id === dairy).items.find((i) => i.id === milk.data.id);
      assert.deepEqual([row.name, row.note, row.by, row.mine, row.bought, row.boughtBy], ['Oat milk', '2 cartons', 'ada', true, true, 'grace'],
        'ticked, it stays in its aisle');
      assert.ok(list.other.some((i) => i.id === loose.data.id));
      assert.deepEqual(list.activity.slice(0, 2).map((e) => [e.by, e.verb, e.text]), [['grace', 'bought', 'Oat milk'], ['ada', 'added', 'Candles']], 'newest first');
      assert.equal(list.activity[0].mine, false);

      // Edit: name, note and aisle.
      const pantry = list.aisles.find((a) => a.name === 'Pantry').id;
      await app.call('PATCH', `/api/items/${loose.data.id}`, { as: grace, body: { name: 'Tea lights', note: 'unscented', aisleId: pantry } });
      list = (await app.call('GET', '/api/list', { as: ada })).data;
      assert.deepEqual(list.aisles.find((a) => a.id === pantry).items.map((i) => [i.name, i.note]), [['Tea lights', 'unscented']]);
      assert.equal((await app.call('PATCH', `/api/items/${loose.data.id}`, { as: grace, body: { name: '  ' } })).status, 400);

      // Aisles: add, rename, reorder, remove (its items go to Other).
      const baby = await app.call('POST', '/api/aisles', { as: ada, body: { name: 'Baby' } });
      assert.equal(baby.status, 201);
      await app.call('PATCH', `/api/aisles/${baby.data.id}`, { as: ada, body: { name: 'Baby things' } });
      const ids = list.aisles.map((a) => a.id).concat(baby.data.id).reverse();
      assert.equal((await app.call('POST', '/api/aisles/order', { as: ada, body: { ids } })).status, 200);
      list = (await app.call('GET', '/api/list', { as: ada })).data;
      assert.deepEqual(list.aisles.map((a) => a.id), ids, 'the store\'s order');
      assert.equal(list.aisles[0].name, 'Baby things');
      assert.equal((await app.call('POST', '/api/aisles/order', { as: ada, body: { ids: ['x'] } })).status, 400);
      await app.call('DELETE', `/api/aisles/${pantry}`, { as: ada });
      list = (await app.call('GET', '/api/list', { as: ada })).data;
      assert.ok(list.other.some((i) => i.id === loose.data.id), 'a removed aisle\'s items go to Other');

      const cleared = await app.call('POST', '/api/items/clear-bought', { as: grace });
      assert.ok(cleared.data.cleared >= 2, 'the seeded bought bananas and the milk');
      list = (await app.call('GET', '/api/list', { as: ada })).data;
      assert.ok(!all(list).some((i) => i.bought));
      assert.equal(list.activity[0].verb, 'cleared');
      assert.equal((await app.call('DELETE', `/api/items/${loose.data.id}`, { as: grace })).status, 200, 'it is everyone\'s list');
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
});
