'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { environmentForInLoop, readManifest } = require('../worker/usernode-run-inloop');

const baseEnv = {
  INLOOP_BROWSER: '1', INLOOP_ENV: 'staging', INLOOP_PORT: '3100',
  INLOOP_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/inloop',
};

test('in-loop launch applies staging manifest fallbacks and never borrows worker secrets', () => {
  const env = environmentForInLoop({ secrets: [
    { key: 'PRIVATE_KEY', required: true, private: true, staging_default: 'staging-dummy' },
    { key: 'PUBLIC_NAME', required: true, default: 'display name' },
  ] }, { ...baseEnv, PRIVATE_KEY: 'worker-private-value', PUBLIC_NAME: 'worker-public-value',
    OPENROUTER_API_KEY: 'worker-model-key', WORKER_JWT: 'worker-push-grant' });
  assert.equal(env.USERNODE_ENV, 'staging');
  assert.equal(env.PORT, '3100');
  assert.equal(env.DATABASE_URL, baseEnv.INLOOP_DATABASE_URL);
  assert.equal(env.PRIVATE_KEY, 'staging-dummy');
  assert.equal(env.PUBLIC_NAME, 'display name');
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.WORKER_JWT, undefined);
});

test('in-loop launch names missing required fallback rather than inventing one', () => {
  assert.throws(() => environmentForInLoop({ secrets: [
    { key: 'MISSING_PRIVATE', required: true, private: true },
    { key: 'MISSING_PUBLIC', required: true },
  ] }, baseEnv), /MISSING_PRIVATE, MISSING_PUBLIC/);
  assert.throws(() => environmentForInLoop({ secrets: [] }, {}), /build turn/);
});

test('apps without a dapp.json can still use the local staging launch', () => {
  assert.deepEqual(readManifest(path.join(__dirname, '__missing_dapp__.json')), {});
  assert.equal(environmentForInLoop({}, baseEnv).DATABASE_URL, baseEnv.INLOOP_DATABASE_URL);
});

test('this app local launch receives only the required values already committed in dapp.json', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const env = environmentForInLoop(manifest, baseEnv);
  assert.equal(env.ADMIN_USERNAME, 'admin');
  assert.equal(env.ADMIN_PASSWORD, '__staging_admin_password__');
  assert.equal(env.SESSION_SECRET, '__staging_session_secret_not_for_prod__');
});
