'use strict';

const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const log = require('./logger');
const docker = require('./docker');
const github = require('./github');
const models = require('./models');

const WORKER_IMAGE = 'usernode-worker:latest';
// Per-session worker container resource limits. Read from env (mirrored
// into src/config.js as workerMemory/workerCpus for logging) so prod can
// shrink the footprint to fit more concurrent warm workers on one box
// without a code deploy. Defaults preserve historical 2g/2-CPU behavior.
const WORKER_MEMORY = process.env.WORKER_MEMORY || '2g';
const WORKER_CPUS = process.env.WORKER_CPUS || '2';
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
//   __USERNODE_PHASE__  <phase>                                                  status transitions
//   __USERNODE_RESULT__ cc_exit=N ahead=N behind=N sha=… push_ok=N [sync_result=…]   final summary
//   __USERNODE_WARN__   <msg>                                                    non-fatal issue
//   __USERNODE_ERROR__  <msg>                                                    fatal, bail out
//
// Everything else is treated as a plain progress line (git output, etc.).
//
// Two transports drive this parser:
//   1) `docker logs -f <container>` — used for legacy single-shot
//      workers and for the warm-ready wait during bootstrap.
//   2) Turn journal files in the CC volume — per-turn output for the
//      long-lived worker path. run-cc.sh runs as a DETACHED exec whose
//      output is redirected to the journal (plus a trailing
//      __USERNODE_EXIT__ <code> line from the wrapper); the host tails
//      the file. Same line format, but restart-proof: the journal and
//      the exec both outlive the platform process.

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
      else if (k === 'behind') state.behind = parseInt(v, 10) || 0;
      else if (k === 'sha') state.sha = v || null;
      else if (k === 'push_ok') state.pushOk = v === '1';
      else if (k === 'sync_result') state.syncResult = v || null;
      // #361: comma-delimited conflicted file paths (MODE=sync). Empty
      // string → no conflicts. Threaded out as result.conflictFiles so
      // sync-main.js can persist the merge-conflict snapshot.
      else if (k === 'conflict_files') state.conflictFiles = v ? v.split(',').filter(Boolean) : [];
    }
    state.resultSeen = true;
    return;
  }
  if (line.startsWith('__USERNODE_ERROR__')) {
    state.fatalError = line.replace('__USERNODE_ERROR__', '').trim();
    return;
  }
  if (line.startsWith('__USERNODE_EXIT__')) {
    // Appended by the detached-exec wrapper after run-cc.sh exits — the
    // journal-file analog of the docker-exec child's exit code. Seeing
    // this line is how the journal tailer knows the turn is over.
    const code = parseInt(line.replace('__USERNODE_EXIT__', '').trim(), 10);
    state.exitCode = Number.isFinite(code) ? code : -1;
    state.execExitSeen = true;
    return;
  }
  if (line.startsWith('__USERNODE_WARN__')) {
    const msg = line.replace('__USERNODE_WARN__', '').trim();
    log.warn('worker', msg);
    // Surface runner warnings ("resume failed (exit N); retrying fresh",
    // "push failed", …) in the session's progress log too — both the
    // interactive and headless paths persist onProgress lines, so a
    // reviewer reading a failed auto session can see what happened
    // without server-log access.
    onProgress(`⚠ ${msg}`);
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
    // #8: how many commits the branch is behind origin/main, parsed from
    // run-cc.sh's __USERNODE_RESULT__ line. Persisted to
    // chat_sessions.behind_main on every turn so the dev-chat banner
    // and merge-time block always reflect the latest state.
    behind: 0,
    sha: null,
    pushOk: false,
    // #8: clean|resolved|conflict|already_synced (MODE=sync only). The
    // route handler routes the chat message off this.
    syncResult: null,
    // #361: conflicted file paths from a MODE=sync turn's
    // __USERNODE_RESULT__ line. Defaults empty.
    conflictFiles: [],
    phase: null,
    fatalError: null,
    resultSeen: false,
    // True once the detached-exec wrapper's __USERNODE_EXIT__ line has
    // been parsed from the turn journal (detached transport only).
    execExitSeen: false,
    // Why a markerless turn (exitCode -1, no __USERNODE_EXIT__ line) was
    // declared dead: 'container_gone' | 'oom_killed' |
    // 'probe_unobservable' | 'turn_process_gone'. Null for turns that
    // ended with a marker. Routes use this for cause-specific failure
    // messages instead of a bare "-1".
    markerlessCause: null,
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
  //
  // CLAUDE_CODE_CACHE_BUST (today's UTC date) busts the
  // `npm install -g @anthropic-ai/claude-code` layer once per calendar
  // day so the worker tracks the latest CLI. Without this, that layer is
  // cached indefinitely and the worker freezes at a stale CLI version —
  // newer models (Sonnet 4.6 / Opus 4.8) then 400 with
  // "thinking.type.enabled is not supported for this model" because the
  // old CLI emits the legacy thinking shape. Day-granular so steady-state
  // session bootstraps stay cache-fast (no per-session npm reinstall).
  const path = require('path');
  const workerDir = path.join(__dirname, '../../worker');
  const cacheBust = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  log.info('worker', 'Building worker image', { dir: workerDir, cacheBust });
  await docker.buildImage(workerDir, WORKER_IMAGE, {
    CLAUDE_CODE_CACHE_BUST: cacheBust,
  });
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

// Per-turn journal file inside the CC volume (/home/node/.claude). The
// detached `docker exec` wrapper redirects run-cc.sh's combined output
// here so the turn's progress stream survives a platform restart: the
// volume outlives both the exec and the platform process, and the boot
// adoption path can replay the file from line 0 to pick the turn back
// up. One turn per session is in flight at a time (enforced via the
// warm registry), so the timestamp suffix only disambiguates the
// current turn from stale leftovers (which the wrapper rm's first).
function turnJournalPath(turnId) {
  return `/home/node/.claude/turn-${turnId}.log`;
}

// ──────────────────────────────────────────────────────────────────────
// Durable turn records (chat_sessions.active_turn)
// ──────────────────────────────────────────────────────────────────────
//
// Written before the detached dispatch and cleared when the journal has
// been consumed to completion. If the platform dies mid-turn the record
// survives, and server.js's adoption path resumes the turn from its
// journal instead of killing the in-container claude.
//
// The pool singleton is created by server.js at boot, long before any
// turn can run, so the bare getPool() here never constructs.
function _getPoolSafe() {
  try {
    return require('../db/pool').getPool();
  } catch {
    return null;
  }
}

async function _persistActiveTurn(sessionId, turn) {
  const pool = _getPoolSafe();
  if (!pool) return;
  try {
    await pool.query(
      'UPDATE chat_sessions SET active_turn = $1 WHERE id = $2',
      [JSON.stringify(turn), sessionId]
    );
  } catch (err) {
    log.warn('worker', 'Failed to persist active_turn', { sessionId, err: err.message });
  }
}

async function clearActiveTurn(sessionId) {
  const pool = _getPoolSafe();
  if (!pool) return;
  try {
    await pool.query(
      'UPDATE chat_sessions SET active_turn = NULL WHERE id = $1',
      [sessionId]
    );
  } catch (err) {
    log.warn('worker', 'Failed to clear active_turn', { sessionId, err: err.message });
  }
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

// Run one CC turn inside an already-warm container, detached: the exec
// is dispatched with `docker exec -d`, its output lands in a journal
// file in the CC volume, and we follow the journal through the shared
// `parseLine` state machine. The dev-chat UI sees identical progress
// markers to the old attached transport — but the turn itself survives
// a platform restart (boot adoption resumes it via the
// chat_sessions.active_turn record + resumeTurnFromJournal).
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
  // Legacy callback: the attached transport used to hand the host-side
  // `docker exec` child to the route handler for SIGTERM-based stops.
  // The detached transport has no such child — stops go through
  // stopTurn() — so this is invoked with null purely for back-compat.
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
  // Scout mode: omit WORKER_JWT so usernode-push has no way to
  // authenticate against the platform's push proxy, regardless of how
  // CC may try to invoke it. ANTHROPIC_API_KEY still gets the JWT when
  // we're routing through the Anthropic proxy — the proxy authenticates
  // request-scoped JWTs for the Anthropic round-trip itself, so dropping
  // it would break LLM access entirely. Build mode keeps both: the
  // commit/push block in run-cc.sh runs, and usernode-push needs the
  // JWT to push the session branch.
  // ISSUES_JWT is a read-only, session-scoped token for the usernode-issues
  // CLI (GET /api/internal/sessions/:id/issues). It's the SAME minted JWT as
  // WORKER_JWT but handed over under a distinct env var so scout — which
  // never gets WORKER_JWT, and so cannot push — can still read public
  // issues. Both modes get it; usernode-push remains gated on WORKER_JWT.
  const secretEnv = mode === 'scout'
    ? {
        ANTHROPIC_API_KEY: useProxy ? workerJwt : anthropicApiKey,
        ISSUES_JWT: workerJwt,
      }
    : {
        ANTHROPIC_API_KEY: useProxy ? workerJwt : anthropicApiKey,
        WORKER_JWT: workerJwt,
        ISSUES_JWT: workerJwt,
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
  // Journal transport: the turn runs DETACHED from this process. The
  // wrapper below redirects run-cc.sh's combined output to a journal
  // file in the CC volume and appends __USERNODE_EXIT__ <code> when it
  // finishes. We then tail the journal from line 0. If the platform
  // restarts mid-turn, the exec keeps running, the journal keeps
  // filling, and the boot adoption path resumes via the same consumer
  // (resumeTurnFromJournal) using the chat_sessions.active_turn record.
  const turnId = Date.now();
  const journal = turnJournalPath(turnId);
  safeEnv.TURN_JOURNAL = journal;

  const secretEnvArgs = Object.keys(secretEnv).flatMap((k) => ['-e', k]);
  const safeEnvArgs = Object.entries(safeEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const args = [
    'exec', '-d',
    ...secretEnvArgs,
    ...safeEnvArgs,
    containerName,
    'sh', '-c',
    // rm stale journals first so the tailer's existence-wait can't latch
    // onto a leftover file from a previous turn.
    'rm -f /home/node/.claude/turn-*.log 2>/dev/null; '
      + '/usr/local/bin/run-cc.sh > "$TURN_JOURNAL" 2>&1; '
      + 'echo "__USERNODE_EXIT__ $?" >> "$TURN_JOURNAL"',
  ];

  // #361: record the in-flight turn's mode in the warm registry so the
  // Anthropic proxy can synchronously tell a sync turn from a build turn
  // and gate it against the system-token budget instead of the owner's.
  _registryUpsert(sessionId, { inFlight: true, activeTurnMode: mode });
  await _persistActiveTurn(sessionId, {
    mode,
    journal,
    model: models.resolve(model),
    startedAt: new Date().toISOString(),
    // #174: billing context for restart-resume — the resume paths debit
    // the recovered costUsd into the bucket the turn actually billed,
    // even if the user adds/removes their key while the turn is detached.
    byok: !!anthropicApiKey,
  });

  try {
    // Dispatch. `docker exec -d` returns as soon as the exec is created;
    // secrets travel via the docker CLI's env (bare `-e KEY`), same as
    // the attached transport did.
    await docker.execFileAsync('docker', args, {
      timeout: 30000,
      env: { ...process.env, ...secretEnv },
    });
    // onChild is legacy: there is no host-side child that owns the turn
    // anymore. Stop semantics live in stopTurn() (in-container pkill).
    if (typeof onChild === 'function') {
      try { onChild(null); } catch {}
    }

    const state = newWatchState();
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    await _consumeJournal(containerName, journal, progress, state, { sessionId });

    // Successful, complete turns don't need their journal anymore; failed
    // or markerless ones keep it on disk for debugging (the next turn's
    // wrapper rm's it).
    if (state.execExitSeen && !state.fatalError) {
      docker.execFileAsync('docker', [
        'exec', containerName, 'rm', '-f', journal,
      ], { timeout: 5000 }).catch(() => {});
    }
    return state;
  } finally {
    _registryUpsert(sessionId, { inFlight: false, lastUsedMs: Date.now(), activeTurnMode: null });
    await clearActiveTurn(sessionId);
  }
}

// #361: synchronous read of the mode of the turn currently in flight for
// a session ('build' | 'sync' | 'scout' | …), or null when idle. Used by
// the Anthropic proxy to route sync turns onto the system-token cap.
function getActiveTurnMode(sessionId) {
  const meta = _warmRegistry.get(Number(sessionId));
  return (meta && meta.inFlight) ? (meta.activeTurnMode || null) : null;
}

// ──────────────────────────────────────────────────────────────────────
// Liveness-watchdog strike accounting
// ──────────────────────────────────────────────────────────────────────
//
// isWorkerExecuting is tri-state: true (turn process present), false
// (definite idle — the probe ran and found no turn process), null (the
// probe ITSELF failed: docker exec timed out, daemon contended, spawn
// error). A null says nothing about the turn — auto-solve workloads
// routinely contend the docker daemon for tens of seconds — so probe
// failures must NOT count toward the cheap 2-strike idle abandonment.
// They get their own, much larger consecutive budget before the turn is
// declared unobservable. Extracted as pure helpers so the policy is
// unit-testable without docker.
const WATCHDOG_INTERVAL_MS = 10000;
const WATCHDOG_PROBE_TIMEOUT_MS = 15000;
const WATCHDOG_IDLE_STRIKE_LIMIT = 2;
const WATCHDOG_PROBE_FAILURE_LIMIT = 12;
// After the watchdog abandons a tail, a `docker inspect` showing the
// container still running buys the turn another tail cycle (a
// late-arriving __USERNODE_EXIT__ marker is then consumed normally).
// Bounded so a permanently unobservable turn still resolves.
const WATCHDOG_MAX_RETAILS = 3;

function newWatchdogCounters() {
  return { idleStrikes: 0, probeFailures: 0 };
}

// Fold one probe result into the counters. Returns { abandon, cause }:
// abandon=true with 'turn_process_gone' after two consecutive definite
// idles (the wrapper's final `echo >> journal` gets one interval to
// flush), or with 'probe_unobservable' once the consecutive
// probe-failure budget is exhausted.
function recordWatchdogProbe(counters, busy) {
  if (busy === true) {
    counters.idleStrikes = 0;
    counters.probeFailures = 0;
    return { abandon: false, cause: null };
  }
  if (busy === false) {
    counters.idleStrikes += 1;
    // The probe itself succeeded, so the consecutive-failure run ends.
    counters.probeFailures = 0;
    return counters.idleStrikes >= WATCHDOG_IDLE_STRIKE_LIMIT
      ? { abandon: true, cause: 'turn_process_gone' }
      : { abandon: false, cause: null };
  }
  counters.probeFailures += 1;
  return counters.probeFailures >= WATCHDOG_PROBE_FAILURE_LIMIT
    ? { abandon: true, cause: 'probe_unobservable' }
    : { abandon: false, cause: null };
}

// Positive evidence of container death for the markerless-turn path.
// Returns { status, oomKilled } — status 'gone' when docker says the
// container doesn't exist — or null when inspect itself failed (daemon
// contended), i.e. we still don't know.
async function inspectContainerState(containerName) {
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'inspect', '--format', '{{.State.Status}} {{.State.OOMKilled}}', containerName,
    ], { timeout: WATCHDOG_PROBE_TIMEOUT_MS });
    const [status, oom] = stdout.trim().split(/\s+/);
    return { status: status || 'unknown', oomKilled: oom === 'true' };
  } catch (err) {
    const msg = String((err && (err.stderr || err.message)) || '');
    if (/no such (object|container)/i.test(msg)) return { status: 'gone', oomKilled: false };
    return null;
  }
}

