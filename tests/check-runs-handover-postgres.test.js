'use strict';

// A rollout's checks runs, handed from the old leader to the new one,
// executed by a REAL postgres (services/check-runs.js, check-harvest.js).
//
// 7 Oct 2026, 21:59 UTC: the new leader's boot harvest ran moments after
// the old Pod exited, while the rows that Pod had been harvesting still
// carried its heartbeat. listOrphans counts a row as an orphan only once its
// heartbeat is CHECK_RUN_ORPHAN_MS old, so the boot sweep listed neither
// 7014 nor 7015, and the stale sweep started both over. The old process now
// hands its rows over on the way out (check-runs.release), and the stale
// sweep asks the cluster first (check-harvest.runOnCluster).
//
// tests/check-harvest.test.js pins the SQL text against a fake pool. This
// file runs it: the `stale` the query computes from an 'epoch' heartbeat,
// the owner rename the heartbeat no longer matches, and the commit match
// over a VARCHAR column with a NULL in it. Two processes are played by
// switching HOSTNAME, which is what selfOwner() reads.
//
// Skips when no postgres is reachable (TEST_DATABASE_URL, else
// DATABASE_URL, else localhost).
//
// Run with: node --test tests/check-runs-handover-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const checkRuns = require('../src/services/check-runs');
const harvest = require('../src/services/check-harvest');
const kubernetes = require('../src/services/kubernetes');

const ROOT = path.join(__dirname, '..');
const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';
const config = { captureRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers' } };

// The table as schema.sql declares it, with the checks queue's columns
// (services/checks-queue.js), less the foreign keys: the test schema has no
// chat_sessions or apps to point at.
const DDL = (() => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS check_runs');
  if (start < 0) throw new Error('check_runs is not in schema.sql any more');
  const last = 'CREATE INDEX IF NOT EXISTS idx_check_runs_app';
  const end = schema.indexOf(';', schema.indexOf(last, start)) + 1;
  return schema.slice(start, end)
    .replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE')
    .replace(/\s*REFERENCES (chat_sessions|apps)\(id\) ON DELETE CASCADE/g, '');
})();

async function connect() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return null; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { error: err.message || err.code || String(err) };
  }
  return { client };
}

async function withSchema(client, fn) {
  const name = `check_runs_handover_test_${process.pid}`;
  await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await client.query(`CREATE SCHEMA ${name}`);
  try {
    await client.query(`SET search_path TO ${name}`);
    await client.query(DDL);
    return await fn();
  } finally {
    await client.query('SET search_path TO public').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
  }
}

// Run `fn` as the process on `host`.
async function as(host, fn) {
  const saved = process.env.HOSTNAME;
  process.env.HOSTNAME = host;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.HOSTNAME; else process.env.HOSTNAME = saved;
  }
}

const RUN_7014 = 'f7895663-04d4-4f43-ac7e-9a116a2c0180';
const RUN_7015 = '338cd4cb-9927-4470-a8fc-000000000000';
const RUN_7017 = 'afd5c3d9-705f-412a-a962-000000000000';
const RUN_7014_OLD_HEAD = 'a13f2462-ff3d-42a5-8c94-d1e1aa99f9d3';

function stub(t, mod, patch) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = mod[k]; mod[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) mod[k] = v; });
}

test('the old leader\'s rows are orphans to the new leader the moment it hands them over', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      const manifest = { launched: true, trigger: 'stuck-sweep', testsCount: 732 };
      await as('old-pod', async () => {
        assert.equal(await checkRuns.record(client, { runId: RUN_7014, sessionId: 7014, commitSha: 'abc123', manifest }), true);
        assert.equal(await checkRuns.record(client, { runId: RUN_7015, sessionId: 7015, commitSha: 'def456', manifest }), true);
      });
      // A run on another Pod that is still alive and serving.
      await as('live-pod', () => checkRuns.record(client, { runId: RUN_7017, sessionId: 7017, commitSha: 'aaa111', manifest }));

      // The gap: to the new leader, a row heartbeated moments ago by a Pod
      // that has since gone looks like a live run's.
      const before = await as('new-pod', () => checkRuns.listOrphans(client));
      assert.deepEqual(before, [], 'without the hand-over the boot sweep seats nothing');

      // The old Pod, on its way out.
      const handed = await as('old-pod', () => checkRuns.release(client));
      assert.equal(handed, 2, 'both of its rows, and nobody else\'s');
      assert.equal(await as('old-pod', () => checkRuns.heartbeat(client, RUN_7014)), false,
        'the heartbeat it still sends until it exits matches no row');

      const { rows: after } = await client.query(
        'SELECT run_id, owner, heartbeat_at FROM check_runs ORDER BY session_id');
      const byRun = Object.fromEntries(after.map((r) => [r.run_id, r]));
      assert.match(byRun[RUN_7014].owner, /^old-pod:\d+:exited$/);
      assert.equal(new Date(byRun[RUN_7014].heartbeat_at).getTime(), 0, 'the heartbeat still reads as long past');
      assert.match(byRun[RUN_7017].owner, /^live-pod:\d+$/, 'a live Pod\'s row is untouched');

      const orphans = await as('new-pod', () => checkRuns.listOrphans(client));
      assert.deepEqual(orphans.map((r) => r.run_id), [RUN_7014, RUN_7015]);
      assert.ok(orphans.every((r) => r.stale === true));
      assert.equal(await as('new-pod', () => checkRuns.claim(client, RUN_7014, orphans[0].owner)), true,
        'the new leader takes it over with the usual compare-and-swap');
    });
  } finally {
    await client.end();
  }
});

test('runOnCluster and stopSupersededRuns read the session\'s runs by commit, NULL included', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      const manifest = { launched: true };
      await as('old-pod', async () => {
        await checkRuns.record(client, { runId: RUN_7014_OLD_HEAD, sessionId: 7014, commitSha: 'old999', manifest });
        await checkRuns.record(client, { runId: RUN_7014, sessionId: 7014, commitSha: 'abc123', manifest });
        await checkRuns.record(client, { runId: RUN_7015, sessionId: 7015, commitSha: null, manifest });
      });
      const asked = [];
      let spared = null;
      stub(t, kubernetes, {
        findCheckJobs: async (_cfg, { sessionId, previewRunId }) => {
          asked.push([sessionId, previewRunId]);
          return { capture: { name: 'c', state: 'running', finishedAt: null }, unitSuite: null };
        },
        stopCheckJobs: async (_cfg, { spare }) => {
          spared = [RUN_7014_OLD_HEAD, RUN_7014, 'no-manifest'].filter((id) => spare(id));
          return [];
        },
      });

      const run = await harvest.runOnCluster(config, client, { id: 7014, checks_commit_sha: 'abc123' });
      assert.equal(run.runId, RUN_7014, 'the run for the commit the session is pending on');
      assert.deepEqual(asked, [[7014, RUN_7014]], 'the older head\'s run is not asked about');

      asked.length = 0;
      const nullHead = await harvest.runOnCluster(config, client, { id: 7015, checks_commit_sha: null });
      assert.equal(nullHead.runId, RUN_7015, 'a run recorded without a commit still matches a session without one');

      await harvest.stopSupersededRuns(config, client, { sessionId: 7014, runId: 'new-run', commitSha: 'abc123' });
      assert.deepEqual(spared, [RUN_7014], 'only the run for another commit (and none with no manifest) may be stopped');
    });
  } finally {
    await client.end();
  }
});
