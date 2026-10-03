'use strict';

const { randomUUID } = require('node:crypto');
const { createSessionDecisionRuntime } = require('../decision-runtime');
const { createCliPreviewHandoff } = require('./store');
const { ordinaryNative, nativeAction } = require('./source-policy');
const { checksSettled } = require('./reducer');
const { nativeHeadCondition } = require('../preview-flow/enabling-conditions');
const { createPreviewWork, PREPARE_RUNTIME } = require('../preview-flow/work');

const CONTINUE = 'native-cli-preview-continuation';

function selected(config, session) {
  return config.nativeCliPreviewHandoffEnabled === true
    && session.source === 'cli_handoff'
    && config.appRuntime === 'kubernetes'
    && config.kubernetes?.buildEngine === 'kpack';
}

function selectedManual(config, session) {
  return config.nativeManualPreviewEnabled === true && ordinaryNative(session)
    && !session.is_headless && config.appRuntime === 'kubernetes'
    && config.kubernetes?.buildEngine === 'kpack';
}

async function enrolled(pool, sessionId) {
  const { rows } = await pool.query('SELECT session_id, flow_id, sync_reconciliation FROM cli_preview_handoffs WHERE session_id = $1', [sessionId]);
  return rows.some(row => Number(row.session_id) === Number(sessionId) && (!!row.flow_id || !!row.sync_reconciliation));
}

