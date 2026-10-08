'use strict';

// The Homeroom bot's coding turns run in the CLI the platform maps their
// model to (#3296), as the dev chat's scout and build do, so GLM 5.3 Flash
// runs in Claude Code and a model mapped to Codex stays there. And a model
// that takes images is handed its screenshots and never told it reads text
// only. These follow one bot build on GLM from the bot's own call site to the
// request OpenRouter receives:
//
//   homeroom-bot-live buildAndPropose
//   → agent-turn resolveCodexRuntimeContext (harness 'auto' → claude; the
//     catalog's supportsImages → agentModelMetadata)
//   → sessions runCodexAttemptLoop → worker execInWorker (run-cc.sh,
//     AGENT_PROVIDER=openrouter, AGENT_MODEL_SUPPORTS_IMAGES=1, the in-loop
//     browser's INLOOP_* env, no handbook system prompt)
//   → run-cc.sh with that env → claude-openrouter-request.js
//   → OpenRouter, a browser_take_screenshot result's image intact,
//
// a text-only model the same way, its screenshot replaced by a note, and
// every other coding turn the bot runs (triage, spec, follow-up, a benchmark
// trial) asking for the same harness. Only the model provider is faked.
//
// Run with: node --test tests/homeroom-bot-claude-harness.test.js

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'test-worker-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const registry = require('../src/agents/registry');
const agentTurn = require('../src/services/agent-turn');
const credentialStore = require('../src/services/credential-store');
const agentModels = require('../src/services/agent-models');
const sessions = require('../src/routes/sessions');
const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const benchRunner = require('../src/services/bench/runner');
const snapshots = require('../src/services/homeroom-bot-snapshots');

const ROOT = path.join(__dirname, '..');
const GLM = 'z-ai/glm-5.3-flash';
const DEEPSEEK = 'deepseek/deepseek-v4.1-flash';
// A model the catalog lists as text only, mapped to Claude Code here so the
// Claude runner's text-only path is the one exercised.
const TEXT_ONLY = 'example/text-only-coder';
const KEY = 'sk-or-v1-bot-test-key-0123456789';
// What OpenRouter's catalog says each model takes. GLM 5.3 Flash is listed
// with image input (input_modalities ['text', 'image', 'video']); whether the
// live catalog still says so is the one link no test here can check.
const CATALOG = {
  [GLM]: { supportsImages: true },
  [DEEPSEEK]: { supportsImages: false },
  [TEXT_ONLY]: { supportsImages: false },
};
const CONFIG = {
  codexOpenrouterEnabled: true,
  openrouterDefaultCodexModel: GLM,
  openrouterDefaultCodexReasoning: 'xhigh',
  // The platform default (src/config.js), plus the text-only model above.
  openrouterModelHarnesses: registry.parseOpenRouterHarnessMap(`${GLM}=claude,${DEEPSEEK}=codex,${TEXT_ONLY}=claude`),
};
const BOT = { id: 77, username: 'homeroom_bot' };
const APP = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo', self_hosted: false };
const SHA = 'c'.repeat(40);
const SPEC = '# Pin the markers to the map\n\n## User-facing changes\n\nThe markers stay put.\n\n## Technical implementation\n\nIn map.js.';
const SCREENSHOT_CHECK = /take screenshots \(`browser_take_screenshot`\) of each changed screen/;
const TEXT_ONLY_LINES = /you read text, not images|reads text only|`browser_snapshot`/;

// The real runtime resolution and attempt loop, with the bot's key and the
// catalog stubbed, and the ledger writes recorded instead of made.
function stubRuntime(t) {
  const resolved = [];
  t.mock.method(credentialStore, 'readMetadata', async () => ({ id: 4, status: 'valid', revision: 2 }));
  t.mock.method(credentialStore, 'readSecret', async () => KEY);
  t.mock.method(agentModels, 'resolveModelPricing', async ({ modelId }) => ({
    id: modelId, name: modelId, contextLength: 200_000, maxOutputTokens: 64_000,
    supportsReasoning: true, reasoningEfforts: null, supportsTools: true,
    inputPricePerMillion: 0.1, outputPricePerMillion: 0.4,
    ...CATALOG[modelId],
  }));
  const realResolve = agentTurn.resolveCodexRuntimeContext;
  t.mock.method(agentTurn, 'resolveCodexRuntimeContext', async (args) => {
    const ctx = await realResolve(args);
    resolved.push({ asked: args.harness, harness: ctx?.agentHarness, model: ctx?.agentModel });
    return ctx;
  });
  let n = 0;
  t.mock.method(agentTurn, 'startCodexAttempt', async () => {
    n += 1;
    return { turnUuid: `attempt-${n}`, journal: `/home/node/.claude/turn-attempt-${n}.log` };
  });
  t.mock.method(agentTurn, 'completeCodexAttempt', async () => ({ estimatedCost: { estimatedCostUsd: 0.01 } }));
  return resolved;
}

// ── The worker, for real, against a fake docker ─────────────────────────

