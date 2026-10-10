'use strict';

// The checks queue on a REAL Postgres (services/checks-queue.js): the slot
// count is the live check_runs rows, counted under one advisory lock, so it
// holds across platform processes and across a restart.
//
// The 7 Oct 2026 storm had about 20 proposals checking at once, their Jobs
// using 35 to 40 cores, and the shared Postgres primary CPU-throttled for 40
// minutes; nothing bounded how many runs went at once. Here two processes are
// two pg pools with their own connections, and an owner is the HOSTNAME
// selfOwner() reads, switched between calls. The run that waits is the real
// captureForSession and the real main-watch afterMerge, stopped before any
// Job by superseding it or by a stub unit suite.
//
// Skips when no postgres is reachable (TEST_DATABASE_URL, else DATABASE_URL,
// else localhost).
//
// Run with: node --test tests/checks-queue-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHECKS_QUEUE_POLL_MS = '250';
delete process.env.APP_RUNTIME;
delete process.env.PREVIEW_LIFECYCLE_ENABLED;

const checksQueue = require('../src/services/checks-queue');
const checkRuns = require('../src/services/check-runs');
const harvest = require('../src/services/check-harvest');
const stagingRecovery = require('../src/services/staging-recovery');
const mainWatch = require('../src/services/main-watch');
const unitSuite = require('../src/services/unit-suite');
const visuals = require('../src/services/visuals');
const { getPool } = require('../src/db/pool');

const ROOT = path.join(__dirname, '..');
const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';
const SCHEMA = `checks_queue_pg_${process.pid}`;
const SCOPED = `${DSN}${DSN.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;

// The two tables the queue reads besides its own, with the columns these
// paths touch; check_runs exactly as schema.sql declares it, the checks
// queue's columns included.
const CHECK_RUNS_DDL = (() => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS check_runs');
  const last = 'CREATE INDEX IF NOT EXISTS idx_check_runs_app';
  const end = schema.indexOf(';', schema.indexOf(last, start)) + 1;
  return schema.slice(start, end);
})();
const DDL = `
  CREATE TABLE apps (
    id SERIAL PRIMARY KEY, slug TEXT, name TEXT, repo_url TEXT, main_sha TEXT,
    runtime_name TEXT, runtime_kind TEXT,
    main_check_state TEXT, main_check_sha TEXT, main_check_at TIMESTAMPTZ, main_check_detail JSONB,
    main_check_resumed_sha TEXT, main_check_paused_sha TEXT
  );
  CREATE TABLE chat_sessions (
    id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id), status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'native', branch_name TEXT, pr_number INTEGER,
    check_state TEXT, check_phase TEXT, check_trigger TEXT, checks_commit_sha VARCHAR(40),
    checks_checked_at TIMESTAMPTZ, checks_progress JSONB, check_next_retry_at TIMESTAMPTZ,
    checks_base_sha TEXT, consecutive_check_failures INTEGER NOT NULL DEFAULT 0,
    first_check_failure_at TIMESTAMPTZ, last_check_failure_at TIMESTAMPTZ,
    check_error_detail TEXT, check_error_notified_at TIMESTAMPTZ,
    handoff_head_sha TEXT, handoff_uploaded_sha TEXT, handoff_upload_checked_sha TEXT,
    imported_pr_head_sha TEXT, active_turn JSONB, staging_url TEXT,
    promoted_at TIMESTAMPTZ, last_activity_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ${CHECK_RUNS_DDL}
