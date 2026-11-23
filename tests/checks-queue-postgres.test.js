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
// captureForSession and the real main-watch runMainSuite (the main-check
// machine's main.suite work), stopped before any Job by superseding it or by
// a stub unit suite.
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

const checksQueue = require('../src/services/checks-queue');
const checkRuns = require('../src/services/check-runs');
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

// The tables the queue reads besides its own, with the columns these paths
// touch; check_runs exactly as schema.sql declares it, the checks queue's
// columns included.
const CHECK_RUNS_DDL = (() => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS check_runs');
  const last = 'CREATE INDEX IF NOT EXISTS idx_check_runs_app';
  const end = schema.indexOf(';', schema.indexOf(last, start)) + 1;
  return schema.slice(start, end);
})();
// The preview machine's work items, which QUEUE_SQL reads a run against.
const WORK_DDL = (() => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS wf_work (');
  return schema.slice(start, schema.indexOf(';', schema.indexOf('CONSTRAINT wf_work_claim_shape', start)) + 1);
})();
// Main watch's verdicts, which a running check of main reads to tell
// whether its own is still wanted (main-watch.js verdictUnread).
const VERDICTS_DDL = (() => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS main_watch_verdicts (');
  return schema.slice(start, schema.indexOf(';', start) + 1);
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
    check_error_platform BOOLEAN NOT NULL DEFAULT false, unit_suite_fresh_sha TEXT,
    handoff_head_sha TEXT, handoff_uploaded_sha TEXT, handoff_upload_checked_sha TEXT,
    imported_pr_head_sha TEXT, active_turn JSONB, staging_url TEXT,
    promoted_at TIMESTAMPTZ, last_activity_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE wf_instances (
    machine TEXT NOT NULL, key TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (machine, key)
  );
  ${CHECK_RUNS_DDL}
  ${WORK_DDL}
  ${VERDICTS_DDL}
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
  await pool.query('TRUNCATE check_runs, chat_sessions, apps, wf_instances, wf_work CASCADE');
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
const { waitFor, within } = require('./lib/wait-for');

// The preview machine's work item for a run (its checks.run, under the
// run's key), or the checks.cancel that follows a cancel.
async function work(pool, sessionId, workKey, { kind = 'checks.run', status = 'running', result = null } = {}) {
  const running = status === 'running';
  await pool.query(
    `INSERT INTO wf_work (machine, key, kind, work_key, input, status, claim_id, lease_until, result, settled_at)
     VALUES ('preview', $1, $2, $3, '{}', $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (machine, key, kind, work_key) DO UPDATE
       SET status = EXCLUDED.status, claim_id = EXCLUDED.claim_id, lease_until = EXCLUDED.lease_until,
           result = EXCLUDED.result, settled_at = EXCLUDED.settled_at`,
    [`session:${sessionId}`, kind, workKey, status, running ? crypto.randomUUID() : null,
      running ? new Date(Date.now() + 60_000) : null, result == null ? null : JSON.stringify(result),
      status === 'settled' ? new Date() : null]);
}

// A preview machine's run, admitted: its row as captureForSession writes it.
async function admitted(pool, s, runKey, extra = {}) {
  const runId = await ask(pool, s, { manifest: { launched: true, workflow: true, runKey }, ...extra });
  await pool.query('UPDATE check_runs SET admitted_at = NOW() WHERE run_id = $1', [runId]);
  return runId;
}

const present = async (pool, runId) => (await pool.query('SELECT 1 FROM check_runs WHERE run_id = $1', [runId])).rows.length === 1;

// ── Two processes, one cap ──────────────────────────────────────────────

test('early units reserve spare shared capacity once and transfer it only to the matching head', async (t) => {
  const env = await fresh(t, { cap: 4 });
  if (!env) return;
  const { pool, appId } = env;
  const config = { kubernetes: { checkNodePoolRequired: true } };
  const capacity = t.mock.method(require('../src/services/kubernetes'), 'checkPoolCapacity',
    async () => ({ available: true, cap: 4 }));
  const secondPool = processPool();
  const inputs = await Promise.all(['a', 'b', 'c', 'd'].map(async (char) => {
    const head = char.repeat(40);
    const s = await session(pool, appId, { checks_commit_sha: head });
    await pool.query("INSERT INTO wf_instances VALUES ('preview', $1, $2)",
      [`session:${s.id}`, { preparing: { n: 2, head } }]);
    return { runId: crypto.randomUUID(), sessionId: s.id, appId, attempt: 2, commitSha: head };
  }));
  const reserve = (input, db = pool) => checksQueue.reserveEarlyUnitSlot(config, db, input);
  assert.equal(await reserve({ ...inputs[0], attempt: 1 }), false);
  assert.equal(await reserve({ ...inputs[0], commitSha: 'f'.repeat(40) }), false);
  capacity.mock.mockImplementation(async () => ({ available: false, cap: 0 }));
  assert.equal(await reserve(inputs[0]), false);
  capacity.mock.restore();
  t.mock.method(require('../src/services/kubernetes'), 'checkPoolCapacity', async () => ({ available: true, cap: 4 }));
  const ordinary = await ask(pool, await session(pool, appId));
  assert.equal(await reserve(inputs[0]), false, 'a regular waiter is first even when there is room');
  assert.deepEqual((await checksQueue.admit(pool)).admit, [ordinary]);

  const raced = await Promise.all(inputs.map((input, i) => reserve(input, i % 2 ? secondPool : pool)));
  assert.equal(raced.filter(Boolean).length, 1);
  const early = inputs[raced.indexOf(true)];
  const claim = { ...early, earlyRunId: early.runId, runId: crypto.randomUUID(), manifest: { launched: false } };
  assert.equal(await checksQueue.takeEarlyUnitSlot(secondPool, { ...claim, commitSha: 'f'.repeat(40) }), null);
  assert.equal(await checksQueue.takeEarlyUnitSlot(secondPool, { ...claim, sessionId: inputs.find(x => x !== early).sessionId }), null);
  const handoffs = await Promise.all([claim, { ...claim, runId: crypto.randomUUID() }]
    .map((candidate, i) => checksQueue.takeEarlyUnitSlot(i ? pool : secondPool, candidate)));
  assert.ok(handoffs[0] || handoffs[1]);
  assert.equal(handoffs.filter(Boolean).length, 1);
  const { rows } = await pool.query("SELECT manifest, admitted_at FROM check_runs WHERE session_id = $1", [early.sessionId]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].admitted_at);
  assert.equal(rows[0].manifest.unitRunId, early.runId);
  assert.equal(rows[0].manifest.earlyUnit, undefined);
  assert.equal(await checkRuns.finish(pool, early.runId), false, 'the old launcher cannot release the transferred slot');
  const later = await ask(pool, await session(pool, appId));
  const main = await askMain(pool, appId, 'e'.repeat(40));
  await checksQueue.admit(pool);
  assert.equal(await reserve(inputs.find(x => x !== early)), false, 'one shared slot stays available');
  assert.ok((await admittedIds(pool)).includes(later));
  assert.ok((await admittedIds(pool)).includes(main), 'main retains its own slot');
});

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

test('two processes grant the pilot slot once and hold only four proposal runs', async (t) => {
  const env = await fresh(t, { cap: 4 });
  if (!env) return;
  const { pool, appId } = env;
  const other = processPool();
  const flag = 'CHECKS_PROPOSAL_OVERFLOW_PILOT';
  const saved = process.env[flag];
  process.env[flag] = 'true';
  t.after(() => {
    if (saved === undefined) delete process.env[flag];
    else process.env[flag] = saved;
  });
  t.mock.method(require('../src/services/kubernetes'), 'checkPoolCapacity',
    async () => ({ available: true, cap: 5 }));

  const mains = [await askMain(pool, appId, 'a'.repeat(40)), await askMain(other, appId, 'b'.repeat(40))];
  const proposals = [];
  for (let i = 0; i < 3; i += 1) proposals.push(await ask(pool, await session(pool, appId)));
  assert.deepEqual((await checksQueue.admit(pool)).admit.sort(), [...mains, ...proposals].sort());
  const nextMain = await askMain(other, appId, 'c'.repeat(40));
  const firstSession = await session(pool, appId);
  const first = await as('pilot-owner', () => ask(pool, firstSession));
  const second = await ask(other, await session(other, appId, { status: 'active' }));

  const raced = await Promise.all(Array.from({ length: 12 }, (_, i) => checksQueue.admit(i % 2 ? other : pool)));
  assert.deepEqual(raced.flatMap((p) => p.admit), [first]);
  assert.deepEqual(raced.map((p) => p.proposalOverflowRunId).filter(Boolean), [first]);
  assert.deepEqual((await admittedIds(pool)).sort(), [...mains, ...proposals, first].sort());
  assert.equal(raced.at(-1).byRun.get(nextMain).admitted, false);
  assert.equal(raced.at(-1).byRun.get(second).admitted, false);

  async function readHolder() {
    const { rows: [holder] } = await pool.query('SELECT owner, manifest FROM check_runs WHERE run_id = $1', [first]);
    return holder;
  }
  const holder = await readHolder();
  assert.equal(holder.manifest.proposalOverflow, true);
  assert.equal(await as('pilot-owner', () => checkRuns.release(pool)), 1);
  await checkRuns.finish(pool, proposals[0]);
  assert.deepEqual((await checksQueue.admit(other)).admit, [nextMain],
    'the ordinary slot frees even while the released pilot run may still have Jobs');
  assert.equal(await checkRuns.claim(other, first, `${holder.owner}:exited`), true);
  const claimed = { runId: first, sessionId: firstSession.id, commitSha: firstSession.checks_commit_sha };
  assert.equal(await checkRuns.record(other, { ...claimed, manifest: { launched: true } }), true);
  assert.deepEqual((await readHolder()).manifest, { launched: true, proposalOverflow: true });
  assert.ok(await checksQueue.enqueue(other, { ...claimed, manifest: { launched: false } }));
  assert.deepEqual((await readHolder()).manifest, { launched: false, proposalOverflow: true });
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
  // The main-check machine claims the row for the commit before it runs.
  const claim = (sha) => pool.query('UPDATE apps SET main_check_sha = $2 WHERE id = $1', [appId, sha]);

  // A slot free: it runs, and gives the slot back.
  await claim('a'.repeat(40));
  const out = await mainWatch.runMainSuite(config, pool, { app, sha: 'a'.repeat(40) });
  assert.equal(out.state, 'skipped', 'the stub suite has no test script');
  assert.deepEqual(suiteCalls, ['a'.repeat(40)]);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM check_runs')).rows[0].n, 0);

  // Its slot held by another app's merge, the shared one by a proposal: it waits.
  const { rows: [other] } = await pool.query(`INSERT INTO apps (slug) VALUES ('other') RETURNING id`);
  const busy = await askMain(pool, other.id, 'c'.repeat(40));
  const p1 = await ask(pool, await session(pool, appId));
  await checksQueue.admit(pool);
  assert.deepEqual((await admittedIds(pool)).sort(), [busy, p1].sort());
  await claim('b'.repeat(40));
  const waiting = mainWatch.runMainSuite(config, pool, { app, sha: 'b'.repeat(40) });
  await until(async () => (await pool.query(
    "SELECT 1 FROM check_runs WHERE kind = 'main' AND app_id = $1 AND admitted_at IS NULL", [appId])).rows.length);
  // A newer merge claims the row: nobody would read this run.
  await claim('d'.repeat(40));
  assert.equal((await waiting).state, 'superseded', 'the machine records nothing more for it');
  assert.deepEqual(suiteCalls, ['a'.repeat(40)], 'its suite never ran');
  const { rows } = await pool.query("SELECT 1 FROM check_runs WHERE kind = 'main' AND app_id = $1", [appId]);
  assert.equal(rows.length, 0, 'and its row left the line');
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
  // The preview machine's checks.run: a claim's id, the work item's key, and
  // the lease's signal, which the machine fires when a newer head cancels it.
  const claim = (runKey) => ({ runId: crypto.randomUUID(), runKey, signal: new AbortController().signal });
  const cancel = new AbortController();
  const first = visuals.captureForSession(config, s, app, 'sha-one', null, {
    trigger: 'commit-push', workflow: { ...claim('run-1-1'), signal: cancel.signal },
  });

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

  // Not stale, however long it has waited: nothing re-drives it by clock.
  // (The wait is inside the machine's checks run, whose work item a dead
  // process's retry carries on: the restart test below.)
  await pool.query("UPDATE chat_sessions SET checks_checked_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [s.id]);
  const fresh2 = (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id])).rows[0];
  assert.equal(stagingRecovery.checkRunOverdue(fresh2), false);

  // A newer head: the machine cancels the waiting run, which leaves the line
  // at once with no verdict; its row is the machine's cancel to clear.
  cancel.abort(new Error('superseded'));
  await assert.rejects(first, /superseded/);
  await checkRuns.finish(pool, row.run_id);
  await pool.query("UPDATE chat_sessions SET checks_commit_sha = 'sha-two', check_phase = 'building' WHERE id = $1", [s.id]);
  const second = visuals.captureForSession(config, { ...s, checks_commit_sha: 'sha-two' }, app, 'sha-two', null, {
    trigger: 'commit-push', workflow: claim('run-1-2'),
  });
  await until(async () => (await pool.query(
    "SELECT 1 FROM chat_sessions WHERE id = $1 AND check_phase = 'queued' AND checks_commit_sha = 'sha-two'", [s.id])).rows.length);

  // The session moves on while the newer run waits: it leaves the line on
  // its own, settled with nothing to judge, and takes its row with it.
  await pool.query("UPDATE chat_sessions SET status = 'archived' WHERE id = $1", [s.id]);
  assert.equal((await second).outcome, 'blocked');
  assert.equal((await pool.query('SELECT 1 FROM check_runs WHERE session_id = $1', [s.id])).rows.length, 0);
  assert.deepEqual(await admittedIds(pool), [holder], 'neither run took a slot');
});

