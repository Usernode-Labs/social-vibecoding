'use strict';

// Test-only preflight. No DDL, Kubernetes writes, registry writes or default
// credential loading belongs here. Mutating tests run only after every check.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const k8s = require('@kubernetes/client-node');
const { Client } = require('pg');

const LABEL = 'social.usernode.io/recovery-fixture';
const DIGEST = /@sha256:[a-f0-9]{64}$/;

function requireIsolation(condition, message) {
  if (!condition) throw new Error(`Isolated kpack preflight: ${message}`);
}

function loopbackUrl(value, protocol) {
  const url = new URL(value);
  requireIsolation(url.protocol === protocol && url.hostname === '127.0.0.1'
    && url.port && !url.hash, 'destination must be explicit IPv4 loopback with a port');
  return url;
}

function validateDestinations(fixture, databaseUrl, now = Date.now()) {
  const isolation = fixture.isolation;
  requireIsolation(isolation?.version === 1, 'isolation manifest version 1 required');
  const id = isolation.fixtureId;
  requireIsolation(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id), 'fresh fixture UUID required');
  const created = Date.parse(isolation.createdAt);
  requireIsolation(Number.isFinite(created) && created <= now && now - created < 24 * 3600000,
    'fixture must have been created within the last 24 hours');
  const name = `preview-recovery-test-${id}`;
  const clusterName = `c4-preview-${id}`;
  requireIsolation(isolation.cluster.name === clusterName && isolation.cluster.context === `kind-${clusterName}`,
    'expected dedicated kind cluster identity required');
  const server = loopbackUrl(isolation.cluster.server, 'https:');
  requireIsolation(!server.username && !server.password && server.pathname === '/' && !server.search,
    'invalid Kubernetes API destination');
  requireIsolation(isolation.cluster.uid && isolation.cluster.nodeContainerIds?.length,
    'expected cluster UID and node container identities required');
  requireIsolation(isolation.dockerHost?.startsWith('unix:///') && isolation.dockerDaemonId,
    'explicit local Docker socket and daemon identity required');

  const database = isolation.database;
  requireIsolation(databaseUrl && database.url === databaseUrl, 'explicit database URL must match the manifest');
  const db = loopbackUrl(databaseUrl, 'postgresql:');
  requireIsolation(db.pathname === `/preview_recovery_${id.replaceAll('-', '')}` && !db.search
    && db.username === 'recovery_test' && db.password
    && database.containerId && database.systemIdentifier && DIGEST.test(database.image)
    && /^(docker.io\/library\/)?postgres@/.test(database.image), 'dedicated PostgreSQL identity required');

  const namespace = isolation.namespace;
  requireIsolation(namespace.name === name && namespace.uid, 'dedicated namespace identity required');
  const registry = isolation.registry;
  const registryHost = `registry.${name}.svc.cluster.local:5000`;
  requireIsolation(registry.host === registryHost && registry.serviceUid && registry.podUid
    && /^(docker.io\/library\/)?registry@/.test(registry.image) && DIGEST.test(registry.image),
  'dedicated in-cluster registry identity required');
  const settings = fixture.config;
  const runtime = settings?.kubernetes;
  requireIsolation(settings?.appRuntime === 'kubernetes' && runtime?.buildEngine === 'kpack'
    && runtime.buildNamespace === name && runtime.appNamespace === name,
  'all runtime/build namespaces must belong to this fixture');
  const prefix = `${registryHost}/preview-recovery-${id}`;
  requireIsolation(runtime.repositoryPrefix === `${prefix}/images`
    && runtime.cacheRepositoryPrefix === `${prefix}/cache`
    && runtime.builderImage?.startsWith(`${prefix}/builder@sha256:`) && DIGEST.test(runtime.builderImage),
  'builder, output and cache must use only the dedicated test registry');
  requireIsolation(runtime.buildServiceAccount === 'recovery-builder', 'dedicated build service account required');
  for (const image of [fixture.runtimeImage, fixture.databaseRuntimeImage].filter(Boolean)) {
    requireIsolation(image.startsWith(`${prefix}/images/demo@sha256:`) && DIGEST.test(image)
      && runtime.generatedAppServiceAccount === 'recovery-builder', 'runtime fixture must use the dedicated registry/account');
  }
  const repo = new URL(fixture.repoUrl);
  requireIsolation(repo.protocol === 'https:' && !repo.username && !repo.password && !repo.search && !repo.hash
    && /^[a-f0-9]{40}$/.test(fixture.revision) && [null, 'build', 'ensure:shell'].includes(fixture.runScript),
  'explicit public fixture source, full revision and script required');
  if (fixture.preparationSource) {
    requireIsolation(fixture.preparationSource.repoUrl === 'https://github.com/nickovivar/simple-health-endpoint'
      && fixture.preparationSource.revision === '59de32fd44f50ba06926a43d90b567e33aa39236'
      && fixture.preparationSource.branch === 'main', 'pinned health-enabled preparation fixture required');
  }
  requireIsolation(!settings.captureRuntime || fixture.checks, 'capture configuration requires its dedicated checks manifest');
  requireIsolation(!runtime.captureImage || fixture.checks, 'capture image requires its dedicated checks manifest');
  if (fixture.checks) {
    requireIsolation(settings.captureRuntime === 'kubernetes'
      && runtime.workerNamespace === name && runtime.workerServiceAccount === 'recovery-builder'
      && runtime.captureImage === fixture.checks.captureImage
      && runtime.captureImage.startsWith(`${prefix}/capture@sha256:`)
      && DIGEST.test(runtime.captureImage), 'checks must use the dedicated namespace, account and registry');
  }
  return isolation;
}

