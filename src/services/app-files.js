'use strict';

// App file storage (#752): user-uploaded images apps store through the
// platform. Bytes live in the MinIO object-store sidecar (compose
// service `usernode-minio`, reachable only from the platform over the
// internal `usernode-storage` network); Postgres's `app_files` table
// holds metadata only (ownership, quotas, visibility).
//
// Layout mirrors services/attachments.js: everything that doesn't take
// a `pool` or a `store` is PURE so tests/app-files.test.js can exercise
// validation without Postgres or MinIO. The object-store wrapper is
// injectable (route factories accept a `store` override) so route tests
// pass a fake client.

const crypto = require('crypto');
const { sniffImageType, fileExt } = require('./attachments');
const log = require('./logger');

// ── Limits ──────────────────────────────────────────────────────────
// v1 accepts images only (the issue's scope). 5 MB fits phone JPEGs;
// there is deliberately no server-side resizing (that would need a
// native dep like sharp) — apps should downscale client-side.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Object storage removes the DB-bloat constraint, so the caps are
// generous: ~a hundred phone photos per user per app.
const PER_APP_CAP = 2 * 1024 * 1024 * 1024; // 2 GB
const PER_USER_PER_APP_CAP = 200 * 1024 * 1024; // 200 MB
// Staging-preview uploads (bridge relay path) are capped tighter and
// GC'd by the server.js sweeper after STAGING_GC_DAYS regardless.
const STAGING_PER_APP_CAP = 100 * 1024 * 1024; // 100 MB
const STAGING_GC_DAYS = 7;

// Mirrors attachments.js's image map (not exported there; images-only
// v1 keeps this a 4-line duplication rather than a cross-module export).
const IMAGE_EXT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// ── Pure validation ─────────────────────────────────────────────────

// Image-only upload validation. Returns { ok: true, contentType } or
// { ok: false, code, error } with a user-facing message. Same rules as
// attachments.validateUpload's image branch: magic-byte sniff, never
// trust the client's Content-Type, extension must agree with the bytes.
function validateImageUpload({ filename, data }) {
  const name = String(filename || '').trim();
  if (!name || name.length > 256) {
    return { ok: false, code: 'invalid_image', error: 'Bad filename (must be 1-256 characters)' };
  }
  if (!Buffer.isBuffer(data) || !data.length) {
    return { ok: false, code: 'invalid_image', error: 'Empty file' };
  }
  if (data.length > MAX_FILE_BYTES) {
    return {
      ok: false, code: 'file_too_large',
      error: `Image too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB)`,
    };
  }
  const ext = fileExt(name);
  if (!IMAGE_EXT_TYPES[ext]) {
    return {
      ok: false, code: 'invalid_image',
      error: `"${name}" isn't a supported image type (PNG, JPEG, GIF, or WebP)`,
    };
  }
  const sniffed = sniffImageType(data);
  if (!sniffed) {
    return {
      ok: false, code: 'invalid_image',
      error: `"${name}" doesn't look like a valid PNG/JPEG/GIF/WebP image`,
    };
  }
  if (sniffed !== IMAGE_EXT_TYPES[ext]) {
    return {
      ok: false, code: 'invalid_image',
      error: `"${name}" extension doesn't match its actual image format`,
    };
  }
  return { ok: true, contentType: sniffed };
}

function normalizeVisibility(raw) {
  return raw === 'private' ? 'private' : 'public';
}

// Object key: the per-app prefix enables bulk prefix deletion when an
// app is removed (removeAppPrefix below).
function objectKey(appId, fileId) {
  return `app/${appId}/${fileId}`;
}

// The stable, absolute URL an app persists in its own DB. Apex-host
// based so it works identically from production and staging containers
// and survives any future storage-backend move (serving is
// platform-proxied, never a direct object-store URL).
function fileUrl(id) {
  // Lazy require avoids a cycle if caddy ever grows a dep on services.
  const { USERNODE_DOMAIN } = require('./caddy');
  return `https://${USERNODE_DOMAIN}/app-files/${id}`;
}

