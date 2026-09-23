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


test('binding opt-in equips the migrator to validate placement without write permissions', () => {
  const args = ['template', 'test', 'deploy/helm/social-vibecoding-platform',
    '--set', 'enabled=true,databaseControlPlane.enabled=true,databaseControlPlane.bindingsEnabled=true,platform.enabled=false,migration.enabled=true,postgresql.enabled=false,secrets.create=false',
    '--set', 'secrets.existingSecret=social-vibecoding,postgresql.host=central.social-platform.svc.cluster.local',
    '--set-json', 'postgresql.podSelector={"cnpg.io/cluster":"central"}',
    '--set-string', `release.sourceRevision=${'a'.repeat(40)},platform.image.digest=sha256:${'b'.repeat(64)}`,
    '--show-only', 'templates/migration-job.yaml'];
  const output = execFileSync('helm', args, { encoding: 'utf8' });
  assert.match(output, /automountServiceAccountToken: true/);
  assert.match(output, /SV_DATABASE_BINDINGS_ENABLED, value: "true"/);
  assert.match(output, /SV_DATABASE_POLICY_FILE, value: \/etc\/sv-database\/policy.json/);
  assert.match(output, /mountPath: \/etc\/sv-database, readOnly: true/);
  assert.match(output, /component: migration/);
  assert.match(output, /toEntities: \[kube-apiserver\]/);
  const disabled = execFileSync('helm', [...args, '--set', 'databaseControlPlane.bindingsEnabled=false'], { encoding: 'utf8' });
  assert.match(disabled, /automountServiceAccountToken: false/);
  assert.doesNotMatch(disabled, /kind: CiliumNetworkPolicy|mountPath: \/etc\/sv-database/);
  assert.throws(() => execFileSync('helm', [...args, '--set', 'databaseControlPlane.enabled=false'], { stdio: 'pipe' }));
});
