'use strict';

const { resourceIntent } = require('./actions');
const { withResourceUse } = require('../build-retention-guard');
const { STAGING_BUILD_LOCK, PREVIEW_LIFECYCLE_LOCK } = require('../advisory-locks');
const log = require('../logger');

const FLOW_LABEL = 'social.usernode.io/preview-flow';

function createCleanup({ runtime = require('../application-runtime'), db = require('../db-manager'),
  lock = withResourceUse, lifecycle = require('../preview-lifecycle') } = {}) {
  // Called only while staging holds STAGING_BUILD_LOCK. Never clear a session
  // projection here: historical resource ownership is separate from publication.
  async function underBuildLock({ pool, config, sessionId, flowId }) {
    let row;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Same aggregate-first order as action admission. Claim retirement in a
      // transaction before I/O so a reported Ready cannot publish while removing.
      await client.query('SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
      row = (await client.query(`SELECT r.*, s.staging_url, s.staging_runtime_kind,
        s.staging_runtime_name, s.staging_commit_sha
        FROM preview_flow_resources r LEFT JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.flow_id = $1 AND r.session_id = $2`, [flowId, sessionId])).rows[0];
      if (!row?.intent) throw new Error('Preview cleanup requires its stored pre-create intent');
      if (row.cleanup_completed_at) {
        await client.query('COMMIT');
        return { disposition: row.cleanup_disposition };
      }
      if (row.published_at && row.staging_url === row.receipt?.stagingUrl
          && row.staging_runtime_kind === row.receipt.runtimeKind
          && row.staging_runtime_name === row.receipt.runtimeName
          && row.staging_commit_sha === row.receipt.commitSha) {
        await client.query('COMMIT');
        return { protected: true };
      }
      await client.query('UPDATE preview_flow_resources SET cleanup_started_at = NOW() WHERE flow_id = $1', [flowId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    // A DB outage defers removal; durable intent survives. Guessing whether an
    // unacknowledged publication committed would risk deleting a live preview.
    const intent = resourceIntent.parse(row.intent);
    const runtimeConfig = { ...config, appRuntime: intent.runtimeKind,
      kubernetes: { ...config?.kubernetes, appNamespace: intent.namespace } };
    const state = await runtime.inspect(runtimeConfig, intent);
    if (!state || state.status === 'unknown') throw new Error('Cannot establish preview runtime ownership');
    let disposition = 'replaced';
    if (state.status === 'not_found' || state.labels?.[FLOW_LABEL] === flowId) {
      const removed = await runtime.remove(runtimeConfig, intent, {
        stopTimeoutSec: require('../docker').STAGING_STOP_GRACE_SEC,
      });
      if (removed?.removed === false) throw new Error(removed.error || 'Preview runtime removal failed');
      // Same-SHA generations share this clone. Hold the same resource lock as
      // every builder until deletion finishes; a successor cannot start restoring.
      await db.dropDatabase(intent.dbName, { strict: true });
      disposition = 'removed';
    }
    // A different/absent label is never authority to delete by shared name.
    // Leave its DB too: that runtime may use the same six-character SHA clone.
    await pool.query(`UPDATE preview_flow_resources SET cleanup_completed_at = NOW(), cleanup_disposition = $2
      WHERE flow_id = $1`, [flowId, disposition]);
    return { disposition };
  }

  async function sweep({ pool, config, limit = 25 }) {
    const requested = Number(limit);
    const batchSize = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.trunc(requested))) : 25;
    // Move selected obligations to the back in one committed statement before
    // acquiring runtime locks or doing I/O. Failures, busy resources and process
    // death cannot pin the oldest batch at the front. A database sequence orders
    // new arrivals/retries without relying on clocks or a process-local cursor.
    // This statement locks only resource rows; it never then locks a session.
    const { rows } = await pool.query(`WITH candidates AS (
      SELECT r.flow_id FROM preview_flow_resources r LEFT JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.cleanup_completed_at IS NULL AND r.intent IS NOT NULL
          AND NOT (r.published_at IS NOT NULL
            AND s.staging_url IS NOT DISTINCT FROM r.receipt->>'stagingUrl'
            AND s.staging_runtime_kind IS NOT DISTINCT FROM r.receipt->>'runtimeKind'
            AND s.staging_runtime_name IS NOT DISTINCT FROM r.receipt->>'runtimeName'
            AND s.staging_commit_sha IS NOT DISTINCT FROM r.receipt->>'commitSha')
        ORDER BY r.cleanup_queue_position LIMIT $1 FOR UPDATE OF r SKIP LOCKED
      )
      UPDATE preview_flow_resources r SET cleanup_queue_position = DEFAULT
      FROM candidates c WHERE r.flow_id = c.flow_id RETURNING r.flow_id, r.session_id, r.intent`, [batchSize]);
    const results = [];
    for (const row of rows) {
      const runtimeConfig = { ...config, appRuntime: row.intent.runtimeKind };
      const cleanup = () => lock(runtimeConfig, STAGING_BUILD_LOCK, row.session_id,
        () => underBuildLock({ pool, config, sessionId: row.session_id, flowId: row.flow_id }),
        { allRuntimes: true, tryOnly: true });
      try {
        // Same ordering as the Kubernetes build: lifecycle, then build resource.
        // Do not wait behind a live phase or cancel its check consumers.
        results.push(lifecycle.enabled(runtimeConfig)
          ? await lock(runtimeConfig, PREVIEW_LIFECYCLE_LOCK, row.session_id, cleanup, { tryOnly: true })
          : await cleanup());
      } catch (err) {
        log.warn('preview-cleanup', 'Resource cleanup remains pending', {
          flowId: row.flow_id, sessionId: row.session_id, err: err.message,
        });
        results.push({ pending: true });
      }
    }
    return results;
  }
  let timer = null;
  let inFlight = null;
  function start({ pool, config, intervalMs = 60000 }) {
    if (timer) return inFlight;
    const run = () => {
      if (inFlight) return inFlight;
      inFlight = sweep({ pool, config })
        .catch(err => log.warn('preview-cleanup', 'Cleanup sweep deferred', { err: err.message }))
        .finally(() => { inFlight = null; });
      return inFlight;
    };
    timer = setInterval(run, intervalMs);
    timer.unref();
    return run();
  }
  async function stop() {
    clearInterval(timer);
    timer = null;
    await inFlight;
  }
  return { underBuildLock, sweep, start, stop };
}

module.exports = { FLOW_LABEL, createCleanup, ...createCleanup() };
