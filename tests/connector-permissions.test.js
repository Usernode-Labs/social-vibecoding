// The connector's canonical name, its read-only/acting split, and the
// client-side allow rules built from both (#1206).
//
// The failure this file exists to prevent is a SILENT one. A Claude Code
// permission rule is `mcp__<server>__<tool>`, the server segment cannot be
// a glob, and a rule that names a server or a tool which does not exist
// produces no error of any kind — it simply never matches, and the user is
// prompted on every read exactly as if they had written nothing. So a typo
// here does not break a test at the point of the typo; it quietly undoes
// the feature. Everything below is therefore generated from ONE constant
// and asserted to agree: the server name, the scaffold's settings file,
// this repository's settings file, the docs, the UI's data source and the
// `whoami` payload.
//
// The second thing it guards is the boundary the issue was explicit about:
// these rules are CLIENT-SIDE CONVENIENCE ONLY. They must never grow to
// cover a tool that acts on the user's behalf, and they must not touch
// scope enforcement — `scopeGuard()` still runs before every platform call
// whatever a settings file says.
//
// Run with: node --test tests/connector-permissions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const mcpTools = require('../src/services/mcp-tools');
const { SERVER_NAME, PERMISSION_RULE_PREFIX } = require('../src/services/mcp-connect-constants');
const { getTemplateFiles } = require('../src/services/template');

const {
  READ_ONLY_TOOLS, ACTING_TOOLS, connectorPermissionSettings, connectorPermissionSettingsJson,
} = mcpTools;

const SETTINGS_PATH = '.claude/settings.json';
const DOCS_PATH = '/connector-setup.md';
const DOCS_FILE = 'CONNECTOR-SETUP.md';

const TOOLS_SRC = read('src/services/mcp-tools.js');
const REMOTE_SRC = read('src/routes/mcp-remote.js');
const SERVER_SRC = read('server.js');
const DOCS = read(DOCS_FILE);

// Register the real tool table against a recording server. Handlers are
// never invoked — this reads the DECLARATIONS, which is what a client sees
// and what the classification below has to stay in step with.
function registerAll() {
  const registered = new Map();
  const server = {
    registerTool(name, config) {
      assert.ok(!registered.has(name), `${name} registered twice`);
      registered.set(name, config);
    },
  };
  mcpTools.registerTools(server, {
    accessToken: 'tok', scopes: ['usernode:apps:read', 'usernode:proposals:write'],
    user: { id: 1, username: 'someone' },
    clientName: 'claude.ai', clientId: 'client-1',
    origin: 'https://claude.ai', baseUrl: 'https://usernode.example',
    pool: {}, config: {},
  });
  return registered;
}

// ── The canonical name ─────────────────────────────────────────────────

test('there is exactly one spelling of the server name, and the rules derive from it', () => {
  assert.equal(SERVER_NAME, 'Usernode');
  assert.equal(PERMISSION_RULE_PREFIX, `mcp__${SERVER_NAME}__`);

  // The prefix a rule carries before any wildcard is allowed. If this ever
  // contained a glob character the rules would be unmatchable, since only
  // the TOOL segment may be wildcarded.
  assert.ok(!/[*?]/.test(PERMISSION_RULE_PREFIX), 'the server segment of a rule cannot be a glob');
});

