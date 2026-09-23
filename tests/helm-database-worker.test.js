const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('database worker uses platform image with separate identity and no platform secrets', () => {
  const args = ['template', 'test', 'deploy/helm/social-vibecoding-platform', '--namespace', 'social-platform',
    '--set', 'enabled=true,databaseControlPlane.enabled=true,platform.enabled=false,migration.enabled=false,postgresql.enabled=false',
    '--set-string', `release.sourceRevision=${'a'.repeat(40)},platform.image.digest=sha256:${'b'.repeat(64)}`,
    '--show-only', 'templates/database-worker.yaml'];
  const output = execFileSync('helm', args, { encoding: 'utf8' });
  assert.match(output, /serviceAccountName: social-database-worker/);
  assert.match(output, /command: \[node, src\/workers\/database-worker.js\]/);
  assert.match(output, /\/social-vibecoding-platform@sha256:b{64}/);
  assert.doesNotMatch(output, /envFrom:|secretRef:|DB_ADMIN_URL|DATABASE_URL/);
  assert.match(output, /toEntities: \[kube-apiserver\]/);
  assert.match(output, /readOnlyRootFilesystem: true/);
  assert.match(output, /path: \/ready/);
  assert.throws(() => execFileSync('helm', [...args, '--set-string', 'platform.image.digest=latest'], { stdio: 'pipe' }), /Command failed/);
});
