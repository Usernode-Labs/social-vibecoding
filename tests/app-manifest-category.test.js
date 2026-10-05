// Tests for the dapp.json `category` line: the top-level one-word kind
// parsed leniently by src/services/app-manifest.js readCategory, plus the
// deploy-time reconcileAppCategory that persists it onto apps.category. The
// manifest is fully authoritative for the kind, like the icon: an absent
// line clears the column, so a proposal that drops a project's kind also
// unshelves it in Discover.
//
// Run with: node --test tests/app-manifest-category.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');
const createOptions = require('../src/services/create-options');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-category-'));
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

// ── readCategory parsing matrix ───────────────────────────────────────

test('each declared slug reads back lowercase', () => {
  for (const slug of createOptions.CATEGORIES) {
    withManifest({ category: slug }, (m) => assert.equal(m.category, slug));
    withManifest({ category: slug.toUpperCase() }, (m) => assert.equal(m.category, slug, `expected ${slug} case-insensitive`));
  }
});

test('the slug is trimmed', () => {
  withManifest({ category: '  games  ' }, (m) => assert.equal(m.category, 'games'));
});

test('a kind one surface drops and the other keeps would be a wrong chip', () => {
  // The create screen's list and the dapp.json reader are one list, by
  // construction — CATEGORIES is imported, not copied.
  assert.equal(appManifest.readCategory({ category: 'fun' }), createOptions.CATEGORIES.includes('fun') ? 'fun' : null);
});

test('unknown, "other" and non-string values are ignored with a warn, never a throw', () => {
  for (const bad of ['other', 'shopping', 'GAME', 'gaming', '', 42, true, {}, []]) {
    withManifest({ category: bad }, (m) => {
      assert.equal(m.category, null, `expected ${JSON.stringify(bad)} ignored`);
    });
  }
});

test('absent / null category resolves to null', () => {
  withManifest({ secrets: [] }, (m) => assert.equal(m.category, null));
  withManifest({ category: null }, (m) => assert.equal(m.category, null));
});

test('missing / unparseable manifest resolves category to null', () => {
  withManifest(null, (m) => assert.equal(m.category, null));
  withManifest('{nope', (m) => assert.equal(m.category, null));
});

// ── reconcileAppCategory ──────────────────────────────────────────────
//
// Scripted mock pool: answers the current-column SELECT from injected
// state, records every write.

function mockPool({ appRow } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT category FROM apps/.test(sql)) {
        return { rows: appRow ? [appRow] : [] };
      }
      return { rows: [] };
    },
  };
}

const APP = { id: 5, slug: 'demo' };
const updates = (pool) => pool.calls.filter((c) => /UPDATE apps SET category/.test(c.sql));

test('reconcile: a declared kind applies to apps.category', async () => {
  const pool = mockPool({ appRow: { category: null } });
  const changed = await appManifest.reconcileAppCategory(pool, APP, { category: 'games' });
  assert.equal(changed, true);
  assert.equal(updates(pool).length, 1);
  assert.deepEqual(updates(pool)[0].params, ['games', APP.id]);
});

test('reconcile: unchanged kind is a no-op', async () => {
  const pool = mockPool({ appRow: { category: 'games' } });
  const changed = await appManifest.reconcileAppCategory(pool, APP, { category: 'games' });
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});

test('reconcile: a removed line clears the column', async () => {
  const pool = mockPool({ appRow: { category: 'games' } });
  const changed = await appManifest.reconcileAppCategory(pool, APP, {});
  assert.equal(changed, true);
  assert.deepEqual(updates(pool)[0].params, [null, APP.id]);
});

test('reconcile: an unknown declared value clears like an absent line', async () => {
  const pool = mockPool({ appRow: { category: 'games' } });
  const changed = await appManifest.reconcileAppCategory(pool, APP, { category: 'shopping' });
  assert.equal(changed, true);
  assert.deepEqual(updates(pool)[0].params, [null, APP.id]);
});

test('reconcile: absent line with nothing stored is a no-op', async () => {
  const pool = mockPool({ appRow: { category: null } });
  const changed = await appManifest.reconcileAppCategory(pool, APP, {});
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});

test('reconcile: null in the row reads as nothing stored', async () => {
  const pool = mockPool({ appRow: { category: null } });
  const changed = await appManifest.reconcileAppCategory(pool, APP, { category: null });
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});

test('reconcile: missing app row is a no-op', async () => {
  const pool = mockPool({ appRow: null });
  const changed = await appManifest.reconcileAppCategory(pool, APP, { category: 'games' });
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});
