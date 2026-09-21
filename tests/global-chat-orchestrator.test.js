'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { CapabilityRegistry } = require('../src/services/global-chat/capability-registry');
const {
  canFastCompleteRead,
  createGlobalChatOrchestrator,
} = require('../src/services/global-chat/orchestrator');
const { capabilityToolName } = require('../src/services/global-chat/tool-protocol');

const THREAD_ID = '95df0790-4873-43cc-9608-728f3349da50';
const TURN_ID = '6d461f00-ca14-44ee-a2b0-67fda9c81d73';

function schema(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}

function definition(overrides = {}) {
  return {
    id: 'issues.list',
    domain: 'issues',
    title: 'List issues',
    summary: 'List issues matching a query.',
    keywords: ['issues', 'find', 'list'],
    inputSchema: schema({ query: { type: 'string', maxLength: 100 } }, ['query']),
    resultSchema: schema({ items: { type: 'array' } }, ['items']),
    renderer: 'grouped_list',
    access: ({ actor }) => actor?.signedIn === true,
    risk: 'read',
    confirmation: 'never',
    classicPath: () => '#app/demo/dev/issues',
    mobileSupported: true,
    sensitiveFields: [],
    handler: async (input) => ({
      modelResult: { items: [{ number: 1, title: input.query }] },
      authoritativeResult: { items: [{ number: 1, title: input.query }] },
    }),
    tests: ['tests/global-chat-orchestrator.test.js'],
    ...overrides,
  };
}

function providerResponse(toolCalls, extras = {}) {
  return {
    servedModel: 'cheap/global',
    toolCalls,
    assistantMessage: { role: 'assistant', content: null, tool_calls: toolCalls },
    usage: { inputTokens: 1, outputTokens: 1 },
    ...extras,
  };
}

