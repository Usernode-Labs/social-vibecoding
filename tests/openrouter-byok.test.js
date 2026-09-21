'use strict';
// Tests for the OpenRouter BYOK / Codex server-side pieces (plan.md).
// Covers: the Codex JSONL normalizer, the codex config builder, resume-error
// classification, and the registry codex_openrouter entry.
//
// Run with: node --test tests/openrouter-byok.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const codex = require('../src/agents/codex-openrouter');
const registry = require('../src/agents/registry');

// ── Registry ──────────────────────────────────────────────────────────
test('registry resolves codex_openrouter and its runner', () => {
  assert.equal(registry.resolveBackend('codex_openrouter'), 'codex_openrouter');
  assert.equal(registry.getBackend('codex_openrouter').runner, '/usr/local/bin/run-codex-agent.sh');
  assert.equal(registry.providerFor('codex_openrouter'), 'openrouter');
});

// ── Codex config builder ──────────────────────────────────────────────
test('buildCodexConfig points directly at OpenRouter and disables agents', () => {
  const cfg = codex.buildCodexConfig({
    openRouterBaseUrl: 'https://openrouter.ai/api/v1/',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });
  assert.match(cfg, /model_provider = "usernode_openrouter"/);
  assert.match(cfg, /model = "openai\/gpt-5.3-codex"/);
  assert.match(cfg, /base_url = "https:\/\/openrouter.ai\/api\/v1"/);
  assert.match(cfg, /env_key = "OPENROUTER_API_KEY"/);
  assert.match(cfg, /\[shell_environment_policy\][\s\S]*exclude = \["OPENROUTER_API_KEY"\]/);
  assert.match(cfg, /\[agents\][\s\S]*enabled = false/);
  assert.match(cfg, /model_reasoning_effort = "high"/);
});

test('buildCodexConfig omits reasoning effort when not provided', () => {
  const cfg = codex.buildCodexConfig({ openRouterBaseUrl: 'http://x/v1', model: 'm' });
  assert.ok(!/model_reasoning_effort/.test(cfg), 'no reasoning effort line when unset');
});

// ── Codex JSONL normalizer ───────────────────────────────────────────
test('normalizeCodexLine maps thread.started to thread_started + stores thread id', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({ type: 'thread.started', thread_id: 'thr-0199' }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'thread_started');
  assert.equal(state.agentThreadId, 'thr-0199');
});

test('normalizeCodexLine maps a command item to $ <command>', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.started', item: { type: 'command_execution', command: 'npm test' },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'command_started');
  assert.match(ev[0].text, /^\$ npm test/);
});

test('normalizeCodexLine maps a file edit to Editing <path>', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.started', item: { type: 'file.edit', path: 'src/app.js' },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'file_changed');
  assert.match(ev[0].text, /Editing src\/app\.js/);
});

test('normalizeCodexLine maps turn.completed to usage + [done] with pinned fields', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 30,
      cache_write_input_tokens: 5,
      output_tokens: 50,
      reasoning_output_tokens: 12,
    },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'usage');
  assert.equal(ev[0].text, '[done]');
  assert.equal(ev[0].usage.inputTokens, 100);
  assert.equal(ev[0].usage.cachedInputTokens, 30);
  assert.equal(ev[0].usage.cacheWriteInputTokens, 5);
  assert.equal(ev[0].usage.outputTokens, 50);
  assert.equal(ev[0].usage.reasoningOutputTokens, 12);
  // The pinned contract has no dollar cost or model id here.
  assert.equal('cost' in ev[0].usage, false);
  assert.equal('model' in ev[0].usage, false);
});

test('normalizeCodexLine returns empty array for malformed JSON and unknown events', () => {
  const state = codex.newCodexState();
  assert.deepEqual(codex.normalizeCodexLine('not json', state), []);
  assert.deepEqual(codex.normalizeCodexLine(JSON.stringify({ type: 'future_event' }), state), []);
});

test('normalizeCodexLine maps turn.failed to an error event', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'error');
  assert.doesNotMatch(ev[0].text, /agent_failed/);
  assert.equal(ev[0].text, 'OpenRouter could not finish this request: boom');
  assert.equal(ev[0].errorCode, 'provider_error');
  assert.equal(state.ccIsError, true);
  assert.equal(state.agentError, 'boom');
  assert.equal(state.agentErrorCode, 'provider_error');
});

test('normalizeCodexLine maps item.completed with agent_message via item.text (real 0.146.0)', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I edited the file.' },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'agent_message');
  assert.equal(ev[0].text, 'I edited the file.');
  assert.equal(ev[0].fullText, 'I edited the file.');
});

