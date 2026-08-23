const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
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

// Staging-preview resourcing (#816). Previews used to inherit the
// production-app defaults above by omission, which meant every preview ran
// on half a core — including for the 1-3 minutes right after a build when
// the screenshot + proposal-checks pass is driving a headless browser
// against it. A reviewer clicking Preview in that window was competing with
// the capture run for the same 0.5 CPU, which is what made a freshly-built
// preview feel slow to open.
//
// `--cpus` is a CEILING, not a reservation: an idle preview (production
// measures ~1%) costs nothing extra at 1.0, and the extra headroom only
// materialises during the capture window this exists to fix. Memory stays
// at 256m deliberately — production previews sit at 28-57 MiB, so memory
// was never the constraint. Both are env-overridable if a host proves tight.
//
// Raised 1 → 2 when the checks run went parallel: the capture container now
// drives up to 8 pages at once against this one preview, so the preview
// itself became the bottleneck the ceiling was protecting against. Still a
// ceiling — an idle preview is unaffected, and the cost only appears during
// the same capture window the 1.0 bump was already for.
const STAGING_MEMORY = process.env.STAGING_MEMORY || '256m';
const STAGING_CPUS = process.env.STAGING_CPUS || '2';

const SHARED_NETWORK = process.env.DOCKER_NETWORK || 'shared-web';

// SIGTERM→SIGKILL budget handed to `docker stop -t <n>` (#767).
//
// This is a CEILING, not a cost: a container that exits on its own returns
// `docker stop` immediately. Before `--init` (see runContainer) it was
// always the full cost, because the app's Node process ran as PID 1 and
// Linux discards signals PID 1 has installed no handler for — every stop
// measured 10.7-11.4s of grace expiring followed by a SIGKILL.
//
// 5s sits above the 3s drain deadline the app conventions prescribe
// (src/prompts/app-conventions.md "Graceful shutdown"), so a well-behaved
// app is never SIGKILLed mid-drain — the same relationship the platform
// keeps between its own DRAIN_TIMEOUT_MS (5s) and compose's
// stop_grace_period (10s). Throwaway staging containers pass 2 explicitly.
const STOP_GRACE_SEC = parseInt(process.env.DOCKER_STOP_GRACE_SEC || '5', 10);
// Staging previews / failed-build cleanup: nothing to drain, so don't wait
// on the ceiling for a container nobody is talking to.
const STAGING_STOP_GRACE_SEC = 2;
// A stop is counted as force-killed when it burned (essentially) the whole
// grace — i.e. Docker had to SIGKILL. Slack absorbs docker CLI overhead.
const FORCE_KILL_SLACK_MS = 400;

async function buildImage(contextPath, tag, buildArgs = {}) {
  const buildArgFlags = Object.entries(buildArgs).flatMap(
    ([k, v]) => ['--build-arg', `${k}=${v}`]
  );
  log.info('docker', 'Building image', { context: contextPath, tag, buildArgs });
  const startedAt = Date.now();
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
  const durationMs = Date.now() - startedAt;
  log.info('docker', 'Image built', { tag, durationMs });
  return { durationMs };
}

// Linux caps a hostname at HOST_NAME_MAX (64 bytes) and runc's
// sethostname() rejects anything longer with EINVAL, so the container dies
// during init with nothing but "error during container init: sethostname:
// invalid argument" to show for it. Staging previews are named
// `usernode-staging-<slug>--<sessionId>`, which is 66 characters for a
// 43-character slug and a 4-digit session id — a real app hit that wall and
// its preview could never boot, no matter how many times the heal sweep
// retried, because the name is deterministic.
//
// Clamp only what we pass to --hostname. The container's --name must stay
// byte-identical to what callers asked for: Caddy's map block derives the
// upstream container name from the request host, staging-reap parses session
// ids back out of it, and both staging_container_id and staging_runtime_name
// persist it.
//
// #1379 stopped there, on the reasoning that "nothing on the platform
// resolves a container by its hostname, so shortening it is invisible." The
// first half of that is still true. The second half was not: Docker's
// embedded DNS resolves container NAMES, and a name longer than 63 bytes is
// not a legal DNS label, so nothing can look it up either. The same 66-byte
// staging name that used to kill the container at init now boots fine and is
// simply unreachable — Chrome answers ERR_NAME_NOT_RESOLVED before a byte of
// app code runs, and Caddy's Go resolver rejects the label just as flatly.
// The health gate never noticed because probeHealthOnce goes through
// `docker exec` + 127.0.0.1, which resolves nothing.
//
// So the resolvable identity is a separate, short NETWORK ALIAS registered
// alongside the long name (see `aliases` below and application-runtime's
// deploy). The name stays the name; the alias is what anything speaking DNS
// is handed.
const MAX_HOSTNAME = 63; // RFC-1123 label limit; same convention as kubernetes.dnsName()

