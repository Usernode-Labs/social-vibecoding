'use strict';

// The checks queue on Admin → Health & status (#5054, part 1).
//
// The queue (services/checks-queue.js) decides how many proposals' checks run
// at once, and since the cpu-heavy node joined on 13 Oct 2026 its limit, not
// the cluster, is what holds runs back: the worker namespace used at most 32
// of the 112 CPUs of requests it allows. Until this, the only place an admin
// could see the queue was the platform log. These are the rules that need no
// database: how the live rows read on the page (describeQueue), the slot
// event every admitted run leaves, that the payload carries the queue to
// admins only, that the page draws it, and that a staging preview has a queue
// to draw. tests/checks-queue-status-postgres.test.js runs the snapshot and
// the events on a real Postgres.
//
// Run with: node --test tests/checks-queue-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const checksQueue = require('../src/services/checks-queue');
const { EVENT_TYPES } = require('../src/services/events');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const at = (minutesAgo, base = NOW) => new Date(base - minutesAgo * 60 * 1000);

// A row as SNAPSHOT_SQL returns it.
let seq = 0;
function row(over = {}) {
  seq += 1;
  const { admitted = null, alive = true, withinDeadline = true, base = NOW, ...rest } = over;
  return {
    run_id: `run-${seq}`, kind: 'proposal', class: 2, session_id: 100 + seq, app_id: null,
    commit_sha: `sha${seq}`, app_slug: 'demo', pr_number: 4000 + seq,
    queued_at: at(30 - seq, base), admitted_at: admitted == null ? null : at(admitted, base),
    heartbeat_at: at(0, base),
    alive, within_deadline: admitted == null ? false : withinDeadline, ...rest,
  };
}

// ── What the rows say ───────────────────────────────────────────────────

test('describeQueue reports who holds a slot, who waits and in what place, and how long the oldest has waited', () => {
  const rows = [
    row({ kind: 'main', class: 1, session_id: null, app_id: 7, pr_number: null, admitted: 3 }),
    row({ admitted: 9 }),
    row({ admitted: 8 }),
    row({ queued_at: at(12) }),
    row({ class: 4, queued_at: at(5) }),
  ];
  const q = checksQueue.describeQueue(rows, { cap: 2, now: NOW });
  assert.equal(q.enabled, true);
  assert.equal(q.cap, 2);
  assert.deepEqual(q.slots, { proposal: 2, main: 1, sharedUsed: 2 },
    'main-watch\'s first run is in its own slot and uses none of the shared ones');
  assert.equal(q.waiting, 2);
  assert.equal(q.oldestWaitMs, 12 * 60 * 1000, 'measured from the oldest waiting run\'s place in line');
  assert.deepEqual(q.runs.map((r) => [r.classLabel, r.state, r.place]), [
    ['main', 'holding', null],
    ['up for a vote', 'holding', null],
    ['up for a vote', 'holding', null],
    ['up for a vote', 'waiting', 1],
    ['draft', 'waiting', 2],
  ]);
  const waiting = q.runs[3];
  assert.equal(waiting.prNumber, rows[3].pr_number);
  assert.equal(waiting.app, 'demo');
  assert.equal(waiting.queuedAt, rows[3].queued_at.toISOString());
  assert.equal(waiting.admittedAt, null);
  assert.equal(waiting.ownerAlive, true);
  assert.equal(waiting.heartbeatAt, rows[3].heartbeat_at.toISOString());
});

test('a run whose owner is gone and that holds nothing is stale, and stale rows are listed last', () => {
  const q = checksQueue.describeQueue([
    row({ admitted: 20, alive: false, withinDeadline: true }),
    row({ admitted: 40, alive: false, withinDeadline: false }),
    row({ alive: false }),
    row(),
  ], { cap: 4, now: NOW });
  assert.deepEqual(q.runs.map((r) => [r.state, r.ownerAlive]),
    [['holding', false], ['waiting', true], ['stale', false], ['stale', false]],
    'a dead run whose Jobs may still be on the cluster still holds its slot, as planAdmission counts it');
  assert.deepEqual(q.slots, { proposal: 1, main: 0, sharedUsed: 1 });
  assert.equal(q.runs[1].place, 1, 'a dead waiter is not in line: the harvest re-drives it in its place');
  assert.equal(q.waiting, 1);
});

