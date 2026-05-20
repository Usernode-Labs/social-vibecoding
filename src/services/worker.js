'use strict';

const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const log = require('./logger');
const docker = require('./docker');
const github = require('./github');
const models = require('./models');

const WORKER_IMAGE = 'usernode-worker:latest';
const WORKER_MEMORY = '2g';
const WORKER_CPUS = '2';
const WARM_READY_TIMEOUT_MS = 5 * 60 * 1000;

// URL the worker container uses to reach the platform's internal API
// (push proxy, PR creation, etc.). Both containers run on the same
// docker network (compose service name `usernode`). Override via env
// for self-hosted deployments that put the platform on a different
// hostname / port.
const PLATFORM_INTERNAL_URL = process.env.PLATFORM_INTERNAL_URL || 'http://usernode:3000';

// Worker JWTs are short-lived but cover the entire chat session; 24h is
// the cap any single session is allowed to run before re-auth becomes
// the chat handler's problem. Re-minted on every warm bootstrap and on
// every per-turn `docker exec`.
const WORKER_JWT_TTL = '24h';

// Lazy-load JWT_SECRET so module import doesn't crash before config
// loads. server.js calls config.load() at startup which crashes on
// missing JWT_SECRET; by the time any worker bootstrap runs the env
// var is guaranteed present.
function _jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set — cannot mint worker JWT');
  return s;
}

// Mint the auth token the worker container uses to call back into the
// platform's internal API. Scope locks it to a single session id; the
// internal-auth middleware rejects anything missing the scope claim.
function mintWorkerJwt(sessionId) {
  return jwt.sign(
    { session_id: sessionId, scope: 'worker:session' },
    _jwtSecret(),
    { expiresIn: WORKER_JWT_TTL }
  );
}

// ──────────────────────────────────────────────────────────────────────
// Stream-json / marker parsing
// ──────────────────────────────────────────────────────────────────────
//
// Claude Code emits one JSON object per stdout line (`--output-format
// stream-json --verbose`). The worker entrypoint additionally emits a
// handful of sentinel lines the host relies on:
//
//   __USERNODE_PHASE__  <phase>                            status transitions
//   __USERNODE_RESULT__ cc_exit=N ahead=N sha=… push_ok=N      final summary
//   __USERNODE_WARN__   <msg>                              non-fatal issue
//   __USERNODE_ERROR__  <msg>                              fatal, bail out
//
// Everything else is treated as a plain progress line (git output, etc.).
//
// Two transports drive this parser:
//   1) `docker logs -f <container>` — used for legacy single-shot
//      workers and for the warm-ready wait during bootstrap.
//   2) `docker exec <container> /usr/local/bin/run-cc.sh` — per-turn
//      streaming for the long-lived worker path. Same stdout format.

function parseClaudeResponse(stdout) {
  // Keep for back-compat with callers that still pass a full stdout blob.
  const lines = (stdout || '').split('\n').filter(Boolean);
  let resultText = '';
  let costUsd = 0;
  let sessionId = null;
  let isError = false;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') {
        resultText = event.result || resultText;
        costUsd = event.cost_usd || event.total_cost_usd || costUsd;
        sessionId = event.session_id || sessionId;
        if (event.is_error) isError = true;
      }
    } catch {
      // Not JSON — skip.
    }
  }

  return { text: resultText, costUsd, numTurns: 0, sessionId, isError };
}

// Best-effort one-line summary of a tool_result payload. The content is
// either a string (typical for Read/Bash) or an array of content blocks
// (image + text for tools like Playwright). We don't want to spam the
// progress log with the entire file, so just surface length/lines and
// trim hard.
function summarizeToolResult(block) {
  if (block.is_error) return 'error';
  const raw = block.content;
  let text = '';
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  if (!text) return 'ok';
  const lines = text.split('\n');
  if (lines.length > 3) return `${lines.length} lines`;
  // Short payloads (e.g. bash exit, quick grep) — show the last
  // non-empty line so the user sees the actual outcome.
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim()) || '';
  const trimmed = lastNonEmpty.trim().replace(/\s+/g, ' ');
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

