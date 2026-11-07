'use strict';

// Brevo as a platform mail provider: the send call, when it is chosen, and
// what its webhook records. The Postgres half is in mail-events-postgres.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const brevo = require('../src/services/mail/transports/brevo');
const select = require('../src/services/mail/select');
const events = require('../src/services/mail/events');
const { deliveryEventsAvailable } = require('../src/services/mail/reports');
const { mailWebhookRoutes } = require('../src/routes/mail-webhooks');

const SENDER = 'Homeroom <no-reply@onhomeroom.com>';
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const realFetch = global.fetch;
function stubFetch(t, answer) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    return answer;
  };
  t.after(() => { global.fetch = realFetch; });
  return calls;
}
const answered = (status, body) => ({ ok: status < 400, status, text: async () => body });

test('a send posts one message to the email API, tagged with its kind, and returns the receipt without its brackets', async (t) => {
  const calls = stubFetch(t, answered(201, '{"messageId":"<201798300811.5787683@relay.example.invalid>"}'));
  const transport = brevo.create({ BREVO_API_KEY: 'test-only-key' }, { sender: SENDER });
  const detail = await transport.send({ kind: 'otp', to: 'someone@example.invalid', code: '123456', messageId: 'a'.repeat(48) });

  assert.deepEqual(detail, { providerMessageId: '201798300811.5787683@relay.example.invalid' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].headers['api-key'], 'test-only-key');
  const { body } = calls[0];
  assert.deepEqual(body.sender, { name: 'Homeroom', email: 'no-reply@onhomeroom.com' });
  assert.deepEqual(body.to, [{ email: 'someone@example.invalid' }]);
  assert.deepEqual(body.tags, ['otp']);
  assert.ok(body.subject);
  assert.ok(body.textContent.includes('123456'));
  assert.ok(body.htmlContent.includes('123456'));
});

test('a kind\'s own headers reach Brevo', async (t) => {
  const calls = stubFetch(t, answered(201, '{}'));
  const templates = require('../src/services/mail/templates');
  const kind = templates.KINDS.find((k) => {
    try { return templates.buildMessage(k, { url: 'https://example.invalid/', unsubscribeUrl: 'https://example.invalid/u' }).headers; }
    catch { return false; }
  });
  assert.ok(kind, 'some kind carries its own headers');
  const payload = { url: 'https://example.invalid/', unsubscribeUrl: 'https://example.invalid/u' };
  const expected = templates.buildMessage(kind, payload).headers;
  await brevo.create({ BREVO_API_KEY: 'k' }, { sender: SENDER }).send({ kind, to: 'a@example.invalid', ...payload });
  assert.deepEqual(calls[0].body.headers, expected);
});

test('a refusal throws Brevo\'s bounded complaint, and a success with no readable receipt is still a success', async (t) => {
  const transport = brevo.create({ BREVO_API_KEY: 'k' }, { sender: SENDER });
  stubFetch(t, answered(401, JSON.stringify({ code: 'unauthorized', message: 'x'.repeat(500) })));
  await assert.rejects(transport.send({ kind: 'otp', to: 'a@example.invalid', code: '1' }), (err) => {
    assert.match(err.message, /^HTTP 401: .*unauthorized/);
    assert.ok(err.message.length < 230);
    return true;
  });
  stubFetch(t, answered(201, 'not json'));
  assert.equal(await transport.send({ kind: 'otp', to: 'a@example.invalid', code: '1' }), undefined);
});

const SET_BUT_IGNORED = { BREVO_API_KEY: 'k', BREVO_MAIL_TEMPLATES: '{"otp":12,"project_invite":34}' };

