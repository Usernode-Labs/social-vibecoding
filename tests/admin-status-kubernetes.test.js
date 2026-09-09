const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');

test('status uses a runtime-specific inventory provider', () => {
  const status = read('src/services/status.js');
  const provider = read('src/services/runtime-status.js');
  assert.match(status, /runtimeStatus\.snapshot\(config\)/);
  assert.match(provider, /runtimeKind === 'kubernetes'/);
  assert.match(provider, /kubernetes\.listStatusResources\(config\)/);
  assert.match(provider, /kubernetes\.listNamespaceCapacity\(config\)/);
  assert.match(provider, /listDockerContainers\(config\)/);
  assert.match(provider, /getDockerStats\(config\)/);
  assert.match(status, /runtimeKind === 'docker'/);
});

test('Kubernetes capacity renders quota reservations, not invented live usage', () => {
  // `.tsx` since #1120 slice 13 — the section renders in React now. What this
  // pins is the SEMANTICS of the Kubernetes branch (reserved quota, not
  // invented live usage), which is renderer-independent; only the two spellings
  // that named the old string-building helpers moved.
  const source = read('frontend/src/features/admin/admin-status.tsx');
  assert.match(source, /data\.runtimeKind === 'kubernetes'/);
  assert.match(source, /CPU requests/);
  assert.match(source, /Memory requests/);
  assert.match(source, /% headroom/);
  assert.doesNotMatch(source, /Kubernetes live (CPU|memory)/i);
  assert.match(source, /d\.runtimeKind === 'kubernetes' \? 'Capacity' : 'Capacity & host'/);
  assert.match(source, /s\.workersReady/);
  assert.match(source, /s\.stagingTotal/);
  assert.match(source, /<StatePill state=\{s\.worker\.state/);
});

test('Kubernetes stale-preview administration is exposed as an explicit gap', () => {
  const route = read('src/routes/admin.js');
  // The Stale previews section left the console chassis for its own React
  // module in #1120 slice 23; the two strings the route's gap feeds moved
  // with it.
  const reapSource = read('frontend/src/features/admin/admin-staging-reap.tsx');
  assert.match(route, /available: !staging && runtimeKind === 'docker'/);
  assert.match(route, /unavailableReason: staging \? 'staging' : \(runtimeKind === 'kubernetes' \? 'kubernetes' : null\)/);
  assert.match(reapSource, /Not yet supported in Kubernetes/);
  assert.match(reapSource, /normal per-session idle cleanup still applies/);
  // Both strings are reached through the reason the route sends, not through
  // an environment read of the section's own — the demo/staging gate above it
  // must not be what decides the Kubernetes wording.
  assert.match(reapSource, /unavailableReason === 'kubernetes'/);
  assert.ok(!/USERNODE_ENV|runtimeKind/.test(reapSource),
    'the section renders the gap the route reports; it does not detect the runtime');
});

test('database export remains runtime-neutral through networked pg_dump', () => {
  const source = read('src/services/db-export.js');
  assert.match(source, /spawnFn \|\| spawn\)\('pg_dump'/);
  assert.match(source, /DB_ADMIN_URL \|\| process\.env\.DATABASE_URL/);
  assert.doesNotMatch(source, /docker exec/);
});
