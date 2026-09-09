const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const k8s = require('@kubernetes/client-node');
const log = require('./logger');

const MANAGED_BY = 'social-vibecoding-runtime';
const PART_OF = 'social-vibecoding';

let clients;

function setClientsForTest(value) { clients = value; }

function getClients() {
  if (clients) return clients;
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();
  clients = {
    kc,
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
  };
  return clients;
}

function isNotFound(err) {
  return err?.code === 404 || err?.response?.statusCode === 404 || err?.response?.status === 404;
}

function dnsName(value, max = 63) {
  const clean = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/-+$/g, '');
}

function withSuffix(value, suffix, max = 63) {
  const cleanSuffix = `-${dnsName(suffix, max)}`;
  const base = dnsName(value, max - cleanSuffix.length);
  return `${base}${cleanSuffix}`;
}

function envChecksum(env) {
  const entries = Object.entries(env || {})
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function labels({ appId, sessionId, environment }) {
  const result = {
    'app.kubernetes.io/part-of': PART_OF,
    'app.kubernetes.io/managed-by': MANAGED_BY,
    'social.usernode.io/environment': environment,
  };
  if (appId !== undefined && appId !== null) result['social.usernode.io/app-id'] = String(appId);
  if (sessionId !== undefined && sessionId !== null) result['social.usernode.io/session-id'] = String(sessionId);
  return result;
}

async function upsert(api, readMethod, createMethod, replaceMethod, namespace, body) {
  const name = body.metadata.name;
  try {
    const current = await api[readMethod]({ name, namespace });
    body.metadata.resourceVersion = current.metadata.resourceVersion;
    if (body.kind === 'Service') {
      for (const field of ['clusterIP', 'clusterIPs', 'ipFamilies', 'ipFamilyPolicy', 'healthCheckNodePort']) {
        if (current.spec?.[field] !== undefined) body.spec[field] = current.spec[field];
      }
    }
    return api[replaceMethod]({ name, namespace, body });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return api[createMethod]({ namespace, body });
  }
}

async function deleteIfPresent(api, method, name, namespace, options = {}) {
  try {
    await api[method]({ name, namespace, ...options });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function requireBuildConfig(config) {
  const cfg = config.kubernetes;
  const missing = [];
  for (const key of ['repositoryPrefix', 'cacheRepositoryPrefix', 'builderImage']) {
    if (!cfg[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(`Kubernetes build configuration missing: ${missing.join(', ')}`);
  }
  return cfg;
}

function packageRunsScript(sourceDir, scriptName) {
  if (!sourceDir) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
    return typeof pkg.scripts?.[scriptName] === 'string';
  } catch {
    return false;
  }
}

async function deleteBuild(config, name) {
  await deleteIfPresent(
    getClients().custom,
    'deleteNamespacedCustomObject',
    name,
    config.kubernetes.buildNamespace,
    {
      group: 'kpack.io', version: 'v1alpha2', plural: 'builds',
      propagationPolicy: 'Background',
    }
  );
}

// `onProgress(image)` is called as the kpack Build advances: `{ phase,
// phases: [{ name, ms }], detail }` — which lifecycle phase (init container)
// is running, how long the finished ones took, and the last line the running
// phase printed. Best-effort throughout; a status read that fails is skipped.
async function createBuild(config, { app, revision, environment, sessionId, sourceDir, onProgress = null }) {
  if (!/^[a-f0-9]{40}$/i.test(revision || '')) {
    throw new Error('Kubernetes builds require a full 40-character Git commit SHA');
  }
  if (!/^https:\/\/github\.com\//.test(app.repo_url || '')) {
    throw new Error('Kubernetes builds require an HTTPS GitHub repository URL');
  }
  const cfg = requireBuildConfig(config);
  const suffix = sessionId ? `s${sessionId}-` : '';
  const repository = `${cfg.repositoryPrefix}/${dnsName(app.slug)}`;
  const cacheTag = `${cfg.cacheRepositoryPrefix}/${dnsName(app.slug)}:cache`;
  const buildEnv = [{ name: 'BP_NODE_VERSION', value: cfg.nodeVersion }];
  // The platform self-app generates ignored React/Tailwind artifacts. Paketo
  // must materialize them while /workspace is writable; the launch container
  // deliberately runs as non-root and treats the image filesystem as built.
  // Detect the script from the exact checked-out source instead of coupling
  // this runtime adapter to one app id or slug.
  if (packageRunsScript(sourceDir, 'ensure:shell')) {
    buildEnv.push({ name: 'BP_NODE_RUN_SCRIPTS', value: 'ensure:shell' });
  } else if (packageRunsScript(sourceDir, 'build')) {
    // Standard generated/imported apps declare their asset build in npm.
    // Keep ensure:shell first: its prerender -> CSS ordering is load-bearing.
    buildEnv.push({ name: 'BP_NODE_RUN_SCRIPTS', value: 'build' });
  }
  // A new builder must rebuild an unchanged app revision, not reuse an old
  // successful immutable Build after create returns 409. Include this in the
  // tag too, so the artifact address identifies the source AND build recipe.
  const recipe = crypto.createHash('sha256')
    .update(JSON.stringify({ builder: cfg.builderImage, env: buildEnv }))
    .digest('hex').slice(0, 12);
  const buildName = dnsName(`sv-${app.id}-${suffix}${revision.slice(0, 12)}-${recipe}`);
  const tag = `${repository}:git-${revision}-${recipe}`;
  const body = {
    apiVersion: 'kpack.io/v1alpha2',
    kind: 'Build',
    metadata: { name: buildName, namespace: cfg.buildNamespace, labels: labels({ appId: app.id, sessionId, environment }) },
    spec: {
      tags: [tag],
      serviceAccountName: cfg.buildServiceAccount,
      builder: { image: cfg.builderImage },
      cache: { registry: { tag: cacheTag } },
      source: { git: { url: app.repo_url.replace(/\.git$/, ''), revision } },
      activeDeadlineSeconds: cfg.activeDeadlineSeconds,
      env: buildEnv,
      resources: {
        requests: { cpu: process.env.BUILD_REQUESTS_CPU || '500m', memory: process.env.BUILD_REQUESTS_MEMORY || '1Gi', 'ephemeral-storage': process.env.BUILD_REQUESTS_EPHEMERAL_STORAGE || '2Gi' },
        limits: { cpu: process.env.BUILD_LIMITS_CPU || '2', memory: process.env.BUILD_LIMITS_MEMORY || '2Gi', 'ephemeral-storage': process.env.BUILD_LIMITS_EPHEMERAL_STORAGE || '8Gi' },
      },
    },
  };
  const { custom } = getClients();
  try {
    await custom.createNamespacedCustomObject({ group: 'kpack.io', version: 'v1alpha2', namespace: cfg.buildNamespace, plural: 'builds', body });
  } catch (err) {
    if (err?.code !== 409 && err?.response?.statusCode !== 409) throw err;
  }
  try {
    const result = await waitForBuild(config, buildName, { onProgress });
    return {
      buildRef: `${cfg.buildNamespace}/${buildName}`, imageRef: result.status.latestImage, requestedTag: tag,
      phases: result.phases || null,
    };
  } catch (err) {
    await deleteBuild(config, buildName).catch((cleanupErr) => {
      log.warn('kubernetes', 'Failed kpack Build cleanup failed', {
        buildName, err: cleanupErr.message,
      });
    });
    throw err;
  }
}

// The kpack pod runs the buildpack lifecycle as init containers, in order
// (prepare, analyze, detect, restore, build, export on current kpack), each
// with its own start and finish stamps. That is the whole per-phase timing,
// read straight off the pod: no log parsing is needed for the phases, only
// for the `detail` line.
function buildPhasesFromPod(pod) {
  const spec = (pod && pod.spec && Array.isArray(pod.spec.initContainers)) ? pod.spec.initContainers : [];
  const statuses = (pod && pod.status && Array.isArray(pod.status.initContainerStatuses)) ? pod.status.initContainerStatuses : [];
  const byName = new Map(statuses.map((s) => [s.name, s]));
  const phases = [];
  let phase = null;
  let runningSince = null;
  for (const c of spec) {
    const st = byName.get(c.name) || {};
    const t = st.state && st.state.terminated;
    const r = st.state && st.state.running;
    if (t) {
      const ms = Date.parse(t.finishedAt) - Date.parse(t.startedAt);
      phases.push({ name: c.name, ms: Number.isFinite(ms) ? Math.max(0, ms) : null });
    } else if (r && !phase) {
      phase = c.name;
      runningSince = r.startedAt || null;
    }
  }
  if (!phase) {
    const main = (pod && pod.status && Array.isArray(pod.status.containerStatuses)) ? pod.status.containerStatuses[0] : null;
    if (main && main.state && main.state.running) phase = main.name || 'completion';
    else if (spec.length && phases.length === spec.length) phase = 'completion';
    else if (spec.length) phase = spec[0].name; // scheduled, nothing running yet
  }
  return { phase, phases, runningSince, order: spec.map((c) => c.name) };
}

async function waitForBuild(config, name, { onProgress = null } = {}) {
  const cfg = config.kubernetes;
  const deadline = Date.now() + (cfg.activeDeadlineSeconds + 60) * 1000;
  const clients = getClients();
  const { custom, core } = clients;
  const report = typeof onProgress === 'function';
  let image = { phase: null, phases: [], detail: null };
  let followed = null;
  let followAbort = null;
  const stopFollow = () => {
    if (followAbort && typeof followAbort.abort === 'function') { try { followAbort.abort(); } catch { /* closed */ } }
    followAbort = null;
    followed = null;
  };
  const emit = () => { if (report) { try { onProgress({ ...image, phases: image.phases.slice() }); } catch { /* observer only */ } } };
  // The running phase's log, followed, for the `detail` line. Re-attached
  // when the running phase changes (kpack runs them one after another).
  const followPhase = async (podName, phase) => {
    if (!report || !core || !podName || !phase || phase === followed) return;
    const logApi = clientsLogApi(clients);
    if (!logApi) return;
    stopFollow();
    try {
      const sink = new stream.PassThrough();
      attachLineObserver(sink, (line) => {
        const text = String(line || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (!text) return;
        image.detail = text.length > 160 ? `${text.slice(0, 157)}...` : text;
        emit();
      });
      followAbort = await logApi.log(cfg.buildNamespace, podName, phase, sink, { follow: true });
      followed = phase;
    } catch { /* not started yet; next tick */ }
  };
  const observe = async (build) => {
    if (!report || !core) return;
    const podName = build.status && build.status.podName;
    if (!podName) return;
    try {
      const pod = await core.readNamespacedPod({ name: podName, namespace: cfg.buildNamespace });
      const derived = buildPhasesFromPod(pod);
      const phaseChanged = derived.phase !== image.phase;
      image = { ...image, phase: derived.phase, phases: derived.phases, ...(phaseChanged ? { detail: null } : {}) };
      emit();
      if (derived.phase && derived.phase !== 'completion') await followPhase(podName, derived.phase);
    } catch { /* progress is best-effort */ }
  };
  try {
    while (Date.now() < deadline) {
      const build = await custom.getNamespacedCustomObject({ group: 'kpack.io', version: 'v1alpha2', namespace: cfg.buildNamespace, plural: 'builds', name });
      const succeeded = build.status?.conditions?.find((condition) => condition.type === 'Succeeded');
      if (succeeded?.status === 'True' && build.status?.latestImage) {
        await observe(build);
        return { ...build, phases: image.phases.length ? image.phases : null };
      }
      if (succeeded?.status === 'False') {
        throw new Error(`kpack Build ${name} failed: ${succeeded.message || succeeded.reason || 'unknown error'}`);
      }
      await observe(build);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`Timed out waiting for kpack Build ${name}`);
  } finally {
    stopFollow();
  }
}

function appResourceName(app, environment, sessionId) {
  return dnsName(environment === 'production' ? `sv-app-${app.id}-${app.slug}` : `sv-preview-${app.id}-s${sessionId}`);
}

function podSecurityContext() {
  return { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } };
}

function nodePodSecurityContext() {
  return {
    ...podSecurityContext(),
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
  };
}

function containerSecurityContext() {
  return { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: false };
}

// `cpus` is the container's CPU LIMIT (a ceiling, not a request — requests
// stay at 100m so scheduling is unchanged). Staging previews pass
// docker.STAGING_CPUS through application-runtime.deploy so the capture
// run's eight concurrent pages get the same headroom on both runtimes;
// production apps pass nothing and keep the 1-CPU limit they always had.
async function deployApplication(config, { app, environment, sessionId, imageRef, env, cpus = null }) {
  if (!imageRef?.includes('@sha256:')) throw new Error('Kubernetes deployments require an immutable image digest');
  const cfg = config.kubernetes;
  const namespace = cfg.appNamespace;
  const name = appResourceName(app, environment, sessionId);
  const resourceLabels = labels({ appId: app.id, sessionId, environment });
  const selectorLabels = { 'social.usernode.io/runtime-name': name };
  const secretName = withSuffix(name, 'env');
  const hostname = environment === 'production'
    ? `${app.slug}.${cfg.appDomain}`
    : `${app.slug}--s${sessionId}.${cfg.appDomain}`;
  // Check before creating or updating any Kubernetes resources.
  require('./caddy').assertAppHostname(hostname, cfg.platformDomain);
  const { core, apps, networking } = getClients();

  await upsert(core, 'readNamespacedSecret', 'createNamespacedSecret', 'replaceNamespacedSecret', namespace, {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: secretName, namespace, labels: resourceLabels },
    type: 'Opaque', stringData: Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)])),
  });
  await upsert(core, 'readNamespacedService', 'createNamespacedService', 'replaceNamespacedService', namespace, {
    apiVersion: 'v1', kind: 'Service', metadata: { name, namespace, labels: resourceLabels },
    spec: { selector: selectorLabels, ports: [{ name: 'http', port: 3000, targetPort: 3000 }], type: 'ClusterIP' },
  });
  await upsert(apps, 'readNamespacedDeployment', 'createNamespacedDeployment', 'replaceNamespacedDeployment', namespace, {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace, labels: resourceLabels },
    spec: {
      replicas: 1,
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: {
          labels: { ...resourceLabels, ...selectorLabels },
          annotations: { 'social.usernode.io/env-checksum': envChecksum(env) },
        },
        spec: {
          serviceAccountName: cfg.generatedAppServiceAccount,
          automountServiceAccountToken: false,
          securityContext: podSecurityContext(),
          containers: [{
            name: 'app', image: imageRef, imagePullPolicy: 'IfNotPresent',
            ports: [{ name: 'http', containerPort: 3000 }],
            env: app.slug === config.selfAppSlug
              ? [{ name: 'USERNODE_SHELL_ASSETS_PREBUILT', value: '1' }]
              : [],
            envFrom: [{ secretRef: { name: secretName } }],
            startupProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 3, failureThreshold: 40 },
            readinessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 5, failureThreshold: 3 },
            livenessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 15, failureThreshold: 3 },
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: String(cpus || '1'), memory: '1Gi' } },
            securityContext: containerSecurityContext(),
          }],
        },
      },
    },
  });
  await upsert(networking, 'readNamespacedIngress', 'createNamespacedIngress', 'replaceNamespacedIngress', namespace, {
    apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: {
      name, namespace, labels: resourceLabels,
      annotations: { 'cert-manager.io/cluster-issuer': cfg.clusterIssuer },
    },
    spec: {
      ingressClassName: cfg.ingressClassName,
      rules: [{ host: hostname, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name, port: { number: 3000 } } } }] } }],
      tls: [{ hosts: [hostname], secretName: withSuffix(name, 'tls') }],
    },
  });
  try {
    await waitForDeployment(namespace, name);
  } catch (err) {
    // A failed preview has no serving value but its declared CPU limit still
    // consumes ResourceQuota. Production keeps its prior ReplicaSet for a
    // recoverable rollout; previews are disposable and are rebuilt on retry.
    if (environment !== 'production') {
      await deleteApplication(config, name).catch((cleanupErr) => {
        log.warn('kubernetes', 'Failed preview cleanup failed', {
          namespace, name, err: cleanupErr.message,
        });
      });
    }
    throw err;
  }
  return { runtimeKind: 'kubernetes', runtimeName: name, imageRef, hostname, url: `https://${hostname}` };
}

