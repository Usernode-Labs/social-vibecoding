'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { prepareNativePreview } = require('../src/services/preview-flow/native');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const { createCleanup, FLOW_LABEL } = require('../src/services/preview-flow/cleanup');
const { createGuard } = require('../src/services/build-retention-guard');
const { STAGING_BUILD_LOCK, PREVIEW_LIFECYCLE_LOCK } = require('../src/services/advisory-locks');
const runtime = require('../src/services/application-runtime');
const docker = require('../src/services/docker');
const kubernetes = require('../src/services/kubernetes');

const HEAD = 'a'.repeat(40);
const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('cleanup recovery runs at startup and independently of auto-pause, skips overlapping ticks and drains on stop', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let queries = 0;
  let gate;
  const pool = {
    query: async () => {
      queries++;
      if (gate) await gate.promise;
      return { rows: [] };
    },
  };
  const cleanup = createCleanup();
  await cleanup.start({ pool, config: { sessionAutopauseIdleMs: 0 } });
  assert.equal(queries, 2);
  gate = deferred();
  t.mock.timers.tick(60000);
  await Promise.resolve();
  assert.equal(queries, 3);
  t.mock.timers.tick(120000);
  assert.equal(queries, 3, 'no overlapping census while a sweep is in flight');
  gate.resolve();
  await cleanup.stop();
  t.mock.timers.tick(60000);
  assert.equal(queries, 4);
});

