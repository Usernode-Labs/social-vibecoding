'use strict';

// The agent-session Mayor's platform tools (#2779, spec: docs/agent-sessions.md,
// "How the Mayor calls it").
//
// The Mayor uses the same tool registry an external chat product does —
// services/mcp-tools.js registerTools — rather than a second set of tool
// definitions. It reaches it in-process: an McpServer and an MCP client joined
// by the SDK's in-memory transport, the server built for a DELEGATED grant
// minted for this one turn (or, for a confirmed write, this one action).
//
// So everything the external connector guarantees holds here by
// construction:
//
//   * the tool list is the `agent_mayor` audience's, decided by the grant's
//     kind (services/mcp-audiences.js);
//   * every tool's loopback call carries the grant's own token through the
//     ordinary bearer chain, which applies the Mayor's route allowlist, the
//     grant's binding and its liveness (routes/cli-auth.js);
//   * a read grant cannot write: the routes refuse a non-GET without the
//     write scope, and the write scope is only ever minted for an action the
//     user confirmed.
//
// The two edge duties the /mcp endpoint performs and an in-process call would
// skip are repeated here: a `token_used` audit row per call, and a rate bucket
// per agent session.
//
// Tool calls go through `client.request` with CallToolResultSchema rather than
// `client.callTool`: the SDK client checks a result's structuredContent against
// the tool's output schema even when the result is an error, and the
// connector's error results never match one.

const log = require('../logger');
const mcpOauth = require('../mcp-oauth');
const { READ_SCOPE, SERVER_NAME, SERVER_VERSION } = require('../mcp-connect-constants');

const SESSION_RATE_PER_MINUTE = 120;
const MAX_RESULT_CHARS = 24 * 1024;

// Where a tool's loopback calls land. The pod's own port rather than the
// in-cluster service, so a call made for this turn is answered by the process
// that holds the turn.
function loopbackBaseUrl(config) {
  return `http://127.0.0.1:${(config && config.port) || 3000}`;
}

// MCP tool definitions, as the Anthropic Messages API wants them. The OpenRouter
// Mayor client translates the same shape to its own.
function toModelTools(mcpTools) {
  return mcpTools.map((tool) => ({
    name: tool.name,
    description: String(tool.description || '').slice(0, 1800),
    input_schema: tool.inputSchema && tool.inputSchema.type === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} },
  }));
}

// One tool result, flattened to what the Mayor loop needs: whether it failed,
// the structured payload for code, and the text the model reads (bounded).
function normalizeResult(result) {
  const content = Array.isArray(result && result.content) ? result.content : [];
  const text = content.filter((block) => block && block.type === 'text').map((block) => block.text).join('\n');
  return {
    isError: !!(result && result.isError),
    structured: (result && result.structuredContent) || null,
    text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]` : text,
  };
}

async function openMayorMcp({
  pool,
  config,
  userId,
  agentSessionId,
  scopes = [READ_SCOPE],
  appId = null,
  changeId = null,
  ttlSeconds = undefined,
  baseUrl = null,
}) {
  const issued = await mcpOauth.issueDelegatedAccess(pool, {
    userId, kind: 'agent_mayor', agentSessionId, appId, changeId, scopes, ttlSeconds,
  });
  let server = null;
  let client = null;
  let closed = false;

  const close = async (reason = 'turn_finished') => {
    if (closed) return;
    closed = true;
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    await mcpOauth.revokeDelegation(pool, { grantId: issued.grantId, reason }).catch((err) => {
      log.warn('agent-mayor', 'Could not revoke a turn grant', { grantId: issued.grantId, err: err.message });
    });
  };

  try {
    // The same resolution /mcp performs, so the tools see exactly the user,
    // scopes and delegation an HTTP caller holding this token would.
    const { authenticateConnector } = require('../../routes/mcp-remote');
    const auth = await authenticateConnector(pool, issued.accessToken);
    if (auth.error) throw new Error(`the turn grant was refused: ${auth.error}`);

    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const mcpTools = require('../mcp-tools');

    server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { instructions: mcpTools.instructionsFor('agent_mayor') }
    );
    mcpTools.registerTools(server, {
      accessToken: issued.accessToken,
      scopes: auth.scopes,
      user: auth.user,
      clientName: auth.clientName,
      clientId: auth.clientId,
      delegation: auth.delegation,
      tokenId: auth.tokenId,
      grantId: auth.grantId,
      origin: (config && config.cliAuthOrigin) || '',
      baseUrl: baseUrl || loopbackBaseUrl(config),
      pool,
      config,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'homeroom-agent-mayor', version: SERVER_VERSION });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();

    const call = async (name, args) => {
      if (closed) return { isError: true, structured: { code: 'closed' }, text: 'closed: this turn has ended.' };
      const { consumeSharedTokenBucket } = require('../cli-auth');
      let bucket;
      try {
        bucket = await consumeSharedTokenBucket(pool, {
          namespace: 'agent-mayor-mcp',
          subject: String(agentSessionId),
          ratePerMinute: SESSION_RATE_PER_MINUTE,
          capacity: SESSION_RATE_PER_MINUTE,
        });
      } catch {
        bucket = { allowed: false };
      }
      if (!bucket.allowed) {
        return {
          isError: true,
          structured: { code: 'rate_limited' },
          text: 'rate_limited: this conversation has made too many platform calls in the last minute. Wait, then try again.',
        };
      }
      // The authorization is recorded before it is used, as at /mcp.
      await mcpOauth.withTransaction(pool, (dbClient) => mcpOauth.insertAudit(dbClient, {
        eventType: 'token_used',
        occurredAt: new Date(),
        userId,
        actorUserId: userId,
        accessTokenId: issued.accessTokenId,
        clientId: auth.clientId,
        scopes: auth.scopes,
        outcome: 'scope_authorized',
        metadata: { method: 'tools/call', route: 'in-process', tool: String(name).slice(0, 64) },
      }));
      const { CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js');
      try {
        const result = await client.request(
          { method: 'tools/call', params: { name, arguments: args && typeof args === 'object' ? args : {} } },
          CallToolResultSchema
        );
        return normalizeResult(result);
      } catch (err) {
        return {
          isError: true,
          structured: { code: 'tool_failed' },
          text: `tool_failed: ${String(err.message || err).slice(0, 400)}`,
        };
      }
    };

    return {
      grantId: issued.grantId,
      scopes: auth.scopes,
      toolNames: tools.map((tool) => tool.name),
      modelTools: toModelTools(tools),
      call,
      close,
    };
  } catch (err) {
    await close('open_failed');
    throw err;
  }
}

module.exports = {
  SESSION_RATE_PER_MINUTE,
  MAX_RESULT_CHARS,
  loopbackBaseUrl,
  toModelTools,
  normalizeResult,
  openMayorMcp,
};