function applyStreamEvent(event, onProgress, state) {
  // Capture the CC session id on the very first event so the caller can
  // persist it even if CC aborts before emitting a `result` event.
  if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
    state.initSessionId = event.session_id;
    state.sessionId = state.sessionId || event.session_id;
  }
  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        state.lastResultText = block.text;
        onProgress(block.text.substring(0, 300));
      } else if (block.type === 'thinking' && block.thinking) {
        // Extended thinking blocks. Without surfacing these the UI can
        // sit on "Reading foo.html" for 30+ seconds while the model
        // thinks about what to do next — misleading. Prefix with `…`
        // so it's visually distinct from tool / text lines.
        const firstLine = block.thinking.split('\n').find((l) => l.trim()) || '';
        const clipped = firstLine.trim().slice(0, 200);
        if (clipped) onProgress(`… ${clipped}`);
      } else if (block.type === 'tool_use') {
        const input = block.input || {};
        // Track id → label mapping so the matching tool_result can
        // display "⎿ <label>: <summary>" instead of just "⎿ done".
        let label;
        if (block.name === 'Read' && input.file_path) {
          label = `Reading ${input.file_path}`;
        } else if (block.name === 'Write' && input.file_path) {
          label = `Writing ${input.file_path}`;
        } else if (block.name === 'Edit' && input.file_path) {
          label = `Editing ${input.file_path}`;
        } else if (block.name === 'MultiEdit' && input.file_path) {
          label = `Editing ${input.file_path}`;
        } else if (block.name === 'Bash' && input.command) {
          label = `$ ${input.command.substring(0, 150)}`;
        } else {
          label = `Using ${block.name}`;
        }
        onProgress(label);
        if (block.id) state.toolUses.set(block.id, { name: block.name, label });
      }
    }
  } else if (event.type === 'user' && event.message?.content) {
    // tool_result arrives inside a `user` event after CC executes the
    // tool call. Surfacing it breaks the "Reading X" dead-air and lets
    // the user see CC is progressing through its plan.
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      const summary = summarizeToolResult(block);
      const prior = block.tool_use_id ? state.toolUses.get(block.tool_use_id) : null;
      if (prior) {
        onProgress(`  ⎿ ${prior.name}: ${summary}`);
        state.toolUses.delete(block.tool_use_id);
      } else {
        onProgress(`  ⎿ ${summary}`);
      }
    }
  } else if (event.type === 'result') {
    state.lastResultText = event.result || state.lastResultText;
    state.costUsd = event.cost_usd || event.total_cost_usd || state.costUsd;
    state.sessionId = event.session_id || state.sessionId;
    if (event.is_error) state.ccIsError = true;
  }
}

function parseLine(line, onProgress, state) {
  if (!line || !line.trim()) return;
  if (line.startsWith('__USERNODE_PHASE__')) {
    state.phase = line.replace('__USERNODE_PHASE__', '').trim();
    onProgress(`[${state.phase}]`);
    return;
  }
  if (line.startsWith('__USERNODE_RESULT__')) {
    const body = line.replace('__USERNODE_RESULT__', '').trim();
    for (const kv of body.split(/\s+/)) {
      const [k, v] = kv.split('=');
      if (k === 'cc_exit') state.ccExit = parseInt(v, 10);
      else if (k === 'ahead') state.ahead = parseInt(v, 10) || 0;
      else if (k === 'sha') state.sha = v || null;
      else if (k === 'push_ok') state.pushOk = v === '1';
    }
    state.resultSeen = true;
    return;
  }
  if (line.startsWith('__USERNODE_ERROR__')) {
    state.fatalError = line.replace('__USERNODE_ERROR__', '').trim();
    return;
  }
  if (line.startsWith('__USERNODE_WARN__')) {
    const msg = line.replace('__USERNODE_WARN__', '').trim();
    log.warn('worker', msg);
    return;
  }
  try {
    const event = JSON.parse(line);
    applyStreamEvent(event, onProgress, state);
  } catch {
    // Plain log line (git output, shell echo, etc.).
    if (line.length < 500) onProgress(line);
  }
}

