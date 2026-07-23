// Tests for the file-based dispatch-prompt transport (prod session 2538
// incident): the prompt used to travel as a single `docker exec -e
// PROMPT=<value>` argument, and Linux caps one argv/env string at
// 128 KiB (MAX_ARG_STRLEN) — a session whose spec doc grew past ~60 KB
// (on top of the ~68 KB conventions block) E2BIG'd every dispatch before
// the exec existed. The prompt now travels via stdin into a file in the
// CC volume (worker.TURN_PROMPT_PATH) and run-cc.sh pipes it to the
// claude CLI from disk.
//
//   1. Unit tests for the pure prompt-file script builder (base64
//      round-trip at >200KB — the size class the old path could not
//      dispatch).
//   2. Behavioral test of writeTurnPrompt against a mocked
//      docker.execShellStdin.
//   3. Source guards: execInWorker writes the prompt file BEFORE the
//      detached dispatch and no longer puts the prompt in the exec env;
//      run-cc.sh consumes the file on stdin, never as a `-p` argument.
//   4. describeTurnError maps E2BIG to actionable, non-"just retry"
//      language.
//
// Run with: node --test tests/prompt-file-transport.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const docker = require('../src/services/docker');
const worker = require('../src/services/worker');
const { describeTurnError } = require('../src/routes/sessions');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Decode the prompt a buildTurnPromptScript-style script would write:
// concatenate the quoted chunks appended to the .b64 staging file.
function decodeScriptPayload(script) {
  const chunks = [...script.matchAll(/printf '%s' '([^']*)' >> \S+\.b64/g)]
    .map((m) => m[1]);
  return Buffer.from(chunks.join(''), 'base64').toString('utf8');
}

// ── 1. buildTurnPromptScript ────────────────────────────────────────────

test('buildTurnPromptScript round-trips a >200KB prompt (the size the old argv path could not dispatch)', () => {
  // Realistic composition: conventions-block-sized text + spec-sized
  // text, with shell-hostile characters mixed in.
  const prompt = `USER REQUEST: "build it"\n'"\`$PATH\\ ${'x'.repeat(120000)}\n${'y'.repeat(120000)} — done`;
  assert.ok(Buffer.byteLength(prompt, 'utf8') > 200 * 1024 * 0.99);

  const script = worker.buildTurnPromptScript(prompt);
  assert.equal(decodeScriptPayload(script), prompt);

  // The staged base64 is decoded into the canonical prompt path and the
  // staging file is cleaned up.
  assert.match(script, new RegExp(`base64 -d < ${worker.TURN_PROMPT_PATH}\\.b64 > ${worker.TURN_PROMPT_PATH}\n`));
  assert.match(script, new RegExp(`rm -f ${worker.TURN_PROMPT_PATH}\\.b64`));
  assert.match(script, /^set -e\n/);
});

test('buildTurnPromptScript chunks the base64 payload (no single unbounded shell word)', () => {
  const script = worker.buildTurnPromptScript('z'.repeat(300 * 1024));
  const chunks = [...script.matchAll(/printf '%s' '([^']*)'/g)].map((m) => m[1]);
  assert.ok(chunks.length >= 2, 'large prompts split across multiple printf lines');
  for (const c of chunks) {
    assert.ok(c.length <= 64 * 1024, `chunk of ${c.length} exceeds the 64KiB bound`);
  }
});

test('buildTurnPromptScript base64 payload never contains quote characters (safe to single-quote)', () => {
  const script = worker.buildTurnPromptScript(`it's a "prompt" with \\'quotes\\'`);
  for (const [, payload] of script.matchAll(/printf '%s' '([^']*)'/g)) {
    assert.doesNotMatch(payload, /['"\\$]/);
  }
});

// ── 2. writeTurnPrompt (mocked docker boundary) ─────────────────────────

test('writeTurnPrompt materializes the prompt via stdin into the session worker', async () => {
  const SID = 990001;
  worker.adoptWarmWorker(SID);

  const calls = [];
  const orig = docker.execShellStdin;
  docker.execShellStdin = async (containerName, script, opts) => {
    calls.push({ containerName, script, opts });
  };
  try {
    const prompt = `SPEC ${'s'.repeat(220 * 1024)}`;
    await worker.writeTurnPrompt(SID, prompt);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].containerName, `usernode-worker-${SID}`);
    assert.equal(decodeScriptPayload(calls[0].script), prompt);
    assert.equal(calls[0].opts.label, 'writeTurnPrompt');
  } finally {
    docker.execShellStdin = orig;
    worker.evictWorker(SID);
  }
});

