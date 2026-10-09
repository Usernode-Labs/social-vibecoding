'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const telemetry = require('../src/services/ui-telemetry');
const { createUITelemetry } = require('../public/js/ui-telemetry');

let idSequence = 0;
const idRun = Date.now().toString(36);
function id(prefix = 'opaque') {
  idSequence += 1;
  return `${prefix}-${idRun}-${String(idSequence).padStart(12, '0')}`;
}

function event(overrides = {}) {
  return {
    id: id('event'),
    visitId: id('visit'),
    kind: 'screen_visit',
    screen: 'app_detail',
    occurredAt: new Date().toISOString(),
    sequence: 1,
    ...overrides,
  };
}

function batch(events, overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: id('batch'),
    events,
    delivery: { failedBatches: 0, droppedEvents: 0 },
    ...overrides,
  };
}

test('collector accepts only the fixed content-free vocabulary', () => {
  const attemptId = id('attempt');
  const parsed = telemetry.parseBatch(batch([
    event({ kind: 'action_attempt', action: 'app_detail_load', attemptId, appSlug: 'a', build: 'abcdef1' }),
    event({ kind: 'action_outcome', action: 'app_detail_load', attemptId,
      outcome: 'failure', errorCode: 'not_found', durationMs: 42, sequence: 2 }),
  ]));
  assert.equal(parsed.events[0].appSlug, 'a', 'one-character valid slugs are accepted');
  assert.equal(parsed.events[1].errorCode, 'not_found');
  // The first session's ping ask (NativeChrome.askForPing): its answer.
  const asked = id('attempt');
  const ping = telemetry.parseBatch(batch([
    event({ kind: 'action_attempt', action: 'push_permission', screen: 'ping_ask', attemptId: asked }),
    event({ kind: 'action_outcome', action: 'push_permission', screen: 'ping_ask', attemptId: asked,
      outcome: 'failure', errorCode: 'access_denied', durationMs: 900, sequence: 2 }),
  ]));
  assert.deepEqual(ping.events.map((e) => [e.action, e.screen, e.outcome || null]),
    [['push_permission', 'ping_ask', null], ['push_permission', 'ping_ask', 'failure']]);
  assert.equal(telemetry.JOURNEY_SCREENS.has('ping_ask'), true);

  for (const forbidden of [
    { rawUrl: 'https://example.test/?token=secret' },
    { query: 'token=secret' },
    { message: 'private report text' },
    { stack: 'Error: private' },
    { selector: '#email' },
  ]) {
    assert.throws(() => telemetry.parseBatch(batch([event(forbidden)])), /unsupported field/);
  }
  assert.throws(() => telemetry.parseBatch(batch([event({ kind: 'boot_failure', screen: 'shell_boot',
    errorCode: 'Error: user@example.test' })])), /not allowlisted/);
  assert.throws(() => telemetry.parseBatch(batch([event({ kind: 'action_outcome',
    action: 'app_detail_load', attemptId, outcome: 'cancelled', errorCode: 'network' })])),
  /errorCode is only valid for failures/);
});

test('a push tap route attempt passes ingest on both ends (#4524)', () => {
  const attemptId = id('attempt');
  const parsed = telemetry.parseBatch(batch([
    event({ kind: 'action_attempt', action: 'push_tap_route', screen: 'shell_boot', attemptId }),
    event({ kind: 'action_outcome', action: 'push_tap_route', screen: 'shell_boot', attemptId,
      outcome: 'success', durationMs: 180, sequence: 2 }),
  ]));
  assert.deepEqual(parsed.events.map((e) => [e.kind, e.action, e.outcome || null]), [
    ['action_attempt', 'push_tap_route', null],
    ['action_outcome', 'push_tap_route', 'success'],
  ]);
  const missed = telemetry.parseBatch(batch([
    event({ kind: 'action_outcome', action: 'push_tap_route', screen: 'shell_boot', attemptId,
      outcome: 'failure', errorCode: 'not_found', durationMs: 900, sequence: 2 }),
  ]));
  assert.equal(missed.events[0].errorCode, 'not_found');
  const network = telemetry.parseBatch(batch([
    event({ kind: 'action_outcome', action: 'push_tap_route', screen: 'shell_boot', attemptId,
      outcome: 'failure', errorCode: 'network', durationMs: 900, sequence: 2 }),
  ]));
  assert.equal(network.events[0].errorCode, 'network');
  // The client's attempt() gate and the server's ingest must move together:
  // a set that accepts one and not the other silently drops every event.
  const h = clientHarness({});
  h.api.setUser(7);
  assert.equal(typeof h.api.attempt('push_tap_route', { screen: 'shell_boot' }), 'string',
    'the client emits the action once the collection gate allows it');
});

test('navigation vocabulary: named screens, a via only on navigation, hidden is a bare mark', () => {
  const parsed = telemetry.parseBatch(batch([
    event({ screen: 'home', via: 'own' }),
    event({ screen: 'project', appSlug: 'run-club', via: 'nudged', sequence: 2 }),
    event({ kind: 'screen_hidden', screen: 'project', appSlug: 'run-club', sequence: 3 }),
    event({ screen: 'discover', sequence: 4 }),
  ], { schemaVersion: 2 }));
  assert.deepEqual(parsed.events.map((e) => [e.kind, e.screen, e.via]), [
    ['screen_visit', 'home', 'own'],
    ['screen_visit', 'project', 'nudged'],
    ['screen_hidden', 'project', null],
    ['screen_visit', 'discover', null],
  ]);
  assert.ok(telemetry.parseBatch(batch([event()], { schemaVersion: 1 })),
    'a shell cached before navigation shipped still reports its failures');
  assert.throws(() => telemetry.parseBatch(batch([event()], { schemaVersion: 3 })),
    /schemaVersion must be 1 or 2/);
  assert.throws(() => telemetry.parseBatch(batch([event({ screen: 'home', via: 'teleport' })])),
    /not allowlisted/);
  assert.throws(() => telemetry.parseBatch(batch([event({ screen: 'app_detail', via: 'own' })])),
    /via is only valid on a navigation screen_visit/,
    'the seven failure journeys never carry a via');
  assert.throws(() => telemetry.parseBatch(batch([event({ kind: 'screen_hidden', screen: 'app_detail' })])),
    /screen_hidden is a bare mark/);
  assert.throws(() => telemetry.parseBatch(batch([event({ kind: 'screen_hidden', screen: 'home',
    durationMs: 10 })])), /screen_hidden is a bare mark/);
  assert.throws(() => telemetry.parseBatch(batch([event({ screen: 'home', path: '#app/x' })])),
    /unsupported field/, 'an address never travels with a navigation step');
  for (const code of telemetry.NAV_SCREENS) {
    assert.equal(telemetry.JOURNEY_SCREENS.has(code), false, `${code} is not a failure journey`);
  }
});

