'use strict';

// Hosted MCP connector: which callers see which tools (#2779).
//
// registerTools in services/mcp-tools.js is the only place a tool is
// defined, and it serves four kinds of caller:
//
//   external    - a chat product the user connected through consent
//                 (Claude.ai, Claude Code, ChatGPT). Today's surface.
//   agent_mayor - Homeroom bot answering a person inside the platform (its
//                 own conversations, a project's thread, a design): the
//                 platform's reads, on a grant minted for that one turn, and
//                 nothing that writes.
//   worker_read - the coding agent inside one change's worker. Six reads,
//                 bound to that change's app, and nothing that writes.
//   bot_admin   - Homeroom bot answering a full platform admin in their own
//                 conversation with it (Homeroom bot parity P7): a curated
//                 set of the connector's admin tools. Its reads run on the
//                 turn's read grant; every write is one the admin confirmed
//                 on a card, run on a grant minted for that one action.
//
// The kind comes from how the token was issued (mcp_delegations.kind), never
// from anything the caller says, and never from its client name.
//
// The two directions differ, on purpose:
//
//   * A delegated kind sees ONLY the tools named for it here. A tool added to
//     the registry tomorrow is invisible to all of them until somebody
//     decides it belongs, and the route allowlists in
//     services/cli-api-policy.js are the second wall behind this one.
//   * The external surface is every tool in the registry, so it keeps
//     growing for external clients the way it always has.

const KINDS = Object.freeze(['external', 'agent_mayor', 'worker_read', 'bot_admin']);

// Reads only. Homeroom bot offers its model the ones it names itself
// (services/bot-tools/platform.js); what it files or changes goes through
// its own offers and the person's tap, never through this grant.
const AGENT_MAYOR_TOOLS = Object.freeze([
  'get_connector_guidance',
  'whoami',
  'get_platform_conventions',
  'list_apps',
  'get_app',
  'list_requests',
  'get_request',
  'get_spec',
  'get_discussion',
  'get_message',
  'get_proposal',
  'list_my_proposals',
  'get_change',
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

// Homeroom bot's admin tools (P7, homeroom-bot-thread-tools/admin.js): the
// bench, the bot's configurations and settings, test accounts, a project's
// featured picture and the recent shots. Not every admin tool: nothing that
// grades, picks a blind pair, cancels, regrades or launches the studio. Each
// one is the connector's own, guarded for a full admin as it is there.
const BOT_ADMIN_READ_TOOLS = Object.freeze([
  'list_bench_runs',
  'get_bench_run',
  'list_bot_configs',
  'list_test_accounts',
  'get_featured_illustration',
  'get_homeroom_bot',
  'list_recent_shots',
]);

// The bot_admin tools that change something, and so never run from the
// model: the turn seals the exact input and shows a confirm card, and only
// the admin's Confirm runs it (homeroom-bot-cards/confirm.js).
const BOT_ADMIN_CONFIRMED_TOOLS = Object.freeze([
  'launch_bench_run',
  'save_bot_config',
  'set_bot_config_role',
  'set_bot_config_budget',
  'create_test_account',
  'retire_test_account',
  'send_test_release_email',
  'propose_featured_illustration',
  'set_homeroom_bot_settings',
]);

const BOT_ADMIN_TOOLS = Object.freeze([...BOT_ADMIN_READ_TOOLS, ...BOT_ADMIN_CONFIRMED_TOOLS]);

const TOOLS_BY_KIND = Object.freeze({
  agent_mayor: AGENT_MAYOR_TOOLS,
  worker_read: WORKER_READ_TOOLS,
  bot_admin: BOT_ADMIN_TOOLS,
});

function isKnownKind(kind) {
  return KINDS.includes(kind);
}

function toolVisibleTo(kind, toolName) {
  if (kind === 'external') return true;
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
  AGENT_MAYOR_TOOLS,
  WORKER_READ_TOOLS,
  BOT_ADMIN_READ_TOOLS,
  BOT_ADMIN_CONFIRMED_TOOLS,
  BOT_ADMIN_TOOLS,
  isKnownKind,
  toolVisibleTo,
  kindOf,
  scopedServer,
};
