'use strict';

const { randomUUID } = require('node:crypto');
const { createSessionDecisionRuntime } = require('../decision-runtime');
const { createExecutionStore } = require('../execution/store');
const { createProposalReview } = require('./store');

const ANNOUNCE_RETURN = 'proposal-review-announce-return';

function createReviewWork(pool, config, {
  store = createExecutionStore(pool),
  owner = createProposalReview(pool),
} = {}) {
  const runtime = createSessionDecisionRuntime(pool);

  async function request(action) {
    if (config.proposalReviewWorkerEnabled !== true) {
      throw new Error('Durable proposal review admission is experimentally disabled');
    }
    if (action.type !== 'RequestImportedReturnToDevelopment') {
      throw new Error('The contained execution entry requires an imported return request');
    }
    return runtime.transact(async transaction => {
      const admission = await owner.applyInTransaction(transaction, action);
      const effects = admission.decision.effects;
      if (!effects.length) return admission;
      if (effects.length !== 1 || effects[0].type !== 'AnnounceReturnToDevelopment') {
        throw new Error('Review execution cannot discard unsupported required effects');
      }
      const effect = effects[0];
      const existing = await store.find(transaction, action.sessionId, effect.effectKey);
      if (existing) return { ...admission, work: existing };
      if (admission.replayed) throw new Error('Cannot enroll an already accepted synchronous return');

      const work = await store.enqueue(transaction, {
        id: randomUUID(),
        effectKey: effect.effectKey,
        sessionId: action.sessionId,
        workflow: ANNOUNCE_RETURN,
        version: 1,
        causedBy: action.actionId,
        input: {
          returnActionId: action.actionId,
          announcementActionId: randomUUID(),
        },
      });
      return { ...admission, work };
    });
  }

  // Append-only SQL publication differs from preview resource creation: it
  // requires no external resource guard or creation checkpoint. The original
  // return receipt supplies authority and text in the domain settlement.
  async function run({ signal }) {
    return { outcome: signal.aborted ? 'retry' : 'succeeded' };
  }

  async function commit(transaction, attempt, proposed) {
    if (proposed.outcome !== 'succeeded') return proposed;
    const result = await owner.applyInTransaction(transaction, {
      type: 'RequestReturnAnnouncement',
      actionId: attempt.input.announcementActionId,
      sessionId: attempt.session_id,
      returnActionId: attempt.input.returnActionId,
    });
    return {
      ...proposed,
      result: { accepted: result.decision.accepted, reason: result.decision.reason },
    };
  }

  return { request, store, handlers: { [ANNOUNCE_RETURN]: { version: 1, run, commit } } };
}

module.exports = { createReviewWork, ANNOUNCE_RETURN };
