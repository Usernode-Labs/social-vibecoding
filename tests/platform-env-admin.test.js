// Wiring tests for the Platform variables section of the admin console
// (src/routes/admin.js + public/js/admin-console.js + the schema and
// debug-access changes that back it).
//
// Text-pinning, in the style of tests/admin-console-page.test.js: the
// route file and the console SPA are too entangled with express and the
// DOM to instantiate here, but the properties that matter are all
// visible in the source and all cheap to break.
//
// What is pinned:
//  - reads are open to view-only admins, writes are not;
//  - every mutation takes the same advisory lock the rest of the console
//    uses, so two admins racing cannot interleave;
//  - the plaintext of a value is never logged, never in an event, and
//    never rendered for a private variable;
//  - the values table is staging:private AND on the debug-access deny
//    list — the two independent mechanisms that keep credentials out of
//    staging clones and out of the read-only prod debugger;
//  - the section is reachable at #admin/platform-env and has a rendered
//    check in dapp.json.
//
// Run with: node --test tests/platform-env-admin.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const adminJs = fs.readFileSync(path.join(root, 'src/routes/admin.js'), 'utf8');
const consoleJs = fs.readFileSync(path.join(root, 'public/js/admin-console.js'), 'utf8');
const schemaSql = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// Read as text rather than required: both modules pull in `pg`, and
// this file is otherwise dependency-free.
const debugAccessJs = fs.readFileSync(path.join(root, 'src/services/debug-access.js'), 'utf8');
const eventsJs = fs.readFileSync(path.join(root, 'src/services/events.js'), 'utf8');

// Slice one route handler out of admin.js by its registration line.
function route(method, pathExpr) {
  const marker = `router.${method}('${pathExpr}'`;
  const start = adminJs.indexOf(marker);
  assert.notStrictEqual(start, -1, `route not found: ${method.toUpperCase()} ${pathExpr}`);
  const end = adminJs.indexOf('\n  });', start);
  assert.notStrictEqual(end, -1, `could not find the end of ${method.toUpperCase()} ${pathExpr}`);
  return adminJs.slice(start, end);
}

// ── Route surface ─────────────────────────────────────────────────────

test('the three routes exist under /api/admin/platform-env', () => {
  route('get', '/api/admin/platform-env');
  route('put', '/api/admin/platform-env/:key');
  route('delete', '/api/admin/platform-env/:key');
});

test('reading is open to view-only admins; writing is not', () => {
  const read = route('get', '/api/admin/platform-env');
  assert.ok(!/requireAdminWrite/.test(read.slice(0, 120)),
    'the router-level adminMiddleware is the gate for reads — a view-only admin '
    + 'must still be able to see what the platform is configured with');
  for (const [method, expr] of [['put', '/api/admin/platform-env/:key'], ['delete', '/api/admin/platform-env/:key']]) {
    assert.match(route(method, expr).slice(0, 120), /requireAdminWrite/,
      `${method.toUpperCase()} must gate on write permission`);
  }
});

