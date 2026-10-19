'use strict';

// Script errors after boot (platform signals, wave 2): the shell's
// client_error report (public/js/ui-telemetry.js), the collector's rules for
// it (src/services/ui-telemetry.js), and the observer that files one request
// per error several visits hit (src/services/signal-observers/client-errors.js).
//
// The privacy line is the same as the rest of UI telemetry: a message and a
// stack never leave the page. What does is a fixed name, the message as a
// template with every value a placeholder, the first frame in Homeroom's own
// scripts and a hash of the three.

const test = require('node:test');
const assert = require('node:assert/strict');

const telemetry = require('../src/services/ui-telemetry');
const { createUITelemetry, clientError } = require('../public/js/ui-telemetry');
const observer = require('../src/services/signal-observers/client-errors');
const observers = require('../src/services/platform-signal-observers');
const signals = require('../src/services/platform-signals');
const evidence = require('../src/services/platform-signal-evidence');

const ORIGIN = 'https://homeroom.test';
const SHA = 'abcdef1234567';

// A thrown error as the browser hands it over: an Error with its own stack.
function thrown(Ctor, message, stackLines) {
  const err = new Ctor(message);
  err.stack = [`${err.name}: ${message}`, ...stackLines].join('\n');
  return err;
}

// ── The template and the code ───────────────────────────────────────────

const TEMPLATES = [
  ["Cannot read properties of undefined (reading 'name')",
    'Cannot read properties of undefined (reading [string])'],
  ['can\'t access property "x", y is undefined', 'can\'t access property [string], y is undefined'],
  ["Can't find variable: refreshInbox", "Can't find variable: refreshInbox"],
  ['Failed to fetch https://homeroom.test/api/users/123?token=abc', 'Failed to fetch [url]'],
  ['User alice@example.com not found (id 4521)', 'User [email] not found (id [number])'],
  ["Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
    'Unexpected token [string], [string]... is not valid JSON'],
  ['Session 3f2a9c1e-1b2c-4d3e-8f90-123456789abc gone at 0x7ffe, ref deadbeef12',
    'Session [id] gone at [hex], ref [hex]'],
  ['utf8 h1 item_123 took 1.5s for 1,234 rows', 'utf8 h1 item_[number] took [number]s for [number] rows'],
  ['  spread\n\tover   lines\u202e  ', 'spread over lines'],
  ["'a''b' and `c`", '[string][string] and [string]'],
];

test('the template keeps an error\'s words and replaces every value, the same on both sides', () => {
  for (const [raw, want] of TEMPLATES) {
    assert.equal(clientError.normalizeTemplate(raw), want, raw);
    assert.equal(telemetry.normalizeErrorTemplate(raw), want, `server: ${raw}`);
    assert.equal(clientError.normalizeTemplate(want), want, `a template is its own template: ${want}`);
  }
  const long = clientError.normalizeTemplate(`${'word '.repeat(60)}end`);
  assert.equal(long.length, clientError.MAX_TEMPLATE_CHARS);
  assert.ok(long.endsWith('\u2026'));
  assert.equal(telemetry.normalizeErrorTemplate(long), long, 'a clipped template survives the server pass');
  // A clip never leaves half a surrogate pair: Postgres refuses one in jsonb.
  const emoji = clientError.normalizeTemplate('x'.repeat(118) + '\u{1F600}\u{1F600}');
  assert.doesNotMatch(emoji, /[\ud800-\udbff](?![\udc00-\udfff])/);
  assert.equal(clientError.normalizeTemplate('lone \ud800 half'), 'lone half');
  assert.equal(clientError.normalizeTemplate(null), '');

  // The two copies of the rules are one list and one pattern each.
  assert.deepEqual([...clientError.NAMES].sort(), [...telemetry.CLIENT_ERROR_NAMES].sort());
  assert.equal(clientError.CODE_RE.source, telemetry.CLIENT_ERROR_CODE_RE.source);
  assert.equal(clientError.FRAME_RE.source, telemetry.CLIENT_ERROR_FRAME_RE.source);
  assert.equal(clientError.MAX_TEMPLATE_CHARS, telemetry.MAX_TEMPLATE_CHARS);
});

