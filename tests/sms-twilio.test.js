'use strict';

// Twilio as an SMS gateway (#5861): the client in src/services/sms/twilio.js
// (URL, Basic credential, form body, retry rules) and how the rest of the SMS
// layer treats it — its own readiness, its own Sender ID registry, and the
// delivery row naming it.
//
// Run with: node --test tests/sms-twilio.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

require.cache[require.resolve('../src/services/logger')] = {
  id: require.resolve('../src/services/logger'), filename: require.resolve('../src/services/logger'),
  loaded: true, paths: [],
  exports: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
};

const twilio = require('../src/services/sms/twilio');
const select = require('../src/services/sms/select');
const senders = require('../src/services/sms/senders');
const sms = require('../src/services/sms');

const SID = 'AC-test-account';
const CONFIG = {
  twilioAccountSid: SID,
  twilioAuthToken: 'auth-token',
  twilioSmsSenderIds: { FR: { sender: 'Homeroom', registered: false, optOut: null } },
};

function answer(status, data = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test.afterEach(() => select.invalidate());

test('posts a form to the account\'s Messages endpoint with the Basic credential', async () => {
  let seen = null;
  const result = await twilio.send(
    { ...CONFIG, twilioStatusCallbackUrl: 'https://example.test/api/sms/webhooks/twilio' },
    { sender: 'Homeroom', recipient: '+33680065433', content: 'Your Homeroom code is 123456.', type: 'transactional', tag: 'otp' },
    { fetch: async (url, opts) => { seen = { url, opts }; return answer(201, { sid: 'SM123', status: 'queued' }); } }
  );

  assert.equal(seen.url, `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.authorization,
    `Basic ${Buffer.from(`${SID}:auth-token`).toString('base64')}`);
  assert.equal(seen.opts.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = Object.fromEntries(new URLSearchParams(seen.opts.body));
  assert.deepEqual(form, {
    To: '+33680065433',
    From: 'Homeroom',
    Body: 'Your Homeroom code is 123456.',
    StatusCallback: 'https://example.test/api/sms/webhooks/twilio',
  });
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'SM123');
  assert.equal(result.attempts, 1);
});

test('no StatusCallback is named while the webhook URL is unset', async () => {
  let body = '';
  await twilio.send(CONFIG, { sender: 'Homeroom', recipient: '+33680065433', content: 'x' },
    { fetch: async (url, opts) => { body = opts.body; return answer(201, { sid: 'SM1' }); } });
  assert.equal(new URLSearchParams(body).has('StatusCallback'), false);
});

test('a long numeric sender goes out as E.164, a short code as digits', () => {
  assert.equal(twilio.fromOf('18885550100'), '+18885550100');
  assert.equal(twilio.fromOf('12345'), '12345');
  assert.equal(twilio.fromOf('Homeroom'), 'Homeroom');
});

test('missing credentials send nothing', async () => {
  let called = false;
  const result = await twilio.send({ twilioAccountSid: SID }, { sender: 'H', recipient: '+33680065433', content: 'x' },
    { fetch: async () => { called = true; return answer(201); } });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.providerCode, 'missing_credentials');
});

test('a 429 and a 5xx are retried with the two backoff delays', async () => {
  const sleeps = [];
  let calls = 0;
  const result = await twilio.send(CONFIG, { sender: 'H', recipient: '+33680065433', content: 'x' }, {
    fetch: async () => {
      calls += 1;
      if (calls === 1) return answer(429, { code: 20429 });
      if (calls === 2) return answer(503, {});
      return answer(201, { sid: 'SM2' });
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(sleeps, [500, 1500]);
});

test('a refusal is not retried and carries Twilio\'s numeric code', async () => {
  let calls = 0;
  const result = await twilio.send(CONFIG, { sender: 'H', recipient: '+33680065433', content: 'x' }, {
    fetch: async () => { calls += 1; return answer(400, { code: 21211, message: 'Invalid To number' }); },
    sleep: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.providerCode, '21211');
  assert.equal(result.unreachable, false);
});

test('a timeout is never retried', async () => {
  let calls = 0;
  const result = await twilio.send(CONFIG, { sender: 'H', recipient: '+33680065433', content: 'x' }, {
    fetch: async () => { calls += 1; const e = new Error('t'); e.name = 'TimeoutError'; throw e; },
    sleep: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.providerCode, 'timeout');
  assert.equal(result.unreachable, true);
});

test('Twilio needs its credentials outside staging and its own Sender IDs', () => {
  assert.deepEqual(select.twilioMissing({}, {}),
    ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_SMS_SENDER_IDS']);
  assert.deepEqual(select.twilioMissing(CONFIG, {}), []);
  assert.deepEqual(
    select.twilioMissing({ twilioSmsSenderIds: { FR: {} } }, { USERNODE_ENV: 'staging' }),
    [],
    'a staging preview logs instead of sending, so the credentials are not needed'
  );
  assert.deepEqual(
    select.twilioMissing({ ...CONFIG, twilioSmsSenderIds: {}, brevoSmsSenderIds: { FR: {} } }, {}),
    ['TWILIO_SMS_SENDER_IDS'],
    'Brevo\'s registry is not Twilio\'s'
  );
  assert.ok(select.isGateway('twilio') && select.isGateway('brevo') && !select.isGateway('firebase'));
  const option = select.describe(CONFIG, { provider: 'twilio', source: 'admin' }, {})
    .options.find((o) => o.name === 'twilio');
  assert.deepEqual(option, { name: 'twilio', label: 'Twilio', ready: true, missing: [] });
});

test('PLATFORM_SMS_PROVIDER=twilio is a known provider', async () => {
  const chosen = await select.selection(null, { env: { PLATFORM_SMS_PROVIDER: 'twilio' } });
  assert.deepEqual(chosen, { provider: 'twilio', source: 'env' });
});

test('each provider resolves Sender IDs from its own registry', () => {
  const config = {
    brevoSmsSenderIds: senders.parseRegistry('{"DE":"HomeroomB"}'),
    twilioSmsSenderIds: senders.parseRegistry('{"FR":"Homeroom"}', 'TWILIO_SMS_SENDER_IDS'),
  };
  assert.equal(senders.senderFor(config, 'FR', 'twilio').sender, 'Homeroom');
  assert.throws(() => senders.senderFor(config, 'FR', 'brevo'), (e) => e.code === 'no_sender_id');
  assert.throws(() => senders.senderFor(config, 'DE', 'twilio'), (e) => e.code === 'no_sender_id');
  assert.deepEqual(senders.list(config, 'twilio').map((r) => r.country), ['FR']);
});

test('with Twilio selected, a sign-in code goes through Twilio and its row names it', async () => {
  const rows = [];
  const pool = {
    query: async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO platform_settings')) return { rows: [] };
      if (typeof sql === 'string' && sql.includes('INSERT INTO sms_deliveries')) rows.push(params);
      return { rows: [] };
    },
  };
  await select.setProvider(pool, 'twilio', 1);
  const urls = [];
  const sent = await sms.sendOtpSms(pool, CONFIG, { phoneNumber: '+33680065433', code: '123456' }, {
    env: {},
    fetch: async (url, opts) => { urls.push({ url, body: opts.body }); return answer(201, { sid: 'SM9' }); },
    sleep: async () => {},
  });
  assert.equal(urls.length, 1);
  assert.match(urls[0].url, /api\.twilio\.com/);
  assert.equal(new URLSearchParams(urls[0].body).get('Body'), sms.OTP_TEXT('123456'));
  assert.deepEqual(sent, { status: 'sent', provider: 'twilio', country: 'FR', senderId: 'Homeroom', messageId: 'SM9' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], 'twilio', 'provider column');
  assert.equal(rows[0][8], 'SM9', 'provider_message_id column');
});

test('without credentials a Twilio send is refused and nothing is fetched', async () => {
  let called = false;
  await assert.rejects(
    () => sms.sendTestSms(null, { twilioSmsSenderIds: CONFIG.twilioSmsSenderIds }, { phoneNumber: '+33680065433' }, {
      env: {}, provider: 'twilio', fetch: async () => { called = true; return answer(201); },
    }),
    (err) => err.code === 'provider_not_configured'
  );
  assert.equal(called, false);
});

test('a staging preview logs a Twilio send and fetches nothing', async () => {
  let called = false;
  const sent = await sms.sendTestSms(null, CONFIG, { phoneNumber: '+33680065433' }, {
    env: { USERNODE_ENV: 'staging' }, provider: 'twilio', fetch: async () => { called = true; return answer(201); },
  });
  assert.equal(called, false);
  assert.equal(sent.status, 'logged');
  assert.equal(sent.provider, 'twilio');
});
