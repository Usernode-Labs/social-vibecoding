'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../src/services/worker');

test('slow coding requests explain which OpenRouter boundary is quiet, then report recovery', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  const progress = [];
  const send = event => worker.parseLine(
    `__USERNODE_CODING_PROVIDER__ ${JSON.stringify(event)}`,
    text => progress.push(text), state,
  );

  send({ kind: 'provider_request_start', requestOrdinal: 4 });
  send({ kind: 'provider_request_pending', requestOrdinal: 4, stage: 'await_headers', durationMs: 15_000 });
  send({ kind: 'provider_request_pending', requestOrdinal: 4, stage: 'await_headers', durationMs: 30_000 });
  send({ kind: 'provider_request_pending', requestOrdinal: 4, stage: 'await_headers', durationMs: 45_000 });
  send({ kind: 'provider_response_headers', requestOrdinal: 4, durationMs: 47_000, httpStatus: 200 });
  send({ kind: 'provider_request_pending', requestOrdinal: 4, stage: 'await_first_byte', durationMs: 48_000 });
  send({ kind: 'provider_response_first_byte', requestOrdinal: 4, durationMs: 52_000 });
  send({ kind: 'provider_request_pending', requestOrdinal: 4, stage: 'streaming', durationMs: 60_000,
    responseBytes: 512, chunkCount: 2 });
  send({ kind: 'provider_request_pending', requestOrdinal: 4, stage: 'streaming', durationMs: 75_000,
    responseBytes: 2048, chunkCount: 8 });
  send({ kind: 'provider_request_pending', requestOrdinal: 4, stage: 'streaming', durationMs: 120_000,
    responseBytes: 8192, chunkCount: 16 });
  send({ kind: 'provider_request_end', requestOrdinal: 4, durationMs: 122_000,
    outcome: 'ok', httpStatus: 200 });

  assert.deepEqual(progress, [
    'OpenRouter request #4: no response headers after 30s',
    'OpenRouter request #4: HTTP 200 headers after 47s',
    'OpenRouter request #4: headers received, no response bytes after 48s',
    'OpenRouter request #4: first response byte after 52s',
    'OpenRouter request #4: still responding after 60s, 512 bytes so far',
    'OpenRouter request #4: still responding after 120s, 8192 bytes so far',
    'OpenRouter request #4: ok after 122s, HTTP 200',
  ]);
  assert.equal(state.codingProviderRequests.size, 0);
});

test('coding request progress ignores short requests and never copies untrusted fields', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  const progress = [];
  const send = event => worker.parseLine(
    `__USERNODE_CODING_PROVIDER__ ${JSON.stringify(event)}`,
    text => progress.push(text), state,
  );

  send({ kind: 'provider_request_start', requestOrdinal: 1 });
  send({ kind: 'provider_request_end', requestOrdinal: 1, durationMs: 800,
    outcome: 'ok', httpStatus: 200 });
  send({ kind: 'provider_request_start', requestOrdinal: 2, apiKey: 'private-key' });
  send({ kind: 'provider_request_pending', requestOrdinal: 2, durationMs: 30_000,
    stage: 'private-stage', prompt: 'private-prompt' });
  send({ kind: 'provider_request_pending', requestOrdinal: 2, durationMs: 45_000,
    stage: 'await_headers', url: 'https://private.invalid/' });
  send({ kind: 'provider_request_end', requestOrdinal: 2, durationMs: 46_000,
    outcome: 'private-outcome', httpStatus: 200, body: 'private-body' });
  worker.parseLine('__USERNODE_CODING_PROVIDER__ {bad json', text => progress.push(text), state);

  assert.deepEqual(progress, ['OpenRouter request #2: no response headers after 45s']);
  assert.doesNotMatch(JSON.stringify(progress), /private/);
  assert.equal(state.codingProviderRequests.size, 0);
});

test('coding request progress records content-free context for every request', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  const progress = [];
  const send = event => worker.parseLine(
    `__USERNODE_CODING_PROVIDER__ ${JSON.stringify(event)}`,
    text => progress.push(text), state,
  );

  send({ kind: 'provider_request_start', requestOrdinal: 3,
    payloadBytes: 175000, inputBytes: 151000, instructionBytes: 0, inputItems: 8,
    previousResponseLinked: false, maxOutputTokens: 32000,
    prompt: 'private-prompt', previous_response_id: 'private-response-id' });
  send({ kind: 'provider_request_end', requestOrdinal: 3, durationMs: 800,
    outcome: 'ok', httpStatus: 200, responseBytes: 2048, chunkCount: 3,
    body: 'private-body' });

  assert.deepEqual(progress, [
    'OpenRouter request #3: payload 175000 bytes, context 151000 bytes in 8 items, instructions 0 bytes, previous response absent, reply limit 32000 tokens',
    'OpenRouter request #3: ok after 1s, HTTP 200, 2048 response bytes in 3 chunks',
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /private/);
  assert.equal(state.codingProviderRequests.size, 0);
});

test('idle heartbeat names what Codex is waiting on, and flags only a quiet with nothing open', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  const progress = [];
  const send = event => worker.parseLine(
    `__USERNODE_CODING_PROVIDER__ ${JSON.stringify(event)}`,
    text => progress.push(text), state,
  );
  const codex = event => worker.parseLine(JSON.stringify(event), text => progress.push(text), state);

  send({ kind: 'codex_output_idle', durationMs: 45_000, activeRequests: 0 });
  send({ kind: 'codex_output_idle', durationMs: 60_000, activeRequests: 0,
    prompt: 'private-prompt', key: 'private-key' });
  send({ kind: 'codex_output_idle', durationMs: 120_000, activeRequests: 1 });
  send({ kind: 'codex_output_idle', durationMs: 180_000, activeRequests: 'private-count' });
  assert.deepEqual(progress, [
    'Codex has been silent for 60s with no command or model request open',
  ], 'a slow model request reports itself on its own lines');
  assert.doesNotMatch(JSON.stringify(progress), /private/);

  progress.length = 0;
  codex({ type: 'item.started', item: { id: 'item_7', type: 'command_execution',
    command: "/bin/bash -lc 'npm test 2>&1 | tail -12'" } });
  send({ kind: 'codex_output_idle', durationMs: 194_000, activeRequests: 0 });
  codex({ type: 'item.started', item: { id: 'item_8', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_navigate' } });
  send({ kind: 'codex_output_idle', durationMs: 75_000, activeRequests: 0 });
  codex({ type: 'item.completed', item: { id: 'item_8', type: 'mcp_tool_call', tool: 'browser_navigate', status: 'completed' } });
  codex({ type: 'item.completed', item: { id: 'item_7', type: 'command_execution', aggregated_output: 'ok', exit_code: 0 } });
  send({ kind: 'codex_output_idle', durationMs: 90_000, activeRequests: 0 });
  assert.deepEqual(progress, [
    "$ /bin/bash -lc 'npm test 2>&1 | tail -12'",
    "Waiting on a command for 194s: /bin/bash -lc 'npm test 2>&1 | tail -12'",
    'Using browser_navigate',
    'Waiting on browser_navigate for 75s (and 1 more)',
    'MCP completed',
    '  ⎿ ok',
    'Codex has been silent for 90s with no command or model request open',
  ]);
});

test('a Codex turn prints its start marker once', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  const progress = [];
  for (const ev of [{ type: 'thread.started', thread_id: 'thr-1' }, { type: 'turn.started' }]) {
    worker.parseLine(JSON.stringify(ev), text => progress.push(text), state);
  }
  assert.deepEqual(progress, ['[agent]']);
  assert.equal(state.agentThreadId, 'thr-1');
});
