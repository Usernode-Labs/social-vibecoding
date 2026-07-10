// Tests for the dapp.json `listing` block: the top-level
// `listing.category` / `listing.tagline` parsed leniently by
// src/services/app-manifest.js readListing, plus the deploy-time
// reconcileAppListing. Unlike the icon reconcile, the listing block is
// SEED-ONLY: a field is written only while the DB column is currently
// NULL, so an in-app edit (PATCH /api/apps/:slug/listing) always wins
// over every later redeploy, and an absent block never clears anything.
//
// Run with: node --test tests/app-manifest-listing.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-listing-'));
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

// ── readListing parsing matrix ───────────────────────────────────────

test('valid category and tagline pass through', () => {
  withManifest({ secrets: [], listing: { category: 'game', tagline: 'Guess the number' } }, (m) => {
    assert.deepEqual(m.listing, { category: 'game', tagline: 'Guess the number' });
  });
});

test('category is trimmed and lowercased', () => {
  withManifest({ secrets: [], listing: { category: ' Tool ' } }, (m) => {
    assert.deepEqual(m.listing, { category: 'tool', tagline: null });
  });
});

test('invalid category is dropped, valid tagline kept', () => {
  withManifest({ secrets: [], listing: { category: 'casino', tagline: 'Spin it' } }, (m) => {
    assert.deepEqual(m.listing, { category: null, tagline: 'Spin it' });
  });
});

test('over-long tagline is dropped', () => {
  withManifest({ secrets: [], listing: { tagline: 'x'.repeat(81) } }, (m) => {
    assert.equal(m.listing, null);
  });
});

test('tagline with control characters is dropped', () => {
  withManifest({ secrets: [], listing: { tagline: 'line one\nline two' } }, (m) => {
    assert.equal(m.listing, null);
  });
});

test('non-object listing block is ignored', () => {
  withManifest({ secrets: [], listing: 'game' }, (m) => {
    assert.equal(m.listing, null);
  });
});

test('absent block and absent manifest both read as null', () => {
  withManifest({ secrets: [] }, (m) => assert.equal(m.listing, null));
  withManifest(null, (m) => assert.equal(m.listing, null));
});

// ── reconcileAppListing seed-only semantics ──────────────────────────

// Minimal pool stub: SELECT returns the current row; UPDATE records
// its params so the write (or its absence) can be asserted.
function makePool(currentRow) {
  const updates = [];
  return {
    updates,
    query: async (sql, params) => {
      if (/^SELECT category, tagline/.test(sql.trim())) {
        return { rows: currentRow ? [currentRow] : [] };
      }
      if (/UPDATE apps/.test(sql)) {
        updates.push(params);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const APP = { id: 5, slug: 'demo' };

test('NULL columns get seeded from the manifest', async () => {
  const pool = makePool({ category: null, tagline: null });
  const changed = await appManifest.reconcileAppListing(pool, APP, {
    listing: { category: 'game', tagline: 'Guess the number' },
  });
  assert.equal(changed, true);
  assert.equal(pool.updates.length, 1);
  assert.deepEqual(pool.updates[0], ['game', 'Guess the number', 5]);
});

test('non-NULL columns are untouched by a redeploy (UI edits win)', async () => {
  const pool = makePool({ category: 'tool', tagline: 'Edited in the app' });
  const changed = await appManifest.reconcileAppListing(pool, APP, {
    listing: { category: 'game', tagline: 'Manifest value' },
  });
  assert.equal(changed, false);
  assert.equal(pool.updates.length, 0);
});

test('only the still-NULL field is seeded on a mixed row', async () => {
  const pool = makePool({ category: 'game', tagline: null });
  const changed = await appManifest.reconcileAppListing(pool, APP, {
    listing: { category: 'tool', tagline: 'Fresh tagline' },
  });
  assert.equal(changed, true);
  assert.equal(pool.updates.length, 1);
  // category param is null (COALESCE keeps the stored 'game'),
  // tagline seeds.
  assert.deepEqual(pool.updates[0], [null, 'Fresh tagline', 5]);
});

test('absent listing block is a no-op, never a clear', async () => {
  const pool = makePool({ category: 'game', tagline: 'Keep me' });
  const changed = await appManifest.reconcileAppListing(pool, APP, { listing: null });
  assert.equal(changed, false);
  assert.equal(pool.updates.length, 0);
});