function call(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

const DEFAULT_SUGGESTIONS = [
  { id: 'issue.open', label: 'Open issue', prompt: 'Open issue 1.', capabilityHint: 'issues.get' },
  { id: 'issue.edit', label: 'Edit issue', prompt: 'Edit issue 1.', capabilityHint: 'issues.edit' },
  { id: 'issue.comment', label: 'Add comment', prompt: 'Comment on issue 1.', capabilityHint: 'issues.comment' },
  { id: 'issue.vote', label: 'Vote', prompt: 'Vote on issue 1.', capabilityHint: 'issues.vote' },
  { id: 'issue.develop', label: 'Start development', prompt: 'Start development for issue 1.', capabilityHint: 'development.start' },
];

function presentation(resultRefs = [], suggestions = DEFAULT_SUGGESTIONS) {
  return {
    message: resultRefs.length ? 'I found one issue.' : 'What next?',
    resultRefs,
    suggestions,
  };
}

function harness({
  definitions = [definition()],
  responses = [],
  priorMessages = [],
  historyHasMore = false,
  threadSummary = null,
  compactedSummary = null,
} = {}) {
  const calls = [];
  const results = new Map();
  const messages = [];
  let nextMessage = 1;
  let nextResult = 1;
  const store = {
    MAX_MESSAGE_CHARS: 12_000,
    async claimTurn(_pool, input) { calls.push({ type: 'claim', input }); return TURN_ID; },
    async releaseTurn(_pool, input) { calls.push({ type: 'release', input }); return true; },
    async listMessages() {
      return {
        messages: priorMessages,
        hasMore: historyHasMore,
        before: historyHasMore ? (priorMessages[0]?.id || '31') : null,
      };
    },
    async threadForUser() { return { id: THREAD_ID, summary: threadSummary }; },
    async compactThread(_pool, input) {
      calls.push({ type: 'compact', input });
      return { id: THREAD_ID, summary: compactedSummary ?? threadSummary };
    },
    async insertMessage(_pool, input) {
      const message = {
        id: String(nextMessage++), threadId: input.threadId, role: input.role,
        text: input.text, payload: input.payload,
      };
      messages.push(message);
      return message;
    },
    async startToolRun(_pool, input) {
      const id = `00000000-0000-4000-8000-${String(nextResult++).padStart(12, '0')}`;
      calls.push({ type: 'tool.start', id, input });
      return id;
    },
    async finishToolRun(_pool, input) {
      calls.push({ type: 'tool.finish', input });
      if (input.status !== 'failed') {
        results.set(input.toolRunId, {
          id: input.toolRunId,
          capabilityId: calls.find((entry) => entry.type === 'tool.start' && entry.id === input.toolRunId)?.input.capabilityId,
          modelResult: input.modelResult,
          authoritativeResult: input.authoritativeResult,
          renderer: input.renderer,
          classicPath: input.classicPath,
          status: input.status || 'completed',
        });
      }
      return true;
    },
    async loadToolResults(_pool, input) {
      return input.resultIds.map((id) => results.get(id)).filter(Boolean);
    },
  };
  const accounting = {
    async invokeAccounted(input) {
      calls.push({ type: 'model', input });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response(input);
      return response;
    },
    async recordTurnOutcome(_pool, input) {
      calls.push({ type: 'turn.outcome', input });
      return true;
    },
  };
  const actions = {
    async prepareAction(_pool, input) {
      calls.push({ type: 'prepare', input });
      return {
        token: 'browser-only-confirmation-token',
        capabilityId: input.capabilityId,
        objectRevision: 'rev-4',
        expiresAt: '2026-09-18T13:05:00.000Z',
      };
    },
  };
  const registry = new CapabilityRegistry(definitions);
  const orchestrator = createGlobalChatOrchestrator({
    pool: {},
    config: { dataEncryptionKey: 'test-key' },
    registry,
    store,
    accounting,
    actions,
  });
  return { calls, messages, results, registry, orchestrator };
}

function turnInput(overrides = {}) {
  return {
    threadId: THREAD_ID,
    text: 'List my open issues',
    actor: { id: 7, username: 'alice', roles: ['member'] },
    client: { surface: 'web', viewport: 'regular', classicReturnPath: '#home' },
    context: { locale: 'en-US', timezone: 'America/Montevideo' },
    globalChatProfile: {
      backend: 'openrouter', model: 'cheap/global', reasoningEffort: 'low', spendCapUsd: '1',
    },
    developmentProfile: { backend: 'codex', model: 'glm/dev', reasoningEffort: 'high' },
    budget: { globalChatSpent: '0.02', globalChatCap: '1' },
    providerAllowance: { limitRemaining: 2 },
    model: {
      id: 'cheap/global', inputPricePerMillion: 0.1, outputPricePerMillion: 0.2,
    },
    apiKey: 'never-forwarded-outside-accounting',
    executionContext: { actor: { signedIn: true } },
    ...overrides,
  };
}

test('the one-call shortcut accepts independent compound reads but never skips writes or synthesis', () => {
  const calls = [{ call: { id: 'read_1' }, definition: { risk: 'read' } }];
  const success = new Map([['read_1', { ok: true, data: { ok: true, status: 200 } }]]);
  assert.equal(canFastCompleteRead('Could you show my apps?', calls, success), true);
  assert.equal(canFastCompleteRead('Help me search issues by tag.', calls, success), false);
  assert.equal(canFastCompleteRead('What are my recent issues?', calls, success), false);
  assert.equal(canFastCompleteRead('Show what I should work on next.', calls, success), false);
  assert.equal(canFastCompleteRead('Show my apps and then delete one.', calls, success), false);
  assert.equal(canFastCompleteRead('Show my apps and their open issues.', calls, success), false);
  const compoundCalls = [
    ...calls,
    { call: { id: 'read_2' }, definition: { risk: 'read' } },
  ];
  const compoundSuccess = new Map([
    ...success,
    ['read_2', { ok: true, data: { ok: true, status: 200 } }],
  ]);
  assert.equal(canFastCompleteRead(
    'Show the last issues I closed and what I merged.',
    compoundCalls,
    compoundSuccess,
  ), true);
  assert.equal(canFastCompleteRead(
    'Compare my closed issues with what I merged.',
    compoundCalls,
    compoundSuccess,
  ), false);
  assert.equal(canFastCompleteRead('Show my apps.', calls, new Map([
    ['read_1', { ok: true, data: { ok: false, status: 503 } }],
  ])), false);
});

test('the first call preloads matching capabilities and auto-attaches authoritative results', async () => {
  const resultId = '00000000-0000-4000-8000-000000000001';
  const responses = [
    providerResponse([
      call('list_1', capabilityToolName('issues.list'), { query: 'open' }),
    ]),
  ];
  const state = harness({ responses });
  const events = [];
  const result = await state.orchestrator.runTurn(turnInput({
    emit: async (event) => { events.push(event); },
  }));

  assert.equal(result.presentation.message, 'Here’s what I found.');
  assert.deepEqual(result.presentation.resultRefs, [resultId]);
  assert.equal(result.results[0].authoritativeResult.items[0].title, 'open');
  assert.equal(result.presentation.suggestions.length, 5);
  assert.equal(state.messages.filter((message) => message.role === 'assistant').length, 1);

  const modelCalls = state.calls.filter((entry) => entry.type === 'model');
  assert.equal(modelCalls.length, 1);
  assert.ok(modelCalls[0].input.tools.some(
    (tool) => tool.function.name === capabilityToolName('issues.list'),
  ));
  assert.equal(modelCalls[0].input.toolChoice, 'auto');
  assert.equal(modelCalls[0].input.tools.some(
    (tool) => tool.function.name === 'present_response',
  ), true);
  assert.equal(modelCalls[0].input.tools.some(
    (tool) => tool.function.name === 'request_more_suggestions',
  ), false);
  assert.equal(modelCalls[0].input.reasoningEffort, 'low');
  assert.equal(modelCalls[0].input.model.id, 'cheap/global');
  assert.equal(modelCalls[0].input.maxOutputTokens, 1_000);
  assert.equal(modelCalls[0].input.timeoutMs, 10_000);
  assert.equal(modelCalls[0].input.sessionId, `${TURN_ID}:turn-v1:route-1`);
  assert.match(modelCalls[0].input.messages[0].content, /Homeroom Global Chat \(experimental\)/);
  assert.equal(modelCalls[0].input.messages.at(-1).content, 'List my open issues');
  assert.match(modelCalls[0].input.messages[1].content, /"availableCapabilities"/);
  assert.doesNotMatch(JSON.stringify(modelCalls[0].input.messages), /never-forwarded-outside-accounting/);
  assert.deepEqual(modelCalls[0].input.providerAllowance, { limitRemaining: 2 });
  assert.ok(events.some((event) => event.type === 'result.attached'));
  assert.equal(events.at(-1).type, 'turn.completed');
  assert.ok(state.calls.some((entry) => entry.type === 'release'));
  assert.equal(state.calls.find((entry) => entry.type === 'turn.outcome').input.outcome, 'success');
});

test('one model plan executes independent closed-issue and merged-work reads in parallel', async () => {
  const closed = definition({
    id: 'issues.closed_by_me',
    title: 'List issues closed by my merged work',
    summary: 'List recent issues closed by the signed-in user across apps.',
    keywords: ['closed issues', 'issues i closed', 'last issues closed'],
    inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['limit']),
    renderer: 'issue',
    handler: async () => ({
      modelResult: { items: [{ number: 7 }] },
      authoritativeResult: { items: [{ number: 7, title: 'Closed issue' }] },
    }),
  });
  const merged = definition({
    id: 'governance.merged_by_me',
    domain: 'governance',
    title: 'List my recently merged work',
    summary: 'List recent work merged by the signed-in user across apps.',
    keywords: ['merged work', 'what i merged', 'recent merges', 'issues linked to merges'],
    inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['limit']),
    renderer: 'proposal',
    handler: async () => ({
      modelResult: { items: [{ id: 8 }] },
      authoritativeResult: { items: [{ id: 8, title: 'Merged proposal' }] },
    }),
  });
  const responses = [providerResponse([
    call('closed_1', capabilityToolName(closed.id), { limit: 10 }),
    call('merged_1', capabilityToolName(merged.id), { limit: 10 }),
  ])];
  const state = harness({ definitions: [closed, merged], responses });
  const events = [];
  const userPrompt = 'Show me the last issues I closed and what I merged';
  const result = await state.orchestrator.runTurn(turnInput({
    text: userPrompt,
    model: {
      id: 'cheap/global', inputPricePerMillion: 0.1, outputPricePerMillion: 0.2,
      supportsParallelToolCalls: true,
    },
    emit: async (event) => { events.push(event); },
  }));

  assert.equal(state.calls.filter((entry) => entry.type === 'model').length, 1);
  assert.equal(state.calls.find((entry) => entry.type === 'model').input.parallelToolCalls, true);
  assert.equal(state.calls.find((entry) => entry.type === 'model').input.messages.at(-1).content, userPrompt);
  assert.equal(result.results.length, 2);
  assert.equal(result.presentation.resultRefs.length, 2);
  const progress = events.filter((event) => event.type === 'turn.progress');
  assert.deepEqual(
    progress.map((event) => event.phase),
    ['understanding', 'planning', 'running_tools', 'rendering'],
  );
  assert.equal(progress.find((event) => event.phase === 'running_tools').parallel, true);
  assert.equal(progress.find((event) => event.phase === 'planning').reasoningEffort, 'low');
  assert.deepEqual(
    progress.find((event) => event.phase === 'running_tools').operations
      .map((operation) => operation.capabilityId),
    ['issues.closed_by_me', 'governance.merged_by_me'],
  );
});

