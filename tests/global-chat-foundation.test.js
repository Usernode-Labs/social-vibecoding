'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildRuntimeMetadata,
  serializeRuntimeMetadata,
} = require('../src/services/global-chat/prompt');
const {
  CapabilityRegistry,
  CapabilityRegistryError,
} = require('../src/services/global-chat/capability-registry');
const {
  PresentationError,
  firstUsePresentation,
  validatePresentation,
} = require('../src/services/global-chat/presentation');

function objectSchema(properties = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
  };
}

function capability(overrides = {}) {
  return {
    id: 'issues.list',
    domain: 'issues',
    title: 'List issues',
    summary: 'Find issues matching a query, state, label, or app.',
    keywords: ['find requests', 'bugs', 'board'],
    inputSchema: objectSchema({ query: { type: 'string' } }),
    resultSchema: objectSchema({ items: { type: 'array' } }),
    renderer: 'grouped_list',
    access: ({ actor }) => actor?.signedIn === true,
    risk: 'read',
    confirmation: 'never',
    classicPath: () => '#app/demo/dev/issues/1',
    mobileSupported: true,
    sensitiveFields: ['secret', 'items.*.token'],
    handler: async () => ({
      modelResult: {
        items: [{ number: 1, title: 'One', token: 'model-secret' }],
        secret: 'hidden',
      },
      authoritativeResult: {
        items: [{ number: 1, title: 'One', token: 'browser-only' }],
        secret: 'browser-secret',
      },
    }),
    tests: ['tests/issues-route.test.js'],
    ...overrides,
  };
}

function runtimeInput(overrides = {}) {
  return {
    request: {
      id: '85b6aee1-2f99-41f4-b86b-682c8a3f79c6',
      kind: 'user_turn',
      locale: 'en-US',
      timezone: 'America/Montevideo',
      cookie: 'must-not-pass',
    },
    client: {
      surface: 'web',
      viewport: 'compact',
      classicReturnPath: '#app/demo/dev/issues/1',
    },
    actor: {
      id: 42,
      username: 'alice',
      roles: ['member', 'collaborator', 'database_owner'],
      capabilityRegistryVersion: 'global-chat-capabilities-v1:abc',
      permissions: ['raw-secret-permission'],
      token: 'must-not-pass',
    },
    context: {
      activeAppSlug: 'demo',
      activeObject: { type: 'issue', id: 1, privateRow: 'must-not-pass' },
      threadSummary: 'The user is reviewing current work.',
      excludedSuggestionIds: ['issue.open', 'issue.open', 'issue.comment'],
      rawTranscript: 'must-not-pass',
    },
    globalChatProfile: {
      backend: 'openrouter',
      model: DEFAULT_MODEL,
      reasoningEffort: 'low',
      apiKey: 'must-not-pass',
    },
    developmentProfile: {
      backend: 'codex_openrouter',
      model: 'z-ai/glm-5.3-flash',
      reasoningEffort: 'high',
    },
    budget: {
      overallRemaining: '1.25',
      globalChatSpent: '0.02',
      globalChatCap: '0.50',
      resetAt: '2026-09-21T00:00:00.000Z',
      rawLedger: 'must-not-pass',
    },
    availableCapabilityIds: ['issues.list', 'issues.get'],
    authorization: 'must-not-pass',
    ...overrides,
  };
}

test('the versioned system prompt pins full parity, discovery, safety, and compact suggestions', () => {
  assert.equal(PROMPT_VERSION, 'global-chat-system-v1');
  assert.match(SYSTEM_PROMPT, /every capability.*Classic mode/i);
  assert.match(SYSTEM_PROMPT, /search_capabilities/);
  assert.match(SYSTEM_PROMPT, /untrusted data/i);
  assert.match(SYSTEM_PROMPT, /development model and reasoning effort/i);
  assert.match(SYSTEM_PROMPT, /Every authorized setting/i);
  assert.match(SYSTEM_PROMPT, /Never emit HTML/i);
  assert.match(SYSTEM_PROMPT, /exactly two short next-action labels/i);
  assert.match(SYSTEM_PROMPT, /Earlier suggestions remain in the transcript/i);
  assert.match(SYSTEM_PROMPT, /Open-in-Classic links.*added by Homeroom/i);
});