function newWatchState() {
  return {
    lastResultText: '',
    costUsd: 0,
    sessionId: null,
    initSessionId: null,
    ccIsError: false,
    ccExit: null,
    ahead: 0,
    sha: null,
    pushOk: false,
    phase: null,
    fatalError: null,
    resultSeen: false,
    rawStdout: '',
    rawStderr: '',
    exitCode: null,
    // id → { name, label } for pending tool_use calls, so the matching
    // tool_result can be annotated with the same label.
    toolUses: new Map(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Image build
// ──────────────────────────────────────────────────────────────────────

async function ensureWorkerImage() {
  // Always build; Docker's layer cache makes this fast when nothing's
  // changed, and crucially picks up edits to worker-run.sh / run-cc.sh
  // without requiring a manual `docker rmi`.
  const path = require('path');
  const workerDir = path.join(__dirname, '../../worker');
  log.info('worker', 'Building worker image', { dir: workerDir });
  await docker.buildImage(workerDir, WORKER_IMAGE);
}

// Docker-volume name used to persist Claude Code's on-disk session
// memory (~/.claude) for a given chat session. Reused across every
// turn — and across container churn (eviction + re-warm) — of the
// same chat so `--resume <cc_session_id>` can replay context from disk.
function ccVolumeName(sessionId) {
  return `usernode-cc-${sessionId}`;
}

function workerContainerName(sessionId) {
  return `usernode-worker-${sessionId}`;
}

// ──────────────────────────────────────────────────────────────────────
// Warm-worker registry
// ──────────────────────────────────────────────────────────────────────
//
// Long-lived per-session worker containers are tracked here so the host
// knows which sessions have a warm container ready to take execs, when
// each was last used (for idle eviction), and whether one is currently
// running a `docker exec` (for stop semantics + drain).
//
// Shape: Map<sessionId:number, {
//   containerName: string,
//   lastUsedMs:    number,    // updated when an exec completes / on adopt
//   inFlight:      boolean,   // true while a docker-exec child is running
//   bootstrap:     Promise|null,   // present while ensureWorker is racing
//   adopted:       boolean,   // true if registered via adoptWarmWorker
// }>
//
// Lifecycle:
//   - ensureWorker()    → creates entry on first use, awaits bootstrap.
//   - execInWorker()    → toggles inFlight + bumps lastUsedMs on finish.
//   - evictWorker()     → docker stop+rm, deletes entry. Volume kept.
//   - destroyWorker()   → also deletes the entry (compat path used by
//                         legacy adoption + session archive).
//   - adoptWarmWorker() → server restart picked up an existing warm
//                         container; register it so the next exec
//                         doesn't try to re-bootstrap on top.
const _warmRegistry = new Map();

function _registryGet(sessionId) {
  return _warmRegistry.get(sessionId) || null;
}

function _registryUpsert(sessionId, patch) {
  const prev = _warmRegistry.get(sessionId) || {
    containerName: workerContainerName(sessionId),
    lastUsedMs: Date.now(),
    inFlight: false,
    bootstrap: null,
    adopted: false,
  };
  const next = { ...prev, ...patch };
  _warmRegistry.set(sessionId, next);
  return next;
}

// Cheap "is this session's worker actively running CC right now?" check.
// Mirrors the in-process `inFlight` flag set by execInWorker. A warm-but-
// idle container (sleep wrapper alive, no `docker exec` running)  → false.
// Returns false when no warm registry entry exists at all (no worker
// ever started, or the entry was evicted).
//
// Use this — NOT `containerStatus === 'running'` — anywhere you need to
// gate logic on "a CC turn is in progress for this session". The
// container-status check predates `keep cc warm between calls` and now
// over-reports busy for the entire warm-idle window (~10 min until the
// sweeper evicts), which strands the dev-chat UI in stop-sign mode if
// the POST SSE drops before delivering its `done` event.
function isInFlight(sessionId) {
  return _warmRegistry.get(sessionId)?.inFlight === true;
}

// Read-only snapshot of the warm registry. Safe to expose to the idle-
// eviction sweeper and the /api/status admin page.
function warmRegistrySnapshot() {
  const out = [];
  for (const [sessionId, meta] of _warmRegistry.entries()) {
    out.push({
      sessionId,
      containerName: meta.containerName,
      lastUsedMs: meta.lastUsedMs,
      inFlight: meta.inFlight,
      bootstrapping: !!meta.bootstrap,
      adopted: !!meta.adopted,
    });
  }
  return out;
}

// Register a warm container that already exists (either spawned by us
// earlier in this process, or adopted from a previous server run).
function adoptWarmWorker(sessionId, containerName = null) {
  _registryUpsert(sessionId, {
    containerName: containerName || workerContainerName(sessionId),
    lastUsedMs: Date.now(),
    inFlight: false,
    bootstrap: null,
    adopted: true,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Bootstrap (cold start) + warm-ready wait
// ──────────────────────────────────────────────────────────────────────

// Spawn a brand-new warm worker container. Internal to this module —
// callers should use `ensureWorker` which handles the "already warm"
// case and concurrency.
async function _bootstrapWarmContainer(sessionId, {
  repoOwner, repoName, branchName, anthropicApiKey, onProgress,
}) {
  const containerName = workerContainerName(sessionId);

  // Defensive: scrub any leftover container at this name. ensureWorker
  // already checks for `running` and returns early; anything else (exited,
  // restarting, dead) gets reaped here so `docker run --name` can succeed.
  await docker.stopAndRemove(containerName).catch(() => {});

  // Public-only invariant: the worker carries no GitHub credentials in
  // its env — it relies on the unauthenticated git protocol for clones
  // and fetches. Refuse to spawn against a repo that has gone private
  // since import. Verified at import time too (verifyBotAccess), but
  // a user could flip the repo to private on GitHub after import; this
  // catches that case before we waste a container slot. Imports that
  // pre-date the public-only enforcement are caught here as well.
  const privacy = await github.checkRepoPublic(repoOwner, repoName);
  if (!privacy.ok) {
    throw new Error(
      `Cannot bootstrap worker for ${repoOwner}/${repoName}: ${privacy.message}`
    );
  }
  if (privacy.private) {
    throw new Error(
      `Cannot bootstrap worker for ${repoOwner}/${repoName}: repo is private. Usernode requires public repositories — make it public on GitHub or delete this app and re-import.`
    );
  }

  // Plain HTTPS clone URL with no embedded token. Public repos clone
  // anonymously; the credential helper in worker-run.sh is skipped when
  // PAT is unset, so the worker container ends up with no auth wired
  // into git at all.
  const cloneUrl = await github.getCloneUrl(repoOwner, repoName);

  // Mint the JWT the worker uses to call back into the platform's
  // internal API. The only operation it authorizes is pushing the
  // session's canonical branch (and creating its PR) — see
  // src/routes/internal.js and execPushFromWorker below.
  const workerJwt = mintWorkerJwt(sessionId);

  // CC volume persists across container churn so `claude --resume <id>`
  // can replay prior conversation state on every re-warm.
  const ccVolume = ccVolumeName(sessionId);
  await docker.ensureVolume(ccVolume);

  // BYOK safety (#30): we split container env into two groups.
  //
  // `secretEnv` are secrets that must NEVER appear in the docker CLI
  // argv — doing so would expose them in `ps` on the host (briefly)
  // and, far worse, in `err.cmd`/`err.message` on every `execFile`
  // failure, which `log.warn` then writes to the log file. Instead we
  // reference them with bare `-e KEY` (no `=value`) so Docker reads
  // the values from its own process env, and we set that env on the
  // child only. Values end up in /proc/<docker-pid>/environ
  // (root/same-user readable, not argv-visible).
  //
  // `safeEnv` holds the non-secret args that stay inline.
  //
  // Anthropic-proxy (key-exfil mitigation): for platform-key sessions
  // (anthropicApiKey unset) we deliberately leave ANTHROPIC_API_KEY
  // empty at bootstrap. The real key NEVER enters this container —
  // execInWorker overrides ANTHROPIC_API_KEY per-turn with a
  // session-scoped JWT, and ANTHROPIC_BASE_URL points at the platform
  // proxy. For BYOK sessions the user's own key is set in env both at
  // bootstrap and per-turn (their key is theirs to exfiltrate; only
  // their session can read it).
  const secretEnv = {
    ANTHROPIC_API_KEY: anthropicApiKey || '',
    // No PAT — public clones don't need it, and removing it is the
    // whole point of the platform-side push proxy.
    WORKER_JWT: workerJwt,
  };
  const safeEnv = {
    GIT_AUTHOR_NAME: 'usernode-bot',
    GIT_AUTHOR_EMAIL: 'usernode-bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'usernode-bot',
    GIT_COMMITTER_EMAIL: 'usernode-bot@users.noreply.github.com',
    BRANCH: branchName,
    // MODE=warm tells worker-run.sh to clone + checkout + sleep
    // infinity, so subsequent `docker exec` calls drive per-turn work.
    MODE: 'warm',
    // CLONE_URL has no token in it now; safe to pass inline.
    CLONE_URL: cloneUrl,
    // Used by /usr/local/bin/usernode-push to identify the calling
    // session and reach the platform's internal API.
    SESSION_ID: String(sessionId),
    PLATFORM_URL: PLATFORM_INTERNAL_URL,
  };
  const secretEnvArgs = Object.keys(secretEnv).flatMap((k) => ['-e', k]);
  const safeEnvArgs = Object.entries(safeEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const network = process.env.DOCKER_NETWORK || 'shared-web';

  // No --rm — we want the container to stick around so the host can
  // re-attach to it on restart (orphan adoption) and so eviction is
  // an explicit policy decision, not a side effect of the wrapper exiting.
  const args = [
    'run', '-d',
    '--name', containerName,
    '--hostname', containerName,
    '--network', network,
    '--memory', WORKER_MEMORY,
    '--cpus', WORKER_CPUS,
    '--security-opt', 'no-new-privileges:true',
    // Anthropic-proxy migration marker. ensureWorker checks this label
    // on warm-path hits and evicts + rebootstraps any container missing
    // it, so pre-proxy containers (which had the real ANTHROPIC_API_KEY
    // baked into their bootstrap env) get cycled out on the next ensure.
    // Bump the version when the bootstrap-env shape changes again.
    '--label', 'usernode.proxy=v1',
    '-v', `${ccVolume}:/home/node/.claude`,
    ...secretEnvArgs,
    ...safeEnvArgs,
    WORKER_IMAGE,
  ];

  await docker.execFileAsync('docker', args, {
    timeout: 30000,
    // Merge secrets into the child's env so `docker run -e KEY` can
    // pick them up without them ever appearing in argv.
    env: { ...process.env, ...secretEnv },
  });
  log.info('worker', 'Warm worker spawned', { containerName, ccVolume });

  // Wait for the wrapper to reach `__USERNODE_PHASE__ warm-ready`.
  // Bootstrap progress (clone/checkout) flows through onProgress so the
  // dev-chat UI sees [clone] / [checkout] phase ticks just like the
  // legacy single-shot path used to surface them.
  await _awaitWarmReady(containerName, { onProgress });

  return containerName;
}

// Tail `docker logs -f` until the warm-ready phase marker shows up, or
// the container dies, or we hit a timeout. SIGKILL the tail before
// returning so we don't leak children.
async function _awaitWarmReady(containerName, { onProgress, timeoutMs = WARM_READY_TIMEOUT_MS } = {}) {
  const progress = typeof onProgress === 'function' ? onProgress : () => {};
  return await new Promise((resolve, reject) => {
    const proc = spawn('docker', ['logs', '-f', containerName]);
    let buf = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { proc.kill('SIGKILL'); } catch {}
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`warm-ready timeout for ${containerName}`)),
      timeoutMs
    );
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('__USERNODE_ERROR__')) {
          return finish(new Error(line.replace('__USERNODE_ERROR__', '').trim()));
        }
        if (line.startsWith('__USERNODE_PHASE__')) {
          const phase = line.replace('__USERNODE_PHASE__', '').trim();
          progress(`[${phase}]`);
          if (phase === 'warm-ready') return finish();
          continue;
        }
        if (line.length < 500) progress(line);
      }
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim() && line.length < 500) progress(line);
      }
    });
    proc.on('close', (code) => {
      // The warm wrapper does `exec sleep infinity`, so logs -f only
      // exits if the container died (or we SIGKILLed the tail). If we
      // hit close before warm-ready, bootstrap failed mid-flight.
      finish(new Error(`warm wrapper exited before warm-ready (code=${code})`));
    });
    proc.on('error', (err) => finish(err));
  });
}