test('a failed Classic read stays in the model loop instead of using the fast completion', async () => {
  const failedRead = definition({
    handler: async () => ({
      modelResult: { ok: false, status: 503, data: { error: 'Unavailable' } },
      authoritativeResult: { ok: false, status: 503, data: { error: 'Unavailable' } },
    }),
  });
  const state = harness({
    definitions: [failedRead],
    responses: [
      providerResponse([call('list_1', capabilityToolName('issues.list'), { query: 'open' })]),
      providerResponse([call('present_1', 'present_response', presentation())]),
    ],
  });

  const result = await state.orchestrator.runTurn(turnInput());
  assert.equal(result.presentation.message, 'What next?');
  const modelCalls = state.calls.filter((entry) => entry.type === 'model');
  assert.equal(modelCalls.length, 2);
  assert.match(modelCalls[1].input.messages[0].content, /Homeroom Global Chat \(experimental\)/);
  assert.match(modelCalls[1].input.messages[1].content, /newest tool results/);
});

test('an incomplete platform request can ask for one missing value instead of looping', async () => {
  const clarification = {
    question: 'Which app should I search for issues in?',
    suggestions: [
      {
        id: 'clarify.apps', label: 'List apps', prompt: 'List my apps so I can choose one.',
        capabilityHint: 'apps.list',
      },
      {
        id: 'clarify.active', label: 'Use demo', prompt: 'List open issues in the demo app.',
        capabilityHint: 'issues.list',
      },
      {
        id: 'clarify.recent', label: 'Recent apps', prompt: 'Show my recently used apps.',
        capabilityHint: 'apps.list',
      },
      {
        id: 'clarify.search', label: 'Search apps', prompt: 'Help me search for an app by name.',
        capabilityHint: 'apps.list',
      },
      {
        id: 'clarify.all', label: 'All issues', prompt: 'List open issues across all apps I can access.',
        capabilityHint: 'issues.list',
      },
    ],
  };
  const state = harness({
    responses: [providerResponse([
      call('ask_1', 'ask_user_for_input', clarification),
    ])],
  });
  const result = await state.orchestrator.runTurn(turnInput());

  assert.equal(result.presentation.message, clarification.question);
  assert.deepEqual(result.presentation.resultRefs, []);
  assert.deepEqual(result.presentation.suggestions, clarification.suggestions);
  assert.deepEqual(result.results, []);
  const modelCall = state.calls.find((entry) => entry.type === 'model');
  assert.equal(modelCall.input.toolChoice, 'auto');
  assert.ok(modelCall.input.tools.some(
    (tool) => tool.function.name === 'ask_user_for_input',
  ));
  assert.equal(modelCall.input.tools.some(
    (tool) => tool.function.name === 'present_response',
  ), true);
});