test('normalizeCodexLine maps item.completed with error type (real 0.146.0)', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed', item: { id: 'item_0', type: 'error', message: '401 Unauthorized' },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'error');
  assert.equal(
    ev[0].text,
    'OpenRouter rejected your API key. Check the key in Settings, then send the request again.',
  );
  assert.equal(ev[0].errorCode, 'credential_failure');
  assert.equal(state.ccIsError, true);
  assert.equal(state.agentErrorCode, 'credential_failure');
  // The raw provider line is kept for the ledger's error_detail even though
  // the user never sees it.
  assert.equal(state.agentError, '401 Unauthorized');
});

test('normalizeCodexLine treats unknown-model fallback metadata as a nonfatal warning', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'error',
      message: 'Model metadata for `~deepseek/deepseek-v4-flash-latest` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
    },
  }), state);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'warning');
  assert.match(ev[0].text, /OpenRouter model metadata/);
  assert.doesNotMatch(ev[0].text, /agent_failed|Codex/);
  assert.equal(state.ccIsError, false);
  assert.equal(state.agentError, null);
});

test('normalizeCodexLine treats reconnect attempts as warnings until a real terminal failure', () => {
  const state = codex.newCodexState();
  const reconnect = codex.normalizeCodexLine(JSON.stringify({
    type: 'error', message: 'Reconnecting... 2/5 (connection reset)',
  }), state);
  assert.equal(reconnect[0].kind, 'warning');
  assert.match(reconnect[0].text, /OpenRouter connection/);
  assert.equal(state.ccIsError, false);

  const terminal = codex.normalizeCodexLine(JSON.stringify({
    type: 'turn.failed', error: { message: 'Provider connection failed' },
  }), state);
  assert.equal(terminal[0].kind, 'error');
  assert.equal(state.ccIsError, true);
  assert.equal(state.agentError, 'Provider connection failed');
});

// ── Resume-error classification ───────────────────────────────────────
test('classifyResumeError: thread-missing is retry-fresh; auth/credit/rate are not', () => {
  assert.equal(codex.classifyResumeError('thread not found', 1).retryFresh, true);
  assert.equal(codex.classifyResumeError('401 unauthorized', 1).retryFresh, false);
  assert.equal(codex.classifyResumeError('402 insufficient credits', 1).retryFresh, false);
  assert.equal(codex.classifyResumeError('429 rate limit', 1).retryFresh, false);
  assert.equal(codex.classifyResumeError('something weird', 1).retryFresh, false);
});

// ── Canonical OpenRouter API base (Commit 2 / plan 4) ────────────────
const { canonicalOpenRouterApiBase } = require('../src/config');

test('canonicalOpenRouterApiBase: default HTTPS base is canonical', () => {
  assert.equal(canonicalOpenRouterApiBase('https://openrouter.ai/api/v1', {}), 'https://openrouter.ai/api/v1');
});

test('canonicalOpenRouterApiBase: trailing slashes are stripped', () => {
  assert.equal(canonicalOpenRouterApiBase('https://openrouter.ai/api/v1/', {}), 'https://openrouter.ai/api/v1');
  assert.equal(canonicalOpenRouterApiBase('https://example.com/gw///', {}), 'https://example.com/gw');
});

test('canonicalOpenRouterApiBase: HTTPS custom path is accepted', () => {
  assert.equal(canonicalOpenRouterApiBase('https://proxy.example.com/openrouter/v1', {}), 'https://proxy.example.com/openrouter/v1');
});

test('canonicalOpenRouterApiBase: username/password rejected', () => {
  assert.equal(canonicalOpenRouterApiBase('https://user:pass@openrouter.ai/api/v1', {}), null);
});

test('canonicalOpenRouterApiBase: query params and fragments rejected', () => {
  assert.equal(canonicalOpenRouterApiBase('https://openrouter.ai/api/v1?x=1', {}), null);
  assert.equal(canonicalOpenRouterApiBase('https://openrouter.ai/api/v1#frag', {}), null);
});

test('canonicalOpenRouterApiBase: remote HTTP rejected even with insecure flag', () => {
  assert.equal(canonicalOpenRouterApiBase('http://openrouter.ai/api/v1', { isLocalDev: true, allowInsecureBase: 'true' }), null);
});

test('canonicalOpenRouterApiBase: loopback HTTP rejected without both local-dev conditions', () => {
  assert.equal(canonicalOpenRouterApiBase('http://localhost:3000', { isLocalDev: false, allowInsecureBase: 'true' }), null);
  assert.equal(canonicalOpenRouterApiBase('http://localhost:3000', { isLocalDev: true, allowInsecureBase: 'false' }), null);
  assert.equal(canonicalOpenRouterApiBase('http://localhost:3000', {}), null);
});

