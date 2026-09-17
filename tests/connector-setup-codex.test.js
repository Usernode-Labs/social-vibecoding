// Settings → Connectors: the Codex CLI and "any other MCP client" setup
// walkthroughs (#1892).
//
// Only Claude.ai and ChatGPT had a walkthrough. The Codex block carries the
// two forms the Codex CLI's remote-server setup takes — the `codex mcp add`
// command and the `~/.codex/config.toml` entry it writes — and the generic
// block states what any MCP client needs that the product walkthroughs leave
// implicit: the transport, how auth is discovered, the callback rule, and
// the tool-name prefix the permission-rule section is written around.
//
// Every server-side fact those blocks name is pinned here to the constants
// and route code that define it, so the copy cannot drift from what /mcp
// actually does. #1893 was filed because the Claude instructions did not
// work; a walkthrough that quietly goes stale is the same complaint again.
//
// Run with: node --test tests/connector-setup-codex.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const TSX = read('frontend/src/features/settings/sections/connectors.tsx');
const SETTINGS = read('frontend/src/features/settings/settings.js');
const OAUTH = read('src/services/mcp-oauth.js');
const REMOTE = read('src/routes/mcp-remote.js');
const constants = require('../src/services/mcp-connect-constants');

// The markup of one card, from its id to the next card's id.
function block(id, nextId) {
  const start = TSX.indexOf(`id="${id}"`);
  assert.ok(start > 0, `#${id} exists`);
  const end = nextId ? TSX.indexOf(`id="${nextId}"`) : TSX.length;
  assert.ok(end > start, `#${nextId} follows #${id}`);
  return TSX.slice(start, end);
}

// User-facing text only: JSX comments are developer prose and may use
// whatever punctuation they like.
const stripComments = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const CODEX = block('connector-setup-codex', 'connector-setup-generic');
const GENERIC = block('connector-setup-generic', 'connector-prompt-help');

// ── The Codex CLI block ────────────────────────────────────────────────

test('#1892: the Codex block carries both forms the CLI takes, under the canonical name', () => {
  // #2370: the route is a <details>; its summary names it and its step count.
  assert.match(CODEX, /3 steps &middot; in the terminal/);
  // Verified against codex-rs/cli/src/mcp_cmd.rs on main (2026-09-14):
  // `codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`.
  const add = TSX.match(/const CODEX_ADD_COMMAND = `([^`]*)`/);
  assert.ok(add, 'the command is one literal');
  assert.match(add[1], new RegExp(`^codex mcp add ${constants.SERVER_NAME} --url \\$\\{CODEX_URL_PLACEHOLDER\\}$`));
  // The file form the command writes: `[mcp_servers.<name>]` with a `url`.
  const toml = TSX.match(/const CODEX_CONFIG_TOML = `([^`]*)`/);
  assert.ok(toml, 'the config entry is one literal');
  assert.match(toml[1], new RegExp(`^\\[mcp_servers\\.${constants.SERVER_NAME}\\]\\nurl = "\\$\\{CODEX_URL_PLACEHOLDER\\}"$`));
  // Both rendered, each with its own Copy control in the header-row idiom.
  for (const id of ['connector-codex-add', 'connector-codex-config']) {
    assert.match(CODEX, new RegExp(`<pre id="${id}"`), `${id} is a <pre>`);
    assert.match(CODEX, new RegExp(`id="${id}-copy"`), `${id} has a Copy button`);
  }
  assert.match(CODEX, /\{CODEX_ADD_COMMAND\}<\/pre>/);
  assert.match(CODEX, /\{CODEX_CONFIG_TOML\}<\/pre>/);
  // And the sign-in and listing commands, by name.
  assert.match(CODEX, new RegExp(`codex mcp login ${constants.SERVER_NAME}`));
  assert.match(CODEX, /codex mcp list/);
});