async function waitForDeployment(namespace, name, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  const { apps } = getClients();
  while (Date.now() < deadline) {
    const deployment = await apps.readNamespacedDeployment({ name, namespace });
    if (deployment.status?.availableReplicas >= 1 && deployment.status?.observedGeneration >= deployment.metadata.generation) return deployment;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for Deployment ${namespace}/${name}`);
}

async function getApplicationStatus(config, runtimeName) {
  try {
    const deployment = await getClients().apps.readNamespacedDeployment({ name: runtimeName, namespace: config.kubernetes.appNamespace });
    if (deployment.status?.availableReplicas >= 1) return 'running';
    if (deployment.status?.unavailableReplicas) return 'restarting';
    return 'created';
  } catch (err) {
    if (isNotFound(err)) return 'not_found';
    throw err;
  }
}

async function getApplicationLogs(config, runtimeName, tailLines = 200) {
  const namespace = config.kubernetes.appNamespace;
  const pods = await getClients().core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${runtimeName}` });
  const pod = pods.items?.[0];
  if (!pod) return '';
  return getClients().core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container: 'app', tailLines });
}

async function restartApplication(config, runtimeName) {
  const namespace = config.kubernetes.appNamespace;
  const deployment = await getClients().apps.readNamespacedDeployment({ name: runtimeName, namespace });
  deployment.spec.template.metadata ||= {};
  deployment.spec.template.metadata.annotations ||= {};
  deployment.spec.template.metadata.annotations['social.usernode.io/restarted-at'] = new Date().toISOString();
  await getClients().apps.replaceNamespacedDeployment({ name: runtimeName, namespace, body: deployment });
  return waitForDeployment(namespace, runtimeName);
}