// ── Object-store wrapper (MinIO / any S3-compatible endpoint) ───────
//
// Constructed from config; absent config (no MINIO_ENDPOINT / creds in
// env) yields null and every route degrades to a clear
// `storage_unavailable` error instead of crashing. Bucket creation is
// lazy and retried per call so a MinIO that comes up after the platform
// (depends_on is service_started, not service_healthy) heals itself.
function createObjectStore(config) {
  const endpoint = config?.storageEndpoint;
  const accessKey = config?.storageAccessKey;
  const secretKey = config?.storageSecretKey;
  const bucket = config?.storageBucket || 'usernode-app-files';
  if (!endpoint || !accessKey || !secretKey) return null;

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    log.error('app-files', 'Invalid storage endpoint URL', { endpoint });
    return null;
  }
  const Minio = require('minio');
  const client = new Minio.Client({
    endPoint: url.hostname,
    port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80),
    useSSL: url.protocol === 'https:',
    accessKey,
    secretKey,
  });

  let bucketReady = false;
  async function ensureBucket() {
    if (bucketReady) return;
    const exists = await client.bucketExists(bucket);
    if (!exists) {
      await client.makeBucket(bucket).catch(async (err) => {
        // Concurrent first-uploads can race makeBucket; a bucket that
        // exists after the error is a win, not a failure.
        if (await client.bucketExists(bucket).catch(() => false)) return;
        throw err;
      });
    }
    bucketReady = true;
  }

  return {
    bucket,
    async putFile(appId, fileId, buffer, contentType) {
      await ensureBucket();
      await client.putObject(bucket, objectKey(appId, fileId), buffer, buffer.length, {
        'Content-Type': contentType,
      });
    },
    async getFileStream(appId, fileId) {
      return client.getObject(bucket, objectKey(appId, fileId));
    },
    async removeFile(appId, fileId) {
      await client.removeObject(bucket, objectKey(appId, fileId));
    },
    // Bulk delete of every object under app/<appId>/ — the app-deletion
    // cleanup path. Streams the listing so a large app doesn't buffer
    // its whole key set.
    async removeAppPrefix(appId) {
      await ensureBucket();
      const prefix = `app/${appId}/`;
      const keys = [];
      await new Promise((resolve, reject) => {
        const stream = client.listObjectsV2(bucket, prefix, true);
        stream.on('data', (obj) => { if (obj?.name) keys.push(obj.name); });
        stream.on('error', reject);
        stream.on('end', resolve);
      });
      if (keys.length) await client.removeObjects(bucket, keys);
      return keys.length;
    },
  };
}

// Module-level singleton for server.js / route factories. Tests inject
// their own store through the route factories' `deps` param instead.
let _store;
let _storeInitialized = false;
function getStore(config) {
  if (!_storeInitialized) {
    _store = createObjectStore(config);
    _storeInitialized = true;
    if (!_store) {
      log.warn('app-files', 'Object storage not configured — app file uploads disabled '
        + '(set MINIO_ENDPOINT / MINIO_ROOT_USER / MINIO_ROOT_PASSWORD)');
    }
  }
  return _store;
}

// ── Quota + persistence helpers ─────────────────────────────────────

async function usageSums(pool, appId, userId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(size_bytes), 0)::bigint AS app_bytes,
       COALESCE(SUM(size_bytes) FILTER (WHERE user_id = $2), 0)::bigint AS user_bytes,
       COALESCE(SUM(size_bytes) FILTER (WHERE staging), 0)::bigint AS staging_bytes
     FROM app_files WHERE app_id = $1`,
    [appId, userId]
  );
  return {
    appBytes: Number(rows[0].app_bytes),
    userBytes: Number(rows[0].user_bytes),
    stagingBytes: Number(rows[0].staging_bytes),
  };
}

// Pure: quota verdict for an upload of `size` bytes given current sums.
// Returns null when the upload fits, else { code, error }.
function quotaVerdict({ size, appBytes, userBytes, stagingBytes, staging }) {
  if (staging && stagingBytes + size > STAGING_PER_APP_CAP) {
    return {
      code: 'staging_quota_exceeded',
      error: `Staging upload storage for this app is full (${Math.round(STAGING_PER_APP_CAP / 1024 / 1024)} MB max)`,
    };
  }
  if (appBytes + size > PER_APP_CAP) {
    return {
      code: 'app_quota_exceeded',
      error: `This app's file storage is full (${Math.round(PER_APP_CAP / 1024 / 1024 / 1024)} GB max)`,
    };
  }
  if (userBytes + size > PER_USER_PER_APP_CAP) {
    return {
      code: 'user_quota_exceeded',
      error: `Your file storage in this app is full (${Math.round(PER_USER_PER_APP_CAP / 1024 / 1024)} MB max)`,
    };
  }
  return null;
}

