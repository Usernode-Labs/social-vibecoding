'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const events = require('../src/services/mail/events');
const express = require('express');
const { mailWebhookRoutes } = require('../src/routes/mail-webhooks');

const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
function signed(raw, { id = 'msg_demo', timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
  const signature = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${id}.${timestamp}.`).update(raw).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
}

test('only the explicit non-transactional allow-list is tracked', () => {
  for (const kind of ['build_ready', 'invite_activity', 'project_invite', 'waitlist_released']) assert.equal(events.isTracked(kind), true);
  for (const kind of ['otp', 'account_email', 'waitlist_code', 'waitlist_joined', 'password_reset', 'admin_test', 'future_kind']) assert.equal(events.isTracked(kind), false);
  const a = events.messageId(); const b = events.messageId();
  assert.match(a, /^[a-f0-9]{48}$/); assert.notEqual(a, b);
});

test('Resend signatures reject changed bytes, missing secrets, stale/future timestamps and support key rotation', () => {
  const raw = Buffer.from('{"type":"email.delivered"}');
  const headers = signed(raw);
  assert.equal(events.verifyResend(raw, headers, secret), true);
  assert.equal(events.verifyResend(Buffer.from(raw + ' '), headers, secret), false);
  assert.equal(events.verifyResend(raw, {}, secret), false);
  assert.equal(events.verifyResend(raw, headers, ''), false);
  assert.equal(events.verifyResend(raw, signed(raw, { timestamp: '1' }), secret), false);
  assert.equal(events.verifyResend(raw, signed(raw, { timestamp: String(Math.floor(Date.now() / 1000) + 600) }), secret), false);
  assert.equal(events.verifyResend(raw, { ...headers, 'svix-signature': 'v1,AAAA ' + headers['svix-signature'] }, secret), true);
});

test('an unknown provider receipt is retryable and never looked up by email address', async () => {
  const calls = [];
  const pool = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: [] }; } };
  assert.equal(await events.ingestResend(pool, { type: 'email.bounced', data: { email_id: 'receipt', to: ['victim@example.invalid'] } }, 'msg'), 'pending');
  assert.deepEqual(calls[0].args, ['receipt']);
  assert.equal(await events.ingestResend(pool, { type: 'email.delivered', data: {} }, 'msg'), 'invalid');
  assert.equal(await events.ingestResend(pool, { type: 'email.opened' }, 'msg'), 'ignored');
});

test('public webhook route rejects unsigned, tampered and malformed calls before touching a database', async (t) => {
  const before = process.env.PLATFORM_MAIL_RESEND_WEBHOOK_SECRET;
  process.env.PLATFORM_MAIL_RESEND_WEBHOOK_SECRET = secret;
  t.after(() => {
    if (before === undefined) delete process.env.PLATFORM_MAIL_RESEND_WEBHOOK_SECRET;
    else process.env.PLATFORM_MAIL_RESEND_WEBHOOK_SECRET = before;
  });
  const app = express(); app.use(mailWebhookRoutes({})); app.use(express.json());
  const server = app.listen(0); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/mail/webhooks/resend`;
  const post = (raw, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
  const raw = Buffer.from('{"type":"email.opened"}');
  assert.equal((await post(raw)).status, 401);
  assert.equal((await post(Buffer.from(raw + ' '), signed(raw))).status, 401);
  const bad = Buffer.from('{broken');
  assert.equal((await post(bad, signed(bad))).status, 400);
  // An ignored event does not need to resolve the pool; getPool itself is lazy.
  assert.equal((await post(raw, signed(raw))).status, 200);
  process.env.PLATFORM_MAIL_RESEND_WEBHOOK_SECRET = '';
  assert.equal((await post(raw, signed(raw))).status, 401);
});

test('Resend and Postmark HTTP receipts are returned to the delivery ledger', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const transport = require('../src/services/mail/transports/http-api').create({
    TOPOCHAIN_MAIL_API_URL: 'https://mail.example.invalid', TOPOCHAIN_MAIL_API_KEY: 'test-only', TOPOCHAIN_MAIL_FROM: 'test@example.invalid',
  });
  for (const receipt of [{ id: 'resend-receipt' }, { MessageID: 'postmark-receipt' }]) {
    global.fetch = async () => ({ ok: true, text: async () => JSON.stringify(receipt) });
    assert.equal((await transport.send({ kind: 'otp', to: 'test@example.invalid', code: '123456' })).providerMessageId, Object.values(receipt)[0]);
  }
});

test('template tracking rewrites only the allow-list and leaves every transactional template unchanged', (t) => {
  const before = process.env.PLATFORM_MAIL_TRACKING_SECRET;
  process.env.PLATFORM_MAIL_TRACKING_SECRET = 'test-only-tracking';
  t.after(() => { if (before === undefined) delete process.env.PLATFORM_MAIL_TRACKING_SECRET; else process.env.PLATFORM_MAIL_TRACKING_SECRET = before; });
  const templates = require('../src/services/mail/templates');
  const id = events.messageId();
  const payload = { code: '123456', url: 'https://app.onhomeroom.com/#home', confirmUrl: 'https://app.onhomeroom.com/confirm/secret', messageId: id, trackingEnabled: true };
  for (const kind of templates.KINDS) {
    const plain = templates.buildMessage(kind, { ...payload, trackingEnabled: false });
    const tracked = templates.buildMessage(kind, payload);
    if (!events.isTracked(kind)) assert.deepEqual(tracked, plain, kind);
    else {
      assert.ok(tracked.html.includes(`/mail/o/${id}.gif?s=`), kind);
      assert.ok(tracked.html.includes(`/mail/c/${id}/`), kind);
      assert.equal(tracked.text, plain.text); assert.ok(tracked.trackingLinks.length > 0);
    }
  }
  delete process.env.PLATFORM_MAIL_TRACKING_SECRET;
  assert.deepEqual(templates.buildMessage('project_invite', payload), templates.buildMessage('project_invite', { ...payload, trackingEnabled: false }));
});

test('HTTP mail carries HTML tracking only on opted-in non-transactional sends', async (t) => {
  const previous = process.env.PLATFORM_MAIL_TRACKING_SECRET; const original = global.fetch;
  process.env.PLATFORM_MAIL_TRACKING_SECRET = 'test-only-http-tracking';
  t.after(() => { global.fetch = original; if (previous === undefined) delete process.env.PLATFORM_MAIL_TRACKING_SECRET; else process.env.PLATFORM_MAIL_TRACKING_SECRET = previous; });
  const requests = [];
  global.fetch = async (_url, opts) => { requests.push(JSON.parse(opts.body)); return { ok: true, text: async () => '{"id":"receipt"}' }; };
  const transport = require('../src/services/mail/transports/http-api').create({ TOPOCHAIN_MAIL_API_URL: 'https://mail.example.invalid', TOPOCHAIN_MAIL_API_KEY: 'test-only', TOPOCHAIN_MAIL_FROM: 'test@example.invalid' });
  const id = events.messageId();
  await transport.send({ kind: 'otp', to: 'test@example.invalid', code: '123456', messageId: id, trackingEnabled: true });
  await transport.send({ kind: 'project_invite', to: 'test@example.invalid', url: 'https://app.onhomeroom.com/#home', messageId: id, trackingEnabled: true });
  assert.equal(requests[0].html, undefined);
  assert.ok(requests[1].html.includes(`/mail/o/${id}.gif?s=`));
  assert.ok(requests[1].html.includes(`/mail/c/${id}/0?s=`));
  assert.ok(requests[1].text.includes('https://app.onhomeroom.com/#home'));
});
