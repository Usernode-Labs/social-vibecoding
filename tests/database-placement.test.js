const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const placement = require('../src/services/database-placement');
const db = require('../src/services/db-manager');

const target = { appId: 4, slug: 'sv-staging-stockroom-d703d6', database: 'app_sv_staging_stockroom_d703d6',
  bindingName: 'app-4-production', clusterRef: { namespace: 'social-platform', name: 'central', uid: 'original-uid' } };
const policy = { namespace: 'social-platform', bindingTargets: [target] };
const spec = { appId: 4, slug: target.slug, database: target.database, owner: `${target.database}_owner`,
  environment: 'production', placement: 'central', clusterRef: target.clusterRef,
  endpoint: { host: 'central.social-platform.svc.cluster.local', port: 5432 },
  credentialRef: { source: 'platform-app', appId: 4 } };
const env = { DB_ADMIN_URL: 'postgresql://admin:never-expose@central.social-platform.svc.cluster.local:5432/usernode' };
function options(binding = { metadata: {}, spec }, cluster = { metadata: { uid: 'original-uid' } }) {
  return { policy, env, getReader: () => ({ binding: async () => binding, cluster: async () => cluster }) };
}

test('explicit current placement survives process-local reader reconstruction', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const records = await placement.assertCentralPlacement([target.database], options());
    assert.equal(records[0].name, 'app-4-production');
    assert.equal(records[0].credentialRef.source, 'platform-app');
    assert.doesNotMatch(JSON.stringify(records), /never-expose|postgresql:\/\//);
  }
});

test('unselected databases and disabled feature do not contact Kubernetes', async () => {
  const getReader = () => { throw Error('must not read'); };
  assert.deepEqual(await placement.assertCentralPlacement(['app_other'], { policy, env, getReader }), []);
  assert.deepEqual(await placement.assertCentralPlacement([target.database], { policy: null, env, getReader }), []);
});

test('missing, replaced, deleting, mismatched and external bindings fail closed', async () => {
  const cases = [null, { metadata: { deletionTimestamp: 'now' }, spec },
    ...[{ placement: 'dedicated' }, { appId: 5 }, { database: 'app_other' },
      { owner: 'admin' }, { credentialRef: { source: 'platform-app', appId: 5 } },
      { environment: 'preview' }, { endpoint: { host: 'elsewhere', port: 5432 } },
      { clusterRef: { ...target.clusterRef, uid: 'replacement' } }]
      .map((patch) => ({ metadata: {}, spec: { ...spec, ...patch } }))];
  for (const record of cases) await assert.rejects(
    placement.assertCentralPlacement([target.database], options(record)), { code: 'DATABASE_PLACEMENT_BLOCKED' });
  for (const cluster of [null, { metadata: { uid: 'replacement' } },
    { metadata: { uid: 'original-uid', deletionTimestamp: 'now' } }]) {
    await assert.rejects(placement.assertCentralPlacement([target.database], options(undefined, cluster)),
      { code: 'DATABASE_PLACEMENT_BLOCKED' });
  }
});

test('Kubernetes failure cannot fall back to central or leak API credentials', async () => {
  await assert.rejects(placement.assertCentralPlacement([target.database], {
    policy, env, getReader: () => ({ binding: async () => { throw Error(env.DB_ADMIN_URL); } }),
  }), (error) => error.code === 'DATABASE_PLACEMENT_BLOCKED' && !error.message.includes('never-expose'));
});

test('preview, template, evidence, prepared-source and role identities are guarded', async () => {
  const names = [target.database, `${target.database}_owner`, db.stagingDbName(target.slug, 's23', '123abc'),
    db.stagingTemplateDbName(target.database), `${db.stagingTemplateDbName(target.database)}_next`,
    db.evidenceDbName(target.slug, 99, 'base'), db.evidenceDbName(target.slug, 99, 'head'),
    db.preparedCloneSourceName(target.database, 99)];
  for (const name of names) {
    assert.equal(placement.ownsDatabase(target, name), true, name);
    await assert.rejects(placement.assertCentralPlacement([name], options(null)), { code: 'DATABASE_PLACEMENT_BLOCKED' });
  }
  assert.equal(placement.ownsDatabase(target, `${target.database}different`), false);
});

test('central binding allows preview cleanup but blocks primary retirement', async () => {
  await assert.rejects(placement.assertRetirementAllowed([target.database], options()), /Retiring/);
  await placement.assertRetirementAllowed([db.stagingDbName(target.slug, 's23', '123abc')], options());
});

test('malformed opt-in policy does not silently disable bindings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-binding-'));
  const file = path.join(dir, 'policy.json');
  try {
    const enabled = { SV_DATABASE_BINDINGS_ENABLED: 'true', SV_DATABASE_POLICY_FILE: file };
    assert.throws(() => placement.loadSelection(enabled), /blocked/);
    for (const bad of [{}, { ...policy, namespace: undefined }, { ...policy, bindingTargets: [{}] },
      { ...policy, bindingTargets: [target, target] }]) {
      fs.writeFileSync(file, JSON.stringify(bad));
      assert.throws(() => placement.loadSelection(enabled), /blocked/);
    }
    fs.writeFileSync(file, JSON.stringify(policy));
    assert.deepEqual(placement.loadSelection(enabled), policy);
    assert.equal(placement.loadSelection({}), null);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('clone, repair and global accounting stop before database side effects', async () => {
  const original = placement.assertCentralPlacement;
  const seen = [];
  placement.assertCentralPlacement = async (names, opts) => { seen.push({ names, all: !!opts?.all }); throw Error('blocked'); };
  try {
    await assert.rejects(db.cloneDatabase('app_other', target.database), /blocked/);
    await assert.rejects(db.cloneDatabase(target.database, 'app_other'), /blocked/);
    await assert.rejects(db.ensureRoleExists(target.database, 'secret'), /blocked/);
    await assert.rejects(db.listAppDatabaseSizes({ execute: () => assert.fail('SQL must not run') }), /blocked/);
    await assert.rejects(db.connectionUrl(target.database, 'secret'), /blocked/);
    assert.deepEqual(seen.slice(0, 2).map((item) => item.names), [['app_other', target.database], [target.database, 'app_other']]);
    assert.equal(seen[3].all, true);
  } finally { placement.assertCentralPlacement = original; }
});