function loadDedicatedClients(isolation) {
  requireIsolation(path.isAbsolute(isolation.directory) && path.isAbsolute(isolation.kubeconfigPath),
    'absolute dedicated fixture paths required');
  const root = fs.realpathSync(isolation.directory);
  requireIsolation(root.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`)
    && path.basename(root) === `preview-recovery-test-${isolation.fixtureId}`, 'dedicated temporary fixture directory required');
  recentlyCreated(fs.statSync(root).birthtime, isolation);
  const filename = fs.realpathSync(isolation.kubeconfigPath);
  requireIsolation(filename === path.join(root, 'kubeconfig'), 'dedicated fixture kubeconfig required');
  const source = fs.readFileSync(filename, 'utf8');
  requireIsolation(createHash('sha256').update(source).digest('hex') === isolation.kubeconfigSha256,
    'kubeconfig fingerprint mismatch');

  // Validate raw YAML before the SDK parser, which can read token-file entries.
  const raw = yaml.load(source);
  requireIsolation(raw?.clusters?.length === 1 && raw.contexts?.length === 1 && raw.users?.length === 1
    && raw['current-context'] === isolation.cluster.context, 'one dedicated kubeconfig context required');
  const cluster = raw.clusters[0];
  const context = raw.contexts[0];
  const user = raw.users[0];
  requireIsolation(cluster.name === isolation.cluster.context && context.name === isolation.cluster.context
    && context.context.cluster === cluster.name && context.context.user === user.name
    && cluster.cluster.server === isolation.cluster.server, 'kubeconfig cluster/context/server mismatch');
  const clusterKeys = ['server', 'certificate-authority-data'];
  const userKeys = ['client-certificate-data', 'client-key-data'];
  requireIsolation(Object.keys(cluster.cluster).every(key => clusterKeys.includes(key))
    && Object.keys(user.user).every(key => userKeys.includes(key))
    && cluster.cluster['certificate-authority-data'] && user.user['client-certificate-data'] && user.user['client-key-data'],
  'embedded fixture TLS credentials only; no files, tokens, exec helpers, proxies or insecure TLS');
  const kc = new k8s.KubeConfig();
  kc.loadFromString(source);
  return {
    kc,
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
    discovery: kc.makeApiClient(k8s.DiscoveryV1Api),
  };
}

function sanitizedEnvironment(env = process.env) {
  const result = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (env[key]) result[key] = env[key];
  }
  for (const key of ['KPACK_RECOVERY_TEST_CONFIG', 'PREVIEW_FLOW_TEST_DATABASE_URL']) {
    requireIsolation(env[key], `${key} required; no ambient fallback`);
    result[key] = env[key];
  }
  result.RUN_ISOLATED_KPACK_TEST = '1';
  return result;
}

function dockerReader(isolation) {
  const socket = fs.realpathSync(isolation.dockerHost.slice('unix://'.length));
  requireIsolation(fs.statSync(socket).isSocket(), 'local Docker socket is not a socket');
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  return args => JSON.parse(execFileSync('docker', ['--host', `unix://${socket}`, ...args], {
    env, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  }));
}