function createNativePreviewWork(pool, config, {
  previewOptions = {},
  owner = createCliPreviewHandoff(pool),
  activate = require('../preview-flow/activation').underBuildLock,
  capture = require('../visuals').captureForSession,
  notify = require('../handoff-pipeline').notifyStagingReady,
  warm = require('../staging').warmStagingCert,
} = {}) {
  const runtime = createSessionDecisionRuntime(pool);
  // New preparation has one complete contract. Recovery still dispatches by
  // persisted kind, independently of admission or legacy native-attempt opt-in.
  const preview = createPreviewWork(pool, config, { ...previewOptions, candidateAccepted });
  const store = preview.store;

  function readWork(transaction, sessionId, workId) {
    return transaction.withSession(sessionId, async client => {
      return (await client.query('SELECT * FROM execution_work_requests WHERE id = $1', [workId])).rows[0];
    });
  }

  function assertAdmissionConfig() {
    if (!selected(config, { source: 'cli_handoff' }) || !require('../preview-lifecycle').enabled(config)) {
      throw new Error('CLI cutover requires all recoverable preparation protections and the checks lifecycle');
    }
  }

  async function admit(options) {
    assertAdmissionConfig();
    return runtime.transact(transaction => admitInTransaction(transaction, options));
  }

  async function admitInTransaction(transaction, {
    session,
    headSha,
    retryPreparation = false,
    expectedChecksSha = session.checks_commit_sha || null,
    expectedPreviewName = session.staging_runtime_name || null,
    persistDetails = async () => {},
  }) {
    // Acquire the aggregate before inspecting deduplication or accepting a head.
    const state = await transaction.withSession(session.id, async client => {
      return (await client.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [session.id])).rows[0];
    });
    if (state?.head_sha === headSha) {
      if (state.sync_reconciliation) {
        const work = await resumeSync(transaction, state);
        return { accepted: true, replayed: true, work };
      }
      const activeId = state.continuation_work_id || state.preparation_work_id;
      const active = await readWork(transaction, session.id, activeId);
      // A running/busy/uncertain operation remains its owner's responsibility.
      // Only an explicit retry of completed work may reserve another attempt.
      if (!retryPreparation || active.status !== 'succeeded') {
        return { accepted: true, replayed: true, work: await readWork(transaction, session.id, state.preparation_work_id) };
      }
    }
    const action = {
      type: 'AcceptCliPreviewHead',
      actionId: randomUUID(),
      sessionId: session.id,
      userId: session.user_id,
      headSha,
      startedStatus: session.status === 'paused' ? 'paused' : 'active',
      expectedStatus: session.status,
      previousPreviewName: expectedPreviewName,
      previousHead: session.handoff_head_sha || null,
      previousChecks: expectedChecksSha,
      uploadCheckedSha: session.handoff_upload_checked_sha || null,
    };
    const accepted = await owner.applyInTransaction(transaction, action);
    if (!accepted.decision.accepted) return { accepted: false, reason: accepted.decision.reason };
    const preparation = await prepareAccepted(transaction, action);
    await transaction.withSession(session.id, persistDetails);
    return { accepted: true, work: preparation.work };
  }

  async function manualReceipt({ sessionId, requestId, userId, kind }) {
    const receipt = (await pool.query(`SELECT * FROM native_preview_manual_requests
      WHERE session_id = $1 AND request_id = $2`, [sessionId, requestId])).rows[0];
    if (!receipt) return null;
    if (receipt.user_id !== userId || receipt.kind !== kind) {
      return { accepted: false, reason: 'manual_request_identity_conflict' };
    }
    return { accepted: true, replayed: true, headSha: receipt.head_sha, work: await store.read(receipt.work_id) };
  }

  async function admitManual({ session, headSha, requestId, userId, canAdminWrite = false, kind, repair = false }) {
    try {
      return await runtime.transact(async transaction => {
        // The receipt and authority share the same aggregate boundary as head/work.
        const previous = await transaction.withSession(session.id, async client => {
          return (await client.query(`SELECT * FROM native_preview_manual_requests
            WHERE session_id = $1 AND request_id = $2`, [session.id, requestId])).rows[0];
        });
        if (previous) {
          if (previous.user_id !== userId || previous.kind !== kind) {
            return { accepted: false, reason: 'manual_request_identity_conflict' };
          }
          return { accepted: true, replayed: true, headSha: previous.head_sha,
            work: await readWork(transaction, session.id, previous.work_id) };
        }

        const request = {
          type: 'AuthorizeNativeManualRequest', actionId: randomUUID(), sessionId: session.id,
          headSha, userId, canAdminWrite, kind, expectedStatus: session.status,
          branchName: session.branch_name, previousChecks: session.checks_commit_sha || null,
          previousPreviewName: session.staging_runtime_name || null,
          startedStatus: session.status === 'paused' ? 'paused' : 'active',
        };
        const permission = await owner.applyInTransaction(transaction, request);
        if (!permission.decision.accepted) return { accepted: false, reason: permission.decision.reason };
        const state = permission.current;
        const sameHead = state.handoff?.head_sha === headSha;
        let work = sameHead ? await readWork(transaction, session.id,
          state.handoff.continuation_work_id || state.handoff.preparation_work_id) : null;
        const outstanding = work && ['queued', 'running', 'blocked'].includes(work.status);
        const needsPreparation = !sameHead || (!outstanding && (repair || state.preview.flow?.state !== 'ready'));

        if (needsPreparation) {
          if (!selectedManual(config, session)) return { accepted: false, reason: 'native_admission_disabled' };
          if (!require('../preview-lifecycle').enabled(config)) throw new Error('Native manual admission requires the checks lifecycle');
          const action = { ...request, type: 'AcceptNativeManualHead', actionId: randomUUID() };
          const accepted = await owner.applyInTransaction(transaction, action);
          if (!accepted.decision.accepted) return { accepted: false, reason: accepted.decision.reason };
          work = (await prepareAccepted(transaction, action)).work;
        } else if (kind === 'recheck' && !outstanding) {
          const identity = { sessionId: session.id, flowId: state.handoff.flow_id, headSha };
          const checks = await owner.applyInTransaction(transaction, {
            type: 'RequestNativeRecheck', actionId: requestId, ...identity,
            userId: session.user_id, reason: 'manual-recheck', metadataKey: null,
            admissionEnabled: selectedManual(config, session),
          });
          if (!checks.decision.accepted) {
            throw Object.assign(new Error(checks.decision.reason), { code: 'NATIVE_RECHECK_WAITING' });
          }
          work = await enqueueContinuation(transaction, identity, requestId, checks.decision.effects[0].effectKey, true);
        }
        if (!work) throw new Error('Authorized native request has no durable work');
        await transaction.withSession(session.id, client => client.query(`INSERT INTO native_preview_manual_requests
          (session_id, request_id, user_id, kind, head_sha, work_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [session.id, requestId, userId, kind, headSha, work.id]));
        return { accepted: true, headSha, work };
      });
    } catch (error) {
      if (error.code !== 'NATIVE_RECHECK_WAITING') throw error;
      return { accepted: false, reason: error.message };
    }
  }

  // Admit a new same-head intent, replay its receipt, or report waiting.
  // External capture remains the existing continuation/lifecycle owner's work.
  async function requestRecheck({ session, requestId, headSha, reason, metadataKey = null,
    persistDetails = async () => {} }) {
    if (!requestId && !metadataKey) return { status: 'blocked', code: 'recheck_request_id_required' };
    try {
      return await runtime.transact(async transaction => {
        const state = await transaction.withSession(session.id, async client => {
          return (await client.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [session.id])).rows[0];
        });
        if (!state?.flow_id) return { status: 'blocked', code: 'native_enrollment_required' };
        if (!requestId) {
          // Serial decision IDs preserve admission order even when competing
          // transactions began before they acquired the aggregate lock.
          const latest = await transaction.withSession(session.id, async client => {
            return (await client.query(`SELECT w.* FROM cli_preview_decisions d
              JOIN execution_work_requests w ON w.session_id = d.session_id AND w.caused_by = d.action_id
              WHERE d.session_id = $1 AND d.action->>'type' = 'RequestNativeRecheck'
                AND d.action->>'metadataKey' IS NOT NULL ORDER BY d.id DESC LIMIT 1`, [session.id])).rows[0];
          });
          const sameSubmission = latest?.input.flowId === state.flow_id && latest.input.headSha === headSha
            && latest.input.requestedRecheck?.metadataKey === metadataKey;
          if (sameSubmission) requestId = latest.caused_by;
          else requestId = require('../native-preview-requests').metadataRecheckId(
            session.id, headSha, metadataKey, latest?.id || state.admission_id,
          );
        }
        const effectKey = `${session.id}:${requestId}:checks`;
        const previous = await store.find(transaction, session.id, effectKey);
        if (previous) {
          const request = previous.input.requestedRecheck;
          if (!request || previous.input.headSha !== headSha || request.reason !== reason
              || request.metadataKey !== metadataKey || request.userId !== session.user_id) {
            return { status: 'blocked', code: 'recheck_request_identity_conflict' };
          }
          return { status: 'durable', replayed: true, requestId, work: previous };
        }
        const request = { reason, metadataKey, userId: session.user_id };
        const decision = await owner.applyInTransaction(transaction, {
          type: 'RequestNativeRecheck', actionId: requestId, sessionId: session.id,
          flowId: state.flow_id, headSha, ...request,
          admissionEnabled: selectedManual(config, session),
        });
        if (!decision.decision.accepted) {
          // A waiting decision cannot permanently consume the intent UUID.
          // Roll back its journal too so the same intent can be reconsidered.
          throw Object.assign(new Error(decision.decision.reason), { code: 'NATIVE_RECHECK_WAITING' });
        }
        await transaction.withSession(session.id, persistDetails);
        const work = await enqueueContinuation(transaction, {
          sessionId: session.id, flowId: state.flow_id, headSha,
        }, requestId, decision.decision.effects[0].effectKey, true, request);
        return { status: 'durable', requestId, work };
      });
    } catch (error) {
      if (error.code !== 'NATIVE_RECHECK_WAITING') throw error;
      return { status: 'waiting', code: error.message,
        reconciliation: { owner: 'native-preview-requests', requestId, headSha } };
    }
  }

  async function prepareAccepted(transaction, { actionId, sessionId, headSha, startedStatus = 'active' }) {
    const preparation = await preview.requestInTransaction(transaction, {
      type: 'RequestCandidatePreview',
      actionId,
      sessionId,
      headSha,
      startedStatus,
    });
    // The head and its required work cannot commit separately.
    if (!preparation.decision.accepted) {
      throw Object.assign(new Error(preparation.decision.reason), { code: 'CLI_PREVIEW_ADMISSION_REJECTED' });
    }
    await transaction.withSession(sessionId, client => client.query(
      'UPDATE cli_preview_handoffs SET flow_id = $2, preparation_work_id = $3 WHERE session_id = $1',
      [sessionId, preparation.decision.flow.id, preparation.work.id],
    ));
    return preparation;
  }

  function syncBlocked(state) {
    return {
      status: 'blocked', code: state.sync_reconciliation.reason,
      reconciliation: state.sync_reconciliation,
    };
  }

  async function admitSubmission({ session, headSha, landedHeadSha, moveKind, persistDetails = async () => {} }) {
    if (landedHeadSha !== headSha) return { accepted: false, reason: 'submission_head_unverified' };
    if (selectedManual(config, session) && !require('../preview-lifecycle').enabled(config)) {
      throw new Error('Native submission requires the checks lifecycle');
    }
    return runtime.transact(async transaction => {
      const current = await transaction.withSession(session.id, async (client, row) => ({
        session: row,
        handoff: (await client.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [session.id])).rows[0],
      }));
      const state = current.handoff;
      // Replay before inspecting mutable admission switches or old snapshots.
      // The producer freshly verifies source attribution and the landed branch.
      if (state?.head_sha === headSha && current.session.checks_commit_sha === headSha
          && current.session.user_id === session.user_id && ordinaryNative(current.session)
          && current.session.branch_name === session.branch_name
          && ['active', 'paused', 'promoted'].includes(current.session.status)
          && (current.session.status !== 'promoted' || current.session.reviewed_head_sha === headSha)) {
        let work = state.sync_reconciliation ? await resumeSync(transaction, state)
          : await readWork(transaction, session.id, state.preparation_work_id);
        const original = await transaction.withSession(session.id, async client => {
          return (await client.query(`SELECT action_id, decision FROM cli_preview_decisions
            WHERE session_id = $1 AND action->>'type' = 'AcceptNativeSubmissionHead'
              AND action->>'headSha' = $2 AND decision->>'accepted' = 'true'
            ORDER BY id DESC LIMIT 1`, [session.id, headSha])).rows[0];
        });
        // A later same-head manual repair has its own intent. It cannot replace
        // the original source submission's receipt, including completed retries.
        if (original && work?.status !== 'blocked') {
          work = await transaction.withSession(session.id, async client => {
            return (await client.query(`SELECT * FROM execution_work_requests
              WHERE session_id = $1 AND caused_by = $2 AND workflow = $3`,
            [session.id, original.action_id, PREPARE_RUNTIME])).rows[0];
          });
          if (!work) throw new Error('Accepted native submission has no required preparation receipt');
        }
        const receipt = original || await transaction.withSession(session.id, async client => {
          return (await client.query('SELECT decision FROM cli_preview_receipts WHERE session_id = $1 AND action_id = $2',
            [session.id, state.admission_id])).rows[0];
        });
        return {
          accepted: true, replayed: true, work, blocked: work?.status === 'blocked',
          requestId: original?.action_id || state.admission_id,
          checksCarry: receipt?.decision.change.checksCarry === true,
          approvalEpoch: Number(current.session.approval_epoch || 0),
        };
      }
      const action = {
        type: 'AcceptNativeSubmissionHead', actionId: randomUUID(), sessionId: session.id,
        userId: session.user_id, headSha, landedHeadSha, moveKind,
        expectedStatus: session.status, branchName: session.branch_name,
        previousChecks: session.checks_commit_sha || null,
        previousPreviewName: session.staging_runtime_name || null,
        previousReviewed: session.reviewed_head_sha || null,
        previousEpoch: Number(session.approval_epoch || 0),
        previousCheckState: session.check_state || null,
        previousCheckPhase: session.check_phase || null,
        admissionEnabled: selectedManual(config, session),
      };
      const accepted = await owner.applyInTransaction(transaction, action);
      if (!accepted.decision.accepted) return { accepted: false, reason: accepted.decision.reason };
      await transaction.withSession(session.id, persistDetails);
      const work = accepted.decision.change.deferPreparation
        ? syncBlocked(accepted.current.handoff)
        : (await prepareAccepted(transaction, action)).work;
      return { accepted: true, work, blocked: work?.status === 'blocked', requestId: action.actionId,
        checksCarry: accepted.decision.change.checksCarry,
        approvalEpoch: accepted.decision.change.approvalEpoch };
    }).catch(error => {
      // A preparation guard is ordinary waiting. The shared runtime already
      // rolled back acceptance and its writes; transport/operation errors still
      // propagate, including an uncertain COMMIT reply.
      if (error.code !== 'CLI_PREVIEW_ADMISSION_REJECTED') throw error;
      return { accepted: false, reason: error.message };
    });
  }

  async function admitSync({ session, headSha, workerResult, workerSha, moveKind }) {
    const admissionEnabled = selected(config, session);
    if (admissionEnabled) assertAdmissionConfig();
    return runtime.transact(async transaction => {
      const current = await transaction.withSession(session.id, async (client, row) => ({
        session: row,
        handoff: (await client.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [session.id])).rows[0],
      }));
      const enrolledHead = current.handoff;
      if (enrolledHead?.head_sha === headSha && current.session?.handoff_head_sha === headSha
          && current.session.checks_commit_sha === headSha
          && ['active', 'promoted'].includes(current.session.status)
          && (current.session.status !== 'promoted' || current.session.reviewed_head_sha === headSha)) {
        const work = enrolledHead.sync_reconciliation
          ? await resumeSync(transaction, enrolledHead)
          : await readWork(transaction, session.id, enrolledHead.preparation_work_id);
        return {
          accepted: true, replayed: true, work, blocked: work?.status === 'blocked',
          approvalEpoch: Number(current.session.approval_epoch || 0),
        };
      }
      const action = {
        type: 'AcceptCliSyncHead', actionId: randomUUID(), sessionId: session.id, headSha,
        expectedStatus: session.status,
        branchName: session.branch_name,
        previousHead: session.handoff_head_sha || null,
        previousUploaded: session.handoff_uploaded_sha || null,
        previousChecks: session.checks_commit_sha || null,
        previousLocalCommit: session.handoff_local_commit_sha || null,
        previousUploadChecked: session.handoff_upload_checked_sha || null,
        previousPreviewName: session.staging_runtime_name || null,
        previousReviewed: session.reviewed_head_sha || null,
        previousEpoch: Number(session.approval_epoch || 0),
        workerResult, workerSha, admissionEnabled, moveKind,
      };
      const accepted = await owner.applyInTransaction(transaction, action);
      if (!accepted.decision.accepted) return { accepted: false, reason: accepted.decision.reason };
      if (accepted.decision.change.deferPreparation) {
        return { accepted: true, blocked: true, work: syncBlocked(accepted.current.handoff) };
      }
      const preparation = await prepareAccepted(transaction, action);
      return { accepted: true, work: preparation.work, approvalEpoch: accepted.decision.change.approvalEpoch };
    });
  }

  async function resumeSync(transaction, state) {
    const native = state.sync_reconciliation.source === 'native-submission';
    if (native) {
      const session = await transaction.withSession(state.session_id, async (_client, row) => row);
      if (!selectedManual(config, session)) return syncBlocked(state);
      if (!require('../preview-lifecycle').enabled(config)) throw new Error('Native submission requires the checks lifecycle');
    } else {
      if (!selected(config, { source: 'cli_handoff' })) return syncBlocked(state);
      assertAdmissionConfig();
    }
    const accepted = await owner.applyInTransaction(transaction, {
      type: native ? 'ResumeNativeSubmissionPreparation' : 'ResumeCliSyncPreparation', actionId: randomUUID(),
      sessionId: state.session_id, headSha: state.head_sha, admissionId: state.admission_id,
    });
    if (!accepted.decision.accepted) {
      return { status: 'blocked', code: accepted.decision.reason, reconciliation: state.sync_reconciliation };
    }
    const preparation = await prepareAccepted(transaction, {
      actionId: state.admission_id, sessionId: state.session_id,
      headSha: state.head_sha, startedStatus: state.started_status,
    });
    return preparation.work;
  }

  async function reconcileSyncs(limit = 25) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid sync reconciliation batch size');
    // Discovery runs on the existing bounded discovery pool. Rotate before
    // taking aggregate locks so busy/rejected obligations remain retryable.
    const { rows } = await pool.query(`WITH selected AS (
      SELECT session_id FROM cli_preview_handoffs WHERE sync_reconciliation IS NOT NULL
      ORDER BY sync_reconcile_at, session_id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE cli_preview_handoffs h SET sync_reconcile_at = clock_timestamp()
      FROM selected s WHERE h.session_id = s.session_id RETURNING h.session_id`, [limit]);
    for (const row of rows) {
      try { await recover(row.session_id); }
      catch { /* Rolled back by the shared runtime; the obligation remains. */ }
    }
  }

  async function enqueueContinuation(transaction, identity, causedBy, effectKey, force = false, requestedRecheck) {
    const existing = await store.find(transaction, identity.sessionId, effectKey);
    if (existing) return existing;
    const work = await store.enqueue(transaction, {
      id: randomUUID(),
      effectKey,
      sessionId: identity.sessionId,
      workflow: CONTINUE,
      version: 1,
      causedBy,
      input: {
        ...identity,
        checksActionId: randomUUID(),
        observedActionId: randomUUID(),
        force,
        ...(requestedRecheck ? { requestedRecheck } : {}),
      },
    });
    await transaction.withSession(identity.sessionId, client => client.query(
      'UPDATE cli_preview_handoffs SET continuation_work_id = $2 WHERE session_id = $1',
      [identity.sessionId, work.id],
    ));
    return work;
  }

  async function candidateAccepted(transaction, attempt) {
    const { identity, preparedActionId } = attempt.input;
    const enrolledHead = await transaction.withSession(attempt.session_id, async client => {
      return (await client.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [attempt.session_id])).rows[0];
    });
    // Older admitted work and other experimental callers retain their contract.
    if (enrolledHead?.flow_id !== identity.flowId) return;
    const session = await transaction.withSession(attempt.session_id, async (_client, row) => row);
    const available = await owner.applyInTransaction(transaction, {
      type: nativeAction(session, 'CliCandidateAvailable'),
      actionId: preparedActionId,
      sessionId: attempt.session_id,
      flowId: identity.flowId,
      headSha: identity.headSha,
    });
    if (!available.decision.accepted) throw new Error(`Candidate handoff rejected: ${available.decision.reason}`);
    await enqueueContinuation(transaction, {
      sessionId: attempt.session_id,
      flowId: identity.flowId,
      headSha: identity.headSha,
    }, preparedActionId, available.decision.effects[0].effectKey);
  }

  function current(state, input) {
    return state.handoff?.flow_id === input.flowId
      && state.handoff.head_sha === input.headSha
      && state.preview.flow?.id === input.flowId
      && !nativeHeadCondition(state.preview.session, state.handoff.started_status, input.headSha);
  }

  async function runContinuation({ attempt, signal }) {
    const input = attempt.input;
    let state = await owner.read(attempt.session_id);
    if (!current(state, input)) return { outcome: 'succeeded', code: 'handoff_obsolete' };
    const app = (await pool.query('SELECT * FROM apps WHERE id = $1', [state.session.app_id])).rows[0];
    if (state.preview.flow.state !== 'ready') {
      const activationAttempt = {
        ...attempt,
        input: { intent: state.preview.resource.intent },
      };
      const activated = await preview.guarded(activationAttempt, async resourceConfig => {
        return activate({
          pool,
          config: resourceConfig,
          app,
          sessionId: attempt.session_id,
          flowId: input.flowId,
        });
      });
      if (activated?.outcome === 'waiting') return activated;
      if (!activated.accepted) return { outcome: 'succeeded', code: activated.reason };
      state = await owner.read(attempt.session_id);
    }
    if (signal.aborted) return { outcome: 'retry' };
    if (!current(state, input)) return { outcome: 'succeeded', code: 'handoff_obsolete' };

    const permission = await owner.apply({
      type: nativeAction(state.session, 'RequestCliPreviewChecks'),
      actionId: input.checksActionId,
      sessionId: attempt.session_id,
      flowId: input.flowId,
      headSha: input.headSha,
      force: input.force,
    });
    if (!permission.decision.accepted) return { outcome: 'succeeded', code: permission.decision.reason };
    state = permission.current;
    // Receipts replay decisions; they do not grant permission over a new head.
    if (!current(state, input)) return { outcome: 'succeeded', code: 'handoff_obsolete' };
    if (!checksSettled(state.session) || state.checksOutstanding) {
      if (!require('../preview-lifecycle').enabled(config)) {
        throw new Error('Enrolled checks require the preview lifecycle; fallback is forbidden');
      }
      const receipt = state.preview.binding.observed.receipt;
      const result = { ...receipt, hostname: new URL(receipt.stagingUrl).hostname };
      const session = (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [attempt.session_id])).rows[0];
      await warm(session, result.hostname, result.stagingUrl).catch(error => {
        require('../logger').warn('native-preview', 'Preview edge warm failed (non-fatal)', {
          sessionId: attempt.session_id, err: error.message,
        });
      });
      notify(session, app, result);
      await capture(config, session, app, input.headSha, result, {
        trigger: input.force ? 'manual' : 'commit-push',
        force: input.force,
        recoverExisting: true,
        ...(ordinaryNative(session) ? { previewFlowId: input.flowId } : { cliFlowId: input.flowId }),
      });
    }
    state = await owner.read(attempt.session_id);
    if (!current(state, input)) return { outcome: 'succeeded', code: 'handoff_obsolete' };
    return checksSettled(state.session) && !state.checksOutstanding
      ? { outcome: 'succeeded', result: { checksObserved: true } }
      : {
        outcome: 'waiting',
        code: state.handoff.checks_recovery ? 'checks_outcome_blocked' : 'checks_continuation_pending',
        result: state.handoff.checks_recovery ? { checksBlocked: state.handoff.checks_recovery } : null,
        delayMs: 1000,
      };
  }

  async function commitContinuation(transaction, attempt, proposed) {
    if (!proposed.result?.checksObserved) return proposed;
    const session = await transaction.withSession(attempt.session_id, async (_client, row) => row);
    const result = await owner.applyInTransaction(transaction, {
      type: nativeAction(session, 'CliPreviewChecksObserved'),
      actionId: attempt.input.observedActionId,
      sessionId: attempt.session_id,
      flowId: attempt.input.flowId,
      headSha: attempt.input.headSha,
    });
    return { ...proposed, result: { accepted: result.decision.accepted, reason: result.decision.reason } };
  }

  async function recover(sessionId, {
    force = false,
    repair = false,
    expectedRuntimeName,
    expectedHeadSha,
  } = {}) {
    // Persisted enrollment always wins over flags, old queues and repair timers.
    return runtime.transact(async transaction => {
      const state = await transaction.withSession(sessionId, async client => {
        return (await client.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [sessionId])).rows[0];
      });
      if (!state) return null;
      if (state.sync_reconciliation) return resumeSync(transaction, state);
      if (!state.flow_id) return null;
      const activeId = state.continuation_work_id || state.preparation_work_id;
      const active = await readWork(transaction, sessionId, activeId);
      const session = await transaction.withSession(sessionId, async (_client, row) => row);
      if (ordinaryNative(session) && session.checks_commit_sha !== state.head_sha) {
        // The mismatch is persisted by the head writer and remains visible.
        // Even outstanding work for the old head cannot represent the new one.
        return { status: 'blocked', code: 'native_head_admission_required',
          reconciliation: { owner: 'native-preview-requests', headSha: session.checks_commit_sha } };
      }
      if (ordinaryNative(session) && force) {
        return { status: 'blocked', code: 'native_recheck_command_required',
          reconciliation: { owner: 'native-preview-requests', headSha: state.head_sha } };
      }
      if (['queued', 'running', 'blocked'].includes(active.status) || ordinaryNative(session)) return active;
      const failedPreparation = !state.continuation_work_id && active.result?.prepared === false;
      if (repair || (force && failedPreparation)) {
        // Recovery does not expand admission after the local switch is off.
        // Existing work still runs; a fresh attempt requires current admission.
        if (!selected(config, { source: 'cli_handoff' })) return active;
        assertAdmissionConfig();
        const session = await transaction.withSession(sessionId, async (_client, row) => row);
        if (repair && expectedRuntimeName === undefined) return active;

        // Carry the manual observation into the existing head action. Its
        // reducer owns both revision and serving-runtime comparisons; recovery
        // must not substitute fresh observations as permission for an old click.
        const expectedChecksSha = expectedHeadSha === undefined
          ? session.checks_commit_sha || null
          : expectedHeadSha;
        const expectedPreviewName = repair ? expectedRuntimeName : session.staging_runtime_name || null;
        const admitted = await admitInTransaction(transaction, {
          session,
          headSha: state.head_sha,
          retryPreparation: true,
          expectedChecksSha,
          expectedPreviewName,
        });
        return admitted.accepted ? admitted.work : active;
      }
      if (!force) return active;
      const actionId = randomUUID();
      const identity = {
        sessionId,
        flowId: state.flow_id,
        headSha: expectedHeadSha === undefined ? state.head_sha : expectedHeadSha,
      };
      const admission = await owner.applyInTransaction(transaction, {
        type: 'RequestCliPreviewChecks',
        actionId,
        ...identity,
        force: true,
      });
      if (!admission.decision.accepted) return active;
      return enqueueContinuation(transaction, identity, actionId, `${actionId}:checks`, true);
    });
  }

  return {
    admit,
    admitSubmission,
    admitSync,
    admitManual,
    manualReceipt,
    requestRecheck,
    recover,
    reconcileSyncs,
    owner,
    preview,
    store,
    handlers: {
      ...preview.handlers,
      ...require('./settlement').createChecksSettlement(pool, config, { store }).handlers,
      [CONTINUE]: { version: 1, run: runContinuation, commit: commitContinuation },
    },
  };
}

// Retained CLI callers and persisted workflow names share this implementation.
module.exports = { selected, selectedManual, enrolled, createNativePreviewWork,
  createCliHandoffWork: createNativePreviewWork, CONTINUE };
