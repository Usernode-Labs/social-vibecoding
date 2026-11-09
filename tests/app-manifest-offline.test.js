// Tests for the dapp.json top-level `offline` switch — read leniently by
// src/services/app-manifest.js and honoured by offlineCache.optedOut.
//
// Run with: node --test tests/app-manifest-offline.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');
const offlineCache = require('../src/services/offline-cache');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-offline-'));
  try {
    if (content != null) {
      fs.writeFileSync(path.join(dir, 'dapp.json'),
        typeof content === 'string' ? content : JSON.stringify(content));
    }
    return fn(appManifest.read(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Parsing matrix ────────────────────────────────────────────────────

test('a literal "offline": false is read and opts the app out', () => {
  withManifest({ offline: false }, (m) => {
    assert.equal(m.offline, false);
    assert.equal(offlineCache.optedOut(m), true);
  });
});

test('anything else reads as no opinion, which is not an opt-out', () => {
  for (const value of [true, 'false', 0, 1, {}, []]) {
    withManifest({ offline: value }, (m) => {
      assert.equal(m.offline, null, JSON.stringify(value));
      assert.equal(offlineCache.optedOut(m), false, JSON.stringify(value));
    });
  }
});

test('absent key, missing file and unparseable JSON all read as no opinion', () => {
  withManifest({ secrets: [] }, (m) => {
    assert.equal(m.offline, null);
    assert.equal(offlineCache.optedOut(m), false);
  });
  withManifest(null, (m) => assert.equal(m.offline, null));
  withManifest('{not json', (m) => assert.equal(m.offline, null));
});
