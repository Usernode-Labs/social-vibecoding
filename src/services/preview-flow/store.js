'use strict';

const { randomUUID } = require('node:crypto');
const {
  parseAction,
  runtimeReceipt,
  resourceIntent,
  candidateReceipt,
  isResourceAction,
} = require('./actions');
const { reduce, REDUCER_VERSION } = require('./reducer');
const { createSessionDecisionRuntime, hashJson } = require('../decision-runtime');

function normalizeSha(value) {
  return value ? String(value).toLowerCase() : null;
}

function snapshot(sessionRow, flowRow, resourceRow, bindingRow, retainedPublishedAttempts) {
  return {
    session: sessionRow ? {
      id: sessionRow.id,
      source: sessionRow.source,
      status: sessionRow.status,
      checksCommitSha: normalizeSha(sessionRow.checks_commit_sha),
      reviewedHeadSha: normalizeSha(sessionRow.reviewed_head_sha),
      approvalEpoch: Number(sessionRow.approval_epoch || 0),
    } : null,
    flow: flowRow ? {
      id: flowRow.id,
      generation: Number(flowRow.generation),
      headSha: flowRow.head_sha,
      startedStatus: flowRow.started_status,
      state: flowRow.state,
      ...(flowRow.attempt_id ? { attemptId: flowRow.attempt_id } : {}),
    } : null,
    resource: resourceRow ? {
      flowId: resourceRow.flow_id,
      sessionId: resourceRow.session_id,
      intent: resourceRow.intent,
      receipt: resourceRow.receipt,
      published: !!resourceRow.published_at,
      cleanupStarted: !!resourceRow.cleanup_started_at,
      cleanupCompleted: !!resourceRow.cleanup_completed_at,
      disposition: resourceRow.cleanup_disposition,
      clonePrepared: !!resourceRow.clone_prepared,
      ...(resourceRow.preparation_owner ? { preparationOwner: resourceRow.preparation_owner } : {}),
    } : null,
    retainedPublishedAttempts,
    binding: bindingRow ? { desired: bindingRow.desired, observed: bindingRow.observed } : null,
    preview: sessionRow ? {
      stagingUrl: sessionRow.staging_url,
      containerId: sessionRow.staging_container_id,
      runtimeKind: sessionRow.staging_runtime_kind,
      runtimeName: sessionRow.staging_runtime_name,
      imageRef: sessionRow.staging_image_ref,
      buildRef: sessionRow.staging_build_ref,
      commitSha: sessionRow.staging_commit_sha,
    } : null,
  };
}

async function readState(client, sessionRow, sessionId, { lock = false, resourceFlowId = null } = {}) {
  // The shared runtime locks the aggregate before any domain resource row.
  const flow = await client.query(`SELECT f.* FROM preview_flow_heads h
    JOIN preview_flows f ON f.id = h.flow_id WHERE h.session_id = $1`, [sessionId]);
  const flowRow = flow.rows[0];

  // Cleanup selects a historical obligation; other actions inspect the current
  // flow's resource. Both acquire resource rows after the aggregate lock.
  const targetFlowId = resourceFlowId || flowRow?.id;
  let resourceRow;
  if (targetFlowId) {
    let resourceResult;
    if (lock) {
      resourceResult = await client.query('SELECT * FROM preview_flow_resources WHERE flow_id = $1 AND session_id = $2 FOR UPDATE',
        [targetFlowId, sessionId]);
    } else {
      resourceResult = await client.query('SELECT * FROM preview_flow_resources WHERE flow_id = $1 AND session_id = $2',
        [targetFlowId, sessionId]);
    }
    resourceRow = resourceResult.rows[0];
  }

  const binding = await client.query('SELECT * FROM preview_bindings WHERE session_id = $1', [sessionId]);
  const retained = await client.query(`SELECT COUNT(*) AS count FROM preview_flow_resources
    WHERE session_id = $1 AND intent->>'attemptId' IS NOT NULL
      AND published_at IS NOT NULL AND cleanup_completed_at IS NULL`, [sessionId]);
  return snapshot(sessionRow, flowRow, resourceRow, binding.rows[0], Number(retained.rows[0].count));
}

