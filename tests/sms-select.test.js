'use strict';

// The provider switch (src/services/sms/select.js): precedence, the ten
// second cache, invalidation, and per-provider readiness.
//
// Run with: node --test tests/sms-select.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const select = require('../src/services/sms/select');

function poolWith(rows, counter) {
  return {
    query: async (sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT value FROM platform_settings')) {
        if (counter) counter.n += 1;
        return { rows };
      }
      return { rows: [] };
    },
  };
}

test.afterEach(() => select.invalidate());

test('with no saved row and no env value, Firebase is the default', async () => {
  const chosen = await select.selection(poolWith([]), { env: {} });
  assert.deepEqual(chosen, { provider: 'firebase', source: 'default' });
});

test('PLATFORM_SMS_PROVIDER decides before any admin saves a choice', async () => {
  const chosen = await select.selection(poolWith([]), { env: { PLATFORM_SMS_PROVIDER: 'brevo' } });
  assert.deepEqual(chosen, { provider: 'brevo', source: 'env' });
  assert.equal(select.selectedSync({ smsProviderDefault: 'brevo' }), 'brevo');
});

test('an unknown env value falls back to Firebase', async () => {
  const chosen = await select.selection(poolWith([]), { env: { PLATFORM_SMS_PROVIDER: 'twilio' } });
  assert.deepEqual(chosen, { provider: 'firebase', source: 'default' });
});

test('an admin row wins over the env default', async () => {
  const chosen = await select.selection(
    poolWith([{ value: 'firebase' }]),
    { env: { PLATFORM_SMS_PROVIDER: 'brevo' } }
  );
  assert.deepEqual(chosen, { provider: 'firebase', source: 'admin' });
});

test('the read is cached, and setProvider invalidates it', async () => {
  const counter = { n: 0 };
  const pool = poolWith([{ value: 'brevo' }], counter);
  const now = 1_000_000;
  await select.selection(pool, { now, env: {} });
  await select.selection(pool, { now: now + 5_000, env: {} });
  assert.equal(counter.n, 1, 'inside CACHE_MS the row is not read again');

  await select.setProvider(pool, 'firebase', 7);
  assert.equal(select.selectedSync({}), 'firebase', 'the switch is visible before the next read');
  await select.selection(pool, { now: Date.now() + select.CACHE_MS + 1, env: {} });
  assert.equal(counter.n, 2, 'the next read goes back to the database');
});

test('Brevo needs its key outside staging and at least one Sender ID', () => {
  assert.deepEqual(select.brevoMissing({ brevoSmsSenderIds: {} }, {}),
    ['BREVO_API_KEY', 'BREVO_SMS_SENDER_IDS']);
  assert.deepEqual(
    select.brevoMissing({ brevoApiKey: 'k', brevoSmsSenderIds: { FR: {} } }, {}),
    []
  );
  assert.deepEqual(
    select.brevoMissing({ brevoApiKey: '', brevoSmsSenderIds: { FR: {} } }, { USERNODE_ENV: 'staging' }),
    [],
    'a staging preview logs instead of sending, so the key is not needed'
  );
  assert.deepEqual(
    select.brevoMissing({ brevoApiKey: '', brevoSmsSenderIds: {} }, { USERNODE_ENV: 'staging' }),
    ['BREVO_SMS_SENDER_IDS']
  );
});

test('describe names each provider, its readiness and its missing settings', async () => {
  const config = {
    firebasePhoneAuthEnabled: true,
    firebaseWebApiKey: 'web',
    firebaseProjectId: 'p',
    firebaseServiceAccountJsonB64: 'e30=',
    brevoApiKey: '',
    brevoSmsSenderIds: { FR: { sender: 'Homeroom' } },
  };
  const described = select.describe(config, { provider: 'firebase', source: 'admin' }, {});
  assert.equal(described.selected, 'firebase');
  assert.equal(described.source, 'admin');
  const firebase = described.options.find((o) => o.name === 'firebase');
  const brevo = described.options.find((o) => o.name === 'brevo');
  assert.equal(firebase.ready, true);
  assert.equal(brevo.ready, false);
  assert.deepEqual(brevo.missing, ['BREVO_API_KEY']);
  assert.equal(described.stagingLogOnly, false);
  assert.ok(!JSON.stringify(described).includes('web'), 'no value ever leaves the server');
});
