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
    ...overrides,
  };
}

test('the registry contains every mapped route, Settings section, and navigation surface', () => {
  const definitions = classicCapabilityDefinitions();
  const registry = new CapabilityRegistry(definitions);
  const expected = inventory.summary.mappedRoutes
    + inventory.summary.settingsSections
    + inventory.summary.navigationSurfaces;
  assert.equal(definitions.length, expected);
  assert.equal(registry.size, expected);
  for (const route of inventory.routes.filter((item) => item.status === 'mapped')) {
    assert.ok(registry.get(route.capabilityId), `missing ${route.capabilityId}`);
  }
  for (const exempt of inventory.routes.filter((item) => item.status === 'exempt')) {
    if (exempt.capabilityId) assert.equal(registry.get(exempt.capabilityId), null);
  }
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