// ──────────────────────────────────────────────────────────────────────
// Public API: ensureWorker, execInWorker, evictWorker
// ──────────────────────────────────────────────────────────────────────

// Idempotently get a warm worker container ready for `execInWorker`.
//
// Cold path: spins up the container (~5-10s docker run + clone +
// checkout + warm-ready ~5-30s). Warm path: cheap no-op once the
// container is running, even across multiple concurrent callers (the
// in-flight bootstrap promise is shared via `_warmRegistry[i].bootstrap`).
//
// Returns the container name. Throws if bootstrap fails — in which case
// the registry entry is cleared so the next caller retries from scratch.
async function ensureWorker(sessionId, {
  repoOwner, repoName, branchName,
  anthropicApiKey,
  onProgress,
} = {}) {
  const containerName = workerContainerName(sessionId);

  // Coalesce concurrent ensures — if one's already racing, await it.
  const existing = _registryGet(sessionId);
  if (existing?.bootstrap) {
    await existing.bootstrap;
    return containerName;
  }

  // Already warm? Confirm with Docker before trusting the registry —
  // an external `docker rm` would otherwise leave stale state.
  const status = await docker.getContainerStatus(containerName);
  if (status === 'running') {
    // Anthropic-proxy migration gate: pre-proxy warm containers had
    // the real ANTHROPIC_API_KEY baked into their bootstrap env (still
    // readable from /proc/1/environ between turns). Detect them via
    // the missing usernode.proxy=v1 label and force a re-bootstrap so
    // the platform key gets out of those containers ASAP. Cheap —
    // single `docker inspect` on the warm-path hot path.
    const labels = await docker.getContainerLabels(containerName);
    if (labels['usernode.proxy'] !== 'v1') {
      log.info('worker', 'Evicting pre-proxy warm container', { containerName });
      await evictWorker(sessionId).catch((err) => {
        log.warn('worker', 'Eviction failed; falling through to bootstrap', {
          containerName, err: err.message,
        });
      });
      // fall through to the bootstrap branch below
    } else {
      if (!existing) {
        _registryUpsert(sessionId, { lastUsedMs: Date.now(), inFlight: false });
      }
      return containerName;
    }
  }

  // Anything else (exited, dead, restarting, or not_found): re-bootstrap.
  // _bootstrapWarmContainer reaps any stale container before docker run.
  const bootstrap = (async () => {
    try {
      await _bootstrapWarmContainer(sessionId, {
        repoOwner, repoName, branchName, anthropicApiKey, onProgress,
      });
      _registryUpsert(sessionId, {
        bootstrap: null,
        lastUsedMs: Date.now(),
        inFlight: false,
        adopted: false,
      });
    } catch (err) {
      _warmRegistry.delete(sessionId);
      throw err;
    }
  })();
  _registryUpsert(sessionId, { bootstrap });
  await bootstrap;
  return containerName;
}

