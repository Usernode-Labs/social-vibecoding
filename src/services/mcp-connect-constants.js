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

// ── The connector's ONE canonical name ─────────────────────────────────
//
// `Usernode`. One spelling, one capitalisation, everywhere the platform
// says the name out loud: the MCP `serverInfo.name`, the RFC 9728
// `resource_name`, the Settings → Connectors panel, the consent page, the
// setup docs, and every `mcp__Usernode__*` permission rule the platform
// ships.
//
// Why this is a constant and not a string typed in six places (#1206): a
// chat product does NOT take the server's own `serverInfo.name` as the
// name a permission rule has to match. Claude.ai's "Add custom connector"
// asks the HUMAN for a name, and whatever they type becomes the server
// segment of every rule — `mcp__<that string>__whoami`. Claude Code's
// permission syntax cannot wildcard that segment:
//
//   mcp__Usernode__get_*     ✅ names a server the user configured
//   mcp__*__get_*            ❌ not a thing; there is no fallback
//
// So a user who typed `Uesrnode` gets a connector that works perfectly and
// a shipped allow rule that matches nothing — and it fails SILENTLY: no
// error, just the same permission prompt on every read-only call, and the
// reasonable conclusion that our instructions are wrong. The only defence
// is to put the exact string in front of the user at connect time and to
// derive every rule we publish from this one constant, so the spelling in
// the docs can never drift from the spelling in the rules.
const SERVER_NAME = 'Usernode';
const SERVER_VERSION = '1.0.0';

// The prefix every permission rule for this connector carries. Derived, so
// renaming the server rewrites the rules rather than orphaning them.
const PERMISSION_RULE_PREFIX = `mcp__${SERVER_NAME}__`;

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
  PERMISSION_RULE_PREFIX,
};
