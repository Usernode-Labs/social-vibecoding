'use strict';

// #4452: how long testing a change usually takes on one app, from the
// app's recent finished runs (src/services/checks-estimate.js), and the
// change page reads it with the proposal (both detail routes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const estimate = require('../src/services/checks-estimate');

const run = (buildSteps, checksMs) => ({
  build: { step: 'done', steps: buildSteps.map((ms, i) => ({ key: `s${i}`, ms })), totalMs: 1 },
  checksMs,
});

test('the median of the recent runs, each half on its own', () => {
  const e = estimate.estimateFrom([
    run([60000, 60000], 600000),
    run([90000, 90000], 300000),
    run([30000, 30000], 900000),
  ]);
  assert.deepEqual(e, { buildMs: 120000, checksMs: 600000, runs: 3 });
});

test('fewer than three finished runs make no estimate', () => {
  assert.equal(estimate.estimateFrom([run([1000], 1000), run([1000], 1000)]), null);
  assert.equal(estimate.estimateFrom([]), null);
  assert.equal(estimate.estimateFrom(null), null);
});

test('a run still building, or one that kept no checks time, is not counted', () => {
  const live = { build: { step: 'image_build', steps: [{ key: 'source_fetch', ms: 2000 }] }, checksMs: 5000 };
  const noChecks = { build: { step: 'done', steps: [{ key: 'health', ms: 2000 }] } };
  const e = estimate.estimateFrom([live, noChecks, run([1000], 4000), run([3000], 2000), run([2000], 3000)]);
  assert.deepEqual(e, { buildMs: 2000, checksMs: 3000, runs: 3 });
});

test('a build block with no step times falls back to its total', () => {
  assert.equal(estimate.buildMsOf({ build: { step: 'done', steps: [], totalMs: 42000 } }), 42000);
  assert.equal(estimate.buildMsOf({ build: { step: 'clone', steps: [], totalMs: 42000 } }), null);
});

test('an even count takes the middle two', () => {
  assert.equal(estimate.median([4, 1, 3, 2]), 3);
  assert.equal(estimate.median([]), null);
});

test('only the most recent runs are read', () => {
  const runs = Array.from({ length: 40 }, (_, i) => run([1000 * (i + 1)], 1000));
  assert.equal(estimate.estimateFrom(runs).runs, estimate.RECENT_RUNS);
});

test('a failed read is no estimate, and the answer is cached per app', async () => {
  estimate.resetCaches();
  let reads = 0;
  const pool = { query: async () => { reads += 1; return { rows: [run([1000], 2000), run([1000], 2000), run([1000], 2000)].map((p) => ({ checks_progress: p })) }; } };
  const own = await estimate.forApp(pool, 77001);
  assert.equal(own.buildMs, 1000);
  assert.equal(own.checksMs, 2000);
  assert.equal(own.runs, 3);
  assert.equal(own.rough, false);
  assert.ok(own.slots >= 1);
  await estimate.forApp(pool, 77001);
  assert.equal(reads, 1);
  const broken = { query: async () => { throw new Error('down'); } };
  assert.equal(await estimate.forApp(broken, 77002), null);
  assert.equal(await estimate.forApp(pool, 0), null);
});

test('a project with too few runs borrows the platform median, marked rough', async () => {
  estimate.resetCaches();
  const own = [run([1000], 2000), run([1000], 2000)].map((p) => ({ checks_progress: p }));
  const everywhere = [run([3000], 9000), run([3000], 9000), run([3000], 9000)].map((p) => ({ checks_progress: p }));
  const pool = {
    query: async (sql) => ({ rows: sql.includes('app_id =') ? own : everywhere }),
  };
  const e = await estimate.forApp(pool, 77011);
  assert.equal(e.buildMs, 3000);
  assert.equal(e.checksMs, 9000);
  assert.equal(e.runs, 3);
  assert.equal(e.rough, true);
  assert.ok(e.slots >= 1);
});

test('no history anywhere is no estimate', async () => {
  estimate.resetCaches();
  const pool = { query: async () => ({ rows: [] }) };
  assert.equal(await estimate.forApp(pool, 77012), null);
});

test('the platform read is cached across apps', async () => {
  estimate.resetCaches();
  let platformReads = 0;
  const rows = [run([3000], 9000), run([3000], 9000), run([3000], 9000)].map((p) => ({ checks_progress: p }));
  const pool = {
    query: async (sql) => {
      if (sql.includes('app_id =')) return { rows: [] };
      platformReads += 1;
      return { rows };
    },
  };
  const first = await estimate.forApp(pool, 77013);
  const second = await estimate.forApp(pool, 77014);
  assert.equal(first.rough, true);
  assert.equal(second.rough, true);
  assert.equal(platformReads, 1, 'one read of the whole platform serves every rough project');
});