function stubModule(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// worker.js loaded against a fake docker, logger and pool, with every
// journal tail answering `journalLines` (the worker-stop-turn.test.js
// harness). Returns the module and the recorded docker calls.
function loadWorker(t, journalLines) {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    childProcess: require.resolve('child_process'),
    subject: require.resolve('../src/services/worker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const calls = [];
  const realDocker = require('../src/services/docker');
  stubModule(ids.docker, {
    ...realDocker,
    execFileAsync: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { stdout: '', stderr: '' }; },
    execShellStdin: async () => ({ stdout: '', stderr: '' }),
  });
  const noop = () => {};
  stubModule(ids.logger, { info: noop, warn: noop, error: noop, debug: noop });
  const activeTurns = new Map();
  stubModule(ids.pool, {
    getPool: () => ({
      query: async (sql, params = []) => {
        const text = String(sql);
        const sessionId = Number(params[0]);
        if (/SELECT active_turn FROM chat_sessions/i.test(text)) {
          return { rows: [{ active_turn: activeTurns.get(sessionId) || null }], rowCount: 1 };
        }
        if (/SET active_turn = \$2::jsonb/i.test(text)) {
          if (activeTurns.has(sessionId)) return { rows: [], rowCount: 0 };
          activeTurns.set(sessionId, JSON.parse(params[1]));
          return { rows: [{ active_turn: activeTurns.get(sessionId) }], rowCount: 1 };
        }
        if (/SET active_turn = active_turn \|\| \$3::jsonb/i.test(text)) {
          const current = activeTurns.get(sessionId);
          if (!current) return { rows: [], rowCount: 0 };
          activeTurns.set(sessionId, { ...current, ...JSON.parse(params[2]) });
          return { rows: [{ active_turn: activeTurns.get(sessionId) }], rowCount: 1 };
        }
        if (/SET active_turn = NULL/i.test(text)) {
          const had = activeTurns.delete(sessionId);
          return { rows: had ? [{ id: sessionId }] : [], rowCount: had ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    }),
  });
  const realCp = require('child_process');
  stubModule(ids.childProcess, {
    ...realCp,
    spawn: () => {
      const handlers = {};
      setImmediate(() => {
        handlers.data?.(Buffer.from(`${journalLines.join('\n')}\n`));
        handlers.close?.(0);
      });
      return {
        stdout: { on: (ev, fn) => { if (ev === 'data') handlers.data = fn; } },
        stderr: { on: () => {} },
        on: (ev, fn) => { if (ev === 'close') handlers.close = fn; },
        kill: () => {},
      };
    },
  });
  delete require.cache[ids.subject];
  const worker = require('../src/services/worker');
  t.after(() => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
    delete require.cache[ids.subject];
  });
  return { worker, calls };
}

// One `docker exec -d` dispatch, read back: the env the runner gets (a
// secret is passed by name, its value from the exec's own environment) and
// the script it runs.
function readDispatch(call) {
  const { args } = call;
  const env = {};
  let i = 2;
  while (args[i] === '-e') {
    const entry = args[i + 1];
    const eq = entry.indexOf('=');
    if (eq < 0) env[entry] = call.opts.env[entry];
    else env[entry.slice(0, eq)] = entry.slice(eq + 1);
    i += 2;
  }
  return { env, script: args[args.length - 1] };
}

const JOURNAL = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cc-or-1' }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: SPEC, session_id: 'cc-or-1', usage: { input_tokens: 10, output_tokens: 5 } }),
  `__USERNODE_RESULT__ cc_exit=0 ahead=1 behind=0 sha=${SHA} push_ok=1 mode=build`,
  '__USERNODE_EXIT__ 0',
];

// A build of the bot's (buildAndPropose), on `model`, through the real
// runtime resolution, attempt loop and worker dispatch, each turn's journal
// reading `journal`. A shadow build by default (propose: false: the same
// spec and build turns, nothing promoted); `propose` puts it to a stub of
// the promote route, which records what it was asked to put up for a vote.
async function runBotBuild(t, model, { journal = JOURNAL, propose = false } = {}) {
  const resolved = stubRuntime(t);
  const { worker, calls } = loadWorker(t, journal);
  const execs = [];
  const promotions = [];
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO chat_sessions/.test(String(sql))) {
        return {
          rows: [{
            id: 5001, app_id: APP.id, user_id: BOT.id, branch_name: null, agent_backend: 'codex_openrouter',
            agent_model: params[4], agent_reasoning_effort: params[5], agent_config_version: 1, agent_thread_id: null,
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id) { worker.adoptWarmWorker(id, `usernode-worker-${id}`); return `usernode-worker-${id}`; },
      execInWorker(id, opts) { execs.push(opts); return worker.execInWorker(id, opts); },
      async stopTurn() {},
      clearPendingStop() {},
    },
    sessions: {
      runCodexAttemptLoop: sessions.runCodexAttemptLoop,
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn,
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `dev/homeroom_bot-${sessionId}` }; } },
    activeWorkers: new Set(),
    votesRouter: { handle(req, res) { promotions.push(req.url); res.json({ ok: true, prNumber: 88 }); } },
  };
  const out = await live.buildAndPropose({
    pool, deps, config: CONFIG, bot: BOT, app: APP, repo: { owner: 'usernode-bot', repo: 'todo' }, issueNumber: 12,
    issue: { title: 'Pins drift' }, seed: 'Please work on GitHub issue #12: "Pins drift".', buildNote: 'Pin the markers.',
    turnBudgetMs: 60_000, model, propose,
  });
  const dispatches = calls.filter((c) => c.args?.[0] === 'exec' && c.args?.[1] === '-d').map(readDispatch);
  return { out, resolved, execs, dispatches, promotions };
}

// ── run-cc.sh with the env the worker built, against a fake OpenRouter ──