async function deleteApplication(config, runtimeName) {
  const namespace = config.kubernetes.appNamespace;
  const { apps, core, networking } = getClients();
  await Promise.all([
    deleteIfPresent(networking, 'deleteNamespacedIngress', runtimeName, namespace),
    deleteIfPresent(core, 'deleteNamespacedService', runtimeName, namespace),
    deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(runtimeName, 'env'), namespace),
    deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(runtimeName, 'tls'), namespace),
    deleteIfPresent(apps, 'deleteNamespacedDeployment', runtimeName, namespace, { propagationPolicy: 'Foreground' }),
  ]);
}

async function deleteBuilds(config, appId) {
  await getClients().custom.deleteCollectionNamespacedCustomObject({
    group: 'kpack.io', version: 'v1alpha2', namespace: config.kubernetes.buildNamespace,
    plural: 'builds', labelSelector: `social.usernode.io/app-id=${appId}`,
    propagationPolicy: 'Background',
  });
}

async function deleteFailedBuilds(config) {
  const namespace = config.kubernetes.buildNamespace;
  const { custom } = getClients();
  const response = await custom.listNamespacedCustomObject({
    group: 'kpack.io', version: 'v1alpha2', namespace, plural: 'builds',
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY}`,
  });
  const items = response.items || [];
  const failed = items.filter((build) => build.status?.conditions?.some(
    (condition) => condition.type === 'Succeeded' && condition.status === 'False'
  ));
  for (const build of failed) {
    await deleteBuild(config, build.metadata.name);
  }
  return { examined: items.length, deleted: failed.length };
}

async function ensureWorker(config, { sessionId, env }) {
  const cfg = config.kubernetes;
  if (!cfg.workerImage?.includes('@sha256:')) throw new Error('KUBERNETES_WORKER_IMAGE must be an immutable digest');
  const namespace = cfg.workerNamespace;
  const name = dnsName(`sv-worker-s${sessionId}`);
  const pvcName = withSuffix(name, 'state');
  const secretName = withSuffix(name, 'env');
  const resourceLabels = labels({ sessionId, environment: 'worker' });
  const workerContractLabels = config.workerContractVersion
    ? { 'social.usernode.io/worker-contract': String(config.workerContractVersion) }
    : {};
  const selectorLabels = { 'social.usernode.io/runtime-name': name };
  const { core, apps } = getClients();
  try {
    const pvc = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace, labels: resourceLabels }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: cfg.workerStorageSize } } } };
    if (cfg.workerStorageClass) pvc.spec.storageClassName = cfg.workerStorageClass;
    await core.createNamespacedPersistentVolumeClaim({ namespace, body: pvc });
  } catch (err) { if (err?.code !== 409 && err?.response?.statusCode !== 409) throw err; }
  await upsert(core, 'readNamespacedSecret', 'createNamespacedSecret', 'replaceNamespacedSecret', namespace, {
    apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace, labels: resourceLabels }, type: 'Opaque',
    stringData: Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)])),
  });
  await upsert(apps, 'readNamespacedDeployment', 'createNamespacedDeployment', 'replaceNamespacedDeployment', namespace, {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: {
      name, namespace, labels: { ...resourceLabels, ...workerContractLabels },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
      strategy: { type: 'Recreate' },
      template: {
        metadata: {
          labels: { ...resourceLabels, ...selectorLabels, ...workerContractLabels },
          annotations: { 'social.usernode.io/env-checksum': envChecksum(env) },
        },
        spec: {
          serviceAccountName: cfg.workerServiceAccount,
          automountServiceAccountToken: false,
          securityContext: nodePodSecurityContext(),
          containers: [{
            name: 'worker', image: cfg.workerImage, imagePullPolicy: 'IfNotPresent',
            envFrom: [{ secretRef: { name: secretName } }],
            volumeMounts: [{ name: 'state', mountPath: '/home/node/.claude' }],
            resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: config.workerCpus || '2', memory: (config.workerMemory || '2Gi').replace(/g$/i, 'Gi') } },
            securityContext: containerSecurityContext(),
          }],
          volumes: [{ name: 'state', persistentVolumeClaim: { claimName: pvcName } }],
        },
      },
    },
  });
  await waitForDeployment(namespace, name);
  const warmDeadline = Date.now() + 5 * 60 * 1000;
  let warmReady = false;
  while (Date.now() < warmDeadline) {
    const pods = await core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${name}` });
    const pod = pods.items?.[0];
    if (pod) {
      const output = await core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container: 'worker' }).catch(() => '');
      if (output.includes('__USERNODE_PHASE__ warm-ready')) {
        warmReady = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!warmReady) throw new Error(`Timed out waiting for worker ${name} warm-ready marker`);
  return { runtimeKind: 'kubernetes', runtimeName: name, pvcName };
}

