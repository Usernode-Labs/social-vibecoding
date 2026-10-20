// #2038: the sweep that measures every promoted proposal against main
// (services/proposal-scans.js measurePromoted, the workflow's
// `proposal-measure` clock; once server.js measurePromotedProposals and,
// before that, the session sweeper's "Pass 9"), which replaced #1442's
// freshness pass.
//
// The old pass was bounded in ways that were forced on it rather than
// chosen: ten rows a tick, a five-minute per-row cooldown, leader-only. Every
// one of those existed because a single row cost two to six GitHub reads
// against a shared rate limit. The consequence was that a proposal nobody had
// opened could carry numbers that were hours old while the merge gate read
// them — and a drifted proposal below the vote threshold was measured by
// nothing at all, which is #2038's F2.
//
// A measurement is local plumbing against the app's own mirror now, so the
// cap and the cooldown are gone on purpose. The properties still worth
// pinning are the ones that keep it correct rather than the ones that kept it
// cheap:
//
//   * EVERY promoted proposal is measured, with no per-tick cap and no
//     per-row cooldown — the regression this whole change exists to prevent;
//   * a session mid-turn is skipped, because its head is about to move and
//     the answer would be wrong before it was written;
//   * rows are grouped by app, and one `git fetch` serves every open
//     proposal on that app (it was one per proposal until 19 Oct 2026);
//   * it runs one pass at a time across every process (a clock of the
//     workflow), so a multi-instance deploy does not double-fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const ROOT = path.join(__dirname, '..');
const SCANS = fs.readFileSync(path.join(ROOT, 'src/services/proposal-scans.js'), 'utf8');
const CLOCKS = fs.readFileSync(path.join(ROOT, 'src/workflow/clock/services.ts'), 'utf8');

const integration = require('../src/services/integration');
const activeWorkers = require('../src/services/active-workers');
const scans = require('../src/services/proposal-scans');

// The measurement pass, isolated so a match in another scan cannot pass a
// test about this one.
function pass() {
  const start = SCANS.indexOf('async function measurePromoted(');
  assert.notEqual(start, -1, 'the measurement sweep exists in services/proposal-scans.js');
  const end = SCANS.indexOf('\n}\n', start);
  return SCANS.slice(start, end);
}

// A pool that answers the candidate query with `rows`, and records it.
function poolOf(rows) {
  const queries = [];
  return {
    queries,
    async query(sql) { queries.push(sql); return { rows, rowCount: rows.length }; },
  };
}

const row = (id, appId) => ({ id, app_id: appId, status: 'promoted', repo_url: `https://github.com/org/app${appId}`, branch_name: `b${id}` });

test('every promoted proposal is measured — no per-tick cap, no per-row cooldown', async (t) => {
  const block = pass();
  assert.doesNotMatch(block, /MAX_[A-Z_]*PER_SWEEP/,
    'a per-tick cap is what let a proposal go hours without being measured');
  assert.doesNotMatch(block, /COOLDOWN_MS/,
    'a per-row cooldown is the other half of the same failure');
  assert.doesNotMatch(block, /LIMIT \d+/,
    'the candidate query must not silently measure only the first N rows');
  assert.match(block, /status = 'promoted'/,
    'the candidate set is every promoted proposal');

  const rows = Array.from({ length: 60 }, (_, i) => row(i + 1, (i % 3) + 1));
  t.mock.method(activeWorkers, 'isSessionBusy', () => false);
  t.mock.method(integration, 'fetchAppMirror', async () => '/tmp/mirror');
  const measure = t.mock.method(integration, 'measure', async () => ({ ok: true }));
  const out = await scans.measurePromoted(poolOf(rows));
  assert.equal(measure.mock.callCount(), 60, 'all sixty, in one pass');
  assert.deepEqual(out, { promoted: 60, apps: 3, measured: 60 });
});

