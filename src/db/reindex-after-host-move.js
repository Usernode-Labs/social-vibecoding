'use strict';

// Rebuild the indexes of every small table once, after the database moved
// hosts.
//
// WHY THIS EXISTS. When production moved to a new server (September 2026),
// rows written BEFORE the move stopped being findable through their unique
// B-tree indexes while rows written after it were fine. The first casualty
// was the hosted MCP connector: Claude.ai's registered client
// (`mcp_clients`, August) was returned by a sequential scan on
// `client_name`, yet `WHERE client_id = $1` — the same table, through the
// unique index — found nothing, so every consent request 404'd as an
// unknown client and reconnecting could not help (registration is
// deduplicated by name and hands back the same unfindable row). The same
// fault hides in every other index over collatable text: a token hash, a
// username, a slug. It is the signature of a data directory carried to a
// host whose glibc or ICU sorts text differently from the one that built
// the indexes; Postgres records that as a collation version mismatch and
// the only repair is REINDEX.
//
// WHY IT RUNS HERE, AND FIRST. migrate() runs on every boot, before the
// platform serves traffic, so a one-off maintenance pass in it needs no
// shell access to the database host. It runs BEFORE seedAdmin and the
// other seeds because they look rows up by text key ("is there a user
// named X?") and insert when nothing comes back — against a broken index
// that is how a duplicate admin row gets created.
//
// WHAT IT DOES AND DOES NOT DO. `REINDEX TABLE` for every ordinary table in
// `public` up to SMALL_TABLE_BYTES, smallest first, each under a lock and
// statement timeout so a held lock or a slow rebuild cannot hang the boot
// (the compose rollout's health gate is 120s). Tables above the threshold
// are deliberately left to an operator's `REINDEX DATABASE` in a window
// and are named in the log, together with the collation drift the server
// reports. A `platform_settings` marker records completion so the pass
// costs nothing on later boots; any table that failed leaves the marker
// unset, and the next boot retries. Deleting the marker re-runs the pass,
// which is safe: reindexing is idempotent.
//
// Not run on a staging clone: a preview's database is a fresh restore
// whose indexes were just built, and the rebuild would only add to every
// preview's boot time.

const log = require('../services/logger');

const MARKER_KEY = 'indexes_rebuilt_after_host_move_2026_09';
const SMALL_TABLE_BYTES = 64 * 1024 * 1024;
// Per-table budget: lock_timeout 5s (a held lock means skip and retry next
// boot), statement_timeout 60s (a rebuild that slow belongs in a window).

const RUNBOOK = 'REINDEX DATABASE in a maintenance window, then ALTER DATABASE ... REFRESH COLLATION VERSION';

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Postgres 15+ remembers the collation version a database was created
// under and can report the one the host currently provides. A difference
// is the fingerprint of the fault above. Advisory only: older servers have
// neither column nor function, and a mismatch is a reason for an operator
// to plan the full reindex, not for this pass to behave differently.
async function reportCollationDrift(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT datcollate, datcollversion,
              pg_database_collation_actual_version(oid) AS actual_version
         FROM pg_database WHERE datname = current_database()`
    );
    const row = rows[0];
    if (!row || !row.datcollversion || !row.actual_version) return null;
    const drifted = row.datcollversion !== row.actual_version;
    if (drifted) {
      log.warn('db', 'Collation version drift: indexes built under another libc/ICU may be unreadable', {
        collation: row.datcollate,
        recorded: row.datcollversion,
        actual: row.actual_version,
        runbook: RUNBOOK,
      });
    }
    return { drifted, recorded: row.datcollversion, actual: row.actual_version };
  } catch (err) {
    log.debug('db', 'collation version check unavailable', { err: err.message });
    return null;
  }
}

async function reindexAfterHostMove(pool, { env = process.env } = {}) {
  if (env.USERNODE_ENV === 'staging') return { skipped: 'staging' };

  try {
    const { rows: marker } = await pool.query(
      'SELECT 1 FROM platform_settings WHERE key = $1',
      [MARKER_KEY]
    );
    if (marker.length) return { skipped: 'done' };

    await reportCollationDrift(pool);

    const { rows: tables } = await pool.query(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) ASC, c.relname ASC`
    );
    const small = tables.filter((t) => Number(t.bytes) <= SMALL_TABLE_BYTES);
    const deferred = tables.filter((t) => Number(t.bytes) > SMALL_TABLE_BYTES).map((t) => t.name);

    const reindexed = [];
    const failed = [];
    const client = await pool.connect();
    try {
      // Literal statements (not built from the constants above) so the
      // static SQL validator sees them; only the REINDEX is runtime-built.
      await client.query("SET lock_timeout = '5s'");
      await client.query("SET statement_timeout = '60s'");
      for (const table of small) {
        try {
          await client.query(`REINDEX TABLE ${quoteIdent(table.name)}`);
          reindexed.push(table.name);
        } catch (err) {
          failed.push(table.name);
          log.warn('db', 'Reindex skipped for one table; the pass retries next boot', {
            table: table.name, err: err.message,
          });
        }
      }
    } finally {
      // Destroy rather than return to the pool: the timeouts above are
      // session-level and must not leak into an unrelated query.
      client.release(true);
    }

    if (!failed.length) {
      await pool.query(
        `INSERT INTO platform_settings (key, value, description) VALUES ($1, 'true', $2)
         ON CONFLICT (key) DO NOTHING`,
        [
          MARKER_KEY,
          'Marker: the one-time REINDEX of every small table after the 2026-09 database host move has completed. Deleting it re-runs the pass on the next boot, which is safe (reindexing is idempotent) but only useful after another host move.',
        ]
      );
    }

    const level = failed.length ? 'warn' : 'info';
    log[level]('db', 'Post-move reindex pass', {
      reindexed: reindexed.length,
      failed,
      deferredLargeTables: deferred,
      note: deferred.length ? `tables over ${SMALL_TABLE_BYTES} bytes are left to the operator: ${RUNBOOK}` : undefined,
    });
    return { reindexed, failed, deferred };
  } catch (err) {
    log.warn('db', 'Post-move reindex pass skipped', { err: err.message });
    return { skipped: 'error', error: err.message };
  }
}

module.exports = {
  reindexAfterHostMove,
  reportCollationDrift,
  quoteIdent,
  MARKER_KEY,
  SMALL_TABLE_BYTES,
};