async function getWorkerStatus(config, runtimeName) {
  try {
    const deployment = await getClients().apps.readNamespacedDeployment({ name: runtimeName, namespace: config.kubernetes.workerNamespace });
    return deployment.status?.availableReplicas >= 1 ? 'running' : 'created';
  } catch (err) {
    if (isNotFound(err)) return 'not_found';
    throw err;
  }
}

async function getWorkerContractVersion(config, runtimeName) {
  try {
    const deployment = await getClients().apps.readNamespacedDeployment({
      name: runtimeName,
      namespace: config.kubernetes.workerNamespace,
    });
    return deployment.metadata?.labels?.['social.usernode.io/worker-contract'] || null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function deleteWorker(config, sessionId, { deleteVolume = false } = {}) {
  const namespace = config.kubernetes.workerNamespace;
  const name = dnsName(`sv-worker-s${sessionId}`);
  const { apps, core } = getClients();
  await Promise.all([
    deleteIfPresent(apps, 'deleteNamespacedDeployment', name, namespace, { propagationPolicy: 'Foreground' }),
    deleteIfPresent(core, 'deleteNamespacedSecret', withSuffix(name, 'env'), namespace),
  ]);
  if (deleteVolume) await deleteIfPresent(core, 'deleteNamespacedPersistentVolumeClaim', withSuffix(name, 'state'), namespace);
}

async function listWorkers(config) {
  const namespace = config.kubernetes.workerNamespace;
  const deployments = await getClients().apps.listNamespacedDeployment({
    namespace,
    labelSelector: 'app.kubernetes.io/managed-by=social-vibecoding-runtime,social.usernode.io/environment=worker',
  });
  return (deployments.items || []).map((deployment) => ({
    name: deployment.metadata.name,
    sessionId: Number(deployment.metadata.labels?.['social.usernode.io/session-id']),
    state: deployment.status?.availableReplicas >= 1 ? 'running' : 'created',
  })).filter((item) => Number.isFinite(item.sessionId));
}

function deploymentState(deployment) {
  const desired = deployment.spec?.replicas ?? 1;
  const ready = deployment.status?.readyReplicas || 0;
  const available = deployment.status?.availableReplicas || 0;
  const observed = deployment.status?.observedGeneration || 0;
  const generation = deployment.metadata?.generation || 0;
  if (desired === 0) return 'stopped';
  if (ready >= desired && available >= desired && observed >= generation) return 'running';
  if ((deployment.status?.replicas || 0) > 0 || deployment.status?.unavailableReplicas) return 'restarting';
  return 'creating';
}

function readyPod(pod) {
  return (pod.status?.conditions || []).some((condition) =>
    condition.type === 'Ready' && condition.status === 'True'
  );
}

function normalizeDeployment(deployment, pods) {
  const runtimeName = deployment.metadata?.name;
  const labelsMap = deployment.metadata?.labels || {};
  const matchingPods = (pods || []).filter((pod) =>
    pod.metadata?.labels?.['social.usernode.io/runtime-name'] === runtimeName
      && !pod.metadata?.deletionTimestamp
  );
  const readyPods = matchingPods.filter(readyPod);
  const candidates = readyPods.length ? readyPods : matchingPods;
  candidates.sort((left, right) =>
    new Date(right.metadata?.creationTimestamp || 0) - new Date(left.metadata?.creationTimestamp || 0)
  );
  const currentPod = candidates[0] || null;
  const desired = deployment.spec?.replicas ?? 1;
  const ready = deployment.status?.readyReplicas || 0;
  const restarts = matchingPods.reduce((total, pod) => total + (pod.status?.containerStatuses || [])
    .reduce((sum, container) => sum + (container.restartCount || 0), 0), 0);
  const environment = labelsMap['social.usernode.io/environment'] || 'unknown';
  return {
    name: runtimeName,
    id: currentPod?.metadata?.uid || deployment.metadata?.uid || null,
    runtimeKind: 'kubernetes',
    resourceType: environment === 'production' ? 'app' : environment,
    environment,
    state: deploymentState(deployment),
    status: `${ready}/${desired} ready${restarts ? ` · ${restarts} restart${restarts === 1 ? '' : 's'}` : ''}`,
    image: deployment.spec?.template?.spec?.containers?.[0]?.image || null,
    startedAt: currentPod?.metadata?.creationTimestamp || deployment.metadata?.creationTimestamp || null,
    appId: Number(labelsMap['social.usernode.io/app-id']) || null,
    sessionId: Number(labelsMap['social.usernode.io/session-id']) || null,
    ready,
    desired,
    restarts,
  };
}

async function listStatusResources(config) {
  const cfg = config.kubernetes;
  const selector = 'app.kubernetes.io/managed-by=social-vibecoding-runtime';
  const namespaces = [...new Set([cfg.appNamespace, cfg.workerNamespace].filter(Boolean))];
  const { apps, core } = getClients();
  const perNamespace = await Promise.all(namespaces.map(async (namespace) => {
    const [deployments, pods] = await Promise.all([
      apps.listNamespacedDeployment({ namespace, labelSelector: selector }),
      core.listNamespacedPod({ namespace, labelSelector: selector }),
    ]);
    return (deployments.items || []).map((deployment) =>
      normalizeDeployment(deployment, pods.items || [])
    );
  }));
  return perNamespace.flat();
}

const QUANTITY_MULTIPLIERS = {
  n: 1e-9, u: 1e-6, m: 1e-3,
  '': 1,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50,
};

function quantityNumber(value) {
  const match = String(value ?? '').trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([a-zA-Z]*)$/);
  if (!match || !Object.prototype.hasOwnProperty.call(QUANTITY_MULTIPLIERS, match[2])) return null;
  const result = Number(match[1]) * QUANTITY_MULTIPLIERS[match[2]];
  return Number.isFinite(result) ? result : null;
}

function quotaMetric(quota, key) {
  const hard = quota.status?.hard?.[key] ?? quota.spec?.hard?.[key];
  if (hard === undefined || hard === null) return null;
  const used = quota.status?.used?.[key] ?? '0';
  const hardNumber = quantityNumber(hard);
  const usedNumber = quantityNumber(used);
  return {
    used: String(used),
    hard: String(hard),
    percent: hardNumber && usedNumber !== null
      ? Math.max(0, Math.round((usedNumber / hardNumber) * 1000) / 10)
      : null,
    headroomPercent: hardNumber && usedNumber !== null
      ? Math.max(0, Math.round((1 - (usedNumber / hardNumber)) * 1000) / 10)
      : null,
  };
}

async function listNamespaceCapacity(config) {
  const cfg = config.kubernetes;
  const namespaces = [...new Set([
    cfg.appNamespace,
    cfg.workerNamespace,
    cfg.buildNamespace,
  ].filter(Boolean))];
  const { core } = getClients();
  return Promise.all(namespaces.map(async (namespace) => {
    try {
      const response = await core.listNamespacedResourceQuota({ namespace });
      const quotas = response.items || [];
      const quota = quotas.find((item) => item.metadata?.name === 'social-vibecoding') || quotas[0];
      if (!quota) return { namespace, quotaName: null, resources: null };
      return {
        namespace,
        quotaName: quota.metadata?.name || null,
        resources: {
          pods: quotaMetric(quota, 'pods'),
          requestsCpu: quotaMetric(quota, 'requests.cpu'),
          requestsMemory: quotaMetric(quota, 'requests.memory'),
        },
      };
    } catch (err) {
      log.warn('kubernetes', 'Namespace quota status unavailable', {
        namespace, err: err.message,
      });
      return { namespace, quotaName: null, resources: null, unavailable: true };
    }
  }));
}

async function cloneWorkerVolume(config, sourceSessionId, targetSessionId) {
  const cfg = config.kubernetes;
  const namespace = cfg.workerNamespace;
  const sourceRuntime = dnsName(`sv-worker-s${sourceSessionId}`);
  const sourcePvc = withSuffix(sourceRuntime, 'state');
  const targetPvc = withSuffix(dnsName(`sv-worker-s${targetSessionId}`), 'state');
  const { core, batch } = getClients();
  const source = await core.readNamespacedPersistentVolumeClaim({ name: sourcePvc, namespace });
  try {
    const body = {
      apiVersion: 'v1', kind: 'PersistentVolumeClaim',
      metadata: { name: targetPvc, namespace, labels: labels({ sessionId: targetSessionId, environment: 'worker' }) },
      spec: {
        accessModes: source.spec.accessModes || ['ReadWriteOnce'],
        resources: { requests: { storage: source.spec.resources?.requests?.storage || cfg.workerStorageSize } },
      },
    };
    if (source.spec.storageClassName) body.spec.storageClassName = source.spec.storageClassName;
    await core.createNamespacedPersistentVolumeClaim({ namespace, body });
  } catch (err) { if (err?.code !== 409 && err?.response?.statusCode !== 409) throw err; }

  const sourcePods = await core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${sourceRuntime}` });
  const sourceNode = sourcePods.items?.[0]?.spec?.nodeName;
  const name = dnsName(`sv-worker-copy-${sourceSessionId}-${targetSessionId}-${Date.now().toString(36)}`);
  const podSpec = {
    restartPolicy: 'Never', serviceAccountName: cfg.workerServiceAccount, automountServiceAccountToken: false,
    securityContext: nodePodSecurityContext(),
    containers: [{ name: 'copy', image: cfg.workerImage, command: ['sh', '-c', 'cp -a /from/. /to/'], volumeMounts: [{ name: 'from', mountPath: '/from', readOnly: true }, { name: 'to', mountPath: '/to' }], securityContext: containerSecurityContext(), resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' } } }],
    volumes: [{ name: 'from', persistentVolumeClaim: { claimName: sourcePvc, readOnly: true } }, { name: 'to', persistentVolumeClaim: { claimName: targetPvc } }],
  };
  if (sourceNode) podSpec.nodeName = sourceNode;
  await batch.createNamespacedJob({ namespace, body: { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace, labels: labels({ sessionId: targetSessionId, environment: 'worker' }) }, spec: { backoffLimit: 0, activeDeadlineSeconds: 300, ttlSecondsAfterFinished: 3600, template: { metadata: { labels: labels({ sessionId: targetSessionId, environment: 'worker' }) }, spec: podSpec } } } });
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await batch.readNamespacedJob({ name, namespace });
    if (job.status?.succeeded) return;
    if (job.status?.failed) throw new Error(`Worker PVC copy Job ${name} failed`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for worker PVC copy Job ${name}`);
}