test('canonicalOpenRouterApiBase: loopback HTTP accepted only with both local-dev conditions', () => {
  assert.equal(canonicalOpenRouterApiBase('http://localhost:3000', { isLocalDev: true, allowInsecureBase: 'true' }), 'http://localhost:3000');
  assert.equal(canonicalOpenRouterApiBase('http://127.0.0.1:3000', { isLocalDev: true, allowInsecureBase: 'true' }), 'http://127.0.0.1:3000');
});

test('canonicalOpenRouterApiBase: empty or invalid values rejected', () => {
  assert.equal(canonicalOpenRouterApiBase('', {}), null);
  assert.equal(canonicalOpenRouterApiBase('not a url', {}), null);
  assert.equal(canonicalOpenRouterApiBase(null, {}), null);
});

// ── Pinned 0.146.0 JSONL contract (Commit 3) ─────────────────────────
test('normalizeCodexLine: full usage-total object retains cached/cache-write/reasoning', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 1000, cached_input_tokens: 400,
      cache_write_input_tokens: 90, output_tokens: 350,
      reasoning_output_tokens: 120,
    },
  }), state);
  assert.equal(evs[0].usage.inputTokens, 1000);
  assert.equal(evs[0].usage.cachedInputTokens, 400);
  assert.equal(evs[0].usage.cacheWriteInputTokens, 90);
  assert.equal(evs[0].usage.outputTokens, 350);
  assert.equal(evs[0].usage.reasoningOutputTokens, 120);
  assert.equal(state.usageSeen, true);
  assert.equal(state.cacheWriteInputTokens, 90);
});

test('normalizeCodexLine: missing usage stays null, not a false zero', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 10 },
  }), state);
  assert.equal(evs[0].usage.inputTokens, 10);
  assert.equal(evs[0].usage.outputTokens, null);
  assert.equal(evs[0].usage.cachedInputTokens, null);
  assert.equal(state.usageSeen, true);
});

test('normalizeCodexLine: command_completed uses aggregated_output + exit_code/status', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed',
    item: { id: 'c1', type: 'command_execution', aggregated_output: 'ok\n', exit_code: 0, status: 'completed' },
  }), state);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, 'command_completed');
  assert.equal(evs[0].exitCode, 0);
  assert.equal(evs[0].status, 'completed');
});

test('normalizeCodexLine: multiple file changes emit one event per path', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({
    type: 'item.completed',
    item: { id: 'f1', type: 'file_change', changes: [
      { kind: 'edit', path: 'a.js' },
      { kind: 'write', path: 'b.txt' },
    ] },
  }), state);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].kind, 'file_changed');
  assert.match(evs[0].text, /Editing a\.js/);
  assert.match(evs[1].text, /Writing b\.txt/);
});

test('normalizeCodexLine: top-level error sets terminal error state', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({ type: 'error', message: 'fatal' }), state);
  assert.equal(evs[0].kind, 'error');
  assert.equal(state.ccIsError, true);
  assert.equal(state.agentError, 'fatal');
});

test('normalizeCodexLine: turn.failed influences final status even with later exit marker', () => {
  const state = codex.newCodexState();
  codex.normalizeCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'backend exploded' } }), state);
  assert.equal(state.ccIsError, true);
  assert.equal(state.agentError, 'backend exploded');
});

test('normalizeCodexLine: unknown future events are ignored (empty array)', () => {
  const state = codex.newCodexState();
  assert.deepEqual(codex.normalizeCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'some_future_kind' } }), state), []);
  assert.deepEqual(codex.normalizeCodexLine(JSON.stringify({ type: 'turn.halted' }), state), []);
});

// ── Provider-error classification (#2676) ─────────────────────────────
const MAX_TOKENS_REFUSAL = 'stream disconnected before completion: This request '
  + 'requires more credits, or fewer max_tokens. You requested up to 131072 tokens, '
  + 'but can only afford 21605. To increase, visit '
  + 'https://openrouter.ai/settings/credits and upgrade to a paid account';

test('classifyProviderError: the max_tokens refusal carries both token figures', () => {
  const c = codex.classifyProviderError(MAX_TOKENS_REFUSAL);
  assert.equal(c.code, 'insufficient_credits_max_tokens');
  assert.equal(c.retryable, true);
  assert.equal(c.requestedTokens, 131072);
  assert.equal(c.affordableTokens, 21605);
});