test('a run a pass would admit now still reads as waiting, at the head of the line', () => {
  // One free slot and two in line: planAdmission would admit the first, but
  // nothing has, so the page says it is first in line.
  const rows = [row({ admitted: 2 }), row(), row()];
  const q = checksQueue.describeQueue(rows, { cap: 2, now: NOW });
  assert.deepEqual(checksQueue.planAdmission(rows, { cap: 2 }).admit, [rows[1].run_id]);
  assert.deepEqual(q.runs.map((r) => [r.state, r.place]), [['holding', null], ['waiting', 1], ['waiting', 2]]);
});

test('a second main-watch run uses a shared slot, and a cap of 0 says the queue is off', () => {
  const q = checksQueue.describeQueue([
    row({ kind: 'main', class: 1, session_id: null, admitted: 2 }),
    row({ kind: 'main', class: 1, session_id: null, admitted: 1 }),
    row({ admitted: 1 }),
  ], { cap: 4, now: NOW });
  assert.deepEqual(q.slots, { proposal: 1, main: 2, sharedUsed: 2 });
  const off = checksQueue.describeQueue([], { cap: 0, now: NOW });
  assert.equal(off.enabled, false);
  assert.equal(off.oldestWaitMs, null);
  assert.deepEqual(off.runs, []);
});

// ── The slot event ──────────────────────────────────────────────────────