// `onStdoutLine(line)`: the same observer contract as docker.runOneShot —
// complete stdout lines as the run progresses, on top of the final log the
// verdict is read from. A Job has no stdout to listen to, so while polling
// for completion the pod log is re-read every few ticks and only the lines
// past the last consumed offset are handed over. Errors reading the log are
// swallowed: progress is a courtesy, the verdict still comes from the final
// read below, unchanged.
async function runCaptureJob(config, options) {
  return runCheckJob(config, options, 'capture');
}

async function runUnitSuiteJob(config, options) {
  return runCheckJob(config, options, 'unit-suite');
}

async function runCheckJob(config, {
  sessionId, env, stdinPayload = null, timeoutMs = 180000,
  onStdoutLine = null, cmd, memory = '2g', cpus = '4', maxBuffer = 64 * 1024 * 1024,
}, kind) {
  const cfg = config.kubernetes;
  const unitSuite = kind === 'unit-suite';
  const image = unitSuite ? cfg.workerImage : cfg.captureImage;
  if (!image?.includes('@sha256:')) throw new Error(`${unitSuite ? 'KUBERNETES_WORKER_IMAGE' : 'KUBERNETES_CAPTURE_IMAGE'} must be an immutable digest`);
  const namespace = cfg.workerNamespace;
  const name = dnsName(`sv-${kind}-s${sessionId}-${Date.now().toString(36)}`);
  const inputSecretName = !unitSuite && stdinPayload == null ? null : withSuffix(name, 'input');
  if (stdinPayload != null && Buffer.byteLength(String(stdinPayload), 'utf8') > 900 * 1024) {
    throw new Error('Capture stdin payload exceeds the Kubernetes Secret transport limit');
  }
  const container = {
    name: kind, image, imagePullPolicy: 'IfNotPresent',
    env: Object.entries(env || {}).map(([key, value]) => unitSuite
      ? { name: key, valueFrom: { secretKeyRef: { name: inputSecretName, key } } }
      : { name: key, value: String(value) }),
    // Eight concurrent Chromium pages need the same memory budget as Docker captures.
    resources: { requests: { cpu: '250m', memory: '512Mi', 'ephemeral-storage': '1Gi' }, limits: { cpu: '2', memory: '4Gi', 'ephemeral-storage': '4Gi' } },
    securityContext: containerSecurityContext(),
  };
  if (unitSuite) {
    container.command = cmd;
    container.resources = {
      requests: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi' },
      limits: { cpu: String(cpus), memory: String(memory).replace(/g$/i, 'Gi').replace(/m$/i, 'Mi'), 'ephemeral-storage': '8Gi' },
    };
  }
  const podVolumes = [];
  if (!unitSuite && inputSecretName) {
    container.command = ['sh', '-c'];
    container.args = ['exec node /app/capture.js < /var/run/usernode-capture/tests.json'];
    container.volumeMounts = [{
      name: 'capture-input', mountPath: '/var/run/usernode-capture', readOnly: true,
    }];
    podVolumes.push({
      name: 'capture-input',
      secret: { secretName: inputSecretName, items: [{ key: 'tests.json', path: 'tests.json' }] },
    });
  }
  const body = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace, labels: labels({ sessionId, environment: unitSuite ? 'worker' : 'capture' }) }, spec: {
    backoffLimit: 0, activeDeadlineSeconds: Math.ceil(timeoutMs / 1000), ttlSecondsAfterFinished: 3600,
    template: { metadata: { labels: labels({ sessionId, environment: unitSuite ? 'worker' : 'capture' }) }, spec: { restartPolicy: 'Never', serviceAccountName: cfg.workerServiceAccount, automountServiceAccountToken: false, securityContext: nodePodSecurityContext(), containers: [container], ...(podVolumes.length ? { volumes: podVolumes } : {}) } },
  } };
  const { batch, core } = getClients();
  let inputSecretCreated = false;
  // Follow state lives outside the try so the finally can close the stream.
  let following = false;
  let followAbort = null;
  try {
    if (inputSecretName) {
      await core.createNamespacedSecret({ namespace, body: {
        apiVersion: 'v1', kind: 'Secret',
        metadata: { name: inputSecretName, namespace, labels: labels({ sessionId, environment: unitSuite ? 'worker' : 'capture' }) },
        type: 'Opaque', stringData: unitSuite
          ? Object.fromEntries(Object.entries(env || {}).map(([key, value]) => [key, String(value)]))
          : { 'tests.json': String(stdinPayload) },
      } });
      inputSecretCreated = true;
    }
    const createdJob = await batch.createNamespacedJob({ namespace, body });
    // A platform restart must not orphan private clone credentials. The Job's
    // TTL also garbage-collects its input Secret if normal cleanup cannot run.
    if (unitSuite && createdJob?.metadata?.uid) {
      const secret = await core.readNamespacedSecret({ name: inputSecretName, namespace });
      secret.metadata.ownerReferences = [{ apiVersion: 'batch/v1', kind: 'Job', name, uid: createdJob.metadata.uid }];
      await core.replaceNamespacedSecret({ name: inputSecretName, namespace, body: secret });
    }
    const deadline = Date.now() + timeoutMs + 15000;
    // Progress observer state. Two ways to see the container's stdout as it
    // streams: FOLLOW the pod log (one long request; each line reaches the
    // observer as it is printed, the same cadence docker's stdout gives),
    // or, until the follow is up or where it is unavailable, re-read the
    // cumulative log every PROGRESS_EVERY_TICKS and hand over what is new.
    // The polled read arrives in ~6s steps, which on a fast document group
    // is 50-100 checks at once; the follow is what makes the bar move
    // smoothly. `consumed` is how much of the log either path has already
    // delivered, so a follow that starts after a poll skips what the poll
    // handed over instead of replaying it.
    const PROGRESS_EVERY_TICKS = 3;
    let progressPodName = null;
    let consumed = 0;
    let tick = 0;
    const findPod = async () => {
      if (progressPodName) return progressPodName;
      const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
      progressPodName = pods.items?.[0]?.metadata?.name || null;
      return progressPodName;
    };
    const startFollow = async () => {
      if (typeof onStdoutLine !== 'function' || following) return;
      try {
        if (!(await findPod())) return;
        const logApi = clientsLogApi(getClients());
        if (!logApi) return;
        const sink = new stream.PassThrough();
        attachLineObserver(sink, onStdoutLine, { skipBytes: consumed });
        // The API refuses a container that has not started ("is waiting to
        // start"); the next tick tries again, and the polled read covers
        // the gap.
        followAbort = await logApi.log(namespace, progressPodName, kind, sink, { follow: true });
        following = true;
      } catch { /* the polled read stays in charge */ }
    };
    const observeProgress = async () => {
      if (typeof onStdoutLine !== 'function' || following) return;
      try {
        if (!(await findPod())) return;
        const text = await core.readNamespacedPodLog({ name: progressPodName, namespace, container: kind, limitBytes: maxBuffer });
        const log = String(text || '');
        if (log.length <= consumed) return;
        const fresh = log.slice(consumed);
        const lastNl = fresh.lastIndexOf('\n');
        if (lastNl === -1) return; // no complete new line yet
        for (const line of fresh.slice(0, lastNl).split('\n')) {
          try { onStdoutLine(line); } catch { /* observer must not break the run */ }
        }
        consumed += lastNl + 1;
      } catch { /* progress is best-effort */ }
    };
    while (Date.now() < deadline) {
      const job = await batch.readNamespacedJob({ name, namespace });
      if (job.status?.failed || job.status?.conditions?.some(c => c.type === 'Failed' && c.status === 'True')) {
        const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
        const pod = pods.items?.[0];
        const err = new Error(`${kind} Job ${name} failed`);
        err.stdout = pod ? await core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container: kind, limitBytes: maxBuffer }).catch(() => '') : '';
        const terminated = pod?.status?.containerStatuses?.find(c => c.name === kind)?.state?.terminated;
        err.code = terminated?.exitCode;
        const jobReason = job.status.conditions?.find(c => c.type === 'Failed')?.reason;
        err.stderr = [jobReason, terminated?.reason].filter(Boolean).join(': ');
        err.killed = jobReason === 'DeadlineExceeded';
        throw err;
      }
      if (job.status?.succeeded) {
        const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
        const pod = pods.items?.[0];
        return { stdout: pod ? await core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container: kind, limitBytes: maxBuffer }) : '', runtimeName: name };
      }
      tick += 1;
      if (!following) await startFollow();
      if (!following && tick % PROGRESS_EVERY_TICKS === 0) await observeProgress();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // Stop the workload before removing its input credentials on timeout.
    await deleteIfPresent(batch, 'deleteNamespacedJob', name, namespace, { propagationPolicy: 'Background' });
    const err = new Error(`Timed out waiting for ${kind} Job ${name}`);
    err.killed = true;
    throw err;
  } finally {
    if (followAbort && typeof followAbort.abort === 'function') {
      try { followAbort.abort(); } catch { /* already closed */ }
    }
    if (inputSecretCreated) {
      await deleteIfPresent(core, 'deleteNamespacedSecret', inputSecretName, namespace)
        .catch(() => {});
    }
  }
}

