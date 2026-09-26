'use strict';

// The Routes screen (#routes): the runs you recorded, kept privately for you.
//
// Four things can go wrong here, and this file is organised around them.
//
// 1. THE TWO DISTANCE IMPLEMENTATIONS CAN DRIFT. The recorder shows a total
//    that ticks up while you run (frontend/src/lib/geo.ts); the number that
//    is SAVED is computed server-side from the rows when the run finishes
//    (src/services/run-routes.js). Two implementations of one rule is
//    exactly the shape that rots, so the assertion below EXECUTES both
//    against one table of fixes rather than grepping either.
//
// 2. THE SCREEN CAN BREAK HYDRATION. It ships hidden and empty; a first
//    render that draws rows would mismatch the prerendered document, which
//    console.errors, which fails every proposal check on every route.
//
// 3. THE FEATURE CAN LEAK. A run is private by construction, and that is a
//    property of the SQL and the route rather than of the screen, so it is
//    asserted where it lives: every read names the viewer, and a run that is
//    not theirs answers a generic 404 rather than a 403.
//
// 4. THE SCREEN CAN BECOME UNREACHABLE. It is a platform screen behind the
//    Me tab's More list, so the router, the tab map, the back slot and the
//    three self-app hash-route lists all have to know about it. Each is
//    asserted against the source that has to agree.
//
// Run with: node --test tests/routes-screen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const appJs = read('public/js/app.js');
const routeSrc = read('src/routes/run-routes.js');
const svcSrc = read('src/services/run-routes.js');
const screenSrc = read('frontend/src/features/routes/index.tsx');
const mapSrc = read('frontend/@/components/ui/route-map.tsx');

// ── 1. One rule, two implementations ───────────────────────────────────

test('the client\'s live total and the server\'s saved distance are one rule', () => {
  // Both are TS/JS modules the repo's own bundler evaluates, so the
  // assertion runs the REAL pair rather than a re-spelling of either.
  const mod = loadTsx('frontend/src/lib/geo.ts');
  const server = require('../src/services/run-routes');

  // A trace with a good fix, a fix at 500 m of accuracy (stored, not summed),
  // a fix with no accuracy at all (counted), and one plain jump.
  const fixes = [
    { lat: 52.0000, lng: 4.0000, accuracy_m: 8 },
    { lat: 52.0005, lng: 4.0002, accuracy_m: 6 },
    { lat: 52.0010, lng: 4.0004, accuracy_m: 500 },
    { lat: 52.0015, lng: 4.0006, accuracy_m: null },
    { lat: 52.0019, lng: 4.0008, accuracy_m: 12 },
    { lat: 52.2000, lng: 4.4000, accuracy_m: 5 },
    { lat: 52.2004, lng: 4.4002, accuracy_m: 5 },
  ];
  const serverSum = server.summarize(fixes).distanceMeters;
  let clientSum = 0;
  let last = null;
  for (const fix of fixes) {
    if (mod.trustedFix(fix)) {
      clientSum += mod.routeStepMeters(last, fix);
      last = fix;
    }
  }
  assert.equal(Math.round(clientSum), serverSum,
    'the number you watch tick up is the number that gets saved');
  assert.ok(serverSum > 0, 'and it is not a zero the assertion would pass on trivially');

  // The filter itself, in both directions.
  assert.equal(mod.trustedFix({ lat: 1, lng: 1, accuracy_m: 500 }), false);
  assert.equal(mod.trustedFix({ lat: 1, lng: 1, accuracy_m: null }), true);
  assert.equal(server.trustedPoint({ lat: 1, lng: 1, accuracy_m: 500 }), false);
  assert.equal(server.trustedPoint({ lat: 1, lng: 1, accuracy_m: null }), true);
  assert.equal(mod.routeStepMeters(null, { lat: 1, lng: 1 }), 0);
  assert.equal(mod.routeStepMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 1 }), 0,
    'a jump past MAX_STEP_M is a reacquisition, not a step');
});

test('the two haversines agree to the metre', () => {
  const server = require('../src/services/run-routes');
  const a = { lat: 52.0907, lng: 4.3143 };
  const b = { lat: 52.1, lng: 4.32 };
  // About 1.1 km, which is the distance the two fixes are apart.
  assert.ok(Math.abs(server.haversineMeters(a, b) - 1105) < 20,
    `expected about 1105 m, got ${server.haversineMeters(a, b)}`);
});

