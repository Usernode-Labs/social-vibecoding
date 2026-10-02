'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { packagedFixture } = require('./lib/packaged-cli-fixture');
const { seed, inspectFreshStore, servingPreview, identities, migrate } = require('./lib/packaged-cli-scenarios');
const { SUCCESSIVE_REVISIONS } = require('./lib/isolated-kpack-fixture');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const { randomUUID } = require('node:crypto');

function notFound(error) {
  return error?.code === 404 || error?.response?.statusCode === 404;
}

async function assertReleased(f, resource) {
  assert.ok(resource.dependencies_released_at);
  assert.equal((await f.pool.query('SELECT oid FROM pg_database WHERE datname = $1', [resource.intent.dbName])).rows.length, 0);
  for (const kind of ['deployment', 'service', 'secret']) {
    const api = kind === 'deployment' ? f.clients.apps : f.clients.core;
    const method = { deployment: 'readNamespacedDeployment', service: 'readNamespacedService', secret: 'readNamespacedSecret' }[kind];
    await assert.rejects(api[method]({ namespace: resource.intent.namespace,
      name: kind === 'secret' ? `${resource.intent.runtimeName}-env` : resource.intent.runtimeName }), notFound);
  }
  const pods = await f.clients.core.listNamespacedPod({ namespace: resource.intent.namespace,
    labelSelector: `social.usernode.io/runtime-name=${resource.intent.runtimeName}` });
  assert.equal(pods.items.length, 0);
  for (const consumer of Object.values(resource.consumer_releases)) {
    assert.ok(consumer.retirement);
    for (const job of consumer.retirement.jobs) {
      assert.equal(job.stage, 'released');
      await assert.rejects(f.clients.core.readNamespacedSecret({ namespace: consumer.retirement.namespace,
        name: job.input.name }), notFound);
    }
  }
  // A released dependency is not proof of creator closure. Keep both locators
  // and the original recurring owner, without authorizing a competing executor.
  const work = (await f.pool.query(`SELECT * FROM execution_work_requests
    WHERE workflow = 'native-preview-retire' AND input->>'flowId' = $1`, [resource.flow_id])).rows;
  assert.equal(work.length, 1);
  assert.ok(['queued', 'running'].includes(work[0].status));
}