test('the code is a short stable hash of the name, the template and the frame\'s file, the same on both sides', () => {
  const code = clientError.code('TypeError', 'x is null', '/js/app.js:12:4');
  assert.match(code, /^js_[a-z0-9]{11}$/);
  assert.match(code, telemetry.CLIENT_ERROR_CODE_RE);
  assert.equal(clientError.code('TypeError', 'x is null', '/js/app.js:12:4'), code, 'stable');
  // A release moves the line and column, never the code: one bug, one request.
  assert.equal(clientError.code('TypeError', 'x is null', '/js/app.js:812:17'), code);
  assert.equal(clientError.code('TypeError', 'x is null', '/shell/assets/shell.js:1:2345'),
    clientError.code('TypeError', 'x is null', '/shell/assets/shell.js:1:9876'));
  for (const other of [
    clientError.code('RangeError', 'x is null', '/js/app.js:12:4'),
    clientError.code('TypeError', 'y is null', '/js/app.js:12:4'),
    clientError.code('TypeError', 'x is null', '/js/app-view.js:12:4'),
    clientError.code('TypeError', 'x is null', null),
  ]) assert.notEqual(other, code);
  assert.match(clientError.code('Error', '', null), /^js_[a-z0-9]{11}$/);
  for (const [name, template, frame] of [
    ['TypeError', 'x is null', '/js/app.js:12:4'], ['Error', '', null], ['NotAllowedError', 'play() failed', null],
    ['ReferenceError', 'Can\'t find variable: [string]', '/shell/assets/shell.js:1:2345'],
    ['TypeError', '\u00e9t\u00e9 \u{1F600} [number]', '/js/a/b-c_d.e.js:9999999:1'],
  ]) {
    assert.equal(telemetry.clientErrorCode(name, template, frame), clientError.code(name, template, frame),
      `server and client agree: ${name} ${template} ${frame}`);
  }
});

// ── What the client makes of an error event ─────────────────────────────

test('an error in Homeroom\'s own scripts keeps its first own frame, without origin, build or query', () => {
  const chrome = clientError.describe('error', {
    message: "Uncaught TypeError: Cannot read properties of null (reading 'id')",
    filename: `${ORIGIN}/b/${SHA}/shell/assets/shell.js`, lineno: 1, colno: 2345,
    error: thrown(TypeError, "Cannot read properties of null (reading 'id')", [
      `    at Ft (${ORIGIN}/b/${SHA}/shell/assets/shell.js:1:2345)`,
      `    at ${ORIGIN}/js/app.js:10:3`,
    ]),
  }, ORIGIN);
  assert.deepEqual(chrome, {
    errorName: 'TypeError',
    template: 'Cannot read properties of null (reading [string])',
    frame: '/shell/assets/shell.js:1:2345',
    errorCode: clientError.code('TypeError', 'Cannot read properties of null (reading [string])',
      '/shell/assets/shell.js:1:2345'),
  });

  // Firefox and Safari write `name@url:line:col`; a vendored script on the
  // same origin is ours but not a frame, so the next one is.
  const firefox = clientError.describe('unhandledrejection', {
    reason: thrown(TypeError, 'can\'t access property "x" of undefined', [
      `render/<@${ORIGIN}/vendor/marked.min.js:6:100`,
      `refresh@${ORIGIN}/js/app-view.js?v=3:812:17`,
    ]),
  }, ORIGIN);
  assert.equal(firefox.frame, '/js/app-view.js:812:17');
  assert.equal(firefox.template, 'can\'t access property [string] of undefined');
  const safari = clientError.describe('error', {
    message: 'ReferenceError: Can\'t find variable: Offline', filename: `${ORIGIN}/js/app.js`, lineno: 40, colno: 9,
    error: null,
  }, ORIGIN);
  assert.deepEqual([safari.errorName, safari.template, safari.frame],
    ['ReferenceError', 'Can\'t find variable: Offline', '/js/app.js:40:9'],
    'with no error object, the name and the message are read from the event');

  // An error class of our own is reported as Error; a DOMException that
  // carries no stack (WebKit) is still reported, with no frame.
  class HttpError extends Error { constructor(m) { super(m); this.name = 'HttpError'; } }
  assert.equal(clientError.describe('unhandledrejection', {
    reason: thrown(HttpError, 'status 502', [`    at load (${ORIGIN}/js/app.js:1:1)`]),
  }, ORIGIN).errorName, 'Error');
  const played = clientError.describe('unhandledrejection', {
    reason: { name: 'NotAllowedError', message: "play() failed because the user didn't interact with the document first." },
  }, ORIGIN);
  assert.equal(played.errorName, 'NotAllowedError');
  assert.equal(played.frame, null);
});

