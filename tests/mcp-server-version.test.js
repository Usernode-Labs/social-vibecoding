// #1244 — the handshake has to say which build answered it.
//
// `serverInfo.version` is the one field in the MCP initialize response whose
// purpose is to identify the running server, and it was a frozen `1.0.0`.
// That is not cosmetic. MCP fetches `instructions`, tool names and tool
// descriptions ONCE per connection and caches them for its lifetime, while
// tool results are live — so a session's cached rules can come from an older
// build than the code now answering its calls, and this field is the only
// thing that can tell the two apart. Three handshakes spanning a deploy
// boundary all reported the same `1.0.0`, and working out which build was
// live took reading a client debug log for the truncated-instructions length
// and matching it against SERVER_INSTRUCTIONS at two commits — which only
// worked because that length happened to differ between them.
//
// The two cautions below are from the same report, and both fail SILENTLY:
//
//   1. A version that varies per deploy is the fix; a NAME that varies is a
//      regression. Permission allow rules match the server name as a
//      literal, so a per-deploy name would break every rule the platform
//      ships, with no error anywhere.
//   2. The build id must stay OUT of SERVER_INSTRUCTIONS, which is budgeted
//      to the byte against a client that truncates that field with a plain
//      slice. serverInfo and a tool result both sit outside that budget,
//      which is exactly why they are the right carriers.
//
// Run with: node --test tests/mcp-server-version.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SERVER_NAME,
  SERVER_VERSION,
  SERVER_VERSION_BASE,
  serverVersionFor,
  SERVER_INSTRUCTIONS_MAX_CHARS,
} = require('../src/services/mcp-connect-constants');
const { SERVER_INSTRUCTIONS } = require('../src/services/mcp-charter');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CONSTANTS_SRC = read('src/services/mcp-connect-constants.js');
const TOOLS_SRC = read('src/services/mcp-tools.js');
const REMOTE_SRC = read('src/routes/mcp-remote.js');

// ── 1. The version identifies the build ────────────────────────────────

test('a deployed build reports its commit', () => {
  assert.equal(
    serverVersionFor('aef58cb05acc87f80e040380326d67cf80d4f744'),
    '1.0.0+aef58cb'
  );
});

test('two builds never report the same version', () => {
  // The whole point of the field is to DISTINGUISH. A deploy that changes
  // behaviour and nothing else must still move this string.
  assert.notEqual(
    serverVersionFor('aef58cb05acc87f80e040380326d67cf80d4f744'),
    serverVersionFor('c9f2fd2ba1e04c6d9b7e3a5f8c2d1e0a4b6f8d3c')
  );
});

test('a build with no deploy behind it says so instead of claiming a release', () => {
  // Staging previews of the platform are built without GIT_SHA, and compose
  // defaults it to the literal `dev` — so this reads as "not a deployment"
  // where a bare `1.0.0` would have read as a release.
  assert.equal(serverVersionFor('dev'), `${SERVER_VERSION_BASE}+dev`);
  for (const empty of [undefined, null, '', '   ']) {
    assert.equal(serverVersionFor(empty), SERVER_VERSION_BASE);
  }
});

test('a value that narrows away leaves no dangling separator', () => {
  // GIT_SHA arrives from the environment, not from this repository. Semver
  // build metadata is [0-9A-Za-z-]; anything else is dropped, and a value
  // that survives to nothing falls back rather than emitting `1.0.0+`.
  assert.equal(serverVersionFor('!!!'), SERVER_VERSION_BASE);
  assert.equal(serverVersionFor('  AEF58CB  '), '1.0.0+aef58cb');
  assert.doesNotMatch(serverVersionFor('///'), /\+$/);
});

test('the exported constant is derived, not written down', () => {
  assert.equal(SERVER_VERSION, serverVersionFor(process.env.GIT_SHA));
  // A bare `const SERVER_VERSION = '1.0.0'` is the bug this file is about.
  assert.doesNotMatch(CONSTANTS_SRC, /const SERVER_VERSION = '[\d.]+';/);
});

// ── 2. Caution one: the NAME must not vary ─────────────────────────────

test('the connector name is still a fixed literal', () => {
  assert.equal(SERVER_NAME, 'usernode');
  const line = CONSTANTS_SRC
    .split('\n')
    .find((l) => l.startsWith('const SERVER_NAME'));
  assert.ok(line, 'SERVER_NAME must stay a top-level const');
  assert.doesNotMatch(
    line,
    /process\.env/,
    'allow rules match the name literally — a per-deploy name breaks every shipped rule, silently'
  );
});

// ── 3. Caution two: the build id stays out of the instructions ─────────

test('the build id is not carried in SERVER_INSTRUCTIONS', () => {
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /GIT_SHA/);
  assert.ok(
    !SERVER_INSTRUCTIONS.includes(SERVER_VERSION),
    'serverInfo and a tool result sit outside the instruction budget; that is why they carry this'
  );
  assert.ok(
    SERVER_INSTRUCTIONS.length <= SERVER_INSTRUCTIONS_MAX_CHARS,
    `SERVER_INSTRUCTIONS is ${SERVER_INSTRUCTIONS.length} chars, over its `
      + `${SERVER_INSTRUCTIONS_MAX_CHARS} budget`
  );
});

// ── 4. Both surfaces report ONE value ──────────────────────────────────

test('the handshake sends the constant', () => {
  assert.match(REMOTE_SRC, /\{\s*name: SERVER_NAME, version: SERVER_VERSION\s*\}/);
});

test('whoami reports the same build, readable without a client debug log', () => {
  const whoami = TOOLS_SRC.slice(
    TOOLS_SRC.indexOf("server.registerTool('whoami'"),
    TOOLS_SRC.indexOf("server.registerTool('get_platform_conventions'")
  );
  assert.ok(whoami, 'whoami registration not found');
  assert.match(whoami, /serverVersion: z\.string\(\)/, 'declared in the output schema');
  assert.match(
    whoami,
    /serverVersion: SERVER_VERSION/,
    'and it must be the SAME constant the handshake sent, not a second source of truth'
  );
});