test('the failure report reads its seven journeys only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ui-telemetry.js'), 'utf8');
  const body = src.slice(src.indexOf('async function aggregate'), src.indexOf('module.exports'));
  assert.equal((body.match(/'ui_experience' AND \$\{base\}/g) || []).length, 0,
    'every observation query is scoped by uiBase');
  assert.equal((body.match(/'ui_experience' AND \$\{uiBase\}/g) || []).length, 5);
  assert.match(body, /const uiBase = `\$\{base\} AND e\.metadata->>'screen' = ANY\(\$3::text\[\]\)`/);
  assert.match(body, /'ui_telemetry_delivery' AND \$\{base\}`, params\)/,
    'delivery receipts keep the unscoped parameters');
});

function clientHarness({ fetchImpl, hash = '', boot = null, withDocument = false, stored = {} } = {}) {
  let now = Date.parse('2026-10-01T10:00:00Z');
  let uuid = 0;
  let timerId = 0;
  const timers = new Map();
  const listeners = new Map();
  const documentListeners = new Map();
  const storageValues = new Map(Object.entries(stored));
  const sent = [];
  const document = withDocument ? {
    readyState: 'loading',
    visibilityState: 'visible',
    addEventListener(name, fn) { documentListeners.set(name, fn); },
    querySelector() { return null; },
  } : null;
  const env = {
    document,
    location: { hash },
    __unBoot: boot || undefined,
    crypto: { randomUUID() {
      uuid += 1;
      return `00000000-0000-4000-8000-${String(uuid).padStart(12, '0')}`;
    } },
    now: () => now,
    setTimeout(fn, delay = 0) {
      timerId += 1;
      timers.set(timerId, { fn, at: now + delay });
      return timerId;
    },
    clearTimeout(key) { timers.delete(key); },
    localStorage: {
      getItem(key) { return storageValues.get(key) || null; },
      setItem(key, value) { storageValues.set(key, value); },
      removeItem(key) { storageValues.delete(key); },
    },
    addEventListener(name, fn) { listeners.set(name, fn); },
    async fetch(url, opts) {
      sent.push({ url, opts, body: JSON.parse(opts.body) });
      return fetchImpl ? fetchImpl(url, opts, sent.length) : { ok: true, status: 202 };
    },
  };
  function elapse(ms, runTimers = false) {
    now += ms;
    if (!runTimers) return;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [key, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(key);
          timer.fn();
          progressed = true;
        }
      }
    }
  }
  return {
    api: createUITelemetry(env), env, document, listeners, documentListeners,
    sent, storageValues, elapse,
  };
}

test('client records repeat, timeout, recovery, cancellation and real page departure separately', async () => {
  const h = clientHarness({ withDocument: true });
  h.api.setUser(7);
  const first = h.api.attempt('app_detail_load', {
    screen: 'app_detail', appSlug: 'demo', timeoutMs: 1000, abandonOnHide: true,
  });
  const second = h.api.attempt('app_detail_load', {
    screen: 'app_detail', appSlug: 'demo', timeoutMs: 1000, abandonOnHide: true,
  });
  h.api.cancel(second);
  h.elapse(1000, true);
  h.api.outcome(first, 'success');

  const pending = h.api.attempt('feedback_submit', {
    screen: 'feedback_dialog', timeoutMs: 5000, abandonOnHide: true,
  });
  h.elapse(1500);
  h.document.visibilityState = 'hidden';
  h.documentListeners.get('visibilitychange')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.flatMap((call) => call.body.events)
    .filter((item) => item.kind === 'navigation_abandonment').length, 0,
  'a tab switch is not classified as navigation abandonment');
  h.listeners.get('pagehide')();
  await new Promise((resolve) => setImmediate(resolve));
  await h.api.flush();

  const records = h.sent.flatMap((call) => call.body.events);
  assert.ok(records.some((item) => item.kind === 'repeated_action' && item.attemptId === second));
  assert.ok(records.some((item) => item.kind === 'loading_timeout' && item.attemptId === first));
  assert.ok(records.some((item) => item.kind === 'recovery' && item.attemptId === first));
  assert.ok(records.some((item) => item.kind === 'action_outcome'
    && item.attemptId === second && item.outcome === 'cancelled'));
  assert.ok(records.some((item) => item.kind === 'navigation_abandonment'
    && item.attemptId === pending));
});

test('client bounds loss, drains every batch, and reuses ids across a retry', async () => {
  const statuses = [500, 202, 202, 202, 202, 202];
  const h = clientHarness({ fetchImpl: async () => {
    const status = statuses.shift() || 202;
    return { ok: status < 400, status };
  } });
  h.api.setUser(8);
  for (let i = 0; i < 100; i += 1) h.api.screen('app_detail', { appSlug: 'demo' });
  assert.deepEqual(h.api.diagnostics(), {
    queued: 80, active: 0, droppedEvents: 20, failedBatches: 0,
  });

  await h.api.flush();
  const first = h.sent[0].body;
  h.elapse(999, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 1, 'a failed batch waits for its bounded retry delay');
  h.elapse(1, true);
  await new Promise((resolve) => setImmediate(resolve));
  const retry = h.sent[1].body;
  assert.equal(retry.batchId, first.batchId);
  assert.deepEqual(retry.events.map((item) => item.id), first.events.map((item) => item.id));
  assert.equal(retry.delivery.failedBatches, 1);
  assert.equal(retry.delivery.droppedEvents, 20);
  while (h.api.diagnostics().queued) await h.api.flush();
  assert.equal(h.sent.slice(1).reduce((sum, call) => sum + call.body.events.length, 0), 80,
    'the successful retry plus later batches drain the bounded queue');
  assert.equal(h.api.diagnostics().queued, 0, 'a successful 25-record batch schedules/drains successors');
});

test('an old account response cannot clear the new account queue', async () => {
  let resolveOld;
  const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
  const h = clientHarness({ fetchImpl: async (_url, _opts, call) => (
    call === 1 ? oldResponse : { ok: true, status: 202 }
  ) });
  h.api.setUser('old-user');
  h.api.screen('app_detail');
  const oldFlush = h.api.flush();
  h.api.setUser('new-user');
  h.api.screen('feedback_dialog');
  resolveOld({ ok: false, status: 401 });
  await oldFlush;
  assert.equal(h.api.diagnostics().queued, 1, 'the new user queue survives the old 401');
  await h.api.flush();
  assert.equal(h.sent[1].body.events[0].screen, 'feedback_dialog');
});

test('synthetic session identification drops pre-auth and persisted observations', async () => {
  const serviceId = '2147483000';
  const stale = event();
  const h = clientHarness({
    withDocument: true,
    boot: { errors: [], steps: [{ step: 'hydrate' }] },
    stored: { [`ui-telemetry-v1:${serviceId}`]: JSON.stringify([stale]) },
  });
  h.documentListeners.get('DOMContentLoaded')();
  assert.ok(h.api.diagnostics().queued > 0, 'boot observations wait in memory for session eligibility');

  h.documentListeners.get('sv:session')({ detail: { user: {
    id: serviceId,
    username: 'usernode-shots-full-admin',
    isAdmin: true,
    uiTelemetryEligible: false,
  }, verifiedSession: true } });
  assert.deepEqual(h.api.diagnostics(), {
    queued: 0, active: 0, droppedEvents: 0, failedBatches: 0,
  });
  assert.equal(h.storageValues.has(`ui-telemetry-v1:${serviceId}`), false,
    'an old persisted capture queue is removed without loading it');
  assert.equal(h.api.screen('app_detail'), null, 'later synthetic actions stay disabled');
  assert.deepEqual(h.api.contextHeaders(), {}, 'synthetic reports carry no UI correlation headers');
  assert.equal(await h.api.flush(), false);
  assert.equal(h.sent.length, 0, 'no pre-auth or persisted capture observation reaches the endpoint');
});

test('an unverified snapshot buffers signals until the same human is verified', async () => {
  const h = clientHarness({
    withDocument: true,
    boot: { errors: [], steps: [{ step: 'hydrate' }] },
  });
  h.documentListeners.get('DOMContentLoaded')();
  h.documentListeners.get('sv:session')({ detail: { user: {
    id: 80, username: 'returning-human',
  }, verifiedSession: false } });
  h.documentListeners.get('sv:session')({ detail: { user: {
    id: 80, username: 'returning-human', uiTelemetryEligible: true,
  }, verifiedSession: false } });
  h.api.screen('app_detail', { appSlug: 'demo' });
  const attemptId = h.api.attempt('app_detail_load', { screen: 'app_detail', appSlug: 'demo' });
  assert.equal(await h.api.flush(), false, 'an offline snapshot never authorizes delivery');
  assert.equal(h.sent.length, 0);

  h.documentListeners.get('sv:session')({ detail: { user: {
    id: 80, username: 'returning-human', uiTelemetryEligible: true,
  }, verifiedSession: true } });
  h.api.outcome(attemptId, 'success');
  assert.equal(await h.api.flush(), true);
  const records = h.sent[0].body.events;
  assert.ok(records.some((item) => item.screen === 'shell_boot'), 'the buffered boot survives');
  assert.ok(records.some((item) => item.kind === 'screen_visit' && item.screen === 'app_detail'));
  assert.ok(records.some((item) => item.kind === 'action_attempt' && item.attemptId === attemptId));
  assert.ok(records.some((item) => item.kind === 'action_outcome' && item.attemptId === attemptId));
});

test('verification as a different account discards snapshot-owned observations', async () => {
  const h = clientHarness();
  h.api.setUser({ id: 81, username: 'old-snapshot' });
  h.api.screen('app_detail');
  h.api.setUser({ id: 82, username: 'new-human', uiTelemetryEligible: true });
  h.api.screen('feedback_dialog');
  assert.equal(await h.api.flush(), true);
  assert.deepEqual(h.sent[0].body.events.map((item) => item.screen), ['feedback_dialog']);
});

test('repeat and recovery state never crosses a verified account switch', async () => {
  const h = clientHarness();
  h.api.setUser({ id: 83, username: 'first-human', uiTelemetryEligible: true });
  const first = h.api.attempt('app_detail_load', { screen: 'app_detail' });
  h.api.outcome(first, 'failure', { errorCode: 'network' });

  h.api.setUser({ id: 84, username: 'second-human', uiTelemetryEligible: true });
  const second = h.api.attempt('app_detail_load', { screen: 'app_detail' });
  h.api.outcome(second, 'success');
  assert.equal(await h.api.flush(), true);
  const records = h.sent[0].body.events;
  assert.deepEqual(records.map((item) => item.kind), ['action_attempt', 'action_outcome']);
  assert.ok(records.every((item) => item.attemptId === second));
});

test('synthetic identification aborts delivery and a later human admin is tracked', async () => {
  const never = new Promise(() => {});
  const h = clientHarness({ fetchImpl: async (_url, _opts, call) => (
    call === 1 ? never : { ok: true, status: 202 }
  ) });
  h.api.setUser({ id: 70, username: 'person', uiTelemetryEligible: true });
  h.api.screen('app_detail');
  const pending = h.api.flush();
  assert.equal(h.sent.length, 1);
  const signal = h.sent[0].opts.signal;

  h.api.setUser({
    id: 71,
    username: 'usernode-capture-admin',
    isAdmin: true,
    uiTelemetryEligible: false,
  });
  assert.equal(signal.aborted, true, 'identification aborts the synthetic session\'s in-flight send');
  assert.equal(await pending, false);
  assert.equal(h.api.diagnostics().queued, 0);
  assert.equal(h.storageValues.has('ui-telemetry-v1:70'), false,
    'the prior in-flight queue cannot survive an identity change');

  h.api.setUser({
    id: 72,
    username: 'human-admin',
    isAdmin: true,
    uiTelemetryEligible: true,
  });
  h.api.screen('app_detail');
  assert.equal(await h.api.flush(), true);
  assert.equal(h.sent.length, 2, 'a later human session resumes ordinary delivery');
  assert.equal(h.sent[1].body.events[0].screen, 'app_detail');
});

test('a 429 honors Retry-After before the next bounded delivery attempt', async () => {
  const h = clientHarness({ fetchImpl: async (_url, _opts, call) => (
    call === 1
      ? { ok: false, status: 429, headers: { get: (name) => (name === 'retry-after' ? '12' : null) } }
      : { ok: true, status: 202 }
  ) });
  h.api.setUser({ id: 73, username: 'person', uiTelemetryEligible: true });
  h.api.screen('app_detail');
  assert.equal(await h.api.flush(), false);
  assert.equal(await h.api.flush(), false, 'a direct flush cannot bypass the server cooldown');
  h.listeners.get('online')();
  h.elapse(11_999, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 1);
  h.elapse(1, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 2);
});

test('a stalled delivery times out, aborts, and leaves the queue retryable', async () => {
  let capturedSignal;
  const h = clientHarness({ fetchImpl: async (_url, opts, call) => {
    capturedSignal = opts.signal;
    if (call === 1) return new Promise(() => {});
    return { ok: true, status: 202 };
  } });
  h.api.setUser('stalled-user');
  h.api.screen('app_detail');
  const stalled = h.api.flush();
  h.elapse(10_000, true);
  assert.equal(await stalled, false);
  assert.equal(capturedSignal.aborted, true);
  assert.equal(h.api.diagnostics().failedBatches, 1);
  assert.equal(h.api.diagnostics().queued, 1);
  assert.equal(await h.api.flush(), false, 'the timeout backoff cannot be bypassed directly');
  h.elapse(1000);
  assert.equal(await h.api.flush(), true, 'a timed-out request releases the sender for retry');
  assert.equal(h.api.diagnostics().queued, 0);
});

test('boot classification never transmits captured error content and admin views stay silent', async () => {
  const secret = 'https://example.test/?token=private user@example.test stack-line';
  const h = clientHarness({ withDocument: true, boot: {
    errors: [{ step: 'error', message: secret, stack: secret, filename: secret }],
    steps: [{ step: 'start' }],
  } });
  h.api.setUser(9);
  h.documentListeners.get('DOMContentLoaded')();
  await h.api.flush();
  const encoded = JSON.stringify(h.sent[0].body);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('user@example.test'), false);
  assert.ok(h.sent[0].body.events.some((item) => item.kind === 'boot_failure'
    && item.errorCode === 'boot_script_error'));

  const admin = clientHarness({ hash: '#admin/analytics' });
  admin.api.setUser(10);
  assert.equal(admin.api.screen('app_detail'), null);
  assert.equal(admin.api.attempt('app_detail_load', { screen: 'app_detail' }), null);
  assert.equal(admin.api.diagnostics().queued, 0);
});

test('collector is same-origin-only and the admin report is protected', async (t) => {
  let express;
  try { express = require('express'); } catch { return t.skip('express is not installed'); }
  let connects = 0;
  const fakePool = {
    connect: async () => {
      connects += 1;
      return ({
      async query(sql) {
        if (/RETURNING id/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
        return { rowCount: 1, rows: [] };
      },
      release() {},
      });
    },
    async query() { throw new Error('admin aggregate must stay behind its gate'); },
  };
  const { uiTelemetryRoutes } = require('../src/routes/ui-telemetry');
  const app = express();
  app.use((req, _res, next) => {
    const fixture = req.get('x-test-user');
    req.user = fixture === 'capture'
      ? { id: 2, username: 'usernode-capture-admin', isAdmin: true }
      : fixture === 'human-admin'
        ? { id: 3, username: 'human-admin', isAdmin: true }
        : { id: 1, username: 'human-member', isAdmin: false };
    next();
  });
  app.use(uiTelemetryRoutes({}, { pool: fakePool }));
  const server = await new Promise((resolve) => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const payload = batch([event()]);
  const cross = await fetch(`${base}/api/ui-telemetry/batch`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify(payload),
  });
  assert.equal(cross.status, 403);
  const same = await fetch(`${base}/api/ui-telemetry/batch`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(payload),
  });
  assert.equal(same.status, 202);
  const beforeSynthetic = connects;
  const synthetic = await fetch(`${base}/api/ui-telemetry/batch`, {
    method: 'POST', headers: {
      'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-test-user': 'capture',
    }, body: JSON.stringify(payload),
  });
  assert.equal(synthetic.status, 202);
  assert.equal((await synthetic.json()).discarded, true);
  assert.equal(connects, beforeSynthetic, 'the collector never inserts a synthetic account batch');
  const humanAdmin = await fetch(`${base}/api/ui-telemetry/batch`, {
    method: 'POST', headers: {
      'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-test-user': 'human-admin',
    }, body: JSON.stringify(payload),
  });
  assert.equal(humanAdmin.status, 202);
  assert.equal(connects, beforeSynthetic + 1, 'a human admin remains eligible outside the admin console');
  const oversized = await fetch(`${base}/api/ui-telemetry/batch`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ padding: 'x'.repeat(33 * 1024) }),
  });
  assert.equal(oversized.status, 413, 'the collector rejects a body above its 32 KiB transport bound');
  assert.equal((await fetch(`${base}/api/admin/analytics/ui-failures`)).status, 403);
});

test('server eligibility excludes only fixed service handles, including paired shots', async () => {
  for (const username of [
    'usernode-capture', 'usernode-capture-admin',
    'usernode-shots-full-admin', 'staging-demo-user',
  ]) {
    assert.equal(telemetry.isEligibleUser({ id: 1, username, isAdmin: true }), false, username);
  }
  assert.equal(telemetry.isEligibleUser({ id: 2, username: 'human-admin', isAdmin: true }), true);
  assert.equal(telemetry.isEligibleUser({ id: 3, username: 'human-view-admin', isAdmin: true }), true);

  let writes = 0;
  const pool = { query: async () => { writes += 1; return { rows: [] }; } };
  await telemetry.recordServerFailure(pool, {
    user: { id: 4, username: 'usernode-capture' }, get() { return null; },
  }, { screen: 'report_dialog', action: 'content_report_submit', status: 404,
    message: 'Target unavailable' });
  assert.equal(writes, 0, 'expected report refusals from capture users are discarded too');

  const authSource = fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(authSource,
    /uiTelemetryEligible:\s*await uiTelemetry\.isRecordable\(pool, req\.user\)/,
    '/api/auth/me exposes the server-owned eligibility decision, objections included (#3369)');
  const service = fs.readFileSync(path.join(__dirname, '../src/services/ui-telemetry.js'), 'utf8');
  assert.match(service, /async function isRecordable\(pool, user\) \{\s*if \(!isEligibleUser\(user\)\) return false;/,
    'a service identity stays ineligible before any list is read');
  assert.match(appSource, /detail: \{ user: App\.user, verifiedSession: true \}/,
    'session reconciliation identifies its authoritative /api/auth/me result');
  assert.match(appSource,
    /detail: \{ user: App\.user, verifiedSession: !App\._sessionFromSnapshot \}/,
    'snapshot publication stays explicitly unverified even when it cached an eligibility flag');
});

test('telemetry limiter still applies 60/min to human full admins and anonymous traffic', async (t) => {
  let express;
  try { express = require('express'); } catch { return t.skip('express is not installed'); }
  const { uiTelemetryLimiter } = require('../src/middleware/rate-limits');
  const app = express();
  app.use((req, _res, next) => {
    if (req.get('x-test-user') === 'admin') {
      req.user = { id: 990000001, username: 'human-full-admin', canAdminWrite: true };
    } else if (req.get('x-test-user') === 'capture') {
      req.user = { id: 990000002, username: 'usernode-capture-admin', canAdminWrite: true };
    }
    next();
  });
  app.post('/limited', uiTelemetryLimiter, (_req, res) => res.sendStatus(204));
  const server = await new Promise((resolve) => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/limited`;
  const post = (fixture) => fetch(url, {
    method: 'POST', headers: fixture ? { 'x-test-user': fixture } : {},
  });

  for (let i = 0; i < 60; i += 1) assert.equal((await post('admin')).status, 204);
  assert.equal((await post('admin')).status, 429, 'canAdminWrite does not exempt a human admin');
  for (let i = 0; i < 60; i += 1) assert.equal((await post()).status, 204);
  assert.equal((await post()).status, 429, 'anonymous traffic retains its IP limit');
  for (let i = 0; i < 65; i += 1) assert.equal((await post('capture')).status, 204,
    'only an authenticated fixed service identity is skipped');
});