function recentlyCreated(value, isolation) {
  const created = new Date(value).getTime();
  requireIsolation(Number.isFinite(created) && created >= Date.parse(isolation.createdAt),
    'resource predates the new disposable fixture');
}

function verifyContainers(isolation, readDocker) {
  const info = readDocker(['info', '--format', '{{json .}}']);
  requireIsolation(info.ID === isolation.dockerDaemonId, 'local Docker daemon identity mismatch');
  const ids = [...isolation.cluster.nodeContainerIds, isolation.database.containerId];
  requireIsolation(ids.every(id => /^[a-f0-9]{64}$/.test(id)) && new Set(ids).size === ids.length,
    'distinct full container IDs required');
  const containers = readDocker(['inspect', '--type', 'container', ...ids]);
  requireIsolation(containers.length === ids.length, 'missing local fixture containers');
  const byId = new Map(containers.map(container => [container.Id, container]));
  for (const id of ids) {
    const container = byId.get(id);
    requireIsolation(container?.State.Running === true, 'fixture container is not running');
    recentlyCreated(container.Created, isolation);
    for (const mount of container.Mounts || []) {
      if (mount.Type === 'bind') {
        requireIsolation(id !== isolation.database.containerId && mount.Source === '/lib/modules' && mount.RW === false,
          'fixture cannot reuse host data/configuration bind mounts');
      } else if (mount.Type === 'volume') {
        const [volume] = readDocker(['volume', 'inspect', mount.Name]);
        recentlyCreated(volume.CreatedAt, isolation);
      } else {
        requireIsolation(mount.Type === 'tmpfs', 'unverified fixture storage');
      }
    }
  }
  const nodes = isolation.cluster.nodeContainerIds.map(id => byId.get(id));
  requireIsolation(nodes.every(node => node.Config.Labels?.['io.x-k8s.kind.cluster'] === isolation.cluster.name),
    'container does not belong to the expected kind cluster');
  const apiPort = new URL(isolation.cluster.server).port;
  const apiBindings = nodes.flatMap(node => node.NetworkSettings.Ports?.['6443/tcp'] || []);
  requireIsolation(apiBindings.length === 1 && apiBindings[0].HostIp === '127.0.0.1'
    && apiBindings[0].HostPort === apiPort, 'API port is not exclusively owned by the local cluster on loopback');
  const database = byId.get(isolation.database.containerId);
  const dbPort = new URL(isolation.database.url).port;
  const dbBindings = database.NetworkSettings.Ports?.['5432/tcp'];
  requireIsolation(database.Config.Labels?.[LABEL] === isolation.fixtureId
    && database.Name === `/${isolation.cluster.name}-postgres`
    && database.Config.Image === isolation.database.image
    && dbBindings?.length === 1 && dbBindings[0].HostIp === '127.0.0.1'
    && dbBindings[0].HostPort === dbPort, 'PostgreSQL destination is not owned by the local fixture on loopback');
  return { nodes, database };
}

