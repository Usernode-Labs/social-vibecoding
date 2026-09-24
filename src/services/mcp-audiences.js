'use strict';

// Hosted MCP connector: which callers see which tools (#2779).
//
// registerTools in services/mcp-tools.js is the only place a tool is
// defined, and it serves three kinds of caller:
//
//   external    - a chat product the user connected through consent
//                 (Claude.ai, Claude Code, ChatGPT). Today's surface.
//   agent_mayor - the Mayor of one of the user's agent sessions, inside
//                 the platform. Reads freely; every write it makes is one the
//                 user confirmed first, carried out with a token minted for
//                 that one action.
//   worker_read - the coding agent inside one change's worker. Six reads,
//                 bound to that change's app, and nothing that writes.
//
// The kind comes from how the token was issued (mcp_delegations.kind), never
// from anything the caller says, and never from its client name.
//
// The two directions fail closed differently, on purpose:
//
//   * A delegated kind sees ONLY the tools named for it here. A tool added to
//     the registry tomorrow is invisible to both until somebody decides it
//     belongs, and the route allowlists in services/cli-api-policy.js are the
//     second wall behind this one.
//   * The external surface is every tool EXCEPT the ones held back for the
//     platform's own agents, so the registry keeps growing for external
//     clients the way it always has. What is held back is exactly the change
//     lifecycle an agent session drives with the user's confirmation, which
//     is not offered to a third-party chat product in v1.

const KINDS = Object.freeze(['external', 'agent_mayor', 'worker_read']);

// Held back from external clients. start_change is not offered to them in
// v1 (they hand work to their own coding agent through prepare_work); the
// other three decide a change's fate, which an external client does through
// submit_work, the vote, or the browser.
const DELEGATED_ONLY_TOOLS = Object.freeze([
  'start_change',
  'promote_change',
  'sync_change',
  'withdraw_change',
]);

const AGENT_MAYOR_TOOLS = Object.freeze([
  // Reads.
  'get_connector_guidance',
  'whoami',
  'get_platform_conventions',
  'list_apps',
  'get_app',
  'list_requests',
  'get_request',
  'get_proposal',
  'list_my_proposals',
  'get_change',
  // Writes the user confirms, on the requests board and on proposal metadata.
  'create_request',
  'claim_request',
  'release_request',
  'update_proposal_issues',
  // The native change lifecycle.
  'start_change',
  'promote_change',
  'recheck_change',
  'sync_change',
  'withdraw_change',
]);

// Exactly the six reads the worker bridge proxies. Nothing that lists every
// app, nothing about the user's other proposals, nothing that writes.
const WORKER_READ_TOOLS = Object.freeze([
  'get_platform_conventions',
  'get_app',
  'list_requests',
  'get_request',
  'get_proposal',
  'get_change',
]);

// The agent_mayor tools that change something, and so run only on a
// confirmation the user gave in the transcript. recheck_change is the one
// exception: it re-runs checks on the commit already there, moves no code and
// clears no vote, so it needs a write token but not a card.
const MAYOR_CONFIRMED_TOOLS = Object.freeze([
  'create_request',
  'claim_request',
  'release_request',
  'update_proposal_issues',
  'start_change',
  'promote_change',
  'sync_change',
  'withdraw_change',
]);

const TOOLS_BY_KIND = Object.freeze({
  agent_mayor: AGENT_MAYOR_TOOLS,
  worker_read: WORKER_READ_TOOLS,
});

function isKnownKind(kind) {
  return KINDS.includes(kind);
}

function toolVisibleTo(kind, toolName) {
  if (kind === 'external') return !DELEGATED_ONLY_TOOLS.includes(toolName);
  const tools = Object.prototype.hasOwnProperty.call(TOOLS_BY_KIND, kind) ? TOOLS_BY_KIND[kind] : null;
  return !!tools && tools.includes(toolName);
}

// The kind a registerTools context is serving: its delegation's, or
// `external` when there is none.
function kindOf(ctx) {
  const delegation = ctx && ctx.delegation;
  return delegation && typeof delegation.kind === 'string' ? delegation.kind : 'external';
}

// Wrap an McpServer (or a test recorder standing in for one) so that
// registerTool quietly skips a tool this kind may not see. The rest of the
// server passes through untouched. An unknown kind sees nothing at all.
function scopedServer(server, kind) {
  return {
    registerTool(name, spec, handler) {
      if (!isKnownKind(kind) || !toolVisibleTo(kind, name)) return undefined;
      return server.registerTool(name, spec, handler);
    },
  };
}

module.exports = {
  KINDS,
  DELEGATED_ONLY_TOOLS,
  AGENT_MAYOR_TOOLS,
  WORKER_READ_TOOLS,
  MAYOR_CONFIRMED_TOOLS,
  isKnownKind,
  toolVisibleTo,
  kindOf,
  scopedServer,
};