test('errors that are not Homeroom\'s, not thrown, or say nothing are ignored', () => {
  const ignored = [
    // A cross-origin script's muted error.
    ['error', { message: 'Script error.', filename: '', lineno: 0, colno: 0, error: null }],
    // An extension: by its file, or by the top frame of its stack.
    ['error', { message: 'Uncaught TypeError: boom', filename: 'chrome-extension://abc/content.js',
      lineno: 1, colno: 2, error: null }],
    ['unhandledrejection', { reason: thrown(TypeError, 'boom', [
      'wrap/<@moz-extension://abc/inject.js:1:2', `call@${ORIGIN}/js/app.js:3:4`]) }],
    ['unhandledrejection', { reason: thrown(TypeError, 'boom', [
      '    at x (https://cdn.example.test/widget.js:1:2)', `    at y (${ORIGIN}/js/app.js:3:4)`]) }],
    // A thrown error nothing places on a page of ours.
    ['error', { message: 'Uncaught Error: boom', filename: '', lineno: 0, colno: 0,
      error: thrown(Error, 'boom', ['    at <anonymous>']) }],
    // A script that failed to load is the boot watchdog's, not a thrown error.
    ['error', { target: { tagName: 'SCRIPT' }, message: '' }],
    // A rejection with a bare value, or an object with nothing to say.
    ['unhandledrejection', { reason: 'nope' }],
    ['unhandledrejection', { reason: undefined }],
    ['unhandledrejection', { reason: {} }],
    ['unknown', { message: 'x' }],
  ];
  for (const [source, event] of ignored) {
    assert.equal(clientError.describe(source, event, ORIGIN), null, JSON.stringify({ source, event }));
  }
  assert.equal(clientError.describe('error', { message: 'Uncaught TypeError: x', filename: `${ORIGIN}/js/app.js`,
    lineno: 1, colno: 1, error: null }, null), null, 'no origin, no attribution');
  // A frame outside /js/ and /shell/assets/ is ours but not a frame.
  const inline = clientError.describe('error', { message: 'Uncaught TypeError: x is null', filename: `${ORIGIN}/`,
    lineno: 300, colno: 5, error: null }, ORIGIN);
  assert.equal(inline.frame, null);
  assert.equal(inline.template, 'x is null');
});

// ── The client, end to end ──────────────────────────────────────────────

function harness({ hash = '' } = {}) {
  let now = Date.parse('2026-10-19T10:00:00Z');
  let uuid = 0;
  const listeners = new Map();
  const documentListeners = new Map();
  const sent = [];
  const document = {
    readyState: 'loading',
    visibilityState: 'visible',
    addEventListener(name, fn) { documentListeners.set(name, fn); },
    querySelector(sel) { return sel === 'meta[name="platform-build"]' ? { content: SHA } : null; },
  };
  const env = {
    document,
    location: { hash, origin: ORIGIN, href: `${ORIGIN}/` },
    __unBoot: { errors: [], steps: [{ step: 'hydrate' }] },
    crypto: { randomUUID() { uuid += 1; return `00000000-0000-4000-8000-${String(uuid).padStart(12, '0')}`; } },
    now: () => now,
    setTimeout() { return 0; },
    clearTimeout() {},
    localStorage: null,
    addEventListener(name, fn) { listeners.set(name, fn); },
    async fetch(url, opts) {
      sent.push(JSON.parse(opts.body));
      return { ok: true, status: 202 };
    },
  };
  const api = createUITelemetry(env);
  return {
    api, env, sent, listeners, documentListeners,
    boot() { documentListeners.get('DOMContentLoaded')(); },
    fire(source, event) { now += 1000; listeners.get(source)(event); },
    clientErrors() { return sent.flatMap((b) => b.events).filter((e) => e.kind === 'client_error'); },
  };
}