async function fakeOpenRouter() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message_start\ndata: {"type":"message_start","message":{"model":"${GLM}","usage":{"input_tokens":12,"output_tokens":1}}}\n\n`);
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    base: `http://127.0.0.1:${server.address().port}/api/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// A stand-in for the claude CLI: records its arguments, then sends the
// request Claude Code sends after the in-loop browser's
// browser_take_screenshot answers, its tool result carrying the image.
function runnerFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-claude-harness-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const runtimeLog = path.join(dir, 'claude-runtime.json');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const prompt = fs.readFileSync(0, 'utf8');
(async () => {
  const reply = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 4096, stream: true, messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_shot', name: 'mcp__playwright__browser_take_screenshot', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_shot', content: [
        { type: 'text', text: 'Took a screenshot of the current page.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoSCREENSHOT' } },
      ] }] },
    ] }),
  });
  await reply.text();
  fs.writeFileSync(${JSON.stringify(runtimeLog)}, JSON.stringify({ args: process.argv.slice(2), status: reply.status }));
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cc-or-1' }));
  // STUB_IS_ERROR / STUB_EXIT / STUB_RESULT: a turn that failed, each way
  // Claude Code says so, and the final message it ended on.
  console.log(JSON.stringify({ type: 'result', is_error: process.env.STUB_IS_ERROR === '1', result: process.env.STUB_RESULT || 'done', session_id: 'cc-or-1', usage: { input_tokens: 5, output_tokens: 7 } }));
  process.exitCode = Number(process.env.STUB_EXIT || 0);
})();
`);
  // git answers every question as though the turn sat on its session branch
  // with a change in its working tree, and logs what it was asked.
  const gitLog = path.join(dir, 'git.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
echo "$*" >> ${JSON.stringify(gitLog)}
case "$1" in symbolic-ref) echo "$BRANCH";; status) echo " M app.js";; diff) exit 1;; esac
exit 0
`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'Build issue #12');
  // The in-loop browser's MCP config, as worker-run.sh seeds it.
  const browserConfig = path.join(dir, 'usernode-mcp.json');
  fs.writeFileSync(browserConfig, JSON.stringify({ mcpServers: { playwright: { command: 'true' } } }));
  return { dir, bin, ws, prompt, runtimeLog, browserConfig, gitLog };
}

// run-cc.sh with the dispatched env, its output written to its journal as
// the worker's wrapper does (worker.js execInWorker). Only what points at the
// container (paths, the provider's address) is swapped for this machine's;
// `extra` is the stub's own switches.
function runRunCc(env, fx, upstream, extra = {}) {
  const journal = path.join(fx.dir, 'turn.log');
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', 'sh "$RUNNER" > "$TURN_JOURNAL" 2>&1'], {
      env: {
        ...env,
        PATH: `${fx.bin}:${process.env.PATH}`,
        HOME: fx.dir,
        PROMPT_FILE: fx.prompt,
        WORKSPACE_DIR: fx.ws,
        OPENROUTER_API_BASE: upstream.base,
        BROWSER_MCP_CONFIG: fx.browserConfig,
        HOMEROOM_MCP_CONFIG: path.join(fx.dir, 'absent-homeroom-mcp.json'),
        INLOOP_PGDATA: path.join(fx.dir, 'absent-pgdata'),
        RUNNER: path.join(ROOT, 'worker', 'run-cc.sh'),
        TURN_JOURNAL: journal,
        ...extra,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('close', (code) => resolve({ code, out: fs.readFileSync(journal, 'utf8') }));
  });
}

// The screenshot's tool result, as OpenRouter received it.
function screenshotResultSent(upstream) {
  const messages = upstream.seen.find((r) => r.url.endsWith('/messages'))?.body?.messages || [];
  const result = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((block) => block.type === 'tool_result' && block.tool_use_id === 'toolu_shot');
  return result?.content || null;
}

