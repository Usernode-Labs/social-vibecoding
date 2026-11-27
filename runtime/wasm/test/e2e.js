'use strict';
// The end-to-end check, driven by e2e.sh once its containers are up:
//   1. build the grocery-list and sign-up-sheet projects through runner A;
//   2. run each one's setup through runner B (which fetches the module by hash);
//   3. walk through each app on its Node twin and its Wasm twin and compare
//      every answer (status, content type, body with times normalised);
//   4. kill runner A right after a write commits, retry with the same
//      operation ID on runner B: one row, the stored answer;
//   5. race 20 people for the last place on a sign-up sheet: exactly one wins;
//   6. a small project of its own for what the starters do not exercise:
//      overlapping outside calls, timers, crypto, the time limit, the
//      private-address guard; and the grocery list's event stream;
//   7. with WW_TGZ: World Weather, built, set up and walked through the
//      same way, its outside services answered by stand-ins;
//   8. with BENCH=1: time and CPU per request at a fixed rate, Node against
//      the runner (the grocery list's read, World Weather's routes);
//   9. with WARM_A > 0 (warm instances): an app's globals last between its
//      requests and never reach another app or database, an instance is
//      recycled and let go after an error, a busy one is not waited for.
// Prints a JSON summary and exits non-zero on any failure.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { mintPass, mintToken } = require('./lib.js');

const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
const KEYS = env('KEYS');
const MODULES = env('MODULES');
const RUNNER_A = env('RUNNER_A');
const RUNNER_B = env('RUNNER_B');
const PG_CONTAINER = env('PG_CONTAINER');
const runnerToken = fs.readFileSync(path.join(KEYS, 'runner.token'), 'utf8').trim();

const APPS = {
  grocery: { app: 201, ses: 301, db: 'app_grocery_staging_s301_a1b2c3_w', name: 'Grocery Test', slug: 'grocery-test', node: env('NODE_GROCERY'), tgz: env('GROCERY_TGZ') },
  signup: { app: 202, ses: 302, db: 'app_signup_staging_s302_d4e5f6_w', name: 'Signup Test', slug: 'signup-test', node: env('NODE_SIGNUP'), tgz: env('SIGNUP_TGZ') },
};
if (process.env.WW_TGZ) {
  // World Weather goes to runner A: its outside services are private addresses here.
  APPS.ww = { app: 203, ses: 303, db: 'app_ww_staging_s303_c0ffee_w', name: 'World Weather', slug: 'world-weather', node: env('NODE_WW'), tgz: env('WW_TGZ'), runner: RUNNER_A };
}
const PEOPLE = { alice: 7, bob: 8, carol: 9 };

