'use strict';

// Cross-instance fan-out for the WebSocket layer (services/ws-bus.js).
//
// Every broadcast in services/ws.js walks an in-memory Set of THIS process's
// sockets. That is complete at one pod — `platform.replicas: 1`, the shipped
// default — and silently loses roughly 1-1/N of every live update at N pods,
// with no error logged anywhere. The bus carries each event to the other
// instances over PostgreSQL LISTEN/NOTIFY.
//
// These tests drive the seam WITHOUT a database: `_handleNotification` is the
// listener's entry point, so a fabricated notification exercises the exact
// path a real one takes. The parts that genuinely need postgres — that LISTEN
// stays subscribed, that a dropped connection reconnects — are integration
// concerns and are not simulated here, which is stated rather than implied.
//
// Run with: node --test tests/ws-cross-instance-bus.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bus = require('../src/services/ws-bus');

function notify(env) {
  bus._handleNotification({ channel: bus.CHANNEL, payload: JSON.stringify(env) });
}

function collect() {
  const seen = [];
  bus.start({ pool: null, connectionString: null, onMessage: (m) => seen.push(m) });
  return seen;
}

test('an envelope from another instance is delivered', () => {
  const seen = collect();
  notify({ i: 'some-other-pod', k: 'global', r: null, d: { type: 'app_status' } });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    kind: 'global', routing: null, data: { type: 'app_status' }, oversize: false,
  });
});

test('our OWN echo is dropped, so nothing paints twice', () => {
  const seen = collect();
  // The emitter delivers locally and THEN publishes; the publish comes back
  // to it as a notification like any other. Instance id is what tells them
  // apart, and it is random per process rather than derived from a hostname —
  // two pods can share a host, and a collision would make one silently drop
  // the other's events as its own.
  notify({ i: bus.INSTANCE_ID, k: 'global', r: null, d: { type: 'app_status' } });
  assert.equal(seen.length, 0);
});

test('routing rides along for the audiences that need it', () => {
  const seen = collect();
  notify({ i: 'other', k: 'user', r: { userId: 42 }, d: { type: 'mention' } });
  notify({ i: 'other', k: 'room', r: { appId: 7 }, d: { type: 'chat' } });
  notify({ i: 'other', k: 'scoped', r: { appId: 7, appSlug: 'demo' }, d: { type: 'x' } });
  assert.deepEqual(seen.map((m) => [m.kind, m.routing]), [
    ['user', { userId: 42 }],
    ['room', { appId: 7 }],
    ['scoped', { appId: 7, appSlug: 'demo' }],
  ]);
});

test('an oversize envelope arrives flagged, carrying no payload', () => {
  const seen = collect();
  notify({ i: 'other', k: 'global', r: null, o: 1 });
  assert.equal(seen[0].oversize, true);
  assert.equal(seen[0].data, undefined,
    'the payload is absent by construction — a truncated event would be worse than none');
});

test('malformed and foreign notifications are ignored, not thrown on', () => {
  const seen = collect();
  bus._handleNotification({ channel: bus.CHANNEL, payload: 'not json' });
  bus._handleNotification({ channel: 'some_other_channel', payload: '{"i":"x","k":"global"}' });
  bus._handleNotification(null);
  bus._handleNotification({ channel: bus.CHANNEL });
  assert.equal(seen.length, 0);
});

test('a handler that throws cannot kill the listener', () => {
  bus.start({
    pool: null,
    connectionString: null,
    onMessage: () => { throw new Error('boom'); },
  });
  assert.doesNotThrow(() => notify({ i: 'other', k: 'global', r: null, d: { type: 'x' } }));
});

// ── The wiring in ws.js ───────────────────────────────────────────────
//
// Source assertions, because exercising the real thing needs a live
// WebSocketServer and a database. What matters is the SHAPE: local delivery
// and fan-out are separate functions, and the bus handler calls the local one
// — a bus message that re-entered the publishing wrapper would loop.

const WS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'ws.js'), 'utf8');

test('every fan-out point delivers locally AND publishes', () => {
  for (const [wrapper, deliver, kind] of [
    ['broadcast', 'deliverToRoom', 'room'],
    ['broadcastGlobal', 'deliverGlobal', 'global'],
    ['broadcastGlobalScoped', 'deliverGlobalScoped', 'scoped'],
    ['broadcastToAdmins', 'deliverToAdmins', 'admins'],
    ['pushToUser', 'deliverToUser', 'user'],
  ]) {
    const at = WS_SRC.indexOf(`function ${wrapper}(`);
    assert.ok(at > 0, `${wrapper} exists`);
    const body = WS_SRC.slice(at, WS_SRC.indexOf('\n}', at));
    assert.ok(body.includes(`${deliver}(`), `${wrapper} delivers locally via ${deliver}`);
    assert.match(body, new RegExp(`wsBus\\.publish\\('${kind}'`), `${wrapper} publishes as '${kind}'`);
  }
});

