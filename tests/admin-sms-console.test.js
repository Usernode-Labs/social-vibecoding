// Admin → SMS delivery: the section, its two routes, and the gates that
// make a button which sends a real, billed text safe to ship.
//
//   GET  /api/admin/sms/status  — any admin; names missing variables only.
//   POST /api/admin/sms/test    — full admin, 5 / hour / admin and one per
//        number per minute; sends through firebase-phone-auth.js's real
//        Identity Toolkit call and answers with Firebase's own code.
//
// The routes are exercised over HTTP on a real express app with the real
// rate limiters and the real phone-auth service; only the outbound fetch to
// Identity Toolkit, the logger, the event recorder and the session gates are
// stubbed (the featured-apps-route.test.js harness). The console wiring is
// pinned by source shape, as tests/admin-mail-console.test.js does.
//
// Run with: node --test tests/admin-sms-console.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const recorded = [];
stub(require.resolve('../src/services/logger'), { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub(require.resolve('../src/services/events'), {
  EVENT_TYPES: { SMS_TEST_SENT: 'sms_test_sent', MAIL_TEST_SENT: 'mail_test_sent' },
  record: (_pool, ev) => { recorded.push(ev); },
});
stub(require.resolve('../src/middleware/admin'), {
  adminMiddleware: (req, res, next) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    return next();
  },
  requireAdminWrite: (req, res, next) => {
    if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'View-only admin' });
    return next();
  },
});

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  query: async () => ({ rows: [], rowCount: 0 }),
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
});

const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

const FULL_CONFIG = {
  firebasePhoneAuthEnabled: true,
  firebaseWebApiKey: 'web-key',
  firebaseProjectId: 'homeroom-test',
  firebaseServiceAccountJsonB64: 'e30=',
};

// Identity Toolkit is the one outbound call; everything else (the test's own
// requests to the local server) goes through the real fetch.
const realFetch = globalThis.fetch;
let toolkitCalls = [];
let toolkitAnswer = () => ({ ok: true, status: 200, data: { sessionInfo: 'session-xyz' } });
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://identitytoolkit.googleapis.com/')) {
    toolkitCalls.push({ url: String(url), body: JSON.parse(opts.body) });
    const a = toolkitAnswer();
    if (a.throw) throw new Error(a.throw);
    return { ok: a.ok, status: a.status, json: async () => a.data };
  }
  return realFetch(url, opts);
};
test.after(() => { globalThis.fetch = realFetch; });

let currentUser = null;
async function startServer(config) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(adminRoutes(config));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

async function call(server, method, route, body) {
  const res = await realFetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let nextUserId = 100;
const fullAdmin = () => ({ id: nextUserId++, username: 'admin', isAdmin: true, canAdminWrite: true });

function reset() {
  toolkitCalls = [];
  recorded.length = 0;
  toolkitAnswer = () => ({ ok: true, status: 200, data: { sessionInfo: 'session-xyz' } });
}

// ── status ─────────────────────────────────────────────────────────────

test('status is readable by a view-only admin and names missing keys, never values', async () => {
  const server = await startServer({ ...FULL_CONFIG, firebaseWebApiKey: '', firebasePhoneAuthEnabled: false });
  try {
    currentUser = { id: 2, username: 'viewer', isAdmin: true, canAdminWrite: false };
    const res = await call(server, 'GET', '/api/admin/sms/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.offered, false);
    assert.deepEqual(res.body.missing, ['FIREBASE_PHONE_AUTH_ENABLED', 'FIREBASE_WEB_API_KEY']);
    assert.equal(res.body.canSendTest, false);
    assert.equal(res.body.projectId, 'homeroom-test');
    assert.ok(!JSON.stringify(res.body).includes('e30='), 'the service account never leaves the server');
  } finally { server.close(); }
});

test('status reports a complete setup as offered', async () => {
  const server = await startServer(FULL_CONFIG);
  try {
    currentUser = fullAdmin();
    const res = await call(server, 'GET', '/api/admin/sms/status');
    assert.equal(res.body.offered, true);
    assert.deepEqual(res.body.missing, []);
    assert.equal(res.body.canSendTest, true);
    assert.ok(!JSON.stringify(res.body).includes('web-key'));
    assert.equal(res.body.texts, true);
    assert.equal(res.body.testNumbers, false);
  } finally { server.close(); }
});

test('status says when test numbers alone offer phone sign-in, and the test send stays off', async () => {
  const server = await startServer({ phoneTestCode: '123456' });
  try {
    currentUser = fullAdmin();
    const res = await call(server, 'GET', '/api/admin/sms/status');
    assert.equal(res.body.offered, true);
    assert.equal(res.body.texts, false, 'nothing is texted: the test send needs Firebase');
    assert.equal(res.body.testNumbers, true);
    assert.ok(!JSON.stringify(res.body).includes('123456'), 'the code never leaves the server');
    const sent = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: '+447700900123' });
    assert.equal(sent.status, 409);
    assert.equal(sent.body.code, 'not_offered');
  } finally { server.close(); }
});

// ── the test send ──────────────────────────────────────────────────────

test('a full admin sends one real code request and gets "sent" back', async () => {
  reset();
  const server = await startServer(FULL_CONFIG);
  try {
    currentUser = fullAdmin();
    const res = await call(server, 'POST', '/api/admin/sms/test',
      { phoneNumber: '+44 7700 900123', recaptchaToken: 'tok' });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome.status, 'sent');
    assert.equal(res.body.outcome.phoneNumber, '+447700900123');
    assert.ok(res.body.outcome.sentAt);
    assert.ok(!JSON.stringify(res.body).includes('session-xyz'), 'the sessionInfo is never returned');
    assert.equal(toolkitCalls.length, 1);
    assert.match(toolkitCalls[0].url, /accounts:sendVerificationCode/);
    assert.deepEqual(toolkitCalls[0].body, { phoneNumber: '+447700900123', recaptchaToken: 'tok' });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].type, 'sms_test_sent');
    assert.deepEqual(recorded[0].metadata, { status: 'sent', providerCode: null, phoneLast4: '0123' });
  } finally { server.close(); }
});

