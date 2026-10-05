const { englishUiSource } = require("./lib/english-ui-source");
// test:changed: always (every route and client API path, for the Classic inventory; scripts/test-changed.js)
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const inventory = require('../src/services/global-chat/classic-inventory.generated.json');
const generator = require('../scripts/generate-global-chat-inventory.js');

// Parsing every route and client file is nearly all of this suite's time, so
// the tree is scanned once and every build below reuses the scans.
const declaredRoutes = generator.discoverRoutes();
const clientRefs = generator.discoverClientReferences();
const built = generator.buildInventory({ declaredRoutes, clientRefs });
const committed = englishUiSource(fs.readFileSync(generator.OUTPUT, 'utf8'));

test('the generated Classic inventory is current and fully reviewed', () => {
  assert.deepEqual(generator.reviewFindings(built), []);
  assert.ok(generator.serialize(built) === committed,
    'the committed inventory is stale: run npm run global-chat:inventory');
  assert.equal(inventory.inventoryReviewed, true);
  assert.deepEqual(inventory.routes.filter((route) => route.status === 'review_required'), []);
  assert.deepEqual(inventory.unmatchedClientReferences, []);
  assert.ok(built[generator.REVIEWED_REFERENCES].length > 0);
  assert.ok(inventory.ignoredClientSources.some(
    ({ source }) => source === 'frontend/src/features/admin/e2e-results-data.js',
  ));
});

test('client calls are checked against the routes but never recorded, so a client change and a route change merge cleanly', () => {
  // #3346 added a screen whose one call the generator counted against every
  // /api/me route; it regenerated on a base without #2976, which added
  // GET /api/me/app-blocks. Each regenerated correctly, the two merged
  // cleanly, and main went stale on the pairing neither had seen (#3354).
  // Which client files call a route was the file's one input from outside
  // the route files, and nothing at runtime read it.
  for (const route of inventory.routes) {
    assert.ok(!Object.hasOwn(route, 'clientReferences'), `${route.method} ${route.path} lists no callers`);
    assert.ok(!Object.hasOwn(route, 'reviewReason'), `${route.method} ${route.path} has no caller-dependent note`);
  }
  assert.ok(!Object.hasOwn(inventory, 'reviewedClientReferences'), 'no committed list of reviewed callers');
  const ignored = new Set(inventory.ignoredClientSources.map(({ source }) => source));
  const clientFiles = [];
  JSON.stringify(inventory, (_key, value) => {
    if (typeof value === 'string' && /^(?:frontend\/src|public\/js)\/\S+\.(?:js|ts|tsx)$/.test(value)
        && !ignored.has(value)) clientFiles.push(value);
    return value;
  });
  assert.deepEqual(clientFiles, [], 'the committed inventory names no client file');

  // A new call to a route that exists, and the loss of every call to a whole
  // family of routes, leave the committed file byte for byte as it is.
  const withNewCall = new Map(clientRefs);
  withNewCall.set('/api/me/app-blocks', new Set([
    ...(clientRefs.get('/api/me/app-blocks') || []),
    'frontend/src/features/imagined/new-screen.tsx',
  ]));
  assert.ok(generator.serialize(generator.buildInventory({ declaredRoutes, clientRefs: withNewCall })) === committed,
    'adding a client call changed the committed inventory');
  const withoutMeCalls = new Map([...clientRefs].filter(([apiPath]) => !apiPath.startsWith('/api/me/')));
  assert.ok(withoutMeCalls.size < clientRefs.size);
  assert.ok(generator.serialize(generator.buildInventory({ declaredRoutes, clientRefs: withoutMeCalls })) === committed,
    'removing client calls changed the committed inventory');

  // A call that matches no route still fails the check, and names itself.
  const withBrokenCall = new Map(clientRefs);
  withBrokenCall.set('/api/no-such-route', new Set(['frontend/src/features/imagined/typo.tsx']));
  const broken = generator.buildInventory({ declaredRoutes, clientRefs: withBrokenCall });
  assert.equal(broken.inventoryReviewed, false);
  assert.deepEqual(broken.unmatchedClientReferences, [
    { path: '/api/no-such-route', sources: ['frontend/src/features/imagined/typo.tsx'] },
  ]);
  assert.match(generator.reviewFindings(broken).join('\n'),
    /\/api\/no-such-route, called from frontend\/src\/features\/imagined\/typo\.tsx, matches no route/);
});

