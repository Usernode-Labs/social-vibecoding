'use strict';

// Hosted MCP connector — shared constants.
//
// Sibling of services/cli-auth-constants.js, deliberately separate: the CLI
// flow is a first-party device-code grant with a pinned client identity and
// its own two scopes, while this is an OAuth 2.1 authorization-code + PKCE
// server for THIRD-PARTY chat products (Claude.ai, ChatGPT). Sharing the
// constants would end with one flow's tightening silently loosening the
// other.

// Narrow, connector-specific scopes. NOT the CLI's `api:access`, which is a
// denylist over nearly the whole API — right for a checkout the user
// controls, wrong for a third-party web product.
const READ_SCOPE = 'usernode:apps:read';
const WRITE_SCOPE = 'usernode:proposals:write';
const SUPPORTED_SCOPES = Object.freeze([READ_SCOPE, WRITE_SCOPE]);

// Opaque bearer prefix, distinct from the CLI's `svcli_` so the shared
// bearer entry point can route a token to the right table by shape alone.
const TOKEN_PREFIX = 'svmcp_';
const REFRESH_PREFIX = 'svmcr_';

const AUTH_CODE_TTL_SECONDS = 60;
const ACCESS_TTL_SECONDS = 60 * 60;            // 1 hour
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// The MCP endpoint and its browser-facing consent page.
const MCP_PATH = '/mcp';
const CONSENT_PATH = '/connect/authorize';

// Hosts whose https redirect URIs dynamic client registration will accept.
// Registration is allowlisted rather than open: the platform is not trying
// to be a general-purpose OAuth provider, and the consent screen's only
// real defence against a lookalike client is showing a redirect origin the
// user recognises.
const DEFAULT_REDIRECT_HOSTS = Object.freeze([
  'claude.ai',
  'claude.com',
  'chatgpt.com',
  'openai.com',
]);

// Per-token and per-IP request budgets at the /mcp edge.
const TOKEN_RATE_PER_MINUTE = 60;
const IP_RATE_PER_MINUTE = 300;
// Dynamic client registration is cheap to call and creates rows, so it
// gets its own much tighter per-IP bucket.
const REGISTER_RATE_PER_MINUTE = 6;

// ── The connector's canonical name ─────────────────────────────────────
//
// SERVER_NAME is what this server reports as `serverInfo.name` in the MCP
// initialize response, and it is the CANONICAL spelling of the connector
// everywhere: docs, allow rules, the scaffolded `.claude/settings.json`.
//
// #1218: an account had the connector registered as `Uesrnode`, so its
// tools arrived as `mcp__Uesrnode__whoami`. That string is NOT ours — it
// never appears in this repository, and the value below has always been
// correctly spelled. Claude.ai's "Add custom connector" dialog takes a
// Name the human types, and the client builds tool names from THAT, not
// from `serverInfo.name`. So the typo was user-entered, and the fix is to
// recommend the canonical name at connect time (the Settings → Connectors
// copy does) rather than to change anything here.
//
// Why lowercase `usernode` is the canonical one: a client that derives the
// name from the server gets exactly this string, so a client where the
// user typed it agrees with a client where it did not. Any other spelling
// makes the two paths disagree.
//
// It matters because a Claude Code permission rule names the server as a
// LITERAL: `mcp__usernode__get_*` is legal, `mcp__*__get_*` is not. A rule
// aimed at a differently-named connector fails SILENTLY — no error, the
// user just keeps getting prompted. Hence: recommend the name, and tell
// people to read it off their own tool list (see MCP-CONNECTOR.md).
const SERVER_NAME = 'usernode';
const SERVER_VERSION = '1.0.0';

// The read-only allow rules Usernode ships in the app scaffold and
// documents. Two globs plus one literal, and deliberately NOT the
// whole-server `mcp__usernode__*`: the `requiresUserInteraction` marking on
// the acting tools is version-gated (Claude Code ≥ 2.1.199), so a blanket
// rule would auto-approve `submit_work` on an older client and put a change
// to a group vote with nobody having confirmed it. These three are safe on
// every version because they can only ever match reads.
//
// They stay durable only while the naming contract below holds. Tests
// enforce it against the registered tool surface.
const READ_ONLY_ALLOW_RULES = Object.freeze([
  `mcp__${SERVER_NAME}__get_*`,
  `mcp__${SERVER_NAME}__list_*`,
  `mcp__${SERVER_NAME}__whoami`,
]);

// ── The tool-naming contract ───────────────────────────────────────────
//
// A CONTRACT, not a description: the two globs above are only as safe as
// this rule is true.
//
//   * A read-only tool is named `get_*` or `list_*`.
//   * A tool that ACTS — files something, spends an allowance, opens or
//     advances a proposal — is NEVER named `get_*` or `list_*`.
//
// `whoami` is the single grandfathered exception, which is why it has its
// own literal entry rather than a glob.
//
// Adding a read-only tool: name it `get_`/`list_` and it is allowed by the
// rules already in every scaffolded repo, with no migration. Adding an
// acting tool: give it any other name and mark it per ACTING_TOOL_META in
// services/mcp-tools.js.
const READ_ONLY_TOOL_PREFIXES = Object.freeze(['get_', 'list_']);
const READ_ONLY_TOOL_EXCEPTIONS = Object.freeze(['whoami']);

module.exports = {
  READ_SCOPE,
  WRITE_SCOPE,
  SUPPORTED_SCOPES,
  TOKEN_PREFIX,
  REFRESH_PREFIX,
  AUTH_CODE_TTL_SECONDS,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  MCP_PATH,
  CONSENT_PATH,
  DEFAULT_REDIRECT_HOSTS,
  TOKEN_RATE_PER_MINUTE,
  IP_RATE_PER_MINUTE,
  REGISTER_RATE_PER_MINUTE,
  SERVER_NAME,
  SERVER_VERSION,
  READ_ONLY_ALLOW_RULES,
  READ_ONLY_TOOL_PREFIXES,
  READ_ONLY_TOOL_EXCEPTIONS,
};
