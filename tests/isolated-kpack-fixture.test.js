'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync, fork } = require('node:child_process');
const { once } = require('node:events');
const {
  LABEL, validateDestinations, loadDedicatedClients, sanitizedEnvironment,
  verifyContainers, verifyRegistry, verifyDatabase, verifyIsolatedBuildFixture,
} = require('./lib/isolated-kpack-fixture');

function fixture(t) {
  const id = randomUUID();
  const name = `preview-recovery-test-${id}`;
  const clusterName = `c4-preview-${id}`;
  const createdAt = new Date(Date.now() - 1000).toISOString();
  const directory = path.join(os.tmpdir(), name);
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databaseUrl = `postgresql://recovery_test:disposable@127.0.0.1:55449/preview_recovery_${id.replaceAll('-', '')}`;
  const host = `registry.${name}.svc.cluster.local:5000`;
  const prefix = `${host}/preview-recovery-${id}`;
  const nodeId = 'a'.repeat(64);
  const dbId = 'b'.repeat(64);
  const value = {
    isolation: {
      version: 1, fixtureId: id, createdAt, directory,
      kubeconfigPath: path.join(directory, 'kubeconfig'),
      dockerHost: 'unix:///tmp/injected-docker.sock', dockerDaemonId: 'local-daemon',
      cluster: { name: clusterName, context: `kind-${clusterName}`, server: 'https://127.0.0.1:64439', uid: 'cluster-uid', nodeContainerIds: [nodeId] },
      namespace: { name, uid: 'namespace-uid' },
      database: { url: databaseUrl, containerId: dbId, systemIdentifier: '1234567', image: `postgres@sha256:${'d'.repeat(64)}` },
      registry: { host, serviceUid: 'service-uid', podUid: 'pod-uid', image: `registry@sha256:${'e'.repeat(64)}` },
    },
    config: {
      appRuntime: 'kubernetes',
      kubernetes: {
        buildEngine: 'kpack', buildNamespace: name, appNamespace: name,
        buildServiceAccount: 'recovery-builder', builderImage: `${prefix}/builder@sha256:${'c'.repeat(64)}`,
        repositoryPrefix: `${prefix}/images`, cacheRepositoryPrefix: `${prefix}/cache`,
      },
    },
    repoUrl: 'https://github.com/example/isolated-fixture', revision: 'f'.repeat(40), runScript: null,
  };
  const kubeconfig = {
    apiVersion: 'v1', kind: 'Config',
    'current-context': `kind-${clusterName}`,
    clusters: [{ name: `kind-${clusterName}`, cluster: { server: value.isolation.cluster.server, 'certificate-authority-data': 'Y2E=' } }],
    contexts: [{ name: `kind-${clusterName}`, context: { cluster: `kind-${clusterName}`, user: 'fixture' } }],
    users: [{ name: 'fixture', user: { 'client-certificate-data': 'Y2VydA==', 'client-key-data': 'a2V5' } }],
  };
  const metadata = uid => ({ uid, labels: { [LABEL]: id }, creationTimestamp: new Date().toISOString() });
  const containers = [
    {
      Id: nodeId, Name: `/${clusterName}-control-plane`, Created: new Date().toISOString(), State: { Running: true },
      Config: { Labels: { 'io.x-k8s.kind.cluster': clusterName } }, Mounts: [],
      NetworkSettings: { Ports: { '6443/tcp': [{ HostIp: '127.0.0.1', HostPort: '64439' }] } },
    },
    {
      Id: dbId, Name: `/${clusterName}-postgres`, Created: new Date().toISOString(), State: { Running: true },
      Config: { Labels: { [LABEL]: id }, Image: value.isolation.database.image }, Mounts: [],
      NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55449' }] }, Networks: { isolated: { IPAddress: '172.18.0.3' } } },
    },
  ];
  const service = {
    metadata: metadata('service-uid'),
    spec: { type: 'ClusterIP', clusterIP: '10.96.0.2', ports: [{ port: 5000, targetPort: 5000 }] },
  };
  const pod = {
    metadata: metadata('pod-uid'),
    spec: {
      containers: [{ image: value.isolation.registry.image, volumeMounts: [{ name: 'data', mountPath: '/var/lib/registry' }] }],
      volumes: [{ name: 'data', emptyDir: {} }],
    },
    status: { podIP: '10.244.0.2', conditions: [{ type: 'Ready', status: 'True' }] },
  };
  const endpoint = { ip: pod.status.podIP, targetRef: { uid: 'pod-uid' } };
  const slice = { ports: [{ port: 5000 }], endpoints: [{ addresses: [pod.status.podIP], targetRef: { uid: 'pod-uid' }, conditions: { ready: true } }] };
  const clients = {
    core: {
      readNamespace: async ({ name: requested }) => ({ metadata: metadata(requested === 'kube-system' ? 'cluster-uid' : 'namespace-uid') }),
      readNamespacedServiceAccount: async () => ({ metadata: metadata('account-uid') }),
      listNode: async () => ({ items: [{ metadata: { name: `${clusterName}-control-plane` } }] }),
      readNamespacedService: async () => service,
      listNamespacedPod: async () => ({ items: [pod] }),
      readNamespacedEndpoints: async () => ({ subsets: [{ ports: [{ port: 5000 }], addresses: [endpoint] }] }),
    },
    discovery: { listNamespacedEndpointSlice: async () => ({ items: [slice] }) },
  };
  const env = { KPACK_RECOVERY_TEST_CONFIG: path.join(directory, 'fixture.json'), PREVIEW_FLOW_TEST_DATABASE_URL: databaseUrl };
  const save = () => {
    const source = JSON.stringify(kubeconfig);
    value.isolation.kubeconfigSha256 = createHash('sha256').update(source).digest('hex');
    fs.writeFileSync(value.isolation.kubeconfigPath, source);
    fs.writeFileSync(env.KPACK_RECOVERY_TEST_CONFIG, JSON.stringify(value));
  };
  save();
  const readDocker = args => args[0] === 'info' ? { ID: 'local-daemon' } : containers;
  return { value, env, kubeconfig, containers, clients, service, pod, endpoint, slice, readDocker, save };
}