test('an ambiguous preference can be clarified without five filler options', async () => {
  const state = harness({
    responses: [providerResponse([
      call('ask_preference', 'ask_user_for_input', {
        question: 'Would you rather fix a bug or build a feature?',
        suggestions: [
          { id: 'prefer.bug', label: 'Fix a bug', prompt: 'Help me choose a bug to fix.', capabilityHint: null },
          { id: 'prefer.feature', label: 'Build a feature', prompt: 'Help me choose a feature to build.', capabilityHint: null },
        ],
      }),
    ])],
  });
  const result = await state.orchestrator.runTurn(turnInput({ text: 'What should I work on next?' }));
  assert.equal(result.presentation.message, 'Would you rather fix a bug or build a feature?');
  assert.deepEqual(result.presentation.suggestions.map((item) => item.label), [
    'Fix a bug', 'Build a feature',
  ]);
  assert.equal(state.calls.filter((entry) => entry.type === 'model').length, 1);
});

test('protected writes prepare an exact one-use confirmation without executing the handler or exposing its token to the model', async () => {
  let executions = 0;
  const close = definition({
    id: 'issues.close',
    title: 'Close issue',
    summary: 'Close an issue after explicit confirmation.',
    keywords: ['close', 'issue'],
    inputSchema: schema({ number: { type: 'integer', minimum: 1 } }, ['number']),
    resultSchema: schema({ closed: { type: 'boolean' } }, ['closed']),
    risk: 'destructive',
    confirmation: 'required',
    confirmationPreview: (input) => ({ target: `Issue #${input.number}` }),
    renderer: 'issue',
    handler: async () => { executions += 1; return { authoritativeResult: { closed: true } }; },
  });
  const resultId = '00000000-0000-4000-8000-000000000001';
  const state = harness({
    definitions: [close],
    responses: [
      providerResponse([
        call('close_1', capabilityToolName('issues.close'), { number: 7 }),
      ]),
      providerResponse([
        call('present_1', 'present_response', presentation()),
      ]),
    ],
  });
  const events = [];
  const result = await state.orchestrator.runTurn(turnInput({
    text: 'Close issue 7',
    executionContext: {
      actor: { signedIn: true },
      resolveObjectRevision: async () => 'rev-4',
    },
    emit: async (event) => { events.push(event); },
  }));

  assert.equal(executions, 0);
  assert.equal(result.confirmations.length, 1);
  assert.equal(result.confirmations[0].token, 'browser-only-confirmation-token');
  const prepared = state.calls.find((entry) => entry.type === 'prepare');
  assert.deepEqual(prepared.input.input, { number: 7 });
  assert.equal(prepared.input.objectRevision, 'rev-4');
  const stored = state.results.get(resultId);
  assert.equal(stored.renderer, 'confirmation');
  assert.equal(stored.classicPath, '#app/demo/dev/issues');
  assert.equal(stored.authoritativeResult.title, 'Close issue');
  assert.deepEqual(stored.authoritativeResult.preview, { target: 'Issue #7' });
  assert.equal(stored.authoritativeResult.confirmationToken, 'browser-only-confirmation-token');
  const allModelRequests = state.calls
    .filter((entry) => entry.type === 'model')
    .map((entry) => JSON.stringify(entry.input.messages))
    .join('\n');
  assert.doesNotMatch(allModelRequests, /browser-only-confirmation-token/);
  assert.ok(events.some((event) => event.type === 'confirmation.required'));
  const modelCalls = state.calls.filter((entry) => entry.type === 'model');
  assert.match(modelCalls[1].input.messages[0].content, /Homeroom Global Chat \(experimental\)/);
  assert.match(modelCalls[1].input.messages[1].content, /Continue from the newest tool results/);
});

