// Tests for the dapp.json `icon` block: the top-level
// `icon.emoji` / `icon.image` parsed leniently by
// src/services/app-manifest.js readIcon, plus the deploy-time
// reconcileAppIcon that persists it onto apps.icon_emoji /
// apps.icon_image_id and the app_icons blob table. The manifest is
// fully authoritative for the icon: an absent block clears everything
// back to the letter-tile fallback.
//
// Run with: node --test tests/app-manifest-icon.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-icon-'));
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

// Smallest thing the sniffers accept as a PNG: the 8-byte magic plus
// padding past the 12-byte sniff window. Content beyond the magic is
// irrelevant — validation is magic-bytes + size only, by design.
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 0x42),
]);
const FAKE_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(16, 0x42),
]);

// ── readIcon parsing matrix ───────────────────────────────────────────

test('valid emoji passes through', () => {
  withManifest({ secrets: [], icon: { emoji: '🎮' } }, (m) => {
    assert.deepEqual(m.icon, { emoji: '🎮', image: null });
  });
});

test('ZWJ emoji sequence within the length cap passes', () => {
  withManifest({ icon: { emoji: '👨‍👩‍👧‍👦' } }, (m) => {
    assert.equal(m.icon.emoji, '👨‍👩‍👧‍👦');
  });
});

test('emoji is trimmed', () => {
  withManifest({ icon: { emoji: '  🚀  ' } }, (m) => {
    assert.equal(m.icon.emoji, '🚀');
  });
});

test('emoji with interior whitespace is rejected', () => {
  withManifest({ icon: { emoji: 'a b' } }, (m) => {
    assert.equal(m.icon, null);
  });
});

test('overlong emoji string is rejected', () => {
  withManifest({ icon: { emoji: 'x'.repeat(17) } }, (m) => {
    assert.equal(m.icon, null);
  });
});

test('non-string emoji is rejected', () => {
  withManifest({ icon: { emoji: 42 } }, (m) => {
    assert.equal(m.icon, null);
  });
});

test('valid image path passes through', () => {
  withManifest({ icon: { image: 'public/icon.png' } }, (m) => {
    assert.deepEqual(m.icon, { emoji: null, image: 'public/icon.png' });
  });
});

test('both keys are retained (image wins at reconcile time)', () => {
  withManifest({ icon: { emoji: '🎮', image: 'icon.png' } }, (m) => {
    assert.deepEqual(m.icon, { emoji: '🎮', image: 'icon.png' });
  });
});

test('absolute, traversing, scheme, whitespace and backslash paths are rejected', () => {
  for (const bad of [
    '/etc/passwd',
    '../outside.png',
    'a/../../b.png',
    'https://evil.example/icon.png',
    'data:image/png;base64,x',
    'has space.png',
    'win\\path.png',
    'x'.repeat(300),
    '',
  ]) {
    withManifest({ icon: { image: bad } }, (m) => {
      assert.equal(m.icon, null, `expected rejection for ${JSON.stringify(bad)}`);
    });
  }
});

test('absent / null / non-object icon block resolves to null', () => {
  withManifest({ secrets: [] }, (m) => assert.equal(m.icon, null));
  withManifest({ icon: null }, (m) => assert.equal(m.icon, null));
  withManifest({ icon: 'emoji' }, (m) => assert.equal(m.icon, null));
  withManifest({ icon: ['🎮'] }, (m) => assert.equal(m.icon, null));
  withManifest({ icon: {} }, (m) => assert.equal(m.icon, null));
});

test('missing / unparseable manifest resolves icon to null', () => {
  withManifest(null, (m) => assert.equal(m.icon, null));
  withManifest('{nope', (m) => assert.equal(m.icon, null));
});

// ── reconcileAppIcon ──────────────────────────────────────────────────
//
// Scripted mock pool: answers the current-columns SELECT and the
// app_icons lookup from injected state, records every write. The
// best-effort ws broadcast no-ops via its own try/catch.

function mockPool({ appRow, iconRow } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT icon_emoji, icon_image_id FROM apps/.test(sql)) {
        return { rows: appRow ? [appRow] : [] };
      }
      if (/SELECT id, sha256 FROM app_icons/.test(sql)) {
        return { rows: iconRow ? [iconRow] : [] };
      }
      return { rows: [] };
    },
  };
}

const APP = { id: 5, slug: 'demo', name: 'Demo' };
const updates = (pool) => pool.calls.filter((c) => /UPDATE apps SET icon_emoji/.test(c.sql));
const inserts = (pool) => pool.calls.filter((c) => /INSERT INTO app_icons/.test(c.sql));
const deletes = (pool) => pool.calls.filter((c) => /DELETE FROM app_icons/.test(c.sql));