test('the bus handler routes into the LOCAL half, never the publisher', () => {
  const at = WS_SRC.indexOf('function _onBusMessage(');
  const body = WS_SRC.slice(at, WS_SRC.indexOf('\nfunction attach(', at));
  for (const local of ['deliverGlobal', 'deliverToRoom', 'deliverGlobalScoped',
    'deliverToAdmins', 'deliverToUser']) {
    assert.ok(body.includes(`${local}(`), `routes to ${local}`);
  }
  // The loop this prevents: a remote event that re-entered broadcastGlobal
  // would publish itself straight back out, and every instance would answer
  // every other one forever.
  assert.doesNotMatch(body, /wsBus\.publish/, 'a bus message is never re-published');
  assert.doesNotMatch(body, /\bbroadcast(Global|ToAdmins|GlobalScoped)?\(/,
    'and never re-enters a publishing wrapper');
});

test('excludeWs is not published — it names a socket in one process', () => {
  const at = WS_SRC.indexOf('function broadcast(appId');
  const body = WS_SRC.slice(at, WS_SRC.indexOf('\n}', at));
  assert.match(body, /wsBus\.publish\('room', \{ appId \}, data\)/,
    'the room publish carries appId and data only');
});

test('the client answers the oversize nudge with its existing recovery path', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(APP, /case 'resync_hint':\s*\n\s*App\.resyncCurrentView\(\);/,
    'resync_hint reuses resyncCurrentView, the same repair a dropped socket runs');
});

test('the payload budget sits under the NOTIFY hard cap', () => {
  // 8000 is the server's limit and it REJECTS anything larger, so the
  // envelope's own bytes have to come out of the budget rather than out of
  // luck.
  assert.ok(bus.MAX_PAYLOAD_BYTES < 8000, 'leaves room for the envelope');
});

// ── The SEND side ─────────────────────────────────────────────────────

function fakePool() {
  const calls = [];
  return {
    calls,
    query: (sql, params) => { calls.push({ sql, params }); return Promise.resolve({ rows: [] }); },
  };
}

test('publish sends the payload through pg_notify, stamped with this instance', () => {
  const pool = fakePool();
  bus.start({ pool, connectionString: null, onMessage: () => {} });
  bus.publish('global', null, { type: 'app_status', slug: 'demo' });

  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /pg_notify/);
  assert.equal(pool.calls[0].params[0], bus.CHANNEL);
  const env = JSON.parse(pool.calls[0].params[1]);
  assert.equal(env.i, bus.INSTANCE_ID, 'so the emitter can drop its own echo');
  assert.equal(env.k, 'global');
  assert.deepEqual(env.d, { type: 'app_status', slug: 'demo' });
  assert.ok(!env.o, 'not flagged oversize');
});

test('an oversize payload becomes a NUDGE, and the payload is not sent', () => {
  const pool = fakePool();
  bus.start({ pool, connectionString: null, onMessage: () => {} });
  // A cc_progress frame or a long chat body genuinely reaches this size.
  const huge = { type: 'session_event', event: 'cc_progress', blob: 'x'.repeat(9000) };
  bus.publish('global', null, huge);

  const env = JSON.parse(pool.calls[0].params[1]);
  assert.equal(env.o, 1, 'flagged as oversize');
  assert.equal(env.d, undefined, 'and carries no payload at all');
  assert.ok(Buffer.byteLength(pool.calls[0].params[1], 'utf8') < 8000,
    'what is actually sent fits the NOTIFY cap — the whole point of the nudge');
});

test('routing survives the downgrade, so the nudge reaches the right audience', () => {
  const pool = fakePool();
  bus.start({ pool, connectionString: null, onMessage: () => {} });
  bus.publish('user', { userId: 42 }, { type: 'mention', body: 'y'.repeat(9000) });
  const env = JSON.parse(pool.calls[0].params[1]);
  assert.equal(env.o, 1);
  assert.deepEqual(env.r, { userId: 42 },
    'an oversize mention still nudges that user, not everybody');
});

test('publish is a no-op with no pool, and never throws', () => {
  bus.start({ pool: null, connectionString: null, onMessage: () => {} });
  assert.doesNotThrow(() => bus.publish('global', null, { type: 'x' }));
  // A payload that cannot be serialised is dropped rather than thrown:
  // a broadcast that already reached this pod's sockets has done its job.
  const pool = fakePool();
  bus.start({ pool, connectionString: null, onMessage: () => {} });
  const cyclic = {}; cyclic.self = cyclic;
  assert.doesNotThrow(() => bus.publish('global', null, cyclic));
  assert.equal(pool.calls.length, 0, 'nothing published');
});