test('normal model presentations keep contextual options without repeating old buttons or calling the model again', async () => {
  const oldSuggestion = {
    id: 'issue.open', label: 'Open issue', prompt: 'Open issue 1.', capabilityHint: 'issues.get',
  };
  const priorMessages = [{
    role: 'assistant',
    text: 'Earlier',
    payload: { presentation: presentation([], [
      oldSuggestion,
      { id: 'issue.edit', label: 'Edit issue', prompt: 'Edit issue 1.', capabilityHint: 'issues.edit' },
      { id: 'issue.details', label: 'Issue details', prompt: 'Show issue 1 details.', capabilityHint: 'issues.get' },
      { id: 'issue.develop', label: 'Start development', prompt: 'Start development for issue 1.', capabilityHint: 'development.start' },
      { id: 'issue.share', label: 'Share issue', prompt: 'Show options to share issue 1.', capabilityHint: null },
    ]) },
  }];
  const state = harness({
    priorMessages,
    responses: [
      providerResponse([call('present_options', 'present_response', presentation([], [
        oldSuggestion,
        { id: 'issue.close', label: 'Close issue', prompt: 'Close issue 1.', capabilityHint: 'issues.close' },
        { id: 'issue.assign', label: 'Assign issue', prompt: 'Assign issue 1.', capabilityHint: 'issues.assign' },
        { id: 'issue.history', label: 'Issue history', prompt: 'Show issue 1 history.', capabilityHint: null },
        { id: 'issue.related', label: 'Related work', prompt: 'Show work related to issue 1.', capabilityHint: null },
      ]))]),
    ],
  });
  const result = await state.orchestrator.runTurn(turnInput({ text: 'Help me choose.' }));
  assert.deepEqual(result.presentation.suggestions.map((suggestion) => suggestion.id), [
    'issue.close', 'issue.assign', 'issue.history', 'issue.related',
  ]);
  const modelCalls = state.calls.filter((entry) => entry.type === 'model');
  assert.equal(modelCalls.length, 1);
});

