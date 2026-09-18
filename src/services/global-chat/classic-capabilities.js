'use strict';

const inventory = require('./classic-inventory.generated.json');
const { routeParameters, sanitizeForModel } = require('./classic-api-client');

const MAX_BODY_JSON_BYTES = 1024 * 1024;
const QUERY_SCHEMA = Object.freeze({
  type: 'array',
  maxItems: 50,
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      value: { type: 'string', maxLength: 8000 },
    },
    required: ['name', 'value'],
  },
});

const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'integer' },
    data: {},
  },
  required: ['ok', 'status', 'data'],
});

function humanize(value) {
  return String(value || '')
    .replace(/^api\.?/, '')
    .replace(/[:._/-]+/g, ' ')
    .replace(/\b(?:item|param|dynamic)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleFor(route) {
  const verbs = {
    GET: 'View', POST: 'Run', PUT: 'Update', PATCH: 'Edit', DELETE: 'Delete',
  };
  const title = `${verbs[route.method] || route.method} ${humanize(route.path)}`;
  return title.slice(0, 80).trim();
}

function keywordsFor(route) {
  const words = humanize(route.path).split(' ').filter((word) => word.length > 1);
  const aliases = route.method === 'GET'
    ? ['get', 'view', 'show', 'list', 'find']
    : route.method === 'DELETE'
      ? ['delete', 'remove']
      : ['change', 'update', 'edit', 'create'];
  return [...new Set([route.domain, ...aliases, ...words])].slice(0, 30);
}

function inputSchemaFor(route) {
  const names = routeParameters(route.path);
  const pathProperties = Object.fromEntries(names.map((name) => [name, {
    type: 'string', minLength: 1, maxLength: 512,
  }]));
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      pathParameters: {
        type: 'object',
        additionalProperties: false,
        properties: pathProperties,
        required: names,
      },
      query: QUERY_SCHEMA,
      bodyJson: { type: ['string', 'null'], maxLength: MAX_BODY_JSON_BYTES },
    },
    required: ['pathParameters', 'query', 'bodyJson'],
  };
}

function parseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Capability input must be an object.');
  }
  const bodyJson = input.bodyJson;
  let body;
  if (bodyJson != null) {
    if (typeof bodyJson !== 'string' || Buffer.byteLength(bodyJson, 'utf8') > MAX_BODY_JSON_BYTES) {
      throw new Error('bodyJson must be bounded JSON text.');
    }
    try { body = JSON.parse(bodyJson); } catch {
      throw new Error('bodyJson must contain valid JSON.');
    }
  }
  return {
    pathParameters: input.pathParameters || {},
    query: input.query || [],
    ...(bodyJson == null ? {} : { body }),
  };
}

function resolveClassicPath(template, input) {
  let result = template;
  for (const match of [...String(template).matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)]) {
    const raw = input?.pathParameters?.[match[1]];
    result = result.replace(match[0], raw == null ? 'unknown' : encodeURIComponent(String(raw)));
  }
  return result;
}

function actorCanUse(route, context) {
  const actor = context?.actor;
  if (!actor?.signedIn) return false;
  if (route.domain === 'admin') {
    if (!actor.admin) return false;
    if (route.risk !== 'read' && !actor.canAdminWrite) return false;
  }
  if (route.transport === 'server_loopback') {
    return !!context.classicApi?.route?.(route.capabilityId);
  }
  if (route.transport === 'native_client') {
    return /^native_/.test(context.client?.surface || '')
      && typeof context.dispatchClientAction === 'function';
  }
  return typeof context.dispatchClientAction === 'function';
}

function normalizeExecutionResult(result) {
  const status = Number.isInteger(result?.status) ? result.status : (result?.ok === false ? 400 : 200);
  const data = result && Object.hasOwn(result, 'authoritativeResult')
    ? result.authoritativeResult
    : (result?.data ?? {});
  const model = result && Object.hasOwn(result, 'modelResult')
    ? result.modelResult
    : { ok: result?.ok !== false, status, untrusted: true, data: sanitizeForModel(data) };
  return {
    authoritativeResult: { ok: result?.ok !== false, status, data },
    modelResult: model?.data !== undefined && model?.status !== undefined
      ? { ok: model.ok !== false, status: model.status, data: model.data }
      : { ok: result?.ok !== false, status, data: sanitizeForModel(model) },
  };
}

