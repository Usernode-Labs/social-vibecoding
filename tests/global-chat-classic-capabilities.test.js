'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const inventory = require('../src/services/global-chat/classic-inventory.generated.json');
const { CapabilityRegistry } = require('../src/services/global-chat/capability-registry');
const {
  classicCapabilityDefinitions,
  parseInput,
  resolveClassicPath,
} = require('../src/services/global-chat/classic-capabilities');

function context(overrides = {}) {
  return {
    actor: { signedIn: true, admin: true, canAdminWrite: true },
    client: { surface: 'web' },
    classicApi: {
      route: () => ({}),
      invoke: async () => ({
        ok: true,
        status: 200,
        authoritativeResult: { items: [{ id: 1, title: 'One' }] },
        modelResult: {
          ok: true, status: 200, untrusted: true,
          data: { items: [{ id: 1, title: 'One' }] },
        },
      }),
    },
    dispatchClientAction: async () => ({ ok: true, status: 200, data: { opened: true } }),
    queryUserHistory: async () => ({ items: [] }),
    ...overrides,
  };
}

test('the registry contains every mapped route, Settings section, and navigation surface', () => {
  const definitions = classicCapabilityDefinitions();
  const registry = new CapabilityRegistry(definitions);
  const expected = inventory.summary.mappedRoutes
    + inventory.summary.settingsSections
    + inventory.summary.navigationSurfaces
    + 11; // focused settings/activity reads, two updates, and two cross-app history reads
  assert.equal(definitions.length, expected);
  assert.equal(registry.size, expected);
  for (const route of inventory.routes.filter((item) => item.status === 'mapped')) {
    assert.ok(registry.get(route.capabilityId), `missing ${route.capabilityId}`);
  }
  for (const exempt of inventory.routes.filter((item) => item.status === 'exempt')) {
    if (exempt.capabilityId) assert.equal(registry.get(exempt.capabilityId), null);
  }
  for (const definition of definitions) {
    assert.deepEqual(
      [...definition.inputSchema.required].sort(),
      Object.keys(definition.inputSchema.properties).sort(),
      `${definition.id} must represent every strict-tool property as required`,
    );
  }
});

test('natural user wording discovers the intended read and development tools', () => {
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  const execution = context();

  assert.equal(registry.search('Show me apps I can explore.', execution)[0]?.id, 'apps.get.apps.b3dd6aff');
  assert.equal(
    registry.search('list the current issues', execution)[0]?.id,
    'issues.get.apps.item.issues.bcb11122',
  );
  const history = registry.search(
    'Show me the last issues I closed and what I merged', execution, { limit: 8 },
  ).map((entry) => entry.id);
  assert.ok(history.includes('issues.closed_by_me'));
  assert.ok(history.includes('governance.merged_by_me'));
  assert.deepEqual(registry.search('list unicorns', execution), []);
  assert.deepEqual(registry.search('delete unicorns', execution), []);
  assert.deepEqual(registry.search('merge bananas', execution), []);
  assert.equal(
    registry.search('start developing issue 2377', execution)[0]?.id,
    'development.post.apps.item.sessions.5206fad0',
  );
  assert.deepEqual(registry.search('What can I do?', execution), []);
});