// Run one CC turn inside an already-warm container. Streams stdout/stderr
// the same way watchWorker does (via the shared `parseLine` state
// machine) so the dev-chat UI sees identical progress markers regardless
// of which transport delivered them.
//
// Returns the same shape watchWorker produces, so route callers can swap
// `spawnWorker + watchWorker` for `ensureWorker + execInWorker` without
// touching the post-processing logic (PR creation, staging build, etc.).
async function execInWorker(sessionId, {
  mode = 'build',
  prompt,
  model,
  commitMsg,
  resumeSessionId,
  branchName,
  anthropicApiKey,
  onProgress,
  // Optional callback that receives the host-side `docker exec` child
  // process. Lets the route handler stash the child on stopRegistry so
  // a stop signal can SIGTERM just this exec without killing the warm
  // container.
  onChild,
} = {}) {
  const meta = _registryGet(sessionId);
  if (!meta) {
    throw new Error(`execInWorker: no warm worker registered for session ${sessionId}`);
  }
  if (meta.inFlight) {
    throw new Error(`execInWorker: a turn is already in flight for session ${sessionId}`);
  }
  if (!prompt) {
    throw new Error('execInWorker: prompt required');
  }
  const containerName = meta.containerName;

  // Re-mint the JWT on every turn so the worker's auth always has at
  // least WORKER_JWT_TTL left, regardless of how long the warm
  // container has been alive. This avoids edge cases where a session
  // outlives its bootstrap-time token (24h is the cap today; could be
  // shorter later) and the next push fails with 401 from the proxy.
  const workerJwt = mintWorkerJwt(sessionId);

  // Anthropic-proxy: when the caller provides a BYOK key (anthropicApiKey
  // truthy), the worker hits api.anthropic.com directly with that key
  // — same flow as before. When no BYOK key is provided we route the
  // SDK's traffic through the platform's in-process proxy at
  // /api/internal/anthropic. The `claude` CLI honors ANTHROPIC_BASE_URL
  // for endpoint retargeting and ANTHROPIC_API_KEY as the x-api-key
  // header, so we put the session-scoped WORKER_JWT in
  // ANTHROPIC_API_KEY: the proxy verifies it, swaps in the real
  // platform key, and forwards. The real key never enters the worker
  // container, so a malicious prompt like "echo $ANTHROPIC_API_KEY"
  // exfiltrates only a short-lived JWT that's useless against
  // api.anthropic.com directly.
  const useProxy = !anthropicApiKey;
  const secretEnv = {
    ANTHROPIC_API_KEY: useProxy ? workerJwt : anthropicApiKey,
    WORKER_JWT: workerJwt,
  };
  const safeEnv = {
    PROMPT: prompt,
    MODE: mode,
    MODEL: models.resolve(model),
    COMMIT_MSG: commitMsg || 'Changes via Usernode',
    CLAUDE_RESUME_SESSION_ID: resumeSessionId || '',
    // run-cc.sh defensively re-asserts BRANCH (in case the wrapper's
    // checkpoint moves) and gates the pre-exec git reset on it.
    BRANCH: branchName || '',
    // Refresh in case the warm container's env was perturbed; cheap.
    SESSION_ID: String(sessionId),
    PLATFORM_URL: PLATFORM_INTERNAL_URL,
    // Retarget the Anthropic SDK through our proxy when not BYOK.
    // Setting it to '' would still be honored by the SDK as the base
    // URL; only set the key when we mean it.
    ...(useProxy
      ? { ANTHROPIC_BASE_URL: `${PLATFORM_INTERNAL_URL}/api/internal/anthropic` }
      : {}),
  };
  const secretEnvArgs = Object.keys(secretEnv).flatMap((k) => ['-e', k]);
  const safeEnvArgs = Object.entries(safeEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const args = [
    'exec',
    ...secretEnvArgs,
    ...safeEnvArgs,
    containerName,
    '/usr/local/bin/run-cc.sh',
  ];

  _registryUpsert(sessionId, { inFlight: true });

  try {
    return await new Promise((resolve, reject) => {
      const proc = spawn('docker', args, {
        // Same secret-env trick as bootstrap: secrets travel via the
        // child's env, never argv.
        env: { ...process.env, ...secretEnv },
      });
      if (typeof onChild === 'function') {
        try { onChild(proc); } catch {}
      }

      const state = newWatchState();
      const progress = typeof onProgress === 'function' ? onProgress : () => {};

      let stdoutBuf = '';
      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        state.rawStdout += text;
        stdoutBuf += text;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of lines) parseLine(line, progress, state);
      });

      let stderrBuf = '';
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        state.rawStderr += text;
        stderrBuf += text;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() || '';
        for (const line of lines) {
          if (line.trim() && line.length < 500) progress(line);
        }
      });

      proc.on('close', (code) => {
        if (stdoutBuf.trim()) parseLine(stdoutBuf, progress, state);
        // Match watchWorker semantics: state.exitCode mirrors the
        // child's exit code, falling back to -1 on signal.
        state.exitCode = code == null ? -1 : code;
        resolve(state);
      });
      proc.on('error', (err) => reject(err));
    });
  } finally {
    _registryUpsert(sessionId, { inFlight: false, lastUsedMs: Date.now() });
  }
}

