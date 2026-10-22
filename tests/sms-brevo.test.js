'use strict';

// The Brevo SMS client (src/services/sms/brevo.js): the URL, the api-key
// header, the body, and the retry rules. A retry is money and a second text,
// so 429 and 5xx are retried, a refusal and a timeout are not.
//
// Run with: node --test tests/sms-brevo.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const logged = [];
require.cache[require.resolve('../src/services/logger')] = {
  id: require.resolve('../src/services/logger'), filename: require.resolve('../src/services/logger'),
  loaded: true, paths: [],
  exports: { info: (...a) => logged.push(a), warn: (...a) => logged.push(a), error: (...a) => logged.push(a), debug: () => {} },
};

const brevo = require('../src/services/sms/brevo');

const CONFIG = { brevoApiKey: 'secret-key' };

function answer(status, data = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('posts to Brevo with the api-key header and the number without its plus', async () => {
  let seen = null;
  const result = await brevo.send(CONFIG, {
    sender: 'Homeroom', recipient: '+33680065433',
    content: 'Your verification code is 123456', type: 'transactional', tag: 'otp',
  }, { fetch: async (url, opts) => { seen = { url, opts }; return answer(201, { messageId: '1511882900176220' }); } });

  assert.equal(seen.url, 'https://api.brevo.com/v3/transactionalSMS/send');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['api-key'], 'secret-key');
  assert.deepEqual(JSON.parse(seen.opts.body), {
    sender: 'Homeroom',
    recipient: '33680065433',
    content: 'Your verification code is 123456',
    type: 'transactional',
    tag: 'otp',
  });
  assert.equal(result.ok, true);
  assert.equal(result.messageId, '1511882900176220');
  assert.equal(result.attempts, 1);
});

test('a 429 is retried, then succeeds, with the two backoff delays', async () => {
  const sleeps = [];
  let calls = 0;
  const result = await brevo.send(CONFIG, { sender: 'H', recipient: '+33680065433', content: 'x', type: 'transactional' }, {
    fetch: async () => (++calls === 1 ? answer(429, { code: 'too_many_requests' }) : answer(200, { messageId: 'm1' })),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(sleeps, [500]);
});

test('a 5xx is retried at most twice and then reported as unreachable', async () => {
  const sleeps = [];
  let calls = 0;
  const result = await brevo.send(CONFIG, { sender: 'H', recipient: '+33680065433', content: 'x', type: 'transactional' }, {
    fetch: async () => { calls += 1; return answer(503, { code: 'service_unavailable' }); },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.unreachable, true);
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 1500]);
});

test('a connection error before any response is retried', async () => {
  let calls = 0;
  const result = await brevo.send(CONFIG, { sender: 'H', recipient: '+33680065433', content: 'x', type: 'transactional' }, {
    fetch: async () => { if (++calls < 3) throw new Error('ECONNRESET'); return answer(200, { messageId: 'm2' }); },
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
});

test('a 400 or 401 is never retried: it carries Brevo\'s own code', async () => {
  for (const [status, code] of [[400, 'invalid_parameter'], [401, 'unauthorized']]) {
    let calls = 0;
    const result = await brevo.send(CONFIG, { sender: 'H', recipient: '+33680065433', content: 'x', type: 'transactional' }, {
      fetch: async () => { calls += 1; return answer(status, { code }); },
      sleep: async () => assert.fail('must not sleep before a non-retryable refusal'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.unreachable, false);
    assert.equal(result.providerCode, code);
    assert.equal(calls, 1);
  }
});

test('a timeout is not retried: Brevo may already have sent the text', async () => {
  let calls = 0;
  const result = await brevo.send(CONFIG, { sender: 'H', recipient: '+33680065433', content: 'x', type: 'transactional' }, {
    fetch: async () => { calls += 1; const err = new Error('timed out'); err.name = 'TimeoutError'; throw err; },
    sleep: async () => assert.fail('a timeout must not be retried'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.providerCode, 'timeout');
  assert.equal(calls, 1);
});

test('the API key never reaches the log', async () => {
  logged.length = 0;
  await brevo.send(CONFIG, { sender: 'H', recipient: '+33680065433', content: 'x', type: 'transactional' }, {
    fetch: async () => answer(401, { code: 'unauthorized' }),
    sleep: async () => {},
  });
  assert.ok(!JSON.stringify(logged).includes('secret-key'));
});