async function withCloneDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-clone-'));
  try {
    for (const [rel, data] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
    }
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('reconcile: emoji applies to apps.icon_emoji', async () => {
  const pool = mockPool({ appRow: { icon_emoji: null, icon_image_id: null } });
  const changed = await appManifest.reconcileAppIcon(
    pool, APP, { icon: { emoji: '🎮', image: null } }, null
  );
  assert.equal(changed, true);
  assert.equal(updates(pool).length, 1);
  assert.deepEqual(updates(pool)[0].params, ['🎮', null, APP.id]);
  assert.equal(inserts(pool).length, 0);
});

test('reconcile: unchanged emoji is a no-op', async () => {
  const pool = mockPool({ appRow: { icon_emoji: '🎮', icon_image_id: null } });
  const changed = await appManifest.reconcileAppIcon(
    pool, APP, { icon: { emoji: '🎮', image: null } }, null
  );
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});

test('reconcile: absent block clears a stored icon', async () => {
  const pool = mockPool({ appRow: { icon_emoji: null, icon_image_id: 'a'.repeat(32) } });
  const changed = await appManifest.reconcileAppIcon(pool, APP, { icon: null }, null);
  assert.equal(changed, true);
  assert.equal(deletes(pool).length, 1);
  assert.deepEqual(updates(pool)[0].params, [null, null, APP.id]);
});

test('reconcile: absent block with no stored icon is a no-op', async () => {
  const pool = mockPool({ appRow: { icon_emoji: null, icon_image_id: null } });
  const changed = await appManifest.reconcileAppIcon(pool, APP, { icon: null }, null);
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});

test('reconcile: image stores bytes into app_icons and points the app at it', async () => {
  await withCloneDir({ 'public/icon.png': FAKE_PNG }, async (dir) => {
    const pool = mockPool({ appRow: { icon_emoji: null, icon_image_id: null } });
    const changed = await appManifest.reconcileAppIcon(
      pool, APP, { icon: { emoji: null, image: 'public/icon.png' } }, dir
    );
    assert.equal(changed, true);
    assert.equal(inserts(pool).length, 1);
    const [id, appId, contentType, data, sha] = inserts(pool)[0].params;
    assert.match(id, /^[a-f0-9]{32}$/);
    assert.equal(appId, APP.id);
    assert.equal(contentType, 'image/png');
    assert.ok(Buffer.isBuffer(data) && data.equals(FAKE_PNG));
    assert.equal(sha, crypto.createHash('sha256').update(FAKE_PNG).digest('hex'));
    // The apps row points at the freshly inserted id.
    assert.deepEqual(updates(pool)[0].params, [null, id, APP.id]);
  });
});

test('reconcile: unchanged image bytes keep the stored id (no-op)', async () => {
  await withCloneDir({ 'icon.jpg': FAKE_JPEG }, async (dir) => {
    const sha = crypto.createHash('sha256').update(FAKE_JPEG).digest('hex');
    const existingId = 'b'.repeat(32);
    const pool = mockPool({
      appRow: { icon_emoji: null, icon_image_id: existingId },
      iconRow: { id: existingId, sha256: sha },
    });
    const changed = await appManifest.reconcileAppIcon(
      pool, APP, { icon: { emoji: null, image: 'icon.jpg' } }, dir
    );
    assert.equal(changed, false);
    assert.equal(inserts(pool).length, 0);
    assert.equal(deletes(pool).length, 0);
    assert.equal(updates(pool).length, 0);
  });
});

test('reconcile: changed image bytes rotate to a fresh id', async () => {
  await withCloneDir({ 'icon.png': FAKE_PNG }, async (dir) => {
    const existingId = 'c'.repeat(32);
    const pool = mockPool({
      appRow: { icon_emoji: null, icon_image_id: existingId },
      iconRow: { id: existingId, sha256: 'stale-sha' },
    });
    const changed = await appManifest.reconcileAppIcon(
      pool, APP, { icon: { emoji: null, image: 'icon.png' } }, dir
    );
    assert.equal(changed, true);
    assert.equal(deletes(pool).length, 1);
    assert.equal(inserts(pool).length, 1);
    const newId = inserts(pool)[0].params[0];
    assert.notEqual(newId, existingId);
    assert.deepEqual(updates(pool)[0].params, [null, newId, APP.id]);
  });
});

test('reconcile: missing image file falls back to the declared emoji', async () => {
  await withCloneDir({}, async (dir) => {
    const pool = mockPool({ appRow: { icon_emoji: null, icon_image_id: null } });
    const changed = await appManifest.reconcileAppIcon(
      pool, APP, { icon: { emoji: '🎮', image: 'nope.png' } }, dir
    );
    assert.equal(changed, true);
    assert.deepEqual(updates(pool)[0].params, ['🎮', null, APP.id]);
    assert.equal(inserts(pool).length, 0);
  });
});

test('reconcile: invalid image with no emoji clears the icon', async () => {
  await withCloneDir({ 'notes.txt': Buffer.from('plain text file, long enough') }, async (dir) => {
    const pool = mockPool({ appRow: { icon_emoji: '🎮', icon_image_id: null } });
    const changed = await appManifest.reconcileAppIcon(
      pool, APP, { icon: { emoji: null, image: 'notes.txt' } }, dir
    );
    assert.equal(changed, true);
    assert.deepEqual(updates(pool)[0].params, [null, null, APP.id]);
  });
});

test('reconcile: oversized image is rejected', async () => {
  const big = Buffer.concat([FAKE_PNG, Buffer.alloc(256 * 1024, 0)]);
  await withCloneDir({ 'big.png': big }, async (dir) => {
    const pool = mockPool({ appRow: { icon_emoji: null, icon_image_id: null } });
    const changed = await appManifest.reconcileAppIcon(
      pool, APP, { icon: { emoji: null, image: 'big.png' } }, dir
    );
    assert.equal(changed, false);
    assert.equal(inserts(pool).length, 0);
    assert.equal(updates(pool).length, 0);
  });
});

test('reconcile: symlink escaping the clone is rejected', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.png'), FAKE_PNG);
    await withCloneDir({}, async (dir) => {
      fs.symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'icon.png'));
      const pool = mockPool({ appRow: { icon_emoji: null, icon_image_id: null } });
      const changed = await appManifest.reconcileAppIcon(
        pool, APP, { icon: { emoji: null, image: 'icon.png' } }, dir
      );
      assert.equal(changed, false);
      assert.equal(inserts(pool).length, 0);
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('reconcile: missing app row is a no-op', async () => {
  const pool = mockPool({ appRow: null });
  const changed = await appManifest.reconcileAppIcon(
    pool, APP, { icon: { emoji: '🎮', image: null } }, null
  );
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});
