// Wiring tests for the bulk container rollover surface — the admin route
// pair (src/routes/admin.js), the admin-console section
// (public/js/admin-console.js), the shell's WS routing (public/js/app.js)
// and the three small supporting additions it leans on (ws.js's
// admin-filtered broadcast, docker.js's imageExists, staging.js's exported
// per-slug lock).
//
// Text-pinning, in the style of tests/admin-console-page.test.js and
// tests/platform-env-admin.test.js: the route file and the SPA are too
// entangled with express and the DOM to instantiate here, but the
// properties that matter are all visible in the source and all cheap to
// break. The orchestrator's behaviour is covered separately in
// tests/app-rollover.test.js.
//
// What is pinned:
//  - starting a rollover requires a FULL admin and refuses while draining;
//    watching one only requires admin (the view-only split, issue #311);
//  - a second start is a 409 carrying the in-flight job, not a second sweep;
//  - the sweep is refused outright in a staging preview, and the demo job
//    that makes the screen reviewable there is gated on
//    IS_STAGING && ?demo=1 (never persisted, no-op in production);
//  - progress goes out on an ADMIN-only broadcast — the payload is an
//    inventory of every app on the box;
//  - the section is visible to view-only admins while its button is not;
//  - the supporting helpers are actually exported (a private helper would
//    make the route file throw at require time).
//
// Run with: node --test tests/admin-rollover-surface.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const adminRoutes = read('src/routes/admin.js');
const consoleJs = read('public/js/admin-console.js');
const appJs = read('public/js/app.js');
const wsJs = read('src/services/ws.js');
const dockerJs = read('src/services/docker.js');
const stagingJs = read('src/services/staging.js');
const eventsJs = read('src/services/events.js');
const rolloverJs = read('src/services/app-rollover.js');

// The POST handler's source, from its router line to the GET that follows.
function postHandler() {
  const start = adminRoutes.indexOf("router.post('/api/admin/rollover'");
  assert.ok(start > 0, 'POST /api/admin/rollover exists');
  const end = adminRoutes.indexOf("router.get('/api/admin/rollover'", start);
  assert.ok(end > start, 'GET /api/admin/rollover follows it');
  return adminRoutes.slice(start, end);
}

function getHandler() {
  const start = adminRoutes.indexOf("router.get('/api/admin/rollover'");
  assert.ok(start > 0, 'GET /api/admin/rollover exists');
  return adminRoutes.slice(start, start + 1400);
}

test('the rollover routes live on the admin router', () => {
  assert.match(adminRoutes, /router\.use\('\/api\/admin', adminMiddleware\)/,
    'the whole /api/admin prefix is admin-gated, so both routes inherit it');
  assert.match(adminRoutes, /require\('\.\.\/services\/app-rollover'\)/,
    'the route delegates to the orchestrator service rather than inlining it');
});

test('starting a rollover needs a full admin and refuses while draining', () => {
  const post = postHandler();
  assert.match(post, /requireAdminWrite/,
    'a view-only admin cannot start a fleet-wide container recreate');
  assert.match(post, /drainGuard/,
    'no kicking off docker work while the process is shutting down');
  assert.match(adminRoutes, /const \{ drainGuard \} = require\('\.\.\/services\/lifecycle'\)/);
});

test('watching a rollover does NOT require write access', () => {
  const get = getHandler();
  assert.ok(!/requireAdminWrite/.test(get),
    'view-only admins can watch a rollover — reads stay on the plain admin gate');
  assert.ok(!/drainGuard/.test(get), 'a status read is safe mid-drain');
});

test('a second start is a 409 carrying the in-flight job', () => {
  const post = postHandler();
  assert.match(post, /if \(!started\)/, 'the service reports whether it actually started');
  assert.match(post, /status\(409\)/);
  assert.match(post, /Rollover already in progress/);
  assert.match(post, /status\(202\)/, 'a real start is fire-and-forget: 202 + the job record');
});

test('the sweep is refused in a staging preview', () => {
  const post = postHandler();
  assert.match(post, /isStagingEnv\(\)/,
    'a preview has no production containers and no docker socket');
  assert.match(post, /status\(400\)/);
});

test('the demo job is gated on IS_STAGING && ?demo=1 and never persisted', () => {
  const get = getHandler();
  assert.match(get, /isStagingEnv\(\)\s*&&\s*req\.query\.demo === '1'/,
    'request-time demo injection per the Staging mock data convention');
  assert.match(get, /demoJob\(\)/);
  assert.match(consoleJs, /new URLSearchParams\(location\.search\)\.get\('demo'\) === '1' \? '\?demo=1' : ''/,
    "the page's ?demo=1 rides along on the status read, or the preview renders empty");
  // The demo job is a pure literal in the service — no INSERT anywhere.
  assert.ok(!/INSERT/i.test(rolloverJs),
    'the rollover service never writes rows; the demo job is read-only');
  assert.match(rolloverJs, /staging-demo-app-one/,
    'seeded rows carry the obviously-fake staging-demo prefix');
});

test('progress is broadcast to admins only', () => {
  assert.match(wsJs, /function broadcastToAdmins\(payload\)/);
  const fn = wsJs.slice(wsJs.indexOf('function broadcastToAdmins'));
  assert.match(fn.slice(0, 500), /client\.user && client\.user\.isAdmin/,
    'same isAdmin filter broadcastGlobalScoped applies for private apps');
  assert.match(wsJs, /module\.exports = \{[^}]*broadcastToAdmins/s,
    'exported, or the rollover service cannot reach it');

  assert.match(rolloverJs, /broadcastToAdmins/);
  assert.ok(!/broadcastGlobal\b/.test(rolloverJs),
    'the payload is an inventory of every app — it must not reach every client');
  assert.match(rolloverJs, /type: 'admin_rollover_status'/);
});