`;

let pg;
try { pg = require('pg'); } catch { pg = null; }

let reachable = null;
async function setUp() {
  if (reachable !== null) return reachable;
  if (!pg) { reachable = 'the pg driver is not installed in this environment'; return reachable; }
  const client = new pg.Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(DDL);
    reachable = true;
  } catch (err) {
    reachable = `no postgres reachable at ${DSN}: ${err.message || err.code || err}`;
  } finally {
    await client.end().catch(() => {});
  }
  return reachable;
}

// One process's pool: its own connections, its own view of the schema.
const pools = [];
function processPool() {
  const pool = new pg.Pool({ connectionString: SCOPED, max: 4 });
  pools.push(pool);
  return pool;
}

test.after(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => {})));
  if (reachable === true) {
    await getPool({ databaseUrl: SCOPED }).end().catch(() => {});
    const client = new pg.Client({ connectionString: DSN });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await client.end();
  }
});

async function fresh(t, { cap } = {}) {
  const ready = await setUp();
  if (ready !== true) { t.skip(ready); return null; }
  const pool = processPool();
  // Ids keep counting across tests: a run another test left in flight in
  // this process must never share a session id with this one's.
  await pool.query('TRUNCATE check_runs, chat_sessions, apps CASCADE');
  const saved = process.env.CHECKS_MAX_CONCURRENT_RUNS;
  if (cap !== undefined) process.env.CHECKS_MAX_CONCURRENT_RUNS = String(cap);
  t.after(() => {
    if (saved === undefined) delete process.env.CHECKS_MAX_CONCURRENT_RUNS;
    else process.env.CHECKS_MAX_CONCURRENT_RUNS = saved;
  });
  const { rows: [app] } = await pool.query(`INSERT INTO apps (slug, name, repo_url) VALUES ('demo', 'Demo', '') RETURNING id`);
  return { pool, appId: app.id };
}

// Run `fn` as the process on `host` (selfOwner reads HOSTNAME at call time).
async function as(host, fn) {
  const saved = process.env.HOSTNAME;
  process.env.HOSTNAME = host;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.HOSTNAME; else process.env.HOSTNAME = saved;
  }
}

async function session(pool, appId, over = {}) {
  const cols = { app_id: appId, status: 'promoted', source: 'native', branch_name: 'b',
    check_state: 'pending', check_phase: 'building', checks_commit_sha: `c${crypto.randomUUID().slice(0, 8)}`, ...over };
  const keys = Object.keys(cols);
  const { rows } = await pool.query(
    `INSERT INTO chat_sessions (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => cols[k]));
  return rows[0];
}

async function ask(pool, s, extra = {}) {
  const runId = crypto.randomUUID();
  const at = await checksQueue.enqueue(pool, {
    runId, sessionId: s.id, commitSha: s.checks_commit_sha, manifest: { launched: false }, ...extra,
  });
  assert.ok(at, 'the run joined the queue');
  return runId;
}

async function askMain(pool, appId, sha) {
  const runId = crypto.randomUUID();
  assert.ok(await checksQueue.enqueue(pool, { runId, kind: 'main', appId, commitSha: sha, manifest: { kind: 'main' } }));
  return runId;
}

async function admittedIds(pool) {
  const { rows } = await pool.query('SELECT run_id FROM check_runs WHERE admitted_at IS NOT NULL ORDER BY queued_at');
  return rows.map((r) => r.run_id);
}

