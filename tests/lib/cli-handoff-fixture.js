'use strict';

const assert = require('node:assert/strict');
const { createCliHandoffWork } = require('../../src/services/cli-preview-handoff/work');
const { createActivation } = require('../../src/services/preview-flow/activation');
const { createBindingAdapters } = require('../../src/services/preview-flow/binding-adapters');
const { createCleanup } = require('../../src/services/preview-flow/cleanup');

async function addHandoffColumns(pool) {
  await pool.query(`ALTER TABLE apps ADD COLUMN main_sha TEXT;
    ALTER TABLE chat_sessions ADD COLUMN handoff_head_sha TEXT,
      ADD COLUMN handoff_uploaded_sha TEXT, ADD COLUMN handoff_upload_checked_sha TEXT,
      ADD COLUMN handoff_local_commit_sha TEXT, ADD COLUMN check_trigger TEXT, ADD COLUMN checks_base_sha TEXT`);
}

function handoffWorker(f, { onPhase = async () => {}, capture, activation, loseActivationReply = false } = {}) {
  const config = { ...f.config, nativeCliPreviewHandoffEnabled: true, selfAppSlug: 'demo',
    kubernetes: { ...f.config.kubernetes, appDomain: 'fixture.invalid' } };
  const routes = createBindingAdapters({ clients: () => f.clients });
  const changeBinding = routes.activate;
  let replyLost = false;
  routes.activate = async (...args) => {
    const result = await changeBinding(...args);
    if (loseActivationReply && !replyLost) {
      replyLost = true;
      await onPhase('activation_reply_lost');
      throw new Error('Injected lost reply after real Ingress change');
    }
    return result;
  };
  const activate = activation || createActivation({
    routes,
    async verify(resourceConfig, intent, _flowId, receipt) {
      const runtime = await f.runtimes.inspect(resourceConfig, intent);
      const image = await f.images.inspect(intent);
      assert.equal(runtime.status, 'healthy');
      assert.equal(runtime.physicalId, receipt.physicalId);
      assert.equal(image.status, 'succeeded');
      assert.equal(image.uid, intent.buildOperation.receipt.uid);
      assert.equal(image.imageRef, receipt.imageRef);
    },
  }).underBuildLock;
  const work = createCliHandoffWork(f.pool, config, {
    previewOptions: {
      owner: f.owner,
      clones: f.clones,
      images: f.images,
      runtimes: f.runtimes,
      cleanup: createCleanup({ clones: f.clones, images: f.images, runtimes: f.runtimes }).underBuildLock,
    },
    async activate(args) {
      const result = await activate(args);
      if (result.accepted) await onPhase('activated');
      return result;
    },
    capture: capture || (async (_config, session, _app, headSha) => {
      // Check execution is injected; the existing guarded SQL verdict is real.
      assert.equal(await require('../../src/services/visuals').storeChecks(f.pool, session.id, headSha,
        { state: 'passing', results: [] }), true);
      await onPhase('checks_stored');
    }),
    // The disposable fixture has no public edge or web UI. These are transport
    // substitutions, not successful Build/runtime/check observations.
    warm: async () => {},
    notify: () => {},
  });
  const settle = work.store.settle;
  work.store.settle = async (...args) => {
    const result = await settle(...args);
    const record = await work.store.read(args[0].id);
    if (record.workflow === 'native-preview-kubernetes-prepare' && record.result?.accepted) {
      await onPhase('candidate_committed');
    }
    return result;
  };
  return work;
}

module.exports = { addHandoffColumns, handoffWorker };