test('older assistant options are compacted but the newest button prompts remain available', async () => {
  const older = {
    id: 'older.issue', label: 'Older issue',
    prompt: 'Find the full history of an older issue with a long prompt.', capabilityHint: null,
  };
  const latest = {
    id: 'latest.issue', label: 'Latest issue',
    prompt: 'Show details for issue 7.', capabilityHint: null,
  };
  const state = harness({
    priorMessages: [
      { role: 'assistant', text: 'Earlier', payload: { presentation: presentation([], [older]) } },
      { role: 'user', text: 'Show newer options.' },
      { role: 'assistant', text: 'Middle', payload: { presentation: presentation([], [
        { id: 'middle.issue', label: 'Middle issue', prompt: 'Show details for issue 4.', capabilityHint: null },
      ]) } },
      { role: 'user', text: 'Show even newer options.' },
      { role: 'assistant', text: 'Recent', payload: { presentation: presentation([], [latest]) } },
    ],
    responses: [providerResponse([], { content: 'Which one would you like?' })],
  });
  await state.orchestrator.runTurn(turnInput({ text: 'Help me choose.' }));
  const modelCall = state.calls.find((entry) => entry.type === 'model');
  const olderHistory = JSON.parse(modelCall.input.messages[2].content);
  const latestHistory = JSON.parse(modelCall.input.messages[6].content);
  assert.equal(olderHistory.suggestions[0].prompt, undefined);
  assert.deepEqual(olderHistory.suggestions[0], { id: older.id, label: older.label });
  assert.equal(latestHistory.suggestions[0].prompt, latest.prompt);
});