function routeHandler(route) {
  return async (input, context) => {
    const parsed = parseInput(input);
    let result;
    if (route.transport === 'server_loopback') {
      result = await context.classicApi.invoke(route.capabilityId, parsed);
    } else {
      result = await context.dispatchClientAction({
        capabilityId: route.capabilityId,
        transport: route.transport,
        method: route.method,
        pathTemplate: route.path,
        input: parsed,
      });
    }
    return {
      ...normalizeExecutionResult(result),
      classicPath: resolveClassicPath(route.classicPath, parsed),
    };
  };
}

function routeDefinition(route) {
  return {
    id: route.capabilityId,
    domain: route.domain,
    title: titleFor(route),
    summary: `Use the existing authorized Classic ${route.method} ${route.path} operation.`,
    keywords: keywordsFor(route),
    inputSchema: inputSchemaFor(route),
    resultSchema: RESULT_SCHEMA,
    renderer: route.renderer,
    access: (context) => actorCanUse(route, context),
    risk: route.risk,
    confirmation: route.confirmation,
    classicPath: ({ input }) => resolveClassicPath(route.classicPath, input),
    mobileSupported: route.mobileSupported,
    sensitiveFields: [],
    handler: routeHandler(route),
    tests: [`${route.source}:${route.line}`],
  };
}

function navigationDefinition(item) {
  return {
    id: item.id,
    domain: 'navigation',
    title: item.label,
    summary: `Open the ${item.label} area in Classic mode.`,
    keywords: ['open', 'go', 'navigate', item.label],
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {}, required: [],
    },
    resultSchema: RESULT_SCHEMA,
    renderer: 'status',
    access: (context) => context?.actor?.signedIn === true
      && typeof context.dispatchClientAction === 'function',
    risk: 'read',
    confirmation: 'never',
    classicPath: () => item.classicPath,
    mobileSupported: item.mobileSupported,
    sensitiveFields: [],
    handler: async (_input, context) => normalizeExecutionResult(
      await context.dispatchClientAction({
        capabilityId: item.id,
        transport: 'navigation',
        classicPath: item.classicPath,
      }),
    ),
    tests: ['tests/global-chat-classic-capabilities.test.js'],
  };
}

function settingDefinition(item) {
  return {
    id: item.capabilityId,
    domain: 'settings',
    title: item.label,
    summary: `Open the ${item.label} settings group; its individual values and changes are provided by authorized settings capabilities.`,
    keywords: ['settings', 'preferences', 'configure', item.group, item.label],
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {}, required: [],
    },
    resultSchema: RESULT_SCHEMA,
    renderer: 'setting',
    access: (context) => context?.actor?.signedIn === true
      && typeof context.dispatchClientAction === 'function',
    risk: 'read',
    confirmation: 'never',
    classicPath: () => item.classicPath,
    mobileSupported: item.mobileSupported,
    sensitiveFields: [],
    handler: async (_input, context) => normalizeExecutionResult(
      await context.dispatchClientAction({
        capabilityId: item.capabilityId,
        transport: 'navigation',
        classicPath: item.classicPath,
      }),
    ),
    tests: ['tests/global-chat-classic-capabilities.test.js'],
  };
}

function classicCapabilityDefinitions() {
  return [
    ...inventory.routes.filter((route) => route.status === 'mapped').map(routeDefinition),
    ...inventory.navigation.map(navigationDefinition),
    ...inventory.settings.map(settingDefinition),
  ];
}

module.exports = {
  MAX_BODY_JSON_BYTES,
  RESULT_SCHEMA,
  actorCanUse,
  classicCapabilityDefinitions,
  inputSchemaFor,
  parseInput,
  resolveClassicPath,
  routeDefinition,
};