test('route capabilities have strict bounded inputs and preserve the original route as authority', async () => {
  const route = inventory.routes.find((item) => (
    item.status === 'mapped'
      && item.transport === 'server_loopback'
      && item.path.includes(':slug')
      && item.method === 'GET'
  ));
  assert.ok(route);
  const definitions = classicCapabilityDefinitions();
  const definition = definitions.find(({ id }) => id === route.capabilityId);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.equal(definition.inputSchema.properties.pathParameters.additionalProperties, false);
  assert.equal(definition.inputSchema.properties.query.items.additionalProperties, false);
  assert.match(definition.inputSchema.description, new RegExp(`${route.method} ${route.path}`));
  assert.match(definition.inputSchema.properties.pathParameters.description, /:slug/);
  assert.match(definition.inputSchema.properties.pathParameters.properties.slug.description, /context\.activeAppSlug/);
  assert.match(definition.inputSchema.properties.query.description, /Use \[\] when none are needed/);
  assert.match(definition.inputSchema.properties.bodyJson.description, /JSON-encoded request body/);

  let call;
  const execution = context({
    classicApi: {
      route: (id) => id === route.capabilityId ? route : null,
      invoke: async (id, input) => {
        call = { id, input };
        return {
          ok: true, status: 200,
          authoritativeResult: { id: 9, title: 'Authoritative' },
          modelResult: { ok: true, status: 200, data: { id: 9, title: 'Authoritative' } },
        };
      },
    },
  });
  const pathNames = [...route.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  const pathParameters = Object.fromEntries(pathNames.map((name) => [name, name === 'slug' ? 'demo' : '1']));
  const registry = new CapabilityRegistry(definitions);
  const result = await registry.execute(route.capabilityId, {
    pathParameters,
    query: [{ name: 'page', value: '2' }],
    bodyJson: null,
  }, execution);
  assert.equal(call.id, route.capabilityId);
  assert.deepEqual(call.input, { pathParameters, query: [{ name: 'page', value: '2' }] });
  assert.equal(result.authoritativeResult.data.title, 'Authoritative');
  assert.equal(result.modelResult.data.title, 'Authoritative');
  assert.doesNotMatch(result.classicPath, /:slug/);
});

test('client and native operations execute only through their matching trusted dispatcher', async () => {
  const clientRoute = inventory.routes.find((item) => (
    item.status === 'mapped' && item.transport === 'client_action'
  ));
  const nativeRoute = inventory.routes.find((item) => (
    item.status === 'mapped' && item.transport === 'native_client'
  ));
  assert.ok(clientRoute && nativeRoute);
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());

  const noDispatcher = context({ dispatchClientAction: null });
  assert.equal(registry.get(clientRoute.capabilityId).access(noDispatcher), false);
  assert.equal(registry.get(nativeRoute.capabilityId).access(context()), false);

  let dispatched;
  const nativeContext = context({
    client: { surface: 'native_ios' },
    dispatchClientAction: async (action) => {
      dispatched = action;
      return { ok: true, status: 200, data: { completed: true } };
    },
  });
  const pathNames = [...nativeRoute.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  const pathParameters = Object.fromEntries(pathNames.map((name) => [name, '1']));
  const result = await registry.execute(nativeRoute.capabilityId, {
    pathParameters,
    query: [],
    bodyJson: nativeRoute.method === 'GET' ? null : '{}',
  }, nativeContext);
  assert.equal(dispatched.capabilityId, nativeRoute.capabilityId);
  assert.equal(dispatched.transport, 'native_client');
  assert.equal(result.authoritativeResult.data.completed, true);
});

test('admin discovery respects read-only versus write authorization', () => {
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  const adminRead = inventory.routes.find((item) => (
    item.status === 'mapped' && item.domain === 'admin' && item.risk === 'read'
  ));
  const adminWrite = inventory.routes.find((item) => (
    item.status === 'mapped' && item.domain === 'admin' && item.risk !== 'read'
  ));
  assert.ok(adminRead && adminWrite);
  const readOnly = context({
    actor: { signedIn: true, admin: true, canAdminWrite: false },
  });
  assert.equal(registry.get(adminRead.capabilityId).access(readOnly), true);
  assert.equal(registry.get(adminWrite.capabilityId).access(readOnly), false);
  assert.equal(registry.get(adminRead.capabilityId).access(context({
    actor: { signedIn: true, admin: false, canAdminWrite: false },
  })), false);
});

test('role and surface matrix matches the Classic authorization boundary', async () => {
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  const ordinary = inventory.routes.find((item) => (
    item.status === 'mapped'
      && item.domain !== 'admin'
      && item.transport === 'server_loopback'
      && item.risk === 'read'
      && item.path !== '/api/sessions/:id'
  ));
  const adminRead = inventory.routes.find((item) => (
    item.status === 'mapped' && item.domain === 'admin' && item.risk === 'read'
  ));
  const adminWrite = inventory.routes.find((item) => (
    item.status === 'mapped' && item.domain === 'admin' && item.risk !== 'read'
  ));
  const native = inventory.routes.find((item) => (
    item.status === 'mapped' && item.transport === 'native_client'
  ));
  assert.ok(ordinary && adminRead && adminWrite && native);

  const signedOut = context({ actor: { signedIn: false } });
  const member = context({ actor: { signedIn: true, roles: ['member'] } });
  const collaborator = context({ actor: { signedIn: true, roles: ['member', 'collaborator'] } });
  const creator = context({ actor: { signedIn: true, roles: ['member', 'creator'] } });
  const readOnlyAdmin = context({
    actor: { signedIn: true, admin: true, canAdminWrite: false, roles: ['member', 'admin_readonly'] },
  });
  const fullAdmin = context({
    actor: { signedIn: true, admin: true, canAdminWrite: true, roles: ['member', 'admin'] },
  });

  assert.equal(registry.get(ordinary.capabilityId).access(signedOut), false);
  for (const persona of [member, collaborator, creator, readOnlyAdmin, fullAdmin]) {
    assert.equal(registry.get(ordinary.capabilityId).access(persona), true);
  }
  assert.equal(registry.get(adminRead.capabilityId).access(member), false);
  assert.equal(registry.get(adminRead.capabilityId).access(readOnlyAdmin), true);
  assert.equal(registry.get(adminWrite.capabilityId).access(readOnlyAdmin), false);
  assert.equal(registry.get(adminWrite.capabilityId).access(fullAdmin), true);
  assert.equal(registry.get(native.capabilityId).access(member), false);
  assert.equal(registry.get(native.capabilityId).access(context({
    actor: { signedIn: true, roles: ['member', 'native'] },
    client: { surface: 'native_android' },
  })), true);

  // Resource-level collaborator/creator checks remain in the exact Classic
  // handler. Global Chat must preserve its denial rather than treating a
  // coarse role label as authorization.
  const denied = context({
    actor: { signedIn: true, roles: ['member', 'collaborator'] },
    classicApi: {
      route: (id) => id === ordinary.capabilityId ? ordinary : null,
      invoke: async () => ({
        ok: false,
        status: 403,
        authoritativeResult: { error: 'Classic denied this resource.' },
        modelResult: { ok: false, status: 403, data: { error: 'Classic denied this resource.' } },
      }),
    },
  });
  const names = [...ordinary.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)]
    .map((match) => match[1]);
  const result = await registry.execute(ordinary.capabilityId, {
    pathParameters: Object.fromEntries(names.map((name) => [name, name === 'slug' ? 'demo' : '1'])),
    query: [],
    bodyJson: null,
  }, denied);
  assert.equal(result.authoritativeResult.status, 403);
  assert.equal(result.modelResult.status, 403);
});

