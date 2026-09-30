'use strict';

const { randomUUID } = require('node:crypto');
const { createPreviewFlow } = require('./store');

// Legacy executor adapter. The reducer describes BuildPreview; this adapter
// executes it after commit. This is deliberately not a durable outbox yet.
async function prepareNativePreview({ pool, session, app, config, headSha, build,
  cleanup = require('./cleanup').underBuildLock }) {
  const owner = createPreviewFlow(pool);
  // Handoff submissions/rechecks historically rebuild even on the same SHA.
  // Preserve that explicit retry policy rather than silently joining a ready
  // preview whose runtime may have disappeared.
  const start = await owner.apply({ type: 'RetryPreview', actionId: randomUUID(),
    sessionId: session.id, headSha, startedStatus: session.status === 'paused' ? 'paused' : 'active' });
  if (!start.decision.accepted) return { accepted: false, reason: start.decision.reason };
  const effect = start.decision.effects.find(value => value.type === 'BuildPreview');
  if (!effect) throw new Error('Accepted native retry did not describe its build effect');
  const identity = { flowId: effect.flowId, generation: effect.generation, headSha: effect.headSha };
  let result;
  let publication;
  try {
    await build(config, session, app, effect.headSha, { previewFlow: identity,
      beforeBuild: locators => owner.recordIntent(session.id, identity.flowId, locators),
      consumePrepared: async prepared => {
        result = prepared;
        const discard = async () => {
          try { return await cleanup({ pool, config, sessionId: session.id, flowId: identity.flowId }); }
          catch (err) {
            // The pre-create intent is still pending and the sweeper retries it.
            require('../logger').warn('preview-cleanup', 'Immediate cleanup deferred', {
              sessionId: session.id, flowId: identity.flowId, err: err.message,
            });
            return { pending: true };
          }
        };
        try {
          const receipt = await owner.recordRuntime(session.id, identity.flowId, {
            commitSha: result.commitSha, stagingUrl: result.stagingUrl,
            runtimeKind: result.runtimeKind, runtimeName: result.runtimeName,
            containerId: result.containerId, imageRef: result.imageRef, buildRef: result.buildRef ?? null,
          });
          publication = await owner.apply({ type: 'PreviewReady', actionId: randomUUID(),
            sessionId: session.id, ...identity, receipt });
          if (!publication.decision.accepted) await discard();
        } catch (err) { await discard(); throw err; }
      },
    });
    if (!publication) throw new Error('Native executor did not consume its prepared runtime under the build lock');
    return { accepted: publication.decision.accepted, reason: publication.decision.reason,
      result, identity };
  } catch (err) {
    err.previewFlow = identity;
    // Diagnostic only; cleanup owns the pre-create intent even when recording
    // the complete observation failed. Never restore an unaccepted public URL.
    if (result) err.previewRuntime = result;
    throw err;
  }
}

module.exports = { prepareNativePreview };