test('server starts native resource recovery under leader duties and drains it before the pool closes', () => {
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.match(source, /preview-flow\/cleanup'\)\.start\(\{ pool: getPool\(config\), config \}\)/);
  assert.match(source, /previewCleanupStop = require\('\.\/src\/services\/preview-flow\/cleanup'\)\.stop\(\)/);
  assert.match(source, /Promise\.all\(\[retentionStop, previewCleanupStop, scorerStop\]\)\.then\(\(\) => shutdownPool\.end\(\)\)/);
});

test('native cleanup across Docker and Kubernetes with independent PostgreSQL resource locks', { skip: !databaseUrl }, async t => {
  const root = new Pool({ connectionString: databaseUrl });
  const schema = `preview_cleanup_test_${process.pid}`;
  await root.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: scoped.toString(), max: 8 });
  const priorLifecycle = process.env.PREVIEW_LIFECYCLE_ENABLED;
  process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
  try {
    await pool.query(`CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, status TEXT,
      source TEXT, checks_commit_sha TEXT, reviewed_head_sha TEXT, staging_url TEXT,
      staging_container_id TEXT, staging_runtime_kind TEXT, staging_runtime_name TEXT,
      staging_image_ref TEXT, staging_build_ref TEXT, staging_commit_sha TEXT, last_activity_at TIMESTAMPTZ)`);
    const source = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
    for (const table of ['preview_flows', 'preview_bindings', 'preview_flow_heads', 'preview_flow_resources',
      'preview_action_receipts', 'preview_flow_decisions']) {
      await pool.query(source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0]);
    }
    for (const runtimeKind of ['docker', 'kubernetes']) {
      await t.test(runtimeKind, async t => {
        const config = {
          appRuntime: runtimeKind,
          databaseUrl: scoped.toString(),
          kubernetes: { appNamespace: 'test-apps' },
        };
        const intent = {
          runtimeKind,
          runtimeName: 'shared-preview',
          dbName: 'app_demo_staging_s1_aaaaaa',
          namespace: runtimeKind === 'kubernetes' ? 'test-apps' : null,
        };
        const receipt = {
          runtimeKind,
          runtimeName: intent.runtimeName,
          containerId: runtimeKind === 'docker' ? intent.runtimeName : null,
          commitSha: HEAD,
          stagingUrl: 'https://preview.example.test',
          imageRef: 'image:exact',
          buildRef: null,
        };
        let liveFlow;
        let removeFails;
        let inspectFails;
        let dropFails;
        let removeGate;
        let removals;
        let drops;
        let creates;
        let deletedKinds;

        function inspect() {
          if (inspectFails) throw new Error('runtime inspection unavailable');
          if (!liveFlow) return { status: 'not_found', labels: {} };
          return {
            status: 'running',
            labels: liveFlow === 'legacy-owner' ? {} : { [FLOW_LABEL]: liveFlow },
          };
        }

        t.mock.method(docker, 'inspectContainer', async name => {
          assert.equal(name, intent.runtimeName);
          return inspect();
        });
        t.mock.method(docker, 'stopAndRemove', async name => {
          assert.equal(name, intent.runtimeName);
          removals++;
          if (removeGate) {
            removeGate.entered.resolve();
            await removeGate.finish.promise;
          }
          if (removeFails) return { removed: false, error: 'docker removal unavailable' };
          liveFlow = null;
          return { removed: true };
        });
        // Exercise application-runtime's real Kubernetes inspect/remove adapters
        // and deleteApplication's Deployment/Service/Ingress/Secret deletion.
        kubernetes._setClientsForTest({
          apps: {
            readNamespacedDeployment: async ({ name, namespace }) => {
              assert.equal(name, intent.runtimeName);
              assert.equal(namespace, intent.namespace);
              const state = inspect();
              if (state.status === 'not_found') throw { code: 404 };
              return {
                metadata: { uid: liveFlow, generation: 1 },
                spec: { template: { metadata: { labels: state.labels } } },
                status: {},
              };
            },
            deleteNamespacedDeployment: async args => {
              deletedKinds.push('deployment');
              removals++;
              assert.equal(args.namespace, intent.namespace);
              if (removeGate) {
                removeGate.entered.resolve();
                await removeGate.finish.promise;
              }
              if (removeFails) throw new Error('kubernetes deletion unavailable');
              if (liveFlow && args.body) assert.equal(args.body.preconditions.uid, liveFlow);
              liveFlow = null;
            },
          },
          core: {
            deleteNamespacedService: async () => { deletedKinds.push('service'); },
            deleteNamespacedSecret: async () => { deletedKinds.push('secret'); },
          },
          networking: {
            deleteNamespacedIngress: async () => { deletedKinds.push('ingress'); },
          },
        });

        const guard = createGuard({ retryMs: 5 });
        const rivalGuard = createGuard({ retryMs: 5 });
        const cleanup = createCleanup({
          runtime,
          lock: guard.withResourceUse,
          db: {
            dropDatabase: async (name, options) => {
              assert.equal(name, intent.dbName);
              assert.equal(options.strict, true);
              drops++;
              if (dropFails) throw new Error('database drop unavailable');
            },
          },
        });
        const owner = createPreviewFlow(pool);

        async function reset() {
          await pool.query('TRUNCATE chat_sessions, preview_flow_resources CASCADE');
          await pool.query('TRUNCATE preview_action_receipts CASCADE');
          await pool.query(`INSERT INTO chat_sessions (id, status, source, checks_commit_sha)
            VALUES (1, 'active', 'cli_handoff', $1)`, [HEAD]);
          liveFlow = null;
          removeFails = false;
          inspectFails = false;
          dropFails = false;
          removeGate = null;
          removals = 0;
          drops = 0;
          creates = 0;
          deletedKinds = [];
        }

        async function resourceRow() {
          const { rows } = await pool.query('SELECT * FROM preview_flow_resources ORDER BY recorded_at');
          return rows[0];
        }

        function makeExecutor(afterDeploy = async () => {}, buildGuard = guard) {
          return async (_config, _session, _app, _head, options) => {
            return buildGuard.withResourceUse(config, STAGING_BUILD_LOCK, 1, async () => {
              await options.beforeBuild(intent);
              creates++;
              liveFlow = options.previewFlow.flowId;
              await afterDeploy(options);
              await options.consumePrepared(receipt);
              return receipt;
            }, { allRuntimes: true });
          };
        }

        function preparePreview(db = pool, build = makeExecutor()) {
          return prepareNativePreview({
            pool: db,
            config,
            session: { id: 1, status: 'active' },
            headSha: HEAD,
            build,
            cleanup: cleanup.underBuildLock,
          });
        }

        async function archiveSession() {
          await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = 1`);
        }

        function poolWithQueryFailure(predicate, message, afterExecution = false) {
          return {
            query: async (sql, args) => {
              if (predicate(String(sql), args)) throw new Error(message);
              return pool.query(sql, args);
            },
            connect: async () => {
              const client = await pool.connect();
              return {
                release: () => client.release(),
                query: async (sql, args) => {
                  if (predicate(String(sql), args)) {
                    if (afterExecution) await client.query(sql, args);
                    throw new Error(message);
                  }
                  return client.query(sql, args);
                },
              };
            },
          };
        }

        async function seedCleanupQueue(count) {
          const entries = [];
          for (let i = 0; i < count; i++) {
            const entry = {
              flowId: randomUUID(),
              sessionId: 1000 + i,
              intent: {
                runtimeKind,
                runtimeName: `batch-${runtimeKind}-${i}`,
                dbName: `app_batch_staging_s${1000 + i}_aaaaaa`,
                namespace: intent.namespace,
              },
            };
            entries.push(entry);
            await pool.query(`INSERT INTO preview_flow_resources (flow_id, session_id, intent)
              VALUES ($1, $2, $3)`, [entry.flowId, entry.sessionId, JSON.stringify(entry.intent)]);
          }
          return entries;
        }

        function queueOwner(entries, removedIds, droppedNames, fails = () => false) {
          const byName = new Map(entries.map(entry => [entry.intent.runtimeName, entry]));
          return createCleanup({
            lock: guard.withResourceUse,
            runtime: {
              inspect: async (_config, ref) => ({
                status: 'running',
                labels: { [FLOW_LABEL]: byName.get(ref.runtimeName).flowId },
              }),
              remove: async (_config, ref) => {
                const id = byName.get(ref.runtimeName).flowId;
                if (fails(id)) throw new Error('old resource remains unavailable');
                removedIds.add(id);
                return { removed: true };
              },
            },
            db: {
              dropDatabase: async name => {
                droppedNames.add(name);
              },
            },
          });
        }

        for (const blockage of ['failing', 'busy']) {
          await t.test(
            `fair batches process later resources while the oldest 25 stay ${blockage}, then retry the older obligations`,
            async () => {
              await reset();
              const batchSize = 25;
              const entries = await seedCleanupQueue(60);
              const oldIds = new Set(entries.slice(0, batchSize).map(entry => entry.flowId));
              const removedIds = new Set();
              const droppedNames = new Set();
              let stillFailing = blockage === 'failing';
              const fairOwner = () => queueOwner(entries, removedIds, droppedNames,
                id => stillFailing && oldIds.has(id));
              const entered = deferred();
              const release = deferred();
              let enteredCount = 0;
              let held = Promise.resolve();
              if (blockage === 'busy') {
                const classifier = runtimeKind === 'kubernetes' ? PREVIEW_LIFECYCLE_LOCK : STAGING_BUILD_LOCK;
                held = Promise.all(entries.slice(0, batchSize).map(entry =>
                  rivalGuard.withResourceUse(config, classifier, entry.sessionId, async () => {
                    if (++enteredCount === batchSize) entered.resolve();
                    await release.promise;
                  }, { allRuntimes: true })));
                await entered.promise;
              }

              try {
                // Re-create the owner for every pass, like a leader restart. The
                // queue's progress must live in PostgreSQL, not in a local cursor.
                const first = await fairOwner().sweep({ pool, config });
                assert.equal(first.length, batchSize);
                assert.ok(first.every(result => blockage === 'busy' ? result.busy : result.pending));
                assert.equal(removedIds.size, 0);
                for (let pass = 0; pass < 2; pass++) {
                  const result = await fairOwner().sweep({ pool, config });
                  assert.ok(result.length <= batchSize, 'each pass stays bounded');
                }
                assert.equal(removedIds.size, 35, 'all later eligible resources cleaned across subsequent batches');
                assert.ok(entries.slice(batchSize).every(entry => removedIds.has(entry.flowId)));
                assert.equal(droppedNames.size, 35);
                const earlier = (await pool.query(`SELECT flow_id, cleanup_started_at, cleanup_completed_at
                  FROM preview_flow_resources WHERE session_id < $1`, [1000 + batchSize])).rows;
                assert.equal(earlier.length, batchSize);
                assert.ok(earlier.every(row => row.cleanup_completed_at === null), 'earlier obligations remain pending');
                if (blockage === 'busy') {
                  assert.ok(earlier.every(row => row.cleanup_started_at === null),
                    'queue selection does not grant resource ownership or claim retirement');
                }
              } finally {
                release.resolve();
                await held;
              }

              stillFailing = false;
              const retried = await fairOwner().sweep({ pool, config });
              assert.equal(retried.length, batchSize);
              assert.ok(retried.every(result => result.disposition === 'removed'));
              assert.equal(removedIds.size, 60, 'the oldest obligations still succeed when the blockage clears');
              assert.equal(droppedNames.size, 60);
            },
          );
        }

        await t.test('interruption after bounded selection commits preserves queue progress and every pending obligation', async () => {
          await reset();
          const entries = await seedCleanupQueue(110);
          const removedIds = new Set();
          const droppedNames = new Set();
          const freshOwner = () => queueOwner(entries, removedIds, droppedNames);
          let selected;
          // The DB committed selection, but the caller dies/loses its response
          // before taking any runtime lock. Recovery uses no process-local cursor.
          const lostSelection = {
            query: async (...args) => {
              selected = (await pool.query(...args)).rows;
              throw new Error('selection acknowledgement lost');
            },
          };
          await assert.rejects(freshOwner().sweep({ pool: lostSelection, config, limit: 1000 }),
            /selection acknowledgement lost/);
          assert.equal(selected.length, 100, 'oversized batches are bounded to 100');
          assert.equal(removedIds.size, 0);
          const pending = (await pool.query(`SELECT cleanup_started_at, cleanup_completed_at
            FROM preview_flow_resources`)).rows;
          assert.equal(pending.length, 110);
          assert.ok(pending.every(row => !row.cleanup_started_at && !row.cleanup_completed_at),
            'selection alone neither authorizes deletion nor marks an obligation completed');
          const next = await freshOwner().sweep({ pool, config });
          assert.equal(next.length, 25);
          assert.ok(entries.slice(100).every(entry => removedIds.has(entry.flowId)),
            'later eligible resources get a turn even after selection is interrupted');
          const rest = await freshOwner().sweep({ pool, config, limit: 1000 });
          assert.equal(rest.length, 85);
          assert.ok(rest.every(result => result.disposition === 'removed'));
          assert.equal(removedIds.size, 110, 'all interrupted obligations remain recoverable');
          assert.equal(droppedNames.size, 110);
        });

        await t.test('rejected publication deletes its own runtime and clone without restoring a public link', async () => {
          await reset();
          const result = await preparePreview(pool, makeExecutor(async () => {
            await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = 1`);
          }));
          assert.equal(result.accepted, false);
          assert.equal(removals, 1);
          assert.equal(drops, 1);
          assert.equal(liveFlow, null);
          assert.equal((await resourceRow()).cleanup_disposition, 'removed');
          assert.equal((await owner.read(1)).preview.stagingUrl, null);
          if (runtimeKind === 'kubernetes') assert.deepEqual(deletedKinds.sort(), ['deployment', 'ingress', 'secret', 'service']);
          const decisions = await owner.trace(1);
          assert.deepEqual(decisions.slice(-2).map(entry => entry.action.type),
            ['RequestPreviewCleanup', 'PreviewCleanupCompleted']);
          assert.equal(decisions.at(-2).decision.resourceChange.cleanup, 'start');
          assert.equal(decisions.at(-1).decision.resourceChange.disposition, 'removed');
        });

        await t.test('cleanup cannot perform I/O if its authorization trace fails to persist', async () => {
          await reset();
          const broken = poolWithQueryFailure((sql, args) => /INSERT INTO preview_flow_decisions/.test(sql)
            && JSON.parse(args[4]).type === 'RequestPreviewCleanup', 'cleanup trace unavailable');
          await preparePreview(broken, makeExecutor(archiveSession));
          assert.equal(removals, 0);
          assert.equal(drops, 0);
          assert.equal((await resourceRow()).cleanup_started_at, null);
          assert.ok(!(await owner.trace(1)).some(entry => entry.action.type === 'RequestPreviewCleanup'));
          await cleanup.sweep({ pool, config });
          assert.equal(liveFlow, null);
          assert.equal(drops, 1);
        });

        await t.test('lost retirement acknowledgement defers I/O and a fresh owner resumes the recorded effect', async () => {
          await reset();
          let commitCount = 0;
          const broken = poolWithQueryFailure(sql => sql === 'COMMIT' && ++commitCount === 3, 'retirement acknowledgement lost', true);
          await preparePreview(broken, makeExecutor(archiveSession));
          assert.equal(removals, 0);
          assert.equal(drops, 0);
          assert.ok((await resourceRow()).cleanup_started_at);
          const original = (await owner.trace(1)).at(-1);
          assert.equal(original.action.type, 'RequestPreviewCleanup');
          const recovered = createCleanup({
            runtime,
            lock: rivalGuard.withResourceUse,
            db: { dropDatabase: async () => { drops++; } },
          });
          await recovered.sweep({ pool, config });
          assert.equal(liveFlow, null);
          assert.equal(drops, 1);
          const resumed = (await owner.trace(1)).at(-2);
          assert.equal(resumed.decision.reason, 'cleanup_resumed');
          assert.equal(resumed.decision.effects[0].effectKey, original.decision.effects[0].effectKey);
        });

        await t.test('completion trace failure rolls back settlement and remains recoverable after removal', async () => {
          await reset();
          const broken = poolWithQueryFailure((sql, args) => /INSERT INTO preview_flow_decisions/.test(sql)
            && JSON.parse(args[4]).type === 'PreviewCleanupCompleted', 'completion trace unavailable');
          await preparePreview(broken, makeExecutor(archiveSession));
          assert.equal(liveFlow, null);
          assert.equal(drops, 1);
          assert.equal((await resourceRow()).cleanup_completed_at, null);
          assert.ok(!(await owner.trace(1)).some(entry => entry.action.type === 'PreviewCleanupCompleted'));
          await cleanup.sweep({ pool, config });
          assert.equal((await resourceRow()).cleanup_disposition, 'removed');
          assert.equal(drops, 2, 'retry performs the same safe idempotent removal under existing locks');
        });

        await t.test('publication transaction failure cleans the runtime; the receipt survives rollback', async () => {
          await reset();
          const broken = poolWithQueryFailure(sql => /UPDATE chat_sessions SET staging_url = \$1/.test(sql), 'publication failed');
          await assert.rejects(preparePreview(broken), /publication failed/);
          assert.equal(removals, 1);
          assert.equal(drops, 1);
          assert.deepEqual((await resourceRow()).receipt, receipt);
          assert.equal((await owner.read(1)).preview.stagingUrl, null);
        });

        await t.test('publication failure plus removal failure remains recoverable', async () => {
          await reset();
          removeFails = true;
          const broken = poolWithQueryFailure(sql => /UPDATE chat_sessions SET staging_url = \$1/.test(sql), 'publication failed');
          await assert.rejects(preparePreview(broken), /publication failed/);
          assert.equal((await resourceRow()).cleanup_completed_at, null);
          removeFails = false;
          await cleanup.sweep({ pool, config });
          assert.equal((await resourceRow()).cleanup_disposition, 'removed');
          assert.equal(liveFlow, null);
          assert.equal(drops, 1);
        });

        await t.test('database outage during cleanup defers deletion until recovery can establish publication ownership', async () => {
          await reset();
          const broken = poolWithQueryFailure(sql => /UPDATE chat_sessions SET staging_url = \$1|SELECT \* FROM preview_flow_resources.*FOR UPDATE/.test(sql), 'database unavailable');
          await assert.rejects(preparePreview(broken), /database unavailable/);
          assert.equal(removals, 0);
          assert.equal(drops, 0);
          assert.ok((await resourceRow()).intent);
          await cleanup.sweep({ pool, config });
          assert.equal(liveFlow, null);
          assert.equal(drops, 1);
        });

        await t.test('failure to mark completed cleanup keeps an idempotent recovery obligation', async () => {
          await reset();
          const broken = poolWithQueryFailure(sql => /UPDATE preview_flow_resources SET cleanup_completed_at/.test(sql), 'completion unavailable');
          await preparePreview(broken, makeExecutor(archiveSession));
          assert.equal(liveFlow, null);
          assert.ok((await resourceRow()).cleanup_started_at);
          assert.equal((await resourceRow()).cleanup_completed_at, null);
          await cleanup.sweep({ pool, config });
          assert.equal((await resourceRow()).cleanup_disposition, 'removed');
        });

        await t.test('runtime-receipt persistence failure cleans through the pre-create intent', async () => {
          await reset();
          const broken = poolWithQueryFailure(sql => /INSERT INTO preview_flow_resources \(flow_id, session_id, receipt\)/.test(sql), 'receipt failed');
          await assert.rejects(preparePreview(broken), /receipt failed/);
          const row = await resourceRow();
          assert.equal(row.receipt, null);
          assert.deepEqual(row.intent, intent);
          assert.equal(row.cleanup_disposition, 'removed');
          assert.equal(removals, 1);
          assert.equal(drops, 1);
        });

        await t.test('failed receipt persistence plus failed removal leaves an intent consumed by recovery', async () => {
          await reset();
          removeFails = true;
          const broken = poolWithQueryFailure(sql => /INSERT INTO preview_flow_resources \(flow_id, session_id, receipt\)/.test(sql), 'receipt failed');
          await assert.rejects(preparePreview(broken), /receipt failed/);
          assert.equal((await resourceRow()).cleanup_completed_at, null);
          assert.equal((await resourceRow()).receipt, null);
          assert.equal(drops, 0);
          assert.ok(liveFlow);
          removeFails = false;
          await cleanup.sweep({ pool, config });
          assert.equal((await resourceRow()).cleanup_disposition, 'removed');
          assert.equal(removals, 2);
          assert.equal(drops, 1);
          assert.equal(liveFlow, null);
        });

        await t.test('a rejected publication whose deletion fails is retried from its stored receipt', async () => {
          await reset();
          removeFails = true;
          await preparePreview(pool, makeExecutor(archiveSession));
          assert.equal((await resourceRow()).cleanup_completed_at, null);
          assert.deepEqual((await resourceRow()).receipt, receipt);
          removeFails = false;
          await cleanup.sweep({ pool, config });
          assert.equal(liveFlow, null);
          assert.equal(drops, 1);
        });

        await t.test('a failed clone drop stays pending and recovery completes idempotent removal', async () => {
          await reset();
          dropFails = true;
          await preparePreview(pool, makeExecutor(archiveSession));
          assert.equal((await resourceRow()).cleanup_completed_at, null);
          dropFails = false;
          await cleanup.sweep({ pool, config });
          assert.equal((await resourceRow()).cleanup_disposition, 'removed');
          assert.equal(drops, 2);
        });

        await t.test('recovery of an intent after interruption before receipt creation removes its runtime', async () => {
          await reset();
          await assert.rejects(preparePreview(pool, makeExecutor(async () => { throw new Error('process interrupted'); })), /process interrupted/);
          assert.equal((await resourceRow()).receipt, null);
          assert.ok(liveFlow);
          await cleanup.sweep({ pool, config });
          assert.equal(liveFlow, null);
          assert.equal(drops, 1);
        });

        await t.test('failure to reserve cleanup intent prevents resource creation', async () => {
          await reset();
          const broken = poolWithQueryFailure(sql => /INSERT INTO preview_flow_resources \(flow_id, session_id, intent\)/.test(sql), 'intent failed');
          await assert.rejects(preparePreview(broken), /intent failed/);
          assert.equal(creates, 0);
          assert.equal(liveFlow, null);
        });

        await t.test('session hard deletion during preparation preserves the cleanup intent and removes the orphan safely', async () => {
          await reset();
          await assert.rejects(preparePreview(pool, makeExecutor(async () => {
            await pool.query('DELETE FROM chat_sessions WHERE id = 1');
          })), /missing flow|does not exist/);
          assert.equal((await resourceRow()).cleanup_disposition, 'removed');
          assert.equal(liveFlow, null);
          assert.equal(drops, 1);
        });

        await t.test('recovery consumes a published resource after its session and flow have been hard-deleted', async () => {
          await reset();
          await preparePreview();
          await pool.query('DELETE FROM chat_sessions WHERE id = 1');
          assert.equal((await pool.query('SELECT * FROM preview_flows')).rows.length, 0);
          assert.ok((await resourceRow()).intent);
          await cleanup.sweep({ pool, config });
          assert.equal((await resourceRow()).cleanup_disposition, 'removed');
          assert.equal(liveFlow, null);
          assert.equal(drops, 1);
        });

        await t.test('an interrupted intent with no runtime still cleans its clone and auxiliary resources', async () => {
          await reset();
          await assert.rejects(preparePreview(pool, makeExecutor(async () => {
            liveFlow = null;
            throw new Error('interrupted before runtime deployment');
          })), /interrupted/);
          await cleanup.sweep({ pool, config });
          assert.equal((await resourceRow()).cleanup_disposition, 'removed');
          assert.equal(drops, 1);
          if (runtimeKind === 'kubernetes') assert.deepEqual(deletedKinds.sort(), ['deployment', 'ingress', 'secret', 'service']);
        });

        await t.test('a consumed or retiring resource intent cannot authorize another build of the same execution', async () => {
          await reset();
          await preparePreview();
          const published = await resourceRow();
          await assert.rejects(owner.recordIntent(1, published.flow_id, intent), /consumed execution/);
        });

        await t.test('inspection outage retains cleanup obligation rather than guessing at ownership', async () => {
          await reset();
          inspectFails = true;
          await preparePreview(pool, makeExecutor(archiveSession));
          assert.equal(removals, 0);
          assert.equal(drops, 0);
          assert.equal((await resourceRow()).cleanup_completed_at, null);
          inspectFails = false;
          await cleanup.sweep({ pool, config });
          assert.equal(liveFlow, null);
        });

        await t.test('recovery preserves a published resource even after its flow pointer is superseded', async () => {
          await reset();
          await preparePreview();
          const published = await resourceRow();
          await owner.apply({
            type: 'RetryPreview',
            actionId: randomUUID(),
            sessionId: 1,
            headSha: HEAD,
            startedStatus: 'active',
          });
          await cleanup.sweep({ pool, config });
          assert.equal(removals, 0);
          assert.equal(drops, 0);
          assert.equal(liveFlow, published.flow_id);
        });

        await t.test('a commit acknowledgement failure must not delete the preview that actually published', async () => {
          await reset();
          let commitCount = 0;
          const broken = poolWithQueryFailure(sql => sql === 'COMMIT' && ++commitCount === 2, 'commit acknowledgement lost', true);
          await assert.rejects(preparePreview(broken), /acknowledgement lost/);
          assert.ok((await resourceRow()).published_at);
          assert.equal(removals, 0);
          assert.equal(drops, 0);
          assert.equal((await owner.read(1)).preview.stagingUrl, receipt.stagingUrl);
        });

        await t.test('late cleanup never deletes a same-SHA successor or its shared clone', async () => {
          await reset();
          removeFails = true;
          await preparePreview(pool, makeExecutor(archiveSession));
          const old = await resourceRow();
          removeFails = false;
          await pool.query(`UPDATE chat_sessions SET status = 'active' WHERE id = 1`);
          const successor = await preparePreview(pool, makeExecutor(async () => {}, rivalGuard));
          const beforeRemovals = removals;
          await cleanup.sweep({ pool, config });
          assert.equal(liveFlow, successor.identity.flowId);
          assert.equal(removals, beforeRemovals);
          assert.equal(drops, 0);
          assert.equal((await resourceRow()).flow_id, old.flow_id);
          assert.equal((await resourceRow()).cleanup_disposition, 'replaced');
          assert.equal((await owner.read(1)).preview.stagingUrl, receipt.stagingUrl);
        });

        await t.test('legacy/unlabelled replacement is preserved, including its clone', async () => {
          await reset();
          await assert.rejects(preparePreview(pool, makeExecutor(async () => { throw new Error('interrupt'); })), /interrupt/);
          liveFlow = 'legacy-owner';
          await cleanup.sweep({ pool, config });
          assert.equal(removals, 0);
          assert.equal(drops, 0);
          assert.equal((await resourceRow()).cleanup_disposition, 'replaced');
        });

        await t.test('cleanup and a successor build use the same cross-process resource lock', async () => {
          await reset();
          removeGate = { entered: deferred(), finish: deferred() };
          const cleaning = preparePreview(pool, makeExecutor(archiveSession));
          await removeGate.entered.promise;
          assert.deepEqual(await rivalGuard.withResourceUse(config, STAGING_BUILD_LOCK, 1,
            () => assert.fail('successor entered during removal'), { allRuntimes: true, tryOnly: true }), { busy: true });
          await pool.query(`UPDATE chat_sessions SET status = 'active' WHERE id = 1`);
          const successor = preparePreview(pool, makeExecutor(async () => {}, rivalGuard));
          removeGate.finish.resolve();
          await cleaning;
          const result = await successor;
          assert.equal(result.accepted, true);
          assert.equal(liveFlow, result.identity.flowId);
          assert.equal(removals, 1);
          assert.equal(drops, 1);
        });

        await t.test('a reported Ready cannot publish once cleanup has claimed the same flow', async () => {
          await reset();
          removeGate = { entered: deferred(), finish: deferred() };
          const cleaning = preparePreview(pool, makeExecutor(archiveSession));
          await removeGate.entered.promise;
          try {
            const state = await owner.read(1);
            await pool.query(`UPDATE chat_sessions SET status = 'active' WHERE id = 1`);
            const late = await owner.apply({
              type: 'PreviewReady',
              actionId: randomUUID(),
              sessionId: 1,
              flowId: state.flow.id,
              generation: state.flow.generation,
              headSha: HEAD,
              receipt,
            });
            assert.equal(late.decision.reason, 'resource_retiring');
            assert.equal(late.current.preview.stagingUrl, null);
          } finally {
            removeGate.finish.resolve();
          }
          await cleaning;
        });

        if (runtimeKind === 'kubernetes') {
          await t.test('cleanup also works when the legacy lifecycle feature flag is disabled', async () => {
            await reset();
            process.env.PREVIEW_LIFECYCLE_ENABLED = 'false';
            try {
              await preparePreview(pool, makeExecutor(archiveSession));
              assert.equal(liveFlow, null);
              assert.equal(drops, 1);
            } finally {
              process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
            }
          });

          await t.test('recovery skips a live lifecycle owner before attempting the build lock', async () => {
            await reset();
            await assert.rejects(preparePreview(pool, makeExecutor(async () => { throw new Error('interrupt'); })), /interrupt/);
            await rivalGuard.withResourceUse(config, PREVIEW_LIFECYCLE_LOCK, 1, async () => {
              assert.deepEqual(await cleanup.sweep({ pool, config }), [{ busy: true }]);
              assert.equal(removals, 0);
            });
            await cleanup.sweep({ pool, config });
            assert.equal(liveFlow, null);
          });
        }
      });
    }
  } finally {
    if (priorLifecycle === undefined) delete process.env.PREVIEW_LIFECYCLE_ENABLED;
    else process.env.PREVIEW_LIFECYCLE_ENABLED = priorLifecycle;
    kubernetes._setClientsForTest(null);
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