// Tear down a warm worker container (eviction). Volume is preserved so
// the next `ensureWorker` re-warms with CC's session memory intact.
async function evictWorker(sessionId) {
  const meta = _registryGet(sessionId);
  const containerName = meta?.containerName || workerContainerName(sessionId);
  await docker.stopAndRemove(containerName).catch(() => {});
  _warmRegistry.delete(sessionId);
  log.info('worker', 'Worker evicted (volume preserved)', { containerName });
}

// ──────────────────────────────────────────────────────────────────────
// Legacy single-shot helpers (kept for orphan adoption + back-compat)
// ──────────────────────────────────────────────────────────────────────

// Tail a worker container's logs until the container exits, parsing
// stream-json + USERNODE markers along the way. Resolves with the
// accumulated state when the container is gone.
//
// Used today only by the orphan-adoption recovery path
// (recoverActiveWorkers in server.js). The live per-turn path uses
// execInWorker which streams the docker-exec child's stdout directly.
async function watchWorker(containerName, { onProgress, fromStart = true } = {}) {
  const state = newWatchState();
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  const args = ['logs', '-f'];
  if (!fromStart) args.push('--tail', '0');
  args.push(containerName);

  const proc = spawn('docker', args);

  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    state.rawStdout += text;
    stdoutBuf += text;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() || '';
    for (const line of lines) parseLine(line, progress, state);
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    state.rawStderr += text;
    stderrBuf += text;
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() && line.length < 500) progress(line);
    }
  });

  await new Promise((resolve) => {
    proc.on('close', resolve);
    proc.on('error', (err) => {
      log.warn('worker', 'docker logs -f errored', { containerName, err: err.message });
      resolve();
    });
  });

  if (stdoutBuf.trim()) parseLine(stdoutBuf, progress, state);

  // Grab the real exit code from docker itself; the __USERNODE_RESULT__
  // line is best-effort and could be absent (e.g. OOM kill).
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'inspect', '--format', '{{.State.ExitCode}}', containerName,
    ], { timeout: 5000 });
    state.exitCode = parseInt(stdout.trim(), 10);
  } catch {
    state.exitCode = -1;
  }

  return state;
}