// ── A restart ───────────────────────────────────────────────────────────

test('a run waiting when its process died keeps its place: the retry of its work item asks as of then', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const holder = await as('live-pod', async () => ask(pool, await session(pool, appId)));
  await checksQueue.admit(pool);
  const s = await session(pool, appId, { check_phase: 'queued' });
  const dying = await as('old-pod', () => ask(pool, s, { manifest: { launched: false, workflow: true, runKey: 'run-1-1' } }));
  // Its work item is outstanding: the claim after the lost one comes back
  // for the row (its place), so no admission pass may clear it.
  await work(pool, s.id, 'run-1-1', { status: 'queued' });
  await sleep(20);
  const later = await as('live-pod', async () => ask(pool, await session(pool, appId)));
  const { rows: [before] } = await pool.query('SELECT queued_at FROM check_runs WHERE run_id = $1', [dying]);

  // The old Pod on its way out (#4319): its rows are orphans at once.
  assert.equal(await as('old-pod', () => checkRuns.release(pool)), 1);
  let plan = await checksQueue.admit(pool);
  assert.equal(plan.byRun.get(later).ahead, 0, 'a dead run does not hold up the line');
  assert.equal(plan.byRun.get(dying).ahead, null);
  assert.ok(await present(pool, dying), 'handed over, but its work item will come back for it');
  const { rows: [orphaned] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [s.id]);
  assert.equal(stagingRecovery.checkRunOverdue(orphaned, { staleMs: 0 }), false,
    'nor is it overdue by clock: the machine\'s retry of its work item has it');

  // The work item's retry (preview services checks.run) reads the earlier
  // claim's place, clears its row, and asks for its slot as of then.
  const { rows: [placed] } = await pool.query(
    "SELECT min(queued_at) AS at FROM check_runs WHERE session_id = $1 AND manifest->>'runKey' = 'run-1-1'", [s.id]);
  await checkRuns.finish(pool, dying);
  const again = crypto.randomUUID();
  await as('new-pod', () => checksQueue.enqueue(pool, {
    runId: again, sessionId: s.id, commitSha: s.checks_commit_sha,
    manifest: { launched: false, workflow: true, runKey: 'run-1-1' }, queuedSince: placed.at,
  }));
  const { rows: [row] } = await pool.query('SELECT * FROM check_runs WHERE run_id = $1', [again]);
  assert.equal(new Date(row.queued_at).getTime(), new Date(before.queued_at).getTime(), 'its place, not the back of the line');

  plan = await checksQueue.admit(pool);
  assert.equal(plan.byRun.get(again).ahead, 0, 'ahead of the run that asked after it');
  assert.equal(plan.byRun.get(later).ahead, 1);
  await checkRuns.finish(pool, holder);
  plan = await checksQueue.admit(pool);
  assert.deepEqual(plan.admit, [again], 'and it gets the next slot');
});

