'use strict';

// One bounded batch of the media-check-visuals-backfill workflow clock.
// The committed key is its checkpoint, including for merged proposals:
// no age filter, no changed ids, no new retention deletion.
const media = require('./media-store');
const { metadata } = require('./check-visual-media');

const TABLES = [
  {
    name: 'check_run_media',
    read: (tx) => tx.query(`SELECT id, data, sha256, content_type FROM check_run_media WHERE data IS NOT NULL
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`),
    write: (tx, row, key, meta) => tx.query(`UPDATE check_run_media
      SET object_key = $2, sha256 = $3, bytes = $4, legacy_etag = $5, data = NULL WHERE id = $1`,
    [row.id, key, meta.sha256, meta.bytes, meta.legacyEtag]),
    remaining: (db) => db.query('SELECT COUNT(*)::int AS n FROM check_run_media WHERE data IS NOT NULL'),
  },
  {
    name: 'session_visuals',
    read: (tx) => tx.query(`SELECT id, data, sha256, content_type FROM session_visuals WHERE data IS NOT NULL
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`),
    write: (tx, row, key, meta) => tx.query(`UPDATE session_visuals
      SET object_key = $2, sha256 = $3, bytes = $4, legacy_etag = $5, data = NULL WHERE id = $1`,
    [row.id, key, meta.sha256, meta.bytes, meta.legacyEtag]),
    remaining: (db) => db.query('SELECT COUNT(*)::int AS n FROM session_visuals WHERE data IS NOT NULL'),
  },
];

async function one(pool, store, table) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const { rows: [row] } = await table.read(tx);
    if (!row) { await tx.query('COMMIT'); return null; }
    const meta = metadata(row.data);
    // Older rows have no stored checksum. If one is present, never clear
    // bytes that disagree with it; leave the row for diagnosis and retry.
    if (row.sha256 && row.sha256 !== meta.sha256) throw new Error(`Check-visual backfill checksum mismatch (${table.name}:${row.id})`);
    const key = await media.put(tx, store, row.data, row.content_type);
    await table.write(tx, row, key, meta);
    await tx.query('COMMIT');
    return meta.bytes;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { tx.release(); }
}

async function run(pool, store, { limit = 20, maxBytes = 32 * 1024 * 1024, shouldStop = () => false } = {}) {
  if (!store) return { skipped: 'unconfigured', done: false };
  const max = Math.max(1, Math.min(100, Number(limit) || 20));
  let migrated = 0;
  let uploadedBytes = 0;
  let found = true;
  while (found && migrated < max && uploadedBytes < maxBytes && !shouldStop()) {
    found = false;
    for (const table of TABLES) {
      if (migrated >= max || uploadedBytes >= maxBytes || shouldStop()) break;
      const bytes = await one(pool, store, table);
      if (bytes == null) continue;
      found = true; migrated++; uploadedBytes += bytes;
    }
  }
  const remaining = {};
  for (const table of TABLES) remaining[table.name] = (await table.remaining(pool)).rows[0].n;
  return { migrated, uploadedBytes, remaining, done: Object.values(remaining).every((n) => n === 0) };
}

module.exports = { run };
