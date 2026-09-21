'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const applicationRuntime = require('./application-runtime');
const dbManager = require('./db-manager');
const environment = require('./visual-evidence-environment');
const log = require('./logger');
const state = require('./visual-evidence-state');
const { visualHeadForSession, sameSha } = require('./pr-vote-revision');

const FAILED_MEDIA_HOURS = 24;
const ROLLBACK_MEDIA_DAYS = 7;
const RUN_RETENTION_DAYS = 30;

async function cleanupRunResources(config, run) {
  const errors = [];
  for (const side of ['base', 'head']) {
    const runtimeName = environment.runtimeName(run.id, side, applicationRuntime.mode(config));
    await applicationRuntime.remove(config, {
      runtimeKind: applicationRuntime.mode(config), runtimeName,
    }).catch((err) => errors.push(err));
    const dbName = dbManager.evidenceDbName(run.app_slug, run.id, side);
    await dbManager.dropDatabase(dbName, { strict: true }).catch((err) => errors.push(err));
  }
  const prepared = dbManager.preparedCloneSourceName(dbManager.appDbName(run.app_slug), run.id);
  await dbManager.releasePreparedCloneSource(prepared).catch((err) => errors.push(err));
  return errors;
}

async function recoverInterrupted(config, pool, { maxAgeMs = null, limit = 20 } = {}) {
  const ageMs = Math.max(60_000, Number(maxAgeMs) || config.visualEvidence?.maxRunMs || 720_000);
  const { rows } = await pool.query(
    `SELECT r.*, a.slug AS app_slug, s.visual_evidence_run_id AS current_run_id
       FROM visual_evidence_runs r
       JOIN chat_sessions s ON s.id = r.session_id
       JOIN apps a ON a.id = s.app_id
      WHERE r.state IN ('planned','provisioning','exploring','replaying','reviewing')
        AND r.updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
      ORDER BY r.updated_at ASC LIMIT $2`,
    [ageMs, Math.max(1, Math.min(100, Number(limit) || 20))]
  );
  let failed = 0;
  for (const run of rows) {
    await cleanupRunResources(config, run);
    if (run.current_run_id === run.id) {
      try {
        await state.transitionRun(pool, run.id, 'failed', {
          failureCode: 'evidence_run_interrupted',
          failureReason: 'The visual change preview worker stopped before the run completed. Retry the preview run.',
        });
        failed += 1;
        continue;
      } catch (err) {
        log.warn('visual-evidence', 'Interrupted run could not use normal transition', {
          runId: run.id, err: err.message,
        });
      }
    }
    await pool.query(
      `UPDATE visual_evidence_runs
          SET state = 'cancelled', failure_code = 'evidence_run_interrupted',
              failure_reason = 'The visual change preview worker stopped before the run completed.',
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND state IN ('planned','provisioning','exploring','replaying','reviewing')`,
      [run.id]
    );
  }
  return { examined: rows.length, failed };
}

// Intent is written before checks finish. The ordinary checks completion
// event starts evidence, but a process can die between those two writes.
// Unlike an interrupted run, that leaves no visual_evidence_runs row for
// recoverInterrupted to find. Reconcile open, settled, exact-head proposals
// so a one-time hand-off cannot leave "planned" on the card forever.
async function recoverUnstarted(config, pool, { limit = 10, minAgeMs = 60_000, schedule = null } = {}) {
  if (!config.visualEvidence?.execute) return { examined: 0, scheduled: 0 };
  const retryAfterMs = 10 * 60_000;
  const { rows } = await pool.query(
    `SELECT cs.id, cs.source, cs.imported_pr_head_sha, cs.reviewed_head_sha,
            cs.checks_commit_sha, cs.handoff_head_sha
       FROM chat_sessions cs
      WHERE cs.visual_evidence_state = 'planned'
        AND cs.visual_evidence_run_id IS NULL
        AND cs.status IN ('active', 'promoted')
        AND cs.visual_evidence_detail->>'required' = 'true'
        AND jsonb_typeof(cs.visual_evidence_detail->'intent') = 'object'
        AND (cs.check_state IN ('passing', 'failing', 'error', 'skipped')
             OR cs.check_phase = 'deferred')
        AND cs.visual_evidence_updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
        AND COALESCE((cs.visual_evidence_detail->>'recoveryAttemptAt')::bigint, 0)
            < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint - $3::bigint
      ORDER BY cs.visual_evidence_updated_at ASC LIMIT $2`,
    [Math.max(0, Number(minAgeMs) || 0), Math.max(1, Math.min(50, Number(limit) || 10)), retryAfterMs]
  );
  const dispatch = schedule || require('./visual-evidence-orchestrator').scheduleForSession;
  const defer = async (id) => {
    await pool.query(
      `UPDATE chat_sessions
          SET visual_evidence_detail = visual_evidence_detail
                || jsonb_build_object('recoveryAttemptAt', $2::bigint)
        WHERE id = $1 AND visual_evidence_state = 'planned'
          AND visual_evidence_run_id IS NULL`,
      [id, Date.now()]
    );
  };
  let scheduled = 0;
  for (const session of rows) {
    const head = visualHeadForSession(session);
    if (!state.validSha(head) || !sameSha(head, session.checks_commit_sha)) continue;
    try {
      const result = await dispatch(config, {
        pool, sessionId: session.id, headSha: head, trigger: 'planned-recovery',
      });
      if (result.scheduled) scheduled += 1;
      else if (result.reason !== 'already_running') await defer(session.id);
    } catch (error) {
      log.warn('visual-evidence', 'Could not recover an unstarted visual evidence claim', {
        sessionId: session.id, headSha: head, error: error.message,
      });
      await defer(session.id).catch(() => {});
    }
  }
  return { examined: rows.length, scheduled };
}