async function until(fn, { timeoutMs = 5000, everyMs = 50 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Two processes, one cap ──────────────────────────────────────────────

test('two processes never have more than the cap of runs admitted, whoever runs the pass', async (t) => {
  const env = await fresh(t, { cap: 4 });
  if (!env) return;
  const a = env.pool;
  const b = processPool();
  const runs = [];
  for (let i = 0; i < 12; i += 1) {
    const host = i % 2 ? 'pod-b' : 'pod-a';
    const pool = i % 2 ? b : a;
    const s = await session(a, env.appId);
    runs.push({ pool, runId: await as(host, () => ask(pool, s)) });
  }

  // Thirty passes at once, from both processes.
  await Promise.all(Array.from({ length: 30 }, (_, i) => checksQueue.admit(i % 2 ? b : a)));
  const admitted = await admittedIds(a);
  assert.equal(admitted.length, 4, 'four slots, filled once');
  assert.deepEqual(admitted, runs.slice(0, 4).map((r) => r.runId), 'first come, first served');

  // The first four settle; the other eight wait for their slots and hold
  // them briefly, in both processes at once. Nothing ever holds more than
  // four.
  for (const id of admitted) await checkRuns.finish(a, id);
  let running = 0;
  let most = 0;
  let mostInDb = 0;
  const watcher = setInterval(async () => {
    const { rows } = await a.query('SELECT COUNT(*)::int AS n FROM check_runs WHERE admitted_at IS NOT NULL').catch(() => ({ rows: [{ n: 0 }] }));
    mostInDb = Math.max(mostInDb, rows[0].n);
  }, 20);
  await Promise.all(runs.slice(4).map(async ({ pool, runId }, i) => {
    const slot = await checksQueue.waitForSlot(pool, { runId, pollMs: 100 });
    assert.equal(slot.outcome, 'admitted');
    running += 1;
    most = Math.max(most, running);
    await sleep(80 + (i % 3) * 60);
    running -= 1;
    await checkRuns.finish(pool, runId);
  }));
  clearInterval(watcher);
  assert.ok(most <= 4 && most >= 2, `at most four ran at once (saw ${most})`);
  assert.ok(mostInDb <= 4, `the table never held more than four slots (saw ${mostInDb})`);
  const { rows } = await a.query('SELECT COUNT(*)::int AS n FROM check_runs');
  assert.equal(rows[0].n, 0, 'every row went with its run');
});

// ── The order ───────────────────────────────────────────────────────────

test('slots go to main-watch, promoted, submitted hand-offs, then drafts; a draft promoted while it waits moves up', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const draft = await session(pool, appId, { status: 'active' });
  const unsubmitted = await session(pool, appId, {
    status: 'active', source: 'cli_handoff', handoff_head_sha: 'h1', handoff_uploaded_sha: 'h2',
  });
  await pool.query('UPDATE chat_sessions SET handoff_upload_checked_sha = checks_commit_sha WHERE id = $1', [unsubmitted.id]);
  const handoff = await session(pool, appId, { status: 'active', source: 'cli_handoff', handoff_head_sha: 'h3' });
  const merging = await session(pool, appId, { status: 'merging' });
  const promoted = await session(pool, appId, { status: 'promoted' });
  // Asked in the reverse of the order they are served.
  const ids = {};
  for (const [name, s] of [['draft', draft], ['unsubmitted', unsubmitted], ['handoff', handoff], ['merging', merging], ['promoted', promoted]]) {
    ids[name] = await ask(pool, s);
  }
  ids.main = await askMain(pool, appId, 'm'.repeat(40));

  let plan = await checksQueue.admit(pool);
  const at = (name) => plan.byRun.get(ids[name]);
  assert.deepEqual(plan.admit.sort(), [ids.main, ids.merging].sort(),
    'main-watch in its own slot, and the earliest-asking promoted proposal (merging counts as promoted) in the one shared slot');
  assert.equal(at('main').class, 1);
  assert.equal(at('promoted').ahead, 0);
  assert.equal(at('handoff').ahead, 1, 'a submitted hand-off after the promoted ones');
  assert.equal(at('handoff').class, 3);
  assert.equal(at('unsubmitted').class, 4, 'an upload still waiting on proposal_submit_build is not submitted');
  assert.equal(at('draft').class, 4);
  assert.deepEqual([at('draft').ahead, at('unsubmitted').ahead], [2, 3], 'first come within the class');

  // The class is read at every pass.
  await pool.query("UPDATE chat_sessions SET status = 'promoted' WHERE id = $1", [draft.id]);
  plan = await checksQueue.admit(pool);
  assert.equal(at('draft').class, 2);
  assert.equal(at('draft').ahead, 0, 'it asked before the other promoted proposal');
  assert.equal(at('promoted').ahead, 1);

  // A slot frees: the head of the line gets it.
  await checkRuns.finish(pool, ids.merging);
  plan = await checksQueue.admit(pool);
  assert.deepEqual(plan.admit, [ids.draft]);
});

// ── Main-watch's slot ───────────────────────────────────────────────────

test('main-watch has its own slot, takes a freed shared one before any proposal, and proposals never take its slot', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const { rows: [other] } = await pool.query(`INSERT INTO apps (slug) VALUES ('other') RETURNING id`);
  const p1 = await ask(pool, await session(pool, appId));
  assert.deepEqual((await checksQueue.admit(pool)).admit, [p1]);
  const p2 = await ask(pool, await session(pool, appId));
  assert.deepEqual((await checksQueue.admit(pool)).admit, [], 'the shared slot is full, and the reserved one is not a proposal\'s');

  const m1 = await askMain(pool, appId, 'a'.repeat(40));
  assert.deepEqual((await checksQueue.admit(pool)).admit, [m1], 'a merge of main goes at once, with the shared slot full');
  const m2 = await askMain(pool, other.id, 'b'.repeat(40));
  let plan = await checksQueue.admit(pool);
  assert.deepEqual(plan.admit, []);
  assert.equal(plan.byRun.get(m2).ahead, 0, 'a second app\'s merge waits ahead of every proposal');
  assert.equal(plan.byRun.get(p2).ahead, 1);

  await checkRuns.finish(pool, p1);
  plan = await checksQueue.admit(pool);
  assert.deepEqual(plan.admit, [m2], 'the freed shared slot goes to main-watch');
  await checkRuns.finish(pool, m1);
  plan = await checksQueue.admit(pool);
  assert.deepEqual(plan.admit, [p2], 'with one main-watch run left it is in its own slot, and the shared one is free');
  assert.deepEqual(plan.holding, { main: 1, proposal: 1 });
});

