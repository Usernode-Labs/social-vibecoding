'use strict';

// #3296: an OpenRouter model can run in Claude Code instead of Codex. The
// backend id stays `codex_openrouter` (the OpenRouter venue: key, ledger,
// catalog); the harness is the per-model choice of CLI inside it. These pin
// the map, the runtime context, the ledger's usage accounting, and the
// worker's env and journal parsing for the Claude harness.
//
// Run with: node --test tests/openrouter-harness.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../src/agents/registry');
const agentTurn = require('../src/services/agent-turn');
const worker = require('../src/services/worker');
const credentialStore = require('../src/services/credential-store');
const agentModels = require('../src/services/agent-models');

const ROOT = path.join(__dirname, '..');
const GLM = 'z-ai/glm-5.3-flash';
const DEEPSEEK = 'deepseek/deepseek-v4.1-flash';
const DEFAULT_MAP = registry.parseOpenRouterHarnessMap(`${GLM}=claude,${DEEPSEEK}=codex`);

// ── The map ───────────────────────────────────────────────────────────

test('the harness map parses model=harness pairs and drops what it cannot use', () => {
  assert.deepEqual({ ...DEFAULT_MAP }, { [GLM]: 'claude', [DEEPSEEK]: 'codex' });
  assert.deepEqual({ ...registry.parseOpenRouterHarnessMap('none') }, {});
  assert.deepEqual({ ...registry.parseOpenRouterHarnessMap('') }, {});
  assert.deepEqual({ ...registry.parseOpenRouterHarnessMap(undefined) }, {});
  assert.deepEqual(
    { ...registry.parseOpenRouterHarnessMap(' a/b = Claude , c/d=gemini, =codex, e/f, g/h=codex ') },
    { 'a/b': 'claude', 'g/h': 'codex' },
  );
});

test('a model resolves to its mapped harness, and anything unlisted stays on Codex', () => {
  const config = { openrouterModelHarnesses: DEFAULT_MAP };
  assert.equal(registry.openRouterHarnessForModel(GLM, config), 'claude');
  assert.equal(registry.openRouterHarnessForModel(DEEPSEEK, config), 'codex');
  assert.equal(registry.openRouterHarnessForModel('openai/gpt-6-astra', config), 'codex');
  assert.equal(registry.openRouterHarnessForModel(GLM, {}), 'codex');
  assert.equal(registry.openRouterHarnessForModel(null, config), 'codex');
  // Only exact ids match: a prefix never drags a family along.
  assert.equal(registry.openRouterHarnessForModel(`${GLM}:free`, config), 'codex');
});

test('persisted harness values fail safe to Codex', () => {
  assert.equal(registry.resolveOpenRouterHarness('claude'), 'claude');
  assert.equal(registry.resolveOpenRouterHarness('codex'), 'codex');
  for (const bad of [null, undefined, '', 'Claude', 'claude_code', 'gpt']) {
    assert.equal(registry.resolveOpenRouterHarness(bad), 'codex', String(bad));
  }
});

test('the runner follows the harness for OpenRouter and never for Anthropic', () => {
  assert.equal(registry.runnerFor('codex_openrouter'), '/usr/local/bin/run-codex-agent.sh');
  assert.equal(registry.runnerFor('codex_openrouter', 'codex'), '/usr/local/bin/run-codex-agent.sh');
  assert.equal(registry.runnerFor('codex_openrouter', 'claude'), '/usr/local/bin/run-cc.sh');
  assert.equal(registry.runnerFor('claude_code', 'codex'), '/usr/local/bin/run-cc.sh');
  // The backend id is unchanged: no third backend, so nothing persisted moves.
  assert.deepEqual(registry.listBackends().map((b) => b.id).sort(), ['claude_code', 'codex_openrouter']);
});

test('the platform default puts GLM in Claude Code and DeepSeek in Codex', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
  assert.match(src, /openrouterModelHarnesses: parseOpenRouterHarnessMap\(/);
  assert.match(src, /'z-ai\/glm-5\.3-flash=claude,deepseek\/deepseek-v4\.1-flash=codex'/);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
  const declared = (manifest.platform_env || []).find((s) => s.key === 'OPENROUTER_MODEL_HARNESSES');
  assert.ok(declared, 'dapp.json declares OPENROUTER_MODEL_HARNESSES');
  assert.equal(declared.required, false);
  assert.equal(declared.default, `${GLM}=claude,${DEEPSEEK}=codex`);
  assert.match(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'),
    /^OPENROUTER_MODEL_HARNESSES=z-ai\/glm-5\.3-flash=claude,deepseek\/deepseek-v4\.1-flash=codex$/m);
});