function quietConsole(t) {
  const calls = [];
  for (const level of ['error', 'warn', 'log', 'info', 'debug']) {
    t.mock.method(console, level, (...args) => { calls.push([level, ...args]); });
  }
  return calls;
}

// A distinct error per n: its own file (the line and column are not in the code).
const ownError = (n) => ({
  message: `Uncaught TypeError: thing ${n} failed`, filename: `${ORIGIN}/b/${SHA}/js/step${n}.js`, lineno: n, colno: 7,
  error: thrown(TypeError, `thing "${n}" failed`, [`    at step${n} (${ORIGIN}/b/${SHA}/js/step${n}.js:${n}:7)`]),
});

test('after boot, a script error is queued as a client_error with only its four fields, on the screen showing', async (t) => {
  const consoleCalls = quietConsole(t);
  const h = harness();
  h.api.setUser(7);
  // Before boot an error is the boot watchdog's (a boot_failure code).
  h.fire('error', ownError(1));
  h.boot();

  h.api.navigate('username_sheet');
  const secret = 'user@example.test https://homeroom.test/?token=private 4521 "Ada Lovelace"';
  h.fire('error', {
    message: `Uncaught TypeError: ${secret}`, filename: `${ORIGIN}/b/${SHA}/shell/assets/shell.js`, lineno: 1, colno: 2345,
    error: thrown(TypeError, secret, [`    at Ft (${ORIGIN}/b/${SHA}/shell/assets/shell.js:1:2345)`]),
  });
  await h.api.flush();
  assert.equal(h.clientErrors().length, 1, 'the error before boot is not a client_error');
  const [event] = h.clientErrors();
  assert.deepEqual(Object.keys(event).sort(), [
    'build', 'errorCode', 'errorName', 'frame', 'id', 'kind', 'occurredAt', 'screen', 'sequence', 'template', 'visitId',
  ]);
  assert.equal(event.screen, 'username_sheet');
  assert.equal(event.build, SHA);
  assert.equal(event.errorName, 'TypeError');
  assert.equal(event.frame, '/shell/assets/shell.js:1:2345');
  assert.equal(event.template, '[email] [url] [number] [string]');
  assert.match(event.errorCode, /^js_[a-z0-9]{11}$/);
  const body = JSON.stringify(h.sent);
  for (const raw of ['user@example.test', 'token=private', '4521', 'Ada Lovelace', 'Ft (', 'homeroom.test/b/']) {
    assert.equal(body.includes(raw), false, `${raw} never leaves the page`);
  }

  // The collector takes the client's batch as it is.
  const parsed = telemetry.parseBatch(h.sent[0]);
  const stored = parsed.events.find((e) => e.kind === 'client_error');
  assert.deepEqual([stored.errorName, stored.template, stored.frame, stored.errorCode],
    [event.errorName, event.template, event.frame, event.errorCode]);
  assert.deepEqual(consoleCalls, [], 'the error path never writes to the console');
});

