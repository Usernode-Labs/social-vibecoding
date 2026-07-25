// Tests for the dapp.json `admins` block (issue #788) — the per-app
// admin roster parsed leniently by src/services/app-manifest.js.
// Mirrors tests/app-manifest-governance.test.js.
//
// The one semantic worth pinning down here: absence and emptiness mean
// DIFFERENT things. An absent block is null ("leave the roster alone"),
// while an explicit [] is a real, authoritative "no admins" — without
// that asymmetry there would be no way to revoke the last admin.
//
// Run with: node --test tests/app-manifest-admins.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-admins-'));
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

test('valid admins array passes through in declared order + casing', () => {
  withManifest({ secrets: [], admins: ['alice', 'Bob'] }, (m) => {
    assert.deepEqual(m.admins, ['alice', 'Bob']);
  });
});

test('absent block resolves to null (also: no dapp.json, unparseable dapp.json)', () => {
  withManifest({ secrets: [] }, (m) => assert.equal(m.admins, null));
  withManifest(null, (m) => assert.equal(m.admins, null));
  withManifest('{not json', (m) => assert.equal(m.admins, null));
  withManifest({ admins: null }, (m) => assert.equal(m.admins, null));
});

test('an explicit empty array is NOT null — it means "clear the roster"', () => {
  withManifest({ admins: [] }, (m) => {
    assert.deepEqual(m.admins, []);
    assert.notEqual(m.admins, null,
      'absence and emptiness must stay distinguishable, or revocation is impossible');
  });
});

test('non-array block resolves to null (treated as absent)', () => {
  withManifest({ admins: 'alice' }, (m) => assert.equal(m.admins, null));
  withManifest({ admins: { users: ['alice'] } }, (m) => assert.equal(m.admins, null));
  withManifest({ admins: 7 }, (m) => assert.equal(m.admins, null));
  withManifest({ admins: true }, (m) => assert.equal(m.admins, null));
});

test('non-string, empty and over-long entries are dropped', () => {
  withManifest({ admins: ['alice', 42, null, '', '   ', {}, [], true, 'bob'] }, (m) => {
    assert.deepEqual(m.admins, ['alice', 'bob']);
  });
  withManifest({ admins: ['alice', 'x'.repeat(256)] }, (m) => {
    assert.deepEqual(m.admins, ['alice'], 'over the users.username width is dropped');
  });
  withManifest({ admins: ['x'.repeat(255)] }, (m) => {
    assert.equal(m.admins.length, 1, 'exactly at the bound is kept');
  });
});

test('entries are trimmed, and deduped case-insensitively (first casing wins)', () => {
  withManifest({ admins: ['  alice  ', 'ALICE', 'Alice', 'bob'] }, (m) => {
    assert.deepEqual(m.admins, ['alice', 'bob']);
  });
  withManifest({ admins: ['Alice', 'alice'] }, (m) => {
    assert.deepEqual(m.admins, ['Alice'], 'first occurrence keeps its display casing');
  });
});

test('the roster is capped at MAX_APP_ADMINS, extras dropped not silently kept', () => {
  const many = Array.from({ length: appManifest.MAX_APP_ADMINS + 5 }, (_, i) => `user${i}`);
  withManifest({ admins: many }, (m) => {
    assert.equal(m.admins.length, appManifest.MAX_APP_ADMINS);
    assert.equal(m.admins[0], 'user0', 'the kept slice is the first N, in order');
  });
});

test('readAdmins is callable directly on a parsed object', () => {
  assert.deepEqual(appManifest.readAdmins({ admins: ['a'] }), ['a']);
  assert.equal(appManifest.readAdmins({}), null);
  assert.equal(appManifest.readAdmins(null), null);
  assert.equal(appManifest.readAdmins(undefined), null);
});

test("read()'s three early-return literals all carry admins: null", () => {
  // ENOENT (no dapp.json), read failure, and parse failure must all
  // agree with the happy path's shape — a missing key here would make
  // `manifest.admins` undefined and silently skip the reconcile.
  withManifest(null, (m) => assert.ok('admins' in m && m.admins === null));
  withManifest('{not json', (m) => assert.ok('admins' in m && m.admins === null));
  withManifest({ secrets: [] }, (m) => assert.ok('admins' in m && m.admins === null));
});

test('describeAdmins matches the platform wording', () => {
  assert.equal(appManifest.describeAdmins(['alice', 'bob']), '@alice, @bob');
  assert.equal(appManifest.describeAdmins(['alice']), '@alice');
  assert.equal(appManifest.describeAdmins([]),
    'no per-app admins (only the creator and platform admins)');
  assert.equal(appManifest.describeAdmins(null),
    'no per-app admins (only the creator and platform admins)');
});

test('the admins block does not disturb its sibling blocks', () => {
  withManifest({
    name: 'Chess Club',
    admins: ['alice'],
    visibility: { build: 'private', view: 'private' },
    governance: { approvers: 'invited', approvals: 'default' },
  }, (m) => {
    assert.deepEqual(m.admins, ['alice']);
    assert.equal(m.name, 'Chess Club');
    assert.deepEqual(m.visibility, { build: 'private', view: 'private' });
    assert.deepEqual(m.governance, { approvers: 'invited', approvals: 'default' });
  });
});
