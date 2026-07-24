// Tests for the app file-storage service (#752, src/services/app-files.js):
// the pure image validation + quota logic, and the write/delete ordering
// contracts against a fake pool and a fake object store (no Postgres, no
// MinIO). Contracts pinned here:
//
//  - images only, magic-byte sniffed, extension must match the bytes;
//  - the 5 MB file cap and the app/user/staging quota caps with their
//    structured error codes;
//  - upload writes the OBJECT first and rolls it back if the metadata
//    INSERT fails (no orphaned rows pointing at nothing);
//  - delete removes the OBJECT first and keeps the row when that fails
//    (so a retry/sweep can reconcile);
//  - no configured store → storage_unavailable, never a crash.
//
// Run with: node --test tests/app-files.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const appFiles = require('../src/services/app-files');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)]);

// ── validateImageUpload ─────────────────────────────────────────────

test('accepts a valid png with matching extension', () => {
  const v = appFiles.validateImageUpload({ filename: 'photo.png', data: PNG });
  assert.equal(v.ok, true);
  assert.equal(v.contentType, 'image/png');
});

test('accepts jpg/jpeg extensions for jpeg bytes', () => {
  for (const name of ['a.jpg', 'a.jpeg']) {
    const v = appFiles.validateImageUpload({ filename: name, data: JPEG });
    assert.equal(v.ok, true, name);
    assert.equal(v.contentType, 'image/jpeg');
  }
});

test('rejects non-image extensions with invalid_image', () => {
  for (const name of ['notes.txt', 'page.html', 'vector.svg', 'noext']) {
    const v = appFiles.validateImageUpload({ filename: name, data: PNG });
    assert.equal(v.ok, false, name);
    assert.equal(v.code, 'invalid_image');
  }
});

test('rejects extension/bytes mismatch', () => {
  const v = appFiles.validateImageUpload({ filename: 'photo.png', data: JPEG });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'invalid_image');
});

test('rejects bytes that are not a real image', () => {
  const v = appFiles.validateImageUpload({ filename: 'photo.png', data: Buffer.alloc(64, 7) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'invalid_image');
});

test('rejects empty files and bad filenames', () => {
  assert.equal(appFiles.validateImageUpload({ filename: 'a.png', data: Buffer.alloc(0) }).ok, false);
  assert.equal(appFiles.validateImageUpload({ filename: '', data: PNG }).ok, false);
  assert.equal(appFiles.validateImageUpload({ filename: 'x'.repeat(300) + '.png', data: PNG }).ok, false);
});

test('rejects oversized files with file_too_large', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(appFiles.MAX_FILE_BYTES, 1)]);
  const v = appFiles.validateImageUpload({ filename: 'big.png', data: big });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'file_too_large');
});

// ── quotaVerdict ────────────────────────────────────────────────────

test('quota verdict: fits under all caps', () => {
  assert.equal(appFiles.quotaVerdict({
    size: 1000, appBytes: 0, userBytes: 0, stagingBytes: 0, staging: false,
  }), null);
});

test('quota verdict: per-app cap (2 GB)', () => {
  const v = appFiles.quotaVerdict({
    size: 1000, appBytes: appFiles.PER_APP_CAP - 10, userBytes: 0, stagingBytes: 0, staging: false,
  });
  assert.equal(v.code, 'app_quota_exceeded');
});

test('quota verdict: per-user cap (200 MB)', () => {
  const v = appFiles.quotaVerdict({
    size: 1000, appBytes: 0, userBytes: appFiles.PER_USER_PER_APP_CAP - 10, stagingBytes: 0, staging: false,
  });
  assert.equal(v.code, 'user_quota_exceeded');
});

test('quota verdict: staging cap only applies to staging uploads', () => {
  const base = { size: 1000, appBytes: 0, userBytes: 0, stagingBytes: appFiles.STAGING_PER_APP_CAP - 10 };
  assert.equal(appFiles.quotaVerdict({ ...base, staging: false }), null);
  assert.equal(appFiles.quotaVerdict({ ...base, staging: true }).code, 'staging_quota_exceeded');
});

// ── helpers ─────────────────────────────────────────────────────────

test('objectKey embeds the app id for prefix deletes', () => {
  assert.equal(appFiles.objectKey(42, 'a'.repeat(32)), `app/42/${'a'.repeat(32)}`);
});

