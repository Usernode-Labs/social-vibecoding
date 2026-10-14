'use strict';

// A preview attempt on Kubernetes (the preview machine's preview.prepare):
// its own env Secret, the attempt fence on the session's Deployment, the
// serving template restored when its rollout fails, and retirement that
// deletes by identity (machine-preview.md, P-B1, P-B3, P-E3).

const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');

test.afterEach(() => kubernetes._setClientsForTest(null));

const CONFIG = { kubernetes: { appNamespace: 'apps', appDomain: 'example.test' } };
const NAME = 'sv-preview-1-s2';
const ANNOTATION = kubernetes.PREVIEW_ATTEMPT_ANNOTATION;
const missing = () => Object.assign(new Error('missing'), { code: 404 });

// An in-memory namespace. `failRollout` makes the new pod fail to start, so
// the rollout fails at once instead of after its five-minute budget.
function cluster({ failRollout = false } = {}) {
  const store = new Map();
  const failing = { on: failRollout };
  // The ReplicaSets the controller keeps, one per template a Deployment ran.
  const replicaSets = [];
  let revision = 0;
  const keepReplicaSet = (d) => {
    const template = structuredClone(d.spec.template);
    template.metadata.labels = { ...template.metadata.labels, 'pod-template-hash': `h${revision + 1}` };
    replicaSets.push({ metadata: { annotations: { 'deployment.kubernetes.io/revision': String(++revision) } }, spec: { template } });
  };
  const calls = [];
  let uid = 0;
  const kind = (k) => ({
    read: async ({ name }) => {
      const o = store.get(`${k}/${name}`);
      if (!o) throw missing();
      return structuredClone(o);
    },
    create: async ({ body }) => {
      if (store.has(`${k}/${body.metadata.name}`)) throw Object.assign(new Error('exists'), { code: 409 });
      const o = structuredClone(body);
      o.metadata.uid = `uid-${++uid}`;
      o.metadata.resourceVersion = '1';
      o.metadata.generation = 1;
      store.set(`${k}/${body.metadata.name}`, o);
      calls.push(`create ${k} ${body.metadata.name}`);
      return structuredClone(o);
    },
    replace: async ({ name, body }) => {
      const cur = store.get(`${k}/${name}`);
      if (!cur) throw missing();
      if (body.metadata.resourceVersion && body.metadata.resourceVersion !== cur.metadata.resourceVersion) {
        throw Object.assign(new Error('conflict'), { code: 409 });
      }
      const o = structuredClone(body);
      o.metadata.uid = cur.metadata.uid;
      o.metadata.resourceVersion = String(Number(cur.metadata.resourceVersion) + 1);
      o.metadata.generation = (cur.metadata.generation || 1) + 1;
      store.set(`${k}/${name}`, o);
      calls.push(`replace ${k} ${name}`);
      return structuredClone(o);
    },
    delete: async ({ name, body }) => {
      const cur = store.get(`${k}/${name}`);
      if (!cur) throw missing();
      if (body?.preconditions?.uid && body.preconditions.uid !== cur.metadata.uid) {
        throw Object.assign(new Error('precondition'), { code: 409 });
      }
      calls.push(`delete ${k} ${name}${body?.preconditions?.uid ? ' by uid' : ''}`);
      store.delete(`${k}/${name}`);
    },
  });
  const secret = kind('secret'); const service = kind('service'); const deployment = kind('deployment'); const ingress = kind('ingress');
  const app = (d) => (d.spec?.template?.spec?.containers || []).find((c) => c.name === 'app');
  kubernetes._setClientsForTest({
    core: {
      readNamespacedSecret: secret.read, createNamespacedSecret: secret.create, replaceNamespacedSecret: secret.replace,
      deleteNamespacedSecret: secret.delete,
      readNamespacedService: service.read, createNamespacedService: service.create, replaceNamespacedService: service.replace,
      deleteNamespacedService: service.delete,
      listNamespacedPod: async () => {
        const d = store.get(`deployment/${NAME}`);
        if (!d || !failing.on) return { items: [] };
        return { items: [{ metadata: { name: 'new', annotations: d.spec.template.metadata.annotations },
          spec: { containers: [{ name: 'app', image: app(d).image }] },
          status: { containerStatuses: [{ name: 'app', state: { waiting: { reason: 'CreateContainerConfigError', message: 'bad env' } } }] } }] };
      },
      readNamespacedPodLog: async () => '',
    },
    apps: {
      readNamespacedDeployment: async (req) => {
        const d = await deployment.read(req);
        // Rolled out, unless the pod cannot start.
        d.status = failing.on
          ? { observedGeneration: d.metadata.generation, replicas: 2, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 }
          : { observedGeneration: d.metadata.generation, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 };
        return d;
      },
      createNamespacedDeployment: async (req) => { const d = await deployment.create(req); keepReplicaSet(d); return d; },
      replaceNamespacedDeployment: async (req) => { const d = await deployment.replace(req); keepReplicaSet(d); return d; },
      deleteNamespacedDeployment: deployment.delete,
      listNamespacedReplicaSet: async () => ({ items: structuredClone(replicaSets) }),
    },
    networking: {
      readNamespacedIngress: ingress.read, createNamespacedIngress: ingress.create, replaceNamespacedIngress: ingress.replace,
      deleteNamespacedIngress: ingress.delete,
    },
    custom: {},
  });
  return { store, calls, fail: (on) => { failing.on = on; }, image: (n) => app(store.get(`deployment/${NAME}`)).image, secretOf: (n) => store.get(`deployment/${NAME}`).spec.template.spec.containers[0].envFrom[0].secretRef.name };
}

