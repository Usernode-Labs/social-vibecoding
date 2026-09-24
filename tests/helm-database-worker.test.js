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

test('cluster administrative credentials are projected only into platform and startup migrator', () => {
  const args=['template','test','deploy/helm/social-vibecoding-platform','--set',
    'enabled=true,databaseControlPlane.enabled=true,databaseControlPlane.bindingsEnabled=true,databaseControlPlane.runtimeSecret=runtime-targets,secrets.create=false,postgresql.enabled=false',
    '--set','secrets.existingSecret=social-vibecoding,postgresql.host=central.social-platform.svc.cluster.local',
    '--set-json','postgresql.podSelector={"cnpg.io/cluster":"central"}',
    '--set-string',`release.sourceRevision=${'a'.repeat(40)},platform.image.digest=sha256:${'b'.repeat(64)},platform.workerImage.digest=sha256:${'b'.repeat(64)},platform.captureImage.digest=sha256:${'b'.repeat(64)}`];
  for(const template of ['platform.yaml','migration-job.yaml']) {
    const result=execFileSync('helm',[...args,'--show-only',`templates/${template}`],{encoding:'utf8'});
    assert.match(result,/SV_DATABASE_TARGETS_FILE/);assert.match(result,/secretName: "runtime-targets"/);
  }
  const worker=execFileSync('helm',[...args,'--show-only','templates/database-worker.yaml'],{encoding:'utf8'});
  assert.doesNotMatch(worker,/runtime-targets|database-targets|SV_DATABASE_TARGETS_FILE/);
  assert.throws(()=>execFileSync('helm',[...args,'--set','databaseControlPlane.bindingsEnabled=false'],{stdio:'pipe'}));
});

test('migration admin stays in a separate deployment with only session DB credentials and scoped ingress', () => {
  const args = ['template', 'test', 'deploy/helm/social-vibecoding-platform', '--set',
    'enabled=true,databaseControlPlane.enabled=true,databaseControlPlane.bindingsEnabled=true,databaseControlPlane.runtimeSecret=runtime-targets,databaseControlPlane.migrationsEnabled=true,secrets.create=false,postgresql.enabled=false',
    '--set', 'secrets.existingSecret=social-vibecoding,postgresql.host=central.social-platform.svc.cluster.local',
    '--set-json', 'postgresql.podSelector={"cnpg.io/cluster":"central"}',
    '--set-string', `release.sourceRevision=${'a'.repeat(40)},platform.image.digest=sha256:${'b'.repeat(64)},platform.workerImage.digest=sha256:${'b'.repeat(64)},platform.captureImage.digest=sha256:${'b'.repeat(64)}`];
  const rendered = execFileSync('helm', [...args, '--show-only', 'templates/database-migrations.yaml'], {encoding:'utf8'});
  assert.match(rendered, /serviceAccountName: social-database-migrations/);
  assert.match(rendered, /strategy: \{type: Recreate\}/);
  assert.match(rendered, /command: \[node, src\/workers\/database-migrations.js\]/);
  assert.match(rendered, /key: DATABASE_URL/);
  assert.doesNotMatch(rendered, /envFrom:|DB_ADMIN_URL|GITHUB|SESSION_SECRET|runtime-targets/);
  assert.match(rendered, /readOnlyRootFilesystem: true/);
  const ingress = execFileSync('helm', [...args, '--set','ingress.enabled=true', '--show-only', 'templates/ingress.yaml'], {encoding:'utf8'});
  assert.match(ingress, /path: \/api\/admin\/database-migrations/);
  assert.match(ingress, /path: \/database-maintenance/);
  const disabled = execFileSync('helm', [...args, '--set','databaseControlPlane.migrationsEnabled=false'], {encoding:'utf8'});
  assert.doesNotMatch(disabled, /src\/workers\/database-migrations.js|serviceAccountName: social-database-migrations/);
});