test('a fix out of range is not a fix', () => {
  const server = require('../src/services/run-routes');
  assert.equal(server.usablePoint({ lat: 91, lng: 0 }), false);
  assert.equal(server.usablePoint({ lat: 0, lng: 181 }), false);
  assert.equal(server.usablePoint({ lat: NaN, lng: 0 }), false);
  assert.equal(server.usablePoint(null), false);
  assert.equal(server.usablePoint({ lat: 52, lng: 4 }), true);
});

// ── 2. The screen ships hidden and empty ───────────────────────────────

test('the first render is the shipped document: hidden, no rows', () => {
  const html = renderToHtml(createElement(loadTsx('frontend/src/features/routes/index.tsx').RoutesScreen));
  assert.match(html, /<main[^>]*id="routes-screen"[^>]*class="hidden/,
    'the root ships hidden, like every converted screen');
  assert.match(html, /id="routes-empty"[^>]*class="hidden/,
    'the empty card ships hidden too: a load in flight is not "you have no runs"');
  assert.ok(!/data-run-row=/.test(html), 'and no row is drawn before data arrives');
  assert.ok(!/data-run-detail=/.test(html), 'and no run page either');
  assert.match(html, /id="routes-record-btn"[^>]*data-routes-record="start"/,
    'the one primary action is Start run in the cold document');
  assert.match(html, /Only you can see your runs\./);
});

test('the screen root is React-owned through the visibility store', () => {
  assert.match(screenSrc, /useVisibilityHiddenClass\(screenRef, 'routes-screen', false\)/,
    'the island owns its own `hidden`');
  const reactIds = appJs.slice(appJs.indexOf('REACT_SCREEN_IDS: ['));
  assert.match(reactIds.slice(0, reactIds.indexOf('],')), /'routes-screen'/,
    'and app.js publishes it rather than toggling the class');
  const screenIds = appJs.slice(appJs.indexOf('  SCREEN_IDS: ['));
  assert.match(screenIds.slice(0, screenIds.indexOf('],')), /'routes-screen'/);
});