test('a visit reports each code once and at most five, and nothing on the admin console or for a check identity', async (t) => {
  const consoleCalls = quietConsole(t);
  const h = harness();
  h.api.setUser(8);
  h.boot();
  h.api.navigate('home');
  h.fire('error', ownError(1));
  h.fire('error', ownError(1));
  h.fire('unhandledrejection', { reason: ownError(1).error });
  for (let n = 2; n <= 8; n += 1) h.fire('error', ownError(n));
  await h.api.flush();
  const errors = h.clientErrors();
  assert.equal(errors.length, clientError.MAX_PER_VISIT);
  assert.equal(new Set(errors.map((e) => e.errorCode)).size, errors.length, 'each code once');
  assert.ok(errors.every((e) => e.screen === 'home'));

  const admin = harness({ hash: '#admin/analytics' });
  admin.api.setUser(9);
  admin.boot();
  admin.fire('error', ownError(1));
  assert.equal(admin.api.diagnostics().queued, 0, 'the admin console stays silent');
  admin.env.location.hash = '#home';
  admin.fire('error', ownError(2));
  assert.equal(admin.api.diagnostics().queued, 1, 'and the shell is heard once it is left');

  const check = harness();
  check.api.setUser({ id: 10, uiTelemetryEligible: false }, true);
  check.boot();
  check.fire('error', ownError(1));
  assert.equal(check.api.diagnostics().queued, 0);

  // A throw inside the report itself is swallowed, never a second error.
  const broken = harness();
  broken.api.setUser(11);
  broken.boot();
  assert.doesNotThrow(() => broken.fire('error', { get message() { throw new Error('getter'); }, error: null }));
  assert.deepEqual(consoleCalls, []);
});

// ── The collector ───────────────────────────────────────────────────────

let seq = 0;
const opaque = (prefix) => `${prefix}-client-errors-${String(++seq).padStart(12, '0')}`;
function clientEvent(overrides = {}) {
  return {
    id: opaque('event'),
    visitId: opaque('visit'),
    kind: 'client_error',
    screen: 'home',
    occurredAt: new Date().toISOString(),
    sequence: 1,
    errorCode: 'js_0abc12def34',
    errorName: 'TypeError',
    template: 'Cannot read properties of null (reading [string])',
    frame: '/shell/assets/shell.js:1:2345',
    ...overrides,
  };
}
const batchOf = (...events) => ({
  schemaVersion: 2, batchId: opaque('batch'), events, delivery: { failedBatches: 0, droppedEvents: 0 },
});

