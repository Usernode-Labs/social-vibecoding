const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const log = require('./logger');

const execFileAsync = promisify(execFile);

// Run `docker exec -i <container> sh` with `script` fed on stdin. Used to
// materialize files inside a container without putting their contents on
// the docker CLI's argv/env: Linux caps a single argv or envp string at
// 128 KiB (MAX_ARG_STRLEN), so oversized values kill the spawn with
// E2BIG before the exec even exists. Content travels base64-inlined
// within the script, which also keeps it out of `ps` and `docker
// inspect`.
async function execShellStdin(containerName, script, { timeoutMs = 20000, label = 'execShellStdin' } = {}) {
  await new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', '-i', containerName, 'sh'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`${label}: timed out`));
    }, timeoutMs);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`${label}: docker exec exited ${code}: ${stderr.slice(0, 300)}`));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

const APP_MEMORY = '256m';
const APP_CPUS = '0.5';
const SHARED_NETWORK = process.env.DOCKER_NETWORK || 'shared-web';

async function buildImage(contextPath, tag, buildArgs = {}) {
  const buildArgFlags = Object.entries(buildArgs).flatMap(
    ([k, v]) => ['--build-arg', `${k}=${v}`]
  );
  log.info('docker', 'Building image', { context: contextPath, tag, buildArgs });
  try {
    await execFileAsync(
      'docker',
      ['build', ...buildArgFlags, '-t', tag, contextPath],
      // Generous maxBuffer so a chatty build still yields a usable log
      // tail instead of a bare "maxBuffer exceeded" error (#416).
      { timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }
    );
  } catch (err) {
    // Attach the build output tail so deploy callers can persist a
    // diagnosable apps.last_failure record (see services/deploy-failure).
    const deployFailure = require('./deploy-failure');
    err.buildFailed = true;
    err.buildLog = deployFailure.truncateLog(
      `${err.stderr || ''}\n${err.stdout || ''}`
    );
    throw err;
  }
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

  try {
    const { stdout } = await execFileAsync('docker', args, { timeout: 60000 });
    const containerId = stdout.trim();
    log.info('docker', 'Container started', { name, id: containerId.substring(0, 12) });
    return containerId;
  } catch (err) {
    // Defense-in-depth against a name collision: if a container with this
    // name still exists (a prior `stopAndRemove` raced, an aborted rebuild
    // left a half-removed container, or two rebuild paths interleaved),
    // docker fails with "The container name "/x" is already in use". The
    // root-cause serialization lives in staging.rebuildProduction; this
    // retry just makes runContainer self-healing so a stray name never
    // bricks a deploy. Force-remove and try exactly once more.
    const msg = String((err && (err.stderr || err.message)) || '');
    if (/is already in use/i.test(msg)) {
      log.warn('docker', 'Container name in use; removing stale container and retrying', { name });
      await execFileAsync('docker', ['rm', '-f', name], { timeout: 10000 }).catch(() => {});
      const { stdout } = await execFileAsync('docker', args, { timeout: 60000 });
      const containerId = stdout.trim();
      log.info('docker', 'Container started (after name-conflict retry)', {
        name, id: containerId.substring(0, 12),
      });
      return containerId;
    }
    throw err;
  }
}