// 12 Oct 2026: a release restarted the platform during a confirmation, and
// main stayed held until the run was 12 minutes stale and ran from the start.
// Now the main-check machine's next attempt passes the run id it kept back.
test('main-watch: an admitted run whose process died is taken over by the next attempt, and its Jobs read', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const config = { workerRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers' } };
  const kubernetes = require('../src/services/kubernetes');
  const fresh_ = t.mock.method(unitSuite, 'maybeRunUnitSuite', async () => null);
  const found = t.mock.method(kubernetes, 'findCheckJobs', async () => ({
    unitSuites: [{ name: `sv-unit-suite-smain-${appId}-x`, state: 'running' }], unitShards: 1, captures: [],
  }));
  t.mock.method(kubernetes, 'collectCheckJob', async () => ({ state: 'succeeded', stdout: '', stderr: '', exitCode: 0, timedOut: false }));
  t.mock.method(kubernetes, 'deleteSettledCheckJobs', async () => 1);
  t.mock.method(unitSuite, 'outcomeFromLog', async () => ({ row: { status: 'pass', failureReason: '', summary: { tests: 40, pass: 40, fail: 0 } } }));
  const sha = 'a'.repeat(40);
  const app = { id: appId, slug: 'demo', repo_url: 'https://github.com/org/demo' };
  await pool.query('UPDATE apps SET main_check_sha = $2 WHERE id = $1', [appId, sha]);
  const running = await as('old-pod', () => askMain(pool, appId, sha));
  await checksQueue.admit(pool);
  assert.deepEqual(await admittedIds(pool), [running]);

  // The release's shutdown hands its rows over; the new process's attempt
  // takes the run at once.
  await as('old-pod', () => checkRuns.release(pool));
  const out = await as('new-pod', () => mainWatch.runMainSuite(config, pool, { app, sha, resumeRunId: running }));
  assert.equal(out.state, 'passing');
  assert.equal(fresh_.mock.callCount(), 0, 'its Jobs were read, not run again');
  assert.equal(found.mock.calls[0].arguments[1].previewRunId, running);
  assert.equal((await pool.query('SELECT 1 FROM check_runs WHERE run_id = $1', [running])).rows.length, 0, 'its row is cleared');
});

