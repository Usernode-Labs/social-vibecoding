// The waitlist OAuth routes read these four names at runtime. Keep their
// platform-manifest declarations aligned so production can configure the
// optional, private credentials without making the waitlist unavailable.
//
// Run with: node --test tests/waitlist-oauth-manifest.test.js

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const appManifest = require('../src/services/app-manifest');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));
const configSource = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

const WAITLIST_OAUTH_KEYS = [
  'WAITLIST_GITHUB_CLIENT_ID',
  'WAITLIST_GITHUB_CLIENT_SECRET',
  'WAITLIST_X_CLIENT_ID',
  'WAITLIST_X_CLIENT_SECRET',
];

test('manifest exposes waitlist OAuth as deployable platform variables', () => {
  const platformEnv = new Map(appManifest.readPlatformEnv(manifest)
    .map((entry) => [entry.key, entry]));
  const childSecrets = new Map((manifest.secrets || []).map((entry) => [entry.key, entry]));

  for (const key of WAITLIST_OAUTH_KEYS) {
    const entry = platformEnv.get(key);
    assert.ok(entry, `${key} is declared in dapp.json platform_env`);
    assert.equal(childSecrets.has(key), false,
      `${key} is not an inert self-hosted child-secret declaration`);
    assert.equal(entry.required, false, `${key} remains optional`);
    assert.equal(entry.private, true, `${key} is private`);
    assert.equal(entry.group, 'Waitlist OAuth', `${key} is grouped for operators`);
    assert.equal(entry.default, null, `${key} has no committed value`);
    assert.equal(entry.unwritable, false, `${key} can flow through the platform deploy resolver`);
    assert.match(entry.description, /waitlist/i, `${key} explains its waitlist use`);
  }
});

test('runtime config reads every declared waitlist OAuth credential', () => {
  for (const key of WAITLIST_OAUTH_KEYS) {
    assert.match(configSource, new RegExp(`process\\.env\\.${key}`));
    assert.match(envExample, new RegExp(`^# ${key}=$`, 'm'),
      `${key} is documented for local and standalone deployments`);
  }
});
