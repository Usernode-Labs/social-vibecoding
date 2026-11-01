'use strict';

// One bounded batch of the media-shots-backfill workflow clock. The row's
// own state is the durable checkpoint: a committed key never uploads again,
// and a failed/abandoned transaction leaves the old bytes intact. Row locks
// fence retakes, publication, cascades and concurrent backfill attempts.

const media = require('./media-store');

const TABLES = [
  {
    name: 'shot_run_files', dense: true,
    read: (tx) => tx.query(`SELECT run_id, slot, data, object_key, sha256, dense_data, dense_object_key, dense_sha256, content_type
      FROM shot_run_files WHERE data IS NOT NULL OR dense_data IS NOT NULL
      ORDER BY run_id, slot LIMIT 1 FOR UPDATE SKIP LOCKED`),
    write: (tx, row, key, dense) => tx.query(`UPDATE shot_run_files
      SET object_key = $3, data = NULL, dense_object_key = $4, dense_data = NULL WHERE run_id = $1 AND slot = $2`,
    [row.run_id, row.slot, key, dense]),
    remaining: (db) => db.query('SELECT COUNT(*)::int AS n FROM shot_run_files WHERE data IS NOT NULL OR dense_data IS NOT NULL'),
  },
  {
    name: 'shot_artifacts', dense: true,
    read: (tx) => tx.query(`SELECT id, data, object_key, sha256, dense_data, dense_object_key, dense_sha256, content_type
      FROM shot_artifacts WHERE data IS NOT NULL OR dense_data IS NOT NULL
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`),
    write: (tx, row, key, dense) => tx.query(`UPDATE shot_artifacts
      SET object_key = $2, data = NULL, dense_object_key = $3, dense_data = NULL WHERE id = $1`, [row.id, key, dense]),
    remaining: (db) => db.query('SELECT COUNT(*)::int AS n FROM shot_artifacts WHERE data IS NOT NULL OR dense_data IS NOT NULL'),
  },
  {
    name: 'shots_eval_artifacts',
    read: (tx) => tx.query(`SELECT id, data, object_key, sha256, content_type FROM shots_eval_artifacts WHERE data IS NOT NULL
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`),
    write: (tx, row, key) => tx.query('UPDATE shots_eval_artifacts SET object_key = $2, data = NULL WHERE id = $1', [row.id, key]),
    remaining: (db) => db.query('SELECT COUNT(*)::int AS n FROM shots_eval_artifacts WHERE data IS NOT NULL'),
  },
  {
    name: 'shot_diagnostic_artifacts',
    read: (tx) => tx.query(`SELECT id, data, object_key, sha256, 'image/png' AS content_type FROM shot_diagnostic_artifacts WHERE data IS NOT NULL
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`),
    write: (tx, row, key) => tx.query('UPDATE shot_diagnostic_artifacts SET object_key = $2, data = NULL WHERE id = $1', [row.id, key]),
    remaining: (db) => db.query('SELECT COUNT(*)::int AS n FROM shot_diagnostic_artifacts WHERE data IS NOT NULL'),
  },
];

async function one(pool, store, table) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const { rows: [row] } = await table.read(tx);
    if (!row) { await tx.query('COMMIT'); return null; }
    const files = [];
    for (const prefix of table.dense ? ['', 'dense_'] : ['']) {
      if (row[prefix + 'data'] == null) continue;
      const data = row[prefix + 'data'];
      if (media.objectKey(data) !== media.PREFIX + row[prefix + 'sha256']) {
        throw new Error(`Media backfill checksum mismatch in ${table.name} (${row.id || row.run_id})`);
      }
      files.push({ data, contentType: row.content_type, prefix });
    }
    const keys = await media.putMany(tx, store, files);
    for (let i = 0; i < files.length; i++) row[files[i].prefix + 'object_key'] = keys[i];
    await table.write(tx, row, row.object_key, row.dense_object_key || null);
    await tx.query('COMMIT');
    return files.reduce((n, f) => n + f.data.length, 0);
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
  // Take turns across tables so a busy run's retakes cannot starve the
  // published shots or evals. Counts include locked rows: SKIP LOCKED never
  // mistakes somebody else's work in flight for a completed backfill.
  let found = true;
  while (found && migrated < max && uploadedBytes < maxBytes && !shouldStop()) {
    found = false;
    for (const table of TABLES) {
      if (migrated >= max || uploadedBytes >= maxBytes || shouldStop()) break;
      const bytes = await one(pool, store, table);
      if (bytes == null) continue;
      found = true;
      migrated++;
      uploadedBytes += bytes;
    }
  }
  const remaining = {};
  for (const table of TABLES) remaining[table.name] = (await table.remaining(pool)).rows[0].n;
  return { migrated, uploadedBytes, remaining, done: Object.values(remaining).every((n) => n === 0) };
}

module.exports = { run };