test('a bot build on GLM 5.3 Flash runs in Claude Code, and OpenRouter receives its screenshot', async (t) => {
  const run = await runBotBuild(t, GLM);
  assert.equal(run.out.ok, true, run.out.error);
  assert.equal(run.out.sha, SHA);

  // 1. Both turns of the build, its spec and the build itself, asked for the
  //    platform's per-model choice and got Claude Code.
  assert.deepEqual(run.resolved, [
    { asked: 'auto', harness: 'claude', model: GLM },
    { asked: 'auto', harness: 'claude', model: GLM },
  ]);
  assert.deepEqual(run.execs.map((o) => [o.mode, o.agentBackend, o.agentHarness]), [
    ['scout', 'codex_openrouter', 'claude'],
    ['build', 'codex_openrouter', 'claude'],
  ]);
  const build = run.execs[1];
  // 2. The bot path hands the worker the catalog's capability.
  assert.equal(build.agentModelMetadata?.supportsImages, true);
  // Nothing the bot sends tells the model it reads text only.
  for (const opts of run.execs) assert.doesNotMatch(opts.prompt, TEXT_ONLY_LINES, opts.mode);

  // 3. The worker dispatches the build to run-cc.sh, through OpenRouter, with
  //    images on and the in-loop browser's env. An OpenRouter build carries
  //    no handbook as system context, and the worker does not demand one:
  //    the fail-closed rule is hosted Claude's (worker.js, run-cc.sh).
  assert.equal(build.systemPrompt ?? null, null);
  assert.equal(run.dispatches.length, 2);
  const { env, script } = run.dispatches[1];
  assert.match(script, /\/usr\/local\/bin\/run-cc\.sh/);
  assert.doesNotMatch(script, /run-codex-agent/);
  assert.equal(env.MODE, 'build');
  assert.equal(env.AGENT_PROVIDER, 'openrouter');
  assert.equal(env.AGENT_MODEL, GLM);
  assert.equal(env.MODEL, GLM);
  assert.equal(env.AGENT_MODEL_SUPPORTS_IMAGES, '1');
  assert.equal(env.SYSTEM_PROMPT_FILE, '');
  assert.equal(env.INLOOP_BROWSER, '1');
  assert.equal(env.INLOOP_PORT, '3100');
  assert.equal(env.OPENROUTER_API_KEY, KEY);
  assert.ok(env.WORKER_JWT, 'the build may push');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'no Anthropic credential');
  assert.equal(run.dispatches[0].env.MODE, 'scout');
  assert.equal(run.dispatches[0].env.INLOOP_BROWSER, undefined, 'the spec turn gets no browser');

  // 4. run-cc.sh with exactly that env runs the build (no handbook demanded),
  //    gives Claude Code the in-loop browser, and the request adapter hands
  //    OpenRouter the screenshot the browser took.
  const upstream = await fakeOpenRouter();
  t.after(() => upstream.close());
  const fx = runnerFixture();
  const ran = await runRunCc(env, fx, upstream);
  assert.equal(ran.code, 0, ran.out);
  assert.doesNotMatch(ran.out, /SYSTEM_PROMPT_FILE required/);
  assert.match(ran.out, /__USERNODE_RESULT__ cc_exit=0 .*mode=build/);
  const { args } = JSON.parse(fs.readFileSync(fx.runtimeLog, 'utf8'));
  assert.deepEqual(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 3),
    ['--mcp-config', fx.browserConfig, '--strict-mcp-config'], 'the build has the in-loop browser');
  const sent = screenshotResultSent(upstream);
  assert.ok(sent, 'the screenshot\'s tool result reached OpenRouter');
  // GLM is not Anthropic's model: its hosts read a tool result as text, so
  // the image follows the tool results, a pointer left in its place.
  assert.deepEqual(sent[1], { type: 'text', text: '[image 1 of this result follows after the tool results]' });
  const message = upstream.seen.find((r) => r.url.endsWith('/messages')).body.messages.at(-1).content;
  assert.deepEqual(message.slice(1), [
    { type: 'text', text: '[image 1 of the mcp__playwright__browser_take_screenshot result (toolu_shot):]' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoSCREENSHOT' } },
  ]);
  assert.match(ran.out, /"images":\{"sent":1,"moved":1,"omitted":0\}/, 'and the turn\'s journal counts it');
  assert.equal(upstream.seen[0].body.model, GLM);
  assert.ok(!ran.out.includes(KEY), 'the journal never carries the key');
});

test('a bot build on a text-only model runs the same way, and its screenshot becomes a note', async (t) => {
  const run = await runBotBuild(t, TEXT_ONLY);
  assert.equal(run.out.ok, true, run.out.error);
  assert.deepEqual(run.resolved.map((r) => r.harness), ['claude', 'claude']);
  const build = run.execs[1];
  assert.equal(build.agentModelMetadata?.supportsImages, false);
  const { env } = run.dispatches[1];
  assert.equal(env.AGENT_PROVIDER, 'openrouter');
  assert.equal(env.AGENT_MODEL_SUPPORTS_IMAGES, '');

  const upstream = await fakeOpenRouter();
  t.after(() => upstream.close());
  const fx = runnerFixture();
  const ran = await runRunCc(env, fx, upstream);
  assert.equal(ran.code, 0, ran.out);
  const sent = screenshotResultSent(upstream);
  assert.deepEqual(sent, [
    { type: 'text', text: 'Took a screenshot of the current page.' },
    { type: 'text', text: '[image omitted: this model reads text only]' },
  ], 'a model that cannot take the image is never sent it');
});

// ── Every coding turn the bot runs ─────────────────────────────────────

const READY = '```json\n{"verdict":"ready","determined":true,"build_note":"Pin the markers to the map."}\n```';

// A triage pass for one issue (runTriage), through the real runtime
// resolution and attempt loop; the worker records what it was handed.
async function runBotTriage(t, model) {
  const resolved = stubRuntime(t);
  const execs = [];
  const queries = [];
  const sessionRow = {
    id: 501, user_id: BOT.id, app_id: APP.id, branch_name: 'main', agent_backend: 'codex_openrouter',
    agent_model: model, agent_config_version: 1, agent_thread_id: null,
  };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      queries.push({ s, params });
      if (/SELECT \* FROM chat_sessions/.test(s)) return { rows: [{ ...sessionRow }] };
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 900 }] };
      if (/INSERT INTO homeroom_bot_run_snapshots/.test(s)) return { rows: [{ id: 41 }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async getBranchSha() { return 'a'.repeat(40); },
      async fetchPublicIssue() {
        return { issue: { number: 12, title: 'Pins drift', body: 'They drift.\n\n**Screenshot:** https://app.example/issue-images/abc123', state: 'open' } };
      },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-501'; },
      async execInWorker(id, opts) { execs.push(opts); return { lastResultText: READY, inputTokens: 10, outputTokens: 5 }; },
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn,
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: { buildHeadlessSeed: sessions.buildHeadlessSeed, runCodexAttemptLoop: sessions.runCodexAttemptLoop },
    activeWorkers: new Set(),
  };
  const settings = { ...bot.DEFAULTS, models: { triage: model, spec: '', build: '', followup: '' } };
  const out = await bot.runTriage(pool, CONFIG, {
    bot: BOT, app: APP, item: { id: 31, app_id: APP.id, issue_number: 12, priority: 1, reason: 'new', thread_seen_at: null },
    mode: 'shadow', settings, deps,
  });
  return { out, resolved, execs, queries };
}