test('moderation telemetry is limited to the report dialog endpoint', async (t) => {
  let express;
  try { express = require('express'); } catch { return t.skip('express is not installed'); }
  const moderation = require('../src/services/moderation');
  const originalSubmit = moderation.submitReport;
  const originalRecord = telemetry.recordServerFailure;
  const recorded = [];
  moderation.submitReport = async () => { throw new moderation.ModerationError(404, 'Target unavailable'); };
  telemetry.recordServerFailure = async (_pool, req, detail) => { recorded.push({ path: req.path, detail }); };
  t.after(() => { moderation.submitReport = originalSubmit; telemetry.recordServerFailure = originalRecord; });
  delete require.cache[require.resolve('../src/routes/moderation')];
  const { moderationRoutes } = require('../src/routes/moderation');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use(moderationRoutes({}, { pool: { query: async () => ({ rows: [] }) } }));
  const server = await new Promise((resolve) => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await post('/api/reports')).status, 404);
  assert.equal((await post('/api/apps/demo/report')).status, 404);
  assert.deepEqual(recorded.map((item) => item.path), ['/api/reports']);
});

test('real PostgreSQL insert is idempotent and aggregates matched lifecycle identities',
  { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL for PostgreSQL coverage' }, async (t) => {
    let Pool;
    try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
    const table = await pool.query("SELECT to_regclass('public.events') AS name");
    if (!table.rows[0].name) {
      await pool.end();
      return t.skip('schema.sql has not been applied');
    }
    // TEST_DATABASE_URL is this track's disposable database. Remove telemetry
    // left by an interrupted earlier run so window-wide aggregate assertions
    // remain deterministic.
    await pool.query("DELETE FROM events WHERE event_type IN ('ui_experience','ui_telemetry_delivery')");
    const suffix = `${process.pid}-${Date.now()}`;
    const user = (await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id',
      [`ui-telemetry-${suffix}`, 'test']
    )).rows[0];
    const app = (await pool.query(
      'INSERT INTO apps (name, slug, created_by) VALUES ($1, $2, $3) RETURNING id, slug',
      ['UI telemetry test', `ui-telemetry-${suffix}`, user.id]
    )).rows[0];
    let other = null;
    let serviceUser = null;
    let createdServiceUser = false;
    t.after(async () => {
      if (other) {
        await pool.query('DELETE FROM events WHERE user_id = $1', [other.id]);
        await pool.query('DELETE FROM users WHERE id = $1', [other.id]);
      }
      if (serviceUser) {
        await pool.query("DELETE FROM events WHERE user_id = $1 AND event_type IN ('ui_experience','ui_telemetry_delivery')", [serviceUser.id]);
        if (createdServiceUser) await pool.query('DELETE FROM users WHERE id = $1', [serviceUser.id]);
      }
      await pool.query('DELETE FROM events WHERE user_id = $1', [user.id]);
      await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
      await pool.end();
    });

    const reportAttempt = id('attempt');
    const waitingAttempt = id('attempt');
    const cancelledAttempt = id('attempt');
    const reportVisit = id('visit');
    const records = [
      event({ visitId: reportVisit, screen: 'report_dialog', appSlug: app.slug }),
      event({ kind: 'action_attempt', screen: 'report_dialog', action: 'content_report_submit',
        attemptId: reportAttempt, appSlug: app.slug, build: 'abcdef1', sequence: 2 }),
      event({ kind: 'action_outcome', screen: 'report_dialog', action: 'content_report_submit',
        attemptId: reportAttempt, outcome: 'failure', errorCode: 'not_found', durationMs: 250,
        appSlug: app.slug, build: 'abcdef1', sequence: 3 }),
      event({ kind: 'action_attempt', screen: 'feedback_dialog', action: 'feedback_submit',
        attemptId: waitingAttempt, sequence: 4 }),
      event({ kind: 'loading_timeout', screen: 'feedback_dialog', action: 'feedback_submit',
        attemptId: waitingAttempt, durationMs: 1000, sequence: 5 }),
      event({ kind: 'navigation_abandonment', screen: 'feedback_dialog', action: 'feedback_submit',
        attemptId: waitingAttempt, durationMs: 1500, sequence: 6 }),
      event({ kind: 'action_attempt', screen: 'app_detail', action: 'app_detail_load',
        attemptId: cancelledAttempt, sequence: 7 }),
      event({ kind: 'action_outcome', screen: 'app_detail', action: 'app_detail_load',
        attemptId: cancelledAttempt, outcome: 'cancelled', durationMs: 10, sequence: 8 }),
      event({ visitId: reportVisit, screen: 'report_dialog', appSlug: app.slug, sequence: 9 }),
    ];
    const parsed = telemetry.parseBatch(batch(records, {
      delivery: { failedBatches: 1, droppedEvents: 2 },
    }));
    const first = await telemetry.insertBatch(pool, user.id, parsed);
    const replay = await telemetry.insertBatch(pool, user.id, {
      ...parsed, delivery: { failedBatches: 2, droppedEvents: 3 },
    });
    assert.equal(first.accepted, records.length);
    assert.deepEqual(replay, { accepted: 0, duplicate: true });

    await telemetry.recordServerFailure(pool, {
      user: { id: user.id },
      get(name) {
        if (name === 'x-ui-visit-id') return records[0].visitId;
        if (name === 'x-ui-attempt-id') return reportAttempt;
        return null;
      },
    }, { screen: 'report_dialog', action: 'content_report_submit', status: 404, message: 'Target unavailable: private text' });
    const storedServer = await pool.query(
      "SELECT metadata FROM events WHERE user_id = $1 AND event_type = 'ui_experience' AND metadata->>'kind' = 'server_failure'",
      [user.id]
    );
    assert.equal(storedServer.rows.length, 1);
    assert.equal(JSON.stringify(storedServer.rows[0].metadata).includes('private text'), false);
    assert.equal(storedServer.rows[0].metadata.errorCode, 'target_unavailable');

    const oldAttempt = id('attempt');
    await pool.query(
      `INSERT INTO events (user_id, event_type, metadata, created_at) VALUES
       ($1, 'ui_experience', $2::jsonb, NOW() - INTERVAL '20 days'),
       ($1, 'ui_experience', $3::jsonb, NOW())`,
      [user.id,
        JSON.stringify({ eventId: id('event'), visitId: id('visit'), attemptId: oldAttempt,
          kind: 'action_attempt', screen: 'app_detail', action: 'app_detail_load', sequence: 1 }),
        JSON.stringify({ eventId: id('event'), visitId: id('visit'), attemptId: oldAttempt,
          kind: 'action_outcome', screen: 'app_detail', action: 'app_detail_load',
          outcome: 'success', durationMs: 20, sequence: 2 })]
    );

    const existingService = await pool.query(
      "SELECT id FROM users WHERE LOWER(username) = 'usernode-capture' LIMIT 1"
    );
    if (existingService.rows[0]) {
      serviceUser = existingService.rows[0];
    } else {
      serviceUser = (await pool.query(
        "INSERT INTO users (username, password) VALUES ('usernode-capture', 'test') RETURNING id"
      )).rows[0];
      createdServiceUser = true;
    }
    await pool.query(
      `INSERT INTO events (user_id, event_type, metadata) VALUES
       ($1, 'ui_experience', $2::jsonb),
       ($1, 'ui_telemetry_delivery', $3::jsonb)`,
      [serviceUser.id,
        JSON.stringify({ eventId: id('event'), visitId: id('visit'), kind: 'screen_visit',
          screen: 'app_detail', sequence: 1 }),
        JSON.stringify({ batchId: id('batch'), submitted: 1, accepted: 1,
          failedBatches: 0, droppedEvents: 0 })]
    );

    // Navigation shares the event type (#3369) but is not one of the seven
    // journeys: it must not move the failure report's visits or screens.
    await pool.query(
      `INSERT INTO events (user_id, event_type, metadata) VALUES
       ($1, 'ui_experience', $2::jsonb), ($1, 'ui_experience', $3::jsonb)`,
      [user.id,
        JSON.stringify({ eventId: id('event'), visitId: id('visit'), kind: 'screen_visit',
          screen: 'home', via: 'own', sequence: 1 }),
        JSON.stringify({ eventId: id('event'), visitId: id('visit'), kind: 'screen_hidden',
          screen: 'home', sequence: 2 })]
    );

    const report = await telemetry.aggregate(pool, { days: 14 });
    assert.equal(report.screens.some((row) => row.screen === 'home'), false,
      'navigation never appears in the failure report');
    assert.equal(report.coverage.receipts, 1, 'batch replay does not duplicate its receipt');
    assert.equal(report.overview.visits, 2,
      'historic service-identity observations are excluded from the aggregate');
    assert.equal(report.coverage.acceptedRecords, records.length);
    assert.equal(report.coverage.failedBatchesRecovered, 2,
      'a retry updates delivery loss evidence without duplicating the receipt');
    assert.equal(report.coverage.droppedRecordsReported, 3);
    assert.equal(report.overview.attempts, 3);
    assert.equal(report.overview.terminal_attempts, 2);
    assert.equal(report.overview.unresolved_attempts, 1);
    assert.equal(report.overview.orphan_terminal_attempts, 1,
      'a terminal whose attempt preceded the window is reported, never subtracted');
    assert.equal(report.overview.failures, 1, 'correlated server/client failures count once');
    assert.equal(report.overview.cancellations, 1);
    const reportJourney = report.journeys.find((row) => row.action === 'content_report_submit');
    assert.equal(reportJourney.attempts, 1);
    assert.equal(reportJourney.failures, 1);
    assert.equal(reportJourney.failure_denominator, 1);
    assert.equal(reportJourney.failure_rate, 100);
    assert.equal(report.screens.find((row) => row.screen === 'report_dialog').visits, 2);
    assert.deepEqual(report.errors.map((row) => row.error_code), ['target_unavailable'],
      'the correlated server classification supersedes the generic client 404');
    assert.equal(report.contexts[0].app_slug, app.slug);

    other = (await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id',
      [`ui-telemetry-other-${suffix}`, 'test']
    )).rows[0];
    const otherResult = await telemetry.insertBatch(pool, other.id, parsed);
    assert.equal(otherResult.accepted, records.length,
      'opaque event and batch ids are idempotent per user, not globally');
  });

