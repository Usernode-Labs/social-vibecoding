#!/usr/bin/env node
'use strict';

// A Claude Code Stop hook for the Homeroom bot's build turns: it sends the
// agent back to work when it tries to end a turn that has changed nothing.
//
// In Claude Code a reply with no tool call ends the turn. About half of the
// bot's "the build produced no change to propose" failures were GLM 5.3
// Flash doing exactly that within seconds: one or two commands, a few hundred
// output tokens, a text answer, and the turn was over (bot runs 138, 435,
// 533, 673; 1166 had a 49k-character spec and quit after one shell command in
// 34 s). Others worked for minutes and still ended with nothing to commit
// (runs 1, 591, 596). The requester was told the bot had no changes to show.
//
// Installed by run-cc.sh (`claude --settings`) only when the platform asks
// for it: STOP_GUARD=1, which homeroom-bot-live.js buildTurnRunner sets for
// the bot's build turns and its review's fix turns (worker.js passes it to a
// Claude Code build turn and to nothing else). run-cc.sh hands this hook:
//
//   USERNODE_STOP_GUARD_START  the commit HEAD was on when the agent started
//                              (run-cc.sh TURN_START_SHA)
//   USERNODE_STOP_GUARD_COUNT  a file of this turn's own, counting the blocks
//   USERNODE_STOP_GUARD_REPO   the workspace
//
// "Changed nothing" is exactly what the harness would find: HEAD is still the
// start commit and `git status --porcelain` is empty, so there is nothing to
// commit or push. Uncommitted edits are work: the bot's builds are told not
// to commit (build-contract.js harnessCommits) and run-cc.sh commits the
// working tree for them (session-branch.sh usernode_commit_leftovers).
//
// Claude Code's contract (hooks, Stop): the input on stdin carries
// stop_hook_active, true while Claude Code is already continuing because a
// Stop hook blocked. Exit 0 with {"decision":"block","reason":…} on stdout
// keeps the turn going with the reason as feedback; exit 0 with no output
// lets it end. A hook that fails, exits otherwise or runs past its timeout
// lets it end too.
//
// It blocks at most MAX_BLOCKS times in a turn, counted in its file rather
// than read off stop_hook_active (which would allow one block at most, and
// says nothing about how many came before). And it fails open: no start
// commit, no counter, a counter it cannot read or write, git missing, slow or
// failing all let the turn end. It reads only the local checkout: no network.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BLOCKS = 2;
// Each git command's own limit; the settings give the hook as a whole ten
// seconds before Claude Code cancels it (and the turn ends as it would have).
const GIT_TIMEOUT_MS = 3000;
const HOOK_TIMEOUT_S = 10;
const STDIN_WAIT_MS = 500;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const REASON = [
  'You have not changed anything in this repository yet, so stopping now leaves nothing to propose.',
  'The plan is approved: make the change here now and check that it works, then end with the closing',
  'message your instructions ask for. Do not stop to summarize, plan or ask: nobody will answer, and the',
  'work is not done until the change is made. You do not need to commit: your working tree is committed',
  'and pushed for you when you finish. Stop without a change only if you have found a concrete reason it',
  'cannot be made safely, and then say exactly what that reason is.',
].join(' ');

const allow = (why) => ({ block: false, why });

/**
 * Whether to send the agent back to work, from what the hook found. Anything
 * missing or unreadable allows the stop. Pure.
 *
 * @param {object} facts
 * @param {string} facts.startSha  the commit the turn started on
 * @param {number} facts.blocks    how many times this turn was already sent back
 * @param {string} [facts.head]    HEAD now
 * @param {boolean} [facts.dirty]  whether `git status --porcelain` lists anything
 * @returns {{ block: boolean, why: string, reason?: string }}
 */
function decide({ startSha, blocks, head, dirty } = {}) {
  if (!SHA_RE.test(String(startSha || ''))) return allow('no_start');
  if (!Number.isInteger(blocks) || blocks < 0) return allow('no_count');
  if (blocks >= MAX_BLOCKS) return allow('cap');
  if (!SHA_RE.test(String(head || ''))) return allow('no_head');
  if (head !== startSha) return allow('committed');
  if (typeof dirty !== 'boolean') return allow('no_status');
  if (dirty) return allow('uncommitted');
  return { block: true, why: 'unchanged', reason: REASON };
}

