'use strict';

const { createHash } = require('node:crypto');
const { Client, Pool } = require('pg');
const { createPreviewFlow } = require('../../src/services/preview-flow');
const { createSessionDecisionRuntime } = require('../../src/services/decision-runtime');
const { createGuard } = require('../../src/services/build-retention-guard');
const { STAGING_BUILD_LOCK } = require('../../src/services/advisory-locks');
const { FLOW_LABEL } = require('../../src/services/preview-flow/cleanup');
const { decrypt } = require('../../src/services/secrets');
const { event } = require('./database');

function createSteps(config, backend) {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const preview = createPreviewFlow(pool);
  const runtime = createSessionDecisionRuntime(pool);
  let lockClient;
  const guard = createGuard({
    makeClient: () => {
      lockClient = new Client({ connectionString: config.databaseUrl, application_name: `c0-lock-${process.pid}` });
      return lockClient;
    },
    // Preserve fail-stop protection, but the independently supervised execution
    // worker dies. Losing its resource lock never terminates the web process.
    onLockLost: () => process.exit(86),
    retryMs: 20,
  });

  async function rpc(input) {
    const response = await fetch(config.resourcesUrl, {
      method: 'POST',
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  }

  const inspect = (work, name) => rpc({ op: 'inspect', workId: work.id, name });

  async function ensure(work, kind, name, body = {}) {
    const object = await rpc({ op: 'create', workId: work.id, kind, name, body });
    if (object.flow_id !== work.id || object.body.headSha !== work.flow.headSha) {
      throw new Error('Resource ownership or revision differs');
    }
    return object;
  }

  async function remove(work, name) {
    const object = await inspect(work, name);
    if (!object) return;
    await rpc({ op: 'remove', workId: work.id, name, uid: object.uid });
  }

  // These shims adapt the controlled transport to the existing candidate runtime
  // UID/label checks and conditional activation/cleanup code, inside this child
  // process only. No production module or global web process is changed.
  // Resource operations on different aggregates may execute concurrently. The
  // work identity lives in AsyncLocalStorage, never a shared current-work flag.
  const { AsyncLocalStorage } = require('node:async_hooks');
  const context = new AsyncLocalStorage();
  function currentWork() { return context.getStore(); }
  function scopedKubeApi(kind) {
    const locator = name => kind === 'Service' ? `${name}-service` : name;
    return {
      [`readNamespaced${kind}`]: async ({ name }) => {
        const object = await inspect(currentWork(), locator(name));
        if (!object) throw Object.assign(new Error('Absent'), { statusCode: 404 });
        return { metadata: { uid: object.uid, labels: { [FLOW_LABEL]: object.flow_id } } };
      },
      [`deleteNamespaced${kind}`]: ({ name, body }) => rpc({
        op: 'remove', workId: currentWork().id, name: locator(name), uid: body.preconditions.uid,
      }),
    };
  }
  require('../../src/services/kubernetes')._getClients = () => ({
    apps: scopedKubeApi('Deployment'),
    core: { ...scopedKubeApi('Service'), ...scopedKubeApi('Secret'), listNamespacedPod: async () => ({ items: [] }) },
  });
  require('../../src/services/application-runtime').probeHealth = async () => true;
  require('../../src/services/docker').execFileAsync = async (command, args) => {
    if (command !== 'rm' || args[0] !== '-rf') throw new Error('No real Docker operation in C0 fixture');
    return { stdout: '' };
  };

  const routes = {
    async inspect(_config, ref) {
      const { rows } = await pool.query('SELECT uid, body FROM c0_objects WHERE name = $1', [`route-${ref.sessionId}`]);
      return { ...rows[0].body, uid: rows[0].uid };
    },
    async activate(_config, ref, expected, receipt) {
      const { rows } = await pool.query(`UPDATE c0_objects SET flow_id = $2,
        body = jsonb_build_object('target', $3::text, 'token', $4::text)
        WHERE name = $1 AND body->>'token' = $5 AND uid = $6 RETURNING uid`, [
        `route-${ref.sessionId}`, currentWork().id, receipt.runtimeName,
        `${Number(expected.token) + 1}`, expected.token, expected.uid,
      ]);
      if (!rows.length) throw new Error('Conditional activation lost ownership');
      const lost = await pool.query(`UPDATE c0_faults SET policy = policy - 'loseActivationAck'
        WHERE work_id = $1 AND policy->>'loseActivationAck' = 'true' RETURNING work_id`, [currentWork().id]);
      if (lost.rowCount) throw new Error('Injected loss after external activation');
    },
  };
  Object.assign(require('../../src/services/preview-flow/binding-adapters'), routes);
  const activation = require('../../src/services/preview-flow/activation').createActivation({ routes });

  async function cleanup(work) {
    const owner = require('../../src/services/preview-flow/cleanup').createCleanup({
      db: { dropDatabase: name => remove(work, name) },
    });
    const result = await owner.underBuildLock({ pool, config, sessionId: work.sessionId, flowId: work.id });
    if (!result.protected) {
      await remove(work, `${work.intent.runtimeName}-build`);
      await remove(work, `${work.intent.runtimeName}-check`);
    }
    await event(pool, work.id, 'cleanup_observation', result);
    // Keep the retirement workflow discoverable. Observed absence cannot prove
    // an accepted external creator ended; B1 tombstones are not compacted here.
    return { retired: true };
  }

  async function perform(stage, work, execution) {
    await event(pool, work.id, 'step', { stage, backend, workerPid: process.pid, ...execution });
    if (stage === 'cleanup') return cleanup(work);
    const state = await preview.read(work.sessionId);
    if (state.flow?.id !== work.id || state.flow.state === 'superseded' || state.resource?.cleanupStarted) {
      return { retired: true };
    }

    if (stage === 'reserve') {
      if (!state.resource?.intent) {
        await preview.recordIntent(work.sessionId, work.id, work.intent, { credentialEnc: work.credentialEnc });
      }
      return {};
    }

    if (stage === 'clone') {
      const password = decrypt(work.credentialEnc, config.dataEncryptionKey);
      if (!password) throw new Error('Clone credential is unavailable');
      const digest = createHash('sha256').update(password).digest('hex');
      const object = await ensure(work, 'clone', work.intent.dbName, { headSha: work.flow.headSha, digest });
      if (object.body.digest !== digest) throw new Error('Clone credential identity differs');
      if (object.body.state !== 'complete') {
        await event(pool, work.id, 'partial_clone_abandoned');
        return { retired: true };
      }
      if (!state.resource.clonePrepared) await preview.markClonePrepared(work.sessionId, work.id);
      return {};
    }

    if (stage === 'build') {
      const job = await ensure(work, 'build', `${work.intent.runtimeName}-build`, { headSha: work.flow.headSha });
      if (job.body.state === 'running') return { pending: true };
      const deployment = await ensure(work, 'Deployment', work.intent.runtimeName, { headSha: work.flow.headSha });
      await ensure(work, 'Service', work.intent.runtimeName + '-service', { headSha: work.flow.headSha });
      await ensure(work, 'Secret', work.intent.runtimeName + '-env', { headSha: work.flow.headSha });
      const receipt = await preview.recordRuntime(work.sessionId, work.id, {
        commitSha: work.flow.headSha,
        stagingUrl: `http://${work.intent.runtimeName}:3000`,
        runtimeKind: 'kubernetes',
        runtimeName: work.intent.runtimeName,
        containerId: null,
        imageRef: 'c0:immutable-image',
        buildRef: job.name,
        attemptId: work.flow.attemptId,
        physicalId: deployment.uid,
      });
      const result = await preview.apply({
        type: 'PreviewCandidatePrepared',
        actionId: work.preparedActionId,
        sessionId: work.sessionId,
        flowId: work.id,
        generation: work.flow.generation,
        headSha: work.flow.headSha,
        receipt,
      });
      return { retired: !result.decision.accepted };
    }

    if (stage === 'checks') {
      const capture = { target: work.intent.runtimeName, originalHost: `c0--s${work.sessionId}.c0.invalid`,
        headSha: work.flow.headSha, attemptId: work.flow.attemptId };
      const job = await ensure(work, 'check', `${work.intent.runtimeName}-check`, capture);
      const stored = await runtime.transact(transaction => transaction.withSession(work.sessionId, async client => {
        const current = await preview.readInTransaction(transaction, work.sessionId);
        if (current.flow?.id !== work.id || current.flow.state !== 'candidate') return false;
        // C0 adapter: retain the real check-write mapping, add generation fencing
        // under the aggregate. A production check action owner is still stage C/E.
        return require('../../src/services/visuals').storeChecks(client, work.sessionId, work.flow.headSha,
          { state: job.body.verdict, results: [] });
      }));
      await event(pool, work.id, 'verdict', { verdict: job.body.verdict, accepted: stored });
      return { retired: !stored, verdict: job.body.verdict };
    }

    if (stage === 'publish') {
      if (state.flow.state === 'ready' && state.binding?.observed?.flowId === work.id) return {};
      const result = await activation.underBuildLock({ pool, config, app: { id: 1, slug: 'c0' },
        sessionId: work.sessionId, flowId: work.id });
      return { retired: !result.accepted };
    }

    if (stage === 'audit') return {};
    throw new Error(`Unknown bounded C0 step: ${stage}`);
  }

  async function step(stage, work, execution = {}) {
    const result = await context.run(work, () => guard.withResourceUse(config, STAGING_BUILD_LOCK, work.sessionId, async () => {
      await event(pool, work.id, 'resource_lock', { stage, lockPid: lockClient.processID, workerPid: process.pid });
      return perform(stage, work, execution);
    }, { allRuntimes: true, tryOnly: true }));
    if (result.busy) await event(pool, work.id, 'resource_busy', { stage, backend, ...execution });
    return result;
  }

  async function finish(work) {
    await pool.query('UPDATE c0_work SET done = TRUE WHERE id = $1', [work.id]);
    await event(pool, work.id, 'finished', { backend, version: work.version });
  }

  return { step, finish, pool };
}

module.exports = { createSteps };