test('BREVO_MAIL_TEMPLATES is ignored: the console\'s words are always what goes out', async (t) => {
  const calls = stubFetch(t, answered(201, '{"messageId":"<id@relay>"}'));
  const transport = brevo.create(SET_BUT_IGNORED, { sender: SENDER });
  assert.equal(transport.usesProviderTemplate, undefined);
  assert.equal(brevo.parseTemplates, undefined);
  const detail = await transport.send({ kind: 'otp', to: 'a@example.invalid', code: '123456', messageId: 'a'.repeat(48), trackingEnabled: false });
  assert.deepEqual(detail, { providerMessageId: 'id@relay' });
  const { body } = calls[0];
  assert.equal(body.templateId, undefined);
  assert.equal(body.params, undefined);
  assert.ok(body.subject);
  assert.ok(body.htmlContent);
  assert.ok(body.textContent.includes('123456'));
  assert.deepEqual(body.tags, ['otp']);
});

test('a refusal is never retried with other words: one attempt, as ever', async (t) => {
  const transport = brevo.create(SET_BUT_IGNORED, { sender: SENDER });
  for (const status of [400, 404, 401, 502]) {
    const calls = stubFetch(t, answered(status, 'no'));
    await assert.rejects(transport.send({ kind: 'otp', to: 'a@example.invalid', code: '1' }), new RegExp(`HTTP ${status}`));
    assert.equal(calls.length, 1);
  }
});

test('send() records every Brevo mail as Homeroom\'s own words, with the pixel, whatever the setting says', async (t) => {
  const mail = require('../src/services/mail');
  const previous = process.env.PLATFORM_MAIL_TRACKING_SECRET;
  process.env.PLATFORM_MAIL_TRACKING_SECRET = 'test-only-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.PLATFORM_MAIL_TRACKING_SECRET;
    else process.env.PLATFORM_MAIL_TRACKING_SECRET = previous;
  });
  const calls = stubFetch(t, answered(201, '{"messageId":"<id@relay>"}'));
  const poolModule = require('../src/db/pool');
  const realGetPool = poolModule.getPool;
  t.after(() => { poolModule.getPool = realGetPool; });
  const inserts = [];
  // The database holds the first templates, as a seeded one does: send()
  // words every mail from the stored templates.
  const seeded = require('../src/services/mail/template-store').seededSnapshot();
  const query = async (sql, args) => {
    if (/INSERT INTO mail_deliveries/.test(sql)) { inserts.push(args); return { rows: [{ id: 1 }] }; }
    if (/FROM email_templates/.test(sql)) return { rows: Object.values(seeded.templates) };
    if (/FROM email_layouts/.test(sql)) return { rows: Object.values(seeded.layouts) };
    return { rows: [] };
  };
  poolModule.getPool = () => ({ query, connect: async () => ({ query, release() {} }) });
  await mail.send({ databaseUrl: 'postgres://unused.invalid/none', mailTransport: brevo.create(SET_BUT_IGNORED, { sender: SENDER }) },
    { kind: 'project_invite', to: 'a@example.invalid', inviter: 'ada', project: 'Garden', url: 'https://example.invalid/w' });
  assert.equal(calls[0].body.templateId, undefined);
  assert.match(calls[0].body.htmlContent, /\/mail\/o\//, 'Homeroom\'s words carry the pixel');
  assert.equal(inserts[0][8], true, 'engagement_tracked');
});

test('the sender parses from either spelling, and an unusable one is not a transport', () => {
  assert.deepEqual(brevo.parseSender('"Home Room" <a@example.invalid>'), { name: 'Home Room', email: 'a@example.invalid' });
  assert.deepEqual(brevo.parseSender('<a@example.invalid>'), { email: 'a@example.invalid' });
  assert.deepEqual(brevo.parseSender('a@example.invalid'), { email: 'a@example.invalid' });
  assert.equal(brevo.parseSender('Homeroom'), null);
  assert.equal(brevo.create({ BREVO_API_KEY: 'k' }, { sender: 'Homeroom' }), null);
  assert.equal(brevo.create({}, { sender: SENDER }), null);
});