// Run a one-shot container in the foreground and return its stdout/stderr.
// Used by the visuals capture step (src/services/visuals.js): unlike
// runContainer above this is NOT detached, NOT restarted, and removes
// itself on exit (--rm). `maxBuffer` defaults high because the capture
// container streams base64-encoded media on stdout. On any error
// (including the exec timeout, which kills the docker CLIENT but can
// leave the container running) we force-remove the named container so a
// hung capture never leaks.
async function runOneShot(name, {
  image, env = {}, memory = '1g', cpus = '1',
  timeoutMs = 240000, maxBuffer = 128 * 1024 * 1024,
}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const args = [
    'run', '--rm',
    '--name', name,
    '--network', SHARED_NETWORK,
    '--memory', memory,
    '--cpus', cpus,
    '--security-opt', 'no-new-privileges:true',
    ...envArgs,
    image,
  ];
  const opts = { timeout: timeoutMs, maxBuffer };
  try {
    return await execFileAsync('docker', args, opts);
  } catch (err) {
    const msg = String((err && (err.stderr || err.message)) || '');
    if (/is already in use/i.test(msg)) {
      // Stale leftover from a killed prior run — clear it and retry once.
      await execFileAsync('docker', ['rm', '-f', name], { timeout: 10000 }).catch(() => {});
      try {
        return await execFileAsync('docker', args, opts);
      } catch (err2) {
        await execFileAsync('docker', ['rm', '-f', name], { timeout: 10000 }).catch(() => {});
        throw err2;
      }
    }
    await execFileAsync('docker', ['rm', '-f', name], { timeout: 10000 }).catch(() => {});
    throw err;
  }
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

// Start an existing (stopped/exited) container in place. Fast-path
// recovery used by the production watchdog (services/app-heal.js): the
// image, env, and container config all survive a stop, so `docker
// start` brings an app back in seconds without a rebuild. Throws on
// failure so callers can escalate to a full rebuild/respawn.
async function startContainer(nameOrId) {
  await execFileAsync('docker', ['start', nameOrId], { timeout: 30000 });
  log.info('docker', 'Container started in place', { nameOrId });
}

// `docker restart` — used by the on-demand heal path (app-heal.js
// requestHeal) for a container whose state is 'running' but whose HTTP
// health endpoint stopped answering (hung process). Same 10s stop grace
// as stopAndRemove. Throws on failure.
async function restartContainer(nameOrId) {
  await execFileAsync('docker', ['restart', '-t', '10', nameOrId], { timeout: 60000 });
  log.info('docker', 'Container restarted', { nameOrId });
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

// Read the container's labels (Config.Labels) as a flat object. Returns
// {} if the container is missing or labels are unset. Used by the warm
// CC worker fast-path to detect old (pre-Anthropic-proxy) containers
// that need to be evicted and re-bootstrapped — see
// src/services/worker.js's ensureWorker.
async function getContainerLabels(nameOrId) {
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect', '--format', '{{json .Config.Labels}}', nameOrId,
    ], { timeout: 5000 });
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === 'null') return {};
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function containerExists(nameOrId) {
  const status = await getContainerStatus(nameOrId);
  return status !== 'not_found';
}

async function waitForHealthy(name, port, healthPath, maxRetries = 30) {
  log.info('docker', 'Waiting for healthcheck', { name, path: healthPath });
  let lastErr = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      // 127.0.0.1, not localhost: in Alpine containers `/etc/hosts`
      // lists `::1 localhost` before `127.0.0.1 localhost`, BusyBox's
      // resolver returns the v6 entry first, and Node's
      // app.listen(PORT, '0.0.0.0') binds IPv4 only — so a localhost
      // wget gets "connection refused" against ::1:port. Hitting the
      // numeric v4 loopback dodges the resolver entirely.
      await execFileAsync('docker', [
        'exec', name, 'wget', '-qO-', '--timeout=2',
        `http://127.0.0.1:${port}${healthPath}`,
      ], { timeout: 5000 });
      log.info('docker', 'Healthcheck passed', { name, attempt: i + 1 });
      return;
    } catch (err) {
      lastErr = err;
      await sleep(2000);
    }
  }
  // Capture container logs + status before giving up. Without this the
  // platform reports "Healthcheck failed after 30 attempts" with no clue
  // whether the process crashed at startup, the port is wrong, or wget
  // itself is misbehaving — every failure mode looks identical.
  let containerLogs = '';
  let containerStatus = '';
  try {
    const { stdout, stderr } = await execFileAsync('docker', ['logs', '--tail', '50', name], { timeout: 5000 });
    containerLogs = (stdout + stderr).trim();
  } catch (_) { /* ignore — best effort */ }
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect', '--format', '{{.State.Status}} (exit={{.State.ExitCode}})', name,
    ], { timeout: 3000 });
    containerStatus = stdout.trim();
  } catch (_) { /* ignore */ }
  log.error('docker', 'Healthcheck never passed — collecting container state', {
    name,
    containerStatus,
    lastWgetErr: lastErr ? (lastErr.stderr || lastErr.message || String(lastErr)).slice(0, 500) : null,
    containerLogs: containerLogs.slice(-2000), // last 2kB is plenty for a stack trace
  });
  // Attach the collected boot diagnostics to the thrown error so callers
  // (staging build → proposal-checks recovery) can persist a concise reason
  // onto the session instead of leaving check_state NULL with the cause
  // buried in platform logs. `healthcheckFailed` lets callers distinguish a
  // boot/healthcheck failure (the app can't even start) from other build
  // errors. See services/deploy-failure for the reason extraction and
  // staging-recovery.recheckSessionChecks for the persist.
  const err = new Error(`Healthcheck failed after ${maxRetries} attempts: ${name}`);
  err.healthcheckFailed = true;
  err.containerStatus = containerStatus || null;
  err.containerLogs = containerLogs ? containerLogs.slice(-2000) : '';
  throw err;
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
  execShellStdin,
  buildImage,
  runContainer,
  runOneShot,
  startContainer,
  restartContainer,
  stopAndRemove,
  getContainerStatus,
  getContainerLabels,
  containerExists,
  waitForHealthy,
  getHostPort,
  ensureVolume,
  removeVolume,
};
