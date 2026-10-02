'use strict';

// Historical work fixtures only. Production admission must never use this path
// to select an old format. Seed its original payload, then run the real registry.
const { randomUUID, randomBytes } = require('node:crypto');
const { createSessionDecisionRuntime } = require('../../src/services/decision-runtime');
const { createPreviewFlow } = require('../../src/services/preview-flow/store');
const { createPreviewWork, PREPARE, PREPARE_CLONE, PREPARE_IMAGE } = require('../../src/services/preview-flow/work');
const { candidateResources } = require('../../src/services/preview-flow/candidate-resources');
const { reserveImageBuild } = require('../../src/services/preview-flow/image-build-intent');
const { encrypt } = require('../../src/services/secrets');

function createRetainedPreviewWork(pool, config, { workflow = PREPARE, ...options } = {}) {
  if (![PREPARE, PREPARE_CLONE, PREPARE_IMAGE].includes(workflow)) {
    throw new Error('A historical preparation format is required');
  }
  const owner = options.owner || createPreviewFlow(pool);
  const work = createPreviewWork(pool, config, { ...options, owner });
  const runtime = createSessionDecisionRuntime(pool);

  async function seedRetained(action) {
    return runtime.transact(async transaction => {
      const admission = await owner.applyInTransaction(transaction, action);
      if (!admission.decision.accepted) return admission;
      const effect = admission.decision.effects.find(value => value.type === 'BuildPreview');
      const existing = await work.store.find(transaction, action.sessionId, effect.effectKey);
      if (existing) return { ...admission, work: existing };

      return transaction.withSession(action.sessionId, async (client, session) => {
        const app = (await client.query('SELECT * FROM apps WHERE id = $1', [session.app_id])).rows[0];
        const flow = admission.decision.flow;
        const intent = candidateResources(config, session.id, flow.attemptId);
        if (workflow !== PREPARE) {
          intent.cloneOperation = {
            kind: 'template-v1',
            sourceDb: require('../../src/services/db-manager').appDbName(app.slug),
          };
        }
        if (workflow === PREPARE_IMAGE) {
          intent.buildOperation = reserveImageBuild(config, app, flow.headSha);
        }
        const credentialEnc = encrypt(randomBytes(24).toString('hex'), config.dataEncryptionKey);
        await owner.reserveCandidateInTransaction(transaction, session.id, flow.id, intent, {
          credentialEnc,
          preparationOwner: 'bounded',
        });
        const retained = await work.store.enqueue(transaction, {
          id: randomUUID(),
          effectKey: effect.effectKey,
          sessionId: session.id,
          workflow,
          version: 1,
          causedBy: action.actionId,
          input: {
            identity: {
              flowId: flow.id,
              generation: flow.generation,
              headSha: flow.headSha,
            },
            intent,
            app: {
              id: app.id,
              slug: app.slug,
              repo_url: app.repo_url,
            },
            session: {
              id: session.id,
              branch_name: session.branch_name,
              pr_number: session.pr_number,
            },
            preparedActionId: randomUUID(),
            failedActionId: randomUUID(),
            ...(workflow !== PREPARE ? { clonePreparedActionId: randomUUID() } : {}),
            ...(workflow === PREPARE_IMAGE ? { imageBuiltActionId: randomUUID() } : {}),
          },
        });
        return { ...admission, work: retained };
      });
    });
  }

  return { ...work, seedRetained };
}

module.exports = { createRetainedPreviewWork };
