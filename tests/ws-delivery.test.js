'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDelivery, MAX_CLIENT_FRAMES, MAX_CLIENT_BYTES } = require('../src/services/ws-delivery');

const turn = () => new Promise(resolve => setImmediate(resolve));
const client = () => ({ user: { id: 1, username: 'fake', isAdmin: true },
  auth: { kind: 'cookie', token: 'fake-session' }, ws: { readyState: 1 } });

function fixture(query) {
  const sent = [], refused = [], errors = [], calls = [];
  const gate = createDelivery({
    getPool: () => ({ query: async (sql, params) => {
      const inputs = JSON.parse(params[0]);
      calls.push(inputs);
      return { rows: await query(inputs) };
    } }),
    send: (c, json) => sent.push([c, json]),
    refuse: (c, reason) => { refused.push(reason); c.ws.readyState = 3; },
    onError: err => errors.push(err),
  });
  return { gate, sent, refused, errors, calls };
}
const allow = inputs => inputs.map(d => ({ n: d.n, username: 'current', is_admin: false, authenticated: true, allowed: true }));

test('a burst shares one fresh query and preserves order; an action receives a fresh identity snapshot', async () => {
  const f = fixture(allow), c = client();
  for (let n = 0; n < 20; n++) assert.equal(f.gate.enqueue(c, String(n)), true);
  await turn();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.sent.map(([, json]) => json), Array.from({ length: 20 }, (_, n) => String(n)));
  f.gate.enqueue(c, 'later');
  await turn();
  assert.equal(f.calls.length, 2, 'the next burst cannot reuse a positive decision');
  const current = await f.gate.check(c);
  assert.deepEqual(current, { id: 1, username: 'current', isAdmin: false });
  assert.equal(c.user.isAdmin, true, 'concurrent checks never mutate another action\'s identity');
});

test('no cached handshake authority or bus audience can replace a denied decision', async () => {
  const f = fixture(inputs => inputs.map(d => ({ n: d.n, authenticated: true, allowed: false })));
  const c = client();
  f.gate.enqueue(c, 'FAKE_PRIVATE_CONTENT', { appRequired: true, appId: 20 });
  await turn();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.refused, [], 'a scoped refusal does not close the unrelated events socket');
  c.appId = 20;
  f.gate.enqueue(c, 'room content', { appRequired: true, appId: 20 });
  await turn();
  assert.deepEqual(f.refused, ['app']);
});

test('missing authentication, missing rows and an unavailable database all fail closed', async t => {
  for (const [name, query, reason] of [
    ['revoked', inputs => inputs.map(d => ({ n: d.n, authenticated: false, allowed: true })), 'identity'],
    ['missing', () => [], 'identity'],
    ['outage', () => { throw new Error('fake database outage'); }, 'unavailable'],
  ]) await t.test(name, async () => {
    const f = fixture(query);
    f.gate.enqueue(client(), 'FAKE_PRIVATE_CONTENT');
    await turn();
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.refused, [reason]);
  });
});

test('a delayed check cannot be overtaken, and the next batch checks again', async () => {
  let resume;
  const waiting = new Promise(resolve => { resume = resolve; });
  let first = true;
  const f = fixture(async inputs => {
    if (first) { first = false; await waiting; return allow(inputs); }
    return inputs.map(d => ({ n: d.n, authenticated: false }));
  });
  const c = client();
  f.gate.enqueue(c, 'before revocation');
  await turn();
  f.gate.enqueue(c, 'after revocation');
  assert.deepEqual(f.sent, []);
  resume();
  await turn();
  assert.deepEqual(f.sent.map(([, json]) => json), ['before revocation']);
  assert.deepEqual(f.refused, ['identity']);
});

test('pending budgets include frames whose authorization query is in flight', async () => {
  let resume;
  const waiting = new Promise(resolve => { resume = resolve; });
  const f = fixture(async inputs => { await waiting; return allow(inputs); });
  const c = client();
  f.gate.enqueue(c, 'first');
  await turn();
  for (let n = 1; n < MAX_CLIENT_FRAMES; n++) assert.equal(f.gate.enqueue(c, 'next'), true);
  assert.equal(f.gate.enqueue(c, 'over budget'), false);
  assert.deepEqual(f.refused, ['overflow']);
  resume();
  await turn();
  assert.deepEqual(f.sent, []);
});