const failures = [];
const summary = { builds: {}, setups: {}, walkthroughs: {}, kill: {}, race: {} };
const known = []; // differences from Node that are known and reported, not failures
function check(ok, what, detail) {
  if (!ok) { failures.push(detail === undefined ? what : `${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); console.error('FAIL ' + what); }
  return ok;
}

/** One HTTP request on a fresh connection: { status, headers, body }. */
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function sql(db, query) {
  return execFileSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-tAc', query], { encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------- 1 and 2: build, setup

async function build(name) {
  const a = APPS[name];
  const t0 = Date.now();
  const res = await request(`${RUNNER_A}/_wasm/build`, { method: 'POST', headers: { authorization: `Bearer ${runnerToken}` }, body: fs.readFileSync(a.tgz) });
  const wall = Date.now() - t0;
  const body = res.body;
  if (!check(res.status === 200, `build ${name}`, body.toString().slice(0, 500))) throw new Error('build failed');
  const sha = res.headers['x-module-sha256'];
  check(crypto.createHash('sha256').update(body).digest('hex') === sha, `build ${name}: x-module-sha256 names the bytes`);
  fs.writeFileSync(path.join(MODULES, sha), body);
  a.mod = sha;
  summary.builds[name] = { ms: Number(res.headers['x-build-ms']), wall_ms: wall, module_bytes: body.length, bundle_bytes: Number(res.headers['x-bundle-bytes']), files_bytes: Number(res.headers['x-files-bytes']), source_bytes: fs.statSync(a.tgz).size };
}

async function refusedBuild() {
  // A project whose server needs a package nothing covers: 422 with the reason.
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wasm-e2e-'));
  fs.writeFileSync(path.join(dir, 'server.js'), "const express = require('express');\nconst sharp = require('sharp');\nexpress().listen(3000);\n");
  const tgz = path.join(dir, 'p.tgz');
  execFileSync('tar', ['-C', dir, '-czf', tgz, 'server.js']);
  const res = await request(`${RUNNER_A}/_wasm/build`, { method: 'POST', headers: { authorization: `Bearer ${runnerToken}` }, body: fs.readFileSync(tgz) });
  const text = res.body.toString();
  check(res.status === 422 && text.includes('sharp'), 'build refuses an uncovered package with 422', `${res.status} ${text}`);
  summary.builds.refused = { status: res.status, reason: JSON.parse(text).error };
  const unauth = await request(`${RUNNER_A}/_wasm/build`, { method: 'POST', body: fs.readFileSync(tgz) });
  check(unauth.status === 401, 'build without the runner token is refused', unauth.status);
}

function envFor(a) { return { USERNODE_APP_NAME: a.name, USERNODE_APP_SLUG: a.slug }; }

async function setup(name) {
  const a = APPS[name];
  const pass = mintPass(KEYS, { app: a.app, ses: a.ses, mod: a.mod, db: a.db, scope: 'setup', env: envFor(a) });
  const t0 = Date.now();
  const res = await request(`${RUNNER_B}/_wasm/setup`, { method: 'POST', headers: { authorization: `Bearer ${runnerToken}`, 'x-usernode-pass': pass } });
  const out = JSON.parse(res.body.toString());
  check(res.status === 200 && out.ok === true, `setup ${name}`, out);
  summary.setups[name] = { ms: out.ms, wall_ms: Date.now() - t0, statements: out.statements };
  // A request pass is refused for setup, and a setup pass for requests.
  const wrong = await request(`${RUNNER_B}/_wasm/setup`, { method: 'POST', headers: { authorization: `Bearer ${runnerToken}`, 'x-usernode-pass': mintPass(KEYS, { app: a.app, ses: a.ses, mod: a.mod, db: a.db }) } });
  check(wrong.status === 502, `setup ${name}: a request pass is refused`, wrong.status);
}

// ---------------------------------------------------------------- 3: walkthroughs

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
function norm(v) {
  if (typeof v === 'string') return ISO.test(v) ? '<time>' : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = norm(v[k]); return o; }
  return v;
}

let flip = 0;
/** One request of a walkthrough step to a twin; `vars` fills a body given as a function. */
async function call(twin, a, step, vars) {
  const headers = {};
  const uid = step.user ? (PEOPLE[step.user] || step.userId) : null;
  if (step.user) headers['x-usernode-token'] = mintToken(KEYS, a.app, uid, step.user);
  let p = step.path;
  if (step.queryToken) p += (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(mintToken(KEYS, a.app, PEOPLE[step.queryToken], step.queryToken));
  let body;
  if (step.rawBody !== undefined) { headers['content-type'] = 'application/json'; body = step.rawBody; }
  else if (step.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(typeof step.body === 'function' ? step.body(vars || {}) : step.body); }
  let base = a.node;
  if (twin === 'wasm') {
    base = a.runner || (flip++ % 2 ? RUNNER_A : RUNNER_B);
    headers['x-usernode-pass'] = mintPass(KEYS, { app: a.app, ses: a.ses, mod: a.mod, db: a.db, user: uid || (step.queryToken ? PEOPLE[step.queryToken] : null), env: envFor(a) });
    // The gate gives every request that is not a read an operation ID.
    if (step.method && step.method !== 'GET') headers['x-usernode-op'] = crypto.randomUUID();
  }
  const t0 = process.hrtime.bigint();
  const res = await request(base + p, { method: step.method || 'GET', headers, body });
  const buf = res.body;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const type = (res.headers['content-type'] || '').toLowerCase().replace(/\s+/g, '');
  let json = null;
  if (type.startsWith('application/json')) { try { json = JSON.parse(buf.toString()); } catch (_) { /* compared as text */ } }
  const binary = !/^(text\/|application\/(json|javascript|xml))|svg/.test(type);
  let text = json ? null : binary ? 'base64:' + buf.toString('base64') : buf.toString();
  // Express's error page carries the stack: compare its first line.
  if (text && text.includes('<title>Error</title>')) text = text.split('<br>')[0];
  return { status: res.status, type, json, text, ms };
}

async function walk(name, steps) {
  const a = APPS[name];
  const vars = {};
  const out = { steps: steps.length, equal: 0, different: [], ms: { node: [], wasm: [] } };
  for (const s of steps) {
    const step = Object.assign({}, s, { path: s.path.replace(/\{(\w+)\}/g, (_, k) => vars[k]) });
    const n = await call('node', a, step, vars);
    const w = await call('wasm', a, step, vars);
    out.ms.node.push(n.ms); out.ms.wasm.push(w.ms);
    // `loose`: an engine's own error wording (V8's and QuickJS's JSON.parse messages differ).
    const sameBody = s.loose ? true : n.json ? JSON.stringify(norm(n.json)) === JSON.stringify(norm(w.json)) : n.text === w.text;
    const same = n.status === w.status && n.type === w.type && sameBody;
    const order = !same && s.order && n.status === w.status && n.json && w.json ? orderOnly(s.order(n.json), s.order(w.json)) : null;
    if (same) out.equal++;
    else if (order) { out.known = (out.known || 0) + 1; known.push(Object.assign({ app: name, step: s.name, kind: 'same entries, another order (localeCompare without Intl)' }, order)); }
    else out.different.push({ step: s.name, node: { status: n.status, type: n.type, body: (n.json ? JSON.stringify(n.json) : n.text).slice(0, 400) }, wasm: { status: w.status, type: w.type, body: (w.json ? JSON.stringify(w.json) : w.text || '').slice(0, 400) } });
    if (s.expect !== undefined) check(n.status === s.expect, `${name}: ${s.name} answers ${s.expect} on Node`, n.status);
    if (s.save) Object.assign(vars, s.save(n.json));
  }
  const med = (xs) => { const v = xs.slice().sort((p, q) => p - q); return Math.round(v[Math.floor(v.length / 2)] * 10) / 10; };
  summary.walkthroughs[name] = { steps: out.steps, equal: out.equal, known_differences: out.known || 0, different: out.different, median_ms: { node: med(out.ms.node), wasm: med(out.ms.wasm) } };
  check(out.different.length === 0, `${name}: every answer is the same on both twins`, out.different);
}

/** Two lists with the same entries in another order: what moved, or null. */
function orderOnly(nodeList, wasmList) {
  const key = (x) => JSON.stringify(norm(x));
  if (!Array.isArray(nodeList) || !Array.isArray(wasmList) || nodeList.length !== wasmList.length) return null;
  if (nodeList.map(key).sort().join('\n') !== wasmList.map(key).sort().join('\n')) return null;
  const name = (x) => (x && x.name) || key(x);
  const moved = nodeList.map((x, i) => ({ name: name(x), node: i, wasm: wasmList.findIndex((y) => key(y) === key(x)) })).filter((m) => m.node !== m.wasm);
  return { moved: moved.length, examples: moved.slice(0, 6) };
}

const FUTURE = '2027-06-01T10:00:00.000Z';
const groceryWalk = [
  { name: 'the page', path: '/', user: 'alice', expect: 200 },
  { name: 'a static script', path: '/app.js', user: 'alice', expect: 200 },
  { name: 'the stylesheet', path: '/tailwind.css', expect: 200 },
  { name: 'health', path: '/health', expect: 200 },
  { name: 'the list, first look (examples offered)', path: '/api/list', user: 'alice', expect: 200 },
  { name: 'add an item', method: 'POST', path: '/api/items', user: 'alice', body: { text: 'Apples' }, expect: 200, save: (j) => ({ apples: j.item.id }) },
  { name: 'add with a client op id', method: 'POST', path: '/api/items', user: 'alice', body: { text: 'Oat milk', client_op_id: 'op-oat-1' }, expect: 200 },
  { name: 'add again with the same client op id', method: 'POST', path: '/api/items', user: 'alice', body: { text: 'Oat milk', client_op_id: 'op-oat-1' }, expect: 200 },
  { name: 'add an empty item', method: 'POST', path: '/api/items', user: 'alice', body: { text: '  ' }, expect: 400 },
  { name: 'add a category', method: 'POST', path: '/api/categories', user: 'bob', body: { name: 'Fruit' }, expect: 200, save: (j) => ({ fruit: j.category.id }) },
  { name: 'add into the category', method: 'POST', path: '/api/categories/{fruit}/items', user: 'bob', body: { text: 'Pears' }, expect: 200, save: (j) => ({ pears: j.item.id }) },
  { name: 'tick an item', method: 'PATCH', path: '/api/items/{apples}', user: 'bob', body: { checked: true }, expect: 200 },
  { name: 'move an item', method: 'PATCH', path: '/api/items/{apples}', user: 'bob', body: (v) => ({ category_id: v.fruit }), expect: 200 },
  { name: 'switch due dates on', method: 'PATCH', path: '/api/list', user: 'alice', body: { due_dates_enabled: true }, expect: 200 },
  { name: 'set a due date', method: 'PATCH', path: '/api/items/{pears}', user: 'alice', body: { due_date: '2027-01-02', due_time: '09:30' }, expect: 200 },
  { name: 'delete an item', method: 'DELETE', path: '/api/items/{pears}', user: 'alice', expect: 200 },
  { name: 'delete it again', method: 'DELETE', path: '/api/items/{pears}', user: 'alice', expect: 404 },
  { name: 'the list as someone else', path: '/api/list', user: 'bob', expect: 200 },
  { name: 'the list signed out', path: '/api/list', expect: 401 },
  { name: 'a write signed out', method: 'POST', path: '/api/items', body: { text: 'x' }, expect: 401 },
  { name: 'a deep link', path: '/some/screen?x=1', user: 'alice', expect: 200 },
  { name: 'a deep link signed out', path: '/some/screen', expect: 401 },
  { name: 'favicon', path: '/favicon.ico', expect: 204 },
  { name: 'an unknown API path', path: '/api/nope', user: 'alice', expect: 200 },
  { name: 'bad JSON (error page; wording is the engine\'s)', method: 'POST', path: '/api/items', user: 'alice', rawBody: '{', expect: 400, loose: true },
  { name: 'the page as an iframe loads it (?token=)', path: '/?view=1', queryToken: 'alice', expect: 200 },
];
const signupWalk = [
  { name: 'the page', path: '/', user: 'alice', expect: 200 },
  { name: 'the events, none yet', path: '/api/events', user: 'alice', expect: 200 },
  { name: 'make an event', method: 'POST', path: '/api/events', user: 'alice', body: { name: 'Park cleanup', startsAt: FUTURE, place: 'The park' }, expect: 201, save: (j) => ({ ev: j.id }) },
  { name: 'an event in the past', method: 'POST', path: '/api/events', user: 'alice', body: { name: 'Old', startsAt: '2020-01-01T10:00:00.000Z' }, expect: 400 },
  { name: 'add a slot of two', method: 'POST', path: '/api/events/{ev}/slots', user: 'alice', body: { name: 'Morning shift', size: 2 }, expect: 201, save: (j) => ({ slot: j.id }) },
  { name: 'a slot too big', method: 'POST', path: '/api/events/{ev}/slots', user: 'alice', body: { name: 'Huge', size: 500 }, expect: 400 },
  { name: 'alice signs up', method: 'PUT', path: '/api/slots/{slot}/signup', user: 'alice', expect: 201 },
  { name: 'alice signs up again', method: 'PUT', path: '/api/slots/{slot}/signup', user: 'alice', expect: 200 },
  { name: 'bob signs up (the slot is full)', method: 'PUT', path: '/api/slots/{slot}/signup', user: 'bob', expect: 201 },
  { name: 'carol finds it full', method: 'PUT', path: '/api/slots/{slot}/signup', user: 'carol', expect: 409 },
  { name: 'alice cancels', method: 'DELETE', path: '/api/slots/{slot}/signup', user: 'alice', expect: 200 },
  { name: 'carol takes the place', method: 'PUT', path: '/api/slots/{slot}/signup', user: 'carol', expect: 201 },
  { name: 'the sheet as bob', path: '/api/events', user: 'bob', expect: 200 },
  { name: 'bob cannot delete alice\'s event', method: 'DELETE', path: '/api/events/{ev}', user: 'bob', expect: 403 },
  { name: 'a slot that is not there', method: 'PUT', path: '/api/slots/999999/signup', user: 'bob', expect: 404 },
  { name: 'the sheet signed out', path: '/api/events', expect: 401 },
];

// ---------------------------------------------------------------- 4: kill after commit

async function wasmFetch(base, a, method, p, user, body, extra) {
  const headers = Object.assign({ 'x-usernode-pass': mintPass(KEYS, { app: a.app, ses: a.ses, mod: a.mod, db: a.db, user: PEOPLE[user], env: envFor(a) }), 'x-usernode-token': mintToken(KEYS, a.app, PEOPLE[user], user) }, extra || {});
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await request(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: res.body.toString() };
}

async function waitHealthy(base) {
  for (let i = 0; i < 100; i++) {
    try { const r = await request(base + '/health'); if (r.status === 200) return true; } catch (_) { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function killTest() {
  const a = APPS.grocery;
  // A write outside a transaction: kill A after it commits, retry on B.
  const op = 'kill-' + crypto.randomUUID();
  const text = 'Kill test ' + op.slice(5, 13);
  let first;
  try { first = await wasmFetch(RUNNER_A, a, 'POST', '/api/items', 'alice', { text }, { 'x-usernode-op': op, 'x-usernode-test': 'kill-after-commit' }); } catch (e) { first = { error: e.code || e.message }; }
  check(first.error !== undefined, 'kill: runner A dies before answering', first);
  const retry = await wasmFetch(RUNNER_B, a, 'POST', '/api/items', 'alice', { text }, { 'x-usernode-op': op });
  const again = await wasmFetch(RUNNER_B, a, 'POST', '/api/items', 'alice', { text }, { 'x-usernode-op': op });
  const rows = Number(sql(a.db, `SELECT count(*) FROM grocery_items WHERE text = '${text}'`));
  const stored = Number(sql(a.db, `SELECT count(*) FROM _ops WHERE op = '${op}'`));
  check(retry.status === 200 && JSON.parse(retry.text).item.text === text, 'kill: the retry answers the write', retry);
  check(rows === 1, 'kill: exactly one row', rows);
  check(again.text === retry.text, 'kill: asking again gives the stored answer', { retry: retry.text, again: again.text });
  check(stored > 0, 'kill: the statements are stored by operation ID', stored);
  const itemId = JSON.parse(retry.text).item.id;
  check(await waitHealthy(RUNNER_A), 'kill: runner A is back');

  // A transaction (delete = DELETE + INSERT event + COMMIT): kill after the COMMIT.
  const op2 = 'kill-' + crypto.randomUUID();
  let first2;
  try { first2 = await wasmFetch(RUNNER_A, a, 'DELETE', `/api/items/${itemId}`, 'alice', undefined, { 'x-usernode-op': op2, 'x-usernode-test': 'kill-after-commit' }); } catch (e) { first2 = { error: e.code || e.message }; }
  check(first2.error !== undefined, 'kill (transaction): runner A dies before answering', first2);
  const retry2 = await wasmFetch(RUNNER_B, a, 'DELETE', `/api/items/${itemId}`, 'alice', undefined, { 'x-usernode-op': op2 });
  const left = Number(sql(a.db, `SELECT count(*) FROM grocery_items WHERE id = ${itemId}`));
  const events = Number(sql(a.db, `SELECT count(*) FROM grocery_events WHERE text = '${text}'`));
  check(retry2.status === 200 && retry2.text === '{"ok":true}', 'kill (transaction): the retry answers as the first attempt would have', retry2);
  check(left === 0 && events === 1, 'kill (transaction): deleted once, one event', { left, events });
  // Without the operation ID the same retry would have answered 404: the item is gone.
  const fresh = await wasmFetch(RUNNER_B, a, 'DELETE', `/api/items/${itemId}`, 'alice', undefined, { 'x-usernode-op': 'other-' + op2 });
  check(fresh.status === 404, 'kill (transaction): a new operation sees the delete done', fresh.status);
  check(await waitHealthy(RUNNER_A), 'kill (transaction): runner A is back');
  summary.kill = { write: { first: first.error, retry_status: retry.status, rows, stored_statements: stored, replay_identical: again.text === retry.text }, transaction: { first: first2.error, retry: retry2.text, rows_left: left, events, new_op_status: fresh.status } };
}

// ---------------------------------------------------------------- 5: the last place

async function race(twin) {
  const a = APPS.signup;
  const go = (method, p, user, body, userId) => {
    const step = { method, path: p, user, userId, body };
    return call(twin, a, step);
  };
  const ev = (await go('POST', '/api/events', 'alice', { name: 'Race ' + twin, startsAt: FUTURE })).json.id;
  const slot = (await go('POST', `/api/events/${ev}/slots`, 'alice', { name: 'Last place', size: 3 })).json.id;
  await go('PUT', `/api/slots/${slot}/signup`, 'alice');
  await go('PUT', `/api/slots/${slot}/signup`, 'bob');
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => go('PUT', `/api/slots/${slot}/signup`, `racer${i}`, undefined, 1000 + i)));
  const ms = Date.now() - t0;
  const statuses = results.map((r) => r.status);
  const won = statuses.filter((s) => s === 201).length;
  const full = statuses.filter((s) => s === 409).length;
  const db = twin === 'wasm' ? a.db : 'app_signup_node';
  const taken = Number(sql(db, `SELECT count(*) FROM signup_entries WHERE slot_id = ${slot}`));
  check(won === 1 && full === 19 && taken === 3, `race on ${twin}: exactly one wins`, { statuses, taken });
  const open = Number(sql(db, "SELECT count(*) FROM pg_stat_activity WHERE state LIKE 'idle in transaction%'"));
  check(open === 0, `race on ${twin}: no transaction left open`, open);
  summary.race[twin] = { racers: 20, won, full, other: 20 - won - full, places_taken: taken, ms, idle_in_transaction: open };
}


// ---------------------------------------------------------------- the runtime's other promises

// What the starters do not exercise: outside calls started together (they
// overlap), AbortSignal.timeout, Promise.allSettled, timers, crypto, the
// time limit, the private-address guard, and a live-updates event stream.
const DEMO = `const express = require('express');
const crypto = require('crypto');
const app = express();
const BOOT = crypto.randomUUID();
const slow = (n, opts) => fetch(process.env.DEMO_SLOW_URL + '/slow?n=' + n, opts).then((r) => r.json());
const count = () => { globalThis.__n = (globalThis.__n || 0) + 1; return globalThis.__n; };
app.get('/fetch2', async (_req, res) => {
  const t0 = Date.now();
  const [a, b] = await Promise.all([slow(1), slow(2, { signal: AbortSignal.timeout(5000) })]);
  res.json({ a, b, ms: Date.now() - t0 });
});
app.get('/settled', async (_req, res) => {
  const r = await Promise.allSettled([slow(3), Promise.reject(new Error('no'))]);
  res.json(r.map((x) => x.status));
});
app.get('/later', (_req, res) => { setTimeout(() => res.json({ later: true }), 50); });
app.get('/crypto', (_req, res) => res.json({
  uuid: /^[0-9a-f-]{36}$/.test(crypto.randomUUID()),
  sha: crypto.createHash('sha256').update('abc').digest('hex'),
  hmac: crypto.createHmac('sha256', 'k').update('v').digest('base64'),
}));
app.get('/spin', () => { for (;;) {} });
app.get('/count', (_req, res) => res.json({ n: count(), boot: BOOT }));
app.get('/slowcount', async (_req, res) => { await slow(9); res.json({ n: count(), boot: BOOT }); });
app.get('/whoami', (req, res) => res.json({ n: count(), boot: BOOT, token: req.headers['x-usernode-token'] || null, tag: process.env.DEMO_TAG || null, hdr: req.headers['x-demo'] || null }));
app.get('/fail', (_req, res) => { Promise.reject(new Error('left unhandled')); res.json({ ok: true }); });
app.get('/exit', (_req, res) => { res.json({ ok: true }); process.exit(3); });
app.listen(3000);
`;


/** Warm instances: what lasts, for whom, and when it is let go. Fresh: nothing lasts. */
async function instances(get) {
  const warmA = Number(process.env.WARM_A || 0);
  const warmB = Number(process.env.WARM_B || 0);
  const D1 = 'app_demo_staging_s601_000001_w';
  const D2 = 'app_demo_staging_s601_000002_w';
  const out = { mode: warmA > 0 ? `warm (A: ${warmA}, B: ${warmB})` : 'fresh' };
  if (warmA === 0) {
    const a = await get(RUNNER_A, '/count', { app: 601, db: D1 });
    const b = await get(RUNNER_A, '/count', { app: 601, db: D1 });
    check(a.json.n === 1 && b.json.n === 1 && a.json.boot !== b.json.boot, 'fresh: every request starts from nothing', { a: a.json, b: b.json });
    summary.instances = out;
    return;
  }
  // Globals last for one app and database, and never reach another.
  const a1 = (await get(RUNNER_A, '/count', { app: 601, db: D1 })).json;
  const a2 = (await get(RUNNER_A, '/count', { app: 601, db: D1 })).json;
  const other = (await get(RUNNER_A, '/count', { app: 602, db: D1 })).json;
  const otherDb = (await get(RUNNER_A, '/count', { app: 601, db: D2 })).json;
  const otherEnv = (await get(RUNNER_A, '/count', { app: 601, db: D1, env: { DEMO_TAG: 'renamed' } })).json;
  const a3 = (await get(RUNNER_A, '/count', { app: 601, db: D1 })).json;
  check(a1.n === 1 && a2.n === 2 && a3.n === 3 && a1.boot === a2.boot && a2.boot === a3.boot, 'warm: an app\'s globals last between its requests', { a1, a2, a3 });
  check(other.n === 1 && other.boot !== a1.boot, 'warm: another app never gets the instance', other);
  check(otherDb.n === 1 && otherDb.boot !== a1.boot, 'warm: another database never gets the instance', otherDb);
  check(otherEnv.n === 1 && otherEnv.boot !== a1.boot, 'warm: another environment never gets the instance', otherEnv);
  // What belongs to a request reaches it, and is gone by the next.
  const w1 = (await get(RUNNER_A, '/whoami', { app: 610, db: D1, env: { DEMO_TAG: 't' }, headers: { 'x-usernode-token': 'tok-1', 'x-demo': 'one' } })).json;
  const w2 = (await get(RUNNER_A, '/whoami', { app: 610, db: D1, env: { DEMO_TAG: 't' }, headers: { 'x-demo': 'two' } })).json;
  check(w1.boot === w2.boot && w2.n === 2 && w1.token === 'tok-1' && w2.token === null && w1.hdr === 'one' && w2.hdr === 'two' && w2.tag === 't', 'warm: headers, identity and environment are each request\'s own', { w1, w2 });
  // Recycled after WARM_B requests: the next starts with empty globals.
  if (warmB > 0 && warmB < 10) {
    const seq = [];
    for (let i = 0; i < warmB + 1; i++) seq.push((await get(RUNNER_B, '/count', { app: 603, db: D1 })).json);
    const first = seq.slice(0, warmB);
    const last = seq[warmB];
    check(first.every((x, i) => x.n === i + 1 && x.boot === first[0].boot) && last.n === 1 && last.boot !== first[0].boot,
      `warm: recycled after ${warmB} requests, the next instance starts empty`, seq);
    out.recycle = seq.map((x) => x.n);
  }
  // Let go after a request that went wrong.
  for (const [route, status] of [['/fail', 200], ['/exit', 200], ['/spin', 500]]) {
    const before = (await get(RUNNER_A, '/count', { app: 604, db: D1 })).json;
    const bad = await get(RUNNER_A, route, { app: 604, db: D1 });
    const after = (await get(RUNNER_A, '/count', { app: 604, db: D1 })).json;
    check(bad.status === status && after.n === 1 && after.boot !== before.boot, `warm: let go after ${route}`, { before, bad: bad.status, after });
  }
  // A busy instance is not waited for: the second request runs fresh.
  const w = (await get(RUNNER_A, '/count', { app: 605, db: D1 })).json;
  const both = (await Promise.all([get(RUNNER_A, '/slowcount', { app: 605, db: D1 }), get(RUNNER_A, '/slowcount', { app: 605, db: D1 })])).map((r) => r.json);
  const onWarm = both.find((x) => x.boot === w.boot);
  const onFresh = both.find((x) => x.boot !== w.boot);
  check(onWarm && onFresh && onWarm.n === 2 && onFresh.n === 1, 'warm: a request finding the instance busy runs fresh', { w, both });
  summary.instances = out;
}

async function demo() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wasm-demo-'));
  fs.writeFileSync(path.join(dir, 'server.js'), DEMO);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', main: 'server.js', dependencies: { express: '^4' } }));
  const tgz = path.join(dir, 'p.tgz');
  execFileSync('tar', ['-C', dir, '-czf', tgz, 'server.js', 'package.json']);
  const built = await request(`${RUNNER_A}/_wasm/build`, { method: 'POST', headers: { authorization: `Bearer ${runnerToken}` }, body: fs.readFileSync(tgz) });
  if (!check(built.status === 200, 'demo: builds', built.body.toString())) return;
  const mod = built.headers['x-module-sha256'];
  fs.writeFileSync(path.join(MODULES, mod), built.body);
  const get = async (base, p, o) => {
    o = o || {};
    const pass = mintPass(KEYS, { app: o.app || 299, ses: 399, mod, db: o.db || 'app_demo_staging_s399_000000_w', env: Object.assign({ DEMO_SLOW_URL: env('SLOW_URL') }, o.env || {}) });
    const t0 = Date.now();
    const r = await request(base + p, { headers: Object.assign({ 'x-usernode-pass': pass }, o.headers || {}) });
    return { status: r.status, json: (() => { try { return JSON.parse(r.body.toString()); } catch (_) { return r.body.toString(); } })(), ms: Date.now() - t0 };
  };
  await instances(get);
  const f = await get(RUNNER_A, '/fetch2');
  check(f.status === 200 && f.json.a.n === '1' && f.json.b.n === '2', 'demo: two outside calls', f);
  check(f.status === 200 && f.json.ms < 550, 'demo: the two 300 ms calls overlap', f.json);
  const st = await get(RUNNER_A, '/settled');
  check(JSON.stringify(st.json) === '["fulfilled","rejected"]', 'demo: Promise.allSettled', st.json);
  const later = await get(RUNNER_A, '/later');
  check(later.status === 200 && later.json.later === true, 'demo: a timer answers', later);
  const c = await get(RUNNER_A, '/crypto');
  const want = { uuid: true, sha: crypto.createHash('sha256').update('abc').digest('hex'), hmac: crypto.createHmac('sha256', 'k').update('v').digest('base64') };
  check(JSON.stringify(c.json) === JSON.stringify(want), 'demo: crypto as in Node', c.json);
  const blocked = await get(RUNNER_B, '/fetch2');
  check(blocked.status === 500, 'demo: a runner without WASM_FETCH_ALLOW_PRIVATE refuses private addresses', blocked);
  const spin = await get(RUNNER_A, '/spin');
  check(spin.status === 500 && /time limit/.test(JSON.stringify(spin.json)), 'demo: a request that never ends hits the time limit', spin);
  const after = await get(RUNNER_A, '/crypto');
  check(after.status === 200, 'demo: the runner serves on after the time limit', after.status);
  summary.demo = { fetch2_ms: f.json.ms, fetch2_wall_ms: f.ms, spin_ms: spin.ms, spin_status: spin.status, private_blocked_status: blocked.status };

  // The grocery list's live updates: an event stream is answered with what
  // the handler wrote, then closed (the page reconnects after its retry).
  const a = APPS.grocery;
  const sse = await request(`${RUNNER_A}/api/changes`, { headers: { 'x-usernode-pass': mintPass(KEYS, { app: a.app, ses: a.ses, mod: a.mod, db: a.db, user: 7, env: envFor(a) }), 'x-usernode-token': mintToken(KEYS, a.app, 7, 'alice') } });
  check(sse.status === 200 && String(sse.headers['content-type']).startsWith('text/event-stream') && sse.body.toString().startsWith('retry: 3000'), 'live updates: the stream opens and closes', { status: sse.status, type: sse.headers['content-type'], body: sse.body.toString() });
}

// ---------------------------------------------------------------- 7: World Weather

const regionsOf = (j) => j.regions;
const wwWalk = [
  { name: 'the page', path: '/', user: 'alice', expect: 200 },
  { name: 'its script', path: '/app.js', expect: 200 },
  { name: 'the favicon (a file sent)', path: '/favicon.ico', expect: 200 },
  { name: 'health', path: '/health', expect: 200 },
  { name: 'countries (a data file)', path: '/api/regions', user: 'alice', expect: 200 },
  { name: 'France\'s regions (local names asked of the geocoder, then sorted)', path: '/api/regions/FR?lang=en', user: 'alice', expect: 200, order: regionsOf },
  { name: 'Indonesia\'s regions', path: '/api/regions/ID?lang=id', user: 'alice', expect: 200, order: regionsOf },
  { name: 'Brazil\'s regions', path: '/api/regions/BR?lang=en', user: 'alice', expect: 200, order: regionsOf },
  { name: 'Île-de-France\'s districts (a data file)', path: '/api/regions/FR/11', user: 'alice', expect: 200 },
  { name: 'Minas Gerais\'s 853 districts (a data file)', path: '/api/regions/BR/15', user: 'alice', expect: 200 },
  { name: 'a country that is not there', path: '/api/regions/XX', user: 'alice', expect: 404 },
  { name: 'weather in Paris (forecast and air quality)', path: '/api/weather?lat=48.8534&lon=2.3488&cc=FR', user: 'alice', expect: 200 },
  { name: 'weather in New York (and NWS alerts)', path: '/api/weather?lat=40.7128&lon=-74.006&cc=US', user: 'alice', expect: 200 },
  { name: 'weather, bad coordinates', path: '/api/weather?lat=999&lon=0', user: 'alice', expect: 400 },
  { name: 'search', path: '/api/geocode?q=Paris&lang=en', user: 'alice', expect: 200 },
  { name: 'search with filler words (falls back, sequential calls)', path: '/api/geocode?q=Sinjai%20selatan%20kab%20sinjai%20indonesia', user: 'alice', expect: 200 },
  { name: 'search too short', path: '/api/geocode?q=P', user: 'alice', expect: 400 },
  { name: 'a place', path: '/api/place?id=2988507&lang=en', user: 'alice', expect: 200 },
  { name: 'a place the geocoder does not know', path: '/api/place?id=1', user: 'alice', expect: 404 },
  { name: 'save a favorite', method: 'PUT', path: '/api/favorites/2988507', user: 'alice', body: { lang: 'en' }, expect: 200 },
  { name: 'the favorites', path: '/api/favorites', user: 'alice', expect: 200 },
  { name: 'someone else\'s favorites', path: '/api/favorites', user: 'bob', expect: 200 },
  { name: 'remove it', method: 'DELETE', path: '/api/favorites/2988507', user: 'alice', expect: 200 },
  { name: 'signed out', path: '/api/regions', expect: 401 },
];

async function providerStats(reset) {
  const r = await request(env('PROVIDER_STATS') + (reset ? '/__reset' : '/__stats'), { method: reset ? 'POST' : 'GET' });
  return JSON.parse(r.body.toString());
}

/** One weather request at fresh coordinates: its time and the most provider calls in flight at once. */
async function overlap(twin, lat, lon, cc) {
  const a = APPS.ww;
  await providerStats(true);
  const r = await call(twin, a, { path: `/api/weather?lat=${lat}&lon=${lon}&cc=${cc}`, user: 'alice' });
  const st = await providerStats(false);
  return { status: r.status, ms: Math.round(r.ms * 10) / 10, provider_calls: st.requests, most_at_once: st.most };
}

async function worldWeather() {
  await build('ww');
  await setup('ww');
  await walk('ww', wwWalk);
  const fr = { node: await overlap('node', 43.6047, 1.4442, 'FR'), wasm: await overlap('wasm', 43.6147, 1.4542, 'FR') };
  const us = { node: await overlap('node', 34.0522, -118.2437, 'US'), wasm: await overlap('wasm', 34.0622, -118.2537, 'US') };
  summary.ww_overlap = { two_calls: fr, three_calls: us };
  check(fr.wasm.most_at_once === 2 && us.wasm.most_at_once === 3, 'World Weather: the provider calls of one request overlap on Wasm', summary.ww_overlap);
}

// ---------------------------------------------------------------- 8: time and CPU per request

const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 32 });
function requestKA(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: keepAlive }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cpuUsec(container) {
  const t = execFileSync('docker', ['exec', container, 'cat', '/sys/fs/cgroup/cpu.stat'], { encoding: 'utf8' });
  return Number(/usage_usec (\d+)/.exec(t)[1]);
}
const pct = (xs, p) => { const v = xs.slice().sort((a, b) => a - b); return Math.round(v[Math.min(v.length - 1, Math.floor(v.length * p))] * 100) / 100; };

/** `rate` requests a second for `seconds`, each sent on time whatever the others do. */
async function measure(label, twin, a, pathFor, containers) {
  const rate = 50;
  const n = rate * Number(process.env.BENCH_SECONDS || 20);
  const token = mintToken(KEYS, a.app, 7, 'alice');
  const headersFor = () => twin === 'node' ? { 'x-usernode-token': token }
    : { 'x-usernode-token': token, 'x-usernode-pass': mintPass(KEYS, { app: a.app, ses: a.ses, mod: a.mod, db: a.db, user: 7, env: envFor(a) }) };
  const base = twin === 'node' ? a.node : RUNNER_A;
  // A pass for every request, signed beforehand, as the gate signs one each time.
  const headers = Array.from({ length: n }, headersFor);
  for (let i = 0; i < 20; i++) await requestKA(base + pathFor(-1 - i), headersFor());
  const before = containers.map(cpuUsec);
  const times = [];
  const codes = [];
  const t0 = Date.now();
  const all = [];
  for (let i = 0; i < n; i++) {
    const wait = t0 + (i * 1000) / rate - Date.now();
    if (wait > 0) await sleep(wait);
    const s = process.hrtime.bigint();
    all.push(requestKA(base + pathFor(i), headers[i]).then((c) => { codes.push(c); times.push(Number(process.hrtime.bigint() - s) / 1e6); }, () => codes.push(0)));
  }
  await Promise.all(all);
  const after = containers.map(cpuUsec);
  const cpu = {};
  containers.forEach((c, i) => { cpu[c.replace(/^.*?-(?=runner|data|pg|node)/, '')] = Math.round(((after[i] - before[i]) / 1000 / n) * 1000) / 1000; });
  const ok = codes.filter((c) => c === 200).length;
  check(ok === n, `bench ${label} on ${twin}: every request answered 200`, { ok, n });
  return { requests: n, ok, wall_ms: { p50: pct(times, 0.5), p95: pct(times, 0.95) }, cpu_ms_per_request: cpu };
}

async function bench() {
  const P = process.env.CONTAINER_PREFIX;
  const runner = [`${P}-runner-a`, `${P}-data`, `${P}-pg`];
  const out = {};
  const g = APPS.grocery;
  out['grocery: the list read'] = {
    node: await measure('grocery list', 'node', g, () => '/api/list', [`${P}-node-grocery`, `${P}-pg`]),
    wasm: await measure('grocery list', 'wasm', g, () => '/api/list', runner),
  };
  if (APPS.ww) {
    const w = APPS.ww;
    const nodeC = [`${P}-node-ww`];
    const wasmC = [`${P}-runner-a`];
    const routes = {
      'countries': () => '/api/regions',
      'France\'s regions (13 local names asked)': () => '/api/regions/FR?lang=en',
      'Île-de-France\'s districts': () => '/api/regions/FR/11',
      'Minas Gerais\'s 853 districts': () => '/api/regions/BR/15',
      'weather, one place (Node answers from its cache)': () => '/api/weather?lat=48.8534&lon=2.3488&cc=FR',
      // A place no request asked for before (Node's cache key is the place to 0.01°).
      'weather, a new place each time': (k) => `/api/weather?lat=${((((k % 100) + 100) % 100) * 0.5 - 25).toFixed(2)}&lon=${(Math.floor(k / 100) * 0.37 - 150).toFixed(2)}&cc=FR`,
    };
    for (const [label, pathFor] of Object.entries(routes)) {
      const route = label.startsWith('weather, a new') ? (twin) => (i) => pathFor(twin === 'node' ? 10000 + i : 30000 + i) : () => pathFor;
      out['ww: ' + label] = {
        node: await measure(label, 'node', w, route('node'), nodeC),
        wasm: await measure(label, 'wasm', w, route('wasm'), wasmC),
      };
    }
  }
  summary.bench = {
    mode: Number(process.env.WARM_A || 0) > 0 ? `warm (WASM_WARM=${process.env.WARM_A})` : 'fresh',
    rate_per_s: 50, seconds: Number(process.env.BENCH_SECONDS || 20),
    machine: 'Docker Desktop on this Mac (arm64); cpu from each container\'s cgroup', results: out,
    memory: await memory(),
  };
}

function rssKb(container) {
  const t = execFileSync('docker', ['exec', container, 'cat', '/proc/1/status'], { encoding: 'utf8' });
  return Number(/VmRSS:\s+(\d+)/.exec(t)[1]);
}

/** The runner's resident memory before and after requests for many apps of one module (warm: one instance each). */
async function memory() {
  const runner = `${process.env.CONTAINER_PREFIX}-runner-a`;
  const out = {};
  const each = async (label, a, path, count, firstApp) => {
    const before = rssKb(runner);
    for (let i = 0; i < count; i++) {
      const pass = mintPass(KEYS, { app: firstApp + i, ses: a.ses, mod: a.mod, db: a.db, user: 7, env: envFor(a) });
      const r = await request(RUNNER_A + path, { headers: { 'x-usernode-pass': pass, 'x-usernode-token': mintToken(KEYS, firstApp + i, 7, 'alice') } });
      check(r.status === 200, `memory: ${label} answers`, r.status);
    }
    const after = rssKb(runner);
    out[label] = { apps: count, rss_mb_before: Math.round(before / 102.4) / 10, rss_mb_after: Math.round(after / 102.4) / 10, mb_per_app: Math.round(((after - before) / count / 1024) * 100) / 100 };
  };
  await each('grocery list, /api/list', APPS.grocery, '/api/list', 20, 9000);
  if (APPS.ww) await each('World Weather, /api/regions/BR/15 (853 districts kept)', APPS.ww, '/api/regions/BR/15', 10, 9100);
  return out;
}

(async () => {
  try {
    await build('grocery');
    await build('signup');
    await refusedBuild();
    await setup('grocery');
    await setup('signup');
    // The data service refuses a pass whose database is not a twin: every query fails, the app answers 500.
    const bad = await request(`${RUNNER_A}/api/list`, { headers: { 'x-usernode-pass': mintPass(KEYS, { app: 201, ses: 301, mod: APPS.grocery.mod, db: 'postgres', user: 7 }), 'x-usernode-token': mintToken(KEYS, 201, 7, 'alice') } });
    check(bad.status === 500, 'a pass naming a database that is not a twin: the data service refuses its queries', `${bad.status} ${bad.body}`);
    // A pass edited after signing (another app) keeps its old signature: refused.
    const good = mintPass(KEYS, { app: 201, ses: 301, mod: APPS.grocery.mod, db: APPS.grocery.db });
    const [, sig] = good.split('.');
    const edited = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(good.split('.')[0], 'base64url')), { app: 999 }))).toString('base64url') + '.' + sig;
    const forged = await request(`${RUNNER_A}/api/list`, { headers: { 'x-usernode-pass': edited } });
    check(forged.status === 502, 'an edited pass is refused with 502', forged.status);
    const none = await request(`${RUNNER_A}/api/list`);
    check(none.status === 502, 'no pass: 502', none.status);
    const unknown = await request(`${RUNNER_A}/api/list`, { headers: { 'x-usernode-pass': mintPass(KEYS, { app: 201, ses: 301, mod: 'f'.repeat(64), db: APPS.grocery.db }) } });
    check(unknown.status === 502, 'an unknown module: 502', unknown.status);
    await walk('grocery', groceryWalk);
    await walk('signup', signupWalk);
    await killTest();
    await race('node');
    await race('wasm');
    await demo();
    if (APPS.ww) await worldWeather();
    if (process.env.BENCH === '1') await bench();
  } catch (e) {
    failures.push('crashed: ' + (e.stack || e));
  }
  summary.known_differences = known;
  summary.failures = failures;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(failures.length ? 1 : 0);
})();