test('#1892: the placeholder is one string in both files, and settings.js swaps it for the live URL', () => {
  const inTsx = TSX.match(/const CODEX_URL_PLACEHOLDER = '([^']+)';/);
  const inJs = SETTINGS.match(/const CODEX_URL_PLACEHOLDER = '([^']+)';/);
  assert.ok(inTsx && inJs, 'both files define the placeholder');
  assert.equal(inTsx[1], inJs[1], 'the two copies of the placeholder agree');
  // It has to read as a fill-in, never as an address someone might paste
  // as-is — the written steps never name a host (#1289), and neither do
  // these blocks.
  assert.match(inTsx[1], /^https:\/\/<[^>]+>\/mcp$/);
  assert.doesNotMatch(inTsx[1], /onhomeroom|usernode/i);
  // The swap happens where #connector-url is filled, from the same derived
  // value, and by textContent — never innerHTML.
  const start = SETTINGS.indexOf('const connectorUrl = `${window.location.origin}/mcp`;');
  assert.ok(start > 0);
  const swap = SETTINGS.slice(start, SETTINGS.indexOf('this._connectorLoadId', start));
  assert.match(swap, /\['connector-codex-add', 'connector-codex-config'\]/);
  assert.match(swap, /block\.textContent = block\.textContent\.split\(CODEX_URL_PLACEHOLDER\)\.join\(connectorUrl\)/);
  const code = swap.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /innerHTML/);
});