function containerHostname(name) {
  const value = String(name || '');
  if (value.length <= MAX_HOSTNAME) return value;
  // Hash the FULL name, not the truncated prefix: two sessions on the same
  // long slug (…--3530 and …--3539) differ only in the tail that gets cut.
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
  const prefix = value.slice(0, MAX_HOSTNAME - digest.length - 1).replace(/-+$/, '');
  return `${prefix}-${digest}`;
}

async function runContainer(name, {
  image, env = {}, port, memory = APP_MEMORY, cpus = APP_CPUS, labels = {},
  aliases = [],
}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  // Labels are metadata the platform can read back off a LIVE container
  // without knowing anything about how it was built — the one channel that
  // survives `docker restart` and a host reboot. Two consumers today: the
  // warm-worker migration marker (services/worker.js `usernode.proxy`) and
  // the staging env fingerprint (services/staging-env.js `usernode.env.fp`),
  // which is how a preview running stale env becomes detectable at all.
  // Values must never carry secret material — a label is readable by
  // anything that can run `docker inspect`.
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);

  // Extra DNS names this container answers to on SHARED_NETWORK. Every peer
  // that reaches the container over the network — the capture browser, Caddy
  // — resolves one of these rather than --name, which is allowed to exceed a
  // DNS label's 63 bytes (see containerHostname above). Deduped and filtered
  // so a caller passing the name itself, or nothing at all, is a no-op.
  const aliasArgs = [...new Set(
    (Array.isArray(aliases) ? aliases : [aliases])
      .map((a) => String(a == null ? '' : a).trim())
      .filter((a) => a && a !== name)
  )].flatMap((a) => ['--network-alias', a]);

  const args = [
    'run', '-d',
    '--name', name,
    '--hostname', containerHostname(name),
    // #767: run Docker's bundled init (tini) as PID 1 instead of the app.
    //
    // Linux does NOT apply default signal dispositions to PID 1 — a signal
    // with no installed handler is silently DISCARDED. App images are
    // `CMD node server.js`, so the app's Node process was PID 1 and every
    // `docker stop` SIGTERM went nowhere: the app kept serving for the
    // whole grace window and was then SIGKILLed mid-request (measured
    // 10.7-11.4s, every single stop, never less). With --init, tini takes
    // PID 1 and forwards SIGTERM to the app as an ordinary child, where
    // Node's default disposition (terminate) applies.
    //
    // This is the retroactive half of the fix: every app that already
    // exists exits promptly with zero changes to its repo. Apps that adopt
    // the shutdown handler from app-conventions.md additionally get a
    // clean drain. tini also reaps zombies for apps that spawn children.
    '--init',
    '--network', SHARED_NETWORK,
    ...aliasArgs,
    '--memory', memory,
    '--cpus', cpus,
    '--security-opt', 'no-new-privileges:true',
    '--restart', 'unless-stopped',
    '-p', `${port}`,
    ...labelArgs,
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
//
// `salvagePartial` (opt-in) changes ONLY the timeout/maxBuffer outcome: a
// run that produced usable stdout before being killed resolves with that
// partial stdout plus `{ partial: true, partialReason }` instead of
// throwing. The capture pipeline wants this — its output protocol is a
// stream of independently-parseable frames, so a 240s timeout that killed
// the run mid-target still carries every frame already emitted, and
// discarding them loses a whole proposal's screenshots for one slow page
// (screenshot-reliability spec, improvement 5). Every other caller keeps
// the throwing contract: a truncated `docker build` log is not a usable
// result. Non-timeout failures (image missing, OOM-kill, name clash after
// the retry) still throw regardless of the flag.
// `stdinPayload` (optional): a string piped to the container's stdin
// (docker run -i). This is how oversized inputs travel — a Linux exec caps
// any single argv/env string at 128KB (MAX_ARG_STRLEN), so a large value
// passed as `-e KEY=...` kills the docker CLI spawn with E2BIG before the
// container exists. Stdin has no such cap. The write is fire-and-forget
// with an error swallow: if the container dies before draining stdin the
// EPIPE must not mask the real (exit-code) failure.
async function runOneShot(name, {
  image, env = {}, memory = '1g', cpus = '1',
  timeoutMs = 240000, maxBuffer = 128 * 1024 * 1024,
  salvagePartial = false, stdinPayload = null, cmd = null,
}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const args = [
    'run', '--rm',
    ...(stdinPayload != null ? ['-i'] : []),
    '--name', name,
    '--network', SHARED_NETWORK,
    '--memory', memory,
    '--cpus', cpus,
    '--security-opt', 'no-new-privileges:true',
    ...envArgs,
    image,
    // Optional command override (argv after the image). Lets a caller run
    // an ad-hoc script in an existing image (unit-suite check reuses the
    // worker image) instead of the image's default CMD.
    ...(Array.isArray(cmd) ? cmd : []),
  ];
  const opts = { timeout: timeoutMs, maxBuffer };
  const start = () => {
    const promise = execFileAsync('docker', args, opts);
    if (stdinPayload != null && promise.child && promise.child.stdin) {
      promise.child.stdin.on('error', () => {});
      promise.child.stdin.end(stdinPayload);
    }
    return promise;
  };
  try {
    return await start();
  } catch (err) {
    const msg = String((err && (err.stderr || err.message)) || '');
    if (/is already in use/i.test(msg)) {
      // Stale leftover from a killed prior run — clear it and retry once.
      await execFileAsync('docker', ['rm', '-f', name], { timeout: 10000 }).catch(() => {});
      try {
        return await start();
      } catch (err2) {
        await execFileAsync('docker', ['rm', '-f', name], { timeout: 10000 }).catch(() => {});
        const salvaged2 = salvagePartial ? salvageStdout(err2) : null;
        if (salvaged2) return salvaged2;
        throw err2;
      }
    }
    await execFileAsync('docker', ['rm', '-f', name], { timeout: 10000 }).catch(() => {});
    const salvaged = salvagePartial ? salvageStdout(err) : null;
    if (salvaged) return salvaged;
    throw err;
  }
}

// Recover the partial stdout from a timed-out / buffer-exceeded execFile
// rejection. Node attaches whatever was read to err.stdout in both cases
// (`err.killed` + SIGTERM for the timeout, ERR_CHILD_PROCESS_STDIO_MAXBUFFER
// for the cap). Returns null when there's nothing usable to salvage or the
// failure was something else entirely (a non-zero exit with no output, a
// missing image), so the caller rethrows.
function salvageStdout(err) {
  if (!err) return null;
  const stdout = typeof err.stdout === 'string' ? err.stdout : '';
  if (!stdout.length) return null;
  const timedOut = err.killed === true || err.signal === 'SIGTERM' || err.signal === 'SIGKILL';
  const overBuffer = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    || /maxBuffer/i.test(String(err.message || ''));
  if (!timedOut && !overBuffer) return null;
  log.warn('docker', 'One-shot run cut short — salvaging partial stdout', {
    reason: overBuffer ? 'maxBuffer' : 'timeout', bytes: stdout.length,
  });
  return {
    stdout,
    stderr: typeof err.stderr === 'string' ? err.stderr : '',
    partial: true,
    partialReason: overBuffer ? 'output over maxBuffer' : 'run timed out',
  };
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
// health endpoint stopped answering (hung process). Deliberately keeps the
// long 10s grace where stopAndRemove now uses STOP_GRACE_SEC: heal stops a
// container that is (nominally) live and may be mid-request, and it is not
// on any latency-sensitive path. Throws on failure.
async function restartContainer(nameOrId) {
  await execFileAsync('docker', ['restart', '-t', '10', nameOrId], { timeout: 60000 });
  log.info('docker', 'Container restarted', { nameOrId });
}

// Stop then force-remove a container. `stopTimeoutSec` is the SIGTERM→
// SIGKILL grace handed to `docker stop -t` (see STOP_GRACE_SEC above).
//
// `forceKilled` in the log is the diagnostic that matters: true means the
// grace expired and Docker had to SIGKILL, i.e. that container's process
// never handled SIGTERM. It's how you find apps still lacking the
// graceful-shutdown handler without inspecting their repos.
//
// #851: `removed` is the OTHER thing callers need, and until this change it
// was unknowable. Both inner calls swallowed their own failure and the outer
// catch returned timings, so this function could not report "the container is
// still there" — and staging.teardownStaging went on to null
// chat_sessions.staging_container_id anyway, orphaning ten production
// containers whose stopAndRemove had quietly failed. The contract is
// deliberately still NON-THROWING (a dozen best-effort callers rely on that);
// what changes is that the result now tells the truth:
//
//   removed: true   the container is gone — verified, not assumed. Also true
//                   when it was already gone before we started.
//   removed: false  it is STILL THERE after a stop, an rm -f, a short wait
//                   and a second rm -f. `error` carries why. A caller that
//                   is about to forget this container must not.
async function stopAndRemove(nameOrId, { stopTimeoutSec = STOP_GRACE_SEC } = {}) {
  let lastError = null;
  const note = (err) => {
    const msg = String((err && (err.stderr || err.message)) || '').trim();
    // "No such container" is success, not failure: the goal is absence.
    if (msg && !/no such (container|object)/i.test(msg)) lastError = msg.slice(0, 300);
  };

  try {
    const stopStartedAt = Date.now();
    await execFileAsync('docker', ['stop', '-t', String(stopTimeoutSec), nameOrId], { timeout: 30000 })
      .catch(note);
    const stopMs = Date.now() - stopStartedAt;
    const rmStartedAt = Date.now();
    await execFileAsync('docker', ['rm', '-f', nameOrId], { timeout: 10000 }).catch(note);
    let rmMs = Date.now() - rmStartedAt;

    // Verify. `docker rm -f` can fail for reasons that are transient (a
    // device-busy unmount, a daemon mid-restart) and reasons that are not.
    // One retry after a short pause heals the transient shape cheaply;
    // anything surviving that is a genuine leak the caller has to know about.
    let removed = (await getContainerStatus(nameOrId)) === 'not_found';
    if (!removed) {
      await sleep(1000);
      await execFileAsync('docker', ['rm', '-f', nameOrId], { timeout: 10000 }).catch(note);
      rmMs = Date.now() - rmStartedAt;
      removed = (await getContainerStatus(nameOrId)) === 'not_found';
    }

    const forceKilled = stopMs >= (stopTimeoutSec * 1000) - FORCE_KILL_SLACK_MS;
    if (removed) {
      log.info('docker', 'Container removed', { nameOrId, stopMs, rmMs, stopTimeoutSec, forceKilled });
      return { removed: true, stopMs, rmMs, forceKilled, error: null };
    }
    log.warn('docker', 'Container SURVIVED stop+rm — still present after retry', {
      nameOrId, stopMs, rmMs, err: lastError,
    });
    return {
      removed: false, stopMs, rmMs, forceKilled,
      error: lastError || 'container still present after stop + rm -f',
    };
  } catch (err) {
    log.warn('docker', 'Failed to remove container', { nameOrId, err: err.message });
    return {
      removed: false, stopMs: null, rmMs: null, forceKilled: null,
      error: lastError || err.message,
    };
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

// Status + labels in ONE `docker inspect` (#851). The staleness check in
// staging-recovery.stagingNeedsRebuild needs both on a hot path (every
// Preview click, every heal sweep over up to 50 sessions), and doing it as
// getContainerStatus + getContainerLabels would pay two inspects.
//
// Crucially this makes THREE outcomes distinguishable, where the existing
// helpers only manage two:
//
//   { status, labels }              the container is there; labels may be {}
//   { status: 'not_found', ... }    docker says no such container — it is GONE
//   null                            the inspect could not be performed at all
//
// getContainerLabels returns {} for both "no labels" and "could not look", and
// getContainerStatus returns 'not_found' for both "gone" and "daemon
// unreachable". Neither conflation is survivable here: the staleness check acts
// on this verdict by rebuilding or tearing containers down, so "gone" must mean
// rebuild while "cannot see" must mean LEAVE IT ALONE. Collapsing them would
// either strand dead previews or sweep a healthy fleet on a docker hiccup.
async function inspectContainer(nameOrId) {
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect', '--format', '{{.State.Status}}\t{{json .Config.Labels}}', nameOrId,
    ], { timeout: 5000 });
    const [status, labelsJson] = String(stdout).trim().split('\t');
    let labels = {};
    if (labelsJson && labelsJson !== 'null') {
      try {
        const parsed = JSON.parse(labelsJson);
        if (parsed && typeof parsed === 'object') labels = parsed;
      } catch { /* malformed label blob — treat as unlabelled, status is still good */ }
    }
    return { status: status || 'unknown', labels };
  } catch (err) {
    const msg = String((err && (err.stderr || err.message)) || '');
    // Docker's own "it isn't here" wording. Same phrase getContainerStatus
    // turns into 'not_found', kept in sync deliberately.
    if (/no such (container|object)/i.test(msg)) {
      return { status: 'not_found', labels: {} };
    }
    return null;
  }
}

// Read the network aliases a LIVE container answers to on SHARED_NETWORK.
//
// Deliberately a sibling of inspectContainer rather than a widening of it:
// that function's three-way return (record / 'not_found' / null) is consumed
// by the staleness sweep, where "cannot see" must never be confused with
// "gone", and adding a field to it would put a second reason to return null
// into the same channel. Here the tri-state is simpler — an array of aliases,
// or null for "could not look", which callers treat as "leave it alone".
async function containerNetworkAliases(nameOrId, network = SHARED_NETWORK) {
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect', '--format', '{{json .NetworkSettings.Networks}}', nameOrId,
    ], { timeout: 5000 });
    const raw = String(stdout).trim();
    if (!raw || raw === 'null') return [];
    const networks = JSON.parse(raw);
    if (!networks || typeof networks !== 'object') return [];
    const entry = networks[network];
    if (!entry) return [];
    return (Array.isArray(entry.Aliases) ? entry.Aliases : [])
      .map((a) => String(a == null ? '' : a));
  } catch {
    return null;
  }
}

