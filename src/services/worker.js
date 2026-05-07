'use strict';

const { spawn } = require('child_process');
const log = require('./logger');
const docker = require('./docker');
const github = require('./github');

const WORKER_IMAGE = 'usernode-worker:latest';
const WORKER_MEMORY = '2g';
const WORKER_CPUS = '2';

// ──────────────────────────────────────────────────────────────────────
// Stream-json / marker parsing
// ──────────────────────────────────────────────────────────────────────
//
// Claude Code emits one JSON object per stdout line (`--output-format
// stream-json --verbose`). The worker entrypoint additionally emits a
// handful of sentinel lines the host relies on:
//
//   __USERNODE_PHASE__  <phase>                        status transitions
//   __USERNODE_RESULT__ cc_exit=N ahead=N sha=… push_ok=N   final summary
//   __USERNODE_WARN__   <msg>                          non-fatal issue
//   __USERNODE_ERROR__  <msg>                          fatal, bail out
//
// Everything else is treated as a plain progress line (git output, etc.).

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
// Image + spawn
// ──────────────────────────────────────────────────────────────────────

async function ensureWorkerImage() {
  // Always build; Docker's layer cache makes this fast when nothing's
  // changed, and crucially picks up edits to worker-run.sh without
  // requiring a manual `docker rmi`.
  const path = require('path');
  const workerDir = path.join(__dirname, '../../worker');
  log.info('worker', 'Building worker image', { dir: workerDir });
  await docker.buildImage(workerDir, WORKER_IMAGE);
}

// Spawns a worker container that autonomously runs the full dev-session
// pipeline (clone → claude → commit → push). Returns the container name.
// The caller is expected to follow up with `watchWorker` to stream
// progress and collect the final result.
// Docker-volume name used to persist Claude Code's on-disk session memory
// (~/.claude) for a given chat session. Reused across every turn of the
// same chat so `--resume <cc_session_id>` can replay context from disk.
function ccVolumeName(sessionId) {
  return `usernode-cc-${sessionId}`;
}

async function spawnWorker(sessionId, {
  repoOwner,
  repoName,
  branchName,
  anthropicApiKey,
  prompt,
  model,
  commitMsg,
  resumeSessionId,
  // 'build' (default) runs the existing CC + commit + push pipeline.
  // 'scout' runs CC in --permission-mode plan with no commit/push, used
  // by the spec-stage scout dispatch to draft a grounded markdown spec.
  mode = 'build',
}) {
  const containerName = `usernode-worker-${sessionId}`;

  // If a previous run left a container behind, wipe it first. Recovery
  // should have handled cleanup already, but be defensive.
  await docker.stopAndRemove(containerName).catch(() => {});

  const cloneUrl = await github.getCloneUrl(repoOwner, repoName);
  const pat = process.env.GITHUB_BOT_TOKEN || '';

  // Make sure the persistent CC volume exists; worker-run.sh will mount
  // it at /home/node/.claude so `claude --resume <id>` sees prior state.
  const ccVolume = ccVolumeName(sessionId);
  await docker.ensureVolume(ccVolume);

  // BYOK safety (#30): we split container env into two groups.
  //
  // `SECRET_ENV` are secrets that must NEVER appear in the docker CLI
  // argv — doing so would expose them in `ps` on the host (briefly)
  // and, far worse, in `err.cmd`/`err.message` on every `execFile`
  // failure, which `log.warn` then writes to the log file. Instead we
  // reference them with bare `-e KEY` (no `=value`) so Docker reads
  // the values from its own process env, and we set that env on the
  // `execFile` child only. Values end up in /proc/<docker-pid>/environ
  // (root/same-user readable, not argv-visible).
  //
  // `safeEnv` holds the non-secret args that stay inline — they're
  // logged and visible in ps, which is fine.
  const secretEnv = {
    ANTHROPIC_API_KEY: anthropicApiKey || '',
    PAT: pat,
    CLONE_URL: cloneUrl, // contains an embedded GitHub token
  };
  const safeEnv = {
    GIT_AUTHOR_NAME: 'usernode-bot',
    GIT_AUTHOR_EMAIL: 'usernode-bot@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'usernode-bot',
    GIT_COMMITTER_EMAIL: 'usernode-bot@users.noreply.github.com',
    BRANCH: branchName,
    PROMPT: prompt,
    MODEL: model || 'claude-sonnet-4-6',
    COMMIT_MSG: commitMsg || 'Changes via Usernode',
    // Empty means "fresh session, let CC mint a new id"; non-empty means
    // pass through --resume to CC and reuse the on-disk conversation.
    CLAUDE_RESUME_SESSION_ID: resumeSessionId || '',
    // 'build' or 'scout' — read by worker-run.sh to choose between the
    // edit + commit + push pipeline and the read-only plan-mode path.
    MODE: mode,
  };
  const secretEnvArgs = Object.keys(secretEnv).flatMap((k) => ['-e', k]);
  const safeEnvArgs = Object.entries(safeEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const network = process.env.DOCKER_NETWORK || 'shared-web';

  // NOTE: no --rm — we want the container to stick around after exit so
  // that on a server restart we can still read its logs and determine
  // whether it finished successfully.
  const args = [
    'run', '-d',
    '--name', containerName,
    '--hostname', containerName,
    '--network', network,
    '--memory', WORKER_MEMORY,
    '--cpus', WORKER_CPUS,
    '--security-opt', 'no-new-privileges:true',
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
  log.info('worker', 'Worker spawned (autonomous)', {
    containerName,
    ccVolume,
    resume: Boolean(resumeSessionId),
  });
  return containerName;
}

// Remove the named CC volume for a given chat session. Called when the
// session is archived (permanent teardown). Safe to call even if the
// volume was never created.
async function destroyCcVolume(sessionId) {
  await docker.removeVolume(ccVolumeName(sessionId));
}

// ──────────────────────────────────────────────────────────────────────
// Log watching
// ──────────────────────────────────────────────────────────────────────

// Tail a worker container's logs until the container exits, parsing
// stream-json + USERNODE markers along the way. Resolves with the
// accumulated state when the container is gone.
//
// `fromStart`:
//   true  (default): emit/parse from the beginning of the log. Used by
//                    fresh spawns so we don't miss the opening phases.
//   false:           only follow new output (useful on recovery if the
//                    caller doesn't want to re-replay progress they've
//                    already seen — though currently we always replay).
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
// Used on server startup to adopt any workers that were running (or
// have since finished) while the previous server instance was down.
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

async function destroyWorker(containerName) {
  await docker.stopAndRemove(containerName).catch(() => {});
  log.info('worker', 'Worker destroyed', { containerName });
}

module.exports = {
  ensureWorkerImage,
  spawnWorker,
  watchWorker,
  listOrphanWorkers,
  destroyWorker,
  destroyCcVolume,
  parseClaudeResponse,
};