test('every mapped route has one stable mobile-capable capability contract', () => {
  const mapped = inventory.routes.filter((route) => route.status === 'mapped');
  const exempt = inventory.routes.filter((route) => route.status === 'exempt');
  assert.equal(mapped.length + exempt.length, inventory.routes.length, 'every route is mapped or exempt');

  const ids = mapped.map((route) => route.capabilityId);
  assert.equal(new Set(ids).size, ids.length, 'capability ids must be unique');
  for (const route of mapped) {
    assert.ok(route.path, `${route.source} ${route.method} ${route.expression || ''} must have a resolved path`);
    assert.match(route.capabilityId, /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/);
    assert.ok(['read', 'reversible_write', 'external_write', 'destructive'].includes(route.risk));
    assert.ok(['server_loopback', 'client_action', 'native_client'].includes(route.transport));
    assert.equal(route.mobileSupported, true);
    assert.match(route.classicPath, /^#/);
  }
});

test('aliased and array route declarations cannot disappear from the parity audit', () => {
  const routeKey = new Set(inventory.routes.map(({ method, path }) => `${method} ${path}`));
  for (const expected of [
    'GET /api/apps/:slug/featured-illustration',
    'DELETE /api/apps/:slug/featured-illustration',
    'GET /api/sessions/:id/checks',
    'GET /api/sessions/:id/details',
    'GET /api/v4/mobile/native/delegation',
    'POST /api/v4/mobile/native/delegation',
    'POST /api/v4/mobile/auth/native-establish-handoff',
    'GET /api/iframe-token',
  ]) {
    assert.ok(routeKey.has(expected), `missing ${expected}`);
  }
});

test('exact governance and proposal routes keep their distinct Classic destinations', () => {
  const route = (routePath) => inventory.routes.find((item) => (
    item.method === 'GET' && item.path === routePath
  ));
  assert.equal(
    route('/api/apps/:slug/governance/:id')?.classicPath,
    '#app/:slug/dev/governance/:id',
  );
  assert.equal(
    route('/api/apps/:slug/proposals/:id')?.classicPath,
    '#app/:slug/dev/proposals/:id',
  );
});

test('credentials and protocol endpoints are reviewed exemptions, not model tools', () => {
  function route(method, routePath) {
    return inventory.routes.find((item) => item.method === method && item.path === routePath);
  }
  for (const [method, routePath] of [
    ['GET', '/api/iframe-token'],
    ['POST', '/api/v4/mobile/auth/native-establish-handoff'],
    ['POST', '/api/cli/device/token'],
  ]) {
    const item = route(method, routePath);
    assert.equal(item?.status, 'exempt', `${method} ${routePath} must be exempt`);
    assert.match(item.reason, /credential|protocol/i);
  }
  assert.equal(route('GET', '/api/cli/device/approval')?.status, 'mapped');
  assert.equal(route('POST', '/api/cli/device/approve')?.status, 'mapped');
});

test('every Settings section and navigation surface is discoverable on mobile', () => {
  assert.ok(inventory.settings.length > 0);
  assert.ok(inventory.navigation.length > 0);
  for (const item of [...inventory.settings, ...inventory.navigation]) {
    assert.ok(item.capabilityId || item.id);
    assert.match(item.classicPath, /^#/);
    assert.equal(item.mobileSupported, true);
  }
});

test('account deletion opens the private Settings form instead of collecting credentials in chat', () => {
  const deletion = inventory.routes.find(({ method, path }) => method === 'DELETE' && path === '/api/auth/account');
  assert.equal(deletion?.risk, 'destructive');
  assert.equal(deletion.confirmation, 'required');
  assert.equal(deletion.transport, 'client_action');
  assert.equal(deletion.classicPath, '#settings/delete-account');
});

test('the reviewed first-version artifact enables the all-user experimental release gate', () => {
  assert.equal(inventory.parityReady, true);
  const packageJson = JSON.parse(englishUiSource(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));
  assert.equal(packageJson.scripts['global-chat:inventory:check'],
    'node scripts/generate-global-chat-inventory.js --check');
  const shellSource = [
    path.join(ROOT, 'frontend', 'src', 'shell.tsx'),
    path.join(ROOT, 'public', 'index.html'),
  ].filter(fs.existsSync).map((file) => englishUiSource(fs.readFileSync(file, 'utf8'))).join('\n');
  assert.doesNotMatch(shellSource, /data-global-chat-switch/);
});

test('reviewed route exemptions are keyed on registration shape, never on a line number', () => {
  // A line-keyed exemption stops matching the moment an unrelated edit shifts
  // the file, which silently flips reviewed routes back to "mapped" and fails
  // the freshness check above with a diff that looks like noise. Exemptions
  // must name what the registration IS (an array of paths, a middleware
  // shadowing the concrete route below it), not where it currently sits.
  const source = englishUiSource(fs.readFileSync(
    path.join(ROOT, 'scripts/generate-global-chat-inventory.js'),
    'utf8',
  ));
  const start = source.indexOf('const REVIEWED_ROUTE_EXEMPTIONS = [');
  assert.ok(start !== -1, 'REVIEWED_ROUTE_EXEMPTIONS must exist');
  const end = source.indexOf('\n];', start);
  assert.ok(end !== -1, 'REVIEWED_ROUTE_EXEMPTIONS must be terminated');
  const block = source.slice(start, end);
  assert.doesNotMatch(
    block,
    /\.line\b/,
    'exemption matchers must not depend on a route line number',
  );
});

test('the committed inventory carries no line numbers, so moving a route is not a change', () => {
  // Every edit above a route used to move its `line`, and the file went stale
  // on nearly every change to a routes file (and on the merge of two changes
  // that had each regenerated it). The generator keeps the line internal, for
  // declaration order and shadowed registrations only.
  assert.ok(inventory.routes.every((route) => !Object.hasOwn(route, 'line')), 'no route records its line');
  const source = englishUiSource(fs.readFileSync(path.join(ROOT, 'scripts/generate-global-chat-inventory.js'), 'utf8'));
  assert.match(source, /\[REGISTRATION\]: \{ line, pathCount: discovered\.length, shadowsLaterRoute: false \}/,
    'the line rides on the Symbol key JSON.stringify skips');
  assert.doesNotMatch(englishUiSource(fs.readFileSync(path.join(ROOT, 'src/services/global-chat/classic-capabilities.js'), 'utf8')), /route\.line\b/,
    'and nothing that reads the inventory expects one');
});

test('the committed inventory carries no totals, so two changes that each add a route merge cleanly', () => {
  // Two changes that each added a route each moved the committed totals by
  // one, the same edit, which their merge applied once: main went stale though
  // both had regenerated correctly (#3127 and #3133). Every count is the
  // length of a list the file already has.
  const topLevel = Object.keys(inventory);
  assert.ok(!topLevel.includes('summary'), 'no summary block');
  for (const key of topLevel.filter((name) => name !== 'schemaVersion')) {
    assert.ok(typeof inventory[key] !== 'number', `${key} is not a committed count`);
  }
  const source = englishUiSource(fs.readFileSync(path.join(ROOT, 'scripts/generate-global-chat-inventory.js'), 'utf8'));
  assert.match(source, /\[COUNTS\]: \{ mapped: counts\.mapped, reviewRequired: counts\.review_required \}/,
    'the counts the script reports ride on the Symbol key JSON.stringify skips');
  const readers = [
    'src/routes/global-chat.js',
    'src/services/global-chat/classic-api-client.js',
    'src/services/global-chat/classic-capabilities.js',
    'src/services/global-chat/suggestion-actions.js',
    'tests/global-chat-classic-capabilities.test.js',
  ];
  for (const file of readers) {
    assert.doesNotMatch(englishUiSource(fs.readFileSync(path.join(ROOT, file), 'utf8')), /\binventory\.summary\b|classicInventory\.summary\b/,
      `${file} does not read a total`);
  }
});