test('the triage tells a model that takes images to look at screenshots, and records the prompt it sent', async (t) => {
  const glm = await runBotTriage(t, GLM);
  assert.equal(glm.out.verdict, 'ready');
  assert.deepEqual(glm.resolved, [{ asked: 'auto', harness: 'claude', model: GLM }]);
  assert.equal(glm.execs[0].agentHarness, 'claude');
  const sent = glm.execs[0].prompt;
  // The request's screenshot is to be looked at, and so is the app.
  assert.match(sent, /The request includes a screenshot/);
  assert.match(sent, SCREENSHOT_CHECK);
  assert.doesNotMatch(sent, TEXT_ONLY_LINES);
  // What the snapshot keeps for the benchmark is what the turn was sent.
  const snap = glm.queries.find((q) => /INSERT INTO homeroom_bot_run_snapshots/.test(q.s));
  assert.equal(snap.params[5], snapshots.hashText(sent));
  // The benchmark's rebuild of it, for the same capability, is identical.
  const seed = sent.slice(0, sent.indexOf('\n\nThe request includes a screenshot'));
  assert.equal(bot.triagePromptFor({ seed, issueNumber: 12, readsImages: true }), sent);
});

test('the triage tells a text-only model to read the accessibility snapshot instead', async (t) => {
  const plain = await runBotTriage(t, TEXT_ONLY);
  assert.deepEqual(plain.resolved.map((r) => [r.asked, r.harness]), [['auto', 'claude']]);
  const sent = plain.execs[0].prompt;
  assert.match(sent, /you read text, not images/);
  assert.match(sent, /`browser_snapshot`/);
  assert.doesNotMatch(sent, SCREENSHOT_CHECK);
});