test('a Firebase refusal is a 200 carrying Firebase\'s own code', async () => {
  reset();
  toolkitAnswer = () => ({ ok: false, status: 400, data: { error: { message: 'QUOTA_EXCEEDED : project over its SMS quota' } } });
  const server = await startServer(FULL_CONFIG);
  try {
    currentUser = fullAdmin();
    const res = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: '+15550100001' });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome.status, 'refused');
    assert.equal(res.body.outcome.providerCode, 'QUOTA_EXCEEDED');
    assert.equal(res.body.outcome.httpStatus, 400);
    assert.ok(!JSON.stringify(res.body).includes('project over'), 'the free-text detail is dropped');
    assert.equal(recorded[0].metadata.status, 'refused');
  } finally { server.close(); }
});

test('an unreachable Firebase is a 200 "unreachable"', async () => {
  reset();
  toolkitAnswer = () => ({ throw: 'ECONNRESET' });
  const server = await startServer(FULL_CONFIG);
  try {
    currentUser = fullAdmin();
    const res = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: '+15550100002' });
    assert.equal(res.status, 200);
    assert.equal(res.body.outcome.status, 'unreachable');
  } finally { server.close(); }
});

test('a view-only admin cannot send, and nothing goes out', async () => {
  reset();
  const server = await startServer(FULL_CONFIG);
  try {
    currentUser = { id: 3, username: 'viewer', isAdmin: true, canAdminWrite: false };
    const res = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: '+15550100003' });
    assert.equal(res.status, 403);
    assert.equal(toolkitCalls.length, 0);
    assert.equal(recorded.length, 0);
  } finally { server.close(); }
});

test('a malformed number is a 400 that sends nothing and costs no slot', async () => {
  reset();
  const server = await startServer(FULL_CONFIG);
  try {
    currentUser = fullAdmin();
    for (let i = 0; i < 7; i++) {
      const bad = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: '07700 900123' });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'invalid_phone');
    }
    assert.equal(toolkitCalls.length, 0);
    assert.equal(recorded.length, 0);
    const ok = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: '+15550100004' });
    assert.equal(ok.status, 200, 'seven refused typos did not use up the hourly allowance');
  } finally { server.close(); }
});

test('an unconfigured platform answers 409 not_offered and sends nothing', async () => {
  reset();
  const server = await startServer({ ...FULL_CONFIG, firebaseWebApiKey: '' });
  try {
    currentUser = fullAdmin();
    const res = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: '+15550100005' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'not_offered');
    assert.equal(toolkitCalls.length, 0);
    assert.equal(recorded.length, 0);
  } finally { server.close(); }
});

test('one text per number per minute, however the number is written', async () => {
  reset();
  const server = await startServer(FULL_CONFIG);
  try {
    currentUser = fullAdmin();
    const first = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: '+1 555 010 0006' });
    assert.equal(first.status, 200);
    currentUser = fullAdmin();
    const again = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: '+15550100006' });
    assert.equal(again.status, 429);
    assert.match(again.body.error, /just sent to that number/);
    assert.equal(toolkitCalls.length, 1);
  } finally { server.close(); }
});

test('five test texts per admin per hour', async () => {
  reset();
  const server = await startServer(FULL_CONFIG);
  try {
    currentUser = fullAdmin();
    for (let i = 0; i < 5; i++) {
      const res = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: `+1555020000${i}` });
      assert.equal(res.status, 200);
    }
    const sixth = await call(server, 'POST', '/api/admin/sms/test', { phoneNumber: '+15550200009' });
    assert.equal(sixth.status, 429);
    assert.match(sixth.body.error, /up to 5 test texts per hour/);
    assert.equal(toolkitCalls.length, 5);
  } finally { server.close(); }
});

// ── console wiring ─────────────────────────────────────────────────────

test('the console lists SMS delivery in Platform, right after Email delivery', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  const mailAt = consoleJs.indexOf("{ key: 'mail', label: 'Email delivery', group: 'Platform' }");
  const smsAt = consoleJs.indexOf("{ key: 'sms', label: 'SMS delivery', group: 'Platform' }");
  const signInAt = consoleJs.indexOf("{ key: 'sign-in', label: 'Sign-in providers', group: 'Platform' }");
  assert.ok(mailAt > 0 && smsAt > mailAt && signInAt > smsAt);
  assert.match(consoleJs, /sms: 'AdminSms'/);
  assert.match(consoleJs, /'sms': '<svg/);
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-sms\.tsx';/);
  assert.match(read('scripts/audit-react-ownership.mjs'), /when: '#admin\/sms'/);
});

test('the section posts to the test route with the sign-in sheet\'s reCAPTCHA token', () => {
  const src = read('frontend/src/features/admin/admin-sms.tsx');
  assert.match(src, /phoneRecaptchaToken\(\)/);
  assert.match(src, /'\/api\/admin\/sms\/test'/);
  assert.match(src, /'\/api\/admin\/sms\/status'/);
  assert.match(src, /Send test SMS/);
  assert.match(src, /needs full admin access/, 'a view-only admin is told why there is no form');
  assert.match(src, /if \(typeof window !== 'undefined'\) \(window as any\)\.AdminSms = AdminSms;/);
});