// Return metadata for every container matching `usernode-worker-*`.
// Used on server startup to adopt any workers left over from a previous
// process. The state field comes straight from `docker ps`:
//   - "running"  : either a warm-idle wrapper (sleep infinity) or a
//                  legacy single-shot still in flight.
//   - "exited"   : single-shot finished; needs log scrape + cleanup.
//   - "created"/"restarting"/etc.: rare, treat as broken → reap.
async function listOrphanWorkers() {
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'ps', '-a',
      '--filter', 'name=^/usernode-worker-',
      '--format', '{{.Names}}\t{{.State}}',
    ], { timeout: 5000 });
    const out = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name, state] = line.split('\t');
      const m = name && name.match(/^usernode-worker-(\d+)$/);
      if (m) out.push({ name, sessionId: parseInt(m[1], 10), state });
    }
    return out;
  } catch {
    return [];
  }
}

// Best-effort check of whether a running warm container has an in-flight
// per-turn exec. We look for a `claude` process inside the container —
// the sleep wrapper is always there, but `claude` is only present
// during a docker exec of run-cc.sh.
//
// Returns:
//   true   — claude (or its parent run-cc.sh) is currently executing
//   false  — only the sleep wrapper is alive
//   null   — couldn't determine (container not running, exec failed, etc.)
async function isWorkerExecuting(containerName) {
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'exec', containerName, 'sh', '-c',
      'pgrep -f "(^|/)(claude|run-cc.sh)(\\s|$)" >/dev/null && echo busy || echo idle',
    ], { timeout: 5000 });
    const out = stdout.trim();
    if (out === 'busy') return true;
    if (out === 'idle') return false;
    return null;
  } catch {
    return null;
  }
}