test('the follow-up and every benchmark trial ask for the same harness; a model mapped to Codex stays there', async (t) => {
  for (const [model, harness] of [[GLM, 'claude'], [DEEPSEEK, 'codex']]) {
    // A follow-up on the bot's own proposal (also its checks fix).
    const resolved = stubRuntime(t);
    const execs = [];
    const out = await followup.runFollowUpTurn({
      pool: { async query() { return { rows: [], rowCount: 1 }; } },
      config: CONFIG, bot: BOT, repo: { owner: 'usernode-bot', repo: 'todo' },
      session: { id: 602, branch_name: 'dev/homeroom_bot-602', agent_backend: 'codex_openrouter', agent_model: model, agent_config_version: 1 },
      prompt: 'Address the review.', mode: 'build', issueNumber: 12, turnBudgetMs: 60_000, model,
      deps: {
        worker: {
          async ensureWorkerImage() {}, async ensureWorker() { return 'usernode-worker-602'; },
          async execInWorker(_id, opts) { execs.push(opts); return { lastResultText: 'done' }; }, async stopTurn() {},
        },
        agentTurn,
        sessions: { runCodexAttemptLoop: sessions.runCodexAttemptLoop },
        activeWorkers: new Set(),
      },
    });
    assert.ok(!out.routed?.error, JSON.stringify(out.routed));
    assert.deepEqual(resolved, [{ asked: 'auto', harness, model }], `follow-up on ${model}`);
    assert.equal(execs[0].agentHarness, harness);
    t.mock.restoreAll();

    // A benchmark triage trial: the bot's triage, on the trial's model.
    const benchResolved = stubRuntime(t);
    const benchExecs = [];
    const seed = 'Please work on GitHub issue #12: "Pins drift".';
    const trial = await benchRunner.runStage({
      pool: {
        async query(sql, params) {
          if (/INSERT INTO chat_sessions/.test(String(sql))) {
            return { rows: [{ id: 7001, branch_name: params[2], agent_model: params[4], agent_backend: 'codex_openrouter', agent_config_version: 1 }] };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      config: CONFIG, stage: 'triage', task: { id: 1, stage: 'triage', reference: {} },
      snapshot: {
        id: 1, stage: 'triage', issueNumber: 12, baseSha: 'b'.repeat(40),
        promptHash: snapshots.hashText(bot.triagePromptFor({ seed, issueNumber: 12, readsImages: model === GLM })),
        texts: { seed }, extra: {},
      },
      model, user: { id: 501, username: 'homeroom_bench' }, app: APP, repo: { owner: 'o', repo: 'todo' },
      trial: { id: 44, run_id: 3, attempt: 1 }, budgets: { turnMs: 60_000, buildMs: 60_000, specMs: 60_000 },
      title: 'Homeroom benchmark: run 3, trial 44',
      deps: {
        github: benchRunner.guardedGithub({
          isEnabled: () => true,
          async getBranchSha() { return 'f'.repeat(40); },
          async ensureBranchAtSha() {},
          async deleteBenchBranch() { return true; },
        }),
        worker: {
          async ensureWorkerImage() {},
          async ensureWorker() { return 'w-7001'; },
          async execInWorker(_id, opts) { benchExecs.push(opts); return { lastResultText: READY }; },
          async stopTurn() {},
          clearPendingStop() {},
        },
        sessions: { runCodexAttemptLoop: sessions.runCodexAttemptLoop },
        agentTurn,
        activeWorkers: new Set(),
      },
    });
    assert.equal(trial.status, 'ok', trial.error);
    assert.deepEqual(benchResolved, [{ asked: 'auto', harness, model }], `benchmark trial on ${model}`);
    assert.equal(benchExecs[0].agentHarness, harness);
    // Its prompt is the one the bot would send the same model.
    assert.equal(benchExecs[0].prompt, bot.triagePromptFor({ seed, issueNumber: 12, readsImages: model === GLM }));
    assert.equal(trial.parsed.promptMatchesSnapshot, true);
    t.mock.restoreAll();
  }
});

// ── A turn that failed is never proposed ────────────────────────────────
//
// The Codex runner never commits or pushes a turn whose agent failed
// (run-codex-agent.sh). run-cc.sh did, for every caller: in a person's dev
// chat that keeps their partial work, but a bot build that died partway was
// pushed, and then proposed, once GLM ran in Claude Code. The bot's turns now
// ask run-cc.sh not to keep a failed turn, and the bot refuses one that was
// kept anyway.

// What run-cc.sh printed before it learned to discard a failed turn (and
// prints still for a caller that does not ask): claude exited 1, and the
// partial work was committed and pushed.
const FAILED_PUSHED_JOURNAL = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cc-or-1' }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: SPEC, session_id: 'cc-or-1', usage: { input_tokens: 10, output_tokens: 5 } }),
  `__USERNODE_RESULT__ cc_exit=1 ahead=1 behind=0 sha=${SHA} push_ok=1 mode=build`,
  '__USERNODE_EXIT__ 1',
];

test('a GLM bot build whose agent failed opens no proposal, even when its partial work was pushed', async (t) => {
  const run = await runBotBuild(t, GLM, { journal: FAILED_PUSHED_JOURNAL, propose: true });
  assert.equal(run.execs[1].agentHarness, 'claude');
  assert.equal(run.out.ok, false);
  assert.equal(run.out.error, 'the build turn failed (the agent exited with code 1)');
  assert.deepEqual(run.promotions, [], 'nothing was put up for a vote');
  // And the build asked run-cc.sh not to keep a failed turn in the first place.
  assert.equal(run.execs[1].discardFailedTurn, true);
  assert.equal(run.dispatches[1].env.DISCARD_FAILED_TURN, '1');
});

test('a bot build is recorded as build_failed, with the reason, when its agent failed', async (t) => {
  const run = await runBotBuild(t, GLM, { journal: FAILED_PUSHED_JOURNAL, propose: true });
  const queries = [];
  const said = [];
  await bot.announceBuilt({
    pool: { async query(sql, params) { queries.push({ sql: String(sql), params }); return { rows: [], rowCount: 1 }; } },
    ws: null, app: APP, bot: BOT, issueNumber: 12, runId: 900, built: run.out, domain: 'app.example',
    say: async (kind, text, extra) => { said.push({ kind, text, extra }); },
  }).then((acted) => assert.equal(acted, 'build_failed'));
  const recorded = queries.find((q) => /SET build_ok = \$2, build_error = \$3/.test(q.sql));
  assert.equal(recorded.params[1], false);
  assert.match(recorded.params[2], /^the build turn failed \(the agent exited with code 1\)/);
  assert.deepEqual(said.map((s) => s.kind), ['build_failed']);
  assert.ok(!queries.some((q) => /proposal_session_id = \$2/.test(q.sql)), 'no proposal on the run');
});

test('a build that ended on an error result, or on the runtime\'s API error notice, is not proposed either', async (t) => {
  const ended = (resultEvent) => [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cc-or-1' }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'cc-or-1', usage: { input_tokens: 10, output_tokens: 5 }, ...resultEvent }),
    `__USERNODE_RESULT__ cc_exit=0 ahead=1 behind=0 sha=${SHA} push_ok=1 mode=build`,
    '__USERNODE_EXIT__ 0',
  ];
  const isError = await runBotBuild(t, GLM, { journal: ended({ is_error: true, result: 'Stopped.' }), propose: true });
  assert.equal(isError.out.error, 'the build turn failed (the agent reported an error)');
  assert.deepEqual(isError.promotions, []);
  t.mock.restoreAll();
  const wire = await runBotBuild(t, GLM, {
    journal: ended({ is_error: false, result: 'Edited app.js.\n\nAPI Error: Connection lost mid-response. The response above may be incomplete.' }),
    propose: true,
  });
  assert.equal(wire.out.error, 'the build turn failed (it ended on an API error)');
  assert.deepEqual(wire.promotions, []);
});

test('a Codex build that failed fails exactly as it did', async (t) => {
  // The Codex runner's own line for a failed turn: nothing committed or pushed.
  const run = await runBotBuild(t, DEEPSEEK, {
    journal: [
      `__USERNODE_RESULT__ cc_exit=1 ahead=0 behind=0 sha= push_ok=0 mode=build agent_backend=codex_openrouter agent_model=${DEEPSEEK} agent_thread_id= agent_exit=1`,
      '__USERNODE_EXIT__ 1',
    ],
    propose: true,
  });
  assert.equal(run.execs[1].agentHarness, 'codex');
  assert.equal(run.out.ok, false);
  assert.equal(run.out.error, 'the build produced no change to propose', 'the message it always had');
  assert.deepEqual(run.promotions, []);
  assert.match(run.dispatches[1].script, /run-codex-agent\.sh/);
  assert.equal(run.dispatches[1].env.DISCARD_FAILED_TURN, undefined, 'the Codex runner needs no asking');
  // A Codex turn is judged as before: only by what it pushed.
  assert.equal(live.failedClaudeTurn({ agentHarness: 'codex', ccExit: 1, exitCode: 1, ccIsError: true }), null);
  t.mock.restoreAll();
  const pushed = await runBotBuild(t, DEEPSEEK, {
    journal: [
      `__USERNODE_RESULT__ cc_exit=0 ahead=1 behind=0 sha=${SHA} push_ok=1 mode=build agent_backend=codex_openrouter agent_model=${DEEPSEEK} agent_thread_id=t-1 agent_exit=0`,
      '__USERNODE_EXIT__ 0',
    ],
    propose: true,
  });
  assert.equal(pushed.out.ok, true, pushed.out.error);
  assert.deepEqual(pushed.promotions, ['/api/sessions/5001/promote']);
});

test('run-cc.sh commits and pushes nothing from a failed turn when asked, and keeps it otherwise', async (t) => {
  const run = await runBotBuild(t, GLM);
  const { env } = run.dispatches[1];
  assert.equal(env.DISCARD_FAILED_TURN, '1');
  const upstream = await fakeOpenRouter();
  t.after(() => upstream.close());
  const committed = (fx) => fs.readFileSync(fx.gitLog, 'utf8').split('\n').filter((l) => /^(add|commit)\b/.test(l));

  // claude exited 1: nothing is committed, the push is skipped, and the
  // result line is the Codex runner's for a failed turn.
  const fx = runnerFixture();
  const failed = await runRunCc(env, fx, upstream, { STUB_EXIT: '1' });
  assert.equal(failed.code, 1, failed.out);
  assert.match(failed.out, /__USERNODE_WARN__ claude exited non-zero \(1\); skipping commit\/push/);
  assert.match(failed.out, /__USERNODE_RESULT__ cc_exit=1 ahead=0 behind=0 sha= push_ok=0 mode=build/);
  assert.doesNotMatch(failed.out, /__USERNODE_PHASE__ (commit|push)\b/);
  assert.deepEqual(committed(fx), []);

  // claude exited 0 but its result was an error: the same.
  const fx2 = runnerFixture();
  const errored = await runRunCc(env, fx2, upstream, { STUB_IS_ERROR: '1' });
  assert.equal(errored.code, 1, errored.out);
  assert.match(errored.out, /__USERNODE_WARN__ claude's result was an error; skipping commit\/push/);
  assert.match(errored.out, /push_ok=0 mode=build/);
  assert.deepEqual(committed(fx2), []);

  // A turn that succeeded is committed as before.
  const fx3 = runnerFixture();
  const ok = await runRunCc(env, fx3, upstream);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /__USERNODE_PHASE__ commit/);
  assert.ok(committed(fx3).some((line) => line.startsWith('commit')), 'committed');

  // Not asked (a person's dev chat): a failed turn's work is kept, as it was.
  const fx4 = runnerFixture();
  const kept = await runRunCc({ ...env, DISCARD_FAILED_TURN: '' }, fx4, upstream, { STUB_EXIT: '1' });
  assert.equal(kept.code, 1, kept.out);
  assert.match(kept.out, /__USERNODE_PHASE__ commit/);
  assert.ok(committed(fx4).some((line) => line.startsWith('commit')), 'committed');
});

// ── A turn stopped before its result is still priced ───────────────────

test('a Claude-harness turn stopped before its result is priced from the usage it streamed', async (t) => {
  const stream = (event, uuid) => JSON.stringify({
    type: 'stream_event', event, session_id: 'cc-or-1', parent_tool_use_id: null, uuid,
  });
  const { worker } = loadWorker(t, [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cc-or-1' }),
    stream({ type: 'message_start', message: { id: 'gen-1', model: GLM, usage: { input_tokens: 1200, cache_read_input_tokens: 800, output_tokens: 1 } } }, 'u1'),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading the map code.' } }, 'u2'),
    stream({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 300 } }, 'u3'),
    stream({ type: 'message_start', message: { id: 'gen-2', model: GLM, usage: { input_tokens: 2500, output_tokens: 1 } } }, 'u4'),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(400) } }, 'u5'),
    // The wall clock: the kill's marker, no result event.
    '__USERNODE_EXIT__ 143',
  ]);
  worker.adoptWarmWorker(701, 'usernode-worker-701');
  const result = await worker.execInWorker(701, {
    mode: 'scout', prompt: 'triage', branchName: 'main', agentBackend: 'codex_openrouter', agentHarness: 'claude',
    agentModel: GLM, openrouterApiKey: KEY, openrouterApiBase: 'https://openrouter.ai/api/v1',
    turnUuid: 'attempt-1', logicalTurnId: 'turn-1', attemptNumber: 1,
  });
  assert.equal(result.inputTokens, null, 'Claude Code reported no usage of its own');
  assert.deepEqual(result.relayUsage, {
    requests: 2, inputTokens: 1200 + 800 + 2500, cachedInputTokens: 800, outputTokens: 300 + 100,
  });
  const spend = bot.relaySpend(result.relayUsage, {
    available: true, inputPricePerMillion: 0.1, outputPricePerMillion: 0.4,
  }, agentTurn);
  assert.equal(spend.requests, 2);
  assert.ok(spend.costUsd > 0, 'priced, so the weekly pool is debited');
});