test('runtime metadata is allowlisted, deterministic, and defaults global chat to low effort', () => {
  const now = new Date('2026-09-18T12:00:00.000Z');
  const metadata = buildRuntimeMetadata(runtimeInput(), { now });

  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.request.timestamp, now.toISOString());
  assert.equal(metadata.globalChatProfile.model, DEFAULT_MODEL);
  assert.equal(metadata.globalChatProfile.reasoningEffort, DEFAULT_REASONING_EFFORT);
  assert.deepEqual(metadata.actor.roles, ['collaborator', 'member']);
  assert.deepEqual(metadata.context.activeObject, { type: 'issue', id: '1' });
  assert.deepEqual(metadata.context.excludedSuggestionIds, ['issue.open', 'issue.comment']);
  assert.equal(metadata.budget.currency, 'USD');

  const serialized = serializeRuntimeMetadata(metadata);
  assert.match(serialized, /^<homeroom-runtime-metadata>/);
  for (const forbidden of [
    'must-not-pass',
    'raw-secret-permission',
    'privateRow',
    'rawTranscript',
    'rawLedger',
    'apiKey',
    'authorization',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});

test('runtime metadata rejects unsafe Classic paths and invalid money values', () => {
  assert.throws(
    () => buildRuntimeMetadata(runtimeInput({
      client: { surface: 'web', viewport: 'regular', classicReturnPath: 'https://evil.example/' },
    })),
    /classicReturnPath/,
  );
  assert.throws(
    () => buildRuntimeMetadata(runtimeInput({
      budget: { globalChatSpent: '-1' },
    })),
    /globalChatSpent/,
  );
});

test('the capability registry is deterministic and hides unauthorized capabilities', () => {
  const first = capability();
  const second = capability({
    id: 'settings.read',
    domain: 'settings',
    title: 'Read settings',
    summary: 'Find and read an authorized settings group.',
    keywords: ['preferences', 'configuration'],
    renderer: 'setting',
    access: ({ actor }) => actor?.admin === true,
  });
  const registryA = new CapabilityRegistry([first, second]);
  const registryB = new CapabilityRegistry([second, first]);

  assert.equal(registryA.version, registryB.version);
  assert.deepEqual(registryA.ids(), ['issues.list', 'settings.read']);
  assert.deepEqual(
    registryA.search('find bugs', { actor: { signedIn: true, admin: false } }).map((entry) => entry.id),
    ['issues.list'],
  );
  assert.throws(
    () => registryA.describe('settings.read', { actor: { signedIn: true, admin: false } }),
    (error) => error instanceof CapabilityRegistryError
      && error.code === 'capability_not_found',
  );
});

test('capability execution keeps authoritative data intact and redacts model-facing fields', async () => {
  const registry = new CapabilityRegistry([capability()]);
  const result = await registry.execute(
    'issues.list',
    { query: 'one' },
    { actor: { signedIn: true } },
  );

  assert.equal(result.classicPath, '#app/demo/dev/issues/1');
  assert.equal(result.renderer, 'grouped_list');
  assert.equal(result.modelResult.secret, undefined);
  assert.equal(result.modelResult.items[0].token, undefined);
  assert.equal(result.modelResult.items[0].title, 'One');
  assert.equal(result.authoritativeResult.secret, 'browser-secret');
  assert.equal(result.authoritativeResult.items[0].token, 'browser-only');
});

test('capability inputs are validated locally even when a provider claims strict tool mode', async () => {
  let called = false;
  const registry = new CapabilityRegistry([capability({
    handler: async () => { called = true; return { authoritativeResult: { items: [] } }; },
  })]);
  await assert.rejects(
    registry.execute(
      'issues.list',
      { query: 'valid', modelAddedField: 'must not pass' },
      { actor: { signedIn: true } },
    ),
    (error) => error instanceof CapabilityRegistryError
      && error.code === 'invalid_capability_input',
  );
  assert.equal(called, false);
});

test('the registry rejects destructive capabilities without confirmation and unsafe paths', async () => {
  assert.throws(
    () => new CapabilityRegistry([capability({
      id: 'issues.delete',
      risk: 'destructive',
      confirmation: 'never',
    })]),
    /must require confirmation/,
  );

  const registry = new CapabilityRegistry([capability({
    handler: async () => ({ authoritativeResult: { items: [] }, classicPath: 'javascript:alert(1)' }),
  })]);
  await assert.rejects(
    registry.execute('issues.list', {}, { actor: { signedIn: true } }),
    (error) => error instanceof CapabilityRegistryError
      && error.code === 'invalid_classic_path',
  );
});

test('present_response accepts only two compact non-repeating suggestions and known results', () => {
  const value = validatePresentation({
    message: 'I found one issue.',
    resultRefs: ['result-1'],
    suggestions: [
      {
        id: 'issue.open',
        label: 'Open issue',
        prompt: 'Open issue 1.',
        capabilityHint: 'issues.get',
      },
      {
        id: 'issue.comment',
        label: 'Add comment',
        prompt: 'Help me add a comment to issue 1.',
        capabilityHint: 'issues.comment',
      },
    ],
  }, { availableResultIds: ['result-1'] });

  assert.equal(value.suggestions.length, 2);
  assert.equal(value.suggestions[0].label, 'Open issue');
  assert.equal(Object.hasOwn(value.suggestions[0], 'description'), false);

  assert.throws(
    () => validatePresentation({
      ...value,
      suggestions: [{ ...value.suggestions[0], description: 'Extra cognitive load' }, value.suggestions[1]],
    }, { availableResultIds: ['result-1'] }),
    /unsupported fields: description/,
  );
  assert.throws(
    () => validatePresentation(value, {
      availableResultIds: ['result-1'],
      excludedSuggestionIds: ['issue.open'],
    }),
    (error) => error instanceof PresentationError && error.code === 'repeated_suggestion',
  );
  assert.throws(
    () => validatePresentation({ ...value, resultRefs: ['made-up-result'] }, {
      availableResultIds: ['result-1'],
    }),
    (error) => error instanceof PresentationError
      && error.code === 'unknown_result_reference',
  );
});

test('the first-use state is instant, compact, and leaves More suggestions to the client', () => {
  const first = firstUsePresentation();
  const validated = validatePresentation(first, { availableResultIds: [] });

  assert.deepEqual(validated.suggestions.map((entry) => entry.label), [
    'Show my work',
    'Explore apps',
  ]);
  assert.equal(Object.hasOwn(validated, 'moreSuggestions'), false);
});
