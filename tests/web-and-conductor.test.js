'use strict';

// What a process that never leads needs from the one that does, and what
// each process does for itself (docs/plans/web-and-conductor.md): statuses
// the leader keeps in memory, published for the others; the leader's loops
// woken over the bus from wherever a request landed; the open-issues copy
// kept in step across processes; DM answers asked again exactly once;
// workers warm in one process left alone by the others; and a web process
// that never stands for election. The other process is played by the
// registry's copy of its holds (a fake database answers the mirror's read)
// and the bus by a stub of its publish.
//
// Run with: node --test tests/web-and-conductor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const processes = require('../src/services/processes');
const wsBus = require('../src/services/ws-bus');
const leaderStatus = require('../src/services/leader-status');

const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The registry, over a database whose only other live process ('pod-web')
// holds `held` ([kind, ref] pairs). `holders` is answered exactly too.
async function elsewhere(held, other = 'pod-web') {
  processes._reset();
  const pool = {
    query: async (sql, params = []) => {
      if (/FROM process_holds h\s+JOIN platform_processes p ON p\.id = h\.process_id\s+WHERE h\.process_id <> \$1/.test(sql)) {
        return { rows: held.map(([kind, ref]) => ({ kind, ref: String(ref), process_id: other })) };
      }
      if (/SELECT DISTINCT h\.process_id/.test(sql)) {
        const kinds = [].concat(params[0]);
        const hit = held.some(([kind, ref]) => kinds.includes(kind) && String(ref) === String(params[1]));
        return { rows: hit ? [{ process_id: other }] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  await processes.start({ pool, role: 'web' });
  return pool;
}

function capturePublishes(t) {
  const sent = [];
  const real = wsBus.publish;
  wsBus.publish = (kind, routing, data) => { sent.push({ kind, routing, data }); };
  t.after(() => { wsBus.publish = real; });
  return sent;
}

// ── Leader status ─────────────────────────────────────────────────────

test('a status is read from memory where its work runs, and from the leader\'s copy elsewhere', async (t) => {
  leaderStatus._reset();
  t.after(() => leaderStatus._reset());
  const rows = new Map();
  const pool = {
    query: async (sql, params) => {
      if (sql.startsWith('INSERT INTO leader_status')) {
        rows.set(params[0], { value: JSON.parse(params[1]), at: Date.now() });
        return { rows: [] };
      }
      if (sql.includes('FROM leader_status')) {
        const row = rows.get(params[0]);
        const fresh = row && Date.now() - row.at < params[1] * 1000;
        return { rows: fresh ? [{ value: row.value }] : [] };
      }
      return { rows: [] };
    },
  };
  let lastSweepAt = new Date('2026-10-14T12:00:00Z');
  leaderStatus.provide('app-domains.sweep', () => ({ lastSweepAt, lastError: null, sweepInFlight: false }));
  await leaderStatus.start({ pool });
  // Where the work runs: its memory, as it is now.
  lastSweepAt = new Date('2026-10-14T12:05:00Z');
  assert.equal((await leaderStatus.read('app-domains.sweep', pool)).lastSweepAt.toISOString(), '2026-10-14T12:05:00.000Z');
  // Elsewhere (no provider): the copy, as res.json would have sent it.
  assert.deepEqual(rows.get('app-domains.sweep').value,
    { lastSweepAt: '2026-10-14T12:00:00.000Z', lastError: null, sweepInFlight: false });
  leaderStatus.stop();
  const published = rows.get('app-domains.sweep').value;
  leaderStatus._reset();
  rows.set('app-domains.sweep', { value: published, at: Date.now() });
  assert.deepEqual(await leaderStatus.read('app-domains.sweep', pool), published);
  // A copy its leader stopped writing is nobody's.
  rows.set('app-domains.sweep', { value: published, at: Date.now() - leaderStatus.STALE_MS - 1000 });
  assert.equal(await leaderStatus.read('app-domains.sweep', pool), null);
  assert.deepEqual(await leaderStatus.readOr('app-domains.sweep', pool, () => ({ own: true })), { own: true });
  // A database that will not answer is no copy, never a failed route.
  assert.equal(await leaderStatus.read('app-domains.sweep', { query: async () => { throw new Error('down'); } }), null);
});

test('the leader publishes the admin statuses it keeps in memory, and stops as it hands over', () => {
  const body = serverJs.slice(serverJs.indexOf('async function becomeLeader()'), serverJs.indexOf('async function start()'));
  for (const key of [
    "require('./src/services/homeroom-bot').MEMORY_STATUS_KEY",
    "'bench-lane'",
    "'staging-reap.automatic'",
    "'app-domains.sweep'",
    "require('./src/services/app-storage-cap').LAST_SWEEP_STATUS_KEY",
  ]) {
    assert.ok(body.includes(`leaderStatus.provide(${key}`), `becomeLeader publishes ${key}`);
  }
  assert.match(body, /leaderStatus\.start\(\{ pool: getPool\(config\) \}\)/);
  const cleanupBody = serverJs.slice(serverJs.indexOf('async function cleanup()'));
  assert.match(cleanupBody, /require\('\.\/src\/services\/leader-status'\)\.stop\(\)/);
  // And the routes read them wherever they are served.
  const admin = fs.readFileSync(path.join(__dirname, '..', 'src/routes/admin.js'), 'utf8');
  assert.match(admin, /automatic: await leaderStatus\.readOr\('staging-reap\.automatic', pool, stagingReap\.readAutomatic\)/);
  assert.match(admin, /sweep: await leaderStatus\.readOr\('app-domains\.sweep', pool, appDomains\.getStatus\)/);
  const bench = fs.readFileSync(path.join(__dirname, '..', 'src/routes/homeroom-bench.js'), 'utf8');
  assert.equal(bench.match(/lane: await leaderStatus\.readOr\('bench-lane', pool, lane\.laneStatus\)/g).length, 2);
});

test('the Homeroom bot\'s queue shows why a row waits from the loop\'s memory, wherever the loop runs', async (t) => {
  const bot = require('../src/services/homeroom-bot');
  leaderStatus._reset();
  t.after(() => leaderStatus._reset());
  const now = Date.now();
  const waiting = {
    id: 1, app_id: 5, issue_number: 9, priority: 1, reason: 'new', started_at: null, waiting_total: 1, running_total: 0,
  };
  const pool = { query: async () => ({ rows: [waiting] }) };
  // The loop's memory, as the leader publishes it: a platform fault.
  const memory = { ...bot.memoryStatus(now), fault: { attempts: 1, until: now + 60_000, error: 'worker quota', at: now } };
  assert.deepEqual(JSON.parse(JSON.stringify(memory)), memory, 'plain JSON, as it crosses the table');
  const snap = await bot.queueSnapshot(pool, {}, { now, memory });
  assert.equal(snap.items[0].waiting.reason, 'platform_fault');
  // An app backed off after a refusal, as busy.
  const backedOff = await bot.queueSnapshot(pool, {}, { now, memory: { ...bot.memoryStatus(now), backoff: [[5, now + 30_000]] } });
  assert.equal(backedOff.items[0].waiting.reason, 'session_busy');
  // A process not running the loop reads the copy, else its own (empty) memory.
  const copyPool = {
    query: async (sql) => (sql.includes('FROM leader_status') ? { rows: [{ value: memory }] } : { rows: [] }),
  };
  assert.equal((await bot.loopMemory(copyPool, now)).fault.error, 'worker quota');
  assert.deepEqual((await bot.loopMemory({ query: async () => ({ rows: [] }) }, now)).inFlight, []);
});

// ── Wakes over the bus ────────────────────────────────────────────────

test('a launch on a process not running the bench lane or the eval runner wakes the one that does', (t) => {
  const sent = capturePublishes(t);
  const lane = require('../src/services/bench/lane');
  const runner = require('../src/services/shots-eval-runner');
  assert.equal(lane.wake(), false, 'the lane does not run here');
  assert.equal(runner.wake(), false, 'nor the runner');
  assert.deepEqual(sent.map((m) => m.kind), ['bench_wake', 'shots_eval_wake']);
  // Where they do not run either, the bus half does nothing and publishes nothing.
  sent.length = 0;
  const ws = require('../src/services/ws');
  ws._onBusMessage({ kind: 'bench_wake', data: {} });
  ws._onBusMessage({ kind: 'shots_eval_wake', data: {} });
  assert.deepEqual(sent, [], 'a wake is never passed on again');
  assert.equal(lane.wakeHere(), false);
  assert.equal(runner.wakeHere(), false);
});

// ── The open-issues copy ──────────────────────────────────────────────

test('issues one process closes leave every process\'s open-issues copy, and are never passed on again', (t) => {
  const sent = capturePublishes(t);
  const github = require('../src/services/github');
  github.noteIssuesClosed('Acme', 'board', [4, 'x', 5]);
  github.invalidateIssuesCache('Acme', 'board');
  github.unsuppressIssues('Acme', 'board', [5]);
  assert.deepEqual(sent, [
    { kind: 'issues_cache', routing: { owner: 'Acme', repo: 'board' }, data: { closed: [4, 5] } },
    { kind: 'issues_cache', routing: { owner: 'Acme', repo: 'board' }, data: { invalidate: true } },
    { kind: 'issues_cache', routing: { owner: 'Acme', repo: 'board' }, data: { open: [5] } },
  ]);
  sent.length = 0;
  const ws = require('../src/services/ws');
  ws._onBusMessage({ kind: 'issues_cache', routing: { owner: 'Acme', repo: 'other' }, data: { closed: [7] } });
  ws._onBusMessage({ kind: 'issues_closed', routing: { owner: 'Acme', repo: 'other' }, data: { numbers: [8] }, fromWorkflow: true });
  assert.deepEqual(sent, [], 'what another process shared is applied here only');
  // Applied: the closed numbers are suppressed here, as noteIssuesClosed does.
  assert.equal(github.unsuppressIssues('Acme', 'other', [7, 8]), 2);
});

// ── DM answers asked again ────────────────────────────────────────────

test('a DM answer is held until its later try runs, and a restart leaves one a live process holds', async (t) => {
  processes._reset();
  t.after(() => processes._reset());
  const mayor = require('../src/services/homeroom-bot-mayor');
  let run = null;
  const pool = { query: async () => ({ rows: [{ x: 1 }] }) }; // a newer message: the try does nothing
  mayor.scheduleDeferred(pool, {}, {
    message: { id: 501 }, user: { id: 1 }, conversationId: 2, deps: { schedule: (fn) => { run = fn; } },
  }, 1);
  assert.equal(processes.heldHere('dm_defer', 501), true, 'marked from the promise');
  assert.equal(processes.localCount(), 0, 'a timer waiting is no work a drain waits for');
  const running = run();
  assert.equal(processes.heldHere('dm_answer', 501), true, 'the try running is');
  assert.equal(processes.heldHere('dm_defer', 501), false);
  assert.equal(processes.localCount(), 1);
  await running;
  assert.equal(processes.heldHere('dm_answer', 501), false, 'released once the try ran');

  // resumeDeferred: one message held by a live process, one nobody holds.
  const found = [
    { message_id: 601, conversation_id: 3, tries: 1, user_id: 1, username: 'a', content: 'hi' },
    { message_id: 602, conversation_id: 3, tries: 1, user_id: 1, username: 'a', content: 'hi' },
    { message_id: 603, conversation_id: 3, tries: 1, user_id: 1, username: 'a', content: 'hi' },
  ];
  const scheduled = [];
  const resumePool = { query: async (sql) => (sql.includes('homeroom_bot_dm_turns') ? { rows: found } : { rows: [] }) };
  const n = await mayor.resumeDeferred(resumePool, {}, {
    dmSvc: { botAccount: async () => ({ id: 99 }) },
    processes: {
      heldHere: () => false,
      holders: async (kinds, ref) => {
        assert.deepEqual(kinds, ['dm_defer', 'dm_answer'], 'waiting or running');
        if (Number(ref) === 603) throw new Error('database blip');
        return Number(ref) === 601 ? ['pod-web'] : [];
      },
    },
    schedule: (fn) => { scheduled.push(fn); },
  }, { minAgeSeconds: 60 });
  assert.equal(n, 1, 'only the one nobody holds is asked again: not one held, nor one whose holders cannot be read');
  assert.equal(scheduled.length, 1);
  assert.equal(processes.heldHere('dm_defer', 602), true, 'and this process marks it now');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot-mayor.js'), 'utf8'),
    /AND NOT EXISTS \(\n\s+SELECT 1 FROM conversation_messages n/, 'one written to since is not picked up again and again');
});

test('the bot sweeps every minute for DM answers a process that died had promised', () => {
  const bot = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  assert.match(bot, /resumeDeferred\(getPool\(config\), config, \{\}, \{ minAgeSeconds: 60 \}\)/);
  assert.match(bot, /if \(deferResumeTimer\) clearInterval\(deferResumeTimer\);\n\s+deferResumeTimer = null;/, 'stopped with the bot');
});

// ── Warm workers ──────────────────────────────────────────────────────

test('a worker warm here is a marker other processes read, never work a drain waits for', (t) => {
  processes._reset();
  t.after(() => processes._reset());
  const worker = require('../src/services/worker');
  worker._registryUpsertForTests(9201, { lastUsedMs: Date.now(), inFlight: false });
  assert.equal(processes.heldHere('warm', 9201), true);
  assert.equal(processes.localCount(), 0, 'warm is had, not done');
  assert.deepEqual(processes.localSnapshot(), []);
  worker._registryUpsertForTests(9201, { inFlight: true });
  assert.equal(processes.localCount(), 1, 'a turn in it is');
  worker.forgetWorker(9201);
  assert.equal(processes.heldHere('warm', 9201), false);
  assert.equal(processes.heldHere('session', 9201), false);
});

test('the idle sweep leaves a worker another process keeps warm, and adoption leaves it too', () => {
  const sweeper = serverJs.slice(serverJs.indexOf('function startIdleEvictionSweeper()'));
  assert.match(sweeper.slice(0, 3000), /if \(processes\.heldElsewhere\('warm', meta\.sessionId\)\) \{\n\s+worker\.forgetWorker\(meta\.sessionId\);/,
    'the last one keeping it warm evicts it');
  // A draining process lets go of its idle ones, so the next leader adopts them.
  const cleanupBody = serverJs.slice(serverJs.indexOf('async function cleanup()'));
  assert.match(cleanupBody.slice(0, 4000), /if \(!meta\.inFlight && !meta\.bootstrapping\) worker\.forgetWorker\(meta\.sessionId\);/);
  const adopt = serverJs.slice(serverJs.indexOf('async function adoptOrphanWorker('));
  assert.match(adopt, /processes\.holders\('warm', sessionId, pool\)/);
});

test('a heal or a drift rebuild under way elsewhere is not started twice', async (t) => {
  await elsewhere([['app_heal', 'ear-trainer'], ['drift_rebuild', 12]]);
  t.after(() => processes._reset());
  const heal = require('../src/services/app-heal');
  const out = await heal.checkAndHealOne({}, null, { slug: 'ear-trainer', runtime_kind: 'docker' });
  assert.deepEqual(out, { status: 'in_flight', slug: 'ear-trainer' });
  const drift = require('../src/services/main-drift-poller');
  assert.deepEqual(await drift.checkAndRedeployOne({}, null, { id: 12, slug: 'ear-trainer' }), { status: 'in_flight', slug: 'ear-trainer' });
});

// ── Roles at boot ─────────────────────────────────────────────────────

test('a web process never stands for leader, and only a serving one says its merges are live', () => {
  const startBody = serverJs.slice(serverJs.indexOf('async function start()'), serverJs.indexOf('// Boot only when run as the entry point'));
  assert.match(startBody, /const ownRole = processRole\.processRole\(\);/);
  assert.match(startBody, /await processes\.start\(\{ pool: getPool\(config\), role: ownRole \}\);/);
  const web = startBody.indexOf('} else if (!processRole.standsForLeader(ownRole)) {');
  const elect = startBody.indexOf('leadership.start(becomeLeader)');
  assert.ok(web !== -1 && elect > web, 'the election is the last branch, after the web one');
  assert.match(startBody, /if \(processRole\.servesRequests\(ownRole\)\) platformRelease\.recordRunning\(getPool\(config\)\);/);
  // The sweeps that read busy before acting read it for every process.
  assert.equal((serverJs.match(/worker\.isInFlight\(session\.id\) \|\| activeWorkersSvc\.isSessionBusy\(session\.id\)/g) || []).length, 2);
});