test('admin surface explains coverage and non-failure signals', () => {
  const source = fs.readFileSync(path.join(__dirname,
    '../frontend/src/features/admin/admin-analytics.tsx'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '../src/services/ui-telemetry.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /id="ui-failures"/);
  assert.match(source, /No delivery coverage/);
  assert.match(service, /not zero failures/);
  assert.match(source, /success.*failed outcomes/i);
  assert.match(source, /Neither signal alone establishes frustration/);
  assert.match(server, /req\.path === '\/api\/ui-telemetry\/batch'\) return next\(\)/,
    'the global parser must leave the body for the stricter collector limit');
});

test('client reports navigation once per change, with how they got there, a hidden mark and returns', async () => {
  const { api, sent, documentListeners, document, elapse } = clientHarness({ withDocument: true });
  api.setUser({ id: 42, uiTelemetryEligible: true }, true);
  api.navigate('home');
  api.navigate('home');
  api.navigate('project', { appSlug: 'run-club' });
  api.navigate('project', { appSlug: 'run-club' });
  api.markNextVia('nudged');
  api.navigate('messages');
  api.navigate('discover', { via: 'back' });
  api.navigate('not-a-screen');
  document.visibilityState = 'hidden';
  documentListeners.get('visibilitychange')();
  elapse(5 * 60 * 1000);
  document.visibilityState = 'visible';
  documentListeners.get('visibilitychange')();
  document.visibilityState = 'hidden';
  documentListeners.get('visibilitychange')();
  elapse(31 * 60 * 1000);
  document.visibilityState = 'visible';
  documentListeners.get('visibilitychange')();
  await api.flush(false);
  elapse(120_000, true);
  await new Promise((resolve) => setImmediate(resolve));
  await api.flush(false);
  const events = sent.flatMap((b) => b.body.events);
  assert.ok(sent.every((b) => b.body.schemaVersion === 2), 'navigation-capable clients send version 2');
  assert.deepEqual(events.map((e) => [e.kind, e.screen, e.via || null, e.appSlug || null]), [
    ['screen_visit', 'home', 'own', null],
    ['screen_visit', 'project', 'own', 'run-club'],
    ['screen_visit', 'messages', 'nudged', null],
    ['screen_visit', 'discover', 'back', null],
    ['screen_hidden', 'discover', null, null],
    ['screen_hidden', 'discover', null, null],
    ['screen_visit', 'discover', 'returned', null],
  ], 'a short hide is not a return; a hide of 30 minutes or more is');
  const sequences = events.map((e) => e.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), 'the order of the path is kept');
});

