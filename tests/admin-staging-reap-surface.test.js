// Wiring tests for the stale-staging-preview sweep surface — the admin route
// pair (src/routes/admin.js), the admin-console section
// (frontend/src/features/admin/admin-console.js), the shell's WS routing (public/js/app.js) and
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
const consoleJs = read('frontend/src/features/admin/admin-console.js');
// The section is a React module since #1120 slice 23; the console keeps the
// nav entry, the SECTION_MODULES mapping and the two WS forwarders app.js
// calls, so both files carry part of what this file pins.
const reapTsx = read('frontend/src/features/admin/admin-staging-reap.tsx');
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
  assert.match(consoleJs, /\{ key: 'staging-reap', label: 'Stale previews', group: '[^']+' \}/,
    'a real section in the admin console nav');
  // Dispatched as a delegated module rather than by a render*Section method
  // on the chassis (#1120 slice 23) — the `switch` those two arms lived in is
  // gone. What has to hold is that the key still resolves to a module the
  // island imports; losing either shows "module failed to load".
  assert.match(consoleJs, /'staging-reap': 'AdminStagingReap',/,
    'wired into the section dispatch');
  assert.ok(!/case 'staging-reap'/.test(consoleJs),
    'and not ALSO on the retired switch, which would be two dispatch paths');
  assert.match(read('frontend/src/features/admin/index.tsx'),
    /import '\.\/admin-staging-reap\.tsx';/, 'the console island imports the module');
  assert.match(reapTsx,
    /if \(typeof window !== 'undefined'\) \(window as any\)\.AdminStagingReap = AdminStagingReap;/,
    'and the module publishes the global the dispatcher looks up');

  assert.match(reapTsx, /const canWrite = !!console_\(\)\?\.canWrite\(\)/,
    'canWrite is derived from canAdminWrite — the view-only-admin split');
  assert.match(reapTsx, /\{canWrite \? \(/,
    'the start button is conditional on write access, the section itself is not');
  assert.match(reapTsx, /View-only admin — you can watch a sweep, but not start one\./,
    'and a view-only admin is told why the button is missing');
  assert.match(reapTsx, /id="admin-reap-list"/, 'a host for the live per-preview table');
});