test('main-watch: a run waiting when its process died runs again in its place', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const config = { workerRuntime: 'kubernetes' };
  const suite = t.mock.method(unitSuite, 'maybeRunUnitSuite', async () => null);
  const sha = 'e'.repeat(40);
  const app = { id: appId, slug: 'demo', repo_url: 'https://github.com/org/demo' };
  await pool.query('UPDATE apps SET main_check_sha = $2 WHERE id = $1', [appId, sha]);
  // Both slots a main-watch run may use are busy.
  const { rows: [other] } = await pool.query(`INSERT INTO apps (slug) VALUES ('other') RETURNING id`);
  const busy = await as('live-pod', () => askMain(pool, other.id, 'f'.repeat(40)));
  const p1 = await as('live-pod', async () => ask(pool, await session(pool, appId)));
  await checksQueue.admit(pool);
  const waiting = await as('old-pod', () => askMain(pool, appId, sha));
  const { rows: [before] } = await pool.query('SELECT queued_at FROM check_runs WHERE run_id = $1', [waiting]);

  // Its process dies; the next attempt passes its run id back, but a run
  // never admitted has no Jobs: it asks for a slot again, in the dead run's place.
  await as('old-pod', () => checkRuns.release(pool));
  const out = as('new-pod', () => mainWatch.runMainSuite(config, pool, { app, sha, resumeRunId: waiting }));
  const again = await until(async () => (await pool.query(
    "SELECT * FROM check_runs WHERE kind = 'main' AND app_id = $1", [appId])).rows.find((r) => r.run_id !== waiting));
  assert.equal(new Date(again.queued_at).getTime(), new Date(before.queued_at).getTime(), 'it took over the dead run\'s place');
  assert.equal((await pool.query('SELECT 1 FROM check_runs WHERE run_id = $1', [waiting])).rows.length, 0);

  // A slot frees; the run takes it and settles.
  await checkRuns.finish(pool, busy);
  assert.equal((await out).state, 'skipped');
  assert.equal(suite.mock.callCount(), 1);
  assert.deepEqual(await admittedIds(pool), [p1], 'its slot went back');
});