test('#1892: the two Codex copy buttons are wired, reading the block at click time', () => {
  const start = SETTINGS.indexOf('const CODEX_BLOCKS = {');
  assert.ok(start > 0, 'the Codex blocks are wired in one place');
  const wiring = SETTINGS.slice(start, SETTINGS.indexOf('this._wireConnectorNameSpelling();', start));
  for (const id of ['connector-codex-add', 'connector-codex-config']) {
    assert.match(wiring, new RegExp(`'${id}': \\{`), `${id} has copy messages`);
  }
  assert.match(wiring, /this\._wireCopyControl\(`\$\{id\}-copy`/);
  assert.match(wiring, /read: \(\) => \{\s*const block = document\.getElementById\(id\);\s*return block \? block\.textContent : null;/);
  // The existing allow-rule loop is untouched: another test pins it literally.
  assert.match(SETTINGS, /\['connector-allow-rules', 'connector-repo-allow-rules'\]/);
});

test('#1892: the Codex block says what the hosted platform refuses, and why, instead of stopping at a login that fails', () => {
  // Codex takes the OAuth approval on a loopback callback
  // (codex-rs/rmcp-client/src/oauth_callback.rs: "http://127.0.0.1/callback").
  // mcp-oauth.js accepts a loopback redirect only in local-development mode,
  // so on the hosted platform dynamic client registration refuses it. The
  // copy names the host, the mode and the error, each pinned to the code.
  assert.match(CODEX, /127\.0\.0\.1/);
  assert.match(OAUTH, /host === '127\.0\.0\.1'/);
  assert.match(OAUTH, /config\.cliAuthLocalMode && loopback/);
  assert.match(CODEX, /local-development mode/);
  assert.match(CODEX, /invalid_redirect_uri/);
  assert.match(REMOTE, /error: 'invalid_redirect_uri'/);
  // And it says what a connector-less Codex session can still do, which is
  // the hand-off the platform already runs: push, and the chat submits.
  assert.match(CODEX, /pushes the branch/);
});

// ── The generic block ──────────────────────────────────────────────────

test('#1892: the generic block names the transport and the auth-discovery path the route serves', () => {
  assert.match(GENERIC, /4 steps &middot; any MCP client/);
  assert.match(GENERIC, /Streamable HTTP/);
  assert.match(GENERIC, /JSON-RPC over POST/);
  // /mcp is POST-only; there is no GET/SSE handler to promise.
  assert.match(REMOTE, /router\.post\(MCP_PATH,/);
  assert.doesNotMatch(REMOTE, /router\.get\(MCP_PATH/);
  // The protected-resource metadata path is `/.well-known/oauth-protected-resource${MCP_PATH}`.
  assert.match(GENERIC, new RegExp(`/\\.well-known/oauth-protected-resource${constants.MCP_PATH}`));
  assert.match(REMOTE, /router\.get\(`\/\.well-known\/oauth-protected-resource\$\{MCP_PATH\}`/);
  assert.match(GENERIC, /dynamic client registration/);
  assert.match(GENERIC, /no client ID or secret/);
});

test('#1892: the scopes and redirect hosts in the copy are the server constants', () => {
  for (const scope of [constants.READ_SCOPE, constants.WRITE_SCOPE]) {
    assert.match(GENERIC, new RegExp(`<code[^>]*>${scope.replace(/[.:]/g, '\\$&')}</code>`), `${scope} is named`);
  }
  for (const host of constants.DEFAULT_REDIRECT_HOSTS) {
    assert.match(GENERIC, new RegExp(`<code[^>]*>${host.replace(/\./g, '\\.')}</code>`), `${host} is named`);
  }
  // No host beyond the default list is named as accepted: an operator's
  // additions are described, not enumerated.
  const named = [...GENERIC.matchAll(/<code[^>]*>([a-z]+\.(?:ai|com))<\/code>/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(named)].sort(), [...constants.DEFAULT_REDIRECT_HOSTS].sort());
  assert.match(GENERIC, /operator has added/);
  assert.match(GENERIC, /invalid_redirect_uri/);
});

test('#1892: the generic block teaches the tool-name prefix the permission rules depend on', () => {
  // Both spellings MCP-CONNECTOR.md documents, and the same "read it off
  // your own tool list" rule.
  assert.match(GENERIC, new RegExp(`mcp__${constants.SERVER_NAME}__whoami`));
  assert.match(GENERIC, new RegExp(`mcp__claude_ai_${constants.SERVER_NAME}__whoami`));
  assert.match(GENERIC, /between the first and last/);
  assert.match(GENERIC, /get_connector_guidance/);
});

// ── Shape and conventions ──────────────────────────────────────────────

test('#1892: both blocks are numbered walkthroughs in the same idiom as the Claude and ChatGPT ones', () => {
  for (const [name, src, steps] of [['Codex', CODEX, 3], ['generic', GENERIC, 4]]) {
    const count = (src.match(/<SetupStep n=\{\d+\}/g) || []).length;
    assert.equal(count, steps, `the ${name} block has ${steps} steps`);
    for (let n = 1; n <= steps; n += 1) {
      assert.match(src, new RegExp(`<SetupStep n=\\{${n}\\} title="[^"]+\\."`), `${name} step ${n} is titled`);
    }
    assert.match(src, /<ol className="space-y-2">/);
  }
  // The four walkthroughs sit together, before the permission-prompt panel.
  const order = ['Set up in Claude', 'Set up in ChatGPT', 'id="connector-setup-codex"', 'id="connector-setup-generic"', 'id="connector-prompt-help"']
    .map((needle) => TSX.indexOf(needle));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'walkthroughs are in reading order');
});

test('#1892: user-facing copy in the new blocks carries no em dash', () => {
  for (const src of [stripComments(CODEX), stripComments(GENERIC)]) {
    assert.doesNotMatch(src, /—|&mdash;|&#8212;/);
  }
});

test('#1893: the Claude walkthrough names the connector at the step where the Name field is filled', () => {
  // The Name field in Claude.ai's dialog is where the permission-rule server
  // segment comes from (#1218). Saying `homeroom` two blocks later, after
  // the reader has already typed something, is how one account ended up
  // with `Uesrnode`. So step 2 says it at the moment it is typed.
  const step2 = TSX.slice(
    TSX.indexOf('<SetupStep n={2} title="Start a custom connector."'),
    TSX.indexOf('<SetupStep n={3} title="Paste your MCP server URL."')
  );
  assert.ok(step2.length > 0, 'the Claude steps are in order');
  assert.match(step2, new RegExp(`<code[^>]*>${constants.SERVER_NAME}</code>`));
  assert.match(step2, /Name field/);
});

test('#1892: the no-prompts case covers Codex, which settings.js already files with ChatGPT', () => {
  const chat = TSX.slice(TSX.indexOf('id="connector-case-chat"'));
  assert.match(chat, /Claude\.ai chat, ChatGPT and Codex/);
  assert.match(chat, /Nothing to do/);
  assert.match(SETTINGS, /\/chatgpt\|openai\|codex\/\.test\(name\)/);
});