test('Brevo sends only when named: having the SMS key never moves mail', () => {
  const key = { BREVO_API_KEY: 'k' };
  const gmail = { GMAIL_OAUTH_CLIENT_ID: 'a', GMAIL_OAUTH_CLIENT_SECRET: 'b', GMAIL_OAUTH_REFRESH_TOKEN: 'c' };
  assert.equal(select.chooseTransport({ ...key, ...gmail, USERNODE_ENV: 'production' }).provider, 'gmail');
  assert.equal(select.chooseTransport({ ...key, USERNODE_ENV: 'production' }).transport, null);

  const named = select.chooseTransport({ ...key, ...gmail, PLATFORM_MAIL_PROVIDER: 'brevo', USERNODE_ENV: 'production' });
  assert.equal(named.provider, 'brevo');
  assert.equal(named.transport.provider, 'brevo');
  assert.equal(named.from, select.DEFAULT_FROM);
  assert.equal(select.chooseTransport({ PLATFORM_MAIL_PROVIDER: 'brevo', USERNODE_ENV: 'production' }).transport, null,
    'named but not configured is broken, not downgraded');
});

test('a staging preview never reaches Brevo', () => {
  const chosen = select.chooseTransport({ BREVO_API_KEY: 'k', PLATFORM_MAIL_PROVIDER: 'brevo', USERNODE_ENV: 'staging' });
  assert.equal(chosen.provider, 'log');
  assert.equal(chosen.stagingLogOnly, true);
});

test('the admin card is told Brevo\'s readiness and, once it is named, what it lacks; never the key', () => {
  const missing = select.describe({ PLATFORM_MAIL_PROVIDER: 'brevo', USERNODE_ENV: 'production' });
  assert.deepEqual(missing.providers.find((p) => p.name === 'brevo'),
    { name: 'brevo', label: 'Brevo email API', configured: false, ready: false, missing: ['BREVO_API_KEY'] });
  assert.deepEqual(missing.missing, ['BREVO_API_KEY']);

  const ready = select.describe({ PLATFORM_MAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'secret-key-value', USERNODE_ENV: 'production' });
  assert.equal(ready.configured, true);
  assert.equal(ready.provider, 'brevo');
  assert.ok(!JSON.stringify(ready).includes('secret-key-value'));
});

test('the reports show delivery counts only for a provider whose webhook is connected', () => {
  assert.equal(deliveryEventsAvailable('brevo', { BREVO_MAIL_WEBHOOK_TOKEN: 't' }), true);
  assert.equal(deliveryEventsAvailable('brevo', {}), false);
  assert.equal(deliveryEventsAvailable('brevo', { PLATFORM_MAIL_RESEND_WEBHOOK_SECRET: 'whsec_x' }), false);
  assert.equal(deliveryEventsAvailable('http', { BREVO_MAIL_WEBHOOK_TOKEN: 't' }), false);
  assert.equal(deliveryEventsAvailable('gmail', { BREVO_MAIL_WEBHOOK_TOKEN: 't' }), false);
});

function poolFinding(row) {
  const calls = [];
  return { calls, query: async (sql, args) => { calls.push({ sql, args }); return { rows: row ? [row] : [] }; } };
}
const NOW = Date.UTC(2026, 10, 5, 12);

test('each Brevo event records the right type and suppresses only what will never arrive', async () => {
  const delivery = { id: 7, kind: 'project_invite', recipient: 'a@example.invalid' };
  const expected = {
    delivered: ['delivered', false, null],
    hard_bounce: ['bounced', true, 'bounce'],
    invalid_email: ['bounced', true, 'bounce'],
    soft_bounce: ['bounced', false, null],
    blocked: ['bounced', false, null],
    spam: ['complained', false, 'complaint'],
  };
  for (const [name, [type, hardBounce, reason]] of Object.entries(expected)) {
    const pool = poolFinding(delivery);
    assert.equal(await events.ingestBrevo(pool, { event: name, 'message-id': '<id@relay>', email: 'other@example.invalid' }, NOW), 'recorded', name);
    assert.deepEqual(pool.calls[0].args, ['id@relay'], 'looked up by the receipt, never the address');
    assert.match(pool.calls[0].sql, /provider = 'brevo'/);
    assert.deepEqual(pool.calls[1].args,
      [7, type, `brevo:id@relay:${name}`, hardBounce, true, 'a@example.invalid', reason, 'brevo'], name);
  }
});

