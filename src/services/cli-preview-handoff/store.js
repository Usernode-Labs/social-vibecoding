'use strict';

const { createSessionDecisionRuntime } = require('../decision-runtime');
const { readState } = require('../preview-flow/store');
const { parseAction } = require('./actions');
const { ordinaryNative } = require('./source-policy');
const { reduce, REDUCER_VERSION } = require('./reducer');

function createCliPreviewHandoff(pool) {
  const runtime = createSessionDecisionRuntime(pool);
  const machine = {
    name: 'cli-preview-handoff',
    version: REDUCER_VERSION,
    parseAction,
    reduce,
    async load(client, session, { sessionId, lock }) {
      const handoffRow = (await client.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [sessionId])).rows[0];
      // Scheduling time is executor metadata, not a reducer input (or a Date
      // object in a JSON decision trace).
      const handoff = handoffRow ? Object.fromEntries(Object.entries(handoffRow)
        .filter(([key]) => key !== 'sync_reconcile_at')) : null;
      // Same aggregate transaction: no independently locked domain snapshots.
      const previewState = await readState(client, session, sessionId);
      const { rows: obligations } = await client.query(`SELECT
        EXISTS (SELECT 1 FROM check_runs WHERE session_id = $1 AND commit_sha = $2::text)
        OR EXISTS (SELECT 1 FROM preview_operations
          WHERE session_id = $1 AND revision = $2::text AND state = 'running') AS outstanding`,
      [sessionId, session?.checks_commit_sha || null]);
      const checkOperation = (await client.query(`SELECT run_id, revision, desired_revision, phase, state
        FROM preview_operations WHERE session_id = $1`, [sessionId])).rows[0] || null;
      let checkRun = null;
      if (checkOperation?.run_id) {
        const values = [sessionId, checkOperation.run_id];
        // Decisions exclude manifest claims while observing/persisting their
        // owner. Read-only snapshots cannot take this write lock.
        if (lock) {
          await client.query('SELECT run_id FROM check_runs WHERE session_id = $1 AND run_id = $2 FOR UPDATE', values);
        }
        checkRun = (await client.query(`SELECT run_id, session_id, commit_sha, owner, manifest
          FROM check_runs WHERE session_id = $1 AND run_id = $2`, values)).rows[0] || null;
      }
      let continuationOutstanding = false;
      if (handoff?.continuation_work_id) {
        const continuation = (await client.query('SELECT status FROM execution_work_requests WHERE id = $1',
          [handoff.continuation_work_id])).rows[0];
        continuationOutstanding = ['queued', 'running', 'blocked'].includes(continuation?.status);
      }

      const lifecycleSession = session ? Object.fromEntries([
        'id', 'app_id', 'user_id', 'source', 'status', 'active_turn', 'handoff_uploaded_sha',
        'handoff_head_sha', 'handoff_upload_checked_sha', 'checks_commit_sha',
        'staging_commit_sha', 'staging_runtime_name', 'reviewed_head_sha', 'check_state', 'check_phase',
        'branch_name', 'approval_epoch', 'handoff_local_commit_sha',
      ].map(key => [key, session[key] ?? null])) : null;
      return {
        session: ordinaryNative(session) ? { ...lifecycleSession, is_headless: session.is_headless, shared_at: session.shared_at ? String(session.shared_at) : null } : lifecycleSession,
        handoff,
        preview: previewState,
        checksOutstanding: obligations[0].outstanding,
        continuationOutstanding,
        checkOperation,
        checkRun,
      };
    },
    facts: () => ({}),
    actionConflict: () => new Error('CLI preview action ID reused with different input'),
    async persist(client, { state, action, decision }) {
      if (decision.change.authorizationOnly) return;

      const sync = action.type === 'AcceptCliSyncHead';
      const manual = action.type === 'AcceptNativeManualHead';
      const submission = action.type === 'AcceptNativeSubmissionHead';
      if (manual || sync || submission || action.type === 'AcceptCliPreviewHead') {
        if (sync || submission) {
          if (sync) {
            await client.query(`UPDATE chat_sessions SET handoff_head_sha = $2::text,
              handoff_uploaded_sha = $2::text, handoff_local_commit_sha = NULL,
              handoff_upload_checked_sha = NULL WHERE id = $1`, [action.sessionId, action.headSha]);
          }
          const freshness = require('../summary-freshness');
          await client.query(`UPDATE chat_sessions SET last_activity_at = NOW(),
            ${freshness.invalidateHeadMoveSql('$2')},
            reviewed_head_sha = CASE WHEN status = 'promoted' THEN $2::text ELSE reviewed_head_sha END,
            approval_epoch = $3, stale_notified_at = NULL WHERE id = $1`,
          [action.sessionId, action.headSha, decision.change.approvalEpoch]);
          // Same client and aggregate boundary: approval, summary and shots
          // cannot commit independently of the accepted head and required work.
          await require('../shots-state').markStaleForHeadWithClient(client, action.sessionId, action.headSha);
        } else if (manual) {
          await client.query('UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1', [action.sessionId]);
        } else {
          await client.query(`UPDATE chat_sessions SET handoff_head_sha = $2::text,
            handoff_local_commit_sha = CASE WHEN handoff_uploaded_sha = $2::text THEN handoff_local_commit_sha ELSE NULL END,
            handoff_upload_checked_sha = NULL, last_activity_at = NOW() WHERE id = $1`, [action.sessionId, action.headSha]);
        }
        // Preserve the serving preview while the candidate prepares.
        const phase = decision.change.deferPreparation ? 'reconciling' : 'building';
        if (decision.change.checksCarry) {
          // Mechanical changes retain the existing green verdict/graduation;
          // the new candidate still needs preparation and authorized activation.
          await client.query('UPDATE chat_sessions SET checks_commit_sha = $2 WHERE id = $1',
            [action.sessionId, action.headSha]);
        } else {
          const pending = await require('../visuals').setChecksPending(
            client, action.sessionId, action.headSha, phase,
            manual ? 'manual-recheck' : sync ? 'sync-main' : 'commit-push',
          );
          if (!pending) throw new Error('Accepted head could not admit required checks');
        }
        const reconciliation = decision.change.deferPreparation ? {
          owner: submission ? 'native-preview-requests' : 'cli-preview-handoff',
          reason: submission ? decision.change.blockedReason : 'sync_admission_disabled',
          ...(submission ? { source: 'native-submission', checksCarry: decision.change.checksCarry } : {}),
          headSha: action.headSha, admissionId: action.actionId,
        } : null;
        if (reconciliation && !decision.change.checksCarry) {
          await client.query(`UPDATE chat_sessions SET check_phase = 'reconciling',
            check_error_detail = 'Revision accepted; preparation is waiting for its reconciliation owner.',
            checks_progress = $2::jsonb WHERE id = $1`, [action.sessionId, JSON.stringify(reconciliation)]);
        }
        await client.query(`INSERT INTO cli_preview_handoffs
          (session_id, head_sha, started_status, admission_id, phase, sync_reconciliation, sync_reconcile_at)
          VALUES ($1,$2,$3,$4,'preparing',$5::jsonb,CASE WHEN $5::jsonb IS NULL THEN NULL ELSE NOW() END) ON CONFLICT (session_id) DO UPDATE
          SET head_sha = EXCLUDED.head_sha, started_status = EXCLUDED.started_status,
            admission_id = EXCLUDED.admission_id, phase = 'preparing', checks_recovery = NULL,
            sync_reconciliation = $5::jsonb, sync_reconcile_at = CASE WHEN $5::jsonb IS NULL THEN NULL ELSE NOW() END,
            flow_id = CASE WHEN $5::jsonb IS NULL THEN NULL ELSE cli_preview_handoffs.flow_id END,
            preparation_work_id = NULL, continuation_work_id = NULL`, [
          action.sessionId, action.headSha, decision.change.startedStatus, action.actionId,
          reconciliation ? JSON.stringify(reconciliation) : null,
        ]);
        return;
      }
      await client.query('UPDATE cli_preview_handoffs SET phase = $2 WHERE session_id = $1',
        [action.sessionId, decision.change.phase]);
      if (decision.change.resumeSync) {
        await client.query(`UPDATE cli_preview_handoffs SET sync_reconciliation = NULL,
          sync_reconcile_at = NULL WHERE session_id = $1`, [action.sessionId]);
        if (!state.handoff.sync_reconciliation.checksCarry) {
          const pending = await require('../visuals').setChecksPending(client, action.sessionId, action.headSha,
            'building', ordinaryNative(state.session) ? 'commit-push' : 'sync-main');
          if (!pending) throw new Error('Head reconciliation could not admit required checks');
          await client.query('UPDATE chat_sessions SET check_error_detail = NULL WHERE id = $1', [action.sessionId]);
        }
      }
      if (decision.change.recovery) {
        const recovery = decision.change.recovery;
        // A missing manifest must retain a conservative run locator across
        // supersession. Reconstructed metadata never grants creation or grading.
        const fallback = {
          ...(ordinaryNative(state.session) ? { durableNative: true, previewFlowId: action.flowId } : { durableCli: true, cliFlowId: action.flowId }),
          launched: true,
          reconstruction: 'unknown-launch',
          recovery,
          unitSuite: { version: 1, state: 'submitted' },
        };
        const { rowCount } = await client.query(`INSERT INTO check_runs (run_id, session_id, commit_sha, owner, manifest)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (run_id) DO UPDATE
          SET manifest = jsonb_set(check_runs.manifest, '{recovery}', $6::jsonb)
          WHERE check_runs.session_id = $2 AND check_runs.commit_sha = $3
            AND check_runs.owner = $4`, [
          action.runId, action.sessionId, action.headSha,
          action.observedOwner || require('../check-runs').selfOwner(),
          JSON.stringify(fallback), JSON.stringify(recovery),
        ]);
        if (rowCount !== 1) throw new Error('Checks manifest changed during blocked-state persistence');
        await client.query('UPDATE cli_preview_handoffs SET checks_recovery = $2 WHERE session_id = $1',
          [action.sessionId, JSON.stringify(recovery)]);
      }
      if (decision.change.clearRecovery) {
        await client.query('UPDATE cli_preview_handoffs SET checks_recovery = NULL WHERE session_id = $1', [action.sessionId]);
      }
      if (decision.change.resetChecks) {
        const pending = await require('../visuals').setChecksPending(client, action.sessionId, action.headSha, 'testing', 'manual');
        if (!pending) throw new Error('Accepted recheck could not admit required checks');
      }
    },
    journal: {
      async findReceipt(client, sessionId, actionId) {
        return (await client.query(`SELECT action_hash, decision FROM cli_preview_receipts
          WHERE session_id = $1 AND action_id = $2`, [sessionId, actionId])).rows[0];
      },
      saveReceipt: (client, values) => client.query(`INSERT INTO cli_preview_receipts
        (session_id, action_id, action_hash, decision) VALUES ($1,$2,$3,$4)`, values),
      saveTrace: (client, values) => client.query(`INSERT INTO cli_preview_decisions
        (session_id, action_id, reducer_version, pre_state, action, facts, decision)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, values),
      async trace(client, sessionId) {
        return (await client.query('SELECT * FROM cli_preview_decisions WHERE session_id = $1 ORDER BY id', [sessionId])).rows;
      },
    },
  };
  return {
    applyInTransaction: (transaction, action) => transaction.apply(machine, action),
    apply: action => runtime.apply(machine, action),
    read: sessionId => runtime.read(machine, sessionId),
    trace: sessionId => runtime.trace(machine, sessionId),
  };
}

module.exports = { createCliPreviewHandoff };