test('Settings and navigation capabilities stay compact and return exact Classic destinations', async () => {
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  const setting = inventory.settings.find((item) => item.key === 'openrouter');
  const navigation = inventory.navigation.find((item) => item.id === 'navigation.dev');
  assert.equal(registry.describe(setting.capabilityId, context()).renderer, 'setting');
  assert.equal(registry.describe(navigation.id, context()).renderer, 'status');
  assert.equal((await registry.execute(setting.capabilityId, {}, context())).classicPath, setting.classicPath);
  assert.equal((await registry.execute(navigation.id, {}, context())).classicPath, navigation.classicPath);
});

test('generic input parsing never silently truncates or repairs a write body', () => {
  assert.deepEqual(parseInput({
    pathParameters: { slug: 'demo' },
    query: [],
    bodyJson: '{"description":"whole"}',
  }), {
    pathParameters: { slug: 'demo' },
    query: [],
    body: { description: 'whole' },
  });
  assert.throws(
    () => parseInput({ pathParameters: {}, query: [], bodyJson: '{broken' }),
    /valid JSON/,
  );
  assert.equal(resolveClassicPath('#app/:slug', {
    pathParameters: { slug: 'demo/other' },
  }), '#app/demo%2Fother');
});

test('development handoff creates a session without letting the global model choose its agent', async () => {
  const startRoute = inventory.routes.find((item) => (
    item.method === 'POST' && item.path === '/api/apps/:slug/sessions'
  ));
  assert.ok(startRoute);
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  const definition = registry.get(startRoute.capabilityId);
  assert.equal(definition.title, 'Start development work');
  assert.match(definition.summary, /configured Development AI profile/);
  assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), [
    'appSlug', 'issueNumber', 'task',
  ]);
  assert.deepEqual([...definition.inputSchema.required].sort(), [
    'appSlug', 'issueNumber', 'task',
  ]);

  let invoked;
  const execution = context({
    classicApi: {
      route: () => ({}),
      async invoke(id, input) {
        invoked = { id, input };
        return {
          ok: true,
          status: 201,
          authoritativeResult: {
            session: {
              id: 44, app_slug: 'demo', status: 'active',
              agent_backend: 'codex_openrouter', agent_model: 'z-ai/glm-5.3-flash',
              agent_reasoning_effort: 'high',
            },
          },
          modelResult: { ok: true, status: 201, data: {} },
        };
      },
    },
  });
  const result = await registry.execute(startRoute.capabilityId, {
    appSlug: 'demo', task: 'Implement the compact global-chat cards.', issueNumber: 2377,
  }, execution);
  assert.equal(invoked.id, startRoute.capabilityId);
  assert.deepEqual(invoked.input, {
    pathParameters: { slug: 'demo' }, query: [], body: { issueNumber: 2377 },
  });
  assert.equal(Object.hasOwn(invoked.input.body, 'backend'), false);
  assert.equal(result.classicPath, '#app/demo/dev/sessions/44');
  assert.equal(result.authoritativeResult.data.state, 'client_action_required');
  assert.deepEqual(result.authoritativeResult.data.action.input.body, {
    message: 'Implement the compact global-chat cards.',
  });
  assert.equal(result.modelResult.data.session.agentModel, 'z-ai/glm-5.3-flash');
});