test('classifyProviderError: the stream wrapper never hides the provider reason', () => {
  // The same refusal arrives both bare and wrapped by the stream layer. The
  // wrapper is what made every one of these read as a connection blip.
  assert.equal(codex.classifyProviderError('402 insufficient credits').code, 'insufficient_credits');
  assert.equal(
    codex.classifyProviderError('stream disconnected before completion: 402 insufficient credits').code,
    'insufficient_credits',
  );
  assert.equal(codex.classifyProviderError('429 rate limit exceeded').code, 'rate_limited');
  assert.equal(codex.classifyProviderError('401 Unauthorized').code, 'credential_failure');
  assert.equal(codex.classifyProviderError('stream disconnected before completion').code, 'stream_disconnected');
  assert.equal(codex.classifyProviderError('something weird').code, 'provider_error');
  assert.equal(codex.classifyProviderError('').code, 'provider_error');
});

test('describeProviderError: the remedy names the account that is actually paying', () => {
  const c = codex.classifyProviderError(MAX_TOKENS_REFUSAL);
  const personal = codex.describeProviderError({ ...c, raw: MAX_TOKENS_REFUSAL, includedKey: false });
  assert.match(personal, /Your OpenRouter account cannot cover a reply this long\./);
  assert.match(personal, /about 22,000 tokens/);
  assert.match(personal, /Top up your OpenRouter credit/);

  const included = codex.describeProviderError({ ...c, raw: MAX_TOKENS_REFUSAL, includedKey: true });
  assert.match(included, /credit included with Homeroom/);
  assert.match(included, /Add your own OpenRouter key in Settings/);

  assert.match(
    codex.describeProviderError({ code: 'credential_failure', includedKey: true }),
    /Please report this so it can be fixed\./,
  );
  assert.match(
    codex.describeProviderError({ code: 'rate_limited' }),
    /^OpenRouter rate-limited this request\./,
  );
  assert.match(
    codex.describeProviderError({ code: 'provider_error', raw: 'weird upstream text' }),
    /weird upstream text/,
  );
});

test('every provider sentence is free of em dashes', () => {
  const codes = [
    'insufficient_credits_max_tokens', 'insufficient_credits', 'rate_limited',
    'credential_failure', 'stream_disconnected', 'provider_error',
  ];
  for (const code of codes) {
    for (const includedKey of [false, true]) {
      const text = codex.describeProviderError({
        code, includedKey, affordableTokens: 21605, raw: 'raw provider text',
      });
      assert.doesNotMatch(text, /\u2014|&mdash;|&#8212;/, code);
      assert.ok(text.length > 0, code);
    }
  }
});

test('normalizeCodexLine: the max_tokens refusal is classified and its affordable size kept', () => {
  const state = codex.newCodexState();
  const ev = codex.normalizeCodexLine(JSON.stringify({
    type: 'turn.failed', error: { message: MAX_TOKENS_REFUSAL },
  }), state);
  assert.equal(ev[0].kind, 'error');
  assert.equal(ev[0].errorCode, 'insufficient_credits_max_tokens');
  assert.equal(ev[0].affordableOutputTokens, 21605);
  assert.equal(state.agentErrorCode, 'insufficient_credits_max_tokens');
  assert.equal(state.affordableOutputTokens, 21605);
  // The raw text survives for the ledger even though the rendered sentence
  // is the short one.
  assert.equal(state.agentError, MAX_TOKENS_REFUSAL);
  assert.doesNotMatch(ev[0].text, /max_tokens|openrouter\.ai\/settings/);
});

test('normalizeCodexLine: the same failure is rendered once, not once per line', () => {
  // Codex reports one refusal as both a top-level error and a turn.failed.
  // Printing it twice is what made a single failure look like a cascade.
  const state = codex.newCodexState();
  const first = codex.normalizeCodexLine(JSON.stringify({
    type: 'error', message: MAX_TOKENS_REFUSAL,
  }), state);
  assert.ok(first[0].text);
  const second = codex.normalizeCodexLine(JSON.stringify({
    type: 'turn.failed', error: { message: MAX_TOKENS_REFUSAL },
  }), state);
  assert.equal(second[0].kind, 'error');
  assert.equal(second[0].text, null);
  // Suppressing the duplicate must not suppress the state it carries.
  assert.equal(second[0].errorCode, 'insufficient_credits_max_tokens');
  assert.equal(state.ccIsError, true);
});

test('normalizeCodexLine: a reconnect over a hard refusal escalates instead of counting to five', () => {
  const state = codex.newCodexState();
  const evs = codex.normalizeCodexLine(JSON.stringify({
    type: 'error', message: 'Reconnecting... 2/5 (402 insufficient credits)',
  }), state);
  assert.equal(evs[0].kind, 'error');
  assert.equal(state.ccIsError, true);
});

test('nonFatalDiagnostic renders the reconnect counter in plain words', () => {
  const text = codex.nonFatalDiagnostic('Reconnecting... 2/5 (connection reset)');
  assert.equal(text, 'OpenRouter connection interrupted, retrying (attempt 2 of 5)…');
  assert.doesNotMatch(text, /\u2014/);
});
