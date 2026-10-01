#!/usr/bin/env node
'use strict';

// Local C4 fixture provisioning only. Never uses default Docker/Kubernetes
// contexts, applies to an existing cluster, or deletes by an unverified name.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const yaml = require('js-yaml');
const { LABEL, loadDedicatedClients, verifyIsolatedBuildFixture } = require('../tests/lib/isolated-kpack-fixture');

const KIND_VERSION = '0.33.0';
const KPACK_VERSION = '0.17.2';
const CRANE_VERSION = '0.20.3';
const BUILDER_SOURCE = 'paketobuildpacks/ubuntu-noble-builder@sha256:30bfd9a0535236af8c59e7e0ca7f7b32f56094f7c509f60ba72bc99c64aca903';
const SOURCE_REVISION = '28cdfd8d72324baddeb292f4bdd8a96bb081a463';
const IMAGES = {
  node: 'kindest/node:v1.34.0',
  database: 'postgres:15.15',
  registry: 'registry:2.8.3',
};

function check(condition, message) {
  if (!condition) throw new Error(`Local fixture: ${message}`);
}

function save(state) {
  fs.writeFileSync(path.join(state.directory, 'setup-state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function environment(state) {
  return {
    PATH: process.env.PATH,
    HOME: path.join(state.directory, 'home'),
    TMPDIR: state.directory,
    DOCKER_CONFIG: path.join(state.directory, 'docker-config'),
    DOCKER_HOST: state.dockerHost,
    KIND_EXPERIMENTAL_DOCKER_NETWORK: `${state.clusterName}-network`,
    KUBECONFIG: path.join(state.directory, 'kubeconfig'),
  };
}

async function run(state, command, args, { input, timeout = 300000 } = {}) {
  const output = [];
  const logfile = fs.createWriteStream(path.join(state.directory, 'setup.log'), { flags: 'a', mode: 0o600 });
  const child = spawn(command, args, { env: environment(state), stdio: ['pipe', 'pipe', 'pipe'] });
  let bytes = 0;
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) child.kill('SIGKILL');
    else output.push(chunk);
    logfile.write(chunk);
  });
  child.stderr.on('data', chunk => logfile.write(chunk));
  if (input) child.stdin.end(input);
  else child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(
        `${path.basename(command)} exited ${code ?? signal}; see fixture setup.log`)));
    });
    return Buffer.concat(output).toString('utf8').trim();
  } finally {
    clearTimeout(timer);
    logfile.end();
  }
}

function docker(state, args, options) {
  return run(state, 'docker', ['--host', state.dockerHost, ...args], options);
}

async function daemon(state) {
  check(state.dockerHost.startsWith('unix:///') && fs.statSync(state.dockerHost.slice(7)).isSocket(), 'explicit local Docker socket required');
  const info = JSON.parse(await docker(state, ['info', '--format', '{{json .}}']));
  if (state.dockerDaemonId) check(info.ID === state.dockerDaemonId, 'Docker daemon changed');
  state.dockerDaemonId = info.ID;
  check(info.OSType === 'linux', 'local Linux container daemon required');
  save(state);
}