test('development continuation validates the owned session then queues its pinned agent turn', async () => {
  const turnRoute = inventory.routes.find((item) => (
    item.method === 'POST' && item.path === '/api/sessions/:id/chat'
  ));
  const detailRoute = inventory.routes.find((item) => (
    item.method === 'GET' && item.path === '/api/sessions/:id'
  ));
  assert.ok(turnRoute && detailRoute);
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  let invoked;
  const execution = context({
    classicApi: {
      route: () => ({}),
      async invoke(id, input) {
        invoked = { id, input };
        return {
          ok: true, status: 200,
          authoritativeResult: {
            session: {
              id: 44, app_slug: 'demo', status: 'active',
              agent_backend: 'codex_openrouter', agent_model: 'z-ai/glm-5.3-flash',
            },
          },
          modelResult: { ok: true, status: 200, data: {} },
        };
      },
    },
  });
  const result = await registry.execute(turnRoute.capabilityId, {
    sessionId: '44', task: 'Run the tests and fix failures.',
  }, execution);
  assert.equal(invoked.id, detailRoute.capabilityId);
  assert.deepEqual(invoked.input, { pathParameters: { id: '44' }, query: [] });
  assert.equal(result.authoritativeResult.data.action.pathTemplate, '/api/sessions/:id/chat');
  assert.equal(result.authoritativeResult.data.action.transport, 'development_handoff');
  assert.equal(result.classicPath, '#app/demo/dev/sessions/44');
});