test('opens, clicks and the rest stay Brevo\'s: nothing is read or written', async () => {
  for (const name of ['request', 'click', 'opened', 'unique_opened', 'proxy_open', 'unique_proxy_open', 'deferred', 'unsubscribed', 'error', 'toString', undefined]) {
    const pool = poolFinding({ id: 1 });
    assert.equal(await events.ingestBrevo(pool, { event: name, 'message-id': '<id@relay>' }, NOW), 'ignored', String(name));
    assert.equal(pool.calls.length, 0);
  }
});

test('an unknown receipt is retried only while send() could still be saving it', async () => {
  const fresh = NOW - 60_000;
  const old = NOW - 16 * 60_000;
  const ask = (fields) => events.ingestBrevo(poolFinding(null), { event: 'delivered', 'message-id': '<id@relay>', ...fields }, NOW);
  assert.equal(await ask({ ts_epoch: fresh }), 'pending');
  assert.equal(await ask({ ts_event: fresh / 1000 }), 'pending');
  assert.equal(await ask({ ts_epoch: old }), 'ignored', 'too old to be ours');
  assert.equal(await ask({}), 'ignored', 'no time to go on');
  assert.equal(await events.ingestBrevo(poolFinding(null), { event: 'delivered' }, NOW), 'invalid');
  assert.equal(await events.ingestBrevo(poolFinding(null), { event: 'delivered', 'message-id': 'x'.repeat(129) }, NOW), 'invalid');
});

test('the webhook is off with no token and refuses a wrong one before touching a database', async (t) => {
  const before = process.env.BREVO_MAIL_WEBHOOK_TOKEN;
  t.after(() => {
    if (before === undefined) delete process.env.BREVO_MAIL_WEBHOOK_TOKEN;
    else process.env.BREVO_MAIL_WEBHOOK_TOKEN = before;
  });
  const app = express(); app.use(mailWebhookRoutes({}));
  const server = app.listen(0); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/mail/webhooks/brevo`;
  const post = (body, token) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
  const opened = '{"event":"opened","message-id":"<id@relay>"}';

  delete process.env.BREVO_MAIL_WEBHOOK_TOKEN;
  assert.equal((await post(opened, 'anything')).status, 404);

  process.env.BREVO_MAIL_WEBHOOK_TOKEN = 'test-only-token';
  assert.equal((await post(opened)).status, 401);
  assert.equal((await post(opened, 'wrong')).status, 401);
  assert.equal((await post('{broken', 'test-only-token')).status, 400);
  assert.equal((await post(opened, 'test-only-token')).status, 200);
});

test('the chart can name the provider and supply the webhook token, and naming nothing changes nothing', () => {
  const secret = read('deploy/helm/social-vibecoding-platform/templates/secret.yaml');
  assert.match(secret, /\{\{- with \.Values\.secrets\.platformMailProvider \}\}\n\s+PLATFORM_MAIL_PROVIDER: \{\{ \. \| quote \}\}\n\s+\{\{- end \}\}/);
  assert.match(secret, /BREVO_MAIL_WEBHOOK_TOKEN: \{\{ \.Values\.secrets\.brevoMailWebhookToken \| quote \}\}/);
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.match(values, /^ {2}platformMailProvider: ""$/m);
  assert.match(values, /^ {2}brevoMailWebhookToken: ""$/m);
  assert.doesNotMatch(secret, /BREVO_MAIL_TEMPLATES|brevoMailTemplates/);
  assert.doesNotMatch(values, /brevoMailTemplates/);
});

test('the manifest declares the webhook token as private and optional', () => {
  const entry = JSON.parse(read('dapp.json')).platform_env.find((e) => e.key === 'BREVO_MAIL_WEBHOOK_TOKEN');
  assert.equal(entry.private, true);
  assert.equal(entry.required, false);
});
