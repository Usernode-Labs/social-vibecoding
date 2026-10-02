'use strict';

const { randomUUID } = require('node:crypto');
const { createSessionDecisionRuntime } = require('../decision-runtime');
const { createCliPreviewHandoff } = require('./store');
const { checksSettled } = require('./reducer');
const { nativeHeadCondition } = require('../preview-flow/enabling-conditions');
const { createPreviewWork } = require('../preview-flow/work');

const CONTINUE = 'native-cli-preview-continuation';

function selected(config, session) {
  return config.nativeCliPreviewHandoffEnabled === true
    && session.source === 'cli_handoff'
    && config.appRuntime === 'kubernetes'
    && config.kubernetes?.buildEngine === 'kpack';
}

async function enrolled(pool, sessionId) {
  const { rows } = await pool.query('SELECT session_id, flow_id FROM cli_preview_handoffs WHERE session_id = $1', [sessionId]);
  return rows.some(row => Number(row.session_id) === Number(sessionId) && !!row.flow_id);
}

function createCliHandoffWork(pool, config, {
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
    persistDetails = async () => {},
  }) {
    // Acquire the aggregate before inspecting deduplication or accepting a head.
    const state = await transaction.withSession(session.id, async client => {
      return (await client.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [session.id])).rows[0];
    });
    if (state?.head_sha === headSha) {
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
      previousPreviewName: session.staging_runtime_name || null,
      previousHead: session.handoff_head_sha || null,
      previousChecks: session.checks_commit_sha || null,
      uploadCheckedSha: session.handoff_upload_checked_sha || null,
    };
    const accepted = await owner.applyInTransaction(transaction, action);
    if (!accepted.decision.accepted) return { accepted: false, reason: accepted.decision.reason };
    const preparation = await preview.requestInTransaction(transaction, {
      type: 'RequestCandidatePreview',
      actionId: action.actionId,
      sessionId: session.id,
      headSha,
      startedStatus: action.startedStatus,
    });
    // Head acceptance must not survive a rejected preparation admission.
    if (!preparation.decision.accepted) {
      throw Object.assign(new Error(preparation.decision.reason), { code: 'CLI_PREVIEW_ADMISSION_REJECTED' });
    }
    await transaction.withSession(session.id, async client => {
      await client.query(`UPDATE cli_preview_handoffs SET flow_id = $2, preparation_work_id = $3
        WHERE session_id = $1`, [session.id, preparation.decision.flow.id, preparation.work.id]);
      await persistDetails(client);
    });
    return { accepted: true, work: preparation.work };
  }

  async function enqueueContinuation(transaction, identity, causedBy, effectKey, force = false) {
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
    const available = await owner.applyInTransaction(transaction, {
      type: 'CliCandidateAvailable',
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
      type: 'RequestCliPreviewChecks',
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
        require('../logger').warn('cli-preview-handoff', 'Preview edge warm failed (non-fatal)', {
          sessionId: attempt.session_id, err: error.message,
        });
      });
      notify(session, app, result);
      await capture(config, session, app, input.headSha, result, {
        trigger: input.force ? 'manual' : 'commit-push',
        force: input.force,
        recoverExisting: true,
      });
    }
    state = await owner.read(attempt.session_id);
    if (!current(state, input)) return { outcome: 'succeeded', code: 'handoff_obsolete' };
    return checksSettled(state.session) && !state.checksOutstanding
      ? { outcome: 'succeeded', result: { checksObserved: true } }
      : { outcome: 'waiting', code: 'checks_continuation_pending', delayMs: 1000 };
  }

  async function commitContinuation(transaction, attempt, proposed) {
    if (!proposed.result?.checksObserved) return proposed;
    const result = await owner.applyInTransaction(transaction, {
      type: 'CliPreviewChecksObserved',
      actionId: attempt.input.observedActionId,
      sessionId: attempt.session_id,
      flowId: attempt.input.flowId,
      headSha: attempt.input.headSha,
    });
    return { ...proposed, result: { accepted: result.decision.accepted, reason: result.decision.reason } };
  }

  async function recover(sessionId, { force = false, repair = false, expectedRuntimeName } = {}) {
    // Persisted enrollment always wins over flags, old queues and repair timers.
    return runtime.transact(async transaction => {
      const state = await transaction.withSession(sessionId, async client => {
        return (await client.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [sessionId])).rows[0];
      });
      if (!state?.flow_id) return null;
      const activeId = state.continuation_work_id || state.preparation_work_id;
      const active = await readWork(transaction, sessionId, activeId);
      if (['queued', 'running', 'blocked'].includes(active.status)) return active;
      const failedPreparation = !state.continuation_work_id && active.result?.prepared === false;
      if (repair || (force && failedPreparation)) {
        // Recovery does not expand admission after the local switch is off.
        // Existing work still runs; a fresh attempt requires current admission.
        if (!selected(config, { source: 'cli_handoff' })) return active;
        assertAdmissionConfig();
        const session = await transaction.withSession(sessionId, async (_client, row) => row);
        if (repair && (expectedRuntimeName === undefined
            || (session.staging_runtime_name || null) !== expectedRuntimeName)) return active;
        const admitted = await admitInTransaction(transaction, {
          session,
          headSha: state.head_sha,
          retryPreparation: true,
        });
        return admitted.accepted ? admitted.work : active;
      }
      if (!force) return active;
      const actionId = randomUUID();
      const identity = { sessionId, flowId: state.flow_id, headSha: state.head_sha };
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
    recover,
    owner,
    preview,
    store,
    handlers: {
      ...preview.handlers,
      [CONTINUE]: { version: 1, run: runContinuation, commit: commitContinuation },
    },
  };
}

module.exports = { selected, enrolled, createCliHandoffWork, CONTINUE };
