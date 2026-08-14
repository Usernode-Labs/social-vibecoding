// #1218 — the connector's permission surface.
//
// Every hosted-connector call used to raise its own permission prompt,
// read-only ones included, and in a Claude Code WEB session the grant does
// not survive the container — so the same prompts came back next session,
// for every user, and `submit_work` (which starts a group vote) drowned in
// the noise.
//
// An MCP server cannot reduce its own prompting, and should not be able to.
// The fix is therefore client-side and three-part, and all three parts fail
// SILENTLY when they drift:
//
//   1. The server segment of a permission rule cannot be wildcarded, so
//      every rule hardcodes a name. If the scaffold's name and the server's
//      own serverInfo.name ever diverge, the shipped rules match nothing —
//      no error, the user just keeps being prompted.
//   2. The acting tools are marked `anthropic/requiresUserInteraction`, but
//      that needs Claude Code >= 2.1.199, so the shipped allowlist must stay
//      narrow enough to be safe without it.
//   3. Documentation has to name BOTH tool-name prefixes, because the
//      `claude_ai_` segment is present on some surfaces and absent on
//      others — guidance naming one is wrong for half of users.
//
// Run with: node --test tests/connector-permission-rules.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const constants = require('../src/services/mcp-connect-constants');
const template = require('../src/services/template');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const REMOTE_SRC = read('src/routes/mcp-remote.js');
const CONNECTORS_TSX = read('frontend/src/features/settings/sections/connectors.tsx');
const CONNECTOR_DOC = read('MCP-CONNECTOR.md');

const scaffold = () => {
  const files = template.getTemplateFiles('Demo App', 'demo-app', 'postgres://x/y');
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  return byPath;
};

// ── 1. The name ────────────────────────────────────────────────────────

test('the canonical connector name is what the server actually reports', () => {
  assert.equal(constants.SERVER_NAME, 'usernode');
  // serverInfo.name in the initialize response is built from that one
  // constant, so a client that derives the name and a user who types it
  // land on the same string — which is the whole reason the rules below
  // can hardcode it.
  assert.match(REMOTE_SRC, /\{\s*name: SERVER_NAME, version: SERVER_VERSION\s*\}/);
});

test('the misspelling from the report is not ours', () => {
  // #1218 saw tools arrive as mcp__Uesrnode__whoami. If that string were
  // in the source it would be a platform bug and the shipped rules would
  // have to reproduce the typo to work. It is not: the name was typed into
  // Claude.ai's "Add custom connector" dialog, which is why the fix is to
  // recommend the canonical name at connect time.
  for (const rel of [
    'src/services/mcp-connect-constants.js',
    'src/services/mcp-tools.js',
    'src/routes/mcp-remote.js',
    'src/services/template.js',
  ]) {
    const src = read(rel);
    const typo = /Uesrnode/g;
    const hits = [...src.matchAll(typo)];
    // Prose explaining the report is fine; a value is not.
    for (const hit of hits) {
      const line = src.slice(0, hit.index).split('\n').pop() + src.slice(hit.index).split('\n')[0];
      assert.match(
        line.trim(), /^(\/\/|\*|\/\*)/,
        'Uesrnode may appear only in a comment, never as a value'
      );
    }
  }
});

test('the connect flow recommends the canonical name where it is typed', () => {
  // The Name field is the only place that string is decided, so this is
  // where it has to be said — not in a doc nobody opens mid-dialog.
  assert.match(CONNECTORS_TSX, /Add custom connector/);
  assert.match(CONNECTORS_TSX, /Name it exactly/);
  assert.match(CONNECTORS_TSX, new RegExp(`<code[^>]*>${constants.SERVER_NAME}</code>`));
});

// ── 2. The shipped allow rules ─────────────────────────────────────────

test('the read-only allow rules are two globs and one literal, built from the name', () => {
  assert.deepEqual([...constants.READ_ONLY_ALLOW_RULES], [
    'mcp__usernode__get_*',
    'mcp__usernode__list_*',
    'mcp__usernode__whoami',
  ]);
  for (const rule of constants.READ_ONLY_ALLOW_RULES) {
    assert.ok(
      rule.startsWith(`mcp__${constants.SERVER_NAME}__`),
      `${rule} names the configured server literally`
    );
    // The server segment must be glob-free — a rule with a wildcard there
    // is not a looser rule, it is a rule that matches nothing.
    const [, , server] = rule.split('__');
    assert.ok(server !== undefined);
    assert.doesNotMatch(
      rule.slice(0, rule.indexOf('__', 5)), /\*/,
      'the server segment must be glob-free'
    );
  }
});