async function verifyCluster(isolation, clients) {
  const { core } = clients;
  const system = await core.readNamespace({ name: 'kube-system' });
  requireIsolation(system.metadata.uid === isolation.cluster.uid, 'Kubernetes cluster UID mismatch');
  const namespace = await core.readNamespace({ name: isolation.namespace.name });
  requireIsolation(namespace.metadata.uid === isolation.namespace.uid
    && namespace.metadata.labels?.[LABEL] === isolation.fixtureId, 'test namespace identity mismatch');
  recentlyCreated(namespace.metadata.creationTimestamp, isolation);
  const account = await core.readNamespacedServiceAccount({ name: 'recovery-builder', namespace: namespace.metadata.name });
  requireIsolation(account.metadata.labels?.[LABEL] === isolation.fixtureId
    && !account.secrets?.length && !account.imagePullSecrets?.length,
  'build account must belong to the fixture and contain no ambient registry/Git credentials');
  recentlyCreated(account.metadata.creationTimestamp, isolation);
}

async function verifyRegistry(isolation, clients) {
  const namespace = isolation.namespace.name;
  const service = await clients.core.readNamespacedService({ name: 'registry', namespace });
  const registry = isolation.registry;
  requireIsolation(service.metadata.uid === registry.serviceUid && service.metadata.labels?.[LABEL] === isolation.fixtureId
    && service.spec.type === 'ClusterIP' && service.spec.clusterIP && service.spec.clusterIP !== 'None'
    && !service.spec.externalName && !service.spec.externalIPs?.length
    && service.spec.ports.length === 1 && service.spec.ports[0].port === 5000
    && (!service.spec.ports[0].protocol || service.spec.ports[0].protocol === 'TCP')
    && service.spec.ports[0].targetPort === 5000, 'registry must be a fixture-owned internal service');
  recentlyCreated(service.metadata.creationTimestamp, isolation);
  const pods = await clients.core.listNamespacedPod({ namespace, labelSelector: `${LABEL}=${isolation.fixtureId},app=registry` });
  requireIsolation(pods.items.length === 1, 'one dedicated registry Pod required');
  const pod = pods.items[0];
  requireIsolation(pod.metadata.uid === registry.podUid && pod.status.podIP
    && !pod.metadata.deletionTimestamp
    && pod.status.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')
    && pod.metadata.labels?.[LABEL] === isolation.fixtureId,
  'registry must be the expected healthy fixture Pod');
  recentlyCreated(pod.metadata.creationTimestamp, isolation);

  requireIsolation(!pod.spec.hostNetwork && !pod.spec.initContainers?.length
    && !pod.spec.ephemeralContainers?.length && !pod.spec.imagePullSecrets?.length
    && pod.spec.containers.length === 1, 'registry cannot use extra containers, host networking or credentials');
  const container = pod.spec.containers[0];
  requireIsolation(container.image === registry.image
    && !container.command?.length && !container.args?.length && !container.env?.length && !container.envFrom?.length,
  'registry must use the pinned standard image without proxy/remote storage configuration');

  requireIsolation(pod.spec.volumes?.length === 1 && pod.spec.volumes[0].emptyDir
    && container.volumeMounts?.length === 1 && container.volumeMounts[0].name === pod.spec.volumes[0].name
    && container.volumeMounts[0].mountPath === '/var/lib/registry',
  'registry must use only new emptyDir storage');

  const endpoints = await clients.core.readNamespacedEndpoints({ name: 'registry', namespace });
  requireIsolation(endpoints.subsets?.length === 1 && !endpoints.subsets[0].notReadyAddresses?.length
    && endpoints.subsets[0].ports?.length === 1 && endpoints.subsets[0].ports[0].port === 5000
    && (!endpoints.subsets[0].ports[0].protocol || endpoints.subsets[0].ports[0].protocol === 'TCP')
    && endpoints.subsets[0].addresses?.length === 1
    && endpoints.subsets[0].addresses[0].ip === pod.status.podIP
    && endpoints.subsets[0].addresses[0].targetRef?.uid === pod.metadata.uid,
  'registry service endpoint must be the verified disposable Pod');
  const slices = await clients.discovery.listNamespacedEndpointSlice({
    namespace, labelSelector: 'kubernetes.io/service-name=registry',
  });
  requireIsolation(slices.items.length === 1 && slices.items[0].ports?.length === 1
    && slices.items[0].ports[0].port === 5000 && slices.items[0].endpoints?.length === 1,
  'one verified registry EndpointSlice required');
  requireIsolation(!slices.items[0].ports[0].protocol || slices.items[0].ports[0].protocol === 'TCP',
    'registry EndpointSlice must use TCP');
  const endpoint = slices.items[0].endpoints[0];
  requireIsolation(endpoint.conditions?.ready === true && endpoint.addresses?.length === 1
    && endpoint.addresses[0] === pod.status.podIP && endpoint.targetRef?.uid === pod.metadata.uid,
  'registry EndpointSlice must route only to the verified disposable Pod');
}