test('main-watch runs through its slot, and a run superseded by a newer merge while it waits leaves the line', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const config = { workerRuntime: 'kubernetes' };
  const suiteCalls = [];
  t.mock.method(unitSuite, 'maybeRunUnitSuite', async (opts) => { suiteCalls.push(opts.ref); return null; });
  const app = { id: appId, slug: 'demo', repo_url: 'https://github.com/org/demo' };

  // A slot free: it runs, and gives the slot back.
  const out = await mainWatch.afterMerge(config, pool, { app, mergeSha: 'a'.repeat(40) });
  assert.equal(out.state, 'skipped', 'the stub suite has no test script');
  assert.deepEqual(suiteCalls, ['a'.repeat(40)]);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM check_runs')).rows[0].n, 0);

  // Its slot held by another app's merge, the shared one by a proposal: it waits.
  const { rows: [other] } = await pool.query(`INSERT INTO apps (slug) VALUES ('other') RETURNING id`);
  const busy = await askMain(pool, other.id, 'c'.repeat(40));
  const p1 = await ask(pool, await session(pool, appId));
  await checksQueue.admit(pool);
  assert.deepEqual((await admittedIds(pool)).sort(), [busy, p1].sort());
  const waiting = mainWatch.afterMerge(config, pool, { app, mergeSha: 'b'.repeat(40) });
  await until(async () => (await pool.query(
    "SELECT 1 FROM check_runs WHERE kind = 'main' AND app_id = $1 AND admitted_at IS NULL", [appId])).rows.length);
  // A newer merge claims the row: nobody would read this run.
  await pool.query('UPDATE apps SET main_check_sha = $2 WHERE id = $1', [appId, 'd'.repeat(40)]);
  assert.equal(await waiting, null, 'nothing stored for the superseded merge');
  assert.deepEqual(suiteCalls, ['a'.repeat(40)], 'its suite never ran');
  const { rows } = await pool.query("SELECT 1 FROM check_runs WHERE kind = 'main' AND app_id = $1", [appId]);
  assert.equal(rows.length, 0, 'and its row left the line');
  assert.equal((await pool.query('SELECT main_check_sha FROM apps WHERE id = $1', [appId])).rows[0].main_check_sha,
    'd'.repeat(40), 'the newer merge\'s claim stands');
});

// ── A freed slot ────────────────────────────────────────────────────────

test('a freed slot admits the next run at once here, and at the next poll in another process', async (t) => {
  const env = await fresh(t, { cap: 2 });
  if (!env) return;
  const a = env.pool;
  const b = processPool();
  const r1 = await as('pod-a', async () => ask(a, await session(a, env.appId)));
  const r2 = await as('pod-a', async () => ask(a, await session(a, env.appId)));
  await checksQueue.admit(a);
  const r3 = await as('pod-b', async () => ask(b, await session(a, env.appId)));

  // A long poll: only the wake can explain a prompt admission.
  const started = Date.now();
  const waiting = checksQueue.waitForSlot(b, { runId: r3, pollMs: 60_000 });
  await sleep(300);
  assert.equal((await a.query('SELECT admitted_at FROM check_runs WHERE run_id = $1', [r3])).rows[0].admitted_at, null);
  await checkRuns.finish(a, r1);
  const slot = await waiting;
  assert.equal(slot.outcome, 'admitted');
  assert.ok(Date.now() - started < 5000, 'woken by the run that settled, not by its next poll');

  // Another Pod's run settling wakes nobody here: the waiter's own poll finds it.
  const r4 = await as('pod-b', async () => ask(b, await session(a, env.appId)));
  const polled = checksQueue.waitForSlot(b, { runId: r4, pollMs: 250 });
  await sleep(300);
  await a.query('DELETE FROM check_runs WHERE run_id = $1', [r2]);
  const t0 = Date.now();
  assert.equal((await polled).outcome, 'admitted');
  assert.ok(Date.now() - t0 < 2000, 'within a poll or two');
});

// ── A waiting run, end to end ───────────────────────────────────────────

