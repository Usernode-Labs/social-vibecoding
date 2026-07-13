const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');

function readManifest(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-listing-'));
  try {
    fs.writeFileSync(path.join(dir, 'dapp.json'), JSON.stringify(content));
    return appManifest.read(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mockPool(row) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT category, tagline FROM apps/.test(sql)) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  };
}

test('listing parser accepts the launch vocabulary and trims the tagline', () => {
  const manifest = readManifest({
    listing: { category: 'game', tagline: '  Guess the number with friends  ' },
  });
  assert.deepEqual(manifest.listing, {
    category: 'game',
    tagline: 'Guess the number with friends',
  });
});

test('listing parser ignores invalid fields without dropping a valid sibling', () => {
  const manifest = readManifest({
    listing: { category: 'finance', tagline: 'A useful tool' },
  });
  assert.deepEqual(manifest.listing, { category: null, tagline: 'A useful tool' });
  assert.equal(readManifest({ listing: { category: 'game', tagline: 'x'.repeat(81) } }).listing.category, 'game');
});

test('listing reconcile seeds only null database columns', async () => {
  const pool = mockPool({ category: null, tagline: null });
  const changed = await appManifest.reconcileAppListing(
    pool,
    { id: 5, slug: 'demo' },
    { listing: { category: 'tool', tagline: 'Plan the next release' } }
  );
  assert.equal(changed, true);
  const update = pool.calls.find((call) => /UPDATE apps SET category/.test(call.sql));
  assert.deepEqual(update.params, ['tool', 'Plan the next release', 5]);
});

test('listing reconcile never overwrites platform edits on redeploy', async () => {
  const pool = mockPool({ category: 'game', tagline: 'Edited in Usernode' });
  const changed = await appManifest.reconcileAppListing(
    pool,
    { id: 5, slug: 'demo' },
    { listing: { category: 'tool', tagline: 'From the repo' } }
  );
  assert.equal(changed, false);
  assert.ok(!pool.calls.some((call) => /UPDATE apps SET category/.test(call.sql)));
});

test('listing reconcile can seed one null field without replacing the other', async () => {
  const pool = mockPool({ category: 'game', tagline: null });
  const changed = await appManifest.reconcileAppListing(
    pool,
    { id: 5, slug: 'demo' },
    { listing: { category: 'tool', tagline: 'Seeded once' } }
  );
  assert.equal(changed, true);
  const update = pool.calls.find((call) => /UPDATE apps SET category/.test(call.sql));
  assert.deepEqual(update.params, ['game', 'Seeded once', 5]);
});