test('writeTurnPrompt rejects when no warm worker is registered (required file, unlike personal-files sync)', async () => {
  await assert.rejects(
    () => worker.writeTurnPrompt(990002, 'p'),
    /no warm worker registered/
  );
});

// ── 3. Source guards — worker.js dispatch wiring ────────────────────────

test('execInWorker writes the prompt file before the detached dispatch and never puts the prompt in exec env', () => {
  const src = read('src/services/worker.js');

  // No `PROMPT: <value>` env entry anywhere — the env carries only the
  // short constant path.
  assert.doesNotMatch(src, /PROMPT:\s*prompt/);
  assert.match(src, /PROMPT_FILE:\s*TURN_PROMPT_PATH/);

  // Ordering: the file write happens before the `docker exec -d`
  // dispatch inside execInWorker.
  const writeIdx = src.indexOf('await writeTurnPrompt(sessionId, prompt)');
  const dispatchIdx = src.indexOf("'exec', '-d',");
  assert.ok(writeIdx !== -1, 'execInWorker awaits writeTurnPrompt');
  assert.ok(dispatchIdx !== -1, 'detached dispatch present');
  assert.ok(writeIdx < dispatchIdx, 'prompt file is written before the dispatch args are built');

  // The detached wrapper removes the consumed prompt file when the turn
  // ends (after run-cc.sh, so mid-turn reads are unaffected).
  assert.match(src, /__USERNODE_EXIT__ \$\?" >> "\$TURN_JOURNAL"; '\s*\n\s*\+ 'rm -f "\$PROMPT_FILE"/);
});

// ── 3b. Source guards — run-cc.sh consumption ───────────────────────────

test('run-cc.sh pipes the prompt file to claude on stdin, never as a -p argument', () => {
  const cc = read('worker/run-cc.sh');

  // The build/scout invocations read stdin from the file; an inline
  // `-p "$PROMPT"` would just move the 128KiB E2BIG inside the container.
  assert.doesNotMatch(cc, /-p "\$PROMPT"/);
  assert.doesNotMatch(cc, /\$\{PROMPT:\?/);
  const stdinInvocations = cc.match(/--output-format stream-json < "\$PROMPT_FILE"/g) || [];
  assert.equal(stdinInvocations.length, 3,
    'resume, resume-retry-fresh, and fresh invocations all read the prompt file');

  // Required-env guard: fail fast when the host did not materialize the
  // file (or wrote it empty).
  assert.match(cc, /\$\{PROMPT_FILE:\?PROMPT_FILE required\}/);
  assert.match(cc, /\[ -s "\$PROMPT_FILE" \] \|\| die "prompt file missing or empty/);

  // The in-container sync-conflict prompt is small and locally built —
  // it legitimately stays an inline argument.
  assert.match(cc, /-p "\$SYNC_PROMPT"/);
});

// ── 4. describeTurnError E2BIG mapping ──────────────────────────────────

test('describeTurnError maps spawn E2BIG to actionable language, not the raw errno', () => {
  const friendly = describeTurnError(new Error('spawn E2BIG'));
  assert.doesNotMatch(friendly, /E2BIG/);
  assert.match(friendly, /too large/i);
  assert.match(friendly, /spec|attachment/i);
});

test('describeTurnError leaves unrelated errors verbatim', () => {
  assert.equal(describeTurnError(new Error('boom')), 'boom');
});