test('a session mid-turn is skipped', async (t) => {
  // Its head is about to move; an answer written now describes a commit that
  // will not exist by the time anybody reads it. Mid-turn on any process: a
  // web process runs the turns its routes start
  // (docs/plans/web-and-conductor.md), and isSessionBusy reads them all.
  assert.match(SCANS, /function busy\(sessionId\) \{\n\s+return require\('\.\/active-workers'\)\.isSessionBusy\(Number\(sessionId\)\);/);
  assert.match(pass(), /const ready = sessions\.filter\(\(session\) => !busy\(session\.id\)\);/);

  t.mock.method(activeWorkers, 'isSessionBusy', (id) => id === 2 || id === 3);
  const fetched = t.mock.method(integration, 'fetchAppMirror', async () => '/tmp/mirror');
  const measure = t.mock.method(integration, 'measure', async () => ({ ok: true }));
  // Session 3 is the only one on app 2: a busy app's mirror is not fetched.
  const out = await scans.measurePromoted(poolOf([row(1, 1), row(2, 1), row(3, 2)]));
  assert.deepEqual(measure.mock.calls.map((c) => c.arguments[0].session.id), [1]);
  assert.equal(fetched.mock.callCount(), 1, 'an app with nobody ready is not fetched');
  assert.equal(out.measured, 1);
});

test('candidates are grouped by app so one fetch serves them all', async (t) => {
  const block = pass();
  assert.match(block, /ORDER BY cs\.app_id/,
    'measuring app-by-app is what makes a single mirror fetch cover every '
    + 'open proposal on it');
  assert.match(block, /for \(const sessions of byApp\.values\(\)\)/);

  t.mock.method(activeWorkers, 'isSessionBusy', () => false);
  const fetched = t.mock.method(integration, 'fetchAppMirror', async (ready) => `/tmp/mirror-${ready[0].app_id}`);
  const measure = t.mock.method(integration, 'measure', async () => ({ ok: true }));
  await scans.measurePromoted(poolOf([row(1, 1), row(2, 1), row(3, 2), row(4, 2), row(5, 2)]));
  assert.deepEqual(fetched.mock.calls.map((c) => c.arguments[0].map((s) => s.id)), [[1, 2], [3, 4, 5]], 'one fetch for each app');
  assert.deepEqual(measure.mock.calls.map((c) => [c.arguments[0].session.id, c.arguments[1]]), [
    [1, { force: true, mirrorDir: '/tmp/mirror-1' }],
    [2, { force: true, mirrorDir: '/tmp/mirror-1' }],
    [3, { force: true, mirrorDir: '/tmp/mirror-2' }],
    [4, { force: true, mirrorDir: '/tmp/mirror-2' }],
    [5, { force: true, mirrorDir: '/tmp/mirror-2' }],
  ], 'which every measurement of it reads');
});

test('the sweep degrades rather than throwing, and says so', async (t) => {
  const block = pass();
  assert.match(block, /fetchAppMirror\(ready\)\.catch\(\(err\) => \{\s+log\.warn\(/,
    'an app whose fetch fails is recorded, and its proposals still measured');

  t.mock.method(activeWorkers, 'isSessionBusy', () => false);
  t.mock.method(integration, 'fetchAppMirror', async () => { throw new Error('fetch failed'); });
  const measure = t.mock.method(integration, 'measure', async () => ({ ok: true }));
  const out = await scans.measurePromoted(poolOf([row(1, 1), row(2, 1)]));
  assert.deepEqual(measure.mock.calls.map((c) => c.arguments[1]), [{ force: true }, { force: true }],
    'each measurement fetches for itself, and records its own failure');
  assert.equal(out.measured, 2);
  // A pass that throws fails its clock run, which the clock records and runs
  // again later (clock/services.ts: maxAttempts 1, the next run sooner).
});

test('it runs one pass at a time across every process, and stops at its next proposal', async (t) => {
  // A clock of the workflow (src/workflow/clock/services.ts): every minute,
  // one run at a time wherever the workflow runs, so a follower never
  // fetches a mirror the leader is fetching too. Its stop is the run's
  // signal.
  assert.match(CLOCKS,
    /name: 'proposal-measure', everyMs: MIN, leaseMs: 15 \* MIN,\n\s+run: \(ctx: WorkContext, \{ pool \}: JobDeps\) => legacy\('services\/proposal-scans'\)\.measurePromoted\(pool, \{ shouldStop: stopped\(ctx\) \}\),/);
  const { JOBS } = require('../src/workflow/clock/services.ts');
  const job = JOBS.find((j) => j.name === 'proposal-measure');
  assert.ok(job, 'the proposal-measure clock exists');
  assert.equal(job.everyMs, 60 * 1000);
  assert.equal(job.item, undefined, 'one pass, not a target per proposal: the fetch is shared');

  t.mock.method(activeWorkers, 'isSessionBusy', () => false);
  t.mock.method(integration, 'fetchAppMirror', async () => '/tmp/mirror');
  const stop = new AbortController();
  const measure = t.mock.method(integration, 'measure', async () => { stop.abort(); return { ok: true }; });
  const out = await job.run({ input: {}, signal: stop.signal }, { pool: poolOf([row(1, 1), row(2, 1), row(3, 2)]), config: {} });
  assert.equal(measure.mock.callCount(), 1, 'a stopped run measures nothing more');
  assert.equal(out.measured, 1);
});

test('the sweep writes through services/integration, not its own SQL', () => {
  const block = pass();
  assert.match(block, /integration\.measure\(/,
    'one writer owns the record — a second one here is how six columns with '
    + 'five writers happened in the first place');
  assert.doesNotMatch(block, /UPDATE chat_sessions/,
    'the sweep must not write the record behind the service that owns it');
});