// ── Runtime context ───────────────────────────────────────────────────

function stubCredentials(t) {
  t.mock.method(credentialStore, 'readMetadata', async () => ({ id: 4, status: 'valid', revision: 2 }));
  t.mock.method(credentialStore, 'readSecret', async () => 'sk-or-test');
  t.mock.method(agentModels, 'resolveModelPricing', async () => ({
    id: GLM, name: 'GLM 5.3 Flash', contextLength: 200_000, maxOutputTokens: 64_000,
    supportsReasoning: true, reasoningEfforts: null, supportsTools: true,
    inputPricePerMillion: 0.1, outputPricePerMillion: 0.4,
  }));
}

const CONFIG = {
  codexOpenrouterEnabled: true,
  openrouterDefaultCodexModel: GLM,
  openrouterDefaultCodexReasoning: 'xhigh',
  openrouterModelHarnesses: DEFAULT_MAP,
};

// A pool that answers only the thread-harness lookup, from a fixed ledger.
function ledgerPool(harnessByThread) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/metadata->>'harness'/.test(sql)) {
        const [, threadId] = params;
        if (!Object.prototype.hasOwnProperty.call(harnessByThread, threadId)) return { rows: [] };
        return { rows: [{ harness: harnessByThread[threadId] }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function session(overrides = {}) {
  return {
    id: 5, agent_backend: 'codex_openrouter', agent_model: GLM,
    agent_reasoning_effort: null, agent_config_version: 1, agent_thread_id: null,
    ...overrides,
  };
}

test("'auto' resolves the harness from the map; callers that do not ask keep Codex", async (t) => {
  stubCredentials(t);
  const pool = ledgerPool({});
  const auto = await agentTurn.resolveCodexRuntimeContext({
    pool, userId: 3, config: CONFIG, session: session(), harness: 'auto',
  });
  assert.equal(auto.agentHarness, 'claude');
  assert.equal(auto.agentModel, GLM);
  // The thinking level travels to Claude Code too (as output_config.effort).
  assert.equal(auto.agentReasoningEffort, 'xhigh');

  const legacy = await agentTurn.resolveCodexRuntimeContext({
    pool, userId: 3, config: CONFIG, session: session(),
  });
  assert.equal(legacy.agentHarness, 'codex', 'the bot and evidence keep Codex');
  assert.equal(legacy.agentReasoningEffort, 'xhigh');

  const deepseek = await agentTurn.resolveCodexRuntimeContext({
    pool, userId: 3, config: CONFIG, session: session({ agent_model: DEEPSEEK }), harness: 'auto',
  });
  assert.equal(deepseek.agentHarness, 'codex');
  assert.equal(deepseek.agentReasoningEffort, 'xhigh');
});

test('a thread written by the other CLI is not resumed', async (t) => {
  stubCredentials(t);
  const pool = ledgerPool({ 'codex-thread': 'codex', 'claude-thread': 'claude' });
  const resolve = (threadId, harness) => agentTurn.resolveCodexRuntimeContext({
    pool, userId: 3, config: CONFIG, session: session({ agent_thread_id: threadId }), harness,
  });

  const same = await resolve('claude-thread', 'auto');
  assert.equal(same.resumeThreadId, 'claude-thread');
  assert.equal(same.resumeThreadDropped, false);

  // GLM moved to Claude Code while this session held a Codex thread.
  const moved = await resolve('codex-thread', 'auto');
  assert.equal(moved.resumeThreadId, null);
  assert.equal(moved.resumeThreadDropped, true);

  // Evidence (Codex) after a Claude Code build.
  const evidence = await resolve('claude-thread', 'codex');
  assert.equal(evidence.resumeThreadId, null);
  assert.equal(evidence.resumeThreadDropped, true);

  // A thread from before harnesses existed has no recorded harness: Codex.
  const legacy = await resolve('pre-harness-thread', 'codex');
  assert.equal(legacy.resumeThreadId, 'pre-harness-thread');
  assert.equal(legacy.resumeThreadDropped, false);
});

test('a failed thread lookup starts fresh rather than guessing', async (t) => {
  stubCredentials(t);
  const pool = { async query() { throw new Error('db down'); } };
  const ctx = await agentTurn.resolveCodexRuntimeContext({
    pool, userId: 3, config: CONFIG, session: session({ agent_thread_id: 't-1' }), harness: 'auto',
  });
  assert.equal(ctx.resumeThreadId, null);
  assert.equal(ctx.resumeThreadDropped, true);
});

// ── Ledger usage ──────────────────────────────────────────────────────

test("a Claude-harness result's input is the sum of Anthropic's three input counts", () => {
  const claude = agentTurn.usageTotalFromResult({
    agentHarness: 'claude',
    inputTokens: 120, cachedInputTokens: 90_000, cacheWriteInputTokens: 4_000,
    outputTokens: 2_500, reasoningOutputTokens: null,
  });
  assert.deepEqual(claude, {
    inputTokens: 94_120, cachedInputTokens: 90_000, cacheWriteInputTokens: 4_000,
    outputTokens: 2_500, reasoningOutputTokens: null,
  });
  // Codex already reports the total; nothing is added.
  const codex = agentTurn.usageTotalFromResult({
    agentHarness: 'codex',
    inputTokens: 94_120, cachedInputTokens: 90_000, cacheWriteInputTokens: null, outputTokens: 2_500,
  });
  assert.equal(codex.inputTokens, 94_120);
  // No harness recorded means Codex.
  assert.equal(agentTurn.usageTotalFromResult({ inputTokens: 10, cachedInputTokens: 5, outputTokens: 1 }).inputTokens, 10);
  // Missing usage stays unknown, never a false zero.
  assert.equal(agentTurn.usageTotalFromResult({ agentHarness: 'claude' }), null);
});

test('Claude Code totals cover the run, so the ledger skips the thread delta', async () => {
  assert.equal(agentTurn.usageScopeForHarness('claude'), 'run');
  assert.equal(agentTurn.usageScopeForHarness('codex'), 'thread');
  assert.equal(agentTurn.usageScopeForHarness(undefined), 'thread');

  const sql = [];
  const row = {
    session_id: 5, status: 'running', agent_thread_id: 'cc-1', reasoning_effort: null,
    metadata: { pricing: { available: true, inputPricePerMillion: 1, outputPricePerMillion: 2 } },
    input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0,
  };
  const client = {
    async query(text, params) {
      sql.push(text);
      if (/FOR UPDATE/.test(text)) return { rows: [row] };
      if (/previous_attempts/.test(text)) {
        // A previous run on the same Claude session that was bigger than this
        // one: subtracting it would record zero for a turn that did work.
        return { rows: [{ provider_input_tokens_total: 900_000, provider_output_tokens_total: 9_000 }] };
      }
      if (/^\s*UPDATE agent_turns/.test(text)) {
        row.updateParams = params;
        return { rowCount: 1 };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const result = await agentTurn.completeCodexAttempt({
    pool, turnUuid: 'u-1', threadId: 'cc-1', usageScope: 'run',
    usageTotal: { inputTokens: 100_000, cachedInputTokens: 80_000, outputTokens: 1_000 },
  });
  assert.ok(!sql.some((text) => /previous_attempts/.test(text)), 'no previous-total lookup for a run-scoped total');
  assert.equal(result.delta.inputTokens, 100_000);
  assert.equal(result.delta.outputTokens, 1_000);
  assert.equal(result.estimatedCost.estimatedCostUsd, 0.102);
});

// ── Worker: capability env ────────────────────────────────────────────

test('a Claude-harness OpenRouter turn gets the OpenRouter capability set and nothing Anthropic', () => {
  const build = worker.buildTurnSecretEnv({
    mode: 'build', agentBackend: 'codex_openrouter', agentHarness: 'claude',
    workerSessionJwt: 'general-session-token', workerPushJwt: 'push-only',
    issuesReadJwt: 'issues', anthropicProxyJwt: 'anthropic-proxy', prodDebugJwt: 'prod-debug',
    openrouterApiKey: 'sk-or-user', homeroomMcpToken: 'grant',
  });
  assert.deepEqual(build, {
    OPENROUTER_API_KEY: 'sk-or-user',
    ISSUES_JWT: 'issues',
    WORKER_JWT: 'push-only',
    HOMEROOM_MCP_TOKEN: 'grant',
  });
  const scout = worker.buildTurnSecretEnv({
    mode: 'scout', agentBackend: 'codex_openrouter', agentHarness: 'claude',
    workerPushJwt: 'push-only', issuesReadJwt: 'issues', openrouterApiKey: 'sk-or-user',
  });
  assert.deepEqual(scout, { OPENROUTER_API_KEY: 'sk-or-user', ISSUES_JWT: 'issues' });
  assert.throws(() => worker.buildTurnSecretEnv({
    mode: 'build', agentBackend: 'codex_openrouter', agentHarness: 'claude',
    workerPushJwt: 'push-only', issuesReadJwt: 'issues',
  }), /openrouterApiKey required/);
  for (const mode of ['sync', 'evidence']) {
    assert.throws(() => worker.buildTurnSecretEnv({
      mode, agentBackend: 'codex_openrouter', agentHarness: 'claude',
      issuesReadJwt: 'issues', openrouterApiKey: 'sk-or-user', evidenceJwt: 'e',
      evidenceMemberToken: 'm', evidenceAdminToken: 'a', evidenceFullAdminToken: 'f',
    }), /not supported/, mode);
  }
});

test('the backend flags keep their meaning and add the Claude harness beside them', () => {
  const claudeCode = worker.resolveTurnBackend('claude_code', 'codex');
  assert.equal(claudeCode.isClaude, true);
  assert.equal(claudeCode.runsClaude, true);
  assert.equal(claudeCode.isOpenRouter, false);
  assert.equal(claudeCode.harness, null);

  const codex = worker.resolveTurnBackend('codex_openrouter');
  assert.equal(codex.isCodex, true);
  assert.equal(codex.isClaudeOpenRouter, false);
  assert.equal(codex.runsClaude, false);

  const claudeOnOpenRouter = worker.resolveTurnBackend('codex_openrouter', 'claude');
  assert.equal(claudeOnOpenRouter.isCodex, false);
  assert.equal(claudeOnOpenRouter.isClaude, false, 'not Anthropic: no proxy, no live Anthropic spend');
  assert.equal(claudeOnOpenRouter.isClaudeOpenRouter, true);
  assert.equal(claudeOnOpenRouter.isOpenRouter, true);
  assert.equal(claudeOnOpenRouter.runsClaude, true);
});

// ── Worker: journal parsing ───────────────────────────────────────────

function claudeHarnessState() {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.agentHarness = 'claude';
  return state;
}

test("a Claude-harness journal is parsed as Claude stream-json, not Codex JSONL", () => {
  const state = claudeHarnessState();
  const progress = [];
  const feed = (event) => worker.parseLine(JSON.stringify(event), (line) => progress.push(line), state);
  feed({ type: 'system', subtype: 'init', session_id: 'cc-or-1' });
  feed({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'server.js' } },
  ] } });
  feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } });
  feed({
    type: 'result', result: 'All done.', session_id: 'cc-or-1', total_cost_usd: 4.2,
    usage: { input_tokens: 50, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 700, output_tokens: 300 },
  });
  assert.ok(progress.includes('Reading server.js'));
  assert.equal(state.lastResultText, 'All done.');
  assert.equal(state.inputTokens, 50);
  assert.equal(state.cachedInputTokens, 9_000);
  assert.equal(state.cacheWriteInputTokens, 700);
  assert.equal(state.outputTokens, 300);
  // Claude Code prices from Anthropic's list; the ledger prices OpenRouter.
  assert.equal(state.costUsd, 0);
  assert.equal(state.providerCostSeen, false);

  worker.finalizeHarnessResult(state);
  assert.equal(state.agentThreadId, 'cc-or-1', 'the resume id lives where every OpenRouter caller reads it');
  assert.equal(state.sessionId, null, 'nothing is written to the Anthropic cc_session_id');
  assert.equal(state.initSessionId, null);
  assert.equal(agentTurn.usageTotalFromResult(state).inputTokens, 9_750);
});