// Hard teardown of a worker container. Used for session archive, error
// recovery, and the orphan-adoption legacy path. Removes the registry
// entry too so a follow-up ensureWorker doesn't trust stale state.
//
// For ordinary idle eviction during a session, use `evictWorker`
// instead — same effect, but the function name signals intent better.
async function destroyWorker(containerName) {
  await docker.stopAndRemove(containerName).catch(() => {});
  const m = containerName.match(/^usernode-worker-(\d+)$/);
  if (m) _warmRegistry.delete(parseInt(m[1], 10));
  log.info('worker', 'Worker destroyed', { containerName });
}

// Remove the named CC volume for a given chat session. Called when the
// session is archived (permanent teardown). Safe to call even if the
// volume was never created.
async function destroyCcVolume(sessionId) {
  await docker.removeVolume(ccVolumeName(sessionId));
}

// ──────────────────────────────────────────────────────────────────────
// Platform-side git push proxy
// ──────────────────────────────────────────────────────────────────────
//
// The worker container carries no GitHub credentials. When CC commits
// and wants to push, the worker's `usernode-push` shell wrapper hits
// POST /api/internal/sessions/:id/push (see src/routes/internal.js),
// which calls this helper.
//
// We use the worker's existing clone (origin already points at GitHub)
// and inject `GITHUB_BOT_TOKEN` into a single one-shot `docker exec` via
// an inline credential helper. The bot token never enters the worker's
// persistent env or git config; it lives in the exec's environ for the
// duration of the push and disappears when the exec exits.
//
// Branch is supplied by the caller (the route handler) AFTER looking up
// the session's canonical `branch_name` from the DB. The worker doesn't
// get to pick. Branch is sanitized to a strict charset before being
// passed to bash so it can't break out of the shell expansion below.
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;

async function execPushFromWorker(sessionId, branchName) {
  const botToken = process.env.GITHUB_BOT_TOKEN || '';
  if (!botToken) {
    const err = new Error('GITHUB_BOT_TOKEN not configured on platform');
    err.code = 'no_token';
    throw err;
  }
  if (!branchName || !BRANCH_NAME_RE.test(branchName)) {
    const err = new Error(`Invalid branch name: ${branchName}`);
    err.code = 'bad_branch';
    throw err;
  }

  const containerName = workerContainerName(sessionId);

  // Inline credential helper: prints `username=x-access-token` and
  // `password=$PAT` to stdout when git asks for credentials. `-c
  // credential.helper=…` is scoped to this single git invocation —
  // doesn't touch the worker's .git/config. The `bash -c` script
  // reads $PAT and $BRANCH from the exec env (passed via bare `-e`
  // so the values aren't in argv).
  //
  // Final `git rev-parse HEAD` prints the SHA we pushed, which the
  // caller surfaces back to the worker for logging and the
  // __USERNODE_RESULT__ accounting.
  const inlineScript =
    'set -e; cd /home/node/workspace && ' +
    'git -c credential.helper="!f() { echo username=x-access-token; echo password=$PAT; }; f" ' +
    'push -u origin "$BRANCH" >&2 && ' +
    'git rev-parse HEAD';

  const args = [
    'exec',
    '-e', 'PAT',              // bare -e: value taken from docker's own env
    '-e', 'BRANCH',
    containerName,
    'bash', '-c', inlineScript,
  ];

  try {
    const { stdout, stderr } = await docker.execFileAsync('docker', args, {
      timeout: 60000,
      env: { ...process.env, PAT: botToken, BRANCH: branchName },
    });
    const sha = (stdout || '').trim().split('\n').pop();
    log.info('worker', 'Push proxied to GitHub', {
      sessionId, branch: branchName, sha: (sha || '').slice(0, 8),
    });
    return { sha, stderr: (stderr || '').trim() };
  } catch (err) {
    // Don't leak the PAT into log lines if `docker exec` printed any
    // (it shouldn't — credential helpers don't echo creds — but defense
    // in depth). err.message + err.stderr come from execFileAsync.
    const cleanMsg = String(err.message || '').replace(botToken, '***');
    const cleanStderr = String(err.stderr || '').replace(botToken, '***');
    const wrapped = new Error(`push proxy failed: ${cleanMsg}`);
    wrapped.code = 'push_failed';
    wrapped.stderr = cleanStderr;
    log.warn('worker', 'Push proxy failed', {
      sessionId, branch: branchName, err: cleanMsg,
    });
    throw wrapped;
  }
}

module.exports = {
  ensureWorkerImage,
  // long-lived API
  ensureWorker,
  execInWorker,
  evictWorker,
  warmRegistrySnapshot,
  adoptWarmWorker,
  isInFlight,
  isWorkerExecuting,
  // legacy / shared helpers
  watchWorker,
  listOrphanWorkers,
  destroyWorker,
  destroyCcVolume,
  parseClaudeResponse,
  // exposed for the routes' container-name lookups
  workerContainerName,
  // platform-side git push proxy (called from src/routes/internal.js)
  execPushFromWorker,
  mintWorkerJwt,
};
