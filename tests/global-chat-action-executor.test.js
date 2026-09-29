'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { CapabilityRegistry } = require('../src/services/global-chat/capability-registry');
const { createActionExecutor } = require('../src/services/global-chat/action-executor');

const THREAD_ID = '95df0790-4873-43cc-9608-728f3349da50';
const TURN_ID = '6d461f00-ca14-44ee-a2b0-67fda9c81d73';
const RESULT_ID = '00000000-0000-4000-8000-000000000001';

function destructiveDefinition(handler) {
  return {
    id: 'issues.close',
    domain: 'issues',
    title: 'Close issue',
    summary: 'Close an issue after explicit confirmation.',
    keywords: ['close', 'issue'],
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'],
    },
    resultSchema: {
      type: 'object', additionalProperties: false,
      properties: { closed: { type: 'boolean' } }, required: ['closed'],
    },
    renderer: 'issue',
    access: ({ actor }) => actor?.signedIn === true,
    risk: 'destructive',
    confirmation: 'required',
    classicPath: () => '#app/demo/dev/issues/7',
    mobileSupported: true,
    sensitiveFields: [],
    handler,
    tests: ['tests/global-chat-action-executor.test.js'],
  };
}

test('a confirmed action rechecks revision and authorization, executes once, and releases its lease', async () => {
  const calls = [];
  const stored = new Map();
  const store = {
    async claimTurn() { calls.push('claim'); return TURN_ID; },
    async releaseTurn(_pool, input) { calls.push(['release', input]); return true; },
    async startToolRun(_pool, input) { calls.push(['start', input]); return RESULT_ID; },
    async finishToolRun(_pool, input) {
      calls.push(['finish', input]);
      stored.set(input.toolRunId, {
        id: input.toolRunId,
        capabilityId: 'issues.close',
        authoritativeResult: input.authoritativeResult,
        modelResult: input.modelResult,
        renderer: input.renderer,
        classicPath: input.classicPath,
        status: input.status || 'completed',
      });
      return true;
    },
    async loadToolResults(_pool, input) {
      return input.resultIds.map((id) => stored.get(id)).filter(Boolean);
    },
  };
  let revision;
  const actions = {
    async consumeAction(_pool, input) {
      revision = await input.resolveObjectRevision({
        client: { transaction: true },
        capabilityId: 'issues.close',
        input: { number: 7 },
      });
      calls.push(['consume', input]);
      return {
        capabilityId: 'issues.close', input: { number: 7 },
        inputHash: 'hash', objectRevision: 'rev-7',
      };
    },
  };
  let executions = 0;
  const registry = new CapabilityRegistry([destructiveDefinition(async (input) => {
    executions += 1;
    return {
      modelResult: { closed: true },
      authoritativeResult: { closed: true, number: input.number },
    };
  })]);
  const executor = createActionExecutor({
    pool: {}, config: { dataEncryptionKey: 'key' }, registry, store, actions,
  });
  const events = [];
  const output = await executor.executeConfirmedAction({
    userId: 7,
    threadId: THREAD_ID,
    token: 'one-use-token',
    executionContext: {
      actor: { signedIn: true },
      resolveObjectRevision: async ({ client }) => client.transaction ? 'rev-7' : 'wrong',
    },
    emit: async (event) => { events.push(event); },
  });

  assert.equal(revision, 'rev-7');
  assert.equal(executions, 1);
  assert.equal(output.result.id, RESULT_ID);
  assert.deepEqual(output.result.authoritativeResult, { closed: true, number: 7 });
  assert.equal(calls[0], 'claim');
  assert.equal(calls.at(-1)[0], 'release');
  assert.deepEqual(events.map((event) => event.type), [
    'tool.started', 'tool.completed', 'result.attached',
  ]);
});

test('a failed confirmed action is recorded as failed and still releases the turn', async () => {
  const calls = [];
  const store = {
    async claimTurn() { return TURN_ID; },
    async releaseTurn() { calls.push('release'); return true; },
    async startToolRun() { return RESULT_ID; },
    async finishToolRun(_pool, input) { calls.push(input); return true; },
    async loadToolResults() { return []; },
  };
  const actions = {
    async consumeAction() {
      return { capabilityId: 'issues.close', input: { number: 7 } };
    },
  };
  const registry = new CapabilityRegistry([destructiveDefinition(async () => {
    const error = new Error('route refused');
    error.code = 'forbidden';
    throw error;
  })]);
  const executor = createActionExecutor({
    pool: {}, config: { dataEncryptionKey: 'key' }, registry, store, actions,
  });
  await assert.rejects(executor.executeConfirmedAction({
    userId: 7,
    threadId: THREAD_ID,
    token: 'one-use-token',
    executionContext: { actor: { signedIn: true } },
  }), /route refused/);
  assert.equal(calls[0].status, 'failed');
  assert.deepEqual(calls[0].modelResult, { ok: false, error: { code: 'forbidden' } });
  assert.equal(calls.at(-1), 'release');
});