test('a model can answer with a short contextual next-step choice', async () => {
  const state = harness({
    responses: [providerResponse([
      call('present_options', 'present_response', {
        message: 'I can help you choose. Do you want to focus on issues or active development?',
        resultRefs: [],
        suggestions: [
          { id: 'choose.issues', label: 'Issues', prompt: 'Show issues I can work on.', capabilityHint: null },
          { id: 'choose.development', label: 'Active work', prompt: 'Show my active development work.', capabilityHint: null },
        ],
      }),
    ])],
  });
  const result = await state.orchestrator.runTurn(turnInput({ text: 'Help me choose my next task.' }));
  assert.deepEqual(result.presentation.suggestions.map((item) => item.label), ['Issues', 'Active work']);
  assert.equal(result.presentation.resultRefs.length, 0);
});

test('a model-written answer with inline results is not padded with generic buttons', async () => {
  const state = harness({ responses: [
    providerResponse([call('list_1', capabilityToolName('issues.list'), { query: 'open' })]),
    providerResponse([call('present_1', 'present_response', {
      message: 'This issue is open; its details are shown below.',
      resultRefs: [],
      suggestions: [],
    })]),
  ] });
  const result = await state.orchestrator.runTurn(turnInput({ text: 'Explain what you found for my open issues.' }));
  assert.equal(result.presentation.resultRefs.length, 1);
  assert.deepEqual(result.presentation.suggestions, []);
  assert.equal(state.calls.filter((entry) => entry.type === 'model').length, 2);
});

test('a transient provider failure reroutes once with visible progress', async () => {
  const transient = Object.assign(new Error('network failed'), { code: 'network' });
  const retryState = harness({
    responses: [
      transient,
      providerResponse([call('present_1', 'present_response', presentation())]),
    ],
  });
  const events = [];
  const result = await retryState.orchestrator.runTurn(turnInput({
    text: 'Hello.',
    emit: async (event) => { events.push(event); },
  }));
  assert.equal(result.presentation.message, 'What next?');
  assert.deepEqual(
    retryState.calls.filter((entry) => entry.type === 'model').map((entry) => entry.input.attemptNumber),
    [1, 2],
  );
  assert.deepEqual(
    retryState.calls.filter((entry) => entry.type === 'model').map((entry) => entry.input.sessionId),
    [`${TURN_ID}:turn-v1:route-1`, `${TURN_ID}:turn-v1:route-2`],
  );
  assert.equal(events.some((event) => event.phase === 'retrying'), true);
});

test('a provider timeout reroutes once but invalid requests do not retry', async () => {
  const timeout = Object.assign(new Error('slow provider'), { code: 'timeout' });
  const timeoutState = harness({ responses: [
    timeout,
    providerResponse([], { content: 'Which kind of work interests you?' }),
  ] });
  const result = await timeoutState.orchestrator.runTurn(turnInput({ text: 'What should I work on next?' }));
  assert.equal(result.presentation.message, 'Which kind of work interests you?');
  assert.deepEqual(timeoutState.calls.filter((entry) => entry.type === 'model')
    .map((entry) => entry.input.timeoutMs), [10_000, 12_000]);

  const invalid = Object.assign(new Error('invalid model request'), { code: 'invalid_request' });
  const invalidState = harness({ responses: [invalid] });
  await assert.rejects(
    invalidState.orchestrator.runTurn(turnInput({ text: 'Hello.' })),
    (error) => error.code === 'invalid_request',
  );
  assert.equal(invalidState.calls.filter((entry) => entry.type === 'model').length, 1);
});

