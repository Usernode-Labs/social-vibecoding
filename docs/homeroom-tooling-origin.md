# Default Homeroom tooling to app.onhomeroom.com

## Problem

The committed production default for the CLI, stdio MCP server, and local
coding agents still points to `https://my.onhomeroom.com`. A local named
profile can hide this problem, but a clean setup or explicit `production`
profile continues to use the old host. Agent handoff instructions also use
the old origin when no deployment domain is configured.

## Change

Use `https://app.onhomeroom.com` as the production fallback in the shared CLI
authentication constants. Update the agent handoff fallback so its connector
URL is `https://app.onhomeroom.com/mcp` and its settings link uses the same
origin. Document this committed default in the tooling specification and
agent API instructions, distinguishing it from a local profile override.

Keep explicit `USERNODE_DOMAIN` deployments, named custom profiles, and the
`http://localhost:3000` local profile unchanged. Do not alter production
infrastructure, domain routing, or existing user configuration.

Credentials remain bound to their original server origin. Do not copy a
credential issued for `my.onhomeroom.com` to the new host or follow redirects
with credentials. A user with only an old-host login uses the existing device
login flow for the new origin; an existing named profile stays as configured.

## Verification

Verify the production profile resolves to the new host with no environment
override, while self-hosted and local selection still work. Verify the
credential-free MCP status reports the new origin, an old-host credential
cannot satisfy new-host authentication, and generated handoff URLs use the
new fallback while respecting a configured domain. Run the affected auth,
CLI, MCP, setup, and prompt suites, then the normal native proposal checks.

## How to test / observe

From the updated checkout, with `USERNODE_DOMAIN` unset, run
`node ./tools/social-vibecoding auth server list`: `production` should show
`https://app.onhomeroom.com`. A stdio MCP server started with
`--profile production` should report that same origin through `login_status`.
An explicitly configured self-hosted domain or named profile should still
report its own origin. Confirm generated agent handoff instructions use
`https://app.onhomeroom.com/mcp` when no domain is configured.

This changes tooling defaults and generated text links only, with no rendered
application UI, layout, styling, or animation changes.
