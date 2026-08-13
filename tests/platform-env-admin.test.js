// Wiring tests for the Platform variables surface — the platform app's own
// secrets panel (src/routes/apps.js + public/js/app-secrets.js + the schema
// and debug-access rules that back it).
//
// #826 shipped this as its own admin-console section; it was folded into the
// app-secrets panel so the platform's environment has ONE screen instead of
// two (the other one being an inert list of GitHub-injected credentials with
// buttons that only ever errored). These tests moved with it: the surface
// changed, the properties that matter did not.
//
// Text-pinning, in the style of tests/admin-console-page.test.js: the route
// file and the SPA are too entangled with express and the DOM to instantiate
// here, but the properties that matter are all visible in the source and all
// cheap to break.
//
// What is pinned:
//  - all three secrets routes branch on self_hosted onto the platform-env
//    DAO, so a write to the platform's env can never land in app_secrets
//    (where the platform would never read it) and vice versa;
//  - reads are open to view-only admins, writes are not;
//  - every mutation takes the same advisory lock the admin console uses, so
//    two admins racing cannot interleave a read-modify-write;
//  - the plaintext of a value is never logged, never in an event, never
//    returned for a private variable, and never returned at all to a
//    non-admin;
//  - an unwritable (deploy-owned) key is refused by both mutations;
//  - the values table is staging:private AND on the debug-access deny list —
//    the two independent mechanisms that keep credentials out of staging
//    clones and out of the read-only prod debugger;
//  - the deleted admin-console section stays deleted (nav entry, router
//    case, and the three /api/admin/platform-env routes).
//
// Run with: node --test tests/platform-env-admin.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appsJs = fs.readFileSync(path.join(root, 'src/routes/apps.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'src/routes/admin.js'), 'utf8');
const consoleJs = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-console.js'), 'utf8');
const secretsJs = fs.readFileSync(path.join(root, 'frontend/src/features/dialogs/app-secrets-controller.js'), 'utf8');
const schemaSql = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// Read as text rather than required: both modules pull in `pg`, and this
// file is otherwise dependency-free.
const debugAccessJs = fs.readFileSync(path.join(root, 'src/services/debug-access.js'), 'utf8');
const eventsJs = fs.readFileSync(path.join(root, 'src/services/events.js'), 'utf8');

// Slice one route handler out of apps.js by its registration line.
function route(method, pathExpr) {
  const marker = `router.${method}('${pathExpr}'`;
  const start = appsJs.indexOf(marker);
  assert.notStrictEqual(start, -1, `route not found: ${method.toUpperCase()} ${pathExpr}`);
  const end = appsJs.indexOf('\n  });', start);
  assert.notStrictEqual(end, -1, `could not find the end of ${method.toUpperCase()} ${pathExpr}`);
  return appsJs.slice(start, end);
}

// Slice one named helper function out of apps.js.
function helper(name) {
  const marker = `async function ${name}(`;
  const start = appsJs.indexOf(marker);
  assert.notStrictEqual(start, -1, `helper not found: ${name}`);
  const end = appsJs.indexOf('\n  }\n', start);
  assert.notStrictEqual(end, -1, `could not find the end of ${name}`);
  return appsJs.slice(start, end);
}

const WRITE_HELPERS = ['setPlatformVariable', 'clearPlatformVariable'];

// ── Route surface ─────────────────────────────────────────────────────

test('the platform surface is the app-scoped secrets routes, not its own', () => {
  route('get', '/api/apps/:slug/secrets');
  route('put', '/api/apps/:slug/secrets/:key');
  route('delete', '/api/apps/:slug/secrets/:key');

  assert.ok(!/\/api\/admin\/platform-env/.test(adminJs),
    'the admin-console routes were folded into the app-scoped ones — a second '
    + 'write path is exactly the duplication this change removed');
});