async function download(state, url, filename) {
  if (fs.existsSync(filename)) return;
  const temporary = `${filename}.download`;
  try {
    await run(state, 'curl', [
      '--fail', '--location', '--silent', '--show-error', '--connect-timeout', '10', '--max-time', '60', url, '-o', temporary,
    ], { timeout: 65000 });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function tools(state) {
  check(process.platform === 'darwin' && process.arch === 'arm64', 'this fixture recipe currently supports Darwin arm64 only');
  const directory = path.join(state.directory, 'tools');
  const kind = path.join(directory, 'kind');
  await download(state, `https://github.com/kubernetes-sigs/kind/releases/download/v${KIND_VERSION}/kind-darwin-arm64`, kind);
  await download(state, `https://github.com/kubernetes-sigs/kind/releases/download/v${KIND_VERSION}/kind-darwin-arm64.sha256sum`, `${kind}.sha256sum`);
  const digest = createHash('sha256').update(fs.readFileSync(kind)).digest('hex');
  check(digest === fs.readFileSync(`${kind}.sha256sum`, 'utf8').split(/\s/)[0], 'kind checksum mismatch');
  fs.chmodSync(kind, 0o700);
  // Copy the already installed client; never install tooling globally.
  if (!fs.existsSync(path.join(directory, 'kubectl'))) fs.copyFileSync('/opt/homebrew/bin/kubectl', path.join(directory, 'kubectl'));
  fs.chmodSync(path.join(directory, 'kubectl'), 0o700);
  const archive = path.join(directory, 'crane.tar.gz');
  await download(state, `https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Darwin_arm64.tar.gz`, archive);
  const sums = path.join(directory, 'crane-checksums.txt');
  await download(state, `https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/checksums.txt`, sums);
  const expected = fs.readFileSync(sums, 'utf8').split('\n').find(line => line.endsWith('go-containerregistry_Darwin_arm64.tar.gz'))?.split(/\s/)[0];
  check(createHash('sha256').update(fs.readFileSync(archive)).digest('hex') === expected, 'crane checksum mismatch');
  if (!fs.existsSync(path.join(directory, 'crane'))) await run(state, 'tar', ['-xzf', archive, '-C', directory, 'crane']);
  await download(state, `https://github.com/buildpacks-community/kpack/releases/download/v${KPACK_VERSION}/release-${KPACK_VERSION}.yaml`, path.join(state.directory, 'kpack-release.yaml'));
}

async function image(state, key) {
  if (state.images?.[key]) return state.images[key];
  console.log(`[fixture] pulling ${IMAGES[key]}`);
  await docker(state, ['pull', IMAGES[key]]);
  const [value] = JSON.parse(await docker(state, ['image', 'inspect', IMAGES[key]]));
  const ref = value.RepoDigests[0];
  check(ref?.includes('@sha256:'), 'resolved image digest required');
  state.images = { ...state.images, [key]: ref };
  save(state);
  return ref;
}

async function network(state) {
  if (state.networkId) {
    const [value] = JSON.parse(await docker(state, ['network', 'inspect', state.networkId]));
    check(value.Name === `${state.clusterName}-network` && value.Labels?.[LABEL] === state.fixtureId, 'network ownership changed');
    return;
  }
  state.networkId = await docker(state, ['network', 'create', '--label', `${LABEL}=${state.fixtureId}`, `${state.clusterName}-network`]);
  save(state);
}

async function recordNodes(state) {
  const ids = (await docker(state, ['ps', '-aq', '--filter', `label=io.x-k8s.kind.cluster=${state.clusterName}`])).split('\n').filter(Boolean);
  if (!ids.length) return [];
  const values = JSON.parse(await docker(state, ['inspect', ...ids]));
  if (state.nodes?.length) check(values.length === state.nodes.length
    && values.every(value => state.nodes.some(node => node.id === value.Id)), 'kind node identity changed; do not adopt a successor');
  for (const value of values) {
    check(value.Config.Labels?.['io.x-k8s.kind.cluster'] === state.clusterName
      && new Date(value.Created) >= new Date(state.createdAt)
      && value.Name === `/${state.clusterName}-control-plane`
      && value.Config.Image === state.images.node
      && value.NetworkSettings.Networks?.[`${state.clusterName}-network`]?.NetworkID === state.networkId,
    'kind node ownership cannot be established');
  }
  state.nodes = values.map(value => ({ id: value.Id, name: value.Name, volumes: value.Mounts.filter(m => m.Type === 'volume').map(m => m.Name) }));
  save(state);
  return values;
}

async function cluster(state) {
  const nodeImage = await image(state, 'node');
  let nodes = await recordNodes(state);
  if (!nodes.length) {
    console.log('[fixture] creating dedicated kind cluster');
    const filename = path.join(state.directory, 'kind-config.yaml');
    fs.writeFileSync(filename, yaml.dump({ kind: 'Cluster', apiVersion: 'kind.x-k8s.io/v1alpha4',
      networking: { apiServerAddress: '127.0.0.1' }, nodes: [{ role: 'control-plane' }] }));
    try {
      await run(state, path.join(state.directory, 'tools/kind'), ['create', 'cluster', '--name', state.clusterName,
        '--image', nodeImage, '--config', filename, '--kubeconfig', path.join(state.directory, 'kubeconfig'), '--wait', '180s']);
    } finally {
      nodes = await recordNodes(state);
    }
  }
  check(nodes.length === 1, 'one fresh control-plane node required');
  const source = fs.readFileSync(path.join(state.directory, 'kubeconfig'), 'utf8');
  const raw = yaml.load(source);
  const server = raw.clusters[0].cluster.server;
  const bindings = nodes[0].NetworkSettings.Ports['6443/tcp'];
  check(bindings.length === 1 && bindings[0].HostIp === '127.0.0.1' && bindings[0].HostPort === new URL(server).port,
    'new API server must be owned by the recorded local node');
  state.kubeconfigPath = path.join(state.directory, 'kubeconfig');
  state.kubeconfigSha256 = createHash('sha256').update(source).digest('hex');
  state.cluster = { name: state.clusterName, context: `kind-${state.clusterName}`, server, nodeContainerIds: nodes.map(n => n.Id) };
  const clients = loadDedicatedClients(state);
  const system = await clients.core.readNamespace({ name: 'kube-system' });
  if (state.clusterUid) check(system.metadata.uid === state.clusterUid, 'cluster UID changed');
  state.clusterUid = system.metadata.uid;
  state.cluster.uid = system.metadata.uid;
  save(state);
  return clients;
}

async function kubectl(state, args, options) {
  // Recheck the explicit local server identity before every bootstrap mutation.
  const clients = loadDedicatedClients(state);
  check((await clients.core.readNamespace({ name: 'kube-system' })).metadata.uid === state.clusterUid, 'bootstrap cluster identity changed');
  return run(state, path.join(state.directory, 'tools/kubectl'), [
    '--kubeconfig', state.kubeconfigPath, '--context', state.cluster.context, '--cache-dir', path.join(state.directory, 'kubectl-cache'), ...args,
  ], options);
}

async function database(state) {
  const ref = await image(state, 'database');
  if (!state.database) {
    const password = randomBytes(24).toString('hex');
    const dbName = `preview_recovery_${state.fixtureId.replaceAll('-', '')}`;
    const filename = path.join(state.directory, 'postgres.env');
    fs.writeFileSync(filename, `POSTGRES_USER=recovery_test\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${dbName}\n`, { mode: 0o600 });
    console.log('[fixture] creating disposable PostgreSQL');
    const id = await docker(state, ['run', '-d', '--label', `${LABEL}=${state.fixtureId}`, '--name', `${state.clusterName}-postgres`,
      '--network', `${state.clusterName}-network`, '--tmpfs', '/var/lib/postgresql/data:rw',
      '-p', '127.0.0.1::5432', '--env-file', filename, ref, 'postgres', '-c', 'max_prepared_transactions=10']);
    state.database = { containerId: id, image: ref, password, name: dbName };
    save(state);
  }
  const [value] = JSON.parse(await docker(state, ['inspect', state.database.containerId]));
  check(value.Config.Labels?.[LABEL] === state.fixtureId && value.Name === `/${state.clusterName}-postgres`
    && value.Config.Image === ref, 'database container ownership changed');
  let identifier;
  for (let delivery = 0; delivery < 30; delivery++) {
    try {
      identifier = await docker(state, ['exec', value.Id, 'psql', '-U', 'recovery_test', '-d', state.database.name, '-Atc', 'SELECT system_identifier FROM pg_control_system()']);
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  check(identifier, 'new PostgreSQL did not become ready');
  const port = value.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  state.database.url = `postgresql://recovery_test:${state.database.password}@127.0.0.1:${port}/${state.database.name}`;
  if (state.database.systemIdentifier) check(identifier === state.database.systemIdentifier, 'database storage identity changed');
  state.database.systemIdentifier = identifier;
  save(state);
}

async function registry(state, clients) {
  const ref = await image(state, 'registry');
  const ns = `preview-recovery-test-${state.fixtureId}`;
  const labels = { [LABEL]: state.fixtureId };
  if (state.namespace) {
    check((await clients.core.readNamespace({ name: ns })).metadata.uid === state.namespace.uid, 'namespace successor must not be changed');
    check((await clients.core.readNamespacedService({ namespace: ns, name: 'registry' })).metadata.uid === state.registry.serviceUid, 'registry service successor must not be changed');
    check((await clients.core.readNamespacedPod({ namespace: ns, name: 'registry' })).metadata.uid === state.registry.podUid, 'registry Pod successor must not be changed');
  }
  const objects = [
    { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } },
    { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'recovery-builder', namespace: ns, labels } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'registry', namespace: ns, labels },
      spec: { selector: { ...labels, app: 'registry' }, ports: [{ port: 5000, targetPort: 5000 }] } },
    { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'registry', namespace: ns, labels: { ...labels, app: 'registry' } },
      spec: { automountServiceAccountToken: false, containers: [{ name: 'registry', image: ref, ports: [{ containerPort: 5000 }],
        readinessProbe: { httpGet: { path: '/v2/', port: 5000 } },
        volumeMounts: [{ name: 'data', mountPath: '/var/lib/registry' }] }], volumes: [{ name: 'data', emptyDir: {} }] } },
  ];
  const filename = path.join(state.directory, 'registry.yaml');
  fs.writeFileSync(filename, objects.map(object => yaml.dump(object)).join('---\n'));
  console.log('[fixture] creating dedicated registry');
  await kubectl(state, ['apply', '-f', filename]);
  await kubectl(state, ['wait', '--for=condition=Ready', 'pod/registry', '-n', ns, '--timeout=180s']);
  const namespace = await clients.core.readNamespace({ name: ns });
  const service = await clients.core.readNamespacedService({ namespace: ns, name: 'registry' });
  const pod = await clients.core.readNamespacedPod({ namespace: ns, name: 'registry' });
  state.namespace = { name: ns, uid: namespace.metadata.uid };
  state.registry = { host: `registry.${ns}.svc.cluster.local:5000`, serviceUid: service.metadata.uid, podUid: pod.metadata.uid, image: ref };
  // Only this fresh node is modified. containerd needs the service DNS name and
  // HTTP endpoint; no host /etc/hosts or daemon deployment configuration changes.
  await docker(state, ['exec', state.nodes[0].id, 'sh', '-c',
    'printf "%s\\n" "$1" >> /etc/hosts; mkdir -p "$2"; printf "%s\\n" "$3" > "$2/hosts.toml"', 'fixture',
    `${service.spec.clusterIP} registry.${ns}.svc.cluster.local`,
    `/etc/containerd/certs.d/${state.registry.host}`,
    `server = "http://${state.registry.host}"\n[host."http://${state.registry.host}"]\n  capabilities = ["pull", "resolve"]`]);
  const containerd = await docker(state, ['exec', state.nodes[0].id, 'cat', '/etc/containerd/config.toml']);
  if (!containerd.includes('config_path = "/etc/containerd/certs.d"')) {
    check(!containerd.includes('config_path'), 'unexpected containerd registry configuration');
    await docker(state, ['exec', state.nodes[0].id, 'sh', '-c',
      'printf "%s\\n" "$1" >> /etc/containerd/config.toml; systemctl restart containerd', 'fixture',
      '[plugins."io.containerd.grpc.v1.cri".registry]\n  config_path = "/etc/containerd/certs.d"']);
  }
  save(state);
}

