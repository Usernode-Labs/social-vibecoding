'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const inventory = require('../src/services/global-chat/classic-inventory.generated.json');

test('the generated Classic inventory is current and fully reviewed', () => {
  assert.doesNotThrow(() => execFileSync(
    process.execPath,
    ['scripts/generate-global-chat-inventory.js', '--check'],
    { cwd: ROOT, stdio: 'pipe' },
  ));
  assert.equal(inventory.inventoryReviewed, true);
  assert.equal(inventory.summary.reviewRequiredRoutes, 0);
  assert.equal(inventory.summary.unmatchedClientApiReferences, 0);
  assert.deepEqual(inventory.unmatchedClientReferences, []);
  assert.ok(inventory.reviewedClientReferences.length > 0);
  assert.ok(inventory.ignoredClientSources.some(
    ({ source }) => source === 'frontend/src/features/admin/e2e-results-data.js',
  ));
});

test('every mapped route has one stable mobile-capable capability contract', () => {
  const mapped = inventory.routes.filter((route) => route.status === 'mapped');
  const exempt = inventory.routes.filter((route) => route.status === 'exempt');
  assert.equal(mapped.length, inventory.summary.mappedRoutes);
  assert.equal(exempt.length, inventory.summary.exemptRoutes);
  assert.equal(mapped.length + exempt.length, inventory.summary.totalRoutes);

  const ids = mapped.map((route) => route.capabilityId);
  assert.equal(new Set(ids).size, ids.length, 'capability ids must be unique');
  for (const route of mapped) {
    assert.ok(route.path, `${route.source}:${route.line} must have a resolved path`);
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
  assert.equal(inventory.settings.length, inventory.summary.settingsSections);
  assert.equal(inventory.navigation.length, inventory.summary.navigationSurfaces);
  for (const item of [...inventory.settings, ...inventory.navigation]) {
    assert.ok(item.capabilityId || item.id);
    assert.match(item.classicPath, /^#/);
    assert.equal(item.mobileSupported, true);
  }
});

test('the reviewed first-version artifact enables the all-user experimental release gate', () => {
  assert.equal(inventory.parityReady, true);
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['global-chat:inventory:check'],
    'node scripts/generate-global-chat-inventory.js --check');
  const shellSource = [
    path.join(ROOT, 'frontend', 'src', 'shell.tsx'),
    path.join(ROOT, 'public', 'index.html'),
  ].filter(fs.existsSync).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(shellSource, /data-global-chat-switch/);
});