test('Codex and Anthropic Claude journals parse exactly as before', () => {
  const codex = worker.newWatchState();
  codex.agentBackend = 'codex_openrouter';
  worker.parseLine(JSON.stringify({ type: 'thread.started', thread_id: 'th-9' }), () => {}, codex);
  assert.equal(codex.agentThreadId, 'th-9');
  worker.finalizeHarnessResult(codex);
  assert.equal(codex.agentThreadId, 'th-9');

  const claude = worker.newWatchState();
  claude.agentBackend = 'claude_code';
  worker.parseLine(JSON.stringify({ type: 'result', result: 'ok', session_id: 'cc-1', total_cost_usd: 0.5 }), () => {}, claude);
  worker.finalizeHarnessResult(claude);
  assert.equal(claude.costUsd, 0.5);
  assert.equal(claude.sessionId, 'cc-1');
  assert.equal(claude.agentThreadId, null);
});

test('the dispatch records the harness so a restart replays the right parser', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'worker.js'), 'utf8');
  assert.match(src, /harness: resolvedHarness \|\| undefined,/);
  assert.match(src, /state\.agentHarness = recoveredBackend\.harness;/);
  const sessions = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'sessions.js'), 'utf8');
  assert.match(sessions, /agentHarness: activeTurn\.harness \|\| null,/);
  // Only the dev chat's scout and build opt in to the per-model harness.
  assert.equal((sessions.match(/harness: 'auto',/g) || []).length, 2);
  const ledger = fs.readFileSync(path.join(ROOT, 'src', 'services', 'agent-turn.js'), 'utf8');
  assert.match(ledger, /harness: registry\.resolveOpenRouterHarness\(ctx\.agentHarness\),\n\s+turnUuid: turnId,/);
});

