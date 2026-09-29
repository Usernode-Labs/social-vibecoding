#!/usr/bin/env node
'use strict';

// The coding agent's read-only Homeroom tools (#2779, spec:
// docs/agent-sessions.md, "Coding agent").
//
// A stdio MCP server that proxies an allowlist of six READ tools to the
// platform's own MCP endpoint (PLATFORM_URL/mcp), authenticated with the
// turn's `worker_read` grant (HOMEROOM_MCP_TOKEN). The platform binds that
// grant to this change and its app, lets it read only, and revokes it when
// the turn ends; the allowlist here is a second fence, not the first.
//
// The token reaches this process through the environment the agent CLI
// inherits. It is never written to a config file and never echoed.
//
// Without a token (the platform could not issue one this turn) the server
// still starts and simply offers no tools, so the agent's MCP start-up never
// fails a turn.

const HOMEROOM_READ_TOOLS = Object.freeze([
  'get_platform_conventions',
  'get_app',
  'list_requests',
  'get_request',
  'get_proposal',
  'get_change',
]);

// The worker image installs the SDK globally; a checkout has it in
// node_modules. Either way the same modules load.
function sdk(subpath) {
  try {
    return require(`/usr/local/lib/node_modules/@modelcontextprotocol/sdk/dist/cjs/${subpath}`);
  } catch {
    return require(`@modelcontextprotocol/sdk/${subpath}`);
  }
}

const { Server } = sdk('server/index.js');
const { StdioServerTransport } = sdk('server/stdio.js');
const { Client } = sdk('client/index.js');
const { StreamableHTTPClientTransport } = sdk('client/streamableHttp.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
} = sdk('types.js');

const platform = String(process.env.PLATFORM_URL || '').replace(/\/$/, '');
const token = String(process.env.HOMEROOM_MCP_TOKEN || '');
const configured = /^https?:\/\//.test(platform) && /^svmcd_[A-Za-z0-9_-]{43}$/.test(token);

const INSTRUCTIONS = 'Read-only Homeroom tools for this change: the platform conventions, the app, its requests '
  + 'and their full discussion, and its proposals (including this one, with its checks). They cannot write '
  + 'anything and are bound to this change\'s app. Questions for the user go in your final message.';

let upstream = null;

async function connectUpstream() {
  const client = new Client({ name: 'homeroom-read-bridge', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${platform}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

// One upstream session, reconnected once if it has gone away.
async function withUpstream(fn) {
  try {
    if (!upstream) upstream = await connectUpstream();
    return await fn(upstream);
  } catch (err) {
    try { if (upstream) await upstream.close(); } catch { /* already gone */ }
    upstream = null;
    upstream = await connectUpstream();
    return fn(upstream);
  }
}

function toolError(code, message) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code, message }) }] };
}

const server = new Server(
  { name: 'homeroom', version: '1.0.0' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!configured) return { tools: [] };
  try {
    const listed = await withUpstream((client) => client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema));
    // outputSchema is dropped: the agent reads the text either way, and an
    // error result that does not match it must not be refused client-side.
    const tools = (listed.tools || [])
      .filter((tool) => HOMEROOM_READ_TOOLS.includes(tool.name))
      .map(({ outputSchema, ...tool }) => tool);
    return { tools };
  } catch (err) {
    process.stderr.write(`homeroom: could not list tools: ${String(err && err.message).slice(0, 300)}\n`);
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params && request.params.name;
  if (!HOMEROOM_READ_TOOLS.includes(name)) {
    return toolError('not_allowed', `${String(name).slice(0, 64)} is not one of the read-only Homeroom tools.`);
  }
  if (!configured) return toolError('not_available', 'The Homeroom tools are not available for this turn.');
  try {
    const result = await withUpstream((client) => client.request({
      method: 'tools/call',
      params: { name, arguments: (request.params && request.params.arguments) || {} },
    }, CallToolResultSchema));
    const { structuredContent, ...rest } = result;
    return rest;
  } catch (err) {
    return toolError('platform_unavailable', `Homeroom could not answer: ${String(err && err.message).slice(0, 300)}`);
  }
});

server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(`${String((error && error.message) || error).slice(0, 1000)}\n`);
  process.exit(1);
});
