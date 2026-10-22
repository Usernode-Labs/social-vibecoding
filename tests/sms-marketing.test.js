'use strict';

// Marketing texts: the consent, opt-out and quiet-hour gates, the appended
// opt-out line, and the delivery row every outcome writes.
//
// Run with: node --test tests/sms-marketing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const sms = require('../src/services/sms');

const CONFIG = {
  brevoApiKey: 'key',
  brevoSmsSenderIds: {
    FR: { sender: 'Homeroom', registered: false, optOut: null },
    US: { sender: '18885550100', registered: true, optOut: 'Reply STOP to opt out' },
  },
};

function poolWith({ consent = null, deliveries = [] } = {}) {
  return {
    query: async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('FROM sms_marketing_consents')) {
        return { rows: consent ? [consent] : [] };
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO sms_deliveries')) {
        deliveries.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function okFetch() {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    return { ok: true, status: 201, json: async () => ({ messageId: 'm-1' }) };
  };
  return { calls, fetchImpl };
}

const DEPS = (fetchImpl) => ({ env: {}, fetch: fetchImpl, sleep: async () => {} });

test('a number with no opt-in gets nothing', async () => {
  const { fetchImpl, calls } = okFetch();
  await assert.rejects(
    () => sms.sendMarketingSms(poolWith(), CONFIG, { phoneNumber: '+33680065433', content: 'Hello' }, DEPS(fetchImpl)),
    (err) => err.code === 'no_consent'
  );
  assert.equal(calls.length, 0);
});

test('a number that opted out gets nothing', async () => {
  const { fetchImpl, calls } = okFetch();
  await assert.rejects(
    () => sms.sendMarketingSms(
      poolWith({ consent: { opted_in_at: '2026-01-01', opted_out_at: '2026-02-01' } }),
      CONFIG,
      { phoneNumber: '+33680065433', content: 'Hello' },
      DEPS(fetchImpl)
    ),
    (err) => err.code === 'opted_out'
  );
  assert.equal(calls.length, 0);
});

test('quiet hours refuse rather than queue', async () => {
  const { fetchImpl, calls } = okFetch();
  await assert.rejects(
    () => sms.sendMarketingSms(
      poolWith({ consent: { opted_in_at: '2026-01-01', opted_out_at: null } }),
      CONFIG,
      { phoneNumber: '+33680065433', content: 'Hello', now: new Date('2026-10-25T10:00:00Z') },
      DEPS(fetchImpl)
    ),
    (err) => err.code === 'quiet_hours',
    'a Sunday in Paris'
  );
  assert.equal(calls.length, 0);
});

test('a permitted send is marketing, carries the opt-out line, and is logged', async () => {
  const deliveries = [];
  const { fetchImpl, calls } = okFetch();
  const result = await sms.sendMarketingSms(
    poolWith({ consent: { opted_in_at: '2026-01-01', opted_out_at: null }, deliveries }),
    CONFIG,
    { phoneNumber: '+33680065433', content: 'New this week on Homeroom.', now: new Date('2026-10-22T10:00:00Z') },
    DEPS(fetchImpl)
  );
  assert.equal(result.status, 'sent');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    sender: 'Homeroom',
    recipient: '33680065433',
    content: 'New this week on Homeroom. Reply STOP to unsubscribe',
    type: 'marketing',
    tag: 'marketing',
  });
  assert.equal(deliveries.length, 1, 'one sms_deliveries row is written');
  assert.equal(deliveries[0][0], 'marketing');
  assert.equal(deliveries[0][5], 'sent');
});

test('the registry opt-out line is used, and STOP already said is not repeated', async () => {
  const { fetchImpl, calls } = okFetch();
  await sms.sendMarketingSms(
    poolWith({ consent: { opted_in_at: '2026-01-01', opted_out_at: null } }),
    CONFIG,
    { phoneNumber: '+15550100001', content: 'Big news. Reply STOP to opt out', now: new Date('2026-10-22T16:00:00Z') },
    DEPS(fetchImpl)
  );
  assert.equal(calls[0].content, 'Big news. Reply STOP to opt out');
  assert.equal(calls[0].sender, '18885550100');
});

test('a refusal still writes a delivery row', async () => {
  const deliveries = [];
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ code: 'invalid_parameter' }) });
  await assert.rejects(
    () => sms.sendMarketingSms(
      poolWith({ consent: { opted_in_at: '2026-01-01', opted_out_at: null }, deliveries }),
      CONFIG,
      { phoneNumber: '+33680065433', content: 'Hello', now: new Date('2026-10-22T10:00:00Z') },
      DEPS(fetchImpl)
    ),
    (err) => err.code === 'provider_refused' && err.providerCode === 'invalid_parameter'
  );
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0][5], 'refused');
});

test('an unmapped country is refused before Brevo is called, as an OTP is', async () => {
  const { fetchImpl, calls } = okFetch();
  await assert.rejects(
    () => sms.sendOtpSms(poolWith(), CONFIG, { phoneNumber: '+5511999999999', code: '123456' }, DEPS(fetchImpl)),
    (err) => err.code === 'no_sender_id'
  );
  assert.equal(calls.length, 0);
});