test('isolated harness rejects missing configuration before starting integration', () => {
  const result = spawnSync(process.execPath, ['scripts/test-recoverable-preview-build.js'], {
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /KPACK_RECOVERY_TEST_CONFIG required/);
  assert.match(result.stderr, /No integration mutations were authorized/);
});

test('runtime worker assembly rejects a missing explicit database before creating adapters', () => {
  const { runtimeTestWorker } = require('./lib/runtime-test-worker');
  const forbiddenClients = new Proxy({}, {
    get() { assert.fail('Runtime clients accessed before explicit database guard'); },
  });
  assert.throws(() => runtimeTestWorker({ options: {} }, { config: {} }, forbiddenClients),
    /Explicit isolated database connection is required/);
});

test('worker environment strips ambient Kubernetes, Docker, PG, registry and preload credentials', () => {
  const env = sanitizedEnvironment({
    PATH: '/bin', KPACK_RECOVERY_TEST_CONFIG: '/fixture', PREVIEW_FLOW_TEST_DATABASE_URL: 'explicit',
    KUBECONFIG: '/production', KUBERNETES_SERVICE_HOST: 'production', DOCKER_HOST: 'ssh://production',
    PGPASSWORD: 'production', SQL_CHECK_CONNECTION_URL: 'production', NODE_OPTIONS: '--require production',
    HOME: '/production', HTTP_PROXY: 'production', REGISTRY_PASSWORD: 'production',
  });
  assert.deepEqual(Object.keys(env).sort(), ['KPACK_RECOVERY_TEST_CONFIG', 'PATH', 'PREVIEW_FLOW_TEST_DATABASE_URL', 'RUN_ISOLATED_KPACK_TEST']);
});

for (const field of ['repoUrl', 'revision', 'branch']) {
  test(`complete preparation rejects mismatched fixture ${field} before clients or mutations`, t => {
    const f = fixture(t);
    f.value.preparationSource = {
      repoUrl: 'https://github.com/nickovivar/simple-health-endpoint',
      revision: '59de32fd44f50ba06926a43d90b567e33aa39236',
      branch: 'main',
    };
    validateDestinations(f.value, f.value.isolation.database.url);
    f.value.preparationSource[field] = 'another';
    assert.throws(() => validateDestinations(f.value, f.value.isolation.database.url), /pinned health-enabled preparation fixture/);
  });
}

const destinationConflicts = {
  'old fixture': f => { f.isolation.createdAt = '2000-01-01'; },
  'remote API': f => { f.isolation.cluster.server = 'https://production.example:6443'; },
  'default context': f => { f.isolation.cluster.context = 'production'; },
  'remote Docker': f => { f.isolation.dockerHost = 'ssh://production'; },
  'remote database': f => { f.isolation.database.url = 'postgresql://recovery_test:password@production:5432/postgres'; },
  'shared database': f => { f.isolation.database.url = 'postgresql://recovery_test:password@127.0.0.1:55449/postgres'; },
  'database host override': f => { f.isolation.database.url += '?host=production'; },
  'production output': f => { f.config.kubernetes.repositoryPrefix = 'production.example/images'; },
  'production cache': f => { f.config.kubernetes.cacheRepositoryPrefix = 'production.example/cache'; },
  'production builder': f => { f.config.kubernetes.builderImage = `production.example/builder@sha256:${'c'.repeat(64)}`; },
  'production namespace': f => { f.config.kubernetes.appNamespace = 'apps'; },
  'production database runtime image': f => { f.databaseRuntimeImage = `production.example/images/demo@sha256:${'a'.repeat(64)}`; },
  'production runtime image': f => { f.runtimeImage = `production.example/images/demo@sha256:${'a'.repeat(64)}`; },
  'ambient runtime service account': f => {
    f.runtimeImage = `${f.config.kubernetes.repositoryPrefix}/demo@sha256:${'a'.repeat(64)}`;
    f.config.kubernetes.generatedAppServiceAccount = 'default';
  },
};
for (const [reason, change] of Object.entries(destinationConflicts)) {
  test(`isolation rejects ${reason} before any client creation`, t => {
    const f = fixture(t);
    change(f.value);
    assert.throws(() => validateDestinations(f.value, f.value.isolation.database.url), /preflight/);
  });
}

for (const credential of ['exec', 'auth-provider', 'token-file', 'client-key', 'token', 'as']) {
  test(`dedicated kubeconfig rejects ${credential} before SDK credential loading`, t => {
    const f = fixture(t);
    f.kubeconfig.users[0].user[credential] = '/production-secret-must-not-be-read';
    f.save();
    assert.throws(() => loadDedicatedClients(f.value.isolation), /embedded fixture TLS/);
  });
}

test('dedicated kubeconfig verifies fingerprint and server and never loads defaults', t => {
  const f = fixture(t);
  const k8s = require('@kubernetes/client-node');
  t.mock.method(k8s.KubeConfig.prototype, 'loadFromDefault', () => assert.fail('ambient kubeconfig loaded'));
  t.mock.method(k8s.KubeConfig.prototype, 'loadFromCluster', () => assert.fail('ambient cluster loaded'));
  assert.equal(loadDedicatedClients(f.value.isolation).kc.getCurrentCluster().server, f.value.isolation.cluster.server);
  f.kubeconfig.clusters[0].cluster.server = 'https://production.example';
  f.save();
  assert.throws(() => loadDedicatedClients(f.value.isolation), /server mismatch/);
  f.value.isolation.kubeconfigSha256 = '0'.repeat(64);
  assert.throws(() => loadDedicatedClients(f.value.isolation), /fingerprint mismatch/);
});

for (const reason of ['old container', 'other cluster', 'wrong API port', 'wrong database port', 'host data mount', 'old data volume', 'wrong daemon']) {
  test(`local container proof rejects ${reason}`, t => {
    const f = fixture(t);
    let readDocker = f.readDocker;
    if (reason === 'old container') f.containers[0].Created = '2000-01-01';
    if (reason === 'other cluster') f.containers[0].Config.Labels['io.x-k8s.kind.cluster'] = 'production';
    if (reason === 'wrong API port') f.containers[0].NetworkSettings.Ports['6443/tcp'][0].HostPort = '6443';
    if (reason === 'wrong database port') f.containers[1].NetworkSettings.Ports['5432/tcp'][0].HostPort = '5432';
    if (reason === 'host data mount') f.containers[1].Mounts = [{ Type: 'bind', Source: '/production/postgres', RW: true }];
    if (reason === 'old data volume') {
      f.containers[1].Mounts = [{ Type: 'volume', Name: 'old' }];
      readDocker = args => args[0] === 'volume' ? [{ CreatedAt: '2000-01-01' }] : f.readDocker(args);
    }
    if (reason === 'wrong daemon') readDocker = args => args[0] === 'info' ? { ID: 'production' } : f.readDocker(args);
    assert.throws(() => verifyContainers(f.value.isolation, readDocker), /preflight/);
  });
}

for (const reason of ['external service', 'wrong Pod', 'remote registry storage', 'persistent storage', 'other endpoint', 'other EndpointSlice']) {
  test(`registry proof rejects ${reason}`, async t => {
    const f = fixture(t);
    if (reason === 'external service') f.service.spec.type = 'ExternalName';
    if (reason === 'wrong Pod') f.pod.metadata.uid = 'other';
    if (reason === 'remote registry storage') f.pod.spec.containers[0].env = [{ name: 'REGISTRY_STORAGE_S3_BUCKET', value: 'production' }];
    if (reason === 'persistent storage') f.pod.spec.volumes = [{ name: 'data', persistentVolumeClaim: { claimName: 'old' } }];
    if (reason === 'other endpoint') f.endpoint.ip = '10.244.0.99';
    if (reason === 'other EndpointSlice') f.slice.endpoints[0].addresses = ['10.244.0.99'];
    await assert.rejects(verifyRegistry(f.value.isolation, f.clients), /preflight/);
  });
}

test('preflight completes every read-only proof before allowing integration mutations', async t => {
  const f = fixture(t);
  let databaseChecks = 0;
  const dependencies = {
    loadClients: () => f.clients,
    readDocker: f.readDocker,
    verifyDatabase: async () => { databaseChecks++; },
  };
  await verifyIsolatedBuildFixture({ env: f.env, dependencies });
  assert.equal(databaseChecks, 1);
  f.clients.core.readNamespace = async () => ({ metadata: { uid: 'production' } });
  await assert.rejects(verifyIsolatedBuildFixture({ env: f.env, dependencies }), /cluster UID mismatch/);
  assert.equal(databaseChecks, 1, 'mismatched cluster cannot authorize database setup');
});

test('worker cannot change the database destination through schema options', async t => {
  const f = fixture(t);
  let databaseChecks = 0;
  const dependencies = { loadClients: () => f.clients, readDocker: f.readDocker, verifyDatabase: async () => { databaseChecks++; } };
  await assert.rejects(verifyIsolatedBuildFixture({ env: f.env, databaseUrl: `${f.env.PREVIEW_FLOW_TEST_DATABASE_URL}?host=production`, dependencies }), /schema options/);
  assert.equal(databaseChecks, 0);
  await verifyIsolatedBuildFixture({ env: f.env, databaseUrl: `${f.env.PREVIEW_FLOW_TEST_DATABASE_URL}?options=-c%20search_path%3Dexecution_1_2_3`, dependencies });
  assert.equal(databaseChecks, 1);
});

for (const mode of ['actual without manifest', 'injected with database override', 'actual with injected API']) {
  test(`worker refuses unsafe startup: ${mode}`, async t => {
    const child = fork(require.resolve('./lib/recoverable-build-child'), [], {
      execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        PATH: process.env.PATH,
        ...(mode.startsWith('injected') ? { RUN_INJECTED_BUILD_TEST: '1' } : { RUN_ISOLATED_KPACK_TEST: '1' }),
      },
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const reply = once(child, 'message');
    child.send({
      databaseUrl: 'postgresql://recovery_test:disposable@127.0.0.1:55449/fixture?host=production.example',
      config: {},
      ...(mode !== 'actual without manifest' ? { apiUrl: 'http://127.0.0.1:64439' } : {}),
    });
    const [message] = await reply;
    const expected = {
      'actual without manifest': /KPACK_RECOVERY_TEST_CONFIG required/,
      'injected with database override': /loopback API and database destinations/,
      'actual with injected API': /cannot substitute an injected API/,
    };
    assert.match(message.error, expected[mode]);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  });
}

for (const conflict of [null, 'database', 'address', 'identifier', 'start time']) {
  test(`database proof checks actual server identity: ${conflict || 'matching'}`, async t => {
    const f = fixture(t);
    const identity = {
      name: new URL(f.env.PREVIEW_FLOW_TEST_DATABASE_URL).pathname.slice(1),
      port: 5432, address: '172.18.0.3', identifier: '1234567', started: new Date(),
    };
    if (conflict === 'database') identity.name = 'production';
    if (conflict === 'address') identity.address = '172.18.0.99';
    if (conflict === 'identifier') identity.identifier = 'other';
    if (conflict === 'start time') identity.started = new Date('2000-01-01');
    let closed = false;
    class ReadOnlyClient {
      async connect() {}
      async query(sql) {
        assert.match(sql, /^SELECT current_database/);
        assert.doesNotMatch(sql, /CREATE|UPDATE|INSERT|DELETE/i);
        return { rows: [identity] };
      }
      async end() { closed = true; }
    }
    const proof = verifyDatabase(f.value.isolation, f.containers[1], f.env.PREVIEW_FLOW_TEST_DATABASE_URL, ReadOnlyClient);
    if (conflict) await assert.rejects(proof, /preflight/);
    else await proof;
    assert.equal(closed, true);
  });
}
