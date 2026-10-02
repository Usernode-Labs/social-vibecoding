'use strict';

// Real PostgreSQL admission/recovery; external observations below are injected.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { enabled: postgresEnabled, readPreviewPostgresFixture } = require('./lib/preview-postgres-fixture');
const { createExecutionDatabase } = require('./lib/execution-database');
const { createPreviewWork, PREPARE_RUNTIME } = require('../src/services/preview-flow/work');
const { createExecutionWorker } = require('../src/services/execution/worker');

const HEAD = 'a'.repeat(40);

async function fixture(t) {
  const selected = await readPreviewPostgresFixture();
  const db = await createExecutionDatabase(selected.databaseUrl);
  t.after(() => db.close());
  await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES (1, $1)', [HEAD]);
  const config = {
    ...selected.config,
    databaseUrl: db.url,
    dataEncryptionKey: 'admission-fixture-only',
    nativeCliPreviewHandoffEnabled: true,
    nativePreviewAttempts: false,
  };
  const action = {
    type: 'RequestCandidatePreview',
    actionId: randomUUID(),
    sessionId: 1,
    headSha: HEAD,
    startedStatus: 'active',
  };
  return { ...db, config, action };
}

test('real PostgreSQL: new durable admission has one complete format without legacy opt-in', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const owner = createPreviewWork(f.pool, f.config);
  const admitted = await owner.request(f.action);
  const { input } = admitted.work;
  assert.equal(admitted.work.workflow, PREPARE_RUNTIME);
  assert.equal(admitted.work.contract_version, 1);
  assert.equal(input.intent.runtimeKind, 'kubernetes');
  assert.equal(input.intent.cloneOperation.kind, 'template-v1');
  assert.equal(input.intent.buildOperation.kind, 'kpack-v1');
  assert.equal(input.intent.buildOperation.revision, HEAD);
  assert.deepEqual(input.intent.runtimeOperation, { kind: 'kubernetes-v1', resources: {} });
  const actionIds = ['preparedActionId', 'failedActionId', 'clonePreparedActionId', 'imageBuiltActionId'];
  assert.equal(new Set(actionIds.map(key => input[key])).size, actionIds.length);
  for (const key of actionIds) assert.match(input[key], /^[a-f0-9-]{36}$/);
  const resource = (await f.pool.query('SELECT * FROM preview_flow_resources')).rows[0];
  assert.ok(resource.clone_credential_enc);
  assert.deepEqual(resource.intent, input.intent);
  const replayed = await owner.request(f.action);
  assert.equal(replayed.work.id, admitted.work.id);
  assert.deepEqual(replayed.work.input, input);
  assert.equal((await f.pool.query('SELECT * FROM execution_work_requests')).rowCount, 1);
  assert.equal(require('../src/services/preview-flow/activation').enabled(f.config), false);
});

for (const enabled of [undefined, false]) {
  test(`real PostgreSQL: ${enabled === undefined ? 'unset' : 'disabled'} admission rejects without writes`, { skip: !postgresEnabled }, async t => {
    const f = await fixture(t);
    f.config.nativeCliPreviewHandoffEnabled = enabled;
    f.config.nativePreviewAttempts = true;
    const owner = createPreviewWork(f.pool, f.config);
    await assert.rejects(owner.request(f.action), /experimentally disabled/);
    for (const table of ['preview_flows', 'preview_flow_resources', 'preview_action_receipts',
      'preview_flow_decisions', 'execution_work_requests', 'execution_work_events']) {
      assert.equal((await f.pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
    }
  });
}