// ── A turn that ended on the runtime's API error notice ────────────────
//
// Claude Code can give up on a provider (an OpenRouter 429 once its own
// retries are spent) and exit 0, its final message the runtime's "API Error"
// notice. run-cc.sh judges that with the host's own definition
// (worker/agent-api-failure.js), so a follow-up that ended this way pushes
// nothing onto the proposal, and the host does not count it as a revision.

const API_ERROR = 'API Error: 429 {"error":{"message":"Provider returned error","code":429}}';

test('the worker and the host read one definition of the API error notice', () => {
  const shared = require('../worker/agent-api-failure');
  assert.equal(require('../src/services/agent-result-text').agentApiFailure, shared.agentApiFailure);
  const journal = (result, extra = {}) => [
    '__USERNODE_PHASE__ claude (mode build)',
    JSON.stringify({ type: 'result', is_error: true, result: 'a subagent', parent_tool_use_id: 'toolu_1' }),
    JSON.stringify({ type: 'result', is_error: false, result, ...extra }),
    '__USERNODE_CODING_PROVIDER__ {"kind":"provider_request_end"}',
  ].join('\n');
  assert.equal(shared.failedFinalResult(journal(API_ERROR)), 'claude ended on an API error');
  assert.equal(shared.failedFinalResult(journal('Edited app.js.\n\nAPI Error: Connection lost mid-response. The response above may be incomplete.')), 'claude ended on an API error');
  assert.equal(shared.failedFinalResult(journal('done', { is_error: true })), "claude's result was an error");
  // Anchored as the host's check is: a message that mentions an API error is not one.
  assert.equal(shared.failedFinalResult(journal('Fixed the API error handling in the fetch helper.\n\nAPI error messages now say what to retry.')), null);
  assert.equal(shared.failedFinalResult(journal('done')), null);
  assert.equal(shared.failedFinalResult('no result at all'), null);
  // The host reads the same notice the same way.
  assert.equal(live.failedClaudeTurn({ agentHarness: 'claude', ccExit: 0, exitCode: 0, lastResultText: API_ERROR }), 'it ended on an API error');
  assert.equal(live.failedClaudeTurn({ agentHarness: 'claude', ccExit: 0, exitCode: 0, lastResultText: 'Fixed the API error handling.' }), null);
  // The image ships it beside the runner that calls it.
  assert.match(fs.readFileSync(path.join(ROOT, 'worker', 'Dockerfile'), 'utf8'), /COPY agent-api-failure\.js \/usr\/local\/bin\/agent-api-failure\.js/);
  assert.match(fs.readFileSync(path.join(ROOT, 'worker', 'run-cc.sh'), 'utf8'), /node "\$\(dirname "\$0"\)\/agent-api-failure\.js" "\$TURN_JOURNAL"/);
});