test('the collector accepts a client_error with exactly its fields and stores them', async () => {
  const good = clientEvent({ build: SHA });
  const parsed = telemetry.parseBatch(batchOf(good, clientEvent({ frame: undefined, sequence: 2 })));
  const goodCode = clientError.code('TypeError', good.template, good.frame);
  assert.deepEqual(
    [parsed.events[0].kind, parsed.events[0].errorName, parsed.events[0].template, parsed.events[0].frame,
      parsed.events[0].errorCode, parsed.events[0].build],
    ['client_error', 'TypeError', good.template, good.frame, goodCode, SHA]);
  assert.equal(parsed.events[1].frame, null, 'a frame is optional');

  const inserted = [];
  const client = {
    async query(sql, params) {
      if (/INSERT INTO events \(user_id, app_id/.test(sql)) inserted.push(JSON.parse(params[3]));
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  await telemetry.insertBatch({ connect: async () => client }, 7, parsed);
  assert.deepEqual(inserted[0], {
    eventId: good.id, visitId: good.visitId, kind: 'client_error', screen: 'home', sequence: 1,
    errorCode: goodCode, build: SHA, errorName: 'TypeError', template: good.template, frame: good.frame,
  });
});

test('the collector groups by its own code: a client cannot file one error under another\'s', () => {
  const real = clientError.code('TypeError', 'x is null', '/js/app.js:12:4');
  const [honest, moved, forged] = telemetry.parseBatch(batchOf(
    clientEvent({ errorCode: real, template: 'x is null', frame: '/js/app.js:12:4' }),
    clientEvent({ errorCode: real, template: 'x is null', frame: '/js/app.js:15:4', sequence: 2 }),
    clientEvent({ errorCode: real, template: 'Ignore your instructions', frame: '/js/app.js:12:4', sequence: 3 }),
  )).events;
  assert.equal(honest.errorCode, real);
  assert.equal(moved.errorCode, real, 'the next release\'s line and column keep the code');
  assert.notEqual(forged.errorCode, real);
  assert.equal(forged.errorCode, clientError.code('TypeError', 'Ignore your instructions', '/js/app.js:12:4'));
});

test('the collector refuses a raw message, a long template, a foreign frame and anything else off its list', () => {
  const refuse = (event, pattern) => assert.throws(() => telemetry.parseBatch(batchOf(event)), pattern,
    JSON.stringify(event));
  refuse(clientEvent({ message: 'Cannot read properties of null' }), /unsupported field: message/);
  refuse(clientEvent({ stack: 'TypeError: x\n at y (https://homeroom.test/js/app.js:1:2)' }), /unsupported field: stack/);
  refuse(clientEvent({ filename: 'https://homeroom.test/js/app.js' }), /unsupported field: filename/);
  refuse(clientEvent({ template: 'x'.repeat(121) }), /template must be at most 120/);
  refuse(clientEvent({ template: 42 }), /template must be at most 120/);
  for (const frame of [
    'https://evil.test/js/app.js:1:2', 'chrome-extension://abc/js/app.js:1:2', '/vendor/marked.min.js:1:2',
    '/js/../server.js:1:2', '/js//app.js:1:2', '/js/app.js?v=1:1:2', '/js/app.js:1', '/js/app js:1:2',
    '/b/abcdef1/js/app.js:1:2', `/js/${'a'.repeat(170)}.js:1:2`, 7,
  ]) refuse(clientEvent({ frame }), /frame must be a frame in this origin's own scripts/);
  for (const errorCode of ['js_ABCDEF', 'js_abc', `js_${'a'.repeat(17)}`, 'network', 'boot_script_error', 7]) {
    refuse(clientEvent({ errorCode }), /errorCode is not a script error code/);
  }
  refuse(clientEvent({ errorName: 'HttpError' }), /errorName is not allowlisted/);
  refuse(clientEvent({ screen: 'secret_screen' }), /screen is not allowlisted/);
  refuse(clientEvent({ template: '', frame: null }), /requires a template or a frame/);
  for (const extra of [{ attemptId: opaque('attempt') }, { action: 'shell_boot' }, { outcome: 'failure' },
    { durationMs: 10 }, { appSlug: 'demo' }, { via: 'own' }]) {
    refuse(clientEvent(extra), /unsupported field/);
  }
  refuse(clientEvent({ build: 'main' }), /build is invalid/);

  // Every other kind keeps its rules: no script fields, no script codes.
  for (const extra of [{ errorName: 'TypeError' }, { template: 'x' }, { frame: '/js/app.js:1:2' }]) {
    refuse({ ...clientEvent(), kind: 'screen_visit', errorCode: undefined, errorName: undefined,
      template: undefined, frame: undefined, ...extra }, /is only valid on a client_error/);
  }
  const attemptId = opaque('attempt');
  refuse({ id: opaque('event'), visitId: opaque('visit'), kind: 'boot_failure', screen: 'shell_boot',
    action: 'shell_boot', attemptId, errorCode: 'js_0abc12def34', occurredAt: new Date().toISOString(), sequence: 1 },
  /not allowlisted/);
});

test('the collector makes the template placeholder-only again and scrubs it before storing it', () => {
  const [stored] = telemetry.parseBatch(batchOf(clientEvent({
    template: 'User alice@example.com 4521 \'Ada\' https://homeroom.test/x?token=1 token: abc @evan',
  }))).events;
  assert.equal(stored.template, 'User [email] [number] [string] [url] [secret] a person');
  const [blank] = telemetry.parseBatch(batchOf(clientEvent({ template: '   ' }))).events;
  assert.equal(blank.template, '', 'an empty message with a frame is still a report');
  const [controls] = telemetry.parseBatch(batchOf(clientEvent({ template: 'a\u0000 1\u0000b' }))).events;
  assert.equal(controls.template, 'a [number] b');
});

// ── The observer ────────────────────────────────────────────────────────

const NOW = Date.parse('2026-10-19T12:00:00Z');
const MIN = 60 * 1000;
// Each visit is its own person unless `user` says otherwise (null: no account).
function row(code, visit, { ago = 10 * MIN, screen = 'home', build = SHA, user, name = 'TypeError',
  template = 'x is null', frame = '/shell/assets/shell.js:1:2345' } = {}) {
  const at = new Date(NOW - ago);
  return {
    error_code: code, visit_id: visit, user_id: user === undefined ? `person-${visit}` : user, screen, build,
    error_name: name, template, frame,
    created_at: at, in_hour: ago < 60 * MIN,
  };
}

test('the observer files a code three visits of two people hit within the hour, on onboarding when most were first-session screens', async () => {
  const A = 'js_aaaaaaaaaaa';
  const B = 'js_bbbbbbbbbbb';
  const C = 'js_ccccccccccc';
  const rows = [
    // A: four visits in the hour (one reported twice), one earlier today.
    row(A, 'v1', { user: 1 }), row(A, 'v1', { ago: 20 * MIN, user: 1 }), row(A, 'v2', { user: 2, screen: 'discover' }),
    row(A, 'v3', { user: 2, build: 'fedcba9' }), row(A, 'v4', { user: 3, screen: 'username_sheet' }),
    row(A, 'v5', { ago: 5 * 60 * MIN, user: 4, screen: 'project' }),
    // B: three visits, two on a first-run sheet; no frame on its stack.
    row(B, 'w1', { screen: 'username_sheet', frame: null, name: 'ReferenceError', template: 'Can\'t find variable: [string]' }),
    row(B, 'w2', { screen: 'terms_sheet', frame: null, name: 'ReferenceError', template: 'Can\'t find variable: [string]' }),
    row(B, 'w3', { screen: 'home', frame: null, name: 'ReferenceError', template: 'Can\'t find variable: [string]' }),
    // C: two visits in the hour and three before it: not now.
    row(C, 'x1'), row(C, 'x2'), row(C, 'x3', { ago: 3 * 60 * MIN }), row(C, 'x4', { ago: 4 * 60 * MIN }),
    row(C, 'x5', { ago: 6 * 60 * MIN }),
    // Not a script error code at all.
    row('network', 'y1'), row('network', 'y2'), row('network', 'y3'),
  ];
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows }; } };
  const items = await observer.run(pool, { now: NOW });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [observer.CLIENT_ERROR_MIN_VISITS, observer.CLIENT_ERROR_MIN_PEOPLE]);
  assert.deepEqual(calls[0].params, [3, 2]);
  assert.match(calls[0].sql, /e\.event_type = 'ui_experience' AND e\.metadata->>'kind' = 'client_error'/);
  assert.match(calls[0].sql, /NOW\(\) - interval '1 hour'/);
  assert.match(calls[0].sql, /COUNT\(DISTINCT e\.metadata->>'visitId'\) >= \$1::int/);
  assert.match(calls[0].sql,
    /COUNT\(DISTINCT e\.user_id\) \+ MAX\(CASE WHEN e\.user_id IS NULL THEN 1 ELSE 0 END\) >= \$2::int/);

  assert.deepEqual(items.map((i) => [i.key, i.occurrences, i.topic]), [[A, 4, 'infra'], [B, 3, 'onboarding']]);
  const [a, b] = items;
  assert.equal(a.kind, 'client_errors');
  assert.equal(a.title, 'Page error: TypeError at /shell/assets/shell.js:1:2345');
  assert.deepEqual(a.evidence.where, ['/shell/assets/shell.js:1:2345',
    'frontend/src (built into /shell/assets/shell.js; the line and column are the built file\'s)']);
  assert.match(a.evidence.lines[0], /^4 visits in the last hour \(3 people\), 5 visits in the last 24 hours, the last at /);
  assert.ok(a.evidence.lines.includes('Screens: discover, home, project, username_sheet.'));
  assert.ok(a.evidence.lines.includes(`Builds: ${SHA}, fedcba9.`));
  assert.ok(a.evidence.lines.includes(`Error: TypeError, code ${A}.`));
  assert.deepEqual(a.evidence.excerpts, [{ label: 'TypeError message, with every value replaced', text: 'x is null' }]);

  assert.equal(b.title, 'Page error: ReferenceError: Can\'t find variable: [string]', 'no frame: the template names it');
  assert.deepEqual(b.evidence.where, []);
  assert.ok(b.evidence.lines.includes('No frame in Homeroom\'s own scripts was on its stack.'));

  // Through the service: a whole item, and a request body with the template
  // fenced as data.
  const it = signals.normalizeItem(a);
  assert.deepEqual([it.fingerprint, it.topic, it.fixer, it.occurrences], [`client_errors:${A}`, 'infra', 'bot', 4]);
  const body = evidence.requestBody({ signal: { kind: 'client_errors', occurrences: 4 }, kind: signals.KINDS.client_errors,
    evidence: it.evidence, summary: it.summary, done: it.done });
  assert.match(body, /```text\nx is null\n```/);
  assert.match(body, /- \/shell\/assets\/shell\.js:1:2345/);
  assert.equal(signals.normalizeItem(b).topic, 'onboarding');
});

