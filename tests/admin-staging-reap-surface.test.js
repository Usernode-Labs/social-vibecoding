// Wiring tests for the stale-staging-preview sweep surface — the admin route
// pair (src/routes/admin.js), the admin-console section
// (public/js/admin-console.js), the shell's WS routing (public/js/app.js) and
// the analytics event type it records.
//
// Text-pinning, in the style of tests/admin-rollover-surface.test.js (whose
// section this one deliberately mirrors): the route file and the SPA are too
// entangled with express and the DOM to instantiate here, but the properties
// that matter are all visible in the source and all cheap to break. The
// orchestrator's behaviour is covered separately in
// tests/staging-reap.test.js.
//
// What is pinned:
//  - starting a sweep requires a FULL admin and refuses while draining;
//    watching one only requires admin (the view-only split, issue #311);
//  - a second start is a 409 carrying the in-flight job, not a second sweep;
//  - the sweep is refused outright in a staging preview, and the demo job
//    that makes the screen reviewable there is gated on
//    IS_STAGING && ?demo=1 (never persisted, no-op in production);
//  - progress goes out on an ADMIN-only broadcast — the payload is an
//    inventory of every preview on the box;
//  - the section is visible to view-only admins while its button is not;
//  - the sweep TEARS DOWN and never rebuilds inline — the rebuild belongs to
//    the existing on-demand ensure-staging path, which is the whole reason
//    tearing down is safe;
//  - the enumeration starts from docker, not from
//    chat_sessions.staging_container_id, which finds only part of the fleet.
//
// Run with: node --test tests/admin-staging-reap-surface.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const adminRoutes = read('src/routes/admin.js');
const consoleJs = read('public/js/admin-console.js');
const appJs = read('public/js/app.js');
const eventsJs = read('src/services/events.js');
const reapJs = read('src/services/staging-reap.js');

// The POST handler's source, from its router line to the GET that follows.
function postHandler() {
  const start = adminRoutes.indexOf("router.post('/api/admin/staging-reap'");
  assert.ok(start > 0, 'POST /api/admin/staging-reap exists');
  const end = adminRoutes.indexOf("router.get('/api/admin/staging-reap'", start);
  assert.ok(end > start, 'GET /api/admin/staging-reap follows it');
  return adminRoutes.slice(start, end);
}

function getHandler() {
  const start = adminRoutes.indexOf("router.get('/api/admin/staging-reap'");
  assert.ok(start > 0, 'GET /api/admin/staging-reap exists');
  return adminRoutes.slice(start, start + 1400);
}

test('the sweep routes live on the admin router', () => {
  assert.match(adminRoutes, /router\.use\('\/api\/admin', adminMiddleware\)/,
    'the whole /api/admin prefix is admin-gated, so both routes inherit it');
  assert.match(adminRoutes, /require\('\.\.\/services\/staging-reap'\)/,
    'the route delegates to the orchestrator service rather than inlining it');
});

test('starting a sweep needs a full admin and refuses while draining', () => {
  const post = postHandler();
  assert.match(post, /requireAdminWrite/,
    'a view-only admin cannot tear down every preview on the box');
  assert.match(post, /drainGuard/,
    'no kicking off docker work while the process is shutting down');
});

test('watching a sweep does NOT require write access', () => {
  const get = getHandler();
  assert.ok(!/requireAdminWrite/.test(get),
    'view-only admins can watch a sweep — reads stay on the plain admin gate');
  assert.ok(!/drainGuard/.test(get), 'a status read is safe mid-drain');
});

test('a second start is a 409 carrying the in-flight job', () => {
  const post = postHandler();
  assert.match(post, /if \(!started\)/, 'the service reports whether it actually started');
  assert.match(post, /status\(409\)/);
  assert.match(post, /Sweep already in progress/);
  assert.match(post, /status\(202\)/, 'a real start is fire-and-forget: 202 + the job record');
});

test('the sweep is refused in a staging preview', () => {
  const post = postHandler();
  assert.match(post, /isStagingEnv\(\)/,
    'a preview has no docker socket, so it cannot manage other previews');
  assert.match(post, /status\(400\)/);
});

test('the demo job is gated on IS_STAGING && ?demo=1 and never persisted', () => {
  const get = getHandler();
  assert.match(get, /staging && req\.query\.demo === '1'/,
    'request-time demo injection, per the Staging mock data convention');
  assert.match(get, /demoJob\(\)/);
  assert.match(get, /demo: true/, 'the client needs to know it is looking at fixtures');
  // The demo job is a literal, not a DB write — nothing in the service
  // persists it.
  assert.ok(!/INSERT|UPDATE/i.test(reapJs),
    'the sweep never writes rows of its own — teardownStaging owns the DB side');
});

test('progress goes out on an admin-only broadcast', () => {
  assert.match(reapJs, /broadcastToAdmins/);
  assert.ok(!/broadcastGlobal\b/.test(reapJs),
    'the payload is an inventory of every preview — it must not reach every client');
  assert.match(reapJs, /type: 'admin_staging_reap_status'/);
});

