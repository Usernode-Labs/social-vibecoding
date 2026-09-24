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
    'OpenRouter request #4: response streaming after 60s, 512 bytes in 2 chunks',
    'OpenRouter request #4: response streaming after 120s, 8192 bytes in 16 chunks',
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

test('idle heartbeat distinguishes a quiet Codex process with and without an active request', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  const progress = [];
  const send = event => worker.parseLine(
    `__USERNODE_CODING_PROVIDER__ ${JSON.stringify(event)}`,
    text => progress.push(text), state,
  );

  send({ kind: 'codex_output_idle', durationMs: 45_000, activeRequests: 0 });
  send({ kind: 'codex_output_idle', durationMs: 60_000, activeRequests: 0,
    prompt: 'private-prompt', key: 'private-key' });
  send({ kind: 'codex_output_idle', durationMs: 120_000, activeRequests: 1 });
  send({ kind: 'codex_output_idle', durationMs: 180_000, activeRequests: 'private-count' });

  assert.deepEqual(progress, [
    'Codex produced no output for 60s; 0 OpenRouter requests active',
    'Codex produced no output for 120s; 1 OpenRouter requests active',
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /private/);
});
