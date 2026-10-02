'use strict';

// services/mobile-store-links.js is the one reader of the published store
// listings: the install banner and the waitlist release mail both use it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadMobileAppUrls } = require('../src/services/mobile-store-links');

const poolWith = (rows) => ({ query: async () => ({ rows }) });

test('both keys are always present, trimmed, blanks read as null', async () => {
  assert.deepEqual(await loadMobileAppUrls(poolWith([])), { ios: null, android: null });
  assert.deepEqual(await loadMobileAppUrls(poolWith([
    { os: 'ios', update_url: '  https://testflight.apple.com/join/a  ' },
    { os: 'android', update_url: '   ' },
  ])), { ios: 'https://testflight.apple.com/join/a', android: null });
});

test('only active ios and android rows are read', async () => {
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rows: [{ os: 'web', update_url: 'https://w' }] }; } };
  assert.deepEqual(await loadMobileAppUrls(pool), { ios: null, android: null });
  assert.match(sql, /is_active = TRUE/);
  assert.match(sql, /os IN \('ios', 'android'\)/);
});

test('a failed query throws, so each caller chooses how to degrade', async () => {
  const pool = { query: async () => { throw new Error('down'); } };
  await assert.rejects(loadMobileAppUrls(pool), /down/);
});