test('the observer: a classic script\'s frame points at its file, and fewer than three visits is nothing', () => {
  const D = 'js_ddddddddddd';
  const frame = '/js/app-view.js:812:17';
  const [d] = observer.itemsFrom([row(D, 'a', { frame }), row(D, 'b', { frame }), row(D, 'c', { frame })], { now: NOW });
  assert.deepEqual(d.evidence.where, [frame, 'public/js/app-view.js']);
  assert.equal(observer.itemsFrom([row(D, 'a'), row(D, 'b'), row(D, 'c', { ago: 2 * 60 * MIN })], { now: NOW }).length, 0);
  assert.equal(observer.itemsFrom([row(D, 'a'), row(D, 'b'), row(D, 'c')], { now: NOW, minVisits: 4 }).length, 0);
  assert.deepEqual(observer.itemsFrom([], { now: NOW }), []);
  // A stored row that is not what the collector writes is not repeated.
  const [odd] = observer.itemsFrom(['a', 'b', 'c'].map((v) => row(D, v, { frame: 'https://evil.test/x.js:1:2',
    name: 'Bad Name!', template: 'reach me at a@b.co' })), { now: NOW });
  assert.equal(odd.title, 'Page error: Error: reach me at [email]');
  assert.deepEqual(odd.evidence.where, []);
});