function persistPreparationFailure(client, action) {
  return require('../visuals').storeChecks(
    client,
    action.sessionId,
    action.headSha,
    { state: 'error', results: [] },
    action.detail,
  );
}

function createPreviewFlow(pool, {
  newId = randomUUID,
  persistFailure = persistPreparationFailure,
} = {}) {
  const runtime = createSessionDecisionRuntime(pool);
  const machine = {
    name: 'preview',
    version: REDUCER_VERSION,
    parseAction,
    reduce,
    async load(client, session, { sessionId, action, lock }) {
      const state = await readState(client, session, sessionId, {
        lock,
        resourceFlowId: action && isResourceAction(action) ? action.flowId : null,
      });
      if (action?.type === 'RetirePreviewPreparation') {
        const { journal } = require('../proposal-review/journal');
        const receipt = await journal.findReceipt(client, sessionId, action.reviewActionId);
        state.reviewReturn = receipt?.decision || null;
      }
      return state;
    },
    facts: (_client, state, action) => {
      if (!state.session && !isResourceAction(action)) {
        throw Object.assign(new Error('Preview session does not exist'), { code: 'PREVIEW_SESSION_MISSING' });
      }
      const facts = { newFlowId: newId() };
      if (action.type === 'RequestCandidatePreview') facts.newAttemptId = newId();
      if (action.type === 'RequestPreviewActivation') facts.newActivationId = newId();
      return facts;
    },
    actionConflict: () => Object.assign(new Error('Preview action ID reused with different input'), {
      code: 'PREVIEW_ACTION_CONFLICT',
    }),
    persist: persistDecision,
    journal: {
      async findReceipt(client, sessionId, actionId) {
        const { rows } = await client.query(`SELECT action_hash, decision
          FROM preview_action_receipts WHERE session_id = $1 AND action_id = $2`, [sessionId, actionId]);
        return rows[0];
      },
      saveReceipt: (client, values) => client.query(`INSERT INTO preview_action_receipts (session_id, action_id, action_hash, decision)
        VALUES ($1, $2, $3, $4)`, values),
      saveTrace: (client, values) => client.query(`INSERT INTO preview_flow_decisions (session_id, action_id, reducer_version, pre_state, action, facts, decision)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, values),
      async trace(client, sessionId) {
        const { rows } = await client.query(`SELECT id, action_id, reducer_version, pre_state, action, facts, decision, created_at
          FROM preview_flow_decisions WHERE session_id = $1 ORDER BY id`, [sessionId]);
        return rows;
      },
    },
  };

  async function persistDecision(client, { state, action, decision }) {
    const resourceAction = isResourceAction(action);
    // Persist only reducer-selected flow and resource changes.
    const { flow, supersededFlow, resourceChange } = decision;
    if (supersededFlow) {
      await client.query('UPDATE preview_flows SET state = $1 WHERE id = $2',
        [supersededFlow.state, supersededFlow.id]);
    }

    if (flow && flow.id !== state.flow?.id) {
      await client.query(`INSERT INTO preview_flows (id, session_id, generation, head_sha, started_status, state, attempt_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        flow.id,
        action.sessionId,
        flow.generation,
        flow.headSha,
        flow.startedStatus,
        flow.state,
        flow.attemptId || null,
      ]);
      await client.query(`INSERT INTO preview_flow_heads (session_id, flow_id)
        VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET flow_id = EXCLUDED.flow_id`,
        [action.sessionId, flow.id]);
    } else if (flow && !resourceAction) {
      await client.query('UPDATE preview_flows SET state = $1 WHERE id = $2',
        [flow.state, flow.id]);
    }

    if (resourceChange?.cleanup === 'start') {
      await client.query('UPDATE preview_flow_resources SET cleanup_started_at = NOW() WHERE flow_id = $1',
        [resourceChange.flowId]);
    } else if (resourceChange?.cleanup === 'reconcile') {
      await client.query(`UPDATE preview_flow_resources SET cleanup_completed_at = NULL, cleanup_disposition = NULL
        WHERE flow_id = $1`, [resourceChange.flowId]);
    } else if (resourceChange?.cleanup === 'complete') {
      await client.query(`UPDATE preview_flow_resources SET cleanup_completed_at = NOW(), cleanup_disposition = $2
        WHERE flow_id = $1`, [resourceChange.flowId, resourceChange.disposition]);
    }

    if (decision.bindingChange) {
      await client.query(`INSERT INTO preview_bindings (session_id, desired, observed)
        VALUES ($1, $2, $3) ON CONFLICT (session_id) DO UPDATE
        SET desired = EXCLUDED.desired, observed = EXCLUDED.observed`, [
        action.sessionId,
        JSON.stringify(decision.bindingChange.desired),
        JSON.stringify(decision.bindingChange.observed),
      ]);
    }

    if (action.type === 'PreviewCandidatePrepared') {
      const recorded = candidateReceipt.parse(state.resource?.receipt);
      if (hashJson(recorded) !== hashJson(action.receipt)) {
        throw new Error('Candidate preparation requires its recorded immutable runtime receipt');
      }
    }

    // Check failure bookkeeping shares this transaction with retirement.
    if (decision.checkFailure) {
      const stored = await persistFailure(client, action);
      if (stored === false) {
        throw new Error('Preview failure admission and check-state write disagree');
      }
    }

    if (decision.projection === 'publish' || decision.projection === 'publish_candidate') {
      // Resource observation must already have committed. A rejected
      // publication or transaction failure cannot erase cleanup identity.
      const resource = await client.query('SELECT receipt FROM preview_flow_resources WHERE flow_id = $1', [action.flowId]);
      // JSONB changes object key order: validate into canonical field order.
      if (decision.projection === 'publish' && (!resource.rows.length
          || hashJson(runtimeReceipt.parse(resource.rows[0].receipt)) !== hashJson(action.receipt))) {
        throw new Error('PreviewReady requires the recorded immutable runtime receipt');
      }
      if (decision.projection === 'publish_candidate') {
        const recorded = candidateReceipt.parse(resource.rows[0]?.receipt);
        const published = candidateReceipt.parse({ ...decision.receipt, stagingUrl: recorded.stagingUrl });
        if (hashJson(recorded) !== hashJson(published)) {
          throw new Error('Activation requires the recorded immutable runtime receipt');
        }
      }
      const receipt = decision.receipt;
      await client.query(`UPDATE chat_sessions SET staging_url = $1, staging_container_id = $2,
        staging_runtime_kind = $3, staging_runtime_name = $4, staging_image_ref = $5,
        staging_build_ref = $6, staging_commit_sha = $7, last_activity_at = NOW() WHERE id = $8`,
        [
          receipt.stagingUrl,
          receipt.containerId,
          receipt.runtimeKind,
          receipt.runtimeName,
          receipt.imageRef,
          receipt.buildRef,
          receipt.commitSha,
          action.sessionId,
        ]);
      await client.query('UPDATE preview_flow_resources SET published_at = NOW() WHERE flow_id = $1', [action.flowId]);
    } else if (decision.projection === 'clear') {
      await client.query(`UPDATE chat_sessions SET staging_url = NULL, staging_container_id = NULL,
        staging_runtime_kind = NULL, staging_runtime_name = NULL, staging_image_ref = NULL,
        staging_build_ref = NULL, staging_commit_sha = NULL WHERE id = $1`, [action.sessionId]);
    }
  }

  const apply = input => runtime.apply(machine, input);
  const applyInTransaction = (transaction, input) => transaction.apply(machine, input);
  const readInTransaction = (transaction, sessionId) => transaction.read(machine, sessionId);

  async function reserveCandidateInTransaction(transaction, sessionId, flowId, input, {
    credentialEnc,
    preparationOwner = null,
  }) {
    return transaction.withSession(sessionId, async client => {
      const intent = resourceIntent.parse(input);
      if (!intent.attemptId || !credentialEnc) {
        throw new Error('Candidate identity and encrypted credential must precede creation');
      }
      const { rows } = await client.query(`INSERT INTO preview_flow_resources
        (flow_id, session_id, intent, clone_credential_enc, preparation_owner)
        SELECT id, session_id, $3::jsonb, $4, $6 FROM preview_flows
        WHERE id = $1 AND session_id = $2 AND attempt_id = $5 AND state = 'preparing'
        ON CONFLICT (flow_id) DO NOTHING RETURNING flow_id`, [
        flowId, sessionId, JSON.stringify(intent), credentialEnc, intent.attemptId, preparationOwner,
      ]);
      if (!rows.length) throw new Error('Candidate attempt already reserved or no longer belongs to this flow');
      return intent;
    });
  }

  async function recordIntent(sessionId, flowId, input, { credentialEnc = null } = {}) {
    const intent = resourceIntent.parse(input);
    if (intent.attemptId) {
      return runtime.transact(transaction => reserveCandidateInTransaction(
        transaction, sessionId, flowId, intent, { credentialEnc },
      ));
    }

    const { rows } = await pool.query(`INSERT INTO preview_flow_resources (flow_id, session_id, intent)
      SELECT id, session_id, $3::jsonb FROM preview_flows WHERE id = $1 AND session_id = $2
      ON CONFLICT (flow_id) DO UPDATE SET intent = preview_flow_resources.intent
      WHERE preview_flow_resources.intent = EXCLUDED.intent
        AND preview_flow_resources.cleanup_started_at IS NULL AND preview_flow_resources.receipt IS NULL
      RETURNING flow_id`,
      [flowId, sessionId, JSON.stringify(intent)]);
    if (!rows.length) {
      throw new Error('Resource intent has a missing flow, conflicting locators, or a consumed execution');
    }
    return intent;
  }

  async function recordRuntime(sessionId, flowId, input) {
    const receipt = input.attemptId ? candidateReceipt.parse(input) : runtimeReceipt.parse(input);

    // An observation is historical, so it may be recorded for a superseded
    // flow. This grants no permission to publish or to remove a shared runtime.
    const { rows } = await pool.query(`INSERT INTO preview_flow_resources (flow_id, session_id, receipt)
      SELECT id, session_id, $3::jsonb FROM preview_flows
      WHERE id = $1 AND session_id = $2 AND head_sha = $4
        AND ($5::uuid IS NULL OR attempt_id = $5)
      ON CONFLICT (flow_id) DO UPDATE SET receipt = EXCLUDED.receipt
      WHERE (preview_flow_resources.receipt IS NULL OR preview_flow_resources.receipt = EXCLUDED.receipt)
        AND (preview_flow_resources.intent IS NULL OR
          (preview_flow_resources.intent->>'runtimeKind' = EXCLUDED.receipt->>'runtimeKind'
           AND preview_flow_resources.intent->>'runtimeName' = EXCLUDED.receipt->>'runtimeName'))
      RETURNING flow_id`,
      [flowId, sessionId, JSON.stringify(receipt), receipt.commitSha, receipt.attemptId || null]);
    if (!rows.length) {
      throw new Error('Runtime observation has a missing flow, wrong head, or conflicting receipt');
    }
    return receipt;
  }

  async function markClonePrepared(sessionId, flowId) {
    const { rows } = await pool.query(`UPDATE preview_flow_resources SET clone_prepared = TRUE
      WHERE flow_id = $1 AND session_id = $2 AND clone_credential_enc IS NOT NULL
        AND cleanup_started_at IS NULL RETURNING flow_id`, [flowId, sessionId]);
    if (!rows.length) throw new Error('Clone completion no longer belongs to a usable attempt');
  }

  const trace = sessionId => runtime.trace(machine, sessionId);
  const read = sessionId => runtime.read(machine, sessionId);

  return {
    apply,
    applyInTransaction,
    readInTransaction,
    recordIntent,
    reserveCandidateInTransaction,
    recordRuntime,
    markClonePrepared,
    trace,
    read,
  };
}

module.exports = { createPreviewFlow };
