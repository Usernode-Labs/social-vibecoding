'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { makeAccessToken, hashSecret, tokenHint } = require('../../src/services/cli-auth');
const { selectRuntime, runtimeManifests } = require('../../src/services/preview-flow/runtime-intent');
const { SERVER_COMMAND } = require('./runtime-test-worker');
const { bindingRef } = require('../../src/services/preview-flow/binding-adapters');

async function inspectFreshStore(f) {
  const inventory = (await f.pool.query(`
    SELECT 'work' AS kind, count(*)::int AS n FROM execution_work_requests
    UNION ALL SELECT 'resources', count(*)::int FROM preview_flow_resources
    UNION ALL SELECT 'checks', count(*)::int FROM check_runs
    UNION ALL SELECT 'preview decisions', count(*)::int FROM preview_flow_decisions
    UNION ALL SELECT 'CLI decisions', count(*)::int FROM cli_preview_decisions
    UNION ALL SELECT 'review decisions', count(*)::int FROM proposal_review_decisions
    UNION ALL SELECT 'settlement decisions', count(*)::int FROM cli_check_settlement_decisions
  `)).rows;
  for (const row of inventory) assert.equal(row.n, 0, `Fresh fixture has retained ${row.kind}`);
  return inventory;
}

async function seed(f, { privateIdentity = false } = {}) {
  await f.pool.query('CREATE DATABASE usernode'); // Default clone maintenance DB, same disposable server.
  await f.pool.query('CREATE ROLE app_demo_stgtmpl_owner NOLOGIN');
  await f.pool.query('CREATE DATABASE app_demo_stgtmpl TEMPLATE template0 OWNER app_demo_stgtmpl_owner');
  const templateUrl = new URL(f.fixture.isolation.database.url);
  templateUrl.pathname = '/app_demo_stgtmpl';
  const template = new Client({ connectionString: templateUrl.toString() });
  await template.connect();
  try {
    if (privateIdentity) {
      await f.pool.query("UPDATE users SET has_platform_access = true WHERE username IN ('usernode-capture', 'usernode-capture-admin')");
      await template.query(fs.readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8'));
      const users = (await f.pool.query("SELECT id, username, password, is_admin, admin_readonly, has_platform_access FROM users WHERE username IN ('usernode-capture', 'usernode-capture-admin')")).rows;
      assert.equal(users.length, 2);
      for (const user of users) {
        await template.query('INSERT INTO users (id, username, password, is_admin, admin_readonly, has_platform_access) VALUES ($1,$2,$3,$4,$5,$6)',
          [user.id, user.username, user.password, user.is_admin, user.admin_readonly, user.has_platform_access]);
      }
    }
    await template.query('CREATE TABLE evidence (value TEXT)');
    await template.query('INSERT INTO evidence VALUES ($1)', [f.fixture.isolation.fixtureId]);
    await template.query('ALTER TABLE evidence OWNER TO app_demo_stgtmpl_owner');
  } finally {
    await template.end();
  }
  await f.pool.query('ALTER DATABASE app_demo_stgtmpl ALLOW_CONNECTIONS false');
  await f.pool.query(`COMMENT ON DATABASE app_demo_stgtmpl IS 'refreshed_at=${new Date().toISOString()}'`);
  const user = (await f.pool.query(`UPDATE users SET has_platform_access = true
    WHERE username = 'packaged-admin' RETURNING id`)).rows[0];
  assert.ok(user);
  const app = (await f.pool.query(`INSERT INTO apps
    (name, slug, repo_url, status, created_by, db_password, runtime_kind)
    VALUES ('Packaged fixture','demo',$1,'running',$2,'fixture-only','kubernetes') RETURNING *`,
  [f.fixture.preparationSource.repoUrl, user.id])).rows[0];
  if (privateIdentity) {
    await f.pool.query("UPDATE apps SET view_visibility = 'private', collab_visibility = 'private' WHERE id = $1", [app.id]);
    await f.pool.query("INSERT INTO app_collaborators (app_id,user_id) SELECT $1,id FROM users WHERE username = 'usernode-capture'", [app.id]);
  }
  const session = (await f.pool.query(`INSERT INTO chat_sessions
    (app_id, user_id, branch_name, status, source, handoff_base_sha, handoff_uploaded_sha)
    VALUES ($1,$2,'main','active','cli_handoff',$3,$4) RETURNING *`,
  [app.id, user.id, '0'.repeat(40), f.fixture.preparationSource.revision])).rows[0];
  if (privateIdentity) {
    await f.pool.query("UPDATE chat_sessions SET testing_path = '/proof' WHERE id = $1", [session.id]);
  }
  const token = makeAccessToken();
  await f.pool.query(`INSERT INTO cli_access_tokens
    (token_hash, token_hint, user_id, scopes, expires_at)
    VALUES ($1,$2,$3,ARRAY['rpc:identity:read','api:access','agent:local'],NOW()+INTERVAL '30 days')`,
  [hashSecret(token), tokenHint(token), user.id]);
  return { app, session, token };
}

async function servingPreview(f, session, app) {
  const config = { ...f.fixture.config, dataEncryptionKey: f.environment.DATA_ENCRYPTION_KEY,
    kubernetes: { ...f.fixture.config.kubernetes, appDomain: 'fixture.invalid' } };
  const intent = {
    runtimeKind: 'kubernetes', namespace: config.kubernetes.appNamespace,
    attemptId: randomUUID(), runtimeName: `packaged-serving-${randomUUID().slice(0, 8)}`,
    runtimeOperation: { kind: 'kubernetes-v1', resources: {} },
  };
  intent.runtimeOperation.desired = selectRuntime(config, {
    flowId: randomUUID(), generation: 1, headSha: f.fixture.preparationSource.revision,
  }, { imageRef: f.fixture.runtimeImage, env: { TOKEN: 'serving' }, command: SERVER_COMMAND });
  const manifests = runtimeManifests(intent, config.dataEncryptionKey);
  await f.clients.core.createNamespacedSecret({ namespace: intent.namespace, body: manifests.secret });
  await f.clients.core.createNamespacedService({ namespace: intent.namespace, body: manifests.service });
  const deployment = await f.clients.apps.createNamespacedDeployment({ namespace: intent.namespace, body: manifests.deployment });
  const ref = bindingRef(config, app, session.id);
  const ingress = require('../../src/services/kubernetes').appIngressManifest({
    name: ref.runtimeName, namespace: ref.namespace, hostname: ref.hostname,
    resourceLabels: { 'social.usernode.io/session-id': String(session.id) }, cfg: config.kubernetes, assetBackend: null,
  });
  ingress.spec.rules[0].http.paths.find(value => value.path === '/').backend.service.name = intent.runtimeName;
  const binding = await f.clients.networking.createNamespacedIngress({ namespace: ref.namespace, body: ingress });
  await f.pool.query(`UPDATE chat_sessions SET staging_runtime_kind = 'kubernetes',
    staging_runtime_name = $2, staging_image_ref = $3, staging_url = $4 WHERE id = $1`,
  [session.id, intent.runtimeName, f.fixture.runtimeImage, `https://${ref.hostname}`]);
  async function assertHealthy() {
    const current = await f.clients.apps.readNamespacedDeployment({ namespace: intent.namespace, name: intent.runtimeName });
    assert.equal(current.metadata.uid, deployment.metadata.uid);
    assert.deepEqual(current.spec, deployment.spec);
    const body = await f.clients.core.connectGetNamespacedServiceProxyWithPath({
      namespace: intent.namespace, name: `${intent.runtimeName}:3000`, path: 'health',
    });
    assert.equal(body, 'serving');
  }
  await f.waitFor(async () => {
    try { await assertHealthy(); return true; } catch { return false; }
  }, 'serving sentinel');
  return { intent, binding, ref, assertHealthy };
}

async function identities(f, sessionId) {
  const resource = (await f.pool.query(`SELECT r.intent, r.receipt FROM preview_flow_resources r
    JOIN preview_flow_heads h ON h.flow_id = r.flow_id WHERE h.session_id = $1`, [sessionId])).rows[0];
  const intent = resource.intent;
  assert.match(intent.dbName, /^app_p_s[1-9][0-9]*_[a-f0-9]{32}$/);
  const oid = (await f.pool.query('SELECT oid FROM pg_database WHERE datname = $1', [intent.dbName])).rows[0].oid;
  const cloneUrl = new URL(f.fixture.isolation.database.url);
  cloneUrl.pathname = `/${intent.dbName}`;
  const clone = new Client({ connectionString: cloneUrl.toString() });
  await clone.connect();
  try {
    assert.equal((await clone.query('SELECT value FROM evidence')).rows[0].value, f.fixture.isolation.fixtureId);
  } finally {
    await clone.end();
  }
  const image = await require('../../src/services/preview-flow/image-build-operation').createImageBuildOperations({
    clients: () => f.clients,
  }).inspect(intent);
  assert.equal(image.status, 'succeeded');
  const uids = {};
  for (const kind of ['secret', 'service', 'deployment']) {
    const api = kind === 'deployment' ? f.clients.apps : f.clients.core;
    const method = { secret: 'readNamespacedSecret', service: 'readNamespacedService', deployment: 'readNamespacedDeployment' }[kind];
    const object = await api[method]({ namespace: intent.namespace,
      name: kind === 'secret' ? `${intent.runtimeName}-env` : intent.runtimeName });
    assert.equal(object.metadata.uid, intent.runtimeOperation.resources[kind].uid);
    uids[kind] = object.metadata.uid;
  }
  return { oid, buildUid: image.uid, imageRef: image.imageRef, uids, runtimeName: intent.runtimeName };
}

module.exports = { inspectFreshStore, seed, servingPreview, identities };

async function migrate(f) {
  const migration = await f.start('migration');
  await f.waitFor(async () => {
    const [state] = JSON.parse(await f.docker(['inspect', migration]));
    if (state.State.Running) return false;
    assert.equal(state.State.ExitCode, 0, await f.logs(migration));
    return true;
  }, 'packaged migration', 120000);
}
module.exports.migrate = migrate;