// `serving`: the attempt the machine says serves (null: nothing does).
const deploy = (attempt, { imageRef = `app@sha256:${attempt}`, serving = attempt > 1 ? attempt - 1 : null } = {}) =>
  kubernetes.deployApplication(CONFIG, {
    app: { id: 1, slug: 'demo' }, environment: 'staging', sessionId: 2, imageRef, env: { N: String(attempt) },
    internalOnly: true, attempt, servingAttempt: serving,
  });

test('each attempt has its own env Secret and the Deployment records the attempt', async () => {
  const c = cluster();
  await deploy(1);
  await deploy(2);
  assert.ok(c.store.has(`secret/${NAME}-env-a1`) && c.store.has(`secret/${NAME}-env-a2`), 'the serving attempt\'s Secret is never replaced (bug 6)');
  assert.equal(c.secretOf(), `${NAME}-env-a2`);
  assert.equal(c.store.get(`deployment/${NAME}`).metadata.annotations[ANNOTATION], '2');
  assert.equal(kubernetes.attemptSecretName(NAME, 0), `${NAME}-env`, 'attempt 0 is the preview [main] built');
});

test('an attempt older than the one that wrote the Deployment is refused before it writes anything', async () => {
  const c = cluster();
  await deploy(3);
  const before = c.calls.length;
  await assert.rejects(deploy(2), (err) => err.code === 'attempt_superseded' && err.permanent === true);
  assert.equal(c.calls.length, before);
  assert.equal(c.image(), 'app@sha256:3');
});

test('a failed rollout restores the serving template instead of deleting the preview', async () => {
  const c = cluster();
  await deploy(1);
  c.fail(true);   // the next revision's pod cannot start
  await assert.rejects(deploy(2, { imageRef: 'app@sha256:broken' }), (err) => err.healthcheckFailed === true);
  assert.equal(c.image(), 'app@sha256:1', 'the serving revision\'s template is back (bug 2)');
  assert.equal(c.secretOf(), `${NAME}-env-a1`);
  assert.equal(c.store.get(`deployment/${NAME}`).metadata.annotations[ANNOTATION], '2', 'the fence keeps the highest attempt');
  assert.ok(!c.calls.some((x) => x.startsWith('delete')), 'nothing was deleted');
});

test('a failed rollout restores the attempt that serves, not a cancelled candidate written since (review finding)', async () => {
  const c = cluster();
  await deploy(1);
  await deploy(2);              // a candidate the machine cancelled: attempt 1 still serves
  c.fail(true);
  await assert.rejects(deploy(3, { imageRef: 'app@sha256:broken', serving: 1 }));
  assert.equal(c.image(), 'app@sha256:1', 'attempt 1, found among the ReplicaSets');
  assert.equal(c.secretOf(), `${NAME}-env-a1`, 'never the retired candidate\'s Secret');
  assert.equal(c.store.get(`deployment/${NAME}`).spec.template.metadata.labels['pod-template-hash'], undefined);
});

test('a failed attempt with no serving template left deletes only the Deployment it wrote', async () => {
  const c = cluster({ failRollout: true });
  await assert.rejects(deploy(4, { imageRef: 'app@sha256:broken', serving: 3 }));
  assert.ok(c.calls.includes(`delete deployment ${NAME} by uid`), 'the Deployment was lost: nothing serves');
});

test('a failed first attempt deletes only the Deployment it wrote', async () => {
  const c = cluster({ failRollout: true });
  await assert.rejects(deploy(1, { imageRef: 'app@sha256:broken' }));
  assert.ok(c.calls.includes(`delete deployment ${NAME} by uid`));
  assert.ok(!c.store.has(`deployment/${NAME}`));
});

test('retirement deletes every resource by the UID it read, and reports what is left', async () => {
  const c = cluster();
  await deploy(1);
  await deploy(2);
  const secrets = [0, 1, 2].map((n) => kubernetes.attemptSecretName(NAME, n));
  await kubernetes.deleteApplication(CONFIG, NAME, { identity: true, secrets });
  assert.deepEqual(c.calls.filter((x) => x.startsWith('delete')).sort(), [
    `delete deployment ${NAME} by uid`, `delete secret ${NAME}-env-a1 by uid`,
    `delete secret ${NAME}-env-a2 by uid`, `delete service ${NAME} by uid`,
  ]);
  assert.deepEqual(await kubernetes.previewResourcesPresent(CONFIG, NAME, secrets), []);
});
