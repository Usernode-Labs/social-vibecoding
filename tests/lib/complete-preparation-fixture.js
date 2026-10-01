'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');
const { createExecutionDatabase } = require('./execution-database');
const { completePreparationWorker } = require('./complete-preparation-worker');
const { SERVER_COMMAND } = require('./runtime-test-worker');
const { selectRuntime, runtimeManifests } = require('../../src/services/preview-flow/runtime-intent');

async function fixtureFor(t) {
  const verified = await verifyIsolatedBuildFixture();
  assert.ok(verified.fixture.preparationSource && verified.fixture.runtimeImage && verified.databaseAddress);
  require('../../src/services/kubernetes')._setClientsForTest(verified.clients);
  const db = await createExecutionDatabase(verified.fixture.isolation.database.url);
  const assembled = completePreparationWorker(db.pool, verified);
  t.after(() => assembled.restore());
  const sessionId = 7000000 + process.pid;
  const source = verified.fixture.preparationSource;
  await db.pool.query(`CREATE TABLE app_secrets (app_id INTEGER, key TEXT, value_enc TEXT);
    ALTER TABLE pending_secret_declarations ADD COLUMN key TEXT,
      ADD COLUMN declaration JSONB, ADD COLUMN value_enc TEXT`);
  await db.pool.query('UPDATE apps SET repo_url = $1 WHERE id = 1', [source.repoUrl]);
  await db.pool.query(`INSERT INTO chat_sessions (id, checks_commit_sha, branch_name, pr_number)
    VALUES ($1,$2,$3,NULL)`, [sessionId, source.revision, source.branch]);

  const admin = new Client({ connectionString: verified.fixture.isolation.database.url });
  await admin.connect();
  await admin.query('CREATE ROLE app_demo_stgtmpl_owner NOLOGIN');
  await admin.query('CREATE DATABASE app_demo_stgtmpl TEMPLATE template0 OWNER app_demo_stgtmpl_owner');
  const seedUrl = new URL(verified.fixture.isolation.database.url);
  seedUrl.pathname = '/app_demo_stgtmpl';
  const seed = new Client({ connectionString: seedUrl.toString() });
  await seed.connect();
  await seed.query('CREATE TABLE evidence (value TEXT)');
  await seed.query('INSERT INTO evidence VALUES ($1)', [verified.fixture.isolation.fixtureId]);
  await seed.query('ALTER TABLE evidence OWNER TO app_demo_stgtmpl_owner');
  await seed.end();
  await admin.query('ALTER DATABASE app_demo_stgtmpl ALLOW_CONNECTIONS false');
  t.after(async () => {
    // Exact recorded attempt names only, in the preflight-verified disposable DB.
    const { rows } = await db.pool.query('SELECT intent FROM preview_flow_resources');
    for (const { intent } of rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${intent.dbName} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${intent.dbName}_owner`);
    }
    await admin.query('DROP DATABASE app_demo_stgtmpl WITH (FORCE)');
    await admin.query('DROP ROLE app_demo_stgtmpl_owner');
    await admin.end();
    await require('../../src/db/pool').getPool(assembled.config).end();
    await db.close();
    require('../../src/services/kubernetes')._setClientsForTest(new Proxy({}, {
      get() { throw new Error('Ambient Kubernetes access forbidden after fixture'); },
    }));
  });

  const serving = {
    runtimeKind: 'kubernetes', namespace: verified.fixture.isolation.namespace.name,
    attemptId: randomUUID(), runtimeName: `c7-serving-${randomUUID().slice(0, 8)}`,
    runtimeOperation: { kind: 'kubernetes-v1', resources: {} },
  };
  serving.runtimeOperation.desired = selectRuntime(assembled.config,
    { flowId: randomUUID(), generation: 1, headSha: source.revision }, {
      imageRef: verified.fixture.runtimeImage, env: { TOKEN: 'serving' }, command: SERVER_COMMAND,
    });
  const manifests = runtimeManifests(serving, assembled.config.dataEncryptionKey);
  await verified.clients.core.createNamespacedSecret({ namespace: serving.namespace, body: manifests.secret });
  await verified.clients.core.createNamespacedService({ namespace: serving.namespace, body: manifests.service });
  const servingDeployment = await verified.clients.apps.createNamespacedDeployment({ namespace: serving.namespace, body: manifests.deployment });
  const servingDeadline = Date.now() + 120000;
  while (!await assembled.probe(assembled.config, serving)) {
    assert.ok(Date.now() < servingDeadline, 'Serving sentinel must become healthy');
    await delay(1000);
  }
  await db.pool.query(`UPDATE chat_sessions SET staging_runtime_kind = 'kubernetes', staging_runtime_name = $2,
    staging_image_ref = $3, staging_url = $4 WHERE id = $1`, [sessionId, serving.runtimeName,
    verified.fixture.runtimeImage, `http://${serving.runtimeName}.${serving.namespace}.svc:3000`]);
  const projectionSql = `SELECT staging_url, staging_runtime_kind, staging_runtime_name,
    staging_image_ref, staging_container_id, staging_commit_sha, staging_build_ref
    FROM chat_sessions WHERE id = $1`;
  const projection = (await db.pool.query(projectionSql, [sessionId])).rows[0];

  async function assertServing() {
    const current = await verified.clients.apps.readNamespacedDeployment({ namespace: serving.namespace, name: serving.runtimeName });
    assert.equal(current.metadata.uid, servingDeployment.metadata.uid);
    assert.deepEqual(structuredClone(current.spec), structuredClone(servingDeployment.spec));
    assert.equal(await assembled.probe(assembled.config, serving), true);
    assert.deepEqual((await db.pool.query(projectionSql, [sessionId])).rows[0], projection);
    assert.equal((await assembled.owner.read(sessionId)).binding, null);
  }

  async function admit() {
    return assembled.work.request({
      type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId,
      headSha: source.revision, startedStatus: 'active',
    });
  }

  return { ...verified, ...db, ...assembled, sessionId, serving, assertServing, admit };
}

module.exports = { fixtureFor };