test('a capture waits after its preview, says so, is not stale, and leaves the line when superseded', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const config = { captureRuntime: 'kubernetes', databaseUrl: SCOPED, kubernetes: { workerNamespace: 'workers' } };
  // The slot is somebody else's.
  const holder = await ask(pool, await session(pool, appId));
  await checksQueue.admit(pool);

  const s = await session(pool, appId, { checks_commit_sha: 'sha-one', check_phase: 'building' });
  const app = { id: appId, slug: 'demo', name: 'Demo', repo_url: '' };
  const first = visuals.captureForSession(config, s, app, 'sha-one', null, { trigger: 'commit-push' });

  const queued = await until(async () => {
    const { rows } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id]);
    return rows[0].check_phase === 'queued' && rows[0].checks_progress?.queue ? rows[0] : null;
  });
  assert.equal(queued.check_state, 'pending');
  assert.equal(queued.checks_commit_sha, 'sha-one');
  assert.equal(queued.checks_progress.queue.ahead, 0, 'next in line');
  const { rows: [row] } = await pool.query('SELECT * FROM check_runs WHERE session_id = $1', [s.id]);
  assert.equal(row.admitted_at, null);
  assert.equal(row.kind, 'proposal');
  assert.equal(row.manifest.launched, false, 'the queue row is the provisional manifest');

  // Not stale, however long it has waited.
  await pool.query("UPDATE chat_sessions SET checks_checked_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [s.id]);
  const stuck = await stagingRecovery.findStuckCheckSessions({ pool, staleMs: 600000, maxAutoRetries: 6 });
  assert.ok(!stuck.rows.some((r) => r.id === s.id), 'the stale sweep leaves a run that is in line');
  const fresh2 = (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
  assert.equal(stagingRecovery.checkRunOverdue(fresh2), false);
  // A request for the same commit is told the run is coming.
  assert.deepEqual(await harvest.runToCollect(config, pool, s.id, 'sha-one'),
    { runId: row.run_id, owner: row.owner, capture: 'queued', unitSuite: 'queued', queued: true });
  // A session whose row has gone is overdue as before: the backstop.
  const lost = await session(pool, appId, { check_phase: 'queued' });
  await pool.query("UPDATE chat_sessions SET checks_checked_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [lost.id]);
  assert.ok((await stagingRecovery.findStuckCheckSessions({ pool, staleMs: 600000, maxAutoRetries: 6 }))
    .rows.some((r) => r.id === lost.id));
  await pool.query('DELETE FROM chat_sessions WHERE id = $1', [lost.id]);

  // A newer commit's request, in this process: the waiting run leaves at
  // once, and the newer one takes its turn in line.
  await visuals.captureForSession(config, s, app, 'sha-two', null, { trigger: 'commit-push' });
  assert.equal(await first, undefined, 'it left with no verdict');
  const second = await until(async () => {
    const { rows } = await pool.query('SELECT * FROM check_runs WHERE session_id = $1', [s.id]);
    return rows.length === 1 && rows[0].commit_sha === 'sha-two' ? rows[0] : null;
  });
  assert.notEqual(second.run_id, row.run_id, 'the superseded run\'s row went with it');
  await until(async () => (await pool.query(
    "SELECT 1 FROM chat_sessions WHERE id = $1 AND check_phase = 'queued' AND checks_commit_sha = 'sha-two'", [s.id])).rows.length);

  // The session moves on while the newer run waits: it leaves too.
  await pool.query("UPDATE chat_sessions SET status = 'archived' WHERE id = $1", [s.id]);
  await until(async () => (await pool.query('SELECT 1 FROM check_runs WHERE session_id = $1', [s.id])).rows.length === 0
    && !visuals.hasInFlightCapture(s.id));
  assert.deepEqual(await admittedIds(pool), [holder], 'neither run took a slot');
});

// ── A restart ───────────────────────────────────────────────────────────

test('a run waiting when its process died keeps its place: the next leader re-drives it there', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const config = { captureRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers' } };
  const holder = await as('live-pod', async () => ask(pool, await session(pool, appId)));
  await checksQueue.admit(pool);
  const s = await session(pool, appId, { check_phase: 'queued' });
  const dying = await as('old-pod', () => ask(pool, s));
  await sleep(20);
  const later = await as('live-pod', async () => ask(pool, await session(pool, appId)));
  const { rows: [before] } = await pool.query('SELECT queued_at FROM check_runs WHERE run_id = $1', [dying]);

  // The old Pod on its way out (#4319): its rows are orphans at once.
  assert.equal(await as('old-pod', () => checkRuns.release(pool)), 1);
  let plan = await checksQueue.admit(pool);
  assert.equal(plan.byRun.get(later).ahead, 0, 'a dead run does not hold up the line');
  assert.equal(plan.byRun.get(dying).ahead, null);
  assert.ok(!(await stagingRecovery.findStuckCheckSessions({ pool, staleMs: 0, maxAutoRetries: 6 }))
    .rows.some((r) => r.id === s.id), 'nor is it the stale sweep\'s: the harvest has it');

  // The new leader's boot harvest re-drives it; the capture it starts asks
  // for its slot as of the place it had.
  const redriven = [];
  t.mock.method(stagingRecovery, 'recheckSessionChecks', async (args) => {
    redriven.push(args);
    await checksQueue.enqueue(pool, {
      runId: crypto.randomUUID(), sessionId: args.session.id, commitSha: args.session.checks_commit_sha,
      manifest: { launched: false }, queuedSince: args.queuedSince,
    });
    return 'rechecked';
  });
  const sweep = await as('new-pod', () => harvest.sweep(config, { reason: 'boot', pool, wait: true }));
  const results = await sweep.done;
  assert.deepEqual(results.map((r) => r.outcome), ['redriven']);
  assert.equal(redriven.length, 1);
  assert.equal(redriven[0].reason, 'orphaned-run');
  assert.equal(new Date(redriven[0].queuedSince).getTime(), new Date(before.queued_at).getTime());
  const { rows: [again] } = await pool.query('SELECT * FROM check_runs WHERE session_id = $1', [s.id]);
  assert.notEqual(again.run_id, dying);
  assert.equal(new Date(again.queued_at).getTime(), new Date(before.queued_at).getTime(), 'its place, not the back of the line');

  plan = await checksQueue.admit(pool);
  assert.equal(plan.byRun.get(again.run_id).ahead, 0, 'ahead of the run that asked after it');
  assert.equal(plan.byRun.get(later).ahead, 1);
  await checkRuns.finish(pool, holder);
  plan = await checksQueue.admit(pool);
  assert.deepEqual(plan.admit, [again.run_id], 'and it gets the next slot');
});

test('main-watch: a live run is never re-driven, and one waiting when its process died is re-driven at once in its place', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const config = { workerRuntime: 'kubernetes' };
  t.mock.method(unitSuite, 'maybeRunUnitSuite', async () => null);
  const sha = 'e'.repeat(40);
  await pool.query(
    `UPDATE apps SET repo_url = 'https://github.com/org/demo', main_check_state = 'running', main_check_sha = $2,
            main_check_at = NOW(), main_check_detail = '{}'::jsonb WHERE id = $1`, [appId, sha]);
  // Both slots a main-watch run may use are busy.
  const { rows: [other] } = await pool.query(`INSERT INTO apps (slug) VALUES ('other') RETURNING id`);
  const busy = await as('live-pod', () => askMain(pool, other.id, 'f'.repeat(40)));
  const p1 = await as('live-pod', async () => ask(pool, await session(pool, appId)));
  await checksQueue.admit(pool);
  const waiting = await as('old-pod', () => askMain(pool, appId, sha));
  const { rows: [before] } = await pool.query('SELECT queued_at FROM check_runs WHERE run_id = $1', [waiting]);

  // Alive and waiting, it is not interrupted, however old the row's stamp.
  let out = await mainWatch.resumeInterrupted(config, { pool, olderThanMs: 0 });
  assert.deepEqual(out.resumed, []);

  // Its process dies: re-driven at once, though the row was stamped just now.
  await as('old-pod', () => checkRuns.release(pool));
  out = await as('new-pod', () => mainWatch.resumeInterrupted(config, { pool, olderThanMs: 60 * 60 * 1000 }));
  assert.deepEqual(out.resumed, [{ appId, sha, was: 'running' }]);
  const again = await until(async () => (await pool.query(
    "SELECT * FROM check_runs WHERE kind = 'main' AND app_id = $1", [appId])).rows.find((r) => r.run_id !== waiting));
  assert.equal(new Date(again.queued_at).getTime(), new Date(before.queued_at).getTime(), 'it took over the dead run\'s place');
  assert.equal((await pool.query('SELECT 1 FROM check_runs WHERE run_id = $1', [waiting])).rows.length, 0);

  // A slot frees; the re-driven run takes it and settles.
  await checkRuns.finish(pool, busy);
  await out.done;
  assert.equal((await pool.query('SELECT main_check_state FROM apps WHERE id = $1', [appId])).rows[0].main_check_state, 'skipped');
  assert.deepEqual(await admittedIds(pool), [p1], 'its slot went back');
});
