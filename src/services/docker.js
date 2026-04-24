const { execFile } = require('child_process');
const { promisify } = require('util');
const log = require('./logger');

const execFileAsync = promisify(execFile);

const APP_MEMORY = '256m';
const APP_CPUS = '0.5';
const SHARED_NETWORK = process.env.DOCKER_NETWORK || 'shared-web';

async function buildImage(contextPath, tag) {
  log.info('docker', 'Building image', { context: contextPath, tag });
  await execFileAsync('docker', ['build', '-t', tag, contextPath], {
    timeout: 5 * 60 * 1000,
  });
  log.info('docker', 'Image built', { tag });
}

async function runContainer(name, { image, env = {}, port, memory = APP_MEMORY, cpus = APP_CPUS }) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const args = [
    'run', '-d',
    '--name', name,
    '--hostname', name,
    '--network', SHARED_NETWORK,
    '--memory', memory,
    '--cpus', cpus,
    '--security-opt', 'no-new-privileges:true',
    '--restart', 'unless-stopped',
    '-p', `${port}`,
    ...envArgs,
    image,
  ];

  const { stdout } = await execFileAsync('docker', args, { timeout: 60000 });
  const containerId = stdout.trim();
  log.info('docker', 'Container started', { name, id: containerId.substring(0, 12) });
  return containerId;
}

async function getHostPort(nameOrId, containerPort) {
  try {
    const { stdout } = await execFileAsync('docker', [
      'port', nameOrId, `${containerPort}/tcp`,
    ], { timeout: 5000 });
    const match = stdout.trim().match(/:(\d+)$/);
    return match ? parseInt(match[1]) : null;
  } catch {
    return null;
  }
}

async function stopAndRemove(nameOrId) {
  try {
    await execFileAsync('docker', ['stop', '-t', '10', nameOrId], { timeout: 30000 }).catch(() => {});
    await execFileAsync('docker', ['rm', '-f', nameOrId], { timeout: 10000 }).catch(() => {});
    log.info('docker', 'Container removed', { nameOrId });
  } catch (err) {
    log.warn('docker', 'Failed to remove container', { nameOrId, err: err.message });
  }
}

async function getContainerStatus(nameOrId) {
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{.State.Status}}', nameOrId], {
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return 'not_found';
  }
}

async function containerExists(nameOrId) {
  const status = await getContainerStatus(nameOrId);
  return status !== 'not_found';
}

async function waitForHealthy(name, port, healthPath, maxRetries = 30) {
  log.info('docker', 'Waiting for healthcheck', { name, path: healthPath });
  for (let i = 0; i < maxRetries; i++) {
    try {
      await execFileAsync('docker', [
        'exec', name, 'wget', '-qO-', '--timeout=2',
        `http://localhost:${port}${healthPath}`,
      ], { timeout: 5000 });
      log.info('docker', 'Healthcheck passed', { name, attempt: i + 1 });
      return;
    } catch {
      await sleep(2000);
    }
  }
  throw new Error(`Healthcheck failed after ${maxRetries} attempts: ${name}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Create a named volume if it doesn't already exist. Idempotent; `docker
// volume create` no-ops when the target already exists.
async function ensureVolume(name) {
  try {
    await execFileAsync('docker', ['volume', 'create', name], { timeout: 5000 });
  } catch (err) {
    log.warn('docker', 'Failed to create volume', { name, err: err.message });
    throw err;
  }
}

async function removeVolume(name) {
  try {
    await execFileAsync('docker', ['volume', 'rm', '-f', name], { timeout: 10000 });
    log.info('docker', 'Volume removed', { name });
  } catch (err) {
    // Missing / in-use volumes aren't fatal — log and move on.
    log.warn('docker', 'Failed to remove volume', { name, err: err.message });
  }
}

module.exports = {
  execFileAsync,
  buildImage,
  runContainer,
  stopAndRemove,
  getContainerStatus,
  containerExists,
  waitForHealthy,
  getHostPort,
  ensureVolume,
  removeVolume,
};