test('stop and liveness probes see the Claude-over-OpenRouter adapter', () => {
  const script = worker.buildTurnStopScript('/home/node/.claude/turn-1.log');
  assert.match(script, /claude-openrouter-request/);
});

// ── UI ────────────────────────────────────────────────────────────────

test('the transcript and the log name the CLI that actually ran', () => {
  const transcript = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'features', 'agent-session', 'transcript.ts'), 'utf8');
  assert.match(transcript, /meta\.agentBackend === 'codex_openrouter' && meta\.agentHarness !== 'claude' \? 'Codex' : 'Claude Code'/);
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /data\.agentBackend === 'codex_openrouter' && data\.agentHarness !== 'claude'\n\s+\? 'Codex log'/);
  const sessions = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'sessions.js'), 'utf8');
  assert.match(sessions, /\.\.\.\(harness === 'claude' \? \{ agentHarness: harness \} : \{\}\),/);
});

test('pickers mark the Claude Code models and keep their thinking level', () => {
  const credentials = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'credentials.js'), 'utf8');
  assert.match(credentials, /harness: registry\.openRouterHarnessForModel\(model\.id, config\),/);
  for (const file of ['frontend/src/features/dev-chat/dev-chat.js', 'frontend/src/features/settings/settings.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'),
      /if \(model\?\.harness === 'claude'\) badges\.push\('Claude Code'\);/, file);
  }
  // The settings screen no longer calls every OpenRouter model a Codex model.
  const settings = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'features', 'settings', 'sections', 'openrouter.tsx'), 'utf8');
  assert.match(settings, /Models marked Claude Code in the list run in Claude Code; the rest run in Codex\./);
  assert.match(settings, /<SectionHeading title=\{<>OpenRouter<\/>\}>/);
  assert.match(settings, /\n\s+Coding model\n\s+<\/Label>/);
  const choice = fs.readFileSync(path.join(ROOT, 'frontend', 'src', 'features', 'agent-session', 'model-choice.ts'), 'utf8');
  assert.match(choice, /return !model \|\| model\.supportsReasoning !== false;/);
  assert.ok(!/harness !== 'claude'/.test(choice), 'no model loses its thinking level for running in Claude Code');
  assert.match(choice, /'Runs on your OpenRouter key, in Claude Code'/);
});