test('all three routes branch on self_hosted onto the platform-env DAO', () => {
  const get = route('get', '/api/apps/:slug/secrets');
  assert.match(get, /if \(app\.self_hosted\)/);
  assert.match(get, /platformEnv\.listView\(/,
    'the platform reads its declarations+values from platform_env_*, never app_secrets');
  assert.match(get, /appSecrets\.getRedactedView\(/,
    'and an ordinary app still takes the app_secrets path');

  assert.match(route('put', '/api/apps/:slug/secrets/:key'), /setPlatformVariable\(req, res, app\)/);
  assert.match(route('delete', '/api/apps/:slug/secrets/:key'), /clearPlatformVariable\(req, res, rows\[0\]\)/);
  assert.match(helper('setPlatformVariable'), /platformEnv\.setValue\(/);
  assert.match(helper('clearPlatformVariable'), /platformEnv\.deleteValue\(/);
});

test('the platform secrets routes are no longer a dead end', () => {
  // refuseIfSelfHosted survives for the deploy-shaped actions (/redeploy,
  // /check-updates) — those really don't apply to the self-app row — but it
  // must no longer stand in front of a secrets write.
  assert.match(appsJs, /function refuseIfSelfHosted\(app, res\)/);
  for (const [method, expr] of [
    ['put', '/api/apps/:slug/secrets/:key'],
    ['delete', '/api/apps/:slug/secrets/:key'],
  ]) {
    assert.ok(!/refuseIfSelfHosted/.test(route(method, expr)),
      `${method.toUpperCase()} must branch to the platform store rather than refuse`);
  }
  assert.match(route('post', '/api/apps/:slug/redeploy'), /refuseIfSelfHosted/,
    'the platform still deploys via GitHub Actions — /redeploy stays refused');
});

test('reading is open to view-only admins; writing is not', () => {
  const read = route('get', '/api/apps/:slug/secrets');
  assert.ok(!/canAdminWrite/.test(read),
    'a view-only admin must still be able to see what the platform is configured with');
  for (const [method, expr] of [
    ['put', '/api/apps/:slug/secrets/:key'],
    ['delete', '/api/apps/:slug/secrets/:key'],
  ]) {
    assert.match(route(method, expr).slice(0, 260), /canAdminWrite/,
      `${method.toUpperCase()} must gate on write permission`);
  }
});

test('both mutations take the shared admin advisory lock inside a transaction', () => {
  for (const name of WRITE_HELPERS) {
    const src = helper(name);
    assert.match(src, /await client\.query\('BEGIN'\)/, `${name}: BEGIN`);
    assert.match(src, /pg_advisory_xact_lock\(\$1\)', \[ADMIN_MUTATION_LOCK\]/, `${name}: lock`);
    assert.match(src, /await client\.query\('COMMIT'\)/, `${name}: COMMIT`);
    assert.match(src, /ROLLBACK/, `${name}: rollback on failure`);
    assert.match(src, /client\.release\(\)/, `${name}: the connection is always returned`);
  }
});

test('the advisory lock id has one definition, shared by both callers', () => {
  const locks = fs.readFileSync(path.join(root, 'src/services/advisory-locks.js'), 'utf8');
  assert.match(locks, /ADMIN_MUTATION_LOCK = 991001/);
  for (const [file, src] of [['apps.js', appsJs], ['admin.js', adminJs]]) {
    assert.match(src, /require\('\.\.\/services\/advisory-locks'\)/,
      `${file} must import the id, not restate the literal — two copies is how they drift apart`);
    assert.ok(!/991001/.test(src),
      `${file} must not carry its own copy of the number`);
  }
});

test('an unwritable key is refused by both mutations, with a reason', () => {
  for (const name of WRITE_HELPERS) {
    const src = helper(name);
    assert.match(src, /platformEnv\.isWritableKey\(key\)/, `${name}: checks the key`);
    assert.match(src, /UNWRITABLE_MESSAGE/, `${name}: says why, rather than a bare 400`);
  }
  assert.match(appsJs, /cannot be edited here/,
    'the shared message names the reason: the deploy owns this value');
});

test('value validation is delegated to the DAO so the two cannot disagree', () => {
  assert.match(helper('setPlatformVariable'), /platformEnv\.validateValue\(value\)/);
});

test('the value is never logged and never lands in an event', () => {
  for (const name of WRITE_HELPERS) {
    const src = helper(name);
    const logsAndEvents = [...src.matchAll(/log\.(info|warn|error)\([^;]*;|events\.record\([^;]*;/g)]
      .map((m) => m[0]).join('\n');
    assert.ok(!/\bvalue\b/.test(logsAndEvents),
      `${name}: no log line or event may carry the value — only the key and who changed it`);
    assert.match(logsAndEvents, /key/, `${name}: the key IS recorded`);
  }
});

test('the change is auditable through the existing events pipeline', () => {
  assert.match(eventsJs, /PLATFORM_ENV_CHANGED: 'platform_env_changed'/);
  assert.match(helper('setPlatformVariable'), /action: 'set'/);
  assert.match(helper('clearPlatformVariable'), /action: 'clear'/);
});

// ── What the GET returns ──────────────────────────────────────────────

test('non-private values reach admins; nothing reaches a non-admin', () => {
  const get = route('get', '/api/apps/:slug/secrets');
  assert.match(get, /const includeValues = !!req\.user\?\.isAdmin/);
  assert.match(get, /includeValues \? config\.dataEncryptionKey : null/,
    'a non-admin request must not even hand listView the key to decrypt with');

  const view = appsJs.slice(appsJs.indexOf('function platformSecretsView('));
  assert.match(view.slice(0, 2500), /value: includeValues \? r\.value : null/);
  assert.match(view.slice(0, 2500), /valueLast4: includeValues && !r\.private \? r\.valueLast4 : null/,
    'a private row keeps no last-4 anywhere — 4 characters of a token is still 4 characters of a token');
});

test('credential rows are merged in as read-only, never editable', () => {
  const view = appsJs.slice(appsJs.indexOf('function platformSecretsView(')).slice(0, 4000);
  assert.match(view, /for \(const entry of \(manifest\.secrets \|\| \[\]\)\)/,
    'the `secrets` block is rendered in the same panel so one screen covers the whole env');
  assert.match(view, /unwritable: true/);
  assert.match(view, /state: 'managed'/);
  assert.match(view, /hasValue: !!process\.env\[entry\.key\]/,
    'for a GitHub-injected credential process.env IS where the value lives');
  assert.ok(!/value: [^n]/.test(view.slice(view.indexOf('for (const entry of'))),
    'and no ciphertext or plaintext is ever attached to such a row');
});

test('the response tells the client which semantics apply', () => {
  const get = route('get', '/api/apps/:slug/secrets');
  assert.match(get, /scope: app\.self_hosted \? 'platform' : 'app'/);
  assert.match(get, /redeployable: !app\.self_hosted/,
    'the "redeploy now" footer hits an endpoint refuseIfSelfHosted still rejects');
});

test('the self-app tile counts only what the panel can actually fix', () => {
  // `secrets`-block credentials are required:true and unsettable, so counting
  // them would badge the platform with a permanent, unfixable warning.
  assert.match(appsJs, /platformEnv\.missingRequired\(pool, a\.id\)/);
  assert.match(appsJs, /platformEnv\.missingRequired\(pool, appRow\.id\)/);
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

// ── The admin-console section is gone ─────────────────────────────────

test('the console no longer carries a Platform variables section', () => {
  assert.ok(!/key: 'platform-env'/.test(consoleJs), 'no nav entry');
  assert.ok(!/case 'platform-env'/.test(consoleJs), 'no router case');
  assert.ok(!/renderPlatformEnvSection/.test(consoleJs), 'no render function');
  // A stale #admin/platform-env hash falls through to the default section
  // because open() validates the requested key against the visible
  // SECTIONS list (#860 renamed the local, same check).
  assert.match(consoleJs, /const valid = visible\.some\(\(s\) => s\.key === section\)/,
    'that fallthrough is what makes an old bookmark harmless');
  assert.match(consoleJs, /_visibleSections\(\)/,
    'and the visible list is derived from SECTIONS');
});

// ── Panel UI ──────────────────────────────────────────────────────────

test('the panel says a change takes effect on the next deploy', () => {
  assert.match(secretsJs, /applied by the platform.{1,2}s next deploy/,
    'the single most surprising thing about this screen — a value set here is '
    + 'inert until the next deploy — has to be on the screen itself');
});

test('a private value is never rendered', () => {
  assert.match(secretsJs, /never displayed/,
    'a private row shows a placeholder, not a value');
});

test('an unwritable row offers neither a direct nor a propose button', () => {
  // The action branch grew a third case (a 'proposed' row links to its
  // declaration proposal), so this is the if/else form rather than the
  // original ternary — the invariant it protects is unchanged: an
  // unwritable row resolves to the empty string, i.e. no controls at all.
  const row = secretsJs.slice(secretsJs.indexOf('renderRow(s, canWrite) {'));
  assert.match(row.slice(0, 8000), /else if \(s\.unwritable\) \{\s*\n\s*actions = '';/,
    'both button groups are suppressed — a vote that cannot be honoured is '
    + 'worse than no button at all');
  assert.match(secretsJs, /can't be edited here/,
    'and the row says why');
});

test('the footer shortcut is hidden where it could only 403', () => {
  assert.match(secretsJs, /data\.redeployable !== false/);
});

test('the four row states all have a badge', () => {
  const badges = secretsJs.slice(secretsJs.indexOf('STATE_BADGES:'), secretsJs.indexOf('render(data) {'));
  for (const state of ['set', 'unset', 'managed', 'orphan']) {
    assert.match(badges, new RegExp(`\\b${state}:`), `missing badge for ${state}`);
  }
});

// ── The rendered check ────────────────────────────────────────────────

test('dapp.json has a rendered check for the panel, and the reader keeps it', () => {
  // Position no longer matters (#1019 removed the parse cap and every
  // declared check runs), but being KEPT still does: the reader silently
  // drops a malformed entry, and the manifest silently sheds anything past
  // MAX_DECLARED_TESTS. Both are invisible from the manifest alone.
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(manifest);
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'checks past the ceiling never run');
  const entries = meta.tests.filter((t) => /shot=secrets/.test(t.path));
  assert.ok(entries.length >= 1,
    'the check must survive the manifest reader — a dropped check gates nothing');
  // Deliberately NOT scoped under `#app-secrets-modal`: PlatformUI adopts the
  // modal into the native kit, which reparents the list out of that wrapper,
  // so a descendant selector matches nothing in a real browser. The list
  // carries rows only once the panel has rendered, which is the discriminator.
  assert.match(entries[0].expectSelector, /#app-secrets-list code/);

  // And the raw array must agree with what the reader kept.
  const raw = manifest.tests.filter((t) => /shot=secrets/.test(t.path));
  assert.equal(raw[0].expectSelector, entries[0].expectSelector);

  assert.ok(!manifest.tests.some((t) => t.path === '/#admin/platform-env'),
    'the check for the deleted console section must go with it');
});

test('the panel is reachable from a URL so captures and checks can see it', () => {
  const appViewJs = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');
  assert.match(appViewJs, /shot === 'secrets' \|\| shot === 'secrets-new'/,
    'the panel is a modal — without a deep link the before/after screenshots '
    + 'would show the home feed instead of the changed screen');
  // `secrets-new` additionally expands the "New variable" form, which is a
  // SECOND layer of interaction (a click inside a modal) that neither the
  // capture pipeline nor a dapp.json test can reach on its own.
  assert.match(appViewJs, /Secrets\.open\(slug, \{ declare: shot === 'secrets-new' \}\)/);
});
