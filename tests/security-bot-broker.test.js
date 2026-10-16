'use strict';

// The security bot's HTTP broker (services/security-bot/broker.js): relative
// paths only, pinned origin, no redirects followed, caller Host/forwarding
// headers refused, identities applied by reference against the current run,
// physical requests counted and concurrency bounded.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBroker, safePath, BrokerError } = require('../src/services/security-bot/broker');

function stubRuns({ run = {} } = {}) {
  const calls = { dispatch: 0, admit: 0 };
  return {
    calls,
    assertCanDispatch: async () => { calls.dispatch += 1; return { capabilities_revoked_at: null, ...run }; },
    admitTargetRequest: async () => { calls.admit += 1; return { ...run }; },
  };
}

function recordingFetch() {
  const seen = [];
  const fn = async (url, options) => { seen.push({ url, options }); return { status: 200, url, options }; };
  fn.seen = seen;
  return fn;
}

const base = {
  origin: 'http://arena-host:3000',
  pool: {},
  lease: { runId: 1, owner: 'o', generation: 0 },
  maxParallel: 2,
  resolveIdentity: async () => ({ headers: { 'x-usernode-token': 'synthetic-arena-token' } }),
};

test('safePath accepts a relative path and refuses escapes', () => {
  assert.equal(safePath('/api/items?q=1'), '/api/items?q=1');
  for (const bad of ['http://evil/x', '//evil/x', '/../etc', '/a/../../b', '/a/%2e%2e/b',
    'relative', '', '/a\\b', '/user@host/x', '/a\u0000b', '/a b']) {
    assert.throws(() => safePath(bad), BrokerError, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('an absolute or cross-origin URL never reaches fetch', async () => {
  const fetchImpl = recordingFetch();
  const broker = createBroker({ ...base, fetchImpl, runs: stubRuns() });
  await assert.rejects(broker.request('http://evil.example/x'), /invalid_path/);
  await assert.rejects(broker.request('//evil.example/x'), /invalid_path/);
  assert.equal(fetchImpl.seen.length, 0);
});

test('the request lands on the pinned origin with the identity header', async () => {
  const fetchImpl = recordingFetch();
  const runs = stubRuns();
  const broker = createBroker({ ...base, fetchImpl, runs });
  await broker.request('/api/items', { identityRef: 'arena-user-1' });
  assert.equal(fetchImpl.seen.length, 1);
  assert.equal(fetchImpl.seen[0].url, 'http://arena-host:3000/api/items');
  assert.equal(fetchImpl.seen[0].options.headers['x-usernode-token'], 'synthetic-arena-token');
  assert.equal(fetchImpl.seen[0].options.redirect, 'manual');
  assert.equal(runs.calls.dispatch, 1);
  assert.equal(runs.calls.admit, 1);
});

test('a caller-supplied Host or forwarding header is refused, not stripped', async () => {
  const fetchImpl = recordingFetch();
  const broker = createBroker({ ...base, fetchImpl, runs: stubRuns() });
  for (const header of ['Host', 'X-Forwarded-For', 'Forwarded', 'X-Real-IP', 'Via', 'Cookie', 'Authorization']) {
    await assert.rejects(broker.request('/x', { headers: { [header]: 'spoof' } }), /forbidden_header/);
  }
  assert.equal(fetchImpl.seen.length, 0);
});

test('a redirect is surfaced, never followed', async () => {
  const fetchImpl = async () => ({ status: 302, headers: { get: () => 'http://evil/next' } });
  const broker = createBroker({ ...base, fetchImpl, runs: stubRuns() });
  const res = await broker.request('/redirect-me');
  assert.equal(res.status, 302); // caller sees the 3xx; the broker opened one connection
});

test('a revoked campaign cannot dispatch', async () => {
  const fetchImpl = recordingFetch();
  const runs = stubRuns({ run: { capabilities_revoked_at: new Date().toISOString() } });
  const broker = createBroker({ ...base, fetchImpl, runs });
  await assert.rejects(broker.request('/x'), /capabilities_revoked/);
  assert.equal(fetchImpl.seen.length, 0);
});

test('the identity is resolved against the current run on every request', async () => {
  const seenRuns = [];
  const runs = stubRuns({ run: { marker: 'current' } });
  const broker = createBroker({
    ...base, fetchImpl: recordingFetch(), runs,
    resolveIdentity: async (ref, run) => { seenRuns.push(run.marker); return { headers: {} }; },
  });
  await broker.request('/a');
  await broker.request('/b');
  assert.deepEqual(seenRuns, ['current', 'current']);
});

test('concurrency never exceeds max_parallel_requests', async () => {
  let active = 0; let peak = 0;
  const fetchImpl = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1; return { status: 200 };
  };
  const broker = createBroker({ ...base, maxParallel: 2, fetchImpl, runs: stubRuns() });
  await Promise.all([0, 1, 2, 3, 4].map((n) => broker.request(`/p${n}`)));
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded 2`);
});

test('a bad origin is refused at construction', () => {
  for (const origin of ['ftp://x', 'http://user:pass@h', 'http://h/path', 'not-a-url', 'http://h?q=1']) {
    assert.throws(() => createBroker({ ...base, origin }), BrokerError);
  }
});