test('the shell routes the aggregate event into the console', () => {
  assert.match(appJs, /case 'admin_staging_reap_status':/,
    'the shell already holds the /ws/events socket the console needs');
  assert.match(appJs, /AdminConsole\.handleStagingReapStatus\(data\)/);
  assert.match(appJs, /AdminConsole\?\.isOpen\?\.\(\) *\) *AdminConsole\.loadStagingReap/,
    'a dropped socket means missed transitions — resync refetches the job');
});

test('the console section exists, is admin-visible, and its button is write-gated', () => {
  assert.match(consoleJs, /\{ key: 'staging-reap', label: 'Stale previews' \}/,
    'a real section in the admin console nav');
  assert.match(
    consoleJs,
    /case 'staging-reap': return AdminConsole\.renderStalePreviewsSection\(host\)/,
    'wired into the hash router'
  );

  const section = consoleJs.slice(
    consoleJs.indexOf('renderStalePreviewsSection(host)'),
    consoleJs.indexOf('async loadStagingReap()')
  );
  assert.ok(section.length > 200, 'the renderer has a body');
  assert.match(section, /const canWrite = AdminConsole\.canWrite\(\)/,
    'canWrite is derived from canAdminWrite — the view-only-admin split');
  assert.match(section, /\$\{canWrite \?/,
    'the start button is conditional on write access, the section itself is not');
  assert.match(section, /admin-reap-list/, 'a host for the live per-preview table');
});

test('the console passes ?demo=1 through and disables the button on fixtures', () => {
  assert.match(consoleJs, /\/api\/admin\/staging-reap\$\{demoQS\}/,
    'the page-level ?demo=1 must ride along on the status read');
  assert.match(consoleJs, /_reapDemo/);
  assert.match(consoleJs, /'Unavailable in previews'/,
    'pressing the button in a preview would only earn a 400 — say so instead');
});

// The POST is refused in a preview with OR without ?demo=1, so the button
// must be gated on staging-ness rather than on the demo fixtures. Without
// this, a reviewer who opened the console WITHOUT ?demo=1 got a live-looking
// button that could only ever earn a 400.
test('the preview refusal is gated on staging, not just on ?demo=1', () => {
  const get = getHandler();
  assert.match(get, /staging = stagingReap\.isStagingEnv\(\)/,
    'the GET reports staging-ness independently of the demo branch');
  assert.match(get, /staging,/, 'and returns it on the non-demo path too');
  assert.match(consoleJs, /_reapStaging = !!data\.staging/);
  assert.match(consoleJs, /_reapStaging \|\| !!AdminConsole\._reapDemo/,
    'either flag disables the button');
});

// The confirmation text is load-bearing: teardown discards each preview's
// throwaway data and the rebuild re-runs that proposal's checks, so an admin
// must be told both before pressing.
test('the confirmation dialog states the two real consequences', () => {
  // Anchor on the DEFINITION, not the addEventListener call that precedes it.
  const start = consoleJs.indexOf('async _startStagingReap()');
  assert.ok(start > 0, '_startStagingReap is defined');
  const body = consoleJs.slice(start, start + 1800);
  assert.match(body, /_confirm\(/, 'destructive sweeps are confirmed, not one-click');
  assert.match(body, /rebuilt automatically/, 'nothing is permanently lost — say so');
  assert.match(body, /test data is discarded/i);
  assert.match(body, /automated checks/i);
});

test('the sweep tears down and leaves rebuilding to the on-demand path', () => {
  assert.match(reapJs, /staging\.teardownStaging\(/,
    'the shared chokepoint that also drops the DB and un-vouches the hostname');
  // Strip comments before checking for a rebuild CALL — the header
  // deliberately names rebuildSessionStaging in prose as the path that does
  // the rebuilding, which is exactly why tearing down is safe.
  const code = reapJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const fn of ['rebuildSessionStaging', 'buildAndDeployStaging', 'rebuildProduction']) {
    assert.ok(!new RegExp(`${fn}\\s*\\(`).test(code),
      `no inline ${fn} — 101 of 104 previews back merged or abandoned proposals`);
  }
  assert.match(reapJs, /ensure-staging/,
    'the header must name the path that rebuilds a preview someone wants');
});

// The bug that makes DB-first enumeration wrong: 15 of production's 109
// containers had no row naming them.
test('enumeration starts from docker, not from the sessions table', () => {
  assert.match(reapJs, /'ps', '-a'/, 'the container list is the only complete inventory');
  assert.match(reapJs, /name=\^\/usernode-staging-/);
  const listStart = reapJs.indexOf('async function listStagingContainers');
  const listEnd = reapJs.indexOf('async function classify');
  assert.ok(listStart > 0 && listEnd > listStart);
  assert.ok(!/staging_container_id/.test(reapJs.slice(listStart, listEnd)),
    'the inventory must not be filtered by a column that misses leaked containers');
});

test('the analytics event type is declared with the rollover-style comment', () => {
  assert.match(eventsJs, /STALE_PREVIEWS_REAPED: 'stale_previews_reaped'/);
  assert.match(reapJs, /EVENT_TYPES\.STALE_PREVIEWS_REAPED/,
    'the service records its own tally — the job record is in-memory only');
});