// The section renders through React now, so the console no longer owns the
// markup — but public/js/app.js still calls two AdminConsole methods for this
// section, and that surface is the SHELL's. Losing a forwarder is silent: the
// socket frame arrives, nothing repaints, and the screen sits on a stale job.
test('the console keeps the WS surface app.js calls, forwarding to the module', () => {
  for (const [fwd, target] of [
    ['handleStagingReapStatus(data)', 'window.AdminStagingReap?.handleStatus?.(data);'],
    ['loadStagingReap()', 'window.AdminStagingReap?.reload?.();'],
  ]) {
    assert.ok(consoleJs.includes(fwd), `AdminConsole.${fwd} is where app.js looks for it`);
    assert.ok(consoleJs.includes(target), `${fwd} forwards to the module`);
  }
  assert.match(reapTsx, /handleStatus\(data: \{ job\?: ReapJob \| null \} \| null\) \{/);
  assert.match(reapTsx, /\n  reload\(\) \{ live\?\.reload\(\); \},/);
  // A frame that lands while the admin is on another section must be
  // dropped, not applied to an unmounted component — `live` is null exactly
  // then, which is what the old `_section === 'staging-reap'` guard meant.
  assert.match(reapTsx, /if \(!data \|\| !live\) return;/,
    'an unmounted section drops the frame; the next mount reads the GET');
  assert.match(reapTsx, /live = \{ paint:[\s\S]*?return \(\) => \{ live = null; \};/,
    'and the handle is set and cleared by an effect, so it tracks mounting');
});

test('the console passes ?demo=1 through and disables the button on fixtures', () => {
  assert.match(reapTsx,
    /const DEMO = typeof window !== 'undefined'\s*\n?\s*&& new URLSearchParams\(location\.search\)\.get\('demo'\) === '1'/,
    'the flag is read once, guarded — the SSG prerender evaluates this in Node');
  assert.match(reapTsx, /\/api\/admin\/staging-reap\$\{DEMO \? '\?demo=1' : ''\}/,
    'the page-level ?demo=1 must ride along on the status read');
  assert.match(reapTsx, /setDemo\(!!data\.demo\)/);
  assert.match(reapTsx, /'Unavailable in previews'/,
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
  assert.match(reapTsx, /setStaging\(!!data\.staging\)/);
  assert.match(reapTsx, /const preview = staging \|\| demo;/,
    'either flag disables the button');
  assert.match(reapTsx, /disabled=\{running \|\| preview \|\| runtimeUnavailable \|\| starting\}/,
    'and that is the whole disabled expression — no fifth, softer path to the POST');
});

// The confirmation text is load-bearing: teardown discards each preview's
// throwaway data and the rebuild re-runs that proposal's checks, so an admin
// must be told both before pressing.
test('the confirmation dialog states the two real consequences', () => {
  const start = reapTsx.indexOf('const start = useCallback');
  assert.ok(start > 0, 'the start handler is defined');
  const body = reapTsx.slice(start, reapTsx.indexOf('const running =', start));
  assert.ok(body.length > 500, 'the handler has a body');
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

// ── #851: the automatic pass and what the console shows about it ─────────
//
// The manual button is no longer the only remedy for a stale preview, so the
// surface has to answer two new questions an admin will actually ask: how many
// previews are out of date right now, and did the automatic sweep already
// handle it? Without the second, an admin has no way to tell a working
// background pass from a broken one and presses the fleet-wide button anyway.

// The whole GET handler body, from its router line to the section that
// follows. The 1400-char window the older helper uses is too small now.
function getHandlerFull() {
  const start = adminRoutes.indexOf("router.get('/api/admin/staging-reap'");
  assert.ok(start > 0);
  const end = adminRoutes.indexOf('── Users ──', start);
  assert.ok(end > start, 'the Users section follows the reap routes');
  return adminRoutes.slice(start, end);
}

test('the status read reports open vs out-of-date counts separately', () => {
  const get = getHandlerFull();
  // `open` is what the button would shut down; `stale` is what the automatic
  // pass acts on. Conflating them would either overstate the button's blast
  // radius or understate the staleness.
  assert.match(get, /open: counts\.open/);
  assert.match(get, /stale: counts\.stale/);
  assert.match(get, /previewCounts\(/,
    'both counts come from one docker call, not two');
});

test('the status read exposes the expected fingerprint and the automatic history', () => {
  const get = getHandlerFull();
  assert.match(get, /expectedFingerprint: stagingEnv\.expectedStagingFingerprint\(/,
    'an admin diagnosing "why is everything stale" needs the digest being compared');
  assert.match(get, /automatic: stagingReap\.readAutomatic\(\)/);
});

test('the demo payload covers the new tile and the automatic line', () => {
  const get = getHandlerFull();
  assert.match(get, /demoCounts\(\)/,
    'a preview has no docker socket, so the new fields need fixtures too');
  // And the fixture itself is obviously fake + complete, per the Staging mock
  // data convention. Read from source rather than requiring the service: this
  // suite is deliberately dependency-free (the service pulls in pg).
  const start = reapJs.indexOf('function demoCounts()');
  assert.ok(start > 0, 'demoCounts exists');
  const demo = reapJs.slice(start, reapJs.indexOf('\n}', start));
  assert.match(demo, /open: \d+/);
  assert.match(demo, /stale: \d+/);
  assert.match(demo, /expectedFingerprint: 'stagingdemo/,
    'obviously fake, per the seed rules');
  assert.match(demo, /lastRunAt: '20\d\d-/,
    'the "last ran" line has nothing to render without a timestamp');
  assert.match(demo, /intervalMs: \d+/);
  assert.match(demo, /tornDown: \d+/);
  // The demo values must be self-consistent or the screenshot is misleading.
  const open = Number(demo.match(/open: (\d+)/)[1]);
  const stale = Number(demo.match(/stale: (\d+)/)[1]);
  assert.ok(stale <= open, 'the stale subset cannot exceed the whole');
});

test('the automatic pass never writes session rows itself', () => {
  // Same invariant the admin sweep has: teardownStaging owns the DB side, so
  // the sweeper cannot null a column behind the chokepoint's back — which is
  // the whole cause of the leak this release fixes.
  assert.ok(!/INSERT|UPDATE/i.test(reapJs));
  assert.match(reapJs, /async function sweepStale/);
});

test('the automatic pass is selective, unlike the admin sweep', () => {
  // The admin sweep tears down everything it enumerates. An unattended pass
  // doing that on a timer would kill previews backing live votes.
  assert.match(reapJs, /VOTE_BACKED_STATUSES/);
  assert.match(reapJs, /function selectStale/);
  const selStart = reapJs.indexOf('function selectStale');
  const selEnd = reapJs.indexOf('async function staleCount');
  assert.ok(selStart > 0 && selEnd > selStart);
  const sel = reapJs.slice(selStart, selEnd);
  assert.match(sel, /fingerprint === expectedFp/, 'selection is by fingerprint');
  assert.match(sel, /isInFlight/, 'a session mid-turn is left alone');
});

test('the automatic pass records its tally distinguishably from an admin sweep', () => {
  assert.match(reapJs, /trigger: 'sweeper'/,
    'the events row must say which path reaped, or the tallies are unattributable');
});

test('the sweeper pass is wired into the existing session sweeper, throttled', () => {
  const serverJs = read('server.js');
  assert.match(serverJs, /stagingReap\.sweepStale\(/);
  // The cadence lives in the service so the boot run and the sweeper tick
  // cannot disagree about when a pass is due — and so server.js holds no
  // module-level timestamp that a load-order change could trip over.
  assert.match(serverJs, /stagingReap\.staleSweepDue\(\)/,
    'it runs on its own long interval, not on every 60s tick');
  assert.equal((serverJs.match(/stagingReap\.staleSweepDue\(\)/g) || []).length, 2,
    'both the boot run and the sweeper tick gate on the same helper');
  // It must hand the sweeper a way to see every live session-owned operation,
  // including CLI staging/check and sync tails that have no worker exec.
  assert.match(serverJs,
    /isInFlight: \(id\) => activeWorkersSvc\.isSessionBusy\(id\)/);
});

test('the pass also runs once at boot, after the heal recovery', () => {
  // A restart is when a platform env change has just landed, so the fleet is
  // most likely stale then. Ordering matters: recoverSessions rebuilds the
  // vote-backed previews first, so this only ever finds ones to tear down.
  const serverJs = read('server.js');
  const recover = serverJs.indexOf('recoverSessions(config).catch');
  const bootSweep = serverJs.indexOf('Boot stale-preview sweep failed');
  assert.ok(recover > 0 && bootSweep > recover,
    'the boot sweep must follow recoverSessions');
});

test('the console renders the out-of-date tile and the automatic-sweep line', () => {
  assert.match(reapTsx, /id="admin-reap-outdated"/);
  assert.match(reapTsx, /Out of date/);
  assert.match(reapTsx, /id="admin-reap-automatic"/);
  assert.match(reapTsx, /Automatic sweep last ran/);
  // The switched-off case must say so rather than render an empty line.
  assert.match(reapTsx, /automatic background sweep is switched off/);
  // …but before the first response there is nothing to say, and the
  // innerHTML version shipped that paragraph empty.
  assert.match(reapTsx, /if \(!loaded\) return '';/,
    'the line stays empty until the GET answers, as the static markup did');
});

test('the console counts the button\'s real blast radius, not the stale subset', () => {
  // The confirmation says "this shuts down N previews" — N must be every open
  // preview, since that is what the button does.
  const start = reapTsx.indexOf('const start = useCallback');
  assert.ok(start > 0, 'the handler definition, not the onClick reference');
  const body = reapTsx.slice(start, reapTsx.indexOf('const ok = await', start));
  assert.match(body, /typeof open === 'number'/,
    'confirming with the stale count would understate a fleet-wide action');
  assert.ok(!/outdated/.test(body),
    'and the out-of-date subset must not be what the dialog counts');
});

test('the leak event type is declared alongside the reap one', () => {
  assert.match(eventsJs, /STAGING_TEARDOWN_LEAKED: 'staging_teardown_leaked'/);
  const stagingJs = read('src/services/staging.js');
  assert.match(stagingJs, /EVENT_TYPES\.STAGING_TEARDOWN_LEAKED/,
    'the chokepoint records the leak — it is the only place that knows');
});