// ── A finished run's slot ───────────────────────────────────────────────
//
// 23 Nov 2026: PR 7029's checks.run was claimed at 17:12 and its one attempt
// succeeded at 17:27, but its row, admitted at 17:18, was still there, owned
// by a conductor that had drained for a release at about 17:22. The queue
// counted it until 17:36, with four slots in all, and ten rows like it were
// still in the table, the oldest 39 days.

test('a run whose work item settled frees its slot at the next pass, and its row is cleared', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const s = await session(pool, appId);
  const holder = await as('conductor-6b85:7', () => admitted(pool, s, 'run-2-6'));
  await work(pool, s.id, 'run-2-6', { status: 'running' });
  await as('conductor-6b85:7', () => checkRuns.release(pool));
  const waiting = await ask(pool, await session(pool, appId));
  let plan = await checksQueue.admit(pool);
  assert.deepEqual(plan.admit, [], 'handed over while its run went on: its Jobs may still run, so it holds');
  assert.ok(await present(pool, holder));

  // The run settles on the draining process; its delete is lost.
  await work(pool, s.id, 'run-2-6', { status: 'settled', result: { outcome: 'verdict' } });
  plan = await checksQueue.admit(pool);
  assert.deepEqual(plan.admit, [waiting], 'the slot is free at once, not when the deadline runs out');
  assert.deepEqual(plan.swept, [{ runId: holder, sessionId: s.id, why: 'finished' }]);
  assert.equal(await present(pool, holder), false);
});