test('a single oversized frame is refused before a query', async () => {
  const f = fixture(allow);
  assert.equal(f.gate.enqueue(client(), 'x'.repeat(MAX_CLIENT_BYTES + 1)), false);
  await turn();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.refused, ['overflow']);
});

test('an unwatch during the query wins for a watcher, while the owner still receives', async () => {
  let resume;
  const waiting = new Promise(resolve => { resume = resolve; });
  const f = fixture(async inputs => { await waiting; return allow(inputs).map((r, n) => ({ ...r, session_owner: n === 1 })); });
  const watcher = client(), owner = client();
  watcher.watching = new Set([12]); owner.watching = new Set([12]);
  const scope = { sessionId: 12, watching: true };
  f.gate.enqueue(watcher, 'watcher frame', scope);
  f.gate.enqueue(owner, 'owner frame', scope);
  await turn();
  watcher.watching.clear(); owner.watching.clear();
  resume();
  await turn();
  assert.deepEqual(f.sent.map(([, json]) => json), ['owner frame']);
});

test('a staging descriptor is never authority in production', async () => {
  const f = fixture(allow), c = client();
  c.auth = { kind: 'staging', token: 'fake-jwt' };
  await f.gate.check(c);
  assert.equal(f.calls[0][0].staging, false);
  assert.equal(f.calls[0][0].token, null);
});

test('an existing staging credential is reverified for expiry and audience', async () => {
  require('./platform-keys').setPlatformKeys();
  const jwt = require('../src/services/platform-jwt');
  const saved = { env: process.env.USERNODE_ENV, app: process.env.USERNODE_APP_ID, now: Date.now };
  process.env.USERNODE_ENV = 'staging';
  process.env.USERNODE_APP_ID = '42';
  try {
    const f = fixture(inputs => allow(inputs).map((r, n) => ({ ...r, authenticated: inputs[n].staging })));
    const c = client();
    c.auth = { kind: 'staging', token: jwt.signAppIdentityToken({ appId: 42, user: c.user, ttl: '1h' }) };
    assert.ok(await f.gate.check(c));
    process.env.USERNODE_APP_ID = '43';
    assert.equal(await f.gate.check(c), false, 'a different app audience cannot renew authority');
    process.env.USERNODE_APP_ID = '42';
    c.ws.readyState = 1;
    Date.now = () => saved.now() + 2 * 3600_000;
    assert.equal(await f.gate.check(c), false, 'the same connected credential stops at expiry');
  } finally {
    Date.now = saved.now;
    if (saved.env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = saved.env;
    if (saved.app === undefined) delete process.env.USERNODE_APP_ID; else process.env.USERNODE_APP_ID = saved.app;
  }
});

test('an uninitialized delivery authority cannot fall back to sending', async () => {
  const sent = [], refused = [];
  const f = createDelivery({ getPool: () => null, send: (...args) => sent.push(args),
    refuse: (_client, why) => refused.push(why), onError() {} });
  f.enqueue(client(), 'FAKE_PRIVATE_CONTENT', { appRequired: true, appId: 1 });
  await turn();
  assert.deepEqual(sent, []);
  assert.deepEqual(refused, ['unavailable']);
});

test('a late older check cannot overwrite a newer action\'s demoted identity', async () => {
  let resume;
  const waiting = new Promise(resolve => { resume = resolve; });
  let checks = 0;
  const f = fixture(async inputs => {
    const older = checks++ === 0;
    if (older) await waiting;
    return allow(inputs).map(row => ({ ...row, is_admin: older }));
  });
  const c = client();
  const older = f.gate.check(c);
  const current = await f.gate.check(c);
  assert.equal(current.isAdmin, false);
  resume();
  assert.equal((await older).isAdmin, true);
  assert.equal(current.isAdmin, false, 'the action keeps the identity its own check returned');
});
