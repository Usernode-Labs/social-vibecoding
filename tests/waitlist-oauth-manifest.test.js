// The waitlist OAuth routes read these four names at runtime. Keep their
// platform-manifest declarations aligned so production can configure the
// optional, private credentials without making the waitlist unavailable.
//
// Run with: node --test tests/waitlist-oauth-manifest.test.js

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));
const configSource = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');

const WAITLIST_OAUTH_KEYS = [
  'WAITLIST_GITHUB_CLIENT_ID',
  'WAITLIST_GITHUB_CLIENT_SECRET',
  'WAITLIST_X_CLIENT_ID',
  'WAITLIST_X_CLIENT_SECRET',
];

test('manifest exposes the optional private waitlist OAuth credentials', () => {
  const secrets = new Map((manifest.secrets || []).map((entry) => [entry.key, entry]));

  for (const key of WAITLIST_OAUTH_KEYS) {
    const entry = secrets.get(key);
    assert.ok(entry, `${key} is declared in dapp.json`);
    assert.equal(entry.required, false, `${key} remains optional`);
    assert.equal(entry.private, true, `${key} is private`);
    assert.equal(Object.hasOwn(entry, 'default'), false, `${key} has no committed value`);
    assert.match(entry.description, /waitlist/i, `${key} explains its waitlist use`);
  }
});

test('runtime config reads every declared waitlist OAuth credential', () => {
  for (const key of WAITLIST_OAUTH_KEYS) {
    assert.match(configSource, new RegExp(`process\\.env\\.${key}`));
  }
});