// The pod-log follow client: an injected `logs` for tests, else one built
// on the real kube config. Null where neither exists (a test that injected
// only the typed API clients), which leaves the polled read in charge.
function clientsLogApi(clients) {
  if (!clients) return null;
  if (clients.logs && typeof clients.logs.log === 'function') return clients.logs;
  if (clients.kc) {
    try { clients.logs = new k8s.Log(clients.kc); return clients.logs; } catch { return null; }
  }
  return null;
}

// Feed a readable's bytes to `onLine` one complete line at a time, after
// skipping the first `skipBytes` CHARACTERS (what a polled read already
// delivered — `consumed` above counts characters of the decoded log, so the
// skip does too; a StringDecoder keeps a multi-byte character split across
// chunks whole). Chunk boundaries fall anywhere; the trailing partial is
// flushed at end. Same contract as docker.attachLineObserver, kept local so
// the two runtime modules do not import each other.
function attachLineObserver(readable, onLine, { skipBytes = 0 } = {}) {
  const { StringDecoder } = require('string_decoder');
  const decoder = new StringDecoder('utf8');
  let toSkip = Math.max(0, skipBytes | 0);
  let carry = '';
  const deliver = (line) => { try { onLine(line); } catch { /* observer must not break the run */ } };
  readable.on('data', (chunk) => {
    let text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
    if (toSkip > 0) {
      const n = Math.min(toSkip, text.length);
      text = text.slice(n);
      toSkip -= n;
      if (!text) return;
    }
    carry += text;
    let nl;
    while ((nl = carry.indexOf('\n')) !== -1) {
      deliver(carry.slice(0, nl));
      carry = carry.slice(nl + 1);
    }
  });
  readable.on('end', () => {
    carry += decoder.end();
    if (carry) { deliver(carry); carry = ''; }
  });
  readable.on('error', () => {});
}