// A pool that answers the admission pass from `rows` and records every write.
function fakePool(rows) {
  const writes = [];
  const client = {
    async query(sql, params) {
      if (/FROM check_runs cr/.test(sql)) return { rows };
      if (/UPDATE check_runs SET admitted_at/.test(sql)) {
        for (const r of rows) if (params[0].includes(r.run_id)) r.admitted_at = new Date();
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    writes,
    async connect() { return client; },
    async query(sql, params) {
      if (/INSERT INTO events/.test(sql)) writes.push({ type: params[3], sessionId: params[2], appId: params[1], metadata: JSON.parse(params[4]) });
      if (/UPDATE check_runs SET admitted_at/.test(sql)) throw new Error('database is struggling');
      return { rows: [] };
    },
  };
}

test('every admitted run, and every run let go without a slot, leaves one CHECKS_SLOT_GRANTED event', async () => {
  const free = row({ class: 2 });
  const pool = fakePool([free]);
  const slot = await checksQueue.waitForSlot(pool, { runId: free.run_id, cap: 1 });
  assert.equal(slot.outcome, 'admitted');
  await new Promise((r) => setImmediate(r));
  assert.equal(pool.writes.length, 1);
  assert.equal(pool.writes[0].type, EVENT_TYPES.CHECKS_SLOT_GRANTED);
  assert.equal(pool.writes[0].sessionId, free.session_id, 'read from the plan\'s own run');
  assert.deepEqual({ ...pool.writes[0].metadata, waitedMs: 0 },
    { runId: free.run_id, kind: 'proposal', class: 'promoted', waitedMs: 0, failedOpen: false });

  // The pass itself fails: the run goes ahead, and the event says so.
  const broken = { ...fakePool([]), async connect() { throw new Error('no connection'); } };
  broken.writes = [];
  const brokenQuery = broken.query;
  broken.query = async (sql, params) => {
    if (/INSERT INTO events/.test(sql)) broken.writes.push({ metadata: JSON.parse(params[4]) });
    return brokenQuery(sql, params).catch(() => ({ rows: [] }));
  };
  const open = await checksQueue.waitForSlot(broken, { runId: 'run-x', cap: 1 });
  assert.equal(open.failedOpen, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(broken.writes.length, 1);
  assert.equal(broken.writes[0].metadata.failedOpen, true);
});

test('a run that leaves the line without a slot records nothing, and an event write that fails never reaches the run', async () => {
  const waiting = row({ class: 4 });
  const holder = row({ admitted: 1 });
  const pool = fakePool([holder, waiting]);
  let wanted = true;
  const left = checksQueue.waitForSlot(pool, { runId: waiting.run_id, cap: 1, pollMs: 10, stillWanted: async () => wanted });
  await new Promise((r) => setTimeout(r, 40));
  wanted = false;
  assert.equal((await left).outcome, 'superseded');
  assert.equal(pool.writes.length, 0);

  const free = row();
  const failing = fakePool([free]);
  failing.query = async (sql) => {
    if (/INSERT INTO events/.test(sql)) throw new Error('events is full');
    return { rows: [] };
  };
  assert.equal((await checksQueue.waitForSlot(failing, { runId: free.run_id, cap: 1 })).outcome, 'admitted');
});

// ── The payload ─────────────────────────────────────────────────────────

test('the status payload carries the queue snapshot, and redact() keeps it from anyone but an admin', () => {
  const src = read('src/services/status.js');
  assert.match(src, /checksQueue\.snapshot\(pool\)\.catch\(\(\) => null\)/, 'gathered with the rest, and never costs it');
  assert.match(src, /checksQueue: checksQueueSnapshot,/);
  const redact = src.slice(src.indexOf('function redact('), src.indexOf('// ── Stale-while-revalidate cache'));
  assert.match(redact, /checksQueue: _queue, \.\.\.rest/,
    'the non-admin payload is built from `rest`, which no longer has it');
  assert.doesNotMatch(redact.slice(redact.indexOf('return {', redact.indexOf('const stripWorker'))), /checksQueue/);
});

test('the snapshot never rejects: null when the queue cannot be read, last24h null when only the events cannot', async () => {
  const failing = { query: async () => { throw new Error('the database went away'); } };
  assert.equal(await checksQueue.snapshot(failing, { cap: 4 }), null);
  const eventsMissing = {
    query: async (sql) => {
      if (/FROM events/.test(sql)) throw new Error('relation "events" does not exist');
      return { rows: [row({ admitted: 1 })] };
    },
  };
  const q = await checksQueue.snapshot(eventsMissing, { cap: 4 });
  assert.equal(q.slots.proposal, 1, 'the live rows still show');
  assert.equal(q.last24h, null);
});

test('with the queue off the snapshot reads no check_runs, and still reports the last day', async () => {
  const seen = [];
  const pool = {
    query: async (sql) => {
      seen.push(sql);
      return { rows: [{ runs: 3, waited: 0, median_wait_ms: null, longest_wait_ms: null, failed_open: 0 }] };
    },
  };
  const q = await checksQueue.snapshot(pool, { cap: 0 });
  assert.equal(q.enabled, false);
  assert.deepEqual(q.runs, []);
  assert.deepEqual(q.last24h, { runs: 3, waited: 0, medianWaitMs: null, longestWaitMs: null, failedOpen: 0 });
  assert.ok(seen.every((sql) => !/FROM check_runs/.test(sql)));
});

test('a staging preview\'s ?demo=1 status serves a fake burst through the same describeQueue', () => {
  const src = read('src/routes/status.js');
  const demo = src.slice(src.indexOf('function withStagingDemo('), src.indexOf('function statusRoutes('));
  assert.match(demo, /checksQueueSvc\.describeQueue\(\[/);
  assert.match(demo, /app_slug: 'staging-demo'/, 'obviously fake');
  assert.match(demo, /last24h: \{ runs: /);
  assert.match(demo, /\n    checksQueue,\n/);
});

// ── The page ────────────────────────────────────────────────────────────

function loadSection() {
  globalThis.window = globalThis.window || globalThis;
  return loadTsx('frontend/src/features/admin/admin-status.tsx', {
    stubs: {
      './admin-console.js': { AdminUI: new Proxy({}, { get: (_t, key) => String(key) }) },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
}

const page = loadSection();
const render = (q, now = NOW) => renderToHtml(createElement(page.ChecksQueue, { q, now }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

test('the card shows the proposal runs against the limit, who holds and waits, and the last day', () => {
  const q = {
    ...checksQueue.describeQueue([
      row({ kind: 'main', class: 1, session_id: null, pr_number: null, queued_at: at(4), admitted: 3 }),
      row({ queued_at: at(10), admitted: 8 }),
      row({ queued_at: at(9), admitted_at: at(7), within_deadline: true }),
      row({ queued_at: at(6, NOW - 40 * 1000) }),
      row({ class: 3, queued_at: at(1, NOW - 5 * 1000) }),
      row({ alive: false, queued_at: at(12) }),
    ], { cap: 2, now: NOW }),
    last24h: { runs: 112, waited: 37, medianWaitMs: 135000, longestWaitMs: 890000, failedOpen: 1 },
  };
  const out = text(render(q));
  assert.match(out, /Proposal runs \(holding \/ limit\) 2 \/ 2/);
  assert.match(out, /Main-watch 1 in its own slot/);
  assert.match(out, /2 waiting · oldest 6m 40s/);
  assert.match(out, /has a slot main demo slot for 3m 0s · owner alive/);
  assert.match(out, /1st in line up for a vote demo PR #\d+ waiting 6m 40s · owner alive/);
  assert.match(out, /2nd in line CLI hand-off demo PR #\d+ waiting 1m 5s · owner alive/);
  assert.match(out, /stale up for a vote demo PR #\d+ waiting 12m 0s · owner gone/);
  assert.match(out, /Last 24 hours 37 of 112 runs waited · median wait 2m 15s · longest 14m 50s · 1 went ahead without a slot/);
  assert.match(render(q), /border-red-300/, 'a run whose owner is gone has a red outline');
});

test('the card says when the queue is off, empty, or could not be read', () => {
  assert.match(text(render(null)), /^Queue status is unavailable\.$/);
  const empty = { ...checksQueue.describeQueue([], { cap: 4 }), last24h: { runs: 0, waited: 0, medianWaitMs: null, longestWaitMs: null, failedOpen: 0 } };
  const out = text(render(empty));
  assert.match(out, /Proposal runs \(holding \/ limit\) 0 \/ 4/);
  assert.match(out, /No checks running or waiting\./);
  assert.match(out, /Last 24 hours 0 of 0 runs waited$/, 'no wait figures, and nothing about runs that went ahead');
  const off = text(render({ ...checksQueue.describeQueue([], { cap: 0 }), last24h: null }));
  assert.match(off, /The checks queue is off\. Every run starts at once\./);
  assert.doesNotMatch(off, /Proposal runs/);
  assert.match(off, /Last 24 hours Unavailable\./);
});

test('the card is an admin-only section of Health & status under Capacity, drawn only for an admin payload', () => {
  const src = read('frontend/src/features/admin/admin-status.tsx');
  const at = src.indexOf('id="admin-status-checks-queue-heading"');
  assert.ok(at > src.indexOf('id="admin-status-capacity"'), 'just under Capacity');
  const section = src.slice(src.lastIndexOf('<section', at), src.indexOf('</section>', at));
  assert.match(section, /<section className="admin-only">/);
  assert.match(section, />Checks queue<\/h3>/);
  assert.match(section, /id="admin-status-checks-queue"/);
  assert.match(section, /\{data && isAdmin \? <ChecksQueue q=\{d\.checksQueue\} now=\{statusNow\} \/> : null\}/);
});
