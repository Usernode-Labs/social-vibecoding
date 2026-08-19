const docker = require('./docker');
const caddy = require('./caddy');
const kubernetes = require('./kubernetes');

function mode(config) {
  const value = config?.appRuntime || process.env.APP_RUNTIME || 'docker';
  if (!['docker', 'kubernetes'].includes(value)) throw new Error(`Unsupported APP_RUNTIME=${value}`);
  return value;
}

async function build(config, { app, revision, environment, sessionId, sourceDir, dockerImage }) {
  if (mode(config) === 'docker') {
    await docker.buildImage(sourceDir, dockerImage);
    return { runtimeKind: 'docker', imageRef: dockerImage, buildRef: null };
  }
  return kubernetes.createBuild(config, { app, revision, environment, sessionId });
}

async function deploy(config, {
  app, environment, sessionId, imageRef, env, dockerName,
  port = 3000, memory, cpus, labels,
}) {
  if (mode(config) === 'docker') {
    await docker.stopAndRemove(dockerName).catch(() => {});
    await docker.runContainer(dockerName, {
      image: imageRef, env, port, memory, cpus, labels,
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
  return kubernetes.deployApplication(config, { app, environment, sessionId, imageRef, env });
}

async function status(config, ref) {
  if ((ref.runtimeKind || mode(config)) === 'docker') return docker.getContainerStatus(ref.runtimeName);
  return kubernetes.getApplicationStatus(config, ref.runtimeName);
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

module.exports = { mode, build, deploy, status, logs, restart, remove };