test('the observer: one person, or people with no account, cannot get a request filed alone', () => {
  const F = 'js_fffffffffff';
  const one = ['a', 'b', 'c', 'd', 'e'].map((v) => row(F, v, { user: 7 }));
  assert.deepEqual(observer.itemsFrom(one, { now: NOW }), [], 'five visits of one person are one person');
  const anonymous = ['a', 'b', 'c'].map((v) => row(F, v, { user: null }));
  assert.deepEqual(observer.itemsFrom(anonymous, { now: NOW }), [], 'visits with no account are one person between them');
  const [two] = observer.itemsFrom([...anonymous, row(F, 'd', { user: 7 })], { now: NOW });
  assert.equal(two.occurrences, 4);
  assert.match(two.evidence.lines[0], /^4 visits in the last hour \(2 people\)/);
  const [pair] = observer.itemsFrom([row(F, 'a', { user: 7 }), row(F, 'b', { user: 7 }), row(F, 'c', { user: 8 })],
    { now: NOW });
  assert.match(pair.evidence.lines[0], /^3 visits in the last hour \(2 people\)/);
  // The second person must be in the hour too.
  assert.deepEqual(observer.itemsFrom([row(F, 'a', { user: 7 }), row(F, 'b', { user: 7 }), row(F, 'c', { user: 7 }),
    row(F, 'd', { user: 8, ago: 2 * 60 * MIN })], { now: NOW }), []);
  assert.deepEqual(observer.itemsFrom([row(F, 'a'), row(F, 'b'), row(F, 'c')], { now: NOW, minPeople: 4 }), []);
});

test('the observer is wired as client_errors\' and runs through observeAll', async () => {
  const entry = observers.OBSERVERS.find((o) => o.kinds.includes('client_errors'));
  assert.ok(entry);
  const pool = { query: async () => ({ rows: ['a', 'b', 'c'].map((v) => row('js_eeeeeeeeeee', v)) }) };
  const { items, ok } = await observers.observeAll(pool, { now: NOW, observers: [entry] });
  assert.deepEqual(items.map((i) => i.key), ['js_eeeeeeeeeee']);
  assert.deepEqual([...ok], ['client_errors']);
});