// Attach `alias` to a live container as a SHARED_NETWORK alias, if it is not
// already there.
//
// This is the retroactive half of the long-name fix. A preview whose checks
// failed with ERR_NAME_NOT_RESOLVED cannot be repaired by a rebuild: a
// re-check reuses the live container, and the only thing that WOULD rebuild
// it — a new commit — clears the proposal's votes. So the alias has to be
// added in place, to a running container, with no image build and no database
// clone. `docker network disconnect` + `connect --alias` does exactly that;
// the container keeps running throughout and only its IP on the shared
// network may change, which nothing caches.
//
// Idempotent and non-fatal by construction: already-aliased is a no-op, an
// unreachable daemon or a container that has gone away is swallowed with a
// warning. Every caller invokes it on a path that has something else to do
// afterwards, and none of them should fail because a repair could not be
// applied.
//
// Returns whether the container is now KNOWN to answer to `alias` — true both
// when it already did and when this call attached it, false whenever that
// could not be established. Callers use the false case to fall back to the
// container's own name rather than aim a browser at a name nothing has
// confirmed exists.
async function ensureNetworkAlias(name, alias, network = SHARED_NETWORK) {
  const target = String(alias == null ? '' : alias).trim();
  const container = String(name == null ? '' : name).trim();
  if (!container || !target || target === container) return false;

  const existing = await containerNetworkAliases(container, network);
  // null = could not inspect. Do NOT blindly reconnect on a blind guess:
  // disconnecting a container we cannot see the state of is the one way this
  // helper could make things worse.
  if (existing === null) return false;
  if (existing.includes(target)) return true;

  // Preserve whatever aliases the container already had. Docker reports the
  // container's own name (and, on some engine versions, its short id) in this
  // list; both are re-registered automatically on connect, and the name may be
  // longer than a DNS label allows — which is the whole reason we are here —
  // so re-asserting either as an explicit --alias is at best noise and at
  // worst a rejected argument.
  const keep = existing.filter((a) => a && a !== container && a.length <= MAX_HOSTNAME
    && !container.startsWith(a));

  try {
    await execFileAsync('docker', ['network', 'disconnect', network, container], { timeout: 15000 });
    await execFileAsync('docker', [
      'network', 'connect', '--alias', target, ...keep.flatMap((a) => ['--alias', a]),
      network, container,
    ], { timeout: 15000 });
    log.info('docker', 'Network alias attached to live container', { name: container, alias: target });
    return true;
  } catch (err) {
    log.warn('docker', 'Could not attach network alias (non-fatal)', {
      name: container, alias: target, err: err.message,
    });
    return false;
  }
}