// Follow a turn journal until the __USERNODE_EXIT__ marker lands (turn
// finished) or the turn process is verifiably gone (killed / OOM — no
// marker will ever come). Feeds every line through the shared parseLine
// state machine, so the resolved `state` matches the attached
// transport's shape exactly.
//
// The tail itself is a disposable `docker exec`; if it drops while the
// turn is still running (docker hiccup, etc.) we restart it and skip
// the lines we already consumed.
async function _consumeJournal(containerName, journal, progress, state, { sessionId = null } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let linesConsumed = 0;
  let retails = 0;
  // Why the watchdog killed the most recent tail, when it did.
  let watchdogCause = null;

  const consume = (line) => {
    state.rawStdout += `${line}\n`;
    parseLine(line, progress, state);
  };

  for (;;) {
    watchdogCause = null;
    const counters = newWatchdogCounters();
    await new Promise((resolve) => {
      // Wait for the wrapper to create the journal, then follow it from
      // the top. `exec tail` so the pid the shell reports is tail itself.
      const proc = spawn('docker', [
        'exec', containerName, 'sh', '-c',
        `n=0; while [ ! -f "${journal}" ]; do n=$((n+1)); [ "$n" -gt 300 ] && exit 86; sleep 0.1; done; exec tail -n +1 -f "${journal}"`,
      ]);

      let done = false;
      let buf = '';
      let skip = linesConsumed;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(liveness);
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      };

      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (skip > 0) { skip -= 1; continue; }
          linesConsumed += 1;
          consume(line);
          if (state.execExitSeen) return finish();
        }
      });
      proc.stderr.on('data', () => {});
      proc.on('close', finish);
      proc.on('error', finish);

      // Watchdog: `tail -f` never exits on its own, so detect the case
      // where the turn died without writing the exit marker (stopTurn
      // pkill, OOM kill). The probe is purely a safety net — the journal
      // tail is the real-time channel — so the long timeout/interval is
      // harmless, and only DEFINITE idles use the cheap 2-strike
      // abandonment; probe failures get the larger budget above.
      const liveness = setInterval(async () => {
        if (done) return;
        const busy = await isWorkerExecuting(containerName, { timeoutMs: WATCHDOG_PROBE_TIMEOUT_MS });
        if (done) return;
        const verdict = recordWatchdogProbe(counters, busy);
        if (busy === null) {
          log.warn('worker', 'Turn liveness probe failed', {
            containerName, sessionId, journal,
            consecutiveFailures: counters.probeFailures,
          });
        }
        if (verdict.abandon) {
          watchdogCause = verdict.cause;
          finish();
        }
      }, WATCHDOG_INTERVAL_MS);
    });

    if (state.execExitSeen) return state;

    // Tail ended without an exit marker. If the turn is still running
    // (transient tail/docker failure), restart the tail; otherwise we
    // need positive evidence of death before giving up.
    const busy = await isWorkerExecuting(containerName, { timeoutMs: WATCHDOG_PROBE_TIMEOUT_MS });
    if (busy === true) {
      await sleep(1000);
      continue;
    }

    // Verify against docker itself: if the container is still running
    // and no probe definitively saw the turn process gone, re-tail
    // (bounded) instead of abandoning a possibly-healthy turn. This also
    // lets a marker that lands seconds late be consumed normally instead
    // of racing the one-shot `cat` below.
    const inspected = await inspectContainerState(containerName);
    if (
      inspected && inspected.status === 'running' && !inspected.oomKilled
      && busy !== false && watchdogCause !== 'turn_process_gone'
      && retails < WATCHDOG_MAX_RETAILS
    ) {
      retails += 1;
      log.warn('worker', 'Turn unobservable but container still running — re-tailing journal', {
        containerName, sessionId, journal, retails, maxRetails: WATCHDOG_MAX_RETAILS,
      });
      await sleep(1000);
      continue;
    }

    // Final non-follow read to catch anything the tail missed, then
    // give up with whatever state we accumulated.
    try {
      const { stdout } = await docker.execFileAsync('docker', [
        'exec', containerName, 'cat', journal,
      ], { timeout: 10000 });
      const lines = stdout.split('\n');
      for (let i = linesConsumed; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        linesConsumed += 1;
        consume(line);
        if (state.execExitSeen) break;
      }
    } catch {
      // Container (or journal) gone — nothing more to read.
    }
    if (!state.execExitSeen && state.exitCode == null) {
      // Turn vanished without a marker: stopped, killed, or unobservable.
      state.exitCode = -1;
      if (inspected && inspected.oomKilled) {
        state.markerlessCause = 'oom_killed';
      } else if (inspected && inspected.status !== 'running') {
        // Covers 'gone' (no such container) and exited/dead containers.
        state.markerlessCause = 'container_gone';
      } else if (busy === false || watchdogCause === 'turn_process_gone') {
        // Definite idle — stopTurn kills and in-container OOM of the
        // wrapper both land here.
        state.markerlessCause = 'turn_process_gone';
      } else {
        state.markerlessCause = 'probe_unobservable';
      }
      log.warn('worker', 'Turn ended without an exit marker', {
        sessionId, containerName, journal, linesConsumed,
        cause: state.markerlessCause,
        inspect: inspected ? `${inspected.status} oom=${inspected.oomKilled}` : 'unavailable',
        retails,
      });
    }
    return state;
  }
}

