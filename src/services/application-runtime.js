const docker = require('./docker');
const caddy = require('./caddy');
const kubernetes = require('./kubernetes');

function mode(config) {
  const value = config?.appRuntime || process.env.APP_RUNTIME || 'docker';
  if (!['docker', 'kubernetes'].includes(value)) throw new Error(`Unsupported APP_RUNTIME=${value}`);
  return value;
}

function productionRef(config, app) {
  const runtimeKind = app.runtime_kind || mode(config);
  return { runtimeKind, runtimeName: app.runtime_name || (runtimeKind === 'kubernetes'
    ? kubernetes.appResourceName(app, 'production') : `usernode-app-${app.slug}`) };
}

// `onProgress(image)` reports the image build as it goes, in the runtime's
// own terms: kpack lifecycle phases with their times on kubernetes, the
// builder's step counter on docker. See each module for the shape.
async function build(config, { app, revision, environment, sessionId, sourceDir, dockerImage, onProgress = null }) {
  if (mode(config) === 'docker') {
    await docker.buildImage(sourceDir, dockerImage, {}, { onProgress });
    return { runtimeKind: 'docker', imageRef: dockerImage, buildRef: null };
  }
  return kubernetes.createBuild(config, { app, revision, environment, sessionId, sourceDir, onProgress });
}

async function cleanupFailedBuilds(config) {
  if (mode(config) !== 'kubernetes') return { examined: 0, deleted: 0 };
  return kubernetes.deleteFailedBuilds(config);
}

// The short, DNS-resolvable identity a container is reachable by, given the
// (possibly over-long) name it is created with.
//
// Container names are not bounded: `usernode-staging-<slug>--<sessionId>` is
// 66 bytes for a 43-character slug, and 63 is the hard limit on a DNS label —
// so above that, Docker's embedded DNS cannot answer for the name at all and
// every peer (the capture browser, Caddy) gets NXDOMAIN. The alias is what
// they resolve instead.
//
// Staging is UNCONDITIONAL: `usernode-staging-s<sessionId>` is ~25 bytes for
// any app, contains no slug, and is derivable by regex from the request host,
// which is what lets Caddy's map row target it without knowing the slug's
// length. Making it conditional on the name being long would mean two
// different upstreams for Caddy to choose between, decided by a fact the
// proxy cannot see.
//
// Production is conditional: `usernode-app-<slug>` is the name a decade of
// operator muscle memory, `docker logs` and the Caddyfile all use, and it is
// already resolvable whenever it fits. Only when it does not do we hang the
// clamped hostname on it as a second name.
function dnsAlias({ environment, sessionId, dockerName }) {
  if (environment !== 'production') {
    return sessionId ? `usernode-staging-s${sessionId}` : null;
  }
  const name = String(dockerName || '');
  return name.length > 63 ? docker.containerHostname(name) : null;
}

async function deploy(config, {
  app, environment, sessionId, imageRef, env, dockerName,
  port = 3000, memory, cpus, labels,
}) {
  if (mode(config) === 'docker') {
    await docker.stopAndRemove(dockerName).catch(() => {});
    const alias = dnsAlias({ environment, sessionId, dockerName });
    await docker.runContainer(dockerName, {
      image: imageRef, env, port, memory, cpus, labels,
      aliases: alias ? [alias] : [],
    });
    await docker.waitForHealthy(dockerName, port, '/health');
    const hostname = environment === 'production'
      ? caddy.productionHostname(app.slug)
      : caddy.stagingHostname(app.slug, `s${sessionId}`);
    let url = `https://${hostname}`;
    const isLocal = process.env.NODE_ENV === 'development' || process.env.USERNODE_LOCAL_DEV === '1';
    if (isLocal) {
      const hostPort = await docker.getHostPort(dockerName, port);
      if (hostPort) url = `http://localhost:${hostPort}`;
    }
    // Docker returns the container's full ID from `docker run`, but that ID
    // is not a name Docker's embedded DNS resolves from peer containers.
    // `runtimeName` is used both for later Docker commands (which accept the
    // stable --name value) and as the proposal-check capture hostname, so
    // persist the deterministic name rather than the opaque run result.
    return { runtimeKind: 'docker', runtimeName: dockerName, imageRef, hostname, url };
  }
  return kubernetes.deployApplication(config, { app, environment, sessionId, imageRef, env, cpus, labels });
}

async function inspect(config, ref) {
  if ((ref.runtimeKind || mode(config)) === 'docker') return docker.inspectContainer(ref.runtimeName);
  return kubernetes.inspectApplication(config, ref.runtimeName);
}

async function status(config, ref) {
  if ((ref.runtimeKind || mode(config)) === 'docker') return docker.getContainerStatus(ref.runtimeName);
  return kubernetes.getApplicationStatus(config, ref.runtimeName);
}

async function probeHealth(config, ref, { timeoutMs = 3000 } = {}) {
  if ((ref.runtimeKind || mode(config)) === 'docker') {
    return docker.probeHealthOnce(ref.runtimeName, 3000, '/health', { timeoutMs });
  }
  if (!ref.runtimeName) return false;
  const namespace = config?.kubernetes?.appNamespace || process.env.APP_NAMESPACE || 'social-apps';
  try {
    const response = await fetch(`http://${ref.runtimeName}.${namespace}.svc:3000/health`, {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    await response.body?.cancel();
    return response.ok;
  } catch (_) { return false; }
}

async function logs(config, ref, tailLines) {
  if ((ref.runtimeKind || mode(config)) === 'docker') {
    const { stdout, stderr } = await docker.execFileAsync('docker', ['logs', '--tail', String(tailLines || 200), ref.runtimeName]);
    return stdout + stderr;
  }
  return kubernetes.getApplicationLogs(config, ref.runtimeName, tailLines);
}

async function restart(config, ref) {
  if ((ref.runtimeKind || mode(config)) === 'docker') return docker.restartContainer(ref.runtimeName);
  return kubernetes.restartApplication(config, ref.runtimeName);
}

async function remove(config, ref, options = {}) {
  if (!ref?.runtimeName) return;
  if ((ref.runtimeKind || mode(config)) === 'docker') return docker.stopAndRemove(ref.runtimeName, options);
  await kubernetes.deleteApplication(config, ref.runtimeName);
  if (options.deleteBuilds && ref.appId != null) await kubernetes.deleteBuilds(config, ref.appId);
}

module.exports = {
  mode, productionRef, build, cleanupFailedBuilds, deploy, dnsAlias, status, inspect, probeHealth, logs, restart, remove,
};
