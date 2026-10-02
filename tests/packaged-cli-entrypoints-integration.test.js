'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { packagedFixture } = require('./lib/packaged-cli-fixture');
const { makeAccessToken, hashSecret, tokenHint } = require('../src/services/cli-auth');
const { selectRuntime, runtimeManifests } = require('../src/services/preview-flow/runtime-intent');
const { SERVER_COMMAND } = require('./lib/runtime-test-worker');
const { bindingRef } = require('../src/services/preview-flow/binding-adapters');

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

async function seed(f) {
  await f.pool.query('CREATE DATABASE usernode'); // Default clone maintenance DB, same disposable server.
  await f.pool.query('CREATE ROLE app_demo_stgtmpl_owner NOLOGIN');
  await f.pool.query('CREATE DATABASE app_demo_stgtmpl TEMPLATE template0 OWNER app_demo_stgtmpl_owner');
  const templateUrl = new URL(f.fixture.isolation.database.url);
  templateUrl.pathname = '/app_demo_stgtmpl';
  const template = new Client({ connectionString: templateUrl.toString() });
  await template.connect();
  try {
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
  const session = (await f.pool.query(`INSERT INTO chat_sessions
    (app_id, user_id, branch_name, status, source, handoff_base_sha, handoff_uploaded_sha)
    VALUES ($1,$2,'main','active','cli_handoff',$3,$4) RETURNING *`,
  [app.id, user.id, '0'.repeat(40), f.fixture.preparationSource.revision])).rows[0];
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
  const ingress = require('../src/services/kubernetes').appIngressManifest({
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
  const image = await require('../src/services/preview-flow/image-build-operation').createImageBuildOperations({
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

test('packaged web HTTP admission and standalone worker recover persisted phase boundaries', {
  skip: process.env.RUN_ISOLATED_PACKAGED_CLI_TEST !== '1', timeout: 1800000,
}, async t => {
  const f = await packagedFixture(t);
  const migration = await f.start('migration');
  await f.waitFor(async () => {
    const [state] = JSON.parse(await f.docker(['inspect', migration]));
    if (state.State.Running) return false;
    assert.equal(state.State.ExitCode, 0, await f.logs(migration));
    return true;
  }, 'packaged migration', 120000);
  const freshInventory = await inspectFreshStore(f);
  const { app, session, token } = await seed(f);
  const serving = await servingPreview(f, session, app);

  // Admission commits through HTTP; losing its reply must join the same work.
  let web = await f.start('web', { pause: 'admitted' });
  let origin = await f.healthy(web);
  const request = async (authorization = token) => {
    const response = await fetch(`${origin}/api/sessions/${session.id}/proposal-handoff/build`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authorization}` },
      body: JSON.stringify({ schemaVersion: 1, headSha: f.fixture.preparationSource.revision, history: [] }),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.notEqual((await request('svcli_' + 'A'.repeat(43))).status, 202, 'Real CLI authentication rejects an invalid credential');
  const lostReply = request().catch(() => null);
  const marker = name => path.join(f.evidence, `${name}.json`);
  await f.waitFor(() => fs.existsSync(marker('admitted')), 'HTTP admission COMMIT');
  const admission = JSON.parse(fs.readFileSync(marker('admitted'), 'utf8'));
  await f.stop(web);
  await lostReply;
  web = await f.start('web');
  origin = await f.healthy(web);
  const retry = await request();
  assert.equal(retry.status, 202);
  assert.equal(retry.body.workId, admission.workId);
  assert.equal((await f.pool.query(`SELECT count(*)::int AS n FROM execution_work_requests
    WHERE workflow = 'native-preview-kubernetes-prepare' AND session_id = $1`, [session.id])).rows[0].n, 1);


  // Candidate completion records continuation before either serving change or checks.
  let worker = await f.start('worker', { pause: 'candidate_committed' });
  await f.waitFor(() => fs.existsSync(marker('candidate_committed')), 'real candidate completion', 600000);
  const prepared = await identities(f, session.id);
  const handoff = (await f.pool.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [session.id])).rows[0];
  assert.ok(handoff.continuation_work_id);
  const beforeActivation = await f.clients.networking.readNamespacedIngress({ namespace: serving.ref.namespace, name: serving.ref.runtimeName });
  assert.equal(beforeActivation.metadata.uid, serving.binding.metadata.uid);
  assert.equal(beforeActivation.spec.rules[0].http.paths.find(value => value.path === '/').backend.service.name, serving.intent.runtimeName);
  await serving.assertHealthy();
  await f.stop(worker);
  await f.stop(web);
  web = await f.start('web', { admission: false });
  origin = await f.healthy(web);
  assert.equal((await request()).body.workId, handoff.continuation_work_id);
  const refusedHead = await fetch(`${origin}/api/sessions/${session.id}/proposal-handoff/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ schemaVersion: 1, headSha: 'a'.repeat(40), history: [] }),
  });
  assert.equal(refusedHead.status, 409);
  assert.equal((await refusedHead.json()).error, 'durable_revision_admission_disabled');


  // Lose the reply after the real conditional binding write; adoption keeps its UID.
  worker = await f.start('worker', { pause: 'activation_written', admission: false });
  await f.waitFor(() => fs.existsSync(marker('activation_written')), 'real binding update');
  const activated = await f.clients.networking.readNamespacedIngress({ namespace: serving.ref.namespace, name: serving.ref.runtimeName });
  assert.equal(activated.metadata.uid, serving.binding.metadata.uid);
  assert.equal(activated.spec.rules[0].http.paths.find(value => value.path === '/').backend.service.name, prepared.runtimeName);
  await f.stop(worker);
  await f.stop(web);
  web = await f.start('web', { admission: false });
  origin = await f.healthy(web);
  // Policy transition is seeded, not a voting/PR proof. It makes gate delivery
  // exercise the policy service rather than a legitimate not-in-review no-op.
  await f.pool.query(`UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = checks_commit_sha WHERE id = $1`, [session.id]);

  // Real Jobs produce the verdict. Its receipt, history and gate commit before loss.
  worker = await f.start('worker', { pause: 'verdict_committed', admission: false });
  await f.waitFor(() => fs.existsSync(marker('verdict_committed')), 'real capture/unit verdict COMMIT', 300000);
  assert.deepEqual(await identities(f, session.id), prepared);
  const verdict = (await f.pool.query('SELECT check_state, test_results FROM chat_sessions WHERE id = $1', [session.id])).rows[0];
  assert.ok(['passing', 'failing'].includes(verdict.check_state));
  assert.equal(verdict.test_results.find(result => result.index === -3)?.status, 'pass');
  if (verdict.check_state === 'failing') {
    assert.ok(verdict.test_results.some(result => result.consoleErrors?.some(error =>
      error.source?.endsWith('/favicon.ico'))), 'Keep the sample app’s actual console failure');
  }
  const receipt = (await f.pool.query('SELECT * FROM cli_check_settlement_receipts WHERE session_id = $1', [session.id])).rows[0];
  assert.ok(receipt);
  const history = (await f.pool.query('SELECT * FROM app_check_history WHERE app_id = $1 ORDER BY check_key', [app.id])).rows;
  const gates = (await f.pool.query(`SELECT * FROM execution_work_requests WHERE workflow = 'native-cli-check-gate'
    AND session_id = $1`, [session.id])).rows;
  assert.equal(gates.length, 1);
  const policy = verdict.check_state === 'passing' ? 'merge' : 'bot';
  assert.equal(gates[0].input.gate, policy);
  assert.notEqual(gates[0].status, 'succeeded', 'Required gate remains owned before the final recovery');
  const checks = (await f.pool.query('SELECT * FROM check_runs WHERE session_id = $1', [session.id])).rows[0];
  assert.ok(checks?.manifest.durableCli);
  const jobs = await require('../src/services/kubernetes').findCheckJobs(f.fixture.config, {
    sessionId: session.id, previewRunId: checks.run_id,
  });
  assert.ok(jobs.capture && jobs.unitSuite);
  await f.stop(worker);
  await f.stop(web);
  web = await f.start('web', { admission: false });
  origin = await f.healthy(web);

  // Recovery closes original checks and delivers the retained gate exactly once.
  fs.writeFileSync(path.join(f.evidence, 'allow-gate'), 'fixture dependency recovered');
  worker = await f.start('worker', { admission: false });
  await f.waitFor(async () => {
    const row = (await f.pool.query(`SELECT status FROM execution_work_requests WHERE id = $1`, [handoff.continuation_work_id])).rows[0];
    const gate = (await f.pool.query(`SELECT status, last_code FROM execution_work_requests WHERE id = $1`, [gates[0].id])).rows[0];
    return row.status === 'succeeded' && gate.status === 'succeeded' && gate.last_code === 'gate_delivered';
  }, 'durable continuation and gate delivery', 300000);
  assert.deepEqual(await identities(f, session.id), prepared);
  assert.deepEqual((await f.pool.query('SELECT check_state, test_results FROM chat_sessions WHERE id = $1', [session.id])).rows[0], verdict);
  assert.deepEqual((await f.pool.query('SELECT * FROM app_check_history WHERE app_id = $1 ORDER BY check_key', [app.id])).rows, history);
  assert.deepEqual((await f.pool.query('SELECT * FROM cli_check_settlement_receipts WHERE session_id = $1', [session.id])).rows[0], receipt);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM check_runs WHERE session_id = $1', [session.id])).rows[0].n, 0);
  await serving.assertHealthy();
  const events = fs.readFileSync(path.join(f.evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.filter(event => event.kind === 'entry_preloaded').every(event => event.detail.uid === 1000));
  assert.equal(events.filter(event => event.kind === `${policy}_policy_invoked`).length, 1);
  const otherPolicy = policy === 'merge' ? 'bot' : 'merge';
  assert.equal(events.filter(event => event.kind === `${otherPolicy}_policy_invoked`).length, 0);
  assert.equal(events.filter(event => event.kind === 'activation_written').length, 1);
  const createdJobs = events.filter(event => event.kind === 'job_created');
  assert.equal(createdJobs.length, 2, 'Recovery creates neither another capture nor another companion Job');
  assert.deepEqual(createdJobs.map(event => event.detail.uid).sort(), [jobs.capture.uid, jobs.unitSuite.uid].sort());
  assert.ok(createdJobs.every(event => event.detail.runId === checks.run_id));
  fs.writeFileSync(path.join(f.directory, 'result.json'), JSON.stringify({
    freshInventory,
    verdict: verdict.check_state,
    policy,
    tuple: {
      revision: f.revision,
      backendImageId: f.backendImageId,
      builderImage: f.fixture.config.kubernetes.builderImage,
      captureImage: f.fixture.config.kubernetes.captureImage,
      unitImage: f.fixture.config.kubernetes.workerImage,
      sourceRevision: f.fixture.preparationSource.revision,
      unitRevision: f.fixture.checks.unitSuite.revision,
    },
    sessionId: session.id,
    workId: admission.workId,
    continuationId: handoff.continuation_work_id,
    gateId: gates[0].id,
    checkRunId: checks.run_id,
    checkJobs: jobs,
    identities: prepared,
  }, null, 2), { mode: 0o600 });
});