async function verifyDatabase(isolation, databaseContainer, databaseUrl, ClientType = Client) {
  const client = new ClientType({ connectionString: databaseUrl, ssl: false, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    await client.connect();
    const { rows: [identity] } = await client.query(`SELECT current_database() AS name,
      host(inet_server_addr()) AS address, inet_server_port() AS port,
      pg_postmaster_start_time() AS started, system_identifier::text AS identifier
      FROM pg_control_system()`);
    const addresses = Object.values(databaseContainer.NetworkSettings.Networks).map(network => network.IPAddress);
    requireIsolation(identity.name === new URL(isolation.database.url).pathname.slice(1)
      && identity.port === 5432 && addresses.includes(identity.address)
      && identity.identifier === isolation.database.systemIdentifier, 'PostgreSQL server/database identity mismatch');
    recentlyCreated(identity.started, isolation);
    return identity.address;
  } finally {
    await client.end();
  }
}

async function verifyIsolatedBuildFixture({ env = process.env, databaseUrl, dependencies = {} } = {}) {
  sanitizedEnvironment(env);
  const fixture = JSON.parse(fs.readFileSync(env.KPACK_RECOVERY_TEST_CONFIG, 'utf8'));
  const isolation = validateDestinations(fixture, env.PREVIEW_FLOW_TEST_DATABASE_URL);
  requireIsolation(fs.realpathSync(env.KPACK_RECOVERY_TEST_CONFIG) === path.join(fs.realpathSync(isolation.directory), 'fixture.json'),
    'configuration must belong to the dedicated fixture directory');
  const clients = (dependencies.loadClients || loadDedicatedClients)(isolation);
  const inventory = verifyContainers(isolation, dependencies.readDocker || dockerReader(isolation));
  await verifyCluster(isolation, clients);
  const nodes = await clients.core.listNode();
  const nodeNames = inventory.nodes.map(node => node.Name.slice(1)).sort();
  requireIsolation(JSON.stringify(nodes.items.map(node => node.metadata.name).sort()) === JSON.stringify(nodeNames),
    'API nodes do not match the local Docker cluster');
  await verifyRegistry(isolation, clients);
  const connectionString = databaseUrl || isolation.database.url;
  const scoped = new URL(connectionString);
  const base = new URL(isolation.database.url);
  const options = scoped.searchParams.get('options');
  requireIsolation([...scoped.searchParams.keys()].every(key => key === 'options')
    && scoped.searchParams.size <= 1 && (!scoped.searchParams.has('options') || /^-c search_path=execution_[0-9_]+$/.test(options)),
  'invalid test database schema options');
  scoped.search = '';
  requireIsolation(scoped.href === base.href, 'worker database destination mismatch');
  const databaseAddress = await (dependencies.verifyDatabase || verifyDatabase)(isolation, inventory.database, connectionString);
  return { fixture, clients, databaseAddress };
}

module.exports = {
  LABEL,
  validateDestinations,
  loadDedicatedClients,
  sanitizedEnvironment,
  verifyContainers,
  verifyCluster,
  verifyRegistry,
  verifyDatabase,
  verifyIsolatedBuildFixture,
};