// Full upload: validate → quota-check → put object → insert metadata.
// Object first, row second; on INSERT failure the object is best-effort
// removed so it can't leak (a row-less object is invisible anyway).
// Returns { ok: true, file } or { ok: false, status, code, error }.
async function storeAppFile(pool, store, { appId, userId, filename, visibility, staging, data }) {
  if (!store) {
    return { ok: false, status: 503, code: 'storage_unavailable', error: 'File storage is unavailable right now' };
  }
  const verdict = validateImageUpload({ filename, data });
  if (!verdict.ok) {
    return { ok: false, status: 400, code: verdict.code, error: verdict.error };
  }
  const sums = await usageSums(pool, appId, userId);
  const quota = quotaVerdict({ size: data.length, ...sums, staging: !!staging });
  if (quota) return { ok: false, status: 400, code: quota.code, error: quota.error };

  const id = crypto.randomBytes(16).toString('hex');
  try {
    await store.putFile(appId, id, data, verdict.contentType);
  } catch (err) {
    log.error('app-files', 'Object store put failed', { appId, err: err.message });
    return { ok: false, status: 503, code: 'storage_unavailable', error: 'File storage is unavailable right now' };
  }
  try {
    await pool.query(
      `INSERT INTO app_files (id, app_id, user_id, filename, content_type, size_bytes, visibility, staging)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, appId, userId, String(filename).trim(), verdict.contentType, data.length,
       normalizeVisibility(visibility), !!staging]
    );
  } catch (err) {
    log.error('app-files', 'Metadata insert failed; removing object', { appId, id, err: err.message });
    await store.removeFile(appId, id).catch(() => {});
    return { ok: false, status: 500, code: 'upload_failed', error: 'Upload failed' };
  }
  return {
    ok: true,
    file: {
      id,
      url: fileUrl(id),
      filename: String(filename).trim(),
      contentType: verdict.contentType,
      sizeBytes: data.length,
      visibility: normalizeVisibility(visibility),
    },
  };
}

// Deletion: object first, row second — a failed object delete leaves
// the row so a retry (or the staging sweep) can reconcile, while a
// deleted object with a lingering row just 404s on serve.
// `requireUserId` (bridge path) restricts to the uploader's own files;
// the server path (takedowns) passes null and deletes any app file.
async function deleteAppFile(pool, store, { appId, fileId, requireUserId = null }) {
  if (!store) {
    return { ok: false, status: 503, code: 'storage_unavailable', error: 'File storage is unavailable right now' };
  }
  if (!/^[a-f0-9]{32}$/.test(String(fileId || ''))) {
    return { ok: false, status: 404, code: 'not_found', error: 'File not found' };
  }
  const { rows } = await pool.query(
    'SELECT id, user_id FROM app_files WHERE id = $1 AND app_id = $2',
    [fileId, appId]
  );
  if (!rows.length || (requireUserId != null && rows[0].user_id !== requireUserId)) {
    return { ok: false, status: 404, code: 'not_found', error: 'File not found' };
  }
  try {
    await store.removeFile(appId, fileId);
  } catch (err) {
    log.error('app-files', 'Object store delete failed', { appId, fileId, err: err.message });
    return { ok: false, status: 503, code: 'storage_unavailable', error: 'File storage is unavailable right now' };
  }
  await pool.query('DELETE FROM app_files WHERE id = $1 AND app_id = $2', [fileId, appId]);
  return { ok: true };
}

async function usageReport(pool, appId, userId) {
  const sums = await usageSums(pool, appId, userId);
  return {
    appBytes: sums.appBytes,
    appCapBytes: PER_APP_CAP,
    userBytes: sums.userBytes,
    userCapBytes: PER_USER_PER_APP_CAP,
  };
}

// Staging-upload GC (server.js sweeper): remove objects for staging
// rows past STAGING_GC_DAYS, deleting each row only after its object
// removal succeeded so failures retry on the next sweep.
async function sweepStagingFiles(pool, store, { limit = 200 } = {}) {
  if (!store) return 0;
  const { rows } = await pool.query(
    `SELECT id, app_id FROM app_files
      WHERE staging AND created_at < NOW() - INTERVAL '${STAGING_GC_DAYS} days'
      ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );
  let removed = 0;
  for (const row of rows) {
    try {
      await store.removeFile(row.app_id, row.id);
      await pool.query('DELETE FROM app_files WHERE id = $1', [row.id]);
      removed++;
    } catch (err) {
      log.warn('app-files', 'Staging file GC failed; will retry next sweep', {
        id: row.id, appId: row.app_id, err: err.message,
      });
    }
  }
  return removed;
}

module.exports = {
  MAX_FILE_BYTES,
  PER_APP_CAP,
  PER_USER_PER_APP_CAP,
  STAGING_PER_APP_CAP,
  STAGING_GC_DAYS,
  IMAGE_EXT_TYPES,
  validateImageUpload,
  normalizeVisibility,
  quotaVerdict,
  objectKey,
  fileUrl,
  createObjectStore,
  getStore,
  usageSums,
  storeAppFile,
  deleteAppFile,
  usageReport,
  sweepStagingFiles,
};