test('never a whole-server allow — the marking is version-gated', () => {
  // A blanket mcp__usernode__* would auto-approve submit_work for anyone on
  // a Claude Code older than 2.1.199, which ignores requiresUserInteraction:
  // a change reaching a group vote with nobody having confirmed it.
  const wildcard = `mcp__${constants.SERVER_NAME}__*`;
  assert.ok(!constants.READ_ONLY_ALLOW_RULES.includes(wildcard));
  const settings = scaffold().get('.claude/settings.json');
  assert.ok(!settings.includes(`"${wildcard}"`), 'the scaffold ships no whole-server rule');

  // And every shipped rule can only match a read: a glob's prefix is one of
  // the read-only prefixes, or it is a literal read tool.
  for (const rule of constants.READ_ONLY_ALLOW_RULES) {
    const tool = rule.slice(rule.lastIndexOf('__') + 2);
    const ok = constants.READ_ONLY_TOOL_PREFIXES.some((p) => tool === `${p}*`)
      || constants.READ_ONLY_TOOL_EXCEPTIONS.includes(tool);
    assert.ok(ok, `${rule} can only ever match a read-only tool`);
  }
});

// ── 3. The scaffold ────────────────────────────────────────────────────

test('every scaffolded app repo ships .claude/settings.json', () => {
  const files = scaffold();
  const settings = files.get('.claude/settings.json');
  assert.ok(settings, 'the scaffold writes .claude/settings.json');

  const parsed = JSON.parse(settings);
  assert.deepEqual(parsed, {
    permissions: { allow: [...constants.READ_ONLY_ALLOW_RULES] },
  });
  // Only permissions.allow — a scaffolded repo grants capability and
  // nothing more; it does not set a permission mode or add hooks.
  assert.deepEqual(Object.keys(parsed), ['permissions']);
  assert.deepEqual(Object.keys(parsed.permissions), ['allow']);
  assert.ok(settings.endsWith('\n'), 'settings.json ends with a newline');
});

test('the scaffold explains itself next to the file, since JSON has no comments', () => {
  const readme = scaffold().get('.claude/README.md');
  assert.ok(readme, 'the scaffold writes .claude/README.md');
  assert.match(readme, /workspace trust dialog/i);
  assert.match(readme, /requiresUserInteraction/);
  assert.match(readme, /2\.1\.199/);
  // Both prefix forms, because it differs by surface.
  assert.match(readme, /mcp__<server>__whoami/);
  assert.match(readme, /mcp__claude_ai_<server>__whoami/);
  assert.match(readme, /read the name off your own tool list/i);
});

test('the scaffolded CLAUDE.md points at it', () => {
  const claudeMd = scaffold().get('CLAUDE.md');
  assert.match(claudeMd, /\.claude\/settings\.json/);
  assert.match(claudeMd, /workspace trust dialog/i);
});

test('.claude is kept out of the app image', () => {
  // The scaffold's Dockerfile does COPY . . — editor settings have no
  // business in a runtime image.
  assert.match(scaffold().get('.dockerignore'), /^\.claude$/m);
});

// ── 4. The documentation ───────────────────────────────────────────────

test('the connector doc names both tool-name prefixes', () => {
  // Guidance naming only one form is wrong for half of users, silently.
  assert.match(CONNECTOR_DOC, /mcp__usernode__whoami/);
  assert.match(CONNECTOR_DOC, /mcp__claude_ai_usernode__whoami/);
  assert.match(CONNECTOR_DOC, /read the name off your own tool list/i);
});

test('the connector doc covers the trust dialog and the version gate', () => {
  assert.match(CONNECTOR_DOC, /workspace trust dialog/i);
  assert.match(CONNECTOR_DOC, /2\.1\.199/);
  assert.match(CONNECTOR_DOC, /anthropic\/requiresUserInteraction/);
});

test('the open question about ephemeral web containers is recorded as open', () => {
  // It cannot be answered from this repository — it needs a fresh Claude
  // Code web session — and it must not be quietly dropped, because the
  // answer changes what this can honestly be announced as.
  assert.match(CONNECTOR_DOC, /Open question/i);
  assert.match(CONNECTOR_DOC, /ephemeral web containers/i);
  assert.match(CONNECTOR_DOC, /has not been settled/i);
});
