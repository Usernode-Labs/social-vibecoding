'use strict';

const { createSessionDecisionRuntime } = require('../decision-runtime');
const { readState } = require('../preview-flow/store');
const { parseAction } = require('./actions');
const { reduce, REDUCER_VERSION } = require('./reducer');

function createCliPreviewHandoff(pool) {
  const runtime = createSessionDecisionRuntime(pool);
  const machine = {
    name: 'cli-preview-handoff',
    version: REDUCER_VERSION,
    parseAction,
    reduce,
    async load(client, session, { sessionId, lock }) {
      const handoff = (await client.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [sessionId])).rows[0] || null;
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
      const lifecycleSession = session ? Object.fromEntries([
        'id', 'app_id', 'user_id', 'source', 'status', 'active_turn', 'handoff_uploaded_sha',
        'handoff_head_sha', 'handoff_upload_checked_sha', 'checks_commit_sha',
        'staging_commit_sha', 'staging_runtime_name', 'reviewed_head_sha', 'check_state', 'check_phase',
      ].map(key => [key, session[key] ?? null])) : null;
      return {
        session: lifecycleSession,
        handoff,
        preview: previewState,
        checksOutstanding: obligations[0].outstanding,
        checkOperation,
        checkRun,
      };
    },
    facts: () => ({}),
    actionConflict: () => new Error('CLI preview action ID reused with different input'),
    async persist(client, { action, decision }) {
      if (action.type === 'AcceptCliPreviewHead') {
        await client.query(`UPDATE chat_sessions SET handoff_head_sha = $2::text,
          handoff_local_commit_sha = CASE WHEN handoff_uploaded_sha = $2::text THEN handoff_local_commit_sha ELSE NULL END,
          handoff_upload_checked_sha = NULL, last_activity_at = NOW() WHERE id = $1`, [action.sessionId, action.headSha]);
        // Preserve the serving preview while the candidate prepares.
        const pending = await require('../visuals').setChecksPending(client, action.sessionId, action.headSha, 'building', 'commit-push');
        if (!pending) throw new Error('Accepted CLI head could not admit required checks');
        await client.query(`INSERT INTO cli_preview_handoffs (session_id, head_sha, started_status, admission_id, phase)
          VALUES ($1,$2,$3,$4,'preparing') ON CONFLICT (session_id) DO UPDATE
          SET head_sha = EXCLUDED.head_sha, started_status = EXCLUDED.started_status,
            admission_id = EXCLUDED.admission_id, phase = 'preparing', flow_id = NULL, checks_recovery = NULL,
            preparation_work_id = NULL, continuation_work_id = NULL`, [
          action.sessionId, action.headSha, action.startedStatus, action.actionId,
        ]);
        return;
      }
      await client.query('UPDATE cli_preview_handoffs SET phase = $2 WHERE session_id = $1',
        [action.sessionId, decision.change.phase]);
      if (decision.change.recovery) {
        const recovery = decision.change.recovery;
        // A missing manifest must retain a conservative run locator across
        // supersession. Reconstructed metadata never grants creation or grading.
        const fallback = {
          durableCli: true,
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