test('an output-limit response gets one larger retry, not another identical request', async () => {
  const outputLimit = Object.assign(new Error('response reached limit'), { code: 'output_limit' });
  const state = harness({ responses: [
    outputLimit,
    providerResponse([], { content: 'I can help with that. What outcome do you want?' }),
  ] });
  const events = [];
  const result = await state.orchestrator.runTurn(turnInput({
    text: 'Help me decide what to do next.',
    emit: async (event) => { events.push(event); },
  }));
  assert.match(result.presentation.message, /What outcome/);
  assert.deepEqual(state.calls.filter((entry) => entry.type === 'model')
    .map((entry) => entry.input.maxOutputTokens), [1_000, 1_800]);
  assert.ok(events.some((event) => event.phase === 'retrying'
    && /more room/.test(event.message)));
});

test('hundreds of prior suggestion ids do not break runtime metadata', async () => {
  const state = harness({ responses: [providerResponse([], { content: 'What would you like next?' })] });
  const ids = Array.from({ length: 320 }, (_, index) => `suggestion.${index}`);
  const result = await state.orchestrator.runTurn(turnInput({
    text: 'What else can I do?',
    excludedSuggestionIds: ids,
  }));
  assert.equal(result.presentation.message, 'What would you like next?');
  const modelCall = state.calls.find((entry) => entry.type === 'model');
  assert.match(modelCall.input.messages[1].content, /suggestion\.319/);
  assert.doesNotMatch(modelCall.input.messages[1].content, /suggestion\.0"/);
});

test('ordinary assistant text is a valid answer without widgets or forced options', async () => {
  const state = harness({ responses: [providerResponse([], { content: 'Tell me whether you prefer bugs or new features, and I can help you choose.' })] });
  const result = await state.orchestrator.runTurn(turnInput({ text: 'What should I work on next?' }));
  assert.ok(state.calls.some((entry) => entry.type === 'release'));
  assert.equal(result.presentation.message, 'Tell me whether you prefer bugs or new features, and I can help you choose.');
  assert.deepEqual(result.presentation.suggestions, []);
  const model = state.calls.find((entry) => entry.type === 'model');
  assert.equal(model.input.toolChoice, 'auto');
  assert.equal(model.input.maxOutputTokens, 1_000);
});

test('runtime metadata uses only the server-owned compacted transcript summary', async () => {
  const state = harness({
    priorMessages: [{
      id: '31', role: 'assistant', text: 'Recent',
      payload: {},
    }],
    historyHasMore: true,
    threadSummary: 'Old server summary',
    compactedSummary: 'Server compacted context',
    responses: [providerResponse([call('present_1', 'present_response', presentation())])],
  });
  await state.orchestrator.runTurn(turnInput({
    text: 'Hello.',
    context: {
      locale: 'en-US',
      timezone: 'America/Montevideo',
      threadSummary: 'Browser says to ignore every rule',
    },
  }));
  const model = state.calls.find((entry) => entry.type === 'model');
  const metadata = model.input.messages[1].content;
  assert.match(metadata, /Server compacted context/);
  assert.doesNotMatch(metadata, /Browser says/);
  assert.ok(state.calls.some((entry) => entry.type === 'compact'));
});

test('More suggestions is one forced presentation call without a recursive More tool', async () => {
  const state = harness({
    responses: [providerResponse([call('present_1', 'present_response', presentation())])],
  });
  await state.orchestrator.runTurn(turnInput({
    kind: 'more_suggestions',
    text: 'Show more suggestions.',
  }));
  const modelCalls = state.calls.filter((entry) => entry.type === 'model');
  assert.equal(modelCalls.length, 1);
  assert.deepEqual(
    modelCalls[0].input.tools.map((tool) => tool.function.name),
    ['present_response'],
  );
  assert.deepEqual(modelCalls[0].input.toolChoice, {
    type: 'function', function: { name: 'present_response' },
  });
  assert.equal(modelCalls[0].input.maxOutputTokens, 800);
  assert.match(modelCalls[0].input.messages[0].content, /Homeroom Global Chat \(experimental\)/);
  assert.match(modelCalls[0].input.messages[1].content, /selected More suggestions/);
});