test('a run the machine cancelled holds its slot until the clean-up that stops its Jobs has run', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const s = await session(pool, appId);
  const holder = await admitted(pool, s, 'run-3-9');
  await pool.query("UPDATE check_runs SET owner = 'gone-pod:1:exited', heartbeat_at = 'epoch' WHERE run_id = $1", [holder]);
  // The kernel's cancel: settled, `cancelled` in its result, and the
  // checks.cancel item queued to run once the claim has stopped.
  await work(pool, s.id, 'run-3-9', { status: 'settled', result: { cancelled: true } });
  await work(pool, s.id, 'cancel:run-3-9', { kind: 'checks.cancel', status: 'queued' });
  const waiting = await ask(pool, await session(pool, appId));
  let plan = await checksQueue.admit(pool);
  assert.deepEqual(plan.admit, []);
  assert.ok(await present(pool, holder), 'its Jobs are still to be stopped');

  // The clean-up ran but its delete was lost too: the row goes now.
  await work(pool, s.id, 'cancel:run-3-9', { kind: 'checks.cancel', status: 'settled', result: { cancelled: true } });
  plan = await checksQueue.admit(pool);
  assert.deepEqual(plan.admit, [waiting]);
  assert.equal(await present(pool, holder), false);
});

test('the leftovers are swept: finished, ended, abandoned and past their deadline; a run still going is kept', async (t) => {
  const env = await fresh(t, { cap: 4 });
  if (!env) return;
  const { pool, appId } = env;
  const exited = 'social-vibecoding-conductor-6b85dbfff4-fzm94:7:exited';
  const row = async (s, { runKey = null, owner = exited, admittedAgo = '3 days', heartbeat = "'epoch'", extra = {} } = {}) => {
    const runId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO check_runs (run_id, session_id, kind, commit_sha, owner, manifest, started_at, heartbeat_at, queued_at, admitted_at)
       VALUES ($1, $2, 'proposal', $3, $4, $5::jsonb, NOW() - $6::interval, ${heartbeat}, NOW() - $6::interval, NOW() - $6::interval)`,
      [runId, s.id, s.checks_commit_sha, owner,
        JSON.stringify({ launched: true, workflow: true, ...(runKey ? { runKey } : {}), ...extra }), admittedAgo]);
    return runId;
  };
  // Days old, handed over on exit, its work item long settled.
  const a = await session(pool, appId);
  const settled = await row(a, { runKey: 'run-2-6' });
  await work(pool, a.id, 'run-2-6', { status: 'settled', result: {} });
  // 39 days old, its work item already purged.
  const purged = await row(await session(pool, appId), { runKey: 'run-1-2', admittedAgo: '39 days' });
  // A merged proposal's, its owner gone, admitted a minute ago; the retire
  // cancelled its run and stops the session's Jobs.
  const merged = await session(pool, appId, { status: 'merged' });
  const ended = await row(merged, { runKey: 'run-4-1', owner: 'pod-z:1', admittedAgo: '1 minute', heartbeat: "NOW() - INTERVAL '5 minutes'" });
  await work(pool, merged.id, 'run-4-1', { status: 'settled', result: { cancelled: true } });
  // An archived one's whose run is still outstanding: its next claim comes
  // back for the row, so it stays, though it holds no slot.
  const archived = await session(pool, appId, { status: 'archived' });
  const closing = await row(archived, { runKey: 'run-4-2', owner: 'pod-z:1', admittedAgo: '1 minute', heartbeat: "NOW() - INTERVAL '5 minutes'" });
  await work(pool, archived.id, 'run-4-2', { status: 'running' });
  // A settled run whose early unit Jobs would not stop, past their deadline.
  const lingered = await row(await session(pool, appId), { runKey: 'run-5-1', admittedAgo: '1 hour', extra: { settled: true } });

  // Kept: its work item's retry will come back for it.
  const b = await session(pool, appId);
  const retrying = await row(b, { runKey: 'run-6-2' });
  await work(pool, b.id, 'run-6-2', { status: 'queued' });
  // Kept: handed over a moment ago, its Jobs may still run.
  const c = await session(pool, appId);
  const recent = await row(c, { runKey: 'run-7-1', admittedAgo: '2 minutes' });
  await work(pool, c.id, 'run-7-1', { status: 'running' });
  // Kept: lingering within its Jobs' deadline.
  const lingering = await row(await session(pool, appId), { runKey: 'run-8-1', admittedAgo: '1 minute', extra: { settled: true } });
  // Kept: a live run.
  const live = await admitted(pool, await session(pool, appId), 'run-9-1');
  // Kept: main-watch's, whatever its age (its next attempt adopts it; the
  // hour-long expiry of a silent one is main-watch's own rule).
  const main = await askMain(pool, appId, 'a'.repeat(40));
  await pool.query(`UPDATE check_runs SET owner = $2, heartbeat_at = NOW() - INTERVAL '5 minutes',
                           admitted_at = NOW() - INTERVAL '3 days' WHERE run_id = $1`, [main, exited]);

  const plan = await checksQueue.admit(pool);
  const why = Object.fromEntries((plan.swept || []).map((x) => [x.runId, x.why]));
  assert.deepEqual(why, { [settled]: 'finished', [purged]: 'abandoned', [ended]: 'ended', [lingered]: 'deadline' });
  for (const id of [settled, purged, ended, lingered]) assert.equal(await present(pool, id), false);
  for (const id of [retrying, recent, closing, lingering, live, main]) assert.ok(await present(pool, id), id);
  assert.deepEqual(plan.holding, { main: 0, proposal: 3 }, 'the recent hand-over, the lingering run and the live one');
});

// ── A check of main a newer merge made pointless ────────────────────────

test('main-watch: a running check is stopped once a newer merge has passed, never while its green may be read', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const { pool, appId } = env;
  const saved = process.env.MAIN_WATCH_STOP_POLL_MS;
  process.env.MAIN_WATCH_STOP_POLL_MS = '100';
  t.after(() => { if (saved === undefined) delete process.env.MAIN_WATCH_STOP_POLL_MS; else process.env.MAIN_WATCH_STOP_POLL_MS = saved; });
  const config = { workerRuntime: 'kubernetes', kubernetes: { workerNamespace: 'workers' } };
  const deleted = [];
  t.mock.method(require('../src/services/kubernetes'), 'deleteRunCheckJobs', async (cfg, args) => { deleted.push(args); return 1; });
  let release = null;
  t.mock.method(unitSuite, 'maybeRunUnitSuite', (opts) => new Promise((resolve, reject) => {
    release = () => resolve(null);
    opts.signal?.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
  }));
  const app = { id: appId, slug: 'demo', repo_url: 'https://github.com/org/demo' };
  const [A, B, C, OLD] = ['a', 'b', 'c', 'f'].map((ch) => ch.repeat(40));
  // A green recorded before this run started is an older run's, never a newer one's.
  await pool.query(
    `INSERT INTO main_watch_verdicts (app_id, sha, state, created_at) VALUES ($1, $2, 'passing', NOW() - INTERVAL '1 minute')`,
    [appId, OLD]);
  await pool.query('UPDATE apps SET main_check_sha = $2 WHERE id = $1', [appId, A]);
  // The run's own pool, counting the times its watch asks whether it is read.
  let asked = 0;
  const watched = {
    query: (sql, params) => {
      if (/SELECT a\.main_check_sha,/.test(String(sql))) asked += 1;
      return pool.query(sql, params);
    },
    connect: () => pool.connect(),
  };
  t.after(() => { if (release) release(); });
  const running = mainWatch.runMainSuite(config, watched, { app, sha: A, phase: 'first' });
  const row = await until(async () => (await pool.query(
    "SELECT run_id FROM check_runs WHERE kind = 'main' AND app_id = $1 AND admitted_at IS NOT NULL", [appId])).rows[0]);

  // A newer merge claims the row; another superseded run passes. Neither
  // says this run's green would go unread: a later red may still need it.
  await pool.query('UPDATE apps SET main_check_sha = $2 WHERE id = $1', [appId, B]);
  await pool.query(`INSERT INTO main_watch_verdicts (app_id, sha, state, superseded) VALUES ($1, $2, 'passing', TRUE)`, [appId, C]);
  const before = asked;
  await waitFor(() => asked >= before + 3, { label: 'the watch asking three times after the newer merge' });
  assert.equal((await pool.query('SELECT 1 FROM check_runs WHERE run_id = $1', [row.run_id])).rows.length, 1, 'it runs on');
  assert.deepEqual(deleted, []);

  // The newer merge's own run passes (it copied a pass of its tree).
  await pool.query(`INSERT INTO main_watch_verdicts (app_id, sha, state) VALUES ($1, $2, 'passing')`, [appId, B]);
  const out = await within(running, 5000, 'the check of main a newer green made pointless');
  assert.equal(out.state, 'superseded');
  assert.equal((await pool.query('SELECT 1 FROM check_runs WHERE run_id = $1', [row.run_id])).rows.length, 0, 'its slot is free');
  assert.deepEqual(deleted, [{ sessionId: `main-${appId}`, previewRunId: row.run_id }], 'and its Jobs deleted');
});
