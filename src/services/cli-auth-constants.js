'use strict';

const CLIENT_ID = 'social-vibecoding-cli';
const CLIENT_NAME = 'Homeroom CLI';
const IDENTITY_SCOPE = 'rpc:identity:read';
const API_SCOPE = 'api:access';
// #907: the scope the local coding agent's protocol asked for. Nothing
// checks it any more; it stays among the scopes a credential is issued
// with because database constraints and credentials already issued name it.
const AGENT_SCOPE = 'agent:local';
const REQUIRED_SCOPES = Object.freeze([IDENTITY_SCOPE, API_SCOPE, AGENT_SCOPE]);
const REQUIRED_SCOPE_TEXT = REQUIRED_SCOPES.join(' ');
// MCP and the CLI use the hosted platform by default. Self-hosted
// deployments can still select their canonical origin with USERNODE_DOMAIN.
// Concretely: the production profile resolves to https://app.onhomeroom.com
// with no environment set, so normal production use of the CLI, the stdio
// MCP server and the proposal commands needs no USERNODE_DOMAIN. When
// USERNODE_DOMAIN *is* set it still wins, which is how a self-hosted
// deployment points the same three surfaces at its own origin. The local
// profile (LOCAL_ORIGIN, below) is unaffected either way, and credentials
// stay bound to whichever origin they were issued for, so the new default
// needs its own sign-in rather than inheriting the old host's session.
// Use the canonical host directly; the CLI refuses redirects by design.
const PRODUCTION_ORIGIN = process.env.USERNODE_DOMAIN
  ? `https://${process.env.USERNODE_DOMAIN}`
  : 'https://app.onhomeroom.com';
const LOCAL_ORIGIN = 'http://localhost:3000';
const DEVICE_TTL_SECONDS = 600;
const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;
const POLL_INTERVAL_SECONDS = 5;

module.exports = {
  CLIENT_ID,
  CLIENT_NAME,
  IDENTITY_SCOPE,
  API_SCOPE,
  AGENT_SCOPE,
  REQUIRED_SCOPES,
  REQUIRED_SCOPE_TEXT,
  PRODUCTION_ORIGIN,
  LOCAL_ORIGIN,
  DEVICE_TTL_SECONDS,
  ACCESS_TTL_SECONDS,
  POLL_INTERVAL_SECONDS,
};
