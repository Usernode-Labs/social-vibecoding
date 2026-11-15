# Delegated connector grants

The platform's own agents use the hosted connector's tools on a person's
behalf: Homeroom bot answering them, and the coding agent inside a change's
worker. Nothing about that goes through consent, because the person is
already signed in to the platform that runs those agents. Each one gets a
**delegated grant** instead, minted in-process for one turn (or one action)
and narrower than a consent in every direction that matters. The tools are
the connector's own (`registerTools` in `src/services/mcp-tools.js` is the
only place a tool is defined); the grant decides which of them a caller sees
and which routes its loopback calls reach.

## Kinds

The server picks the kind when it issues the grant
(`mcp_delegations.kind`); nothing a client sends, its client name included,
can name one. `src/services/mcp-audiences.js` holds each kind's tools and
`src/services/cli-api-policy.js` its route allowlist, the second wall behind
the tool list. An unknown kind sees no tools and reads no charter.

| Kind | Who | Tools | Writes | Longest life |
| --- | --- | --- | --- | --- |
| `external` | Claude.ai, Claude Code, ChatGPT through OAuth consent (`svmcp_` tokens) | Every tool in the registry | Through the routes, as the person | Consent's own |
| `agent_mayor` | Homeroom bot, reading for the person it answers: its chats, a project's thread, a design | 13 reads (`AGENT_MAYOR_TOOLS`) | None: what the bot files or changes goes through its own offers and the person's tap | 15 minutes |
| `bot_admin` | Homeroom bot answering a full platform admin in their own chat with it (`homeroom-bot-thread-tools/admin.js`) | A curated set of the connector's admin tools | Only on a grant minted for one action the admin confirmed on a card (`src/services/confirmations/`) | 5 minutes |
| `worker_read` | The coding agent inside one change's worker | Six reads (`WORKER_READ_TOOLS`), bound to that change's app | None | 2 hours |

The synthetic client ids are `homeroom:<kind>`, shown by name as "Homeroom
bot", "Homeroom bot (admin tools)" and "Homeroom coding agent"
(`src/services/mcp-connect-constants.js`).

## The token

`mcpOauth.issueDelegatedAccess` (`src/services/mcp-oauth.js`) writes one
`mcp_delegations` row and one access token, audited as `token_issued`:

- **An access row only.** There is no refresh token, so a leaked token dies
  at its expiry, which is at most the kind's longest life away.
- **Its own prefix, `svmcd_`.** The staging and enablement gates recognise
  one by shape before any lookup, and a worker's output scrubber finds one
  without knowing its value. Shape is routing only.
- **A client id `CLIENT_ID_RE` refuses**, so the consent, token and
  registration endpoints can never mint, refresh or approve anything under
  one.
- **A worker grant is read-only and bound** to one change and its app; the
  issuer refuses anything else rather than trusting the caller.

`authenticateConnector` (`src/routes/mcp-remote.js`) joins the delegation on
every request, and the token's shape and its grant must agree: an `svmcd_`
token is honoured only with a live delegation behind it, and an `svmcp_`
token never with one. A delegation is live while it is neither revoked nor
expired and, when it names a change, while that change is still the
person's, still in the named app and still open (`active` or `promoted` for
a worker; `active`, `paused`, `promoted` or `merging` otherwise). Pausing or
archiving a change therefore ends a worker's token on its next call without
anything having to revoke it. The bearer chain additionally pins every
`:slug` in a route to the grant's app and every `:id` to a change in it.

The turn that issued a grant revokes it when it ends, however it ends
(`revokeDelegation`, audited as `token_revoked`). The `delegation-prune`
clock deletes grants a week after they expired or were revoked, with their
token rows. Delegated grants are left out of Settings' connectors list
(`/api/me/connectors`), its disconnect and its Test connection: they are not
the person's to disconnect.

## Where each is used

**Homeroom bot** reaches the tools through `openMayorMcp` in
`src/services/mayor/mcp-shim.js`: an `McpServer` and an MCP client joined by
the SDK's in-memory transport, built for the grant, with loopback calls to the
pod's own port. It repeats the two edge duties `/mcp` performs and an
in-process call would skip: a `token_used` audit row per call, and a rate
bucket of 120 calls a minute per caller. Results reach the model cut at 24k
characters, with at most six pictures a turn. Tool calls go through
`client.request` with `CallToolResultSchema`, because the SDK's `callTool`
checks an error result's content against the tool's output schema and the
connector's error results never match one.

**The coding agent** gets a `worker_read` grant for each build or scout turn
(`mintHomeroomReadGrant` in `src/services/worker.js`), bound to the change's
owner, the change and its app, and revoked on every exit of the turn. Minting
is best effort: without a grant the agent runs as before. A benchmark trial
gets none, except in the App bench studio's own host app, because these reads
show the platform as it is now. The token reaches the worker only as
`HOMEROOM_MCP_TOKEN` in the turn's environment. `worker/homeroom-read-mcp.js`
proxies the six reads to `PLATFORM_URL/mcp` (a first version's build is
offered `get_platform_conventions` alone: a brand-new app has nothing else to
read), drops any other tool the server lists, and offers none without a
token; its config,
`/usr/local/share/usernode/homeroom-mcp.json`, is baked into the image and
carries no secret. Claude Code loads it under `--strict-mcp-config`; Codex
gets an `[mcp_servers.homeroom]` block, with the token excluded from the
shell environment policy and redacted from output.

**Charters.** A delegated caller reads its own charter and instructions
(`charterFor(kind)` and `instructionsFor(kind)` in
`src/services/mcp-charter.js`), chosen by the grant's kind: the sections
written for a human-driven client are left out, and each kind adds its own
role.

## On staging and with the connector off

`/mcp` and the loopback chain answer 404 on a staging preview and when
`cliAuthEnabled` is off. Exactly two things pass, both decided on the
bearer's shape: `POST /mcp` with an `svmcd_` bearer, and an `svmcd_` bearer
on the loopback API chain. Behind the gate the handler still refuses
anything that did not authenticate as a live delegation. Metadata,
registration, consent, token, revocation and the Settings list stay off, so
a preview can exercise the platform's own agents and nothing else.
