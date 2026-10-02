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

// A shadow build of the bot's (buildAndPropose, propose: false: the same
// spec and build turns, nothing promoted), on `model`, through the real
// runtime resolution, attempt loop and worker dispatch.
async function runBotBuild(t, model) {
  const resolved = stubRuntime(t);
  const { worker, calls } = loadWorker(t, JOURNAL);
  const execs = [];
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
  };
  const out = await live.buildAndPropose({
    pool, deps, config: CONFIG, bot: BOT, app: APP, repo: { owner: 'usernode-bot', repo: 'todo' }, issueNumber: 12,
    issue: { title: 'Pins drift' }, seed: 'Please work on GitHub issue #12: "Pins drift".', buildNote: 'Pin the markers.',
    turnBudgetMs: 60_000, model, propose: false,
  });
  const dispatches = calls.filter((c) => c.args?.[0] === 'exec' && c.args?.[1] === '-d').map(readDispatch);
  return { out, resolved, execs, dispatches };
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
  console.log(JSON.stringify({ type: 'result', result: 'done', session_id: 'cc-or-1', usage: { input_tokens: 5, output_tokens: 7 } }));
})();
`);
  // git answers every question as though the turn sat on its session branch
  // with nothing to commit.
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\ncase "$1" in symbolic-ref) echo "$BRANCH";; esac\nexit 0\n');
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'Build issue #12');
  // The in-loop browser's MCP config, as worker-run.sh seeds it.
  const browserConfig = path.join(dir, 'usernode-mcp.json');
  fs.writeFileSync(browserConfig, JSON.stringify({ mcpServers: { playwright: { command: 'true' } } }));
  return { dir, bin, ws, prompt, runtimeLog, browserConfig };
}

// run-cc.sh with the dispatched env. Only what points at the container
// (paths, the provider's address) is swapped for this machine's.
function runRunCc(env, fx, upstream) {
  return new Promise((resolve) => {
    const child = spawn('sh', [path.join(ROOT, 'worker', 'run-cc.sh')], {
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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
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
  assert.deepEqual(sent[1], {
    type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoSCREENSHOT' },
  });
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