test('the connector advertises that one name everywhere, rather than a second copy of it', () => {
  // Both fields a client may pre-fill its name box from: serverInfo.name in
  // the initialize response, and RFC 9728 resource_name. A hardcoded string
  // in either is how the two drifted apart in the first place.
  assert.match(REMOTE_SRC, /resource_name:\s*SERVER_NAME/);
  assert.ok(
    !/resource_name:\s*['"]/.test(REMOTE_SRC),
    'resource_name is hardcoded again — derive it from SERVER_NAME so there is one spelling',
  );

  // The UI must not type the name either; it renders whatever the server
  // sent in the /api/me/connectors `setup` block.
  const ui = read('frontend/src/features/settings/sections/connectors.tsx');
  assert.ok(
    !/Usernode|usernode/.test(ui.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')),
    'the Connectors UI hardcodes a server name; it must render the one the API returns',
  );
  assert.match(ui, /id="connector-name"/);
  assert.match(ui, /id="connector-perms-json"/);
});

test('the connect surface serves the name, the rules and the docs link', () => {
  for (const field of ['serverName', 'toolPrefix', 'readOnlyTools', 'actingTools', 'settingsJson']) {
    assert.match(REMOTE_SRC, new RegExp(`${field}:`), `/api/me/connectors omits ${field}`);
  }
  assert.ok(REMOTE_SRC.includes(`docsPath: '${DOCS_PATH}'`), 'the setup block must link the docs');
});

// ── Read-only vs acting ────────────────────────────────────────────────

test('every registered tool is classified exactly once', () => {
  const registered = [...registerAll().keys()].sort();
  const classified = [...READ_ONLY_TOOLS, ...ACTING_TOOLS].sort();

  assert.deepEqual(
    classified, registered,
    'a connector tool is missing from READ_ONLY_TOOLS / ACTING_TOOLS, or names one that no longer '
    + 'exists. An unclassified tool is not merely undocumented: a rule naming a tool that is not '
    + 'registered matches nothing and fails silently, and a new tool that quietly lands in the '
    + 'read-only list is pre-approved for everyone.',
  );

  const overlap = READ_ONLY_TOOLS.filter((t) => ACTING_TOOLS.includes(t));
  assert.deepEqual(overlap, [], 'a tool cannot be both read-only and acting');
});

test('the acting tools are the ones that change something under the user\'s name', () => {
  // Pinned by name rather than derived, so that MOVING a tool across the
  // line is a deliberate, reviewable edit here. submit_work in particular
  // opens a pull request and puts a change to a group vote.
  assert.deepEqual([...ACTING_TOOLS].sort(), [
    'answer_questions',
    'create_request',
    'prepare_work',
    'start_platform_build',
    'submit_platform_build',
    'submit_work',
  ]);
});

test('annotations declare requiresUserInteraction in line with the classification', () => {
  for (const [name, config] of registerAll()) {
    const a = config.annotations;
    assert.ok(a, `${name} declares no annotations`);
    const acting = ACTING_TOOLS.includes(name);
    assert.equal(
      a.requiresUserInteraction, acting,
      `${name}: requiresUserInteraction should be ${acting}`,
    );
    assert.equal(a.readOnlyHint, !acting, `${name}: readOnlyHint should be ${!acting}`);
    // Nothing the connector does is destructive, and nothing reaches
    // outside the platform.
    assert.equal(a.destructiveHint, false, `${name}: destructiveHint should be false`);
    assert.equal(a.openWorldHint, false, `${name}: openWorldHint should be false`);
  }
});

// ── The generated allow rules ──────────────────────────────────────────

test('the allow list pre-approves the reads and nothing else', () => {
  const { allow } = connectorPermissionSettings().permissions;

  assert.deepEqual(allow, READ_ONLY_TOOLS.map((t) => `${PERMISSION_RULE_PREFIX}${t}`));

  for (const tool of ACTING_TOOLS) {
    assert.ok(
      !allow.some((rule) => rule.endsWith(`__${tool}`)),
      `${tool} acts on the user's behalf and must keep prompting — it is in the allow list`,
    );
  }

  // No globs. A `mcp__Usernode__get_*` rule would silently widen the moment
  // a tool is added whose name happens to match it.
  for (const rule of allow) {
    assert.ok(!/[*?]/.test(rule), `${rule} contains a wildcard; enumerate the tools instead`);
    assert.ok(rule.startsWith(PERMISSION_RULE_PREFIX), `${rule} does not carry the rule prefix`);
  }
});

test('the settings JSON is the object, formatted, with a trailing newline', () => {
  const json = connectorPermissionSettingsJson();
  assert.equal(json, `${JSON.stringify(connectorPermissionSettings(), null, 2)}\n`);
  assert.deepEqual(JSON.parse(json), connectorPermissionSettings());
});

// ── The three copies of that file ──────────────────────────────────────

test('the app scaffold ships the settings file, generated rather than pasted', () => {
  const files = getTemplateFiles('My App', 'my-app-abc123', 'postgres://x', 'secret');
  const entry = files.find((f) => f.path === SETTINGS_PATH);
  assert.ok(entry, `the scaffold does not include ${SETTINGS_PATH}`);
  assert.equal(entry.content, connectorPermissionSettingsJson());

  // It has to survive the container build the scaffold also ships.
  const dockerignore = files.find((f) => f.path === '.dockerignore');
  assert.ok(dockerignore && /^\.claude$/m.test(dockerignore.content));
});

test('this repository holds the same file, and holds it committed', () => {
  assert.equal(read(SETTINGS_PATH), connectorPermissionSettingsJson());

  let ignored = false;
  try {
    execFileSync('git', ['check-ignore', '-q', SETTINGS_PATH], { cwd: ROOT, stdio: 'ignore' });
    ignored = true;
  } catch {
    // exit 1 = not ignored, which is what we want. Any other failure (no
    // git, no work tree) leaves `ignored` false and the assertion passes,
    // which is the right way round: this is a guard, not a dependency.
  }
  assert.ok(
    !ignored,
    `${SETTINGS_PATH} is gitignored, so nobody who clones this repo gets the rules. Only the `
    + '.local sibling belongs in .gitignore.',
  );
});

test('the docs quote the generated JSON verbatim, not a copy that can drift', () => {
  assert.ok(
    DOCS.includes(connectorPermissionSettingsJson().trimEnd()),
    `${DOCS_FILE} no longer contains the exact settings JSON the scaffold writes. Regenerate the `
    + 'block rather than hand-editing it — a doc that drifts hands users rules that match nothing.',
  );
  assert.ok(DOCS.includes(`\`${SERVER_NAME}\``), 'the docs must name the canonical server name');
  for (const tool of ACTING_TOOLS) {
    assert.ok(
      !DOCS.includes(`"${PERMISSION_RULE_PREFIX}${tool}"`),
      `${DOCS_FILE} shows a ready-to-paste allow rule for ${tool}, which must keep prompting`,
    );
  }
  // The promise the issue made explicit, in the doc a user actually reads.
  assert.match(DOCS, /client-side convenience only/i);
});

test('the docs are reachable at the path every surface points at', () => {
  assert.ok(SERVER_SRC.includes(`app.get('${DOCS_PATH}'`), `server.js does not serve ${DOCS_PATH}`);
  assert.ok(SERVER_SRC.includes(`'${DOCS_FILE}'`), 'the route must read the doc from the repo root');
  // whoami hands the same URL to the assistant.
  assert.ok(TOOLS_SRC.includes(`\${origin}${DOCS_PATH}`), `whoami's docsUrl must be ${DOCS_PATH}`);
});

// ── The boundary: convenience, not enforcement ─────────────────────────

test('the allow rules do not touch scope enforcement', () => {
  // Generating a settings file must not be able to see, let alone widen,
  // what a token may do. If this function ever consults scopes, the
  // "client-side convenience only" promise is gone.
  const src = connectorPermissionSettings.toString() + connectorPermissionSettingsJson.toString();
  for (const f of ['scope', 'token', 'canWrite', 'canRead']) {
    assert.ok(!src.includes(f), `the settings generator references ${f}; it must be inert`);
  }

  // And every tool still goes through the guard at call time.
  const guards = (TOOLS_SRC.match(/scopeGuard\(/g) || []).length;
  const toolCount = READ_ONLY_TOOLS.length + ACTING_TOOLS.length;
  assert.ok(
    guards >= toolCount,
    `only ${guards} scopeGuard call sites for ${toolCount} tools — a tool lost its scope check`,
  );
});

test('whoami reports the name and the rules it was generated from', () => {
  const whoami = registerAll().get('whoami');
  assert.ok(whoami.outputSchema.serverName, 'whoami must report the canonical name');
  assert.ok(whoami.outputSchema.permissions, 'whoami must report the permission block');
  // The description is what makes the payload useful: a model that sees a
  // user prompted on every call needs to know to show it.
  assert.match(whoami.description, /permissions/);
});