test('a via mark explains only the navigation right after it', async () => {
  const { api, sent, elapse } = clientHarness();
  api.setUser({ id: 43, uiTelemetryEligible: true }, true);
  api.markNextVia('nudged');
  api.navigate('messages');
  api.markNextVia('handed');
  elapse(6000);
  api.navigate('project', { appSlug: 'run-club' });
  await api.flush(false);
  assert.deepEqual(sent.flatMap((b) => b.body.events).map((e) => e.via), ['nudged', 'own'],
    'a stale mark does not mislabel a later step');
});

// ── Browser languages, for choosing which languages Homeroom ships (#3659) ──

test('the browser language is the most preferred Accept-Language, kept to language, script and region', () => {
  for (const [header, expected] of [
    ['es-MX,es;q=0.9,en;q=0.8', 'es-MX'],
    ['en;q=0.5, fr-CA;q=0.9', 'fr-CA'],
    ['zh-Hant-TW', 'zh-Hant-TW'],
    ['EN-us', 'en-US'],
    ['es-419', 'es-419'],
    ['de-DE-u-co-phonebk', 'de-DE'],
    ['fr;q=0, de;q=0.3', 'de'],
    ['*', null], ['', null], [undefined, null], ['not a language!', null],
    [`en,${'x'.repeat(600)}`, null],
  ]) {
    assert.equal(telemetry.browserLanguage(header), expected, String(header).slice(0, 30));
  }
});

