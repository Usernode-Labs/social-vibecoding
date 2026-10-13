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
  for (const label of ['CPU limits', 'Memory limits', 'Ephemeral storage limits',
    'Persistent storage requests', 'Volume claims', 'Services', 'Secrets', 'Jobs', 'Build records']) {
    assert.ok(source.includes(label), `capacity must display ${label}`);
  }
  assert.match(source, /% headroom/);
  assert.doesNotMatch(source, /Kubernetes live (CPU|memory)/i);
  assert.match(source, /d\.runtimeKind === 'kubernetes' \? 'Capacity' : 'Capacity & host'/);
  assert.match(source, /s\.workersReady/);
  assert.match(source, /s\.stagingTotal/);
  assert.match(source, /<StatePill state=\{s\.worker\.state/);
});

test('Kubernetes previews are administered like Docker ones', () => {
  // The route used to refuse the sweep and report a 'kubernetes' gap, because
  // its inventory was `docker ps`. staging-reap now lists the preview
  // Deployments there, so only a staging preview (which manages no other
  // previews) is refused.
  const route = read('src/routes/admin.js');
  const reap = read('src/services/staging-reap.js');
  const reapSource = read('frontend/src/features/admin/admin-staging-reap.tsx');
  assert.match(route, /available: !staging,/);
  assert.match(route, /unavailableReason: staging \? 'staging' : null/);
  assert.doesNotMatch(route, /mode\(config\) !== 'docker'/);
  assert.match(reap, /kubernetes\.listPreviews\(/);
  assert.doesNotMatch(reap, /mode\(config\) !== 'docker'/);
  assert.doesNotMatch(reapSource, /Not yet supported in Kubernetes|not implemented yet/);
  assert.ok(!/USERNODE_ENV|runtimeKind/.test(reapSource),
    'the section renders what the route reports; it does not detect the runtime');
});

test('database export remains runtime-neutral through networked pg_dump', () => {
  const source = read('src/services/db-export.js');
  assert.match(source, /spawnFn \|\| spawn\)\('pg_dump'/);
  assert.match(source, /DB_ADMIN_URL \|\| process\.env\.DATABASE_URL/);
  assert.doesNotMatch(source, /docker exec/);
});


test('capacity distinguishes idle connections from busy pool slots and labels missing previews honestly', () => {
  const source = read('frontend/src/features/admin/admin-status.tsx');
  assert.match(source, /Math.max\(0, db.total - db.idle\)/);
  assert.match(source, /poolBusy \/ db.max/);
  assert.match(source, /DB pool \(busy \/ max\)/);
  assert.match(source, /db.idle} idle/);
  assert.match(source, /db.waiting > 0/);
  assert.match(source, /Missing previews/);
  assert.doesNotMatch(source, />Stuck sessions<|label="Stuck"/);
});
