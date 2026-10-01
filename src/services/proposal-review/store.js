'use strict';

const { randomUUID } = require('node:crypto');
const { createSessionDecisionRuntime } = require('../decision-runtime');
const { createPreviewFlow } = require('../preview-flow');
const { parseAction } = require('./actions');
const { reduce, REDUCER_VERSION } = require('./reducer');
const { journal } = require('./journal');

async function loadState(client, session, { sessionId, action }) {
  const { rows: secrets } = await client.query(`SELECT EXISTS (
    SELECT 1 FROM pending_secret_declarations WHERE session_id = $1 AND status = 'pending'
  ) AS pending`, [sessionId]);
  let appSlug = null;
  if (session) {
    const { rows: apps } = await client.query('SELECT slug FROM apps WHERE id = $1', [session.app_id]);
    appSlug = apps[0]?.slug || null;
  }

  let announcementState = {};
  if (action?.type === 'RequestReturnAnnouncement') {
    const sourceReturn = await journal.findReceipt(client, sessionId, action.returnActionId);
    const { rows: messages } = await client.query(`SELECT id FROM chat_messages
      WHERE thread_type = 'session' AND thread_ref = $1 AND msg_type = 'system'
        AND metadata->>'returnActionId' = $2 LIMIT 1`, [sessionId, action.returnActionId]);
    announcementState = {
      sourceReturn: sourceReturn?.decision || null,
      returnAnnouncementId: messages[0]?.id || null,
    };
  }
  return {
    ...announcementState,
    session: session ? {
      id: session.id,
      userId: Number(session.user_id),
      appId: session.app_id,
      status: session.status,
      source: session.source,
      headless: session.is_headless,
      turnRunning: !!session.active_turn,
      approvalEpoch: session.approval_epoch,
      prNumber: session.pr_number,
      prTitle: session.pr_title,
    } : null,
    pendingSecret: secrets[0].pending,
    appSlug,
  };
}

async function persistDecision(client, { action, decision }) {
  if (decision.announcement) {
    const message = decision.announcement;
    await client.query(`INSERT INTO chat_messages (app_id, content, msg_type, metadata, thread_type, thread_ref)
      VALUES ($1, $2, 'system', $3, 'session', $4)`, [
      message.appId,
      message.content,
      JSON.stringify({ returnActionId: message.returnActionId }),
      message.sessionId,
    ]);
    return;
  }
  if (!decision.change) return;
  const { status, approvalEpoch } = decision.change;
  // All authoritative return-to-development writes share the decision commit.
  // No GitHub close, staging clear, secret mutation or external teardown here.
  await client.query(`UPDATE chat_sessions SET status = $2, approval_epoch = $3,
    stale_notified_at = NULL, integration_block_reasons = '[]'::jsonb WHERE id = $1`,
    [action.sessionId, status, approvalEpoch]);
}

function createProposalReview(pool, {
  isBusy = sessionId => require('../active-workers').isSessionBusy(sessionId),
  newId = randomUUID,
} = {}) {
  const runtime = createSessionDecisionRuntime(pool);
  const preview = createPreviewFlow(pool);
  const machine = {
    name: 'proposal-review',
    version: REDUCER_VERSION,
    parseAction,
    reduce,
    load: loadState,
    facts: (_client, _state, action) => action.type === 'RequestReturnAnnouncement'
      ? {} : { busyNow: isBusy(action.sessionId) },
    actionConflict: () => Object.assign(new Error('Proposal review action ID reused with different input'), {
      code: 'REVIEW_ACTION_CONFLICT',
    }),
    persist: persistDecision,
    journal,
  };

  async function applyInTransaction(transaction, input) {
    // Domain coordination, not runtime policy: review owns the lifecycle move;
    // preview decides whether that move can retire its unactivated candidate.
    const result = await transaction.apply(machine, input);
    if (result.replayed || !result.decision.change) return result;
    const currentPreview = await preview.readInTransaction(transaction, input.sessionId);
    if (!currentPreview.flow?.attemptId) return result;

    const retirement = await preview.applyInTransaction(transaction, {
      type: 'RetirePreviewPreparation',
      actionId: newId(),
      sessionId: input.sessionId,
      flowId: currentPreview.flow.id,
      generation: currentPreview.flow.generation,
      headSha: currentPreview.flow.headSha,
      reviewActionId: input.actionId,
    });
    if (!retirement.decision.accepted) {
      throw new Error(`Review and preview retirement disagree: ${retirement.decision.reason}`);
    }
    return { ...result, related: retirement };
  }

  const apply = input => runtime.transact(transaction => applyInTransaction(transaction, input));

  const read = sessionId => runtime.read(machine, sessionId);
  const trace = sessionId => runtime.trace(machine, sessionId);
  return { apply, applyInTransaction, read, trace };
}

module.exports = { createProposalReview };
