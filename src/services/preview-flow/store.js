'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { parseAction, runtimeReceipt, resourceIntent, isResourceAction } = require('./actions');
const { reduce, REDUCER_VERSION } = require('./reducer');
const { DELETED_SESSION_ACTION_LOCK } = require('../advisory-locks');

const normalizeSha = value => value ? String(value).toLowerCase() : null;
function snapshot(row, flowRow, resourceRow) {
  return {
    session: row ? { id: row.id, source: row.source, status: row.status,
      checksCommitSha: normalizeSha(row.checks_commit_sha),
      reviewedHeadSha: normalizeSha(row.reviewed_head_sha) } : null,
    flow: flowRow ? { id: flowRow.id, generation: Number(flowRow.generation),
      headSha: flowRow.head_sha, startedStatus: flowRow.started_status, state: flowRow.state } : null,
    resource: resourceRow ? { flowId: resourceRow.flow_id, sessionId: resourceRow.session_id,
      intent: resourceRow.intent, receipt: resourceRow.receipt, published: !!resourceRow.published_at,
      cleanupStarted: !!resourceRow.cleanup_started_at, cleanupCompleted: !!resourceRow.cleanup_completed_at,
      disposition: resourceRow.cleanup_disposition } : null,
    preview: row ? {
      stagingUrl: row.staging_url, containerId: row.staging_container_id,
      runtimeKind: row.staging_runtime_kind, runtimeName: row.staging_runtime_name,
      imageRef: row.staging_image_ref, buildRef: row.staging_build_ref,
      commitSha: row.staging_commit_sha,
    } : null,
  };
}
async function readState(client, sessionId, lock = false, resourceFlowId = null) {
  // Always lock the aggregate first, before flow/receipt rows. The enclosing
  // legacy lifecycle also uses this order. This serializes independent Pods.
  const { rows } = lock
    ? await client.query('SELECT * FROM chat_sessions WHERE id = $1 FOR UPDATE', [sessionId])
    : await client.query('SELECT * FROM chat_sessions WHERE id = $1', [sessionId]);
  if (lock && !rows.length && resourceFlowId) {
    // Orphan obligations still need original-decision deduplication, even when
    // two actions target different resources of the deleted aggregate. Original
    // session IDs must not be recycled. This does not fence external I/O.
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [DELETED_SESSION_ACTION_LOCK, sessionId]);
  }
  const flow = await client.query(`SELECT f.* FROM preview_flow_heads h
    JOIN preview_flows f ON f.id = h.flow_id WHERE h.session_id = $1`, [sessionId]);
  const target = resourceFlowId || flow.rows[0]?.id;
  const resource = !target ? { rows: [] } : lock
    ? await client.query('SELECT * FROM preview_flow_resources WHERE flow_id = $1 AND session_id = $2 FOR UPDATE', [target, sessionId])
    : await client.query('SELECT * FROM preview_flow_resources WHERE flow_id = $1 AND session_id = $2', [target, sessionId]);
  return snapshot(rows[0], flow.rows[0], resource.rows[0]);
}
const digest = action => createHash('sha256').update(JSON.stringify(action)).digest('hex');

