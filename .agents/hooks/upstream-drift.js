'use strict';

// Checkout freshness check for coding agents (AGENTS.md, "Check that this
// checkout is current before you read or write code").
//
// Sessions are often started on a user's fork whose default branch sits far
// behind the platform's canonical main, and nothing inside the checkout says
// so: `git fetch origin` compares it with the fork, which is current with
// itself. This asks the canonical repository where main is and, when HEAD
// does not contain that commit, puts a short notice in front of the agent
// before it reads anything.
//
// Advisory only. Offline, no git, a slow network, a hosted worker: each of
// those is silence and exit 0, so the check can never block a session. That
// also means silence is not proof the checkout is current.
//
// Wired into:
//   Claude Code  .claude/settings.json, SessionStart
//   Codex        the generated project config, UserPromptSubmit, first
//                prompt of each session only (src/cli/main.js setupToml)
//   OpenCode     .opencode/plugins/upstream-drift.js, a link to
//                opencode-upstream-drift.js in this directory
// Homeroom's hosted workers set SOCIAL_VIBECODING_DRIFT_CHECK=off
// (worker/Dockerfile): the harness fixes their base commit.

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CANONICAL_REPO = 'https://github.com/Usernode-Labs/social-vibecoding';
const CANONICAL_BRANCH = 'main';
const OPT_OUT_ENV = 'SOCIAL_VIBECODING_DRIFT_CHECK';
const REMOTE_TIMEOUT_MS = 4000;
const LOCAL_TIMEOUT_MS = 2000;
const SHA_RE = /^[0-9a-f]{40}$/;
const HOOK_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

// Resolves { status, stdout }; status is the exit code, or null when git
// could not run or was killed by the timeout. Never rejects.
function runGit(args, { cwd, timeout }) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (error, stdout) => {
      if (!error) {
        resolve({ status: 0, stdout: stdout || '' });
        return;
      }
      resolve({
        status: typeof error.code === 'number' && !error.killed ? error.code : null,
        stdout: stdout || '',
      });
    });
  });
}

// { state: 'current' | 'behind' | 'unknown', headSha?, upstreamSha? }
async function checkDrift({
  cwd = process.cwd(), git = runGit, repo = CANONICAL_REPO, branch = CANONICAL_BRANCH,
} = {}) {
  const head = await git(['rev-parse', 'HEAD'], { cwd, timeout: LOCAL_TIMEOUT_MS });
  const headSha = head.status === 0 ? head.stdout.trim() : '';
  if (!SHA_RE.test(headSha)) return { state: 'unknown' };

  const ref = `refs/heads/${branch}`;
  const remote = await git(['ls-remote', repo, ref], { cwd, timeout: REMOTE_TIMEOUT_MS });
  const line = remote.status === 0
    ? remote.stdout.split('\n').find((entry) => entry.endsWith(`\t${ref}`))
    : null;
  const upstreamSha = line ? line.slice(0, line.indexOf('\t')) : '';
  if (!SHA_RE.test(upstreamSha)) return { state: 'unknown', headSha };
  if (upstreamSha === headSha) return { state: 'current', headSha, upstreamSha };

  const ancestor = await git(
    ['merge-base', '--is-ancestor', upstreamSha, 'HEAD'],
    { cwd, timeout: LOCAL_TIMEOUT_MS }
  );
  if (ancestor.status === 0) return { state: 'current', headSha, upstreamSha };
  // 1: HEAD does not contain it. 128: this clone has never seen the commit,
  // so HEAD's history cannot contain it either.
  if (ancestor.status === 1 || ancestor.status === 128) {
    return { state: 'behind', headSha, upstreamSha };
  }
  return { state: 'unknown', headSha, upstreamSha };
}