async function prune(pool, config = {}) {
  const failedMediaHours = Math.max(1,
    Number(config.visualEvidence?.failedArtifactRetentionHours) || FAILED_MEDIA_HOURS);
  const failedRunDays = Math.max(1,
    Number(config.visualEvidence?.failedMetadataRetentionDays) || RUN_RETENTION_DAYS);
  const failedMedia = await pool.query(
    `DELETE FROM visual_evidence_artifacts a
      USING visual_evidence_runs r
      WHERE a.run_id = r.id
        AND r.state IN ('failed','cancelled')
        AND COALESCE(r.completed_at, r.updated_at) < NOW() - ($1::int * INTERVAL '1 hour')`,
    [failedMediaHours]
  );
  const rollbackMedia = await pool.query(
    `DELETE FROM visual_evidence_artifacts a
      USING visual_evidence_runs r
      WHERE a.run_id = r.id AND r.state = 'stale'
        AND COALESCE(r.completed_at, r.updated_at) < NOW() - ($1::int * INTERVAL '1 day')`,
    [ROLLBACK_MEDIA_DAYS]
  );
  const runs = await pool.query(
    `DELETE FROM visual_evidence_runs r
      WHERE r.state IN ('failed','stale','cancelled','not_required','overridden')
        AND COALESCE(r.completed_at, r.updated_at) < NOW() - ($1::int * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM chat_sessions s WHERE s.visual_evidence_run_id = r.id
        )`,
    [failedRunDays]
  );
  return {
    failedArtifacts: failedMedia.rowCount || 0,
    rollbackArtifacts: rollbackMedia.rowCount || 0,
    runs: runs.rowCount || 0,
  };
}

async function sweepOrphanCheckouts(pool, { maxAgeMs = 720_000, tmpDir = os.tmpdir() } = {}) {
  const boundedAge = Math.max(60_000, Number(maxAgeMs) || 720_000);
  const active = await pool.query(
    `SELECT id FROM visual_evidence_runs
      WHERE state IN ('planned','provisioning','exploring','replaying','reviewing')
        AND updated_at >= NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
    [boundedAge]
  );
  const activePrefixes = new Set((active.rows || []).map((row) => String(row.id || '').slice(0, 8)));
  let entries;
  try {
    entries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch (err) {
    log.warn('visual-evidence', 'Could not inspect temporary evidence checkouts', { error: err.message });
    return { examined: 0, removed: 0 };
  }
  let examined = 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^usernode-evidence-([0-9a-f]{8})-[A-Za-z0-9._-]+$/.exec(entry.name);
    if (!match || activePrefixes.has(match[1])) continue;
    const target = path.join(tmpDir, entry.name);
    let stat;
    try { stat = await fs.stat(target); } catch { continue; }
    examined += 1;
    if (Date.now() - stat.mtimeMs < boundedAge) continue;
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn('visual-evidence', 'Could not remove orphan evidence checkout', {
        directory: entry.name, error: err.message,
      });
    }
  }
  return { examined, removed };
}

async function sweep(config, pool) {
  const recovered = await recoverInterrupted(config, pool);
  const checkouts = await sweepOrphanCheckouts(pool, {
    maxAgeMs: config.visualEvidence?.maxRunMs || 720_000,
  });
  const pruned = await prune(pool, config);
  return {
    ...recovered,
    orphanCheckoutsExamined: checkouts.examined,
    orphanCheckoutsRemoved: checkouts.removed,
    ...pruned,
  };
}

module.exports = {
  FAILED_MEDIA_HOURS,
  ROLLBACK_MEDIA_DAYS,
  RUN_RETENTION_DAYS,
  cleanupRunResources,
  recoverInterrupted,
  recoverUnstarted,
  prune,
  sweepOrphanCheckouts,
  sweep,
};