// Stop the in-flight turn for a session by killing run-cc.sh + claude
// inside the container. The warm wrapper (sleep infinity) survives, so
// the container stays adoptable for the next dispatch. The journal
// consumer notices the process is gone via its liveness watchdog and
// resolves without an exit marker (exitCode -1).
async function stopTurn(sessionId) {
  const meta = _registryGet(sessionId);
  const containerName = meta?.containerName || workerContainerName(sessionId);
  await docker.execFileAsync('docker', [
    'exec', containerName, 'sh', '-c', TURN_PROC_KILL_SCRIPT,
  ], { timeout: 5000 }).catch(() => {});
  log.info('worker', 'Stop signal sent (in-container turn-process kill)', { containerName, sessionId });
}

// Boot-time resume: pick an in-flight (or finished-while-we-were-down)
// turn back up from its journal. The caller (server.js adoption) owns
// post-turn processing and clearing chat_sessions.active_turn; this
// just replays/follows the journal and returns the watch state, exactly
// as if execInWorker had stayed attached the whole time.
async function resumeTurnFromJournal(sessionId, { journal, onProgress } = {}) {
  if (!journal) throw new Error('resumeTurnFromJournal: journal path required');
  const meta = _registryGet(sessionId);
  const containerName = meta?.containerName || workerContainerName(sessionId);
  _registryUpsert(sessionId, { inFlight: true, adopted: true });
  try {
    const state = newWatchState();
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    await _consumeJournal(containerName, journal, progress, state, { sessionId });
    if (state.execExitSeen && !state.fatalError) {
      docker.execFileAsync('docker', [
        'exec', containerName, 'rm', '-f', journal,
      ], { timeout: 5000 }).catch(() => {});
    }
    return state;
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

// Match a turn process (run-cc.sh wrapper, run-cc.sh itself, or the
// claude CLI) by full cmdline. The anchors keep paths like
// /home/node/.claude/turn-X.log (our tail/cat execs) from matching —
// "claude" there is preceded by "." and followed by "/", neither of
// which the pattern accepts. The probe scripts below also exclude
// their own pid, and their script text can't self-match ("run-cc\.sh"
// in the text has a literal backslash; "claude" is preceded by "(").
//
// IMPORTANT: these walk /proc with sh + grep instead of pgrep/pkill —
// the worker image (node:22-bookworm-slim) does NOT ship procps, so
// pgrep/pkill exit 127 in there. The old `pgrep ... && busy || idle`
// one-liner silently reported "idle" for every container, busy or not.
const TURN_PROC_RE = '(^|[ /])(claude|run-cc\\.sh)( |$)';
const TURN_PROC_PROBE_SCRIPT =
  'busy=0; for d in /proc/[0-9]*; do '
  + '[ "$d" = "/proc/$$" ] && continue; '
  + 'c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; '
  + `printf "%s" "$c" | grep -qE '${TURN_PROC_RE}' && { busy=1; break; }; `
  + 'done; [ "$busy" = "1" ] && echo busy || echo idle';
const TURN_PROC_KILL_SCRIPT =
  'for d in /proc/[0-9]*; do '
  + '[ "$d" = "/proc/$$" ] && continue; '
  + 'c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null) || continue; '
  + `printf "%s" "$c" | grep -qE '${TURN_PROC_RE}' && kill -TERM "\${d#/proc/}" 2>/dev/null; `
  + 'done; exit 0';

// Best-effort check of whether a running warm container has an in-flight
// per-turn exec. We look for a turn process inside the container — the
// sleep wrapper is always there, but run-cc.sh/claude are only present
// while a turn is executing.
//
// Returns:
//   true   — claude (or its parent run-cc.sh) is currently executing
//   false  — only the sleep wrapper is alive
//   null   — couldn't determine (container not running, exec failed, etc.)
//
// `timeoutMs` is overridable because the journal watchdog deliberately
// runs the probe with a generous timeout (the probe is a safety net, not
// the real-time channel); other callers keep the snappy default.
async function isWorkerExecuting(containerName, { timeoutMs = 5000 } = {}) {
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'exec', containerName, 'sh', '-c', TURN_PROC_PROBE_SCRIPT,
    ], { timeout: timeoutMs });
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

// #155: copy one session's CC memory volume (~/.claude) into another
// session's volume, so a dev chat cloned from a headless auto session can
// `--resume` the auto session's Claude Code conversation. Uses the worker
// image (always present locally — staging/CC builds keep it warm) for the
// one-shot copy container, so no registry pull is needed. Throws when the
// source volume doesn't exist or the copy fails; callers treat a clone
// failure as "start with fresh CC memory" (cc_session_id stays NULL).
async function cloneCcVolume(srcSessionId, destSessionId) {
  const src = ccVolumeName(srcSessionId);
  const dest = ccVolumeName(destSessionId);
  // Throws if the source volume was never created (e.g. the headless run
  // failed before its first worker bootstrap).
  await docker.execFileAsync('docker', ['volume', 'inspect', src], { timeout: 5000 });
  await docker.ensureVolume(dest);
  // Run the copy as root (`--user 0:0`). A freshly-created named volume is
  // owned root:root (0755), but the worker image's default user is non-root,
  // so a non-root copy container can't create entries under /to — the exact
  // failures seen cloning chat 735 ("cp: cannot create directory
  // '/to/./backups': Permission denied", "cp: preserving times for '/to/.':
  // Operation not permitted"), which left the clone with fresh CC memory.
  // `cp -a` still preserves each source entry's original uid/gid, so the
  // worker user can read its own ~/.claude files afterward.
  await docker.execFileAsync('docker', [
    'run', '--rm',
    '--user', '0:0',
    '-v', `${src}:/from:ro`,
    '-v', `${dest}:/to`,
    '--entrypoint', 'sh',
    WORKER_IMAGE,
    '-c', 'cp -a /from/. /to/',
  ], { timeout: 60000 });
  log.info('worker', 'CC volume cloned', { from: src, to: dest });
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
  stopTurn,
  resumeTurnFromJournal,
  clearActiveTurn,
  evictWorker,
  warmRegistrySnapshot,
  adoptWarmWorker,
  isInFlight,
  isWorkerExecuting,
  getActiveTurnMode,
  // legacy / shared helpers
  watchWorker,
  listOrphanWorkers,
  destroyWorker,
  destroyCcVolume,
  cloneCcVolume,
  parseClaudeResponse,
  // exposed for unit tests (watchdog strike policy + line parsing)
  newWatchState,
  parseLine,
  newWatchdogCounters,
  recordWatchdogProbe,
  // exposed for the routes' container-name lookups
  workerContainerName,
  // platform-side git push proxy (called from src/routes/internal.js)
  execPushFromWorker,
  mintWorkerJwt,
};