test('both mutations take the shared admin advisory lock inside a transaction', () => {
  for (const [method, expr] of [['put', '/api/admin/platform-env/:key'], ['delete', '/api/admin/platform-env/:key']]) {
    const src = route(method, expr);
    assert.match(src, /await client\.query\('BEGIN'\)/, `${method}: BEGIN`);
    assert.match(src, /pg_advisory_xact_lock\(\$1\)', \[ADMIN_MUTATION_LOCK\]/, `${method}: lock`);
    assert.match(src, /await client\.query\('COMMIT'\)/, `${method}: COMMIT`);
    assert.match(src, /ROLLBACK/, `${method}: rollback on failure`);
    assert.match(src, /client\.release\(\)/, `${method}: the connection is always returned`);
  }
});

test('an unwritable key is refused by both mutations, with a reason', () => {
  for (const [method, expr] of [['put', '/api/admin/platform-env/:key'], ['delete', '/api/admin/platform-env/:key']]) {
    const src = route(method, expr);
    assert.match(src, /platformEnv\.isWritableKey\(key\)/, `${method}: checks the key`);
    assert.match(src, /cannot be edited here/, `${method}: says why, rather than a bare 400`);
  }
});

test('value validation is delegated to the DAO so the two cannot disagree', () => {
  const src = route('put', '/api/admin/platform-env/:key');
  assert.match(src, /platformEnv\.validateValue\(value\)/);
});

test('the value is never logged and never lands in an event', () => {
  for (const [method, expr] of [['put', '/api/admin/platform-env/:key'], ['delete', '/api/admin/platform-env/:key']]) {
    const src = route(method, expr);
    const logsAndEvents = [...src.matchAll(/log\.(info|warn|error)\([^;]*;|events\.record\([^;]*;/g)]
      .map((m) => m[0]).join('\n');
    assert.ok(!/\bvalue\b/.test(logsAndEvents),
      `${method}: no log line or event may carry the value — only the key and who changed it`);
    assert.match(logsAndEvents, /key/, `${method}: the key IS recorded`);
  }
});

test('the change is auditable through the existing events pipeline', () => {
  assert.match(eventsJs, /PLATFORM_ENV_CHANGED: 'platform_env_changed'/);
  assert.match(route('put', '/api/admin/platform-env/:key'), /action: 'set'/);
  assert.match(route('delete', '/api/admin/platform-env/:key'), /action: 'clear'/);
});

// ── Storage guarantees ────────────────────────────────────────────────

test('the values table is staging:private and the declarations table is not', () => {
  assert.match(schemaSql, /COMMENT ON TABLE platform_env_values IS 'staging:private'/,
    'a staging clone must get the schema and none of the values');
  const declBlock = schemaSql.slice(schemaSql.indexOf('CREATE TABLE IF NOT EXISTS platform_env_declarations'));
  assert.ok(!/COMMENT ON TABLE platform_env_declarations IS 'staging:private'/.test(declBlock),
    'declarations are a cache of the committed manifest — public by construction');
});

test('the values table is on the read-only debugger deny list', () => {
  const denied = debugAccessJs.slice(
    debugAccessJs.indexOf('DENIED_TABLES'),
    debugAccessJs.indexOf(']);', debugAccessJs.indexOf('DENIED_TABLES'))
  );
  assert.match(denied, /'platform_env_values'/,
    'the prod debug grant must never be able to read the AES blobs');
  assert.ok(!/'platform_env_declarations'/.test(denied),
    'declarations are useful for debugging and carry nothing sensitive');
});

test('the session columns are additive and separate from check_state', () => {
  assert.match(schemaSql, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS platform_env_state TEXT/);
  assert.match(schemaSql, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS platform_env_detail JSONB/);
});

// ── Console SPA ───────────────────────────────────────────────────────

test('the section is listed in the console menu', () => {
  assert.match(consoleJs, /key: 'platform-env', label: 'Platform variables'/);
  assert.match(consoleJs, /case 'platform-env': return AdminConsole\.renderPlatformEnvSection\(host\)/);
});

test('the panel renders the anchors the rendered check targets', () => {
  assert.match(consoleJs, /id="admin-platform-env-panel"/);
  assert.match(consoleJs, /id="admin-platform-env-list"/);
});

test('the section says a change takes effect on the next deploy', () => {
  const section = consoleJs.slice(consoleJs.indexOf('  renderPlatformEnvSection(host) {'));
  assert.match(section.slice(0, 2500), /does not take effect immediately/,
    'the single most surprising thing about this screen — a value set here is '
    + 'inert until the next deploy — has to be on the screen itself');
});

test('a private value is never rendered, and its editor never pre-fills', () => {
  const row = consoleJs.slice(consoleJs.indexOf('_platformEnvRow('));
  assert.match(row.slice(0, 4000), /never displayed/,
    'a private row shows a placeholder, not a value');
});

test('write controls gate on canWrite, page visibility does not', () => {
  const section = consoleJs.slice(consoleJs.indexOf('  renderPlatformEnvSection(host) {'),
    consoleJs.indexOf('  renderDbExportSection(host) {'));
  assert.match(section, /canWrite/, 'the row builder takes the write flag');
  assert.ok(/403/.test(section), 'a read that is refused is reported, not rendered blank');
});

test('the groups nobody can edit sink to the bottom of the list', () => {
  const load = consoleJs.slice(consoleJs.indexOf('loadPlatformEnv'));
  assert.match(load.slice(0, 3000), /groups\.sort\(\(a, b\) => rank\(a\) - rank\(b\)\)/,
    'the API sorts groups alphabetically, which puts the read-only '
    + '"Managed by the deploy" block above every variable an admin can act on');
});

test('a late-arriving fetch does not paint over another section', () => {
  const load = consoleJs.slice(consoleJs.indexOf('loadPlatformEnv'));
  assert.match(load.slice(0, 1200), /AdminConsole\._section !== 'platform-env'/,
    'the same guard the other sections use — clicking away mid-fetch must not repaint');
});

// ── The rendered check ────────────────────────────────────────────────

test('dapp.json has a rendered check for the section, inside the parse cap', () => {
  const appManifest = require('../src/services/app-manifest');
  const parsed = appManifest.read(root);
  const entry = parsed.tests.find((t) => t.path === '/#admin/platform-env');
  assert.ok(entry,
    'the check must survive app-manifest\'s MAX_TESTS cap — put it near the top of the array');
  assert.match(entry.expectSelector, /#admin-platform-env-panel/);
  assert.match(entry.expectSelector, /#admin-platform-env-list/);

  // And the raw array must agree with what the reader kept.
  const raw = manifest.tests.find((t) => t.path === '/#admin/platform-env');
  assert.equal(raw.expectSelector, entry.expectSelector);
});