test('five real CLI revisions release published predecessors through the existing owner', {
  skip: process.env.RUN_ISOLATED_PREDECESSOR_TEST !== '1', timeout: 1800000,
}, async t => {
  const f = await packagedFixture(t);
  await migrate(f);
  const fresh = await inspectFreshStore(f);
  const { app, session, token } = await seed(f);
  const sentinel = await servingPreview(f, session, app);
  const owner = createPreviewFlow(f.pool);
  const evidence = [];
  let web;
  let worker;
  let previous;
  fs.writeFileSync(path.join(f.evidence, 'allow-gate'), 'fixture-only substituted policy');

  async function bindingTarget() {
    const ingress = await f.clients.networking.readNamespacedIngress({ namespace: sentinel.ref.namespace, name: sentinel.ref.runtimeName });
    assert.equal(ingress.metadata.uid, sentinel.binding.metadata.uid);
    return ingress.spec.rules[0].http.paths.find(value => value.path === '/').backend.service.name;
  }

  async function healthyCandidate(tuple) {
    const actual = await f.clients.apps.readNamespacedDeployment({ namespace: f.fixture.config.kubernetes.appNamespace, name: tuple.runtimeName });
    assert.equal(actual.metadata.uid, tuple.uids.deployment);
    const health = await f.clients.core.connectGetNamespacedServiceProxyWithPath({
      namespace: f.fixture.config.kubernetes.appNamespace, name: `${tuple.runtimeName}:3000`, path: 'health',
    });
    assert.equal(health.trim(), 'Ok');
  }

  async function startWeb(revision) {
    if (web) await f.stop(web);
    web = await f.start('web', { sourceRevision: revision });
    return f.healthy(web);
  }

  for (const [index, revision] of SUCCESSIVE_REVISIONS.entries()) {
    const origin = await startWeb(revision);
    // Upload/auth metadata is fixture input. Admission itself is real HTTP and
    // preserves the platform's managed-head and authorization checks.
    await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $2 WHERE id = $1', [session.id, revision]);
    const response = await fetch(`${origin}/api/sessions/${session.id}/proposal-handoff/build`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ schemaVersion: 1, headSha: revision, history: [] }),
    });
    const admission = await response.json();
    assert.equal(response.status, 202, JSON.stringify(admission));
    assert.equal(await bindingTarget(), previous?.runtimeName || sentinel.intent.runtimeName);
    if (previous) await healthyCandidate(previous);
    await sentinel.assertHealthy();

    if (index === 1) {
      const oldRun = (await f.pool.query('SELECT * FROM check_runs WHERE session_id = $1', [session.id])).rows[0];
      assert.ok(oldRun, 'Successor admission overlaps the original checks manifest');
      const jobs = await require('../src/services/kubernetes').findCheckJobs(f.fixture.config, { sessionId: session.id, previewRunId: oldRun.run_id });
      assert.ok(jobs.capture && jobs.unitSuite);
      const pods = await f.clients.core.listNamespacedPod({ namespace: f.fixture.isolation.namespace.name, labelSelector: `job-name=${jobs.capture.name}` });
      assert.ok(pods.items.some(pod => !['Succeeded', 'Failed'].includes(pod.status?.phase)), 'Original checks have a real live consumer');
      evidence[0].overlap = { runId: oldRun.run_id, jobs };
    }

    // Candidate COMMIT precedes activation; each source/clone/Build/runtime is
    // real. Lose the worker here, then adopt the exact same resource identities.
    const marker = path.join(f.evidence, 'candidate_committed.json');
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    worker = await f.start('worker', { pause: 'candidate_committed', sourceRevision: revision });
    await f.waitFor(() => fs.existsSync(marker), `candidate ${index + 1}`, 600000);
    const prepared = await identities(f, session.id);
    const resource = (await f.pool.query(`SELECT r.* FROM preview_flow_resources r
      JOIN preview_flow_heads h ON h.flow_id = r.flow_id WHERE h.session_id = $1`, [session.id])).rows[0];
    const handoff = (await f.pool.query('SELECT * FROM cli_preview_handoffs WHERE session_id = $1', [session.id])).rows[0];
    assert.equal(await bindingTarget(), previous?.runtimeName || sentinel.intent.runtimeName);
    if (previous) await healthyCandidate(previous);
    await f.stop(worker);

    const checksMarker = path.join(f.evidence, 'checks_created.json');
    if (fs.existsSync(checksMarker)) fs.unlinkSync(checksMarker);
    worker = await f.start('worker', {
      sourceRevision: revision, admission: false,
      ...(index === 0 ? { pause: 'checks_created', holdChecks: true } : {}),
    });
    if (index === 0) {
      await f.waitFor(() => fs.existsSync(checksMarker), 'original overlapping checks', 300000);
      await f.stop(worker); // Original Jobs survive this real process loss.
    } else {
      await f.waitFor(async () => {
        const work = (await f.pool.query('SELECT status FROM execution_work_requests WHERE id = $1', [handoff.continuation_work_id])).rows[0];
        return work.status === 'succeeded';
      }, `checks and continuation ${index + 1}`, 300000);
      assert.deepEqual(await identities(f, session.id), prepared, 'Recovery preserves OID, Build UID/digest and runtime UIDs');
      assert.equal(await bindingTarget(), prepared.runtimeName);
      await healthyCandidate(prepared);
      // Let the same retirement owner release the predecessor before the next
      // admission. No direct deletion or fabricated success observation here.
      await f.waitFor(async () => {
        const old = (await f.pool.query(`SELECT * FROM preview_flow_resources
          WHERE session_id = $1 AND published_at IS NOT NULL AND flow_id <> $2`, [session.id, resource.flow_id])).rows;
        return old.every(row => row.dependencies_released_at);
      }, `predecessor release ${index + 1}`, 300000);
      const old = (await f.pool.query(`SELECT * FROM preview_flow_resources
        WHERE session_id = $1 AND published_at IS NOT NULL AND flow_id <> $2`, [session.id, resource.flow_id])).rows;
      for (const row of old) await assertReleased(f, row);
      const decision = await owner.apply({ type: 'RequestPreviewCleanup', actionId: randomUUID(), sessionId: session.id, flowId: resource.flow_id });
      assert.equal(decision.decision.reason, 'resource_bound');
      await f.stop(worker);
    }
    evidence.push({ revision, flowId: resource.flow_id, preparation: admission.workId, continuation: handoff.continuation_work_id, prepared });
    previous = prepared;
  }

  assert.equal(evidence.length, 5);
  assert.equal(new Set(evidence.map(row => row.flowId)).size, 5);
  const resources = (await f.pool.query('SELECT * FROM preview_flow_resources WHERE session_id = $1 ORDER BY recorded_at', [session.id])).rows;
  assert.equal(resources.length, 5);
  assert.equal(resources.filter(row => row.dependencies_released_at).length, 4);
  assert.equal((await owner.read(session.id)).retainedPublishedAttempts, 1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM check_runs WHERE session_id = $1', [session.id])).rows[0].n, 0);
  await healthyCandidate(previous);
  await sentinel.assertHealthy();
  const events = fs.readFileSync(path.join(f.evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.kind === 'job_created').length, 10, 'Exactly one capture and companion per revision');
  fs.writeFileSync(path.join(f.directory, 'successive-revisions.json'), JSON.stringify({ fresh, evidence, backendImageId: f.backendImageId,
    releases: resources.map(row => ({ flowId: row.flow_id, dependenciesReleased: row.dependencies_released_at, consumerReleases: row.consumer_releases })) }, null, 2), { mode: 0o600 });
});