test('nothing is fetched during render', () => {
  // The load is the controller's, never the component's: a fetch in the
  // render pass is the hydration mismatch this screen has to avoid.
  const component = screenSrc.slice(screenSrc.indexOf('export function RoutesScreen'));
  const body = component.slice(0, component.indexOf('\n// ── The legacy seam'));
  assert.ok(!/fetch\(|await /.test(body),
    'the render pass draws state and nothing else');
  assert.match(screenSrc, /export const routesController = \{/);
  assert.match(screenSrc, /bridgeHost\.routes = routesController;/,
    'the classic router reaches the controller by name');
});

test('the words are the spec\'s, and there are no em dashes', () => {
  for (const phrase of [
    'Only you can see your runs.',
    'No runs yet',
    'Tap Start run to record your first one.',
    'Location is off, so this run will not be drawn on a map.',
    'Your runs',
  ]) {
    assert.ok(screenSrc.includes(phrase), `the screen says "${phrase}"`);
  }
  assert.match(screenSrc, /'Finish run' : 'Start run'/);
  // Comments are agent-facing and out of scope for the copy rule, so the
  // scan runs over code only — the same strip tests/theme-ink-guards uses.
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const userFacing = `${code(screenSrc)}\n${code(mapSrc)}`;
  assert.ok(!/—|&mdash;|&#8212;|\\u2014/.test(userFacing),
    'no em dash in any string a user reads');
});

test('the row\'s second line is distance and duration joined by the app\'s separator', () => {
  const mod = loadTsx('frontend/src/features/routes/index.tsx');
  assert.equal(mod.formatDistance(3200), '3.2 km');
  assert.equal(mod.formatDistance(12500), '13 km');
  assert.equal(mod.formatDistance(0), '0 km');
  assert.equal(mod.formatDuration(24 * 60), '24 min');
  assert.equal(mod.formatDuration(45), '45 sec');
  assert.equal(mod.formatDuration(65 * 60), '1 h 05 min');
  assert.equal(mod.rowSubtitle({
    id: 1, started_at: 'x', finished_at: 'y', duration_seconds: 1440,
    distance_meters: 3200, point_count: 40, has_location: true,
  }), '3.2 km · 24 min');
  assert.equal(mod.rowSubtitle({
    id: 1, started_at: 'x', finished_at: 'y', duration_seconds: 1440,
    distance_meters: 0, point_count: 0, has_location: false,
  }), '24 min · no location');
  // A fixture's own name is the only name a run has.
  assert.equal(mod.rowTitle({ label: 'Staging demo run 1' }), 'Staging demo run 1');
});

// ── 3. The feature is private by construction ──────────────────────────

test('every read and write is scoped to the signed-in viewer', () => {
  for (const fn of ['listFor', 'countFor', 'ownedRun', 'finishRun', 'deleteRun']) {
    const at = svcSrc.indexOf(`async function ${fn}(`);
    assert.ok(at > -1, `${fn} exists`);
    const body = svcSrc.slice(at, svcSrc.indexOf('\n}', at));
    assert.match(body, /user_id = \$2|user_id = \$1/,
      `${fn} names the viewer in its WHERE clause`);
  }
  // The route reads the viewer off the session and never off the request.
  assert.ok(!/req\.(body|query)\.(user_id|userId)/.test(routeSrc),
    'a caller cannot name whose runs to read');
  assert.match(routeSrc, /routes\.ownedRun\(pool, req\.user\.id, id\)/);
});

test('a run that is not yours answers the same 404 as one that is not there', () => {
  assert.match(routeSrc, /const NOT_FOUND = \{ error: 'Run not found' \};/);
  const refusals = routeSrc.match(/res\.status\(404\)\.json\(NOT_FOUND\)/g) || [];
  assert.ok(refusals.length >= 5,
    'every route refuses a row that is not the viewer\'s, and refuses it generically');
  assert.ok(!/status\(403\)/.test(routeSrc),
    'a 403 would confirm the row exists, which is the fact this feature may not disclose');
  assert.match(routeSrc, /router\.use\('\/api\/routes', privateJson\)/);
  assert.match(routeSrc, /Cache-Control', 'private, no-store'/);
});

test('the demo injection is read-only and a strict no-op outside staging', () => {
  assert.match(routeSrc, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging';/);
  assert.match(routeSrc, /return IS_STAGING && req\.query\.demo === '1';/);
  // Every demo branch RETURNS a fixture; none of them writes.
  const demoBranches = routeSrc.match(/if \(isDemo\(req\)\)[\s\S]*?\n\s*\}/g) || [];
  assert.ok(demoBranches.length >= 5, 'each route has its own demo branch');
  for (const branch of demoBranches) {
    assert.ok(!/pool\.query|createRun|appendPoints|finishRun|deleteRun/.test(branch),
      'a demo branch answers from the fixtures and writes nothing');
  }
  assert.match(svcSrc, /const DEMO_RUNS = Object\.freeze\(\[/);
  assert.match(svcSrc, /label: 'Staging demo run 1'/);
});

test('the two tables are private and the ids are derived, not handed in', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS run_routes \(/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS run_route_points \(/);
  assert.match(schema, /COMMENT ON TABLE run_routes IS 'staging:private';/);
  assert.match(schema, /COMMENT ON TABLE run_route_points IS 'staging:private';/);
  assert.match(schema, /UNIQUE \(route_id, seq\)/, 'a replayed batch is idempotent');
  // distance_meters and point_count come out of summarize(), never the body.
  assert.match(svcSrc, /const summary = summarize\(await pointsFor\(pool, id\)\);/);
  assert.ok(!/req\.body\.(distance|distance_meters|point_count)/.test(routeSrc));
});

test('the boot seeds fake runs, never the visitor\'s, and sweeps abandoned ones', () => {
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /await seedStagingRunRoutes\(pool\);/);
  assert.match(migrate, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/);
  assert.match(migrate, /const OWNER = 900001;/, 'the canonical fake identity, never req.user');
  assert.ok(!/req\.user/.test(migrate.slice(
    migrate.indexOf('async function seedStagingRunRoutes'), migrate.indexOf('async function sweepUnfinishedRunRoutes'))),
    'the seed never touches the signed-in viewer');
  assert.match(migrate, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(migrate, /await sweepUnfinishedRunRoutes\(pool\);/);
});

// ── 4. The screen is reachable, and the maps that say so agree ─────────

test('the router knows the address, and the tab map and back slot agree', () => {
  assert.match(appJs, /if \(parts\[0\] === 'routes'\) \{/);
  assert.match(appJs, /App\.navigateToRoutes\(parts\[1\] \? Number\(parts\[1\]\) : null\);/);
  assert.match(appJs, /case 'routes': return 'routes-screen';/);
  assert.match(appJs, /navigateToRoutes\(id\) \{/);
  assert.match(appJs, /_exitRoutes\(\) \{/);
  // The tab map and the back slot are derived from each other by
  // tests/header-back-home.test.js; both entries have to be there.
  assert.match(read('frontend/src/features/nav/nav-store.js'), /'routes-screen': 'me',/);
  const slots = appJs.slice(appJs.indexOf('_BACK_SLOT: {'));
  assert.match(slots.slice(0, slots.indexOf('\n  },')), /'routes-screen': \['arrow', '#profile'\]/);
  // And a Routes visit ends wherever another screen is revealed.
  assert.match(appJs, /if \(revealId !== 'routes-screen' && App\._inRoutes\) App\._exitRoutes\(\);/);
});

test('the address is a self-app hash route in all three lists that must agree', () => {
  assert.match(read('src/services/visuals.js'), /'apps', 'leaderboard', 'group-chat', 'individual-chat', 'create', 'admin', 'messages',\n  'routes',/);
  assert.match(read('public/js/app-view.js'), /_SELF_APP_HASH_ROUTES: \[[^\]]*'routes'\]/);
  assert.match(read('tests/dapp-selectors-resolve.test.js'), /'messages', 'routes',/);
});

test('the Me screen offers the way in', () => {
  const panel = read('frontend/src/features/profile/account-panel.tsx');
  assert.match(panel, /id="profile-row-routes"/);
  assert.match(panel, /href="#routes"/);
  assert.match(panel, /title="Routes"/);
});

test('the declared checks cover the list, a run\'s page, the degraded run and the empty state', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const routes = manifest.tests.filter((t) => /#routes/.test(t.path));
  assert.ok(routes.length >= 4, 'the change declares its own checks');
  const list = routes.find((t) => t.path === '/?demo=1#routes');
  assert.ok(list, 'the demo list is a declared check');
  assert.match(list.expectSelector, /#routes-screen:not\(\.hidden\)/);
  assert.match(list.expectSelector, /a\[data-run-row\]/);
  assert.match(list.expectText, /Staging demo run 1/);
  const detail = routes.find((t) => t.path === '/?demo=1#routes/900101');
  assert.ok(detail, 'a run is a real deep link');
  assert.match(detail.expectSelector, /data-run-detail="900101"/);
  const degraded = routes.find((t) => t.path === '/?demo=1#routes/900102');
  assert.ok(degraded, 'the run recorded with no location is reachable');
  assert.match(degraded.expectSelector, /data-route-map="empty"/);
  const empty = routes.find((t) => t.path === '/#routes' && /No runs yet/.test(t.expectText || ''));
  assert.ok(empty, 'and the UNSEEDED route asserts the production-shaped empty state');
  assert.match(empty.expectSelector, /#routes-empty:not\(\.hidden\)/);
  // The geolocation declaration is what puts the capability in the reviewed diff.
  assert.deepEqual(manifest.permissions, [
    { capability: 'geolocation', reason: 'Records the path of your runs' },
  ]);
});

test('the ownership audit sweeps the screen and the run page', () => {
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#routes-screen' \}/);
  assert.match(audit, /'#routes', '#routes\/900101'/);
});

test('the id inventory declares what the screen adds', () => {
  const inventory = read('tests/shell-id-inventory.test.js');
  // Only the ids the SHIPPED document gains: the inventory test requires
  // every ADDED_IDS key to be really in the prerender, so a runtime-only id
  // (the live line, the run page's stats) is not declared there.
  for (const id of ['routes-screen', 'routes-list', 'routes-empty', 'routes-record-btn', 'routes-privacy']) {
    assert.ok(inventory.includes(`'${id}':`), `#${id} is declared in ADDED_IDS`);
  }
  // The runtime-only ones still have to exist in the source the checks select
  // against, or a declared check would look for an id nothing ever draws.
  for (const id of ['routes-live', 'routes-location-note', 'routes-stats', 'routes-delete']) {
    assert.ok(screenSrc.includes(`id="${id}"`), `#${id} is drawn by the screen`);
  }
});

test('the map is drawn by the shell, with no basemap and no path data', () => {
  assert.match(mapSrc, /<polyline/);
  assert.ok(!/\sd="M/.test(mapSrc), 'the map carries no glyph path data');
  assert.ok(!/fetch\(|https?:\/\//.test(mapSrc), 'and no cross-origin asset');
  assert.match(mapSrc, /No map for this run\./);
  // The projection is pure, so a single point and an empty track both come
  // back empty rather than as a degenerate shape.
  const mod = loadTsx('frontend/@/components/ui/route-map.tsx');
  assert.deepEqual(mod.projectRoute([]), []);
  assert.equal(mod.projectRoute([{ lat: 1, lng: 1 }]).length, 1);
  const line = mod.projectRoute([{ lat: 0, lng: 0 }, { lat: 0.001, lng: 0.001 }]);
  assert.equal(line.length, 2);
  assert.ok(line[1].y < line[0].y, 'latitude grows north and SVG y grows down');
});