function createPreviewFlow(pool, {
  newId = randomUUID,
  persistFailure = (client, action) => require('../visuals').storeChecks(client,
    action.sessionId, action.headSha, { state: 'error', results: [] }, action.detail),
} = {}) {
  async function apply(input) {
    const action = parseAction(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const resourceFlowId = isResourceAction(action) ? action.flowId : null;
      const state = await readState(client, action.sessionId, true, resourceFlowId);
      const { rows: replay } = await client.query(`SELECT action_hash, decision
        FROM preview_action_receipts WHERE session_id = $1 AND action_id = $2`,
      [action.sessionId, action.actionId]);
      if (replay.length) {
        if (replay[0].action_hash !== digest(action)) {
          throw Object.assign(new Error('Preview action ID reused with different input'), { code: 'PREVIEW_ACTION_CONFLICT' });
        }
        await client.query('COMMIT');
        return { decision: replay[0].decision, current: state, replayed: true };
      }
      if (!state.session && !isResourceAction(action)) {
        throw Object.assign(new Error('Preview session does not exist'), { code: 'PREVIEW_SESSION_MISSING' });
      }
      const facts = { newFlowId: newId() };
      const decision = reduce(state, action, facts);
      if (decision.accepted) {
        if (decision.supersededFlow) await client.query('UPDATE preview_flows SET state = $1 WHERE id = $2',
          [decision.supersededFlow.state, decision.supersededFlow.id]);
        if (decision.flow && decision.flow.id !== state.flow?.id) {
          await client.query(`INSERT INTO preview_flows (id, session_id, generation, head_sha, started_status, state)
            VALUES ($1, $2, $3, $4, $5, $6)`, [decision.flow.id, action.sessionId,
            decision.flow.generation, decision.flow.headSha, decision.flow.startedStatus, decision.flow.state]);
          await client.query(`INSERT INTO preview_flow_heads (session_id, flow_id)
            VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET flow_id = EXCLUDED.flow_id`,
          [action.sessionId, decision.flow.id]);
        } else if (decision.flow && !isResourceAction(action)) {
          await client.query('UPDATE preview_flows SET state = $1 WHERE id = $2',
            [decision.flow.state, decision.flow.id]);
        }
        if (decision.resourceChange?.cleanup === 'start') {
          await client.query('UPDATE preview_flow_resources SET cleanup_started_at = NOW() WHERE flow_id = $1',
            [decision.resourceChange.flowId]);
        } else if (decision.resourceChange?.cleanup === 'complete') {
          await client.query(`UPDATE preview_flow_resources SET cleanup_completed_at = NOW(), cleanup_disposition = $2
            WHERE flow_id = $1`, [decision.resourceChange.flowId, decision.resourceChange.disposition]);
        }
        if (decision.checkFailure && await persistFailure(client, action) === false) {
          throw new Error('Preview failure admission and check-state write disagree');
        }
        if (decision.projection === 'publish') {
          // Resource observation must already have committed. A rejected
          // publication or transaction failure cannot erase cleanup identity.
          const resource = await client.query('SELECT receipt FROM preview_flow_resources WHERE flow_id = $1', [action.flowId]);
          // JSONB changes object key order: validate into canonical field order.
          if (!resource.rows.length || digest(runtimeReceipt.parse(resource.rows[0].receipt)) !== digest(action.receipt)) {
            throw new Error('PreviewReady requires the recorded immutable runtime receipt');
          }
          const r = decision.receipt;
          await client.query(`UPDATE chat_sessions SET staging_url = $1, staging_container_id = $2,
            staging_runtime_kind = $3, staging_runtime_name = $4, staging_image_ref = $5,
            staging_build_ref = $6, staging_commit_sha = $7, last_activity_at = NOW() WHERE id = $8`,
          [r.stagingUrl, r.containerId, r.runtimeKind, r.runtimeName, r.imageRef, r.buildRef, r.commitSha, action.sessionId]);
          await client.query('UPDATE preview_flow_resources SET published_at = NOW() WHERE flow_id = $1', [action.flowId]);
        } else if (decision.projection === 'clear') {
          await client.query(`UPDATE chat_sessions SET staging_url = NULL, staging_container_id = NULL,
            staging_runtime_kind = NULL, staging_runtime_name = NULL, staging_image_ref = NULL,
            staging_build_ref = NULL, staging_commit_sha = NULL WHERE id = $1`, [action.sessionId]);
        }
      }
      await client.query(`INSERT INTO preview_action_receipts (session_id, action_id, action_hash, decision)
        VALUES ($1, $2, $3, $4)`, [action.sessionId, action.actionId, digest(action), JSON.stringify(decision)]);
      await client.query(`INSERT INTO preview_flow_decisions (session_id, action_id, reducer_version, pre_state, action, facts, decision)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [action.sessionId, action.actionId, REDUCER_VERSION,
        JSON.stringify(state), JSON.stringify(action), JSON.stringify(facts), JSON.stringify(decision)]);
      const current = await readState(client, action.sessionId, false, resourceFlowId);
      await client.query('COMMIT');
      return { decision, current, replayed: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  }

  async function recordIntent(sessionId, flowId, input) {
    const intent = resourceIntent.parse(input);
    const { rows } = await pool.query(`INSERT INTO preview_flow_resources (flow_id, session_id, intent)
      SELECT id, session_id, $3::jsonb FROM preview_flows WHERE id = $1 AND session_id = $2
      ON CONFLICT (flow_id) DO UPDATE SET intent = preview_flow_resources.intent
      WHERE preview_flow_resources.intent = EXCLUDED.intent
        AND preview_flow_resources.cleanup_started_at IS NULL AND preview_flow_resources.receipt IS NULL
      RETURNING flow_id`,
    [flowId, sessionId, JSON.stringify(intent)]);
    if (!rows.length) throw new Error('Resource intent has a missing flow, conflicting locators, or a consumed execution');
    return intent;
  }

  async function recordRuntime(sessionId, flowId, input) {
    const receipt = runtimeReceipt.parse(input);
    // An observation is historical, so it may be recorded for a superseded
    // flow. This grants no permission to publish or to remove a shared runtime.
    const { rows } = await pool.query(`INSERT INTO preview_flow_resources (flow_id, session_id, receipt)
      SELECT id, session_id, $3::jsonb FROM preview_flows
      WHERE id = $1 AND session_id = $2 AND head_sha = $4
      ON CONFLICT (flow_id) DO UPDATE SET receipt = EXCLUDED.receipt
      WHERE (preview_flow_resources.receipt IS NULL OR preview_flow_resources.receipt = EXCLUDED.receipt)
        AND (preview_flow_resources.intent IS NULL OR
          (preview_flow_resources.intent->>'runtimeKind' = EXCLUDED.receipt->>'runtimeKind'
           AND preview_flow_resources.intent->>'runtimeName' = EXCLUDED.receipt->>'runtimeName'))
      RETURNING flow_id`,
    [flowId, sessionId, JSON.stringify(receipt), receipt.commitSha]);
    if (!rows.length) throw new Error('Runtime observation has a missing flow, wrong head, or conflicting receipt');
    return receipt;
  }

  async function trace(sessionId) {
    return (await pool.query(`SELECT id, action_id, reducer_version, pre_state, action, facts, decision, created_at
      FROM preview_flow_decisions WHERE session_id = $1 ORDER BY id`, [sessionId])).rows;
  }
  async function read(sessionId) {
    const client = await pool.connect();
    try {
      // Debug/status reads need one snapshot too: otherwise a head/flow change
      // between the two SELECTs could describe a state that never existed.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = await readState(client, sessionId);
      await client.query('COMMIT');
      return state;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  }
  return { apply, recordIntent, recordRuntime, trace, read };
}

module.exports = { createPreviewFlow };