async function withRegistryForward(state, clients, callback) {
  const pod = await clients.core.readNamespacedPod({ namespace: state.namespace.name, name: 'registry' });
  check(pod.metadata.uid === state.registry.podUid, 'registry successor must not be seeded');
  const logfile = fs.createWriteStream(path.join(state.directory, 'registry-forward.log'), { flags: 'a' });
  const child = spawn(path.join(state.directory, 'tools/kubectl'), [
    '--kubeconfig', state.kubeconfigPath, '--context', state.cluster.context,
    '--cache-dir', path.join(state.directory, 'kubectl-cache'), 'port-forward', '--address', '127.0.0.1',
    '-n', state.namespace.name, 'pod/registry', ':5000',
  ], { env: environment(state), stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      logfile.write(chunk);
      text += chunk;
      const match = text.match(/Forwarding from 127\.0\.0\.1:([0-9]+) -> 5000/);
      if (match) resolve(match[1]);
    });
    child.stderr.on('data', chunk => logfile.write(chunk));
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Registry forwarding exited ${code}`)));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
  try {
    const port = await ready;
    return await callback(port);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    logfile.end();
  }
}

async function seedBuilder(state, clients) {
  if (state.builderImage && state.builderSeedVersion === 2) return;
  return withRegistryForward(state, clients, async port => {
    const crane = path.join(state.directory, 'tools/crane');
    if (!state.builderSource) {
      state.builderSource = BUILDER_SOURCE;
      save(state);
    }
    const repo = `preview-recovery-${state.fixtureId}/builder`;
    console.log('[fixture] seeding pinned ARM64 builder into dedicated registry');
    await run(state, crane, ['copy', '--platform', 'linux/arm64', state.builderSource, `127.0.0.1:${port}/${repo}:seed`], { timeout: 540000 });
    const digest = await run(state, crane, ['digest', `127.0.0.1:${port}/${repo}:seed`]);
    check(state.builderSource.endsWith(`@${digest}`), 'local builder digest differs from pinned source');
    // Fixture-only image configuration: enable HTTP for precisely this local
    // registry. Production recipes and registry security settings are unchanged.
    await run(state, crane, ['mutate', `127.0.0.1:${port}/${repo}:seed`,
      '--env', `CNB_INSECURE_REGISTRIES=${state.registry.host}`, '-t', `127.0.0.1:${port}/${repo}:fixture`]);
    const localDigest = await run(state, crane, ['digest', `127.0.0.1:${port}/${repo}:fixture`]);
    const localConfig = JSON.parse(await run(state, crane, ['config', `127.0.0.1:${port}/${repo}@${localDigest}`]));
    check(localConfig.architecture === 'arm64' && localConfig.os === 'linux', 'ARM64 Linux builder required');
    check(localConfig.config.Env.includes(`CNB_INSECURE_REGISTRIES=${state.registry.host}`), 'fixture registry permission missing');
    state.builderImage = `${state.registry.host}/${repo}@${localDigest}`;
    state.builderSeedVersion = 2;
    save(state);
  });
}

async function seedRuntime(state, clients) {
  if (state.runtimeImage) return;
  return withRegistryForward(state, clients, async port => {
    const crane = path.join(state.directory, 'tools/crane');
    if (!state.runtimeSource) {
      const digest = await run(state, crane, ['digest', '--platform', 'linux/arm64', 'node:22.15.0-alpine']);
      check(/^sha256:[a-f0-9]{64}$/.test(digest), 'runtime source digest required');
      state.runtimeSource = `node@${digest}`;
      save(state);
    }
    const repo = `preview-recovery-${state.fixtureId}/images/demo`;
    console.log('[fixture] seeding dedicated non-root runtime image');
    await run(state, crane, ['copy', '--platform', 'linux/arm64', state.runtimeSource, `127.0.0.1:${port}/${repo}:runtime-source`]);
    await run(state, crane, ['mutate', `127.0.0.1:${port}/${repo}:runtime-source`, '--user', '1000:1000', '-t', `127.0.0.1:${port}/${repo}:runtime`]);
    const digest = await run(state, crane, ['digest', `127.0.0.1:${port}/${repo}:runtime`]);
    state.runtimeImage = `${state.registry.host}/${repo}@${digest}`;
    save(state);
  });
}

async function seedDatabaseRuntime(state, clients) {
  if (state.databaseRuntimeImage) return;
  const layer = path.join(state.directory, 'database-runtime-layer');
  const modules = path.join(layer, 'opt/evidence/node_modules');
  const copied = new Set();

  function copyPackage(name) {
    if (copied.has(name)) return;
    check(/^[a-z0-9-]+$/.test(name), 'unexpected test dependency name');
    copied.add(name);
    const source = path.resolve(__dirname, '../node_modules', name);
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    fs.cpSync(source, path.join(modules, name), { recursive: true });
    for (const dependency of Object.keys(pkg.dependencies || {})) copyPackage(dependency);
  }

  fs.mkdirSync(modules, { recursive: true });
  copyPackage('pg');
  // Test-only pure-JS database client. No production image or registry changes.
  const archive = path.join(state.directory, 'database-runtime-layer.tar');
  await run(state, 'tar', ['-cf', archive, '-C', layer, 'opt']);
  await withRegistryForward(state, clients, async port => {
    const crane = path.join(state.directory, 'tools/crane');
    const repo = `preview-recovery-${state.fixtureId}/images/demo`;
    const baseDigest = state.runtimeImage.split('@')[1];
    await run(state, crane, ['append', '-b', `127.0.0.1:${port}/${repo}@${baseDigest}`,
      '-f', archive, '-t', `127.0.0.1:${port}/${repo}:database-runtime`]);
    const digest = await run(state, crane, ['digest', `127.0.0.1:${port}/${repo}:database-runtime`]);
    state.databaseRuntimeImage = `${state.registry.host}/${repo}@${digest}`;
    save(state);
  });
}

async function controllers(state) {
  console.log('[fixture] installing pinned kpack into disposable cluster');
  const objects = [];
  yaml.loadAll(fs.readFileSync(path.join(state.directory, 'kpack-release.yaml'), 'utf8'), object => { if (object) objects.push(object); });
  const crds = objects.filter(object => object.kind === 'CustomResourceDefinition');
  const crdFile = path.join(state.directory, 'kpack-crds.yaml');
  fs.writeFileSync(crdFile, crds.map(object => yaml.dump(object)).join('---\n'));
  await kubectl(state, ['apply', '-f', crdFile]);
  for (const crd of crds) {
    await kubectl(state, ['wait', '--for=condition=Established', `crd/${crd.metadata.name}`, '--timeout=60s']);
  }
  await kubectl(state, ['apply', '-f', path.join(state.directory, 'kpack-release.yaml')]);
  for (const name of ['kpack-controller', 'kpack-webhook']) {
    await kubectl(state, ['rollout', 'status', `deployment/${name}`, '-n', 'kpack', '--timeout=180s']);
  }
}

async function manifest(state) {
  if (!state.revision) {
    state.repoUrl = 'https://github.com/heroku/node-js-sample';
    const source = path.join(state.directory, 'source');
    if (!fs.existsSync(source)) await run(state, 'git', ['init', source]);
    await run(state, 'git', ['-C', source, '-c', 'credential.helper=', 'fetch', '--depth', '1', state.repoUrl, SOURCE_REVISION]);
    await run(state, 'git', ['-C', source, 'checkout', '--detach', 'FETCH_HEAD']);
    state.revision = await run(state, 'git', ['-C', source, 'rev-parse', 'HEAD']);
    check(state.revision === SOURCE_REVISION, 'pinned source revision required');
    save(state);
  }
  const prefix = `${state.registry.host}/preview-recovery-${state.fixtureId}`;
  const fixture = {
    isolation: {
      version: 1,
      fixtureId: state.fixtureId,
      createdAt: state.createdAt,
      directory: state.directory,
      dockerHost: state.dockerHost,
      dockerDaemonId: state.dockerDaemonId,
      kubeconfigPath: state.kubeconfigPath,
      kubeconfigSha256: state.kubeconfigSha256,
      cluster: state.cluster,
      namespace: state.namespace,
      database: {
        url: state.database.url,
        containerId: state.database.containerId,
        image: state.database.image,
        systemIdentifier: state.database.systemIdentifier,
      },
      registry: state.registry,
    },
    repoUrl: state.repoUrl,
    revision: state.revision,
    runScript: null,
    runtimeImage: state.runtimeImage,
    databaseRuntimeImage: state.databaseRuntimeImage,
    config: {
      appRuntime: 'kubernetes',
      kubernetes: {
        buildEngine: 'kpack',
        buildNamespace: state.namespace.name,
        appNamespace: state.namespace.name,
        buildServiceAccount: 'recovery-builder',
        generatedAppServiceAccount: 'recovery-builder',
        builderImage: state.builderImage,
        repositoryPrefix: `${prefix}/images`,
        cacheRepositoryPrefix: `${prefix}/cache`,
        nodeVersion: '22.*',
        activeDeadlineSeconds: 900,
      },
    },
  };
  const filename = path.join(state.directory, 'fixture.json');
  fs.writeFileSync(filename, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  await verifyIsolatedBuildFixture({ env: {
    PATH: process.env.PATH, TMPDIR: os.tmpdir(),
    KPACK_RECOVERY_TEST_CONFIG: filename, PREVIEW_FLOW_TEST_DATABASE_URL: state.database.url,
  } });
  state.phase = 'preflight-passed';
  save(state);
  console.log(`[fixture] full isolation preflight passed: ${filename}`);
}

async function setup(state) {
  check(state.phase !== 'torn-down', 'retired fixture cannot be reused; initialize a fresh fixture');
  const age = Date.now() - Date.parse(state.createdAt);
  check(Number.isFinite(age) && age >= 0 && age < 24 * 3600000, 'setup requires a fresh fixture creation boundary');
  await daemon(state);
  await tools(state);
  await network(state);
  const clients = await cluster(state);
  await database(state);
  await registry(state, clients);
  await seedBuilder(state, clients);
  await seedRuntime(state, clients);
  await seedDatabaseRuntime(state, clients);
  await controllers(state);
  await manifest(state);
}

function verifyDeletionInventory(state, containers, net, volumes, consumers) {
  const ids = [...(state.nodes || []).map(node => node.id), ...(state.database ? [state.database.containerId] : [])];
  for (const container of containers) {
    const node = state.nodes?.find(value => value.id === container.Id);
    check(ids.includes(container.Id) && new Date(container.Created) >= new Date(state.createdAt),
      'container deletion ownership mismatch');
    if (node) {
      check(container.Name === node.name
        && container.Config.Labels?.['io.x-k8s.kind.cluster'] === state.clusterName
        && container.Config.Image === state.images.node, 'container deletion ownership mismatch');
    } else {
      check(container.Config.Labels?.[LABEL] === state.fixtureId
        && container.Name === `/${state.clusterName}-postgres`
        && container.Config.Image === state.database.image, 'container deletion ownership mismatch');
    }

    for (const mount of container.Mounts || []) {
      if (mount.Type !== 'volume') continue;
      const volume = volumes.find(value => value.Name === mount.Name);
      check(node?.volumes.includes(mount.Name) && volume
        && new Date(volume.CreatedAt) >= new Date(state.createdAt)
        && consumers[mount.Name]?.every(id => ids.includes(id)), 'volume deletion ownership mismatch');
    }
  }
  if (net) {
    check(net.Id === state.networkId && net.Labels?.[LABEL] === state.fixtureId
      && net.Name === `${state.clusterName}-network`
      && Object.keys(net.Containers || {}).every(id => ids.includes(id)),
    'network has changed or contains an unrelated owner');
  }
}

async function teardown(state) {
  await daemon(state);
  // Inventory by immutable IDs. Missing IDs may result from interrupted teardown;
  // replacements with the same name are never adopted or deleted.
  const ids = [...(state.nodes || []).map(node => node.id), ...(state.database ? [state.database.containerId] : [])];
  const live = new Set((await docker(state, ['ps', '-aq', '--no-trunc'])).split('\n'));
  const present = ids.filter(id => live.has(id));
  const containers = present.length ? JSON.parse(await docker(state, ['inspect', ...present])) : [];
  // Inspect only recorded resources that remain present; interrupted teardown
  // is repeatable without adopting a replacement by name.
  const volumes = [];
  const consumers = {};
  for (const container of containers) {
    for (const mount of container.Mounts || []) {
      if (mount.Type !== 'volume') continue;
      volumes.push(...JSON.parse(await docker(state, ['volume', 'inspect', mount.Name])));
      consumers[mount.Name] = (await docker(state, ['ps', '-aq', '--no-trunc', '--filter', `volume=${mount.Name}`])).split('\n').filter(Boolean);
    }
  }
  const netIds = (await docker(state, ['network', 'ls', '-q', '--no-trunc'])).split('\n');
  const [net] = state.networkId && netIds.includes(state.networkId)
    ? JSON.parse(await docker(state, ['network', 'inspect', state.networkId])) : [];
  verifyDeletionInventory(state, containers, net, volumes, consumers);
  for (const container of containers) {
    await docker(state, ['rm', '-f', '-v', container.Id]);
    state.removedContainerIds = [...(state.removedContainerIds || []), container.Id];
    save(state);
  }
  if (net) await docker(state, ['network', 'rm', net.Id]);
  state.phase = 'torn-down';
  save(state);
  console.log('[fixture] verified local containers/network removed; evidence retained');
}

async function integration(state, mode = 'test') {
  const filename = path.join(state.directory, 'fixture.json');
  const fixture = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const env = {
    PATH: process.env.PATH, TMPDIR: os.tmpdir(),
    KPACK_RECOVERY_TEST_CONFIG: filename, PREVIEW_FLOW_TEST_DATABASE_URL: fixture.isolation.database.url,
  };
  await verifyIsolatedBuildFixture({ env });
  const option = { 'test-runtime': '--runtime', 'test-release': '--release' }[mode];
  const child = spawn(process.execPath, ['scripts/test-recoverable-preview-build.js', ...(option ? [option] : [])], { env, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  state.lastIntegration = { completedAt: new Date().toISOString(), exitCode: code };
  save(state);
  check(code === 0, 'actual-resource scenarios failed');
}

async function main() {
  const [mode, argument] = process.argv.slice(2);
  if (mode === 'init') {
    check(argument?.startsWith('unix:///'), 'init requires the explicit local Docker socket URL');
    const fixtureId = randomUUID();
    const directory = path.join(os.tmpdir(), `preview-recovery-test-${fixtureId}`);
    const state = { version: 1, fixtureId, createdAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
      directory, dockerHost: argument, clusterName: `c4-preview-${fixtureId}`, resources: [] };
    fs.mkdirSync(directory, { mode: 0o700 });
    for (const name of ['tools', 'home', 'docker-config']) fs.mkdirSync(path.join(directory, name));
    save(state);
    console.log(directory);
    return;
  }
  check(['setup', 'teardown', 'test', 'test-runtime', 'test-release'].includes(mode) && argument,
    'use init <local-socket>, setup/test/test-runtime/test-release/teardown <directory>');
  const directory = fs.realpathSync(argument);
  const state = JSON.parse(fs.readFileSync(path.join(directory, 'setup-state.json'), 'utf8'));
  check(state.version === 1 && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(state.fixtureId)
    && state.clusterName === `c4-preview-${state.fixtureId}`, 'fixture journal identity mismatch');
  check(fs.realpathSync(state.directory) === directory && path.basename(directory) === `preview-recovery-test-${state.fixtureId}`
    && directory.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`), 'fixture directory identity mismatch');
  try {
    if (mode === 'setup') await setup(state);
    else if (['test', 'test-runtime', 'test-release'].includes(mode)) await integration(state, mode);
    else await teardown(state);
  } catch (error) {
    state.lastError = error.message;
    save(state);
    throw error;
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { verifyDeletionInventory };