function driftNotice({ headSha, upstreamSha }) {
  return [
    `Checkout freshness: HEAD ${headSha.slice(0, 12)} does not contain the platform's canonical main`,
    `(Usernode-Labs/social-vibecoding main is at ${upstreamSha}).`,
    'This checkout, often a fork, may describe code that has since changed.',
    `To answer a question about current behavior, read the canonical code: git fetch ${CANONICAL_REPO} main,`,
    'then git show FETCH_HEAD:<path> or git grep <pattern> FETCH_HEAD.',
    'To change code, start from the exact base commit your work order (prepare_work) or proposal_start gives;',
    'never merge or rebase onto upstream main yourself. A proposal branch already under way keeps its base.',
    'See AGENTS.md, "Check that this checkout is current".',
  ].join(' ');
}

function disabled(env) {
  return String(env[OPT_OUT_ENV] || '').trim().toLowerCase() === 'off';
}

// The notice text when HEAD is behind, otherwise null.
async function noticeFor({ cwd, env = process.env, git = runGit } = {}) {
  if (disabled(env)) return null;
  const drift = await checkDrift({ cwd, git });
  return drift.state === 'behind' ? driftNotice(drift) : null;
}

// Per user, so a shared tmp never leaves one account unable to write
// another's markers.
function defaultMarkerDir() {
  const user = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `social-vibecoding-drift-${user}`);
}

// Codex runs UserPromptSubmit on every prompt. The first prompt of a session
// gets the check; later ones are skipped before any network call, unless
// HEAD moved in between.
function claimFirstPrompt(sessionId, headSha, markerDir) {
  const key = crypto.createHash('sha256').update(`${sessionId}\0${headSha}`).digest('hex');
  try {
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(markerDir, key), '', { flag: 'wx' });
    return true;
  } catch (error) {
    // EEXIST: an earlier prompt already ran it. Anything else (a read-only
    // tmp): check every prompt rather than never.
    return error.code !== 'EEXIST';
  }
}

async function processHook(input, {
  env = process.env, git = runGit, markerDir = defaultMarkerDir(),
} = {}) {
  if (!input || typeof input !== 'object' || disabled(env)) return null;
  const event = input.hook_event_name;
  if (!HOOK_EVENTS.has(event)) return null;
  const cwd = typeof input.cwd === 'string' && path.isAbsolute(input.cwd)
    ? input.cwd
    : process.cwd();

  if (event === 'UserPromptSubmit') {
    if (typeof input.session_id !== 'string' || !input.session_id) return null;
    const head = await git(['rev-parse', 'HEAD'], { cwd, timeout: LOCAL_TIMEOUT_MS });
    const headSha = head.status === 0 ? head.stdout.trim() : '';
    if (!SHA_RE.test(headSha) || !claimFirstPrompt(input.session_id, headSha, markerDir)) {
      return null;
    }
  }

  const text = await noticeFor({ cwd, env, git });
  if (!text) return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

// OpenCode plugin body; opencode-upstream-drift.js is the ESM entry point.
// The check starts when the plugin loads and its result is appended to the
// system prompt of every model request, the way the promotion guard's
// attestation is.
function createOpenCodeUpstreamDrift({ worktree, directory } = {}, { env = process.env, git = runGit } = {}) {
  const candidate = worktree || directory;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return {};
  const pending = noticeFor({ cwd: candidate, env, git }).catch(() => null);
  return {
    'experimental.chat.system.transform': async (input, output) => {
      const text = await pending;
      if (!text || !input?.sessionID || !Array.isArray(output?.system)) return;
      if (output.system.some((part) => typeof part === 'string' && part.includes(text))) return;
      if (output.system.length === 0) {
        output.system.push(text);
      } else if (typeof output.system[0] === 'string') {
        output.system[0] = `${output.system[0]}\n\n${text}`;
      }
    },
  };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let input;
    try {
      input = JSON.parse(raw || '{}');
    } catch {
      return;
    }
    processHook(input)
      .then((result) => {
        if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
      })
      .catch(() => {});
  });
}

module.exports = {
  CANONICAL_REPO,
  OPT_OUT_ENV,
  checkDrift,
  driftNotice,
  noticeFor,
  processHook,
  createOpenCodeUpstreamDrift,
  main,
};

if (require.main === module) main();