test('normalizeVisibility defaults everything but private to public', () => {
  assert.equal(appFiles.normalizeVisibility('private'), 'private');
  assert.equal(appFiles.normalizeVisibility('public'), 'public');
  assert.equal(appFiles.normalizeVisibility('sneaky'), 'public');
  assert.equal(appFiles.normalizeVisibility(undefined), 'public');
});

test('fileUrl is an absolute platform URL keyed by id', () => {
  const url = appFiles.fileUrl('b'.repeat(32));
  assert.match(url, new RegExp(`^https://.+/app-files/${'b'.repeat(32)}$`));
});

// ── storeAppFile / deleteAppFile ordering ───────────────────────────

function fakePool({ failInsert = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT[\s\S]*FROM app_files WHERE app_id/.test(sql)) {
        return { rows: [{ app_bytes: '0', user_bytes: '0', staging_bytes: '0' }] };
      }
      if (/INSERT INTO app_files/.test(sql)) {
        if (failInsert) throw new Error('insert boom');
        return { rows: [] };
      }
      if (/SELECT id, user_id FROM app_files/.test(sql)) {
        return { rows: [{ id: params[0], user_id: 5 }] };
      }
      return { rows: [] };
    },
  };
}

function fakeStore({ failRemove = false } = {}) {
  const ops = [];
  return {
    ops,
    async putFile(appId, id, buf, contentType) { ops.push(['put', appId, id, contentType]); },
    async getFileStream() { throw new Error('not used'); },
    async removeFile(appId, id) {
      ops.push(['remove', appId, id]);
      if (failRemove) throw new Error('remove boom');
    },
    async removeAppPrefix() { return 0; },
  };
}

test('storeAppFile: object then row, returns the file shape', async () => {
  const pool = fakePool();
  const store = fakeStore();
  const r = await appFiles.storeAppFile(pool, store, {
    appId: 7, userId: 5, filename: 'dish.png', visibility: 'public', staging: false, data: PNG,
  });
  assert.equal(r.ok, true);
  assert.match(r.file.id, /^[a-f0-9]{32}$/);
  assert.equal(r.file.contentType, 'image/png');
  assert.equal(r.file.sizeBytes, PNG.length);
  assert.equal(r.file.visibility, 'public');
  assert.match(r.file.url, /\/app-files\//);
  assert.deepEqual(store.ops[0].slice(0, 2), ['put', 7]);
  assert.ok(pool.calls.some((c) => /INSERT INTO app_files/.test(c.sql)));
});

test('storeAppFile: failed INSERT rolls the object back', async () => {
  const pool = fakePool({ failInsert: true });
  const store = fakeStore();
  const r = await appFiles.storeAppFile(pool, store, {
    appId: 7, userId: 5, filename: 'dish.png', visibility: 'public', staging: false, data: PNG,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'upload_failed');
  assert.equal(store.ops.filter((o) => o[0] === 'put').length, 1);
  assert.equal(store.ops.filter((o) => o[0] === 'remove').length, 1);
});

test('storeAppFile: no store → storage_unavailable 503', async () => {
  const r = await appFiles.storeAppFile(fakePool(), null, {
    appId: 7, userId: 5, filename: 'dish.png', visibility: 'public', staging: false, data: PNG,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.code, 'storage_unavailable');
});

test('deleteAppFile: object delete failure keeps the row', async () => {
  const pool = fakePool();
  const store = fakeStore({ failRemove: true });
  const r = await appFiles.deleteAppFile(pool, store, { appId: 7, fileId: 'c'.repeat(32) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'storage_unavailable');
  assert.ok(!pool.calls.some((c) => /DELETE FROM app_files/.test(c.sql)));
});

test('deleteAppFile: uploader gate 404s on someone else\'s file', async () => {
  const pool = fakePool(); // stored row's user_id is 5
  const store = fakeStore();
  const r = await appFiles.deleteAppFile(pool, store, {
    appId: 7, fileId: 'c'.repeat(32), requireUserId: 9,
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(store.ops.length, 0);
});

test('deleteAppFile: malformed id 404s without querying', async () => {
  const pool = fakePool();
  const r = await appFiles.deleteAppFile(pool, fakeStore(), { appId: 7, fileId: 'not-an-id' });
  assert.equal(r.status, 404);
  assert.equal(pool.calls.length, 0);
});
