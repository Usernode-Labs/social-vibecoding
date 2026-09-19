'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  contextualSuggestionSet,
  resolveAction,
  SuggestionActionError,
} = require('../src/services/global-chat/suggestion-actions');
const { createSuggestionExecutor } = require('../src/services/global-chat/suggestion-executor');

const THREAD_ID = '95df0790-4873-43cc-9608-728f3349da50';
const RESULT_ID = '00000000-0000-4000-8000-000000000001';

test('fixed suggestions resolve only to server-owned read steps', () => {
  const apps = resolveAction({ suggestionId: 'next.general.apps', parameters: {} });
  assert.equal(apps.id, 'apps.list');
  assert.equal(apps.steps.length, 1);
  assert.match(apps.steps[0].capabilityId, /^apps\.get\.apps\./);
  assert.deepEqual(apps.steps[0].input, {
    pathParameters: {},
    query: [{ name: 'view', value: 'global-chat' }],
    bodyJson: null,
  });

  const activity = resolveAction({ suggestionId: 'next.apps.activity', parameters: {} });
  assert.equal(activity.id, 'apps.activity');
  assert.equal(activity.steps[0].capabilityId, 'apps.activity');

  const unread = resolveAction({ suggestionId: 'next.messages.unread', parameters: {} });
  assert.equal(unread.id, 'messages.unread');
  assert.equal(unread.steps[0].capabilityId, 'messages.unread');

  const spending = resolveAction({ suggestionId: 'next.settings.budget', parameters: {} });
  assert.equal(spending.id, 'settings.spending');
  assert.equal(spending.steps[0].capabilityId, 'settings.spending');

  const notification = resolveAction({
    actionId: 'notification.detail', parameters: { notificationId: '42' },
  });
  assert.equal(notification.steps[0].input.pathParameters.id, '42');

  const leaderboard = resolveAction({
    actionId: 'leaderboard.profile', parameters: { userId: '7' },
  });
  assert.equal(leaderboard.steps[0].input.pathParameters.userId, '7');

  assert.throws(
    () => resolveAction({ suggestionId: 'next.governance.votes', parameters: {} }),
    (error) => error instanceof SuggestionActionError
      && error.code === 'direct_action_not_found',
  );

  const issue = resolveAction({
    actionId: 'issue.detail',
    parameters: { appSlug: 'social-vibecoding', issueNumber: '2377' },
  });
  assert.equal(issue.steps[0].input.pathParameters.slug, 'social-vibecoding');
  assert.equal(issue.steps[0].input.pathParameters.number, '2377');

  assert.throws(
    () => resolveAction({
      actionId: 'issue.detail',
      parameters: { appSlug: '../admin', issueNumber: '2377' },
    }),
    (error) => error instanceof SuggestionActionError
      && error.code === 'invalid_direct_action',
  );
  assert.throws(
    () => resolveAction({ actionId: 'issues.delete', parameters: {} }),
    (error) => error instanceof SuggestionActionError
      && error.code === 'direct_action_not_found',
  );
});