test('the collector notes the browser language on a shell start and nowhere else', async (t) => {
  let express;
  try { express = require('express'); } catch { return t.skip('express is not installed'); }
  const stored = [];
  const fakePool = {
    connect: async () => ({
      async query(sql, params) {
        if (/VALUES \(\$1, \(SELECT id FROM apps/.test(sql)) stored.push(JSON.parse(params[3]));
        return { rowCount: 1, rows: [{ id: 1 }] };
      },
      release() {},
    }),
    async query() { throw new Error('the language count must stay behind its gate'); },
  };
  const { uiTelemetryRoutes } = require('../src/routes/ui-telemetry');
  const app = express();
  app.use((req, _res, next) => {
    req.user = req.get('x-test-user') === 'capture'
      ? { id: 2, username: 'usernode-capture-admin', isAdmin: true }
      : { id: 1, username: 'human-member', isAdmin: false };
    next();
  });
  app.use(uiTelemetryRoutes({}, { pool: fakePool }));
  const server = await new Promise((resolve) => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (headers = {}) => fetch(`${base}/api/ui-telemetry/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(batch([
      event({ screen: 'shell_boot' }),
      event({ screen: 'home', via: 'own', sequence: 2 }),
    ], { schemaVersion: 2 })),
  });

  assert.equal((await send({ 'accept-language': 'es-MX,es;q=0.9,en;q=0.8' })).status, 202);
  assert.deepEqual(stored.map((metadata) => [metadata.screen, metadata.language]),
    [['shell_boot', 'es-MX'], ['home', undefined]]);
  // The client sends no language of its own: the vocabulary is unchanged.
  assert.throws(() => telemetry.parseBatch(batch([{ ...event({ screen: 'shell_boot' }), language: 'es-MX' }])),
    /unsupported field: language/);

  stored.length = 0;
  assert.equal((await send({ 'accept-language': '*' })).status, 202);
  assert.deepEqual(stored.map((metadata) => 'language' in metadata), [false, false], 'nothing usable, nothing stored');

  stored.length = 0;
  const synthetic = await send({ 'accept-language': 'es-MX', 'x-test-user': 'capture' });
  assert.equal((await synthetic.json()).discarded, true);
  assert.deepEqual(stored, [], 'a service identity is counted under no language');

  assert.equal((await fetch(`${base}/api/admin/analytics/browser-languages`)).status, 403,
    'the count is for admins');
});

test('real PostgreSQL counts each person once, under the language of their latest shell start',
  { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL for PostgreSQL coverage' }, async (t) => {
    let Pool;
    try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
    const table = await pool.query("SELECT to_regclass('public.events') AS name");
    if (!table.rows[0].name) {
      await pool.end();
      return t.skip('schema.sql has not been applied');
    }
    await pool.query("DELETE FROM events WHERE event_type IN ('ui_experience','ui_telemetry_delivery')");
    const suffix = `${process.pid}-${Date.now()}`;
    const person = async (name, admin = false) => (await pool.query(
      'INSERT INTO users (username, password, is_admin) VALUES ($1, $2, $3) RETURNING id',
      [`ui-language-${name}-${suffix}`, 'test', admin]
    )).rows[0];
    const ana = await person('ana');
    const ben = await person('ben');
    const cho = await person('cho');
    const admin = await person('admin', true);
    t.after(async () => {
      for (const user of [ana, ben, cho, admin]) {
        await pool.query('DELETE FROM events WHERE user_id = $1', [user.id]);
        await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
      }
      await pool.end();
    });
    const start = (minutesAgo) => telemetry.parseBatch(batch([
      event({ screen: 'shell_boot', occurredAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() }),
      event({ screen: 'home', via: 'own', sequence: 2 }),
    ], { schemaVersion: 2 }));
    await telemetry.insertBatch(pool, ana.id, start(30), { language: 'en-US' });
    await telemetry.insertBatch(pool, ana.id, start(5), { language: 'es-MX' });
    await telemetry.insertBatch(pool, ben.id, start(10), { language: 'es-MX' });
    await telemetry.insertBatch(pool, cho.id, start(10), { language: 'ja' });
    await telemetry.insertBatch(pool, cho.id, start(2));
    await telemetry.insertBatch(pool, admin.id, start(1), { language: 'de' });
    // Older than any window read below.
    await pool.query(
      `UPDATE events SET created_at = NOW() - INTERVAL '40 days'
        WHERE user_id = $1 AND metadata->>'language' = 'ja'`, [cho.id]);

    assert.deepEqual(await telemetry.browserLanguages(pool, { days: 30 }), {
      days: 30, people: 2, languages: [{ language: 'es-MX', people: 2 }],
    }, 'Ana counts once, under her latest; Cho’s only language is outside the window; the admin is left out');
    assert.deepEqual((await telemetry.browserLanguages(pool, { days: 90, includeAdmins: true })).languages, [
      { language: 'es-MX', people: 2 }, { language: 'de', people: 1 }, { language: 'ja', people: 1 },
    ]);
  });