test('a GLM follow-up that ended on an API error with exit 0 pushes nothing, and is no revision', async (t) => {
  // The follow-up's own dispatch, through the real runtime and worker.
  stubRuntime(t);
  const { worker, calls } = loadWorker(t, JOURNAL);
  const out = await followup.runFollowUpTurn({
    pool: { async query() { return { rows: [], rowCount: 1 }; } },
    config: CONFIG, bot: BOT, repo: { owner: 'usernode-bot', repo: 'todo' },
    session: { id: 602, branch_name: 'dev/homeroom_bot-602', agent_backend: 'codex_openrouter', agent_model: GLM, agent_config_version: 1 },
    prompt: 'Make it #000.', mode: 'build', issueNumber: 12, turnBudgetMs: 60_000, model: GLM,
    deps: {
      worker: {
        async ensureWorkerImage() {},
        async ensureWorker(id) { worker.adoptWarmWorker(id, `usernode-worker-${id}`); return `usernode-worker-${id}`; },
        execInWorker: (id, opts) => worker.execInWorker(id, opts),
        async stopTurn() {},
      },
      agentTurn,
      sessions: { runCodexAttemptLoop: sessions.runCodexAttemptLoop },
      activeWorkers: new Set(),
    },
  });
  assert.ok(!out.routed?.error, JSON.stringify(out.routed));
  const { env } = readDispatch(calls.find((c) => c.args?.[0] === 'exec' && c.args?.[1] === '-d'));
  assert.equal(env.MODE, 'build');
  assert.equal(env.AGENT_PROVIDER, 'openrouter');
  assert.equal(env.DISCARD_FAILED_TURN, '1');

  // run-cc.sh with that env, the turn ending on the notice with exit 0:
  // nothing is committed or pushed.
  const upstream = await fakeOpenRouter();
  t.after(() => upstream.close());
  const committed = (fx) => fs.readFileSync(fx.gitLog, 'utf8').split('\n').filter((l) => /^(add|commit)\b/.test(l));
  const fx = runnerFixture();
  const ran = await runRunCc(env, fx, upstream, { STUB_RESULT: API_ERROR });
  assert.equal(ran.code, 1, ran.out);
  assert.match(ran.out, /__USERNODE_WARN__ claude ended on an API error; skipping commit\/push/);
  assert.match(ran.out, /__USERNODE_RESULT__ cc_exit=0 ahead=0 behind=0 sha= push_ok=0 mode=build/);
  assert.doesNotMatch(ran.out, /__USERNODE_PHASE__ (commit|push)\b/);
  assert.deepEqual(committed(fx), []);

  // That journal, read back as the host reads it, is a failed turn and no revision.
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.agentHarness = 'claude';
  for (const line of ran.out.split('\n')) worker.parseLine(line, () => {}, state);
  state.exitCode = ran.code;
  assert.equal(live.failedClaudeTurn(state), 'the agent exited with code 1');
  assert.equal(followup.headMoved({ mode: 'build', result: state, reviewedHeadSha: 'a'.repeat(40), action: 'revise' }), false);

  // A good turn that only mentions an API error is committed as before.
  const fx2 = runnerFixture();
  const good = await runRunCc(env, fx2, upstream, {
    STUB_RESULT: 'Fixed the API error handling in the fetch helper.\n\nAPI error messages now say what to retry.',
  });
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /__USERNODE_PHASE__ commit/);
  assert.ok(committed(fx2).some((line) => line.startsWith('commit')), 'committed');
});