test('generic mutation confirmations show bounded details without secret values', () => {
  const route = inventory.routes.find((item) => (
    item.status === 'mapped' && item.confirmation === 'required'
      && item.path !== '/api/apps/:slug/sessions'
      && item.path !== '/api/sessions/:id/chat'
  ));
  assert.ok(route);
  const definition = new CapabilityRegistry(classicCapabilityDefinitions()).get(route.capabilityId);
  const names = [...route.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  const preview = definition.confirmationPreview({
    pathParameters: Object.fromEntries(names.map((name) => [name, '1'])),
    query: [{ name: 'token', value: 'query-secret' }],
    bodyJson: '{"password":"body-secret","name":"Visible"}',
  });
  const serialized = JSON.stringify(preview);
  assert.match(serialized, /Visible/);
  assert.doesNotMatch(serialized, /query-secret|body-secret/);
});

test('every Settings group is queryable in one small logical result', async () => {
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  const inspector = registry.get('settings.inspect');
  assert.deepEqual(
    [...inspector.inputSchema.properties.group.enum].sort(),
    inventory.settings.map((item) => item.key).sort(),
  );
  const result = await registry.execute('settings.inspect', { group: 'global-chat' }, context({
    globalChatProfile: {
      backend: 'openrouter', model: 'deepseek/cheap', reasoningEffort: 'low', spendCapUsd: '2',
    },
    globalChatUsage: { spentUsd: '0.12', capUsd: '2' },
    developmentProfile: {
      backend: 'codex_openrouter', model: 'z-ai/glm-5.3-flash', reasoningEffort: 'high',
    },
    budget: { overallRemaining: '7.25' },
  }));
  assert.equal(result.renderer, 'setting');
  assert.equal(result.classicPath, '#settings/global-chat');
  const values = result.authoritativeResult.data.items[0];
  assert.equal(values['profile.model'], 'deepseek/cheap');
  assert.equal(values['profile.reasoningEffort'], 'low');
  assert.equal(values['developmentProfile.model'], 'z-ai/glm-5.3-flash');
  assert.ok(result.modelResult.data.relatedCapabilityIds.includes('settings.global_chat.update'));
});

test('direct app, unread-message, and app-discussion reads return focused authoritative data', async () => {
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  const appRoute = inventory.routes.find((item) => (
    item.status === 'mapped' && item.method === 'GET' && item.path === '/api/apps'
  ));
  const conversationsRoute = inventory.routes.find((item) => (
    item.status === 'mapped' && item.method === 'GET' && item.path === '/api/conversations'
  ));
  const discussionsRoute = inventory.routes.find((item) => (
    item.status === 'mapped' && item.method === 'GET' && item.path === '/api/apps/:slug/messages'
  ));
  assert.ok(appRoute && conversationsRoute && discussionsRoute);
  const calls = [];
  const apps = Array.from({ length: 24 }, (_, index) => ({
    id: index + 1,
    slug: `app-${index + 1}`,
    name: `App ${index + 1}`,
    icon_emoji: index === 0 ? '🧪' : null,
    messagesLast7Days: index < 22 ? index + 1 : 0,
    activitySecondsLast7Days: index < 22 ? (index + 1) * 60 : 0,
    activeUsers: index < 22 ? 1 : 0,
  }));
  const execution = context({
    classicApi: {
      route: () => ({}),
      async invoke(id, input) {
        calls.push({ id, input });
        if (id === appRoute.capabilityId) {
          return { ok: true, status: 200, authoritativeResult: { apps } };
        }
        if (id === conversationsRoute.capabilityId) {
          return {
            ok: true,
            status: 200,
            authoritativeResult: {
              conversations: [
                { id: 10, title: 'Unread', unreadCount: 3 },
                { id: 11, title: 'Read', unreadCount: 0 },
              ],
            },
          };
        }
        if (id === discussionsRoute.capabilityId) {
          return {
            ok: true,
            status: 200,
            authoritativeResult: { messages: [{ id: 12, content: 'Latest update' }] },
          };
        }
        throw new Error(`Unexpected capability ${id}`);
      },
    },
  });

  const activity = await registry.execute('apps.activity', {}, execution);
  assert.equal(activity.authoritativeResult.data.apps.length, 20);
  assert.equal(activity.authoritativeResult.data.apps[0].icon_emoji, '🧪');
  assert.equal(activity.authoritativeResult.data.apps[0].messagesLast7Days, 1);
  assert.deepEqual(calls[0].input.query, [{ name: 'view', value: 'global-chat' }]);

  const unread = await registry.execute('messages.unread', {}, execution);
  assert.equal(unread.authoritativeResult.data.unreadCount, 3);
  assert.deepEqual(
    unread.authoritativeResult.data.conversations.map((item) => item.id),
    [10],
  );

  const discussions = await registry.execute(
    'messages.for_app', { appSlug: 'social-vibecoding' }, execution,
  );
  assert.equal(discussions.authoritativeResult.data.messages[0].content, 'Latest update');
  assert.equal(discussions.classicPath, '#app/social-vibecoding/dev/chat');
  assert.deepEqual(calls.at(-1).input.pathParameters, { slug: 'social-vibecoding' });
  assert.deepEqual(calls.at(-1).input.query, [{ name: 'limit', value: '20' }]);
});

test('direct spending and notification settings expose only the requested logical group', async () => {
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  const spending = await registry.execute('settings.spending', {}, context({
    globalChatUsage: {
      spentUsd: '0.125', capUsd: '2', remainingUsd: '1.875', turns: '8',
      successfulTurns: '7', resetAt: '2026-10-01T00:00:00.000Z',
    },
    budget: { overallRemaining: '279.98032735' },
  }));
  const usage = spending.authoritativeResult.data.items[0];
  assert.equal(usage.name, 'Global Chat usage');
  assert.equal(usage.spentUsd, '0.125');
  assert.equal(usage.remainingUsd, '1.875');
  assert.equal(usage.overallRemainingUsd, '279.98032735');
  assert.equal(usage.turns, '8');

  const alerts = await registry.execute('settings.inspect', { group: 'alerts' }, context({
    clientSettings: {
      theme: 'dark', devAlerts: false, devConsoleMode: 'expanded', adminPreview: true,
    },
    classicApi: {
      route: () => ({}),
      invoke: async () => ({ ok: true, status: 200, authoritativeResult: {} }),
    },
  }));
  const alertValues = alerts.authoritativeResult.data.items[0];
  assert.equal(alertValues.devAlerts, false);
  assert.equal(Object.hasOwn(alertValues, 'theme'), false);
  assert.equal(Object.hasOwn(alertValues, 'devConsoleMode'), false);
  assert.equal(Object.hasOwn(alertValues, 'adminPreview'), false);
});

test('Global Chat settings change independently through the same validated profile writer', async () => {
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  let patch;
  const result = await registry.execute('settings.global_chat.update', {
    model: 'deepseek/cheap', reasoningEffort: 'low', spendCapUsd: '1.5',
  }, context({
    updateGlobalChatProfile: async (input) => {
      patch = input;
      return {
        profile: { backend: 'openrouter', ...input },
        usage: { spentUsd: '0.1', capUsd: input.spendCapUsd },
      };
    },
  }));
  assert.deepEqual(patch, {
    model: 'deepseek/cheap', reasoningEffort: 'low', spendCapUsd: '1.5',
  });
  assert.equal(result.authoritativeResult.data.profile.model, 'deepseek/cheap');
  assert.equal(result.classicPath, '#settings/global-chat');
  assert.equal(registry.get('settings.global_chat.update').confirmation, 'required');
});

test('local-only settings use a browser allowlist and keep admin preview admin-only', async () => {
  const registry = new CapabilityRegistry(classicCapabilityDefinitions());
  const theme = await registry.execute('settings.local.update', {
    setting: 'theme', value: 'dark',
  }, context());
  assert.equal(theme.authoritativeResult.data.action.transport, 'local_setting');
  assert.equal(theme.authoritativeResult.data.action.setting, 'theme');
  assert.equal(theme.classicPath, '#settings/theme');
  await assert.rejects(
    registry.execute('settings.local.update', {
      setting: 'adminPreview', value: true,
    }, context({ actor: { signedIn: true, admin: false } })),
    /unavailable/,
  );
  const admin = await registry.execute('settings.local.update', {
    setting: 'adminPreview', value: true,
  }, context());
  assert.equal(admin.classicPath, '#settings/admin-preview');
});