test('contextual actions preserve the exact target in transcript copy and every next prompt', () => {
  const issue = resolveAction({
    actionId: 'issue.detail',
    parameters: { appSlug: 'usernode-2d5619', issueNumber: '2377' },
    targetLabel: 'Global Chat interface (#2377)',
  });
  assert.equal(issue.label, 'Open Global Chat interface (#2377)');
  assert.equal(issue.message, 'Here are the details for Global Chat interface (#2377).');

  const contextual = contextualSuggestionSet(issue);
  assert.match(contextual.topic, /Global Chat interface \(#2377\).*usernode-2d5619/);
  assert.equal(contextual.suggestions.length, 5);
  assert.ok(contextual.suggestions.every((suggestion) => (
    /Global Chat interface \(#2377\)|usernode-2d5619/.test(suggestion.prompt)
  )));
  assert.ok(contextual.suggestions.slice(0, 4).every((suggestion) => (
    /#2377|usernode-2d5619/.test(suggestion.label)
  )));
  assert.ok(contextual.suggestions.every((suggestion) => (
    !suggestion.actionId || Object.hasOwn(suggestion, 'parameters')
  )));
  const appIssues = contextual.suggestions.find((suggestion) => (
    suggestion.actionId === 'issues.for_app'
  ));
  assert.equal(appIssues.relatedSuggestions.length, 5);
  assert.ok(appIssues.relatedSuggestions.every((suggestion) => (
    /Global Chat interface \(#2377\)|usernode-2d5619/.test(suggestion.prompt)
  )));
  assert.equal(
    appIssues.relatedSuggestions.some((suggestion) => (
      contextual.suggestions.some((sibling) => sibling.id === suggestion.id)
    )),
    false,
  );
});

test('a direct suggestion persists authoritative results with zero model invocations', async () => {
  const calls = [];
  let messageId = 0;
  const store = {
    async claimTurn() { calls.push('claim'); return 'turn-1'; },
    async releaseTurn() { calls.push('release'); return true; },
    async insertMessage(_pool, value) {
      messageId += 1;
      calls.push({ type: 'message', value });
      return { id: String(messageId), ...value };
    },
    async startToolRun(_pool, value) {
      calls.push({ type: 'start', value });
      return RESULT_ID;
    },
    async finishToolRun(_pool, value) {
      calls.push({ type: 'finish', value });
      return true;
    },
    async loadToolResults() {
      return [{
        id: RESULT_ID,
        capabilityId: 'apps.get.apps.b3dd6aff',
        authoritativeResult: { ok: true, status: 200, data: { apps: [] } },
        renderer: 'app',
        classicPath: '#apps',
        status: 'completed',
      }];
    },
  };
  const registry = {
    get(id) {
      return {
        id,
        risk: 'read',
        confirmation: 'never',
        access: () => true,
      };
    },
    async execute(id, input) {
      calls.push({ type: 'execute', id, input });
      return {
        authoritativeResult: { ok: true, status: 200, data: { apps: [] } },
        modelResult: { ok: true, status: 200, data: { apps: [] } },
        renderer: 'app',
        classicPath: '#apps',
      };
    },
  };
  const executor = createSuggestionExecutor({
    pool: {},
    config: { dataEncryptionKey: 'test-key' },
    registry,
    store,
  });
  const result = await executor.execute({
    userId: 7,
    threadId: THREAD_ID,
    suggestionId: 'next.general.apps',
    parameters: {},
    excludedSuggestionIds: ['next.general.apps'],
    client: { surface: 'web', viewport: 'regular' },
    executionContext: { actor: { signedIn: true } },
  });

  assert.equal(result.modelInvocations, 0);
  assert.equal(result.results[0].id, RESULT_ID);
  assert.deepEqual(result.presentation.resultRefs, [RESULT_ID]);
  assert.equal(result.presentation.suggestions.length, 5);
  assert.ok(result.presentation.suggestions.some((item) => item.actionId));
  assert.equal(calls.filter((entry) => entry?.type === 'execute').length, 1);
  assert.deepEqual(calls.slice(-1), ['release']);
});

test('inline reads return authoritative results without creating a chat turn or message', async () => {
  const calls = [];
  const store = {
    async claimTurn() { throw new Error('inline reads must not claim a turn'); },
    async releaseTurn() { throw new Error('inline reads must not release a turn'); },
    async insertMessage() { throw new Error('inline reads must not insert transcript messages'); },
    async startToolRun(_pool, value) {
      calls.push({ type: 'start', value });
      return RESULT_ID;
    },
    async finishToolRun(_pool, value) {
      calls.push({ type: 'finish', value });
      return true;
    },
    async loadToolResults() {
      return [{
        id: RESULT_ID,
        capabilityId: 'session.detail',
        authoritativeResult: { ok: true, status: 200, data: { id: 4365 } },
        renderer: 'session',
        classicPath: '#app/usernode-2d5619/dev/chat',
        status: 'completed',
      }];
    },
  };
  const registry = {
    get(id) {
      return { id, risk: 'read', confirmation: 'never', access: () => true };
    },
    async execute(id, input) {
      calls.push({ type: 'execute', id, input });
      return {
        authoritativeResult: { ok: true, status: 200, data: { id: 4365 } },
        modelResult: { ok: true, status: 200, data: { id: 4365 } },
        renderer: 'session',
        classicPath: '#app/usernode-2d5619/dev/chat',
      };
    },
  };
  const executor = createSuggestionExecutor({
    pool: {}, config: { dataEncryptionKey: 'test-key' }, registry, store,
  });

  const result = await executor.executeInline({
    userId: 7,
    threadId: THREAD_ID,
    actionId: 'session.detail',
    parameters: { sessionId: '4365' },
    targetLabel: 'test (development #4365)',
    executionContext: { actor: { signedIn: true } },
  });

  assert.equal(result.modelInvocations, 0);
  assert.equal(result.results[0].id, RESULT_ID);
  assert.equal(calls.find((entry) => entry.type === 'start').value.messageId, null);
  assert.equal(calls.filter((entry) => entry.type === 'execute').length, 1);
});

test('a failed direct action persists a readable assistant answer and releases its turn', async () => {
  const calls = [];
  let messageId = 0;
  const store = {
    async claimTurn() { calls.push('claim'); return 'turn-1'; },
    async releaseTurn() { calls.push('release'); return true; },
    async insertMessage(_pool, value) {
      messageId += 1;
      calls.push({ type: 'message', value });
      return { id: String(messageId), ...value };
    },
    async startToolRun() { calls.push('start'); return RESULT_ID; },
    async finishToolRun(_pool, value) { calls.push({ type: 'finish', value }); return true; },
  };
  const failure = Object.assign(new Error('model result is invalid or too large'), {
    code: 'invalid_payload',
  });
  const registry = {
    get(id) {
      return { id, risk: 'read', confirmation: 'never', access: () => true };
    },
    async execute() { throw failure; },
  };
  const executor = createSuggestionExecutor({
    pool: {},
    config: { dataEncryptionKey: 'test-key' },
    registry,
    store,
  });

  await assert.rejects(executor.execute({
    userId: 7,
    threadId: THREAD_ID,
    suggestionId: 'next.general.apps',
    parameters: {},
    excludedSuggestionIds: ['next.general.apps'],
    client: { surface: 'web', viewport: 'regular' },
    executionContext: { actor: { signedIn: true } },
  }), (error) => error === failure);

  const messages = calls.filter((entry) => entry?.type === 'message');
  assert.equal(messages.length, 2);
  assert.equal(messages[0].value.role, 'user');
  assert.equal(messages[1].value.role, 'assistant');
  assert.equal(messages[1].value.payload.kind, 'direct_action_error');
  assert.equal(
    messages[1].value.text,
    'That result was too large to display. Try a narrower option.',
  );
  assert.equal(messages[1].value.payload.presentation.suggestions.length, 5);
  assert.deepEqual(calls.slice(-1), ['release']);
});
