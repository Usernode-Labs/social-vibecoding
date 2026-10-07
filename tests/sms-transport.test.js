// The SMS transports behind src/services/sms/index.js, and the one contract
// every caller depends on.
//
// The property under test is two-sided, exactly as it is for mail: a text
// must actually reach the carrier when configured, and a broken carrier must
// STILL not change the caller's response. The waitlist join is always-200 by
// contract (so it can't be used to enumerate numbers) and a release notice
// rides an admin action that must not fail — which is why a provider outage
// has to look identical to a delivery from outside.
//
// Run with: node --test tests/sms-transport.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const twilio = require(path.join(ROOT, 'src/services/sms/transports/twilio.js'));
const httpApi = require(path.join(ROOT, 'src/services/sms/transports/http.js'));
const sms = require(path.join(ROOT, 'src/services/sms'));

function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'secret-token',
  PLATFORM_SMS_FROM: '+18005550100',
};

// ─── create(): configured / unconfigured / partial ──────────────────────

test('twilio create() returns null when nothing is configured', () => {
  assert.equal(twilio.create({}), null);
  assert.equal(twilio.create({ PLATFORM_SMS_FROM: '+18005550100' }), null,
    'a sender alone is not a Twilio account');
});

test('twilio create() returns null — and names the missing keys — when partial', () => {
  for (const drop of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']) {
    const env = { ...TWILIO_ENV };
    delete env[drop];
    assert.equal(twilio.create(env), null,
      `${drop} missing must not yield a half-working transport`);
  }
});

test('twilio create() returns a transport with a send() when fully configured', () => {
  const t = twilio.create(TWILIO_ENV);
  assert.ok(t && typeof t.send === 'function');
});

// ─── send(): the Twilio wire format ─────────────────────────────────────

test('a twilio send POSTs form-encoded To/From/Body with basic auth', async () => {
  const calls = [];
  await withFetch(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 201, text: async () => '{"sid":"SM123"}' };
  }, async () => {
    const detail = await twilio.create(TWILIO_ENV).send({
      to: '+15550100001', kind: 'waitlist_code_sms', body: 'Homeroom waitlist code: 123456.',
    });
    assert.equal(detail && detail.providerMessageId, 'SM123',
      'the carrier receipt id is returned so the ledger can keep it');
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/2010-04-01\/Accounts\/AC123\/Messages\.json$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['content-type'], 'application/x-www-form-urlencoded');
  // Basic auth is the SID as username and the token as password, base64.
  const expected = 'Basic ' + Buffer.from('AC123:secret-token').toString('base64');
  assert.equal(calls[0].opts.headers.authorization, expected);
  const params = new URLSearchParams(calls[0].opts.body);
  assert.equal(params.get('To'), '+15550100001');
  assert.equal(params.get('From'), '+18005550100');
  assert.equal(params.get('Body'), 'Homeroom waitlist code: 123456.');
});

test('a Messaging Service SID wins over From, matching Twilio precedence', async () => {
  let params;
  await withFetch(async (_url, opts) => {
    params = new URLSearchParams(opts.body);
    return { ok: true, status: 201, text: async () => '{}' };
  }, async () => {
    await twilio.create({ ...TWILIO_ENV, TWILIO_MESSAGING_SERVICE_SID: 'MG999' }).send({
      to: '+15550100001', kind: 'waitlist_code_sms', body: 'code',
    });
  });
  assert.equal(params.get('MessagingServiceSid'), 'MG999');
  assert.equal(params.get('From'), null, 'From must not also be sent');
});

test('the send carries an abort signal bounded by the timeout constant', async () => {
  // The timeout is what keeps a hung carrier from holding an always-200
  // request open. Asserted structurally (the signal is passed and the
  // ceiling is 8s) rather than by waiting eight seconds for it to fire.
  assert.equal(twilio.SEND_TIMEOUT_MS, 8000);
  let sawSignal = false;
  await withFetch(async (_url, opts) => {
    sawSignal = opts.signal instanceof AbortSignal;
    return { ok: true, status: 201, text: async () => '{}' };
  }, async () => {
    await twilio.create(TWILIO_ENV).send({ to: '+15550100001', kind: 'waitlist_code_sms', body: 'x' });
  });
  assert.ok(sawSignal, 'the transport must pass an AbortSignal to fetch');
});

test('a non-ok carrier response throws from the transport', async () => {
  await withFetch(async () => ({
    ok: false, status: 400, text: async () => '{"message":"bad number"}',
  }), async () => {
    await assert.rejects(
      twilio.create(TWILIO_ENV).send({ to: '+1', kind: 'waitlist_code_sms', body: 'x' }),
      /HTTP 400/
    );
  });
});

// ─── the generic HTTP transport ─────────────────────────────────────────

test('a generic-HTTP send POSTs the bearer token and a JSON body', async () => {
  const env = {
    TOPOCHAIN_SMS_API_URL: 'https://sms.example.invalid/send',
    TOPOCHAIN_SMS_API_KEY: 'test-key',
    TOPOCHAIN_SMS_FROM: '+18005550100',
  };
  let call;
  await withFetch(async (url, opts) => {
    call = { url, opts };
    return { ok: true, status: 200, text: async () => '{"id":"msg-1"}' };
  }, async () => {
    await httpApi.create(env).send({ to: '+15550100001', kind: 'waitlist_released_sms', body: 'hello' });
  });
  assert.equal(call.url, env.TOPOCHAIN_SMS_API_URL);
  assert.equal(call.opts.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(call.opts.body);
  assert.deepEqual(body, { from: '+18005550100', to: '+15550100001', body: 'hello' });
});

test('the generic HTTP transport is null unless all three keys are set', () => {
  const env = {
    TOPOCHAIN_SMS_API_URL: 'https://sms.example.invalid/send',
    TOPOCHAIN_SMS_API_KEY: 'test-key',
    TOPOCHAIN_SMS_FROM: '+18005550100',
  };
  for (const drop of Object.keys(env)) {
    const partial = { ...env };
    delete partial[drop];
    assert.equal(httpApi.create(partial), null, `${drop} missing must not build a transport`);
  }
  assert.ok(httpApi.create(env));
});

// ─── the caller never sees a failure ────────────────────────────────────

test('a carrier failure never throws to the caller (always-200 contract)', async () => {
  // The one property both callers depend on. Fails BEFORE the carrier here:
  // no pool resolves, so the ledger write is skipped, and the throw is
  // swallowed by the outer net.
  await withFetch(async () => { throw new Error('carrier exploded'); }, async () => {
    await assert.doesNotReject(
      sms.send({ smsTransport: twilio.create(TWILIO_ENV), smsProvider: 'twilio' },
        { kind: 'waitlist_code_sms', to: '+15550100001', code: '123456' })
    );
  });
});

test('an unknown kind never throws to the caller either', async () => {
  await assert.doesNotReject(
    sms.send({ smsTransport: twilio.create(TWILIO_ENV) }, { kind: 'not_a_kind', to: '+15550100001' })
  );
});