async function containerExists(nameOrId) {
  const status = await getContainerStatus(nameOrId);
  return status !== 'not_found';
}

// Is this image tag present on the host? Sibling of containerExists.
// Used by the bulk container rollover (services/app-rollover.js) to decide
// between the cheap re-run-the-existing-image path and the full
// clone+build fallback: `docker run` on a missing image fails late and
// after the old container is already gone, so we check first.
async function imageExists(tag) {
  try {
    await execFileAsync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// Escalating backoff between health polls (#767). Attempt 1 essentially
// always fails — the container has only just started — and the old flat
// 2000ms sleep meant EVERY container start paid ~2s waiting for a process
// that was typically ready in a few hundred ms (production consistently
// logged `attempt: 2` at +2.96s). Starting at 250ms and escalating keeps
// the fast path fast while preserving the same ~60s total ceiling for a
// genuinely slow boot: 250+500+1000 = 1.75s, then 2000ms steady. 33
// attempts keeps the total budget at 1.75 + 30x2 = 61.75s, i.e. at or above
// the old 30x2000 = 60s — shortening the early retries must never shorten
// how long a slow-booting app is given overall.
const HEALTH_BACKOFF_MS = [250, 500, 1000];
const HEALTH_BACKOFF_MAX_MS = 2000;

function healthBackoffMs(attemptIndex) {
  return HEALTH_BACKOFF_MS[attemptIndex] ?? HEALTH_BACKOFF_MAX_MS;
}

// ONE healthcheck attempt against a running container, as a boolean.
//
// This is the body of waitForHealthy's retry loop, extracted so the two
// consumers share an implementation rather than growing a second copy of
// the wget invocation (#816). waitForHealthy still owns the retry policy;
// this owns "can the app inside this container answer right now".
//
// 127.0.0.1, not localhost: in Alpine containers `/etc/hosts` lists
// `::1 localhost` before `127.0.0.1 localhost`, BusyBox's resolver returns
// the v6 entry first, and Node's app.listen(PORT, '0.0.0.0') binds IPv4
// only — so a localhost wget gets "connection refused" against ::1:port.
// Hitting the numeric v4 loopback dodges the resolver entirely.
//
// Never throws: a missing container, an unreachable daemon and an app that
// answers non-2xx are all just `false`. Callers that need to distinguish
// those use inspectContainer.
// `onError` receives the swallowed error so a retrying caller can keep the
// last failure for its give-up diagnostics without reintroducing throws.
async function probeHealthOnce(name, port, healthPath, { timeoutMs = 5000, onError } = {}) {
  // `--timeout` is in whole seconds and must stay strictly inside the exec
  // budget so wget's own failure (not the CLI kill) is what we observe.
  const wgetTimeoutSec = Math.max(1, Math.floor(timeoutMs / 1000) - 1);
  try {
    await execFileAsync('docker', [
      'exec', name, 'wget', '-qO-', `--timeout=${wgetTimeoutSec}`,
      `http://127.0.0.1:${port}${healthPath}`,
    ], { timeout: timeoutMs });
    return true;
  } catch (err) {
    if (typeof onError === 'function') {
      try { onError(err); } catch { /* diagnostics must never fail a probe */ }
    }
    return false;
  }
}

async function waitForHealthy(name, port, healthPath, maxRetries = 33) {
  log.info('docker', 'Waiting for healthcheck', { name, path: healthPath });
  const startedAt = Date.now();
  let lastErr = null;
  for (let i = 0; i < maxRetries; i++) {
    // 5000ms exec budget / `--timeout=2` inside it: unchanged from the
    // inlined version this replaced.
    if (await probeHealthOnce(name, port, healthPath, {
      timeoutMs: 5000,
      onError: (err) => { lastErr = err; },
    })) {
      const waitedMs = Date.now() - startedAt;
      log.info('docker', 'Healthcheck passed', { name, attempt: i + 1, waitedMs });
      return { attempts: i + 1, waitedMs };
    }
    await sleep(healthBackoffMs(i));
  }
  const waitedMs = Date.now() - startedAt;
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
    attempts: maxRetries,
    waitedMs,
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
  err.attempts = maxRetries;
  err.waitedMs = waitedMs;
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
  containerHostname,
  execShellStdin,
  buildImage,
  runContainer,
  runOneShot,
  startContainer,
  restartContainer,
  stopAndRemove,
  getContainerStatus,
  getContainerLabels,
  inspectContainer,
  containerNetworkAliases,
  ensureNetworkAlias,
  containerExists,
  imageExists,
  waitForHealthy,
  probeHealthOnce,
  getHostPort,
  ensureVolume,
  removeVolume,
  STOP_GRACE_SEC,
  STAGING_STOP_GRACE_SEC,
  STAGING_MEMORY,
  STAGING_CPUS,
  HEALTH_BACKOFF_MS,
  HEALTH_BACKOFF_MAX_MS,
};
