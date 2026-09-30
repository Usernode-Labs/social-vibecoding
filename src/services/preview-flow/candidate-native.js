'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { encrypt } = require('../secrets');
const { createPreviewFlow } = require('./store');
const { candidateResources } = require('./candidate-resources');
const activation = require('./activation');
const log = require('../logger');

async function prepareCandidatePreview({
  pool,
  config,
  session,
  app,
  headSha,
  build,
  cleanup = require('./cleanup').underBuildLock,
  activate = activation.underBuildLock,
}) {
  // Validate the credential boundary before accepting an execution request.
  const password = randomBytes(24).toString('hex');
  const credentialEnc = encrypt(password, config.dataEncryptionKey);
  const owner = createPreviewFlow(pool);
  const admission = await owner.apply({
    type: 'RequestCandidatePreview',
    actionId: randomUUID(),
    sessionId: session.id,
    headSha,
    startedStatus: session.status === 'paused' ? 'paused' : 'active',
  });
  if (!admission.decision.accepted) return { accepted: false, reason: admission.decision.reason };

  const flow = admission.decision.flow;
  const identity = { flowId: flow.id, generation: flow.generation, headSha: flow.headSha };
  const intent = candidateResources(config, session.id, flow.attemptId);
  let preparedRuntime;
  let publication;

  async function discardCandidate() {
    try {
      await cleanup({ pool, config, sessionId: session.id, flowId: flow.id });
    } catch (error) {
      log.warn('preview-candidate', 'Candidate cleanup remains recoverable', {
        sessionId: session.id,
        flowId: flow.id,
        err: error.message,
      });
    }
  }

  async function consumeCandidate(prepared) {
    preparedRuntime = prepared;
    try {
      const receipt = await owner.recordRuntime(session.id, flow.id, {
        commitSha: prepared.commitSha,
        stagingUrl: prepared.stagingUrl,
        runtimeKind: prepared.runtimeKind,
        runtimeName: prepared.runtimeName,
        containerId: prepared.containerId,
        imageRef: prepared.imageRef,
        buildRef: prepared.buildRef ?? null,
        physicalId: prepared.physicalId,
        attemptId: flow.attemptId,
      });
      const readiness = await owner.apply({
        type: 'PreviewCandidatePrepared',
        actionId: randomUUID(),
        sessionId: session.id,
        ...identity,
        receipt,
      });
      if (!readiness.decision.accepted) {
        publication = { accepted: false, reason: readiness.decision.reason };
        await discardCandidate();
        return;
      }
      publication = await activate({ pool, config, app, sessionId: session.id, flowId: flow.id });
      if (!publication.accepted) await discardCandidate();
    } catch (error) {
      // If activation committed, the reducer protects the desired candidate.
      // Immediate cleanup cannot guess that a failed acknowledgement means no.
      await discardCandidate();
      throw error;
    }
  }

  try {
    await build(config, session, app, headSha, {
      previewFlow: identity,
      candidate: {
        intent,
        password,
        onClonePrepared: () => owner.markClonePrepared(session.id, flow.id),
        onPreparationFailed: discardCandidate,
      },
      beforeBuild: locators => owner.recordIntent(session.id, flow.id, locators, { credentialEnc }),
      consumePrepared: consumeCandidate,
    });
    if (!publication) throw new Error('Candidate executor did not consume its runtime under the resource lock');
    const result = publication.receipt ? {
      ...preparedRuntime,
      stagingUrl: publication.receipt.stagingUrl,
      hostname: new URL(publication.receipt.stagingUrl).hostname,
    } : preparedRuntime;
    return { accepted: publication.accepted, reason: publication.reason, result, identity };
  } catch (error) {
    error.previewFlow = identity;
    throw error;
  }
}

module.exports = { prepareCandidatePreview };