test('both change-page reads carry the estimate', () => {
  const votes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');
  const sessions = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');
  assert.match(votes, /proposal\.checks_estimate = await require\('\.\.\/services\/checks-estimate'\)\.forApp\(pool, gatedApp\.id\)/);
  assert.match(sessions, /if \(req\.path\.endsWith\('\/details'\) \|\| session\.check_state === 'pending'\) \{\s*detail\.checks_estimate = await require\('\.\.\/services\/checks-estimate'\)\.forApp\(pool, session\.app_id\);/);
});

// ── The change page's reading of the estimate ───────────────────────────
// AppView is a classic script, so the two methods are run in a sandbox with
// only what they read.

const vm = require('node:vm');

const APP_VIEW = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function methodSource(name) {
  const start = APP_VIEW.indexOf(`  ${name}(`);
  assert.ok(start >= 0, `${name} is in app-view.js`);
  let depth = 0;
  for (let i = APP_VIEW.indexOf('{', start); i < APP_VIEW.length; i += 1) {
    if (APP_VIEW[i] === '{') depth += 1;
    else if (APP_VIEW[i] === '}') {
      depth -= 1;
      if (depth === 0) return APP_VIEW.slice(start, i + 1);
    }
  }
  throw new Error(`${name} is not closed`);
}

function makeAppView() {
  const sandbox = {
    PlatformI18n: {
      t: (id, params) => (params && params.count != null ? `${id}#${params.count}` : id),
    },
    relTime: () => '12 minutes ago',
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    var AppView = {
      ${methodSource('_checksEta')},
      ${methodSource('_checksStatusNotes')},
      ${methodSource('_changeTestingView')},
      _recheckAction: () => null,
      _checksRunStale: () => false,
      _checksPhaseCopy: () => ({ title: 'phase title', detail: 'phase detail', blocked: 'blocked' }),
      _checksTriggerCopy: () => '',
      _freshnessOf: () => ({ behindBy: 0 }),
      _checksProgressView: () => null,
      _checksHalvesFraction: () => 0.5,
      _checksFractionLine: () => 'where the run is',
      _checksWillRetry: () => false,
      _shotsBrokenCount: () => 0,
    };
    globalThis.__AppView = AppView;
  `, sandbox);
  return sandbox.__AppView;
}

const EST = { buildMs: 3 * 60000, checksMs: 15 * 60000, runs: 12, rough: false, slots: 4 };

const pendingItem = (now, extra = {}) => ({
  check_state: 'pending',
  check_phase: 'testing',
  staging_url: 'https://preview.example',
  checks_checked_at: new Date(now - 12 * 60000).toISOString(),
  checks_estimate: { ...EST },
  ...extra,
});

test('_checksEta: running under its usual time gives the minutes left', () => {
  const AppView = makeAppView();
  const now = Date.now();
  const eta = AppView._checksEta(pendingItem(now), now);
  assert.equal(eta.kind, 'left');
  assert.equal(eta.minutes, 6);
  assert.equal(eta.usual, 18 * 60000);
  assert.equal(eta.rough, false);
});

test('_checksEta: past its usual total says so', () => {
  const AppView = makeAppView();
  const now = Date.now();
  const eta = AppView._checksEta(pendingItem(now, {
    checks_checked_at: new Date(now - 20 * 60000).toISOString(),
  }), now);
  assert.equal(eta.kind, 'longer');
});

test('_checksEta: a queued run counts the runs ahead, the slots and the wait so far', () => {
  const AppView = makeAppView();
  const now = Date.now();
  const eta = AppView._checksEta(pendingItem(now, {
    check_phase: 'queued',
    checks_progress: { queue: { ahead: 2, since: new Date(now - 4 * 60000).toISOString() } },
  }), now);
  // ceil((2 + 1) / 4) checks' runs of 15 min, less the 4 already waited.
  assert.equal(eta.kind, 'wait');
  assert.equal(eta.minutes, 11);
});

test('_checksEta: a deferred run, or one with no estimate or start, says nothing', () => {
  const AppView = makeAppView();
  const now = Date.now();
  assert.equal(AppView._checksEta(pendingItem(now, { check_phase: 'deferred' }), now), null);
  assert.equal(AppView._checksEta(pendingItem(now, { checks_estimate: null }), now), null);
  assert.equal(AppView._checksEta(pendingItem(now, { checks_checked_at: null }), now), null);
});

test('_checksStatusNotes: a pending run says the time left, with the rough note when borrowed', () => {
  const AppView = makeAppView();
  const now = Date.now();
  const note = AppView._checksStatusNotes(pendingItem(now));
  const parts = note[0].rows.flatMap((row) => row.parts);
  assert.ok(parts.includes('changes:checks.pending.left#6'), 'the time left is a foot row');
  assert.ok(!parts.includes('changes:checks.pending.rough'), 'an own estimate is not called rough');

  const rough = AppView._checksStatusNotes(pendingItem(now, {
    checks_estimate: { ...EST, rough: true },
  }));
  const roughParts = rough[0].rows.flatMap((row) => row.parts);
  assert.ok(roughParts.includes('changes:checks.pending.left#6'));
  assert.ok(roughParts.includes('changes:checks.pending.rough'), 'the rough note follows it');
});

test('_changeTestingView: past its usual time the figure says so, and a queued run names its wait', () => {
  const AppView = makeAppView();
  const now = Date.now();
  const card = AppView._changeTestingView({
    ...pendingItem(now, { checks_checked_at: new Date(now - 20 * 60000).toISOString() }),
    checks_progress: { build: { step: 'done', steps: [], totalMs: 1 }, ran: 1, expected: 10 },
  });
  assert.equal(card.figure, 'changes:page.testing.figure.longer');
  assert.ok(Array.isArray(card.segments), 'the bar stays');

  const roughCard = AppView._changeTestingView({
    ...pendingItem(now),
    checks_progress: { build: { step: 'done', steps: [], totalMs: 1 }, ran: 1, expected: 10 },
    checks_estimate: { ...EST, rough: true },
  });
  assert.equal(roughCard.note[0], 'changes:page.testing.note.whereUsualRough#18');

  const queued = AppView._changeTestingView({
    ...pendingItem(now),
    check_phase: 'queued',
    checks_progress: { queue: { ahead: 2, since: new Date(now - 4 * 60000).toISOString() } },
  });
  assert.ok(queued.note.includes('changes:checks.pending.wait#11'), 'the wait sits beside the place in line');
});