test('the shell routes the aggregate event into the console', () => {
  assert.match(appJs, /case 'admin_rollover_status':/,
    'the shell already holds the /ws/events socket the console needs');
  assert.match(appJs, /AdminConsole\.handleRolloverStatus\(data\)/);
  assert.match(appJs, /AdminConsole\?\.isOpen\?\.\(\) *\) *AdminConsole\.loadRollover/,
    'a dropped socket means missed transitions — resync refetches the job');
});

test('per-app progress rides the existing version-pill machinery', () => {
  assert.match(rolloverJs, /appDeployStatus\.markStart/,
    'markStart/markEnd are the only emitters of app_redeploy_status');
  assert.match(rolloverJs, /appDeployStatus\.markEnd/);
  assert.match(rolloverJs, /finally \{\s*\n\s*appDeployStatus\.markEnd/,
    'markEnd is in a finally so a throw cannot leave a pill spinning forever');
});

test('the console section exists, is admin-visible, and its button is write-gated', () => {
  assert.match(consoleJs, /\{ key: 'rollover', label: 'Container rollover' \}/,
    'a real section in the admin console nav');
  assert.match(consoleJs, /case 'rollover': return AdminConsole\.renderRolloverSection\(host\)/,
    'wired into the hash router');

  const section = consoleJs.slice(
    consoleJs.indexOf('renderRolloverSection(host)'),
    consoleJs.indexOf('async loadRollover()')
  );
  assert.ok(section.length > 200, 'the renderer has a body');
  assert.match(section, /const canWrite = AdminConsole\.canWrite\(\)/,
    'canWrite is derived from canAdminWrite — the view-only-admin split');
  assert.match(section, /\$\{canWrite \?/,
    'the start button is conditional on write access, the section itself is not');
  assert.match(section, /admin-rollover-list/, 'a host for the live per-app table');
});

test('the start button confirms before recreating anything', () => {
  const start = consoleJs.slice(
    consoleJs.indexOf('async _startRollover()'),
    consoleJs.indexOf('_paintRollover(job)')
  );
  assert.match(start, /AdminConsole\._confirm\(/, 'a fleet-wide recreate is not a one-tap action');
  assert.match(start, /_rolloverEligible/, 'the dialog names the actual app count');
  assert.match(start, /res\.status === 409/, 'a competing sweep is a toast, not an error dialog');
  assert.match(start, /method: 'POST'/);
});

test('the table renders one row per app with its outcome chip', () => {
  assert.match(consoleJs, /ROLLOVER_STATES: \{/);
  for (const state of [
    'pending', 'running', 'rolled', 'rebuilt',
    'skipped_deploying', 'skipped_missing_secrets', 'skipped_no_db_password',
    'skipped_deleted', 'failed',
  ]) {
    assert.match(consoleJs, new RegExp(`${state}:`),
      `the UI has a chip for the ${state} outcome the service can emit`);
    assert.match(rolloverJs, new RegExp(`'${state}'`),
      `the service actually emits ${state}`);
  }
  // The whole renderer, from its method head to the section marker that
  // follows it — a fixed-length slice would silently stop covering the
  // tail as the renderer grows.
  const paintStart = consoleJs.indexOf('_paintRollover(job) {');
  const paint = consoleJs.slice(paintStart, consoleJs.indexOf('// ── Overview', paintStart));
  assert.ok(paint.length > 500, 'the paint renderer has a body');
  assert.match(paint, /data-rollover-slug/,
    'rows are addressable for a future browser check');
  assert.match(paint, /esc\(app\.slug\)/,
    'every interpolation goes through the escaper');
  assert.match(paint, /_rolloverDemo/,
    'a preview says so and disables the button — the POST is refused there');
});

test('the supporting helpers are exported', () => {
  assert.match(dockerJs, /async function imageExists\(tag\)/);
  assert.match(dockerJs, /module\.exports = \{[^}]*imageExists/s);
  assert.match(stagingJs, /module\.exports = \{[\s\S]*?serializeRebuild,/,
    'the rollover has to take the same per-slug lock as a rebuild');
  assert.match(eventsJs, /CONTAINERS_ROLLED_OVER: 'containers_rolled_over'/);
  assert.match(rolloverJs, /EVENT_TYPES\.CONTAINERS_ROLLED_OVER/,
    'the in-memory job has exactly one durable trace');
});

test('the rollover never touches apps.status or main_sha on the respawn path', () => {
  // The env-only property: reusing the existing image means a rollover
  // cannot ship code, and flipping apps.status would drop the app's URL
  // from the home tile (see app-deploy-status.js).
  const respawnUpdate = rolloverJs.slice(
    rolloverJs.indexOf("'UPDATE apps SET container_id = $1, last_deploy_at = NOW()")
  ).slice(0, 200);
  assert.ok(respawnUpdate.length > 50, 'the respawn path persists container_id + last_deploy_at');
  assert.ok(!/status\s*=\s*'running'/.test(respawnUpdate));
  assert.ok(!/main_sha/.test(respawnUpdate));
});
