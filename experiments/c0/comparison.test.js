'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { Client } = require('pg');
const { TestWorkflowEnvironment } = require('@temporalio/testing');
const { Worker } = require('@temporalio/worker');
const { createDatabase } = require('./database');
const { createResources } = require('./resources');
const { createPreviewFlow } = require('../../src/services/preview-flow');
const { createProposalReview } = require('../../src/services/proposal-review/store');
const { STAGING_BUILD_LOCK } = require('../../src/services/advisory-locks');

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = path.join(__dirname, '.artifacts');

async function waitFor(read, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(30);
  }
  throw new Error(`Timed out: ${description}`);
}

async function startChild(filename, config, extra = {}) {
  const logPath = path.join(artifacts, `${filename}-${Date.now()}-${randomUUID()}.log`);
  const log = fs.createWriteStream(logPath);
  const child = fork(path.join(__dirname, filename), [], {
    env: { ...process.env, C0_CONFIG: JSON.stringify(config), ...extra },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('exit', () => log.end());
  child.ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code, signal) => reject(new Error(`${filename} exited ${code || signal}; see ${logPath}`)));
  });
  child.stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  };
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    child.info = await child.ready;
  } finally {
    clearTimeout(timer);
  }
  return child;
}

// Both lanes use real PostgreSQL, the B2 action runtime and the same candidate
// adapters. Temporal uses a real local service and SDK, not mocked scheduling.
// External resources are a separate, controlled service; no production cluster
// access, Docker containers or database-clone redaction run in this experiment.
test('C0: execution backends face the same failure scenarios', async t => {
  assert.ok(process.env.C0_DATABASE_URL, 'C0_DATABASE_URL is required; this comparison must not silently skip');
  assert.ok(process.env.C0_TEMPORAL_CLI, 'C0_TEMPORAL_CLI must point to a recorded CLI version');
  fs.mkdirSync(artifacts, { recursive: true });
  const database = await createDatabase(process.env.C0_DATABASE_URL);
  const { pool } = database;
  const resources = await createResources(pool);
  const children = new Set();
  let temporal;
  let sequence = 900000;
  const serverOptions = {
    ip: '127.0.0.1',
    dbFilename: path.join(artifacts, `temporal-${Date.now()}.sqlite`),
    executable: { type: 'existing-path', path: process.env.C0_TEMPORAL_CLI },
    extraArgs: ['--dynamic-config-value', 'matching.enableFairness=true'],
  };
  const config = {
    databaseUrl: database.url,
    resourcesUrl: resources.url,
    dataEncryptionKey: 'isolated-c0-fixture-key',
    appRuntime: 'kubernetes',
    kubernetes: { appNamespace: 'c0-fixture', appDomain: 'c0.invalid' },
    queue: `c0-${randomUUID()}`,
  };

  async function child(filename, extra) {
    const process = await startChild(filename, config, extra);
    children.add(process);
    return process;
  }

  async function seed() {
    const sessionId = ++sequence;
    await pool.query(`INSERT INTO chat_sessions (id, checks_commit_sha, reviewed_head_sha,
      staging_url, staging_runtime_kind, staging_runtime_name, staging_commit_sha)
      VALUES ($1, $2, $2, 'https://old.c0.invalid', 'kubernetes', 'old-serving', $2)`, [sessionId, HEAD]);
    await pool.query(`INSERT INTO c0_objects VALUES ($1, $2, 'route', $3, $4)`, [
      `route-${sessionId}`, randomUUID(), randomUUID(), JSON.stringify({ target: 'old-serving', token: '0' }),
    ]);
    return sessionId;
  }

  async function request(web, backend, options = {}) {
    const sessionId = options.sessionId || await seed();
    const input = { sessionId, headSha: HEAD, actionId: randomUUID(), backend, ...options };
    const response = await fetch(`http://127.0.0.1:${web.info.port}`, { method: 'POST', body: JSON.stringify(input) });
    const admitted = await response.json();
    assert.equal(response.status, 200, JSON.stringify(admitted));
    assert.equal(admitted.accepted, true, JSON.stringify(admitted));
    const work = (await pool.query('SELECT input FROM c0_work WHERE id = $1', [admitted.id])).rows[0].input;
    return { ...work, request: input };
  }

  const fault = (work, policy) => pool.query(`INSERT INTO c0_faults VALUES ($1, $2)
    ON CONFLICT (work_id) DO UPDATE SET policy = EXCLUDED.policy`, [work.id, JSON.stringify(policy)]);
  const row = async work => (await pool.query('SELECT * FROM c0_work WHERE id = $1', [work.id])).rows[0];
  const object = async name => (await pool.query('SELECT * FROM c0_objects WHERE name = $1', [name])).rows[0];
  const events = async (work, kind) => (await pool.query('SELECT * FROM c0_events WHERE work_id = $1 AND kind = $2 ORDER BY id', [work.id, kind])).rows;
  const done = work => waitFor(async () => (await row(work)).done, `finish ${work.id}`, 30000);
  const created = (work, kind) => waitFor(async () => (await events(work, 'created')).find(value => value.detail.kind === kind), `create ${kind}`);
  const binding = work => object(`route-${work.sessionId}`);
  const completeJob = work => pool.query(`UPDATE c0_objects SET body = body || '{"state":"complete"}' WHERE name = $1`, [`${work.intent.runtimeName}-build`]);

  try {
    temporal = await TestWorkflowEnvironment.createLocal({ server: serverOptions });
    config.temporalAddress = temporal.address;
    serverOptions.port = Number(temporal.address.split(':').at(-1));
    const info = await temporal.client.workflowService.getSystemInfo({});
    console.log(`Temporal server ${info.serverVersion}; real PostgreSQL; controlled resource transport`);

    for (const backend of ['bounded', 'temporal']) {
      await t.test(backend, async lane => {
        let web = await child('web.js');
        let worker;
        let dispatcher;
        const startWorker = async (version = 1) => child(backend === 'bounded' ? 'bounded.js' : 'temporal-worker.js', { C0_VERSION: String(version) });
        const stopWorker = async () => { if (worker) await worker.stop(); };
        const restart = async () => { await stopWorker(); worker = await startWorker(); };

        try {
          await lane.test('committed handoff, web restart, duplicate request/start and backend outage', async () => {
            const work = await request(web, backend);
            assert.equal((await row(work)).done, false);
            await web.stop();
            web = await child('web.js');
            const replay = await request(web, backend, work.request);
            assert.equal(replay.id, work.id);
            assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM c0_work WHERE id = $1', [work.id])).rows[0].n, 1);
            if (backend === 'temporal') {
              await temporal.teardown();
              dispatcher = await child('dispatch.js', { C0_LOSE_START_ACK: 'true' });
              await waitFor(async () => (await events(work, 'dispatch_retry')).length, 'unavailable backend retry');
              assert.equal((await row(work)).dispatched, false);
              temporal = await TestWorkflowEnvironment.createLocal({ server: serverOptions });
            }
            worker = await startWorker();
            await done(work);
            assert.equal((await binding(work)).body.target, work.intent.runtimeName);
            if (backend === 'temporal') {
              await waitFor(async () => (await row(work)).dispatched && (await events(work, 'duplicate_start')).length,
                'lost start acknowledgement is deduplicated and handoff settles');
            }
          });

          await lane.test('retryable I/O is retried; failing verdict is a result, not a retry', async () => {
            await stopWorker();
            const work = await request(web, backend);
            await fault(work, { ioFailures: 1, failingTest: true });
            worker = await startWorker();
            await done(work);
            assert.equal((await pool.query('SELECT check_state FROM chat_sessions WHERE id = $1', [work.sessionId])).rows[0].check_state, 'failing');
            assert.ok((await events(work, 'external_retry')).length);
            assert.equal((await events(work, 'created')).filter(value => value.detail.kind === 'check').length, 1);
          });

          await lane.test('clone creation before acknowledgement recovers credential and identity', async () => {
            await stopWorker();
            const work = await request(web, backend);
            await fault(work, { loseAckKind: 'clone' });
            worker = await startWorker();
            await done(work);
            const clone = await object(work.intent.dbName);
            assert.equal(clone.flow_id, work.id);
            assert.equal((await events(work, 'created')).filter(value => value.detail.kind === 'clone').length, 1);
            const state = await createPreviewFlow(pool).read(work.sessionId);
            assert.equal(state.resource.clonePrepared, true);
            const credential = (await pool.query('SELECT clone_credential_enc FROM preview_flow_resources WHERE flow_id = $1', [work.id])).rows[0].clone_credential_enc;
            assert.ok(credential.startsWith('v1:'));
          });

          await lane.test('partial clone is abandoned and never activated', async () => {
            await stopWorker();
            const work = await request(web, backend);
            await fault(work, { partialClone: true });
            worker = await startWorker();
            await waitFor(async () => (await events(work, 'cleanup_observation')).length, 'partial clone cleanup');
            assert.equal(await object(work.intent.dbName), undefined);
            assert.equal((await binding(work)).body.target, 'old-serving');
            assert.equal((await createPreviewFlow(pool).read(work.sessionId)).resource.clonePrepared, false);
          });

          await lane.test('lost activation acknowledgement is recovered by observation without activating twice', async () => {
            await stopWorker();
            const work = await request(web, backend);
            await fault(work, { loseActivationAck: true });
            worker = await startWorker();
            await done(work);
            assert.equal((await binding(work)).body.token, '1');
            const state = await createPreviewFlow(pool).read(work.sessionId);
            assert.equal(state.binding.desired.activationId, state.binding.observed.activationId);
          });

          await lane.test('supersession while an old external completion is in flight fences its report', async () => {
            await stopWorker();
            const old = await request(web, backend);
            await fault(old, { holdAckKind: 'Deployment', holdAckMs: 1500 });
            worker = await startWorker();
            await created(old, 'Deployment');
            const successor = await request(web, backend, { sessionId: old.sessionId });
            await done(successor);
            await waitFor(async () => (await events(old, 'cleanup_observation')).length, 'in-flight old result cleanup');
            const rejected = await pool.query(`SELECT 1 FROM preview_flow_decisions
              WHERE session_id = $1 AND action->>'type' = 'PreviewCandidatePrepared'
                AND action->>'flowId' = $2 AND decision->>'accepted' = 'false'`, [old.sessionId, old.id]);
            assert.ok(rejected.rowCount);
            assert.equal((await binding(successor)).body.target, successor.intent.runtimeName);
            assert.ok(await object(successor.intent.runtimeName));
          });

          await lane.test('worker termination adopts a surviving build Job and preserves serving preview', async () => {
            await stopWorker();
            const work = await request(web, backend);
            await fault(work, { holdBuild: true });
            worker = await startWorker();
            await created(work, 'build');
            const job = await object(`${work.intent.runtimeName}-build`);
            assert.equal((await binding(work)).body.target, 'old-serving');
            await stopWorker();
            await completeJob(work);
            worker = await startWorker();
            await done(work);
            assert.equal((await object(job.name)).uid, job.uid);
            assert.equal((await events(work, 'created')).filter(value => value.detail.kind === 'build').length, 1);
          });

          await lane.test('resource-lock loss stops only worker; creation before acknowledgement is adopted', async () => {
            await stopWorker();
            const work = await request(web, backend);
            await fault(work, { holdAckKind: 'Deployment', holdAckMs: 1500 });
            worker = await startWorker();
            await created(work, 'Deployment');
            const lock = (await events(work, 'resource_lock')).at(-1);
            const exited = new Promise(resolve => worker.once('exit', resolve));
            await pool.query('SELECT pg_terminate_backend($1)', [lock.detail.lockPid]);
            assert.equal(await exited, 86);
            assert.equal((await request(web, backend, work.request)).id, work.id, 'web remains alive');
            worker = await startWorker();
            await done(work);
            assert.equal((await events(work, 'created')).filter(value => value.detail.kind === 'Deployment').length, 1);
          });

          await lane.test('an expired execution lease does not transfer ownership of a still-running external attempt', async () => {
            await stopWorker();
            const work = await request(web, backend);
            await fault(work, { holdAckKind: 'Deployment', holdAckMs: 3000 });
            worker = await startWorker();
            await created(work, 'Deployment');
            worker.kill('SIGSTOP');
            const peer = await startWorker();
            try {
              await waitFor(async () => (await events(work, 'resource_busy')).length, 'retry encounters live old resource lock');
              worker.kill('SIGCONT');
              await done(work);
              assert.equal((await events(work, 'created')).filter(value => value.detail.kind === 'Deployment').length, 1);
              assert.equal((await binding(work)).body.token, '1');
            } finally {
              worker.kill('SIGCONT');
              await peer.stop();
            }
          });

          for (const headSha of [NEXT_HEAD, HEAD]) {
            await lane.test(`${headSha === HEAD ? 'same-SHA' : 'new-head'} supersession rejects old completion and cleanup preserves successor`, async () => {
              await stopWorker();
              const old = await request(web, backend);
              await fault(old, { holdBuild: true });
              worker = await startWorker();
              await created(old, 'build');
              await stopWorker();
              await pool.query('UPDATE chat_sessions SET checks_commit_sha = $2, reviewed_head_sha = $2 WHERE id = $1', [old.sessionId, headSha]);
              const successor = await request(web, backend, { sessionId: old.sessionId, headSha });
              await completeJob(old);
              worker = await startWorker();
              await done(successor);
              await waitFor(async () => (await events(old, 'cleanup_observation')).length, 'old flow cleanup');
              assert.equal((await binding(successor)).body.target, successor.intent.runtimeName);
              assert.equal(await object(old.intent.runtimeName), undefined);
              assert.ok(await object(successor.intent.runtimeName));
              const rejection = await createPreviewFlow(pool).apply({
                type: 'PreviewCandidatePrepared', actionId: randomUUID(), sessionId: old.sessionId,
                flowId: old.id, generation: old.flow.generation, headSha: old.flow.headSha,
                receipt: { commitSha: old.flow.headSha, stagingUrl: 'http://old:3000', runtimeKind: 'kubernetes',
                  runtimeName: old.intent.runtimeName, containerId: null,
                  imageRef: 'c0:image', buildRef: null, attemptId: old.flow.attemptId, physicalId: randomUUID() },
              });
              assert.equal(rejection.decision.accepted, false);
              assert.equal(rejection.decision.reason, 'superseded_flow');
            });
          }

          await lane.test('cancellation after accepted creation; absence remains discoverable and late resource is removed', async () => {
            await stopWorker();
            const old = await request(web, backend);
            await fault(old, { delayCreationKind: 'clone', delayCreationMs: 5000 });
            worker = await startWorker();
            await waitFor(async () => (await events(old, 'create_accepted')).some(value => value.detail.kind === 'clone'), 'accepted delayed clone');
            await stopWorker();
            const revoked = await createProposalReview(pool, { isBusy: () => false }).apply({
              type: 'RequestReturnToDevelopment', actionId: randomUUID(), sessionId: old.sessionId,
              userId: 1, actorUsername: 'c0',
            });
            assert.equal(revoked.decision.accepted, true);
            if (backend === 'temporal') await temporal.client.workflow.getHandle(`c0-${old.id}`).cancel();
            worker = await startWorker();
            await waitFor(async () => (await events(old, 'cleanup_observation')).length, 'absence cleanup');
            assert.equal(await object(old.intent.dbName), undefined, 'cleanup observed absence before delayed creation');
            assert.equal((await row(old)).done, false, 'retirement obligation remains discoverable');
            await created(old, 'clone');
            await waitFor(async () => !(await object(old.intent.dbName)), 'late clone reconciliation');
            const successor = await request(web, backend, { sessionId: old.sessionId, startedStatus: 'paused' });
            await done(successor);
            assert.equal((await binding(successor)).body.target, successor.intent.runtimeName);
            await delay(250);
            assert.ok(await object(successor.intent.runtimeName), 'repeated old cleanup preserves successor');
          });

          await lane.test('more than one batch: oldest 25 failing/busy, later work and new arrivals progress, then retries recover', async () => {
            await stopWorker();
            const blocked = [];
            const blocker = new Client({ connectionString: database.url });
            await blocker.connect();
            try {
              for (let index = 0; index < 25; index++) {
                const work = await request(web, backend);
                if (index % 2) {
                  const key = createHash('sha256').update(String(work.sessionId)).digest().readInt32BE(0);
                  await blocker.query('SELECT pg_advisory_lock($1, $2)', [STAGING_BUILD_LOCK, key]);
                } else {
                  await fault(work, { failAlways: true });
                }
                blocked.push(work);
              }
              const eligible = [];
              for (let index = 0; index < 6; index++) eligible.push(await request(web, backend));
              worker = await startWorker();
              await Promise.all(eligible.map(done));
              const arrival = await request(web, backend);
              await done(arrival);
              for (let index = 0; index < blocked.length; index++) {
                const work = blocked[index];
                assert.equal((await row(work)).done, false);
                assert.ok((await events(work, index % 2 ? 'resource_busy' : 'external_retry')).length,
                  'blocked work has received attempts');
                await fault(work, {});
              }
            } finally {
              await blocker.end();
            }
            await Promise.all(blocked.map(done));
          });

          await lane.test('changed orchestration uses explicit version lanes; old executions remain resumable', async () => {
            await stopWorker();
            const old = await request(web, backend);
            await fault(old, { holdBuild: true });
            worker = await startWorker();
            await created(old, 'build');
            await stopWorker();
            const newer = await request(web, backend, { version: 2 });
            const v2 = await startWorker(2);
            try {
              await done(newer);
              assert.equal((await row(old)).done, false, 'new worker does not reinterpret old sequence');
              assert.ok((await events(newer, 'step')).some(value => value.detail.stage === 'audit'));
              await completeJob(old);
              worker = await startWorker();
              await done(old);
            } finally {
              await v2.stop();
            }
            if (backend === 'temporal') {
              const history = await temporal.client.workflow.getHandle(`c0-${old.id}`).fetchHistory();
              await Worker.runReplayHistory({ workflowsPath: require.resolve('./workflows') }, history);
              await assert.rejects(Worker.runReplayHistory({ workflowsPath: require.resolve('./incompatible-workflows') }, history),
                /nondetermin|replay|mismatch/i);
              console.log(`Replayed Temporal history with ${history.events.length} events; incompatible orchestration rejected`);
            }
          });

          await lane.test('execution identities correlate with durable domain decision journals', async () => {
            const { rows } = await pool.query(`SELECT e.work_id, e.detail, d.decision FROM c0_events e
              JOIN preview_flow_decisions d ON d.decision->'flow'->>'id' = e.work_id::text
              JOIN c0_work w ON w.id = e.work_id WHERE w.backend = $1 AND e.kind = 'step' LIMIT 1`, [backend]);
            assert.ok(rows.length);
            assert.ok(backend === 'bounded' ? rows[0].detail.token : rows[0].detail.runId);
            const sample = await pool.query(`SELECT 'execution' AS source, kind, detail FROM c0_events
              WHERE work_id = $1 ORDER BY id LIMIT 20`, [rows[0].work_id]);
            const decisions = await pool.query(`SELECT 'decision' AS source, action, decision FROM preview_flow_decisions
              WHERE session_id = (SELECT (input->>'sessionId')::int FROM c0_work WHERE id = $1) ORDER BY id`, [rows[0].work_id]);
            fs.writeFileSync(path.join(artifacts, `${backend}-trace.json`), JSON.stringify({
              workId: rows[0].work_id,
              execution: sample.rows,
              decisions: decisions.rows,
            }, null, 2));
          });
        } finally {
          await stopWorker();
          if (dispatcher) await dispatcher.stop();
          await web.stop();
        }
      });
    }
  } finally {
    for (const process of children) await process.stop();
    if (temporal) await temporal.teardown();
    await resources.close();
    await database.close();
  }
});
