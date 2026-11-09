'use strict';

// The platform's reads, offered to Homeroom bot with the web connector's own
// schemas (mcp-tools.js), as decision 1 of docs/plans/bot-one-model.md asks.
// Main took them from the connector already, through the mayor's MCP shim;
// the voice and the design bot wrote smaller copies by hand. Now one source:
// the connector's registry, read once per process (registering a tool only
// describes it; nothing runs).
//
// On a project's own thread the project is the thread's: `slug` is left out
// of the schema and filled in by the surface (homeroom-bot-voice.js
// scopedPlatformCall), which also keeps every read to that project. A call
// runs through the surface's platform client (`ctx.platformCall`), which
// holds the turn's short grant.

const { define } = require('./registry');

// Main's reads (homeroom-bot-mayor.js PLATFORM_TOOLS): the agent-session
// Mayor's connector reads, offered as they are.
const MAIN_READS = Object.freeze([
  'get_platform_conventions', 'list_apps', 'get_app', 'list_requests', 'get_request',
  'get_discussion', 'get_message', 'get_proposal', 'list_my_proposals', 'get_change', 'get_spec',
]);
// What a project's own thread reads, about that project only.
const THREAD_READS = Object.freeze(['get_change', 'get_discussion', 'list_requests', 'get_request', 'get_message', 'get_spec']);

let specs = null;
/** The connector's tool specs, by name, read off its registry once. */
function connectorSpecs() {
  if (specs) return specs;
  const found = new Map();
  const { READ_SCOPE, WRITE_SCOPE } = require('../mcp-connect-constants');
  require('../mcp-tools').registerTools({ registerTool(name, spec) { found.set(name, spec); } }, {
    accessToken: 'svmcd_schema', scopes: [READ_SCOPE, WRITE_SCOPE],
    user: { id: 0, username: 'schema', isAdmin: false }, clientName: 'schema', clientId: 'schema', origin: '',
    baseUrl: 'http://127.0.0.1', pool: null, config: {}, tokenId: 0, grantId: 'schema',
  });
  specs = found;
  return specs;
}

/**
 * Pure over the registry: the connector tool `name`'s description and its
 * input as JSON schema, with `hidden` properties left out. Null when the
 * connector has no such tool.
 */
function connectorSchema(name, { hidden = [] } = {}) {
  const spec = connectorSpecs().get(name);
  if (!spec) return null;
  const { z } = require('zod');
  const { toJsonSchemaCompat } = require('@modelcontextprotocol/sdk/server/zod-json-schema-compat.js');
  const schema = toJsonSchemaCompat(z.object(spec.inputSchema && typeof spec.inputSchema === 'object' ? spec.inputSchema : {}),
    { strictUnions: true, pipeStrategy: 'input' });
  delete schema.$schema;
  const drop = new Set(hidden);
  if (schema.properties) for (const key of drop) delete schema.properties[key];
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((key) => !drop.has(key));
    if (!schema.required.length) delete schema.required;
  }
  return { description: typeof spec.description === 'string' ? spec.description : '', parameters: schema };
}

for (const name of new Set([...MAIN_READS, ...THREAD_READS])) {
  const scopes = [
    ...(MAIN_READS.includes(name) ? ['main'] : []),
    ...(THREAD_READS.includes(name) ? ['thread'] : []),
  ];
  define({
    name,
    scopes,
    schemaFor(scope) {
      const schema = connectorSchema(name, { hidden: scope === 'thread' ? ['slug'] : [] });
      if (!schema) throw new Error(`bot-tools: the connector has no ${name}`);
      if (scope !== 'thread') return schema;
      return { ...schema, description: `About this project only. ${schema.description}` };
    },
    async run(args, ctx) {
      if (typeof ctx.platformCall !== 'function') return { error: 'The platform\'s reads are not available just now.' };
      return ctx.platformCall(name, args);
    },
  });
}

module.exports = { MAIN_READS, THREAD_READS, connectorSchema };