// git's stdout, or null when it could not run, failed or ran too long.
function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Never take the index lock or refresh the index from a hook.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    return null;
  }
}

// The blocks counted so far: 0 before the first, null when unreadable.
function readBlocks(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    return err && err.code === 'ENOENT' ? 0 : null;
  }
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * The hook's verdict for this stop, with its side effect: a block is counted
 * before it is returned, and one that cannot be counted is not made. Never
 * throws.
 */
function runGuard({ env = process.env, input = {}, git = runGit, fsImpl = fs } = {}) {
  try {
    const startSha = env.USERNODE_STOP_GUARD_START;
    const countFile = env.USERNODE_STOP_GUARD_COUNT;
    if (!countFile) return allow('no_count');
    const repo = env.USERNODE_STOP_GUARD_REPO || (input && typeof input.cwd === 'string' && input.cwd) || process.cwd();
    const facts = { startSha, blocks: readBlocks(countFile) };
    // Read lazily, in the order decide() needs them: most stops are allowed
    // by the start, the cap or a commit before the slower status is run.
    let verdict = decide(facts);
    if (verdict.why === 'no_head') {
      const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], repo);
      facts.head = head == null ? null : head.trim();
      verdict = decide(facts);
    }
    if (verdict.why === 'no_status') {
      const status = git(['status', '--porcelain', '--untracked-files=normal'], repo);
      facts.dirty = status == null ? null : status.trim().length > 0;
      verdict = decide(facts);
    }
    if (!verdict.block) return verdict;
    try {
      fsImpl.writeFileSync(countFile, String(facts.blocks + 1));
    } catch {
      return allow('no_count');
    }
    return { ...verdict, blocks: facts.blocks + 1 };
  } catch {
    return allow('error');
  }
}

/** What Claude Code reads on stdout for a verdict: the block decision, or nothing. */
function hookOutput(verdict) {
  return verdict && verdict.block ? JSON.stringify({ decision: 'block', reason: verdict.reason }) : '';
}

/** The settings run-cc.sh passes to `claude --settings` to install this hook. */
function settingsFor(hookPath) {
  return {
    hooks: {
      Stop: [{
        hooks: [{ type: 'command', command: `node ${JSON.stringify(hookPath)}`, timeout: HOOK_TIMEOUT_S }],
      }],
    },
  };
}

// The hook's input, read without waiting long for it: none of the decision
// depends on it (cwd is only a fallback for the workspace).
function readInput(stream = process.stdin, waitMs = STDIN_WAIT_MS) {
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Let go of stdin, so an input that never ends cannot hold the hook open.
      try { stream.destroy(); } catch { /* already closed */ }
      let parsed = {};
      try { parsed = JSON.parse(text); } catch { parsed = {}; }
      resolve(parsed && typeof parsed === 'object' ? parsed : {});
    };
    const timer = setTimeout(done, waitMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { if (text.length < 1_000_000) text += chunk; });
    stream.on('end', done);
    stream.on('error', done);
  });
}

// Always exits 0: a verdict on stdout, or nothing (the stop goes ahead).
async function main() {
  let out = '';
  try {
    out = hookOutput(runGuard({ input: await readInput() }));
  } catch {
    out = '';
  }
  // Written, not followed by process.exit(): the process ends once stdout
  // has flushed, so a verdict is never cut short.
  if (out) process.stdout.write(`${out}\n`);
  process.exitCode = 0;
}

if (require.main === module) {
  if (process.argv[2] === '--settings') {
    process.stdout.write(`${JSON.stringify(settingsFor(path.resolve(__filename)))}\n`);
  } else {
    main().catch(() => { process.exitCode = 0; });
  }
}

module.exports = {
  MAX_BLOCKS,
  REASON,
  decide,
  runGuard,
  hookOutput,
  settingsFor,
  readBlocks,
};
