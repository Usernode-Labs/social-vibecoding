// #629: platform-managed env vars (NODE_RPC_URL) must be injected into
// a deploy's env even when the app's dapp.json never declares the key.
// The Guardian app read NODE_RPC_URL with an empty manifest, so
// mergeForDeploy dropped the platform value and the prod container
// crash-looped. These are pure-function tests on mergeForDeploy —
// nothing is stubbed.
//
// Run with: node --test tests/app-secrets-platform-defaults.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeForDeploy } = require('../src/services/app-secrets');

const RPC = 'http://usernode-node:3000';

test('undeclared platform key is injected (the Guardian regression)', () => {
  const { env } = mergeForDeploy({ secrets: [] }, {}, { NODE_RPC_URL: RPC });
  assert.equal(env.NODE_RPC_URL, RPC);
});

test('stored value still wins over the platform default for declared keys', () => {
  const manifest = {
    secrets: [{ key: 'NODE_RPC_URL', description: 'rpc', required: false }],
  };
  const { env } = mergeForDeploy(
    manifest, { NODE_RPC_URL: 'http://user-override:9999' }, { NODE_RPC_URL: RPC }
  );
  assert.equal(env.NODE_RPC_URL, 'http://user-override:9999');
});

test('platform default still wins over a declared manifest default', () => {
  const manifest = {
    secrets: [{
      key: 'NODE_RPC_URL', description: 'rpc', required: false,
      default: 'http://standalone-fallback:3001',
    }],
  };
  const { env } = mergeForDeploy(manifest, {}, { NODE_RPC_URL: RPC });
  assert.equal(env.NODE_RPC_URL, RPC);
});

test('undeclared platform key does not touch either failure list', () => {
  const manifest = {
    secrets: [
      { key: 'API_KEY', description: 'k', required: true },
      { key: 'SIGNING_KEY', description: 's', required: true, private: true },
    ],
  };
  const result = mergeForDeploy(manifest, {}, { NODE_RPC_URL: RPC }, { forStaging: true });
  assert.equal(result.env.NODE_RPC_URL, RPC);
  assert.deepEqual(result.missingRequired, ['API_KEY']);
  assert.deepEqual(result.missingPrivateStagingDefault, ['SIGNING_KEY']);
});

test('declared private staging fallback is not overwritten by a platform default', () => {
  const manifest = {
    secrets: [{
      key: 'NODE_RPC_URL', description: 'rpc', required: true, private: true,
      staging_default: 'http://staging-safe:3002',
    }],
  };
  const { env, missingPrivateStagingDefault } = mergeForDeploy(
    manifest, { NODE_RPC_URL: 'http://prod-secret:1111' }, { NODE_RPC_URL: RPC },
    { forStaging: true }
  );
  assert.equal(env.NODE_RPC_URL, 'http://staging-safe:3002');
  assert.deepEqual(missingPrivateStagingDefault, []);
});

test('empty or absent platform defaults inject nothing', () => {
  const manifest = {
    secrets: [{ key: 'DEFAULT_LOCALE', description: 'l', required: false, default: 'en-US' }],
  };
  for (const platform of [{}, null, undefined, { NODE_RPC_URL: null }]) {
    const { env } = mergeForDeploy(manifest, {}, platform);
    assert.deepEqual(env, { DEFAULT_LOCALE: 'en-US' });
  }
});