async function execInWorker(config, runtimeName, command, stdinText = null) {
  const namespace = config.kubernetes.workerNamespace;
  const pods = await getClients().core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${runtimeName}` });
  const pod = pods.items?.[0];
  if (!pod) throw new Error(`Worker Pod for ${runtimeName} not found`);
  const stdout = new stream.PassThrough();
  const stderr = new stream.PassThrough();
  let out = ''; let err = '';
  stdout.on('data', (chunk) => { out += chunk.toString(); });
  stderr.on('data', (chunk) => { err += chunk.toString(); });
  const input = stdinText === null ? null : stream.Readable.from([stdinText]);
  let status;
  const exec = new k8s.Exec(getClients().kc);
  const socket = await exec.exec(namespace, pod.metadata.name, 'worker', command, stdout, stderr, input, false, (value) => { status = value; });
  await new Promise((resolve, reject) => { socket.onclose = resolve; socket.onerror = reject; });
  if (status?.status === 'Failure') throw new Error(err || status.message || 'Worker exec failed');
  return { stdout: out, stderr: err };
}

module.exports = {
  dnsName, withSuffix, labels, createBuild, deployApplication, getApplicationStatus,
  getApplicationLogs, restartApplication, deleteApplication, deleteBuilds, deleteFailedBuilds, ensureWorker,
  runCaptureJob, runUnitSuiteJob, execInWorker, _getClients: getClients,
  getWorkerStatus, getWorkerContractVersion, deleteWorker, listWorkers, cloneWorkerVolume,
  listStatusResources, listNamespaceCapacity,
  _setClientsForTest: setClientsForTest, _envChecksumForTest: envChecksum,
  _attachLineObserverForTest: attachLineObserver,
  _buildPhasesFromPodForTest: buildPhasesFromPod,
  _deploymentStateForTest: deploymentState,
  _normalizeDeploymentForTest: normalizeDeployment,
  _quantityNumberForTest: quantityNumber,
};
