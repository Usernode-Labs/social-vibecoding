'use strict';

// Live, honest proposal status (#1715): the parts that can be pinned without
// a browser.
//
//   1. The capture container's per-check frames are observed AS THEY STREAM
//      (docker: the child's stdout; kubernetes: periodic pod-log reads), on
//      top of the buffered result the verdict is still read from.
//   2. A tracker turns those lines into { ran, passed, failed, expected },
//      deduped by index exactly as parseTests dedupes, and the snapshot is
//      persisted only while THIS run is the pending one.
//   3. The topic page patches its cached row from checks_ready / behind_main
//      / freshness / sync_status instead of refetching five endpoints, and
//      keeps the vote roster on screen for every refresh that is not a vote.
//   4. The connector says how current each field is, and when a submit's
//      vote-clearing actually happens.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const visuals = require('../src/services/visuals');
const docker = require('../src/services/docker');
const kubernetes = require('../src/services/kubernetes');
const tools = require('../src/services/mcp-tools');

const frame = (index, status) =>
  `__USERNODE_TEST__ index=${index} status=${status} loadStatus=200\n${Buffer.from('{}').toString('base64')}\n__USERNODE_TEST_END__\n`;

// ── 1. streaming observers ──────────────────────────────────────────────

test('docker: attachLineObserver re-assembles lines across chunk boundaries and flushes the tail', () => {
  const seen = [];
  const src = new PassThrough();
  docker.attachLineObserver(src, (l) => seen.push(l));
  src.write('__USERNODE_TEST__ index=0 sta');
  src.write('tus=pass loadStatus=200\ne30=\n__USERNODE_TEST_E');
  src.write('ND__\npartial-tail');
  src.end();
  return new Promise((resolve) => setImmediate(() => {
    assert.deepEqual(seen, [
      '__USERNODE_TEST__ index=0 status=pass loadStatus=200',
      'e30=',
      '__USERNODE_TEST_END__',
      'partial-tail',
    ]);
    resolve();
  }));
});

test('docker: an observer that throws cannot break the run', () => {
  const src = new PassThrough();
  docker.attachLineObserver(src, () => { throw new Error('observer bug'); });
  src.write('a\nb\n');
  src.end();
  return new Promise((resolve) => setImmediate(resolve)); // no unhandled throw
});

test('kubernetes: the observer gets only NEW complete lines from successive pod-log reads', async () => {
  const seen = [];
  let reads = 0;
  let jobReads = 0;
  // The log is cumulative; each read returns everything so far. The observer
  // must be handed each line exactly once, and never a trailing partial.
  const logs = [
    '',
    frame(0, 'pass'),                                   // 3 lines
    frame(0, 'pass') + frame(1, 'fail') + '__USERNODE_TESTS_DONE__ ran=2 expected=2 deadline=0\n' + 'part',
  ];
  kubernetes._setClientsForTest({
    batch: {
      async createNamespacedJob() {},
      async readNamespacedJob() {
        jobReads += 1;
        // Succeed after enough ticks for two observations (every 3rd tick).
        return { status: jobReads >= 7 ? { succeeded: 1 } : {} };
      },
    },
    core: {
      async createNamespacedSecret() {},
      async deleteNamespacedSecret() {},
      async listNamespacedPod() { return { items: [{ metadata: { name: 'capture-pod' } }] }; },
      async readNamespacedPodLog() { reads += 1; return logs[Math.min(reads, logs.length - 1)]; },
    },
  });
  const cfg = { kubernetes: { captureImage: 'img@sha256:abc', workerNamespace: 'ns', workerServiceAccount: 'sa' } };
  // Speed the 2s tick up by stubbing setTimeout inside the module's scope is
  // not possible without a seam; run for real but the loop only needs ~7
  // ticks. Keep the test bounded by a generous timeout on the runner.
  const started = Date.now();
  const result = await kubernetes.runCaptureJob(cfg, {
    sessionId: 7, env: {}, timeoutMs: 60000, onStdoutLine: (l) => seen.push(l),
  });
  assert.ok(Date.now() - started < 30000, 'finished inside the job poll budget');
  assert.equal(typeof result.stdout, 'string', 'the final verdict read is unchanged');
  const headers = seen.filter((l) => l.startsWith('__USERNODE_TEST__ '));
  assert.deepEqual(headers.map((l) => /index=(\d+)/.exec(l)[1]), ['0', '1'],
    'each frame header observed exactly once, in order');
  assert.ok(seen.some((l) => l.startsWith('__USERNODE_TESTS_DONE__')), 'the done sentinel is observed');
  assert.ok(!seen.includes('part'), 'a trailing partial line is not handed over');
});

// ── 2. the tracker and its persistence guard ────────────────────────────

test('the tracker dedupes by index, counts pass/fail, and reads the done sentinel', () => {
  const t = visuals.makeChecksProgressTracker(3);
  assert.equal(t.feed('noise'), false);
  assert.equal(t.feed('__USERNODE_TEST__ index=0 status=pass loadStatus=200'), true);
  assert.equal(t.feed('__USERNODE_TEST__ index=0 status=pass loadStatus=200'), false, 'same frame twice is not progress');
  assert.equal(t.feed('__USERNODE_TEST__ index=1 status=fail loadStatus=500'), true);
  let s = t.snapshot();
  assert.deepEqual([s.ran, s.passed, s.failed, s.expected, s.done], [2, 1, 1, 3, false]);
  assert.equal(t.feed('__USERNODE_TEST__ index=1 status=pass loadStatus=200'), true, 'a retried index counts once, latest wins');
  assert.equal(t.feed('__USERNODE_TESTS_DONE__ ran=2 expected=3 deadline=1'), true);
  s = t.snapshot();
  assert.deepEqual([s.ran, s.passed, s.failed, s.done], [2, 2, 0, true]);
  assert.ok(typeof s.updatedAt === 'string');
});

test('setChecksProgress writes only while this run is the pending one', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; } };
  const ok = await visuals.setChecksProgress(pool, 42, 'abc123', { ran: 1, passed: 1, failed: 0, expected: 5 });
  assert.equal(ok, true);
  assert.equal(queries.length, 1);
  const { sql, params } = queries[0];
  assert.match(sql, /SET checks_progress = \$2::jsonb/);
  assert.match(sql, /check_state = 'pending'/, 'a landed verdict is never overwritten by a late frame');
  assert.match(sql, /checks_commit_sha IS NOT DISTINCT FROM \$3::text/, 'nor is a newer run by an older container');
  assert.equal(params[0], 42);
  assert.deepEqual(JSON.parse(params[1]), { ran: 1, passed: 1, failed: 0, expected: 5 });
  assert.equal(params[2], 'abc123');
});

test('setChecksPending resets progress and every verdict write clears it', () => {
  const src = read('src/services/visuals.js');
  const pendingSql = /async function setChecksPending[\s\S]*?UPDATE chat_sessions[\s\S]*?checks_progress = NULL/;
  assert.match(src, pendingSql, 'a new run starts with no stale progress');
  // Three verdict writes: error/partial, the normal result, and skipped.
  const clears = (src.match(/checks_progress = NULL/g) || []).length;
  assert.ok(clears >= 4, `pending reset + three verdict writes clear it (found ${clears})`);
});

test('notifyChecksProgress rides the existing checks_ready event with checkState pending', () => {
  const src = read('src/services/visuals.js');
  const fn = src.slice(src.indexOf('function notifyChecksProgress('), src.indexOf('const CHECKS_PROGRESS_MIN_GAP_MS'));
  assert.match(fn, /type: 'checks_ready'/, 'no second event type for clients to learn');
  assert.match(fn, /checkState: 'pending'/);
  assert.match(fn, /progress: progress \|\| null/);
  assert.match(fn, /broadcastGlobal\(\{ type: 'session_event', sessionId, event: 'checks_ready'/);
});

test('the capture run feeds one observer to BOTH transports, throttled, with the done sentinel always flushed', () => {
  const src = read('src/services/visuals.js');
  assert.match(src, /runCaptureJob\(config, \{\n\s+onStdoutLine: progressObserver,/);
  assert.match(src, /runOneShot\(`usernode-capture-\$\{session\.id\}`, \{\n\s+onStdoutLine: progressObserver,/);
  assert.match(src, /if \(urgent \|\| gap >= minGapMs\)/, 'done always flushes; otherwise one snapshot per gap');
  assert.match(src, /onProgress: progress\.observeUnit,/, 'the unit suite reports into the same state');
  assert.match(src, /const unitOutcome = await unitSuitePromise;\n\s+closeProgress\(\);/, 'closed before the verdict is written');
  assert.match(src, /\} catch \(err\) \{\n\s+closeProgress\(\);\n\s+traceStep\('capture_error'/, 'and on the error path');
});

// ── 2b. the unit suite (npm test) reports the same way ──────────────────

const unitSuite = require('../src/services/unit-suite');

test('the unit-suite tracker walks cloning → installing → running → done and reads TAP', () => {
  const t = unitSuite.makeUnitSuiteTracker(6);
  assert.equal(t.snapshot().phase, 'cloning');
  assert.equal(t.feed('Cloning into ...'), false, 'noise does not advance');
  assert.equal(t.feed(unitSuite.CLONED_SENTINEL), true);
  assert.equal(t.snapshot().phase, 'installing');
  assert.equal(t.feed(unitSuite.SETUP_DONE_SENTINEL), true);
  assert.equal(t.snapshot().phase, 'running');
  t.feed('TAP version 13');
  t.feed('# Subtest: top');
  t.feed('    ok 1 - sub1');
  t.feed('    not ok 2 - sub2');
  t.feed('not ok 1 - top');
  t.feed('ok 2 - skipped one # SKIP');
  let snap = t.snapshot();
  assert.deepEqual(
    { ran: snap.ran, passed: snap.passed, failed: snap.failed, skipped: snap.skipped, expected: snap.expected, done: snap.done },
    { ran: 4, passed: 1, failed: 2, skipped: 1, expected: 6, done: false },
    'nested and parent lines both count until the summary corrects them'
  );
  // The summary block replaces the running approximation.
  for (const l of ['# tests 6', '# suites 1', '# pass 4', '# fail 1', '# cancelled 1', '# skipped 0', '# todo 0']) t.feed(l);
  snap = t.snapshot();
  assert.deepEqual({ ran: snap.ran, passed: snap.passed, failed: snap.failed, expected: snap.expected }, { ran: 6, passed: 4, failed: 2, expected: 6 });
  assert.deepEqual(snap.summary, { tests: 6, pass: 4, fail: 1, cancelled: 1, skipped: 0, todo: 0 });
  const fin = t.finish(false);
  assert.equal(fin.phase, 'done');
  assert.equal(fin.done, true);
  assert.equal(fin.exitOk, false);
  // No denominator when the app has never completed a run.
  assert.equal(unitSuite.makeUnitSuiteTracker(null).snapshot().expected, null);
});

test('a TAP line before the setup sentinel still means the suite is running', () => {
  const t = unitSuite.makeUnitSuiteTracker();
  t.feed('ok 1 - early');
  assert.equal(t.snapshot().phase, 'running');
});

test('the suite size is remembered on the apps row and read back as the next denominator', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push([sql, params]); return { rows: [{ unit_suite_last_tests: 10863 }] }; } };
  assert.equal(await unitSuite.loadExpectedTests(pool, 7), 10863);
  assert.match(calls[0][0], /SELECT unit_suite_last_tests FROM apps WHERE id = \$1/);
  assert.equal(await unitSuite.storeExpectedTests(pool, 7, 10870), true);
  assert.match(calls[1][0], /UPDATE apps SET unit_suite_last_tests = \$2 WHERE id = \$1/);
  assert.deepEqual(calls[1][1], [7, 10870]);
  assert.equal(await unitSuite.storeExpectedTests(pool, 7, 0), false, 'never stores an empty suite');
  const broken = { query: async () => { throw new Error('down'); } };
  assert.equal(await unitSuite.loadExpectedTests(broken, 7), null, 'a lookup failure is "unknown", never a throw');
  assert.match(read('src/db/schema.sql'), /ALTER TABLE apps\s+ADD COLUMN IF NOT EXISTS unit_suite_last_tests INTEGER;/);
});

test('maybeRunUnitSuite observes its container and reports once more at the end', () => {
  const src = read('src/services/unit-suite.js');
  assert.match(src, /docker\.runOneShot\(`usernode-unit-suite-\$\{sessionId\}`, \{\n\s+onStdoutLine: observe,/);
  assert.match(src, /const finalSnap = tracker\.finish\(passed\);\n\s+report\(finalSnap\);/);
  assert.match(src, /echo "\$\{CLONED_SENTINEL\}"\nif \[ -f package-lock\.json \]/, 'the cloned marker precedes npm ci');
  assert.match(src, /\.\.\.\(summary \? \{ summary \} : \{\}\),/, 'the TAP summary rides the row');
});

test('the run state merges both containers into one snapshot, throttles, and is silent once closed', async () => {
  const flushed = [];
  const state = visuals.makeChecksProgressState({ expected: 3, flush: (s) => flushed.push(s), minGapMs: 30 });
  state.observeUnit({ phase: 'installing', ran: 0, passed: 0, failed: 0, expected: null, done: false });
  assert.equal(flushed.length, 1, 'the first observation flushes at once');
  assert.equal(flushed[0].unit.phase, 'installing');
  assert.deepEqual([flushed[0].ran, flushed[0].expected], [0, 3]);
  state.observeCapture(`__USERNODE_TEST__ index=0 status=pass loadStatus=200`);
  state.observeUnit({ phase: 'running', ran: 40, passed: 40, failed: 0, expected: 100, done: false });
  assert.equal(flushed.length, 1, 'inside the gap: coalesced');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(flushed.length, 2, 'one timer flush carries both');
  assert.equal(flushed[1].ran, 1);
  assert.equal(flushed[1].unit.ran, 40);
  state.observeUnit({ phase: 'done', ran: 100, passed: 100, failed: 0, expected: 100, done: true, exitOk: true });
  assert.equal(flushed.length, 3, 'a done from either side flushes immediately');
  state.observeCapture(`__USERNODE_TEST__ index=1 status=fail loadStatus=200`);
  state.close();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(flushed.length, 3, 'close drops the pending timer');
  state.observeCapture(`__USERNODE_TESTS_DONE__ ran=2 expected=3 deadline=0`);
  state.observeUnit({ phase: 'running', ran: 1, passed: 1, failed: 0, expected: null, done: false });
  assert.equal(flushed.length, 3, 'nothing after close, even a done sentinel');
});

// ── 3. the topic page: patch, don't refetch; keep the roster ────────────

const APP_VIEW_SRC = read('public/js/app-view.js');
const MERGE_STATUS_SRC = read('public/js/merge-status.js');
const SESSION_TRANSCRIPT_SRC = read('public/js/session-transcript.js');

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 }, currentTab: 'dev', currentSubTab: 'topic' },
    Kudos: { renderButton: () => '' },
    DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null,
      querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
      hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SESSION_TRANSCRIPT_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  AppView.appData = { slug: 'app' };
  return AppView;
}

test('refreshDevData keeps the vote roster for every kind except a vote', () => {
  const AppView = makeAppView();
  AppView._devTopic = { kind: 'proposal', id: 9 };
  let loads = 0;
  AppView._loadDevData = async () => { loads += 1; };
  AppView._refreshTopicOnDemandRow = async () => {};
  AppView._renderTopicHead = () => {};
  for (const kind of ['session', 'checks', 'checks-poll']) {
    AppView._voteRoster[9] = { phase: 'ready', yes: { label: 'Yes', names: 'a' }, no: { label: 'No', names: '—' }, needs: '' };
    AppView.refreshDevData(kind);
    assert.ok(AppView._voteRoster[9], `'${kind}' must not blank the tally to "Loading votes…"`);
  }
  AppView._voteRoster[9] = { phase: 'ready' };
  AppView.refreshDevData('vote');
  assert.equal(AppView._voteRoster[9], undefined, 'a vote is the one refresh that revalidates the roster');
  assert.equal(loads, 4, 'the data still refreshes on every kind');
});

test('a pending checks_ready patches the cached row and repaints WITHOUT refetching', () => {
  const AppView = makeAppView();
  AppView._devTopic = { kind: 'proposal', id: 9 };
  AppView._proposals = [{ id: 9, status: 'promoted', check_state: null }];
  let loads = 0; let paints = 0;
  AppView._loadDevData = async () => { loads += 1; };
  AppView._renderTopicHead = () => { paints += 1; };
  AppView.applyChecksEvent({
    sessionId: 9, checkState: 'pending', checkPhase: 'testing', checkTrigger: 'commit-push',
    commitSha: 'deadbeef', progress: { ran: 12, passed: 11, failed: 1, expected: 523, done: false },
  });
  const row = AppView._proposals[0];
  assert.equal(row.check_state, 'pending');
  assert.equal(row.check_phase, 'testing');
  assert.equal(row.check_trigger, 'commit-push');
  assert.equal(row.checks_commit_sha, 'deadbeef');
  assert.deepEqual(row.checks_progress, { ran: 12, passed: 11, failed: 1, expected: 523, done: false });
  assert.equal(paints, 1, 'repainted from the cache');
  assert.equal(loads, 0, 'and did not refetch five endpoints to learn what it was just told');
});

test('a progress tick for a row the page does not hold refetches nothing', () => {
  const AppView = makeAppView();
  AppView._proposals = [];
  AppView._merged = [];
  AppView._topicProposal = null;
  let refetched = 0;
  AppView.refreshDevData = () => { refetched += 1; };
  AppView.applyChecksEvent({ sessionId: 424242, checkState: 'pending', checkPhase: 'testing', progress: { ran: 3, passed: 3, failed: 0, expected: 9 } });
  assert.equal(refetched, 0, 'someone else\'s run is not a reason to refetch five endpoints a second');
  AppView.applyChecksEvent({ sessionId: 424242, checkState: 'pending', checkPhase: 'building' });
  assert.equal(refetched, 1, 'a run starting (no progress) still falls through to the refetch');
  AppView.applyChecksEvent({ sessionId: 424242, checkState: 'passing' });
  assert.equal(refetched, 2, 'and so does a verdict');
});

test('a final verdict still refetches, but through a kind that keeps the roster', () => {
  const AppView = makeAppView();
  AppView._devTopic = { kind: 'proposal', id: 9 };
  AppView._proposals = [{ id: 9, status: 'promoted', check_state: 'pending' }];
  AppView._voteRoster[9] = { phase: 'ready' };
  const kinds = [];
  AppView.refreshDevData = (kind) => { kinds.push(kind); };
  AppView.applyChecksEvent({ sessionId: 9, checkState: 'passing', failingCount: 0 });
  assert.deepEqual(kinds, ['checks']);
});

test('behind_main / freshness / sync_status patch the topic row the same way DevChat patches the banner', () => {
  const AppView = makeAppView();
  AppView._devTopic = { kind: 'proposal', id: 9 };
  AppView._proposals = [{ id: 9, status: 'promoted', behind_main: 0 }];
  let paints = 0;
  AppView._renderTopicHead = () => { paints += 1; };
  AppView.applyBehindMainEvent(9, 3);
  assert.equal(AppView._proposals[0].behind_main, 3);
  AppView.applyFreshnessEvent({ sessionId: 9, behindMain: 4, freshness: { behindBy: 4, checkedAt: 't1', mergeability: 'conflict' } });
  const row = AppView._proposals[0];
  assert.equal(row.behind_main, 4);
  assert.equal(row.freshness_behind_by, 4);
  assert.equal(row.freshness_checked_at, 't1');
  assert.equal(row.mergeability, 'conflict');
  assert.equal(AppView._freshnessOf(row).behindBy, 4, 'the pill reads the patched value');
  AppView.applySyncStatusEvent({ sessionId: 9, state: 'running' });
  assert.equal(row.resolving, true);
  AppView.applySyncStatusEvent({ sessionId: 9, state: 'done' });
  assert.equal(row.resolving, false);
  assert.equal(paints, 4);
});

test('the checks ledger row carries progress and a sub line while pending', () => {
  const AppView = makeAppView();
  // Objects built inside the vm carry that realm's Object.prototype, which
  // strict deepEqual treats as a mismatch; compare the plain data.
  const plain = (o) => JSON.parse(JSON.stringify(o));
  const view = AppView._checksProgressView({ checks_progress: { ran: 12, passed: 11, failed: 1, expected: 523 } });
  assert.deepEqual(plain(view.bar), { ran: 12, passed: 11, failed: 1, expected: 523, done: false, unit: null, build: null });
  assert.equal(view.sub, '12 of 523 run · 11 passed · 1 failed');
  assert.match(view.sentence, /12 of 523 checks have run so far: 11 passed, 1 failed\./);
  assert.equal(AppView._checksProgressView({ checks_progress: null }), null, 'nothing before the first frame');
  assert.equal(AppView._checksProgressView({ checks_progress: { ran: 0, passed: 0, failed: 0, expected: null } }), null);
  const notes = AppView._checksStatusNotes({
    check_state: 'pending', check_phase: 'testing', checks_checked_at: new Date().toISOString(),
    checks_progress: { ran: 2, passed: 2, failed: 0, expected: 10 },
  });
  assert.equal(notes.length, 1);
  assert.deepEqual(plain(notes[0].progress), { ran: 2, passed: 2, failed: 0, expected: 10, done: false, unit: null, build: null });
  assert.equal(notes[0].sub, '2 of 10 run · 2 passed');
});

test('the unit suite (npm test) gets its own line, bar and phase copy', () => {
  const AppView = makeAppView();
  const plain = (o) => JSON.parse(JSON.stringify(o));
  // Build phase for the browser checks, but the suite is already cloning:
  // the row has something to say, and the sub line is the suite's.
  const early = AppView._checksProgressView({ checks_progress: { ran: 0, passed: 0, failed: 0, expected: 0, unit: { phase: 'installing', ran: 0, passed: 0, failed: 0, expected: null } } });
  assert.equal(early.sentence, '');
  assert.equal(early.sub, 'npm test: installing dependencies');
  assert.equal(early.unit.sentence, 'The repo unit suite (npm test) is installing dependencies.');
  assert.equal(early.bar.unit.phase, 'installing');
  const mid = AppView._checksProgressView({ checks_progress: { ran: 12, passed: 12, failed: 0, expected: 523, unit: { phase: 'running', ran: 4120, passed: 4118, failed: 2, expected: 10863 } } });
  assert.equal(mid.sub, '12 of 523 run · 12 passed', 'the checks own the sub line when they have run');
  assert.equal(mid.unit.sub, 'npm test: 4120 of ~10863 run · 4118 passed · 2 failed');
  assert.match(mid.unit.sentence, /has run 4120 of ~10863 tests so far: 4118 passed, 2 failed\./);
  assert.deepEqual(plain(mid.bar.unit), { phase: 'running', ran: 4120, passed: 4118, failed: 2, skipped: 0, expected: 10863, done: false });
  const done = AppView._unitSuiteProgressView({ phase: 'done', done: true, exitOk: false, ran: 10863, passed: 10861, failed: 2, expected: 10863 });
  assert.equal(done.sub, 'npm test finished: 2 failed');
  assert.match(done.sentence, /finished with failures: 2 failed, 10861 passed\./);
  const ok = AppView._unitSuiteProgressView({ phase: 'done', done: true, exitOk: true, ran: 10, passed: 9, skipped: 1, failed: 0, expected: 10 });
  assert.equal(ok.sentence, 'The repo unit suite (npm test) finished: 9 passed, 1 skipped.');
  const notes = AppView._checksStatusNotes({
    check_state: 'pending', check_phase: 'testing', checks_checked_at: new Date().toISOString(),
    checks_progress: { ran: 2, passed: 2, failed: 0, expected: 10, unit: { phase: 'running', ran: 5, passed: 5, failed: 0, expected: null } },
  });
  const lines = notes[0].rows.map((r) => r.parts[0]);
  assert.equal(lines[1], '2 of 10 checks have run so far: 2 passed.');
  assert.equal(lines[2], 'The repo unit suite (npm test) has run 5 tests so far: 5 passed.');
  assert.equal(notes[0].progress.unit.ran, 5);
});

// ── 2c. the build half reports its steps ────────────────────────────────

test('setChecksBuildProgress merges into the row while pending; the build event omits what it does not know', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; } };
  const ok = await visuals.setChecksBuildProgress(pool, 7, { step: 'clone', startedAt: 'x', steps: [{ key: 'image_build', ms: 4200 }] });
  assert.equal(ok, true);
  assert.match(calls[0].sql, /COALESCE\(checks_progress, '\{\}'::jsonb\)\s+\|\| jsonb_build_object\('build', \$2::jsonb, 'updatedAt', \$3::text\)/);
  assert.match(calls[0].sql, /AND check_state = 'pending'/);
  assert.equal(JSON.parse(calls[0].params[1]).step, 'clone');
  assert.equal(await visuals.setChecksBuildProgress(pool, 7, null), false);
  const ws = require('../src/services/ws');
  const saved = ws.broadcastGlobal;
  const seen = [];
  ws.broadcastGlobal = (e) => seen.push(e);
  try {
    visuals.notifyChecksBuildProgress(7, { step: 'image_build', startedAt: 'x', steps: [] });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].checkPhase, 'building');
    assert.equal('commitSha' in seen[0], false, 'a build tick must not null the client\'s commit pin');
    assert.equal('checkTrigger' in seen[0], false, 'nor its trigger');
    assert.equal(seen[0].progress.build.step, 'image_build');
    visuals.notifyChecksProgress(7, 'abc', { ran: 1, passed: 1, failed: 0 }, 'testing', 'manual-recheck');
    assert.equal(seen[1].commitSha, 'abc');
    assert.equal(seen[1].checkTrigger, 'manual-recheck');
  } finally { ws.broadcastGlobal = saved; }
});

test('the finished build rides every testing-half snapshot, from the timings staging threads out', () => {
  const build = visuals.buildProgressFromTimings({ sourceFetchMs: 2100.4, imageBuildMs: 48000, cloneMs: 3900, cloneVia: 'template', healthMs: 6000, totalMs: 60000 });
  assert.deepEqual(build, { step: 'done', steps: [
    { key: 'source_fetch', ms: 2100 }, { key: 'image_build', ms: 48000 }, { key: 'clone', ms: 3900, via: 'template' }, { key: 'health', ms: 6000 },
  ], totalMs: 60000 });
  assert.equal(visuals.buildProgressFromTimings({}), null);
  assert.equal(visuals.buildProgressFromTimings(null), null);
  const state = visuals.makeChecksProgressState({ expected: 2, flush: () => {}, build });
  assert.deepEqual(state.snapshot().build, build);
  const src = read('src/services/visuals.js');
  assert.match(src, /build: buildProgressFromTimings\(stagingResult && stagingResult\.timings\),/);
  const staging = read('src/services/staging.js');
  for (const step of ['source_fetch', 'image_build', 'clone', 'health', 'done']) {
    assert.match(staging, new RegExp(`reportBuildStep\\(config, session, '${step}', timings,`), `the build reports ${step}`);
  }
});

test('the build steps render as a line and a step row, live and finished', () => {
  const AppView = makeAppView();
  const plain = (o) => JSON.parse(JSON.stringify(o));
  const live = AppView._checksProgressView({ checks_progress: { build: { step: 'clone', startedAt: 'x', steps: [{ key: 'source_fetch', ms: 2000 }, { key: 'image_build', ms: 48000 }] } } });
  assert.equal(live.build.sentence, 'Preview build: branch fetched (2s), image built (48s), now cloning the database.');
  assert.equal(live.sub, 'build: cloning the database', 'the build owns the sub line while nothing else has reported');
  assert.deepEqual(plain(live.bar.build).map((s) => [s.key, s.state, s.ms]), [
    ['source_fetch', 'done', 2000], ['image_build', 'done', 48000], ['clone', 'now', null], ['health', 'todo', null],
  ]);
  const done = AppView._checksProgressView({ checks_progress: { ran: 3, passed: 3, failed: 0, expected: 10,
    build: { step: 'done', steps: [{ key: 'source_fetch', ms: 2000 }, { key: 'image_build', ms: 48000 }, { key: 'clone', ms: 3900, via: 'template' }, { key: 'health', ms: 6000 }], totalMs: 60000 } } });
  assert.equal(done.build.sentence, 'Preview built in 1m 0s: branch fetched (2s), image built (48s), database cloned from template (4s), preview started (6s).');
  assert.equal(done.sub, '3 of 10 run · 3 passed', 'the checks own the sub line once they run');
  assert.equal(done.bar.build[2].label, 'clone database (from template)');
  const notes = AppView._checksStatusNotes({ check_state: 'pending', check_phase: 'building', checks_checked_at: new Date().toISOString(),
    checks_progress: { build: { step: 'image_build', startedAt: 'x', steps: [{ key: 'source_fetch', ms: 1000 }] } } });
  assert.equal(notes[0].rows[1].parts[0], 'Preview build: branch fetched (1s), now building the preview image.');
  assert.equal(notes[0].rows[1].weight, undefined, 'the live line is primary ink');
  const after = AppView._checksStatusNotes({ check_state: 'pending', check_phase: 'testing', checks_checked_at: new Date().toISOString(),
    checks_progress: { ran: 1, passed: 1, failed: 0, expected: 5, build: { step: 'done', steps: [{ key: 'image_build', ms: 5000 }], totalMs: 5000 } } });
  assert.equal(after[0].rows[1].weight, 'foot', 'the finished build is a footnote under the live checks line');
  assert.match(after[0].rows[2].parts[0], /1 of 5 checks have run so far/);
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(tsx, /\{p\.build && p\.build\.length \? <BuildSteps steps=\{p\.build\} \/> : null\}/);
  assert.match(tsx, /className="dev-ledger-progress-build" data-build-step=\{now \? now\.key : 'done'\}/);
  assert.match(read('frontend/src/features/dev-board/topic/model.ts'), /build\?: LedgerBuildStep\[\] \| null;/);
  assert.match(read('public/css/app.css'), /\.dev-ledger-build-step\.is-now \{/);
});

test('the board card and the running badge carry the live count', () => {
  const AppView = makeAppView();
  const badge = AppView.checksBadgeHtml({ status: 'promoted', check_state: 'pending', checks_progress: { ran: 12, passed: 12, failed: 0, expected: 523 } });
  assert.match(badge, /Checks running…\s12\/523</);
  const quiet = AppView.checksBadgeHtml({ status: 'promoted', check_state: 'pending', checks_progress: null });
  assert.match(quiet, /Checks running…</, 'no count before the first frame');
  const src = APP_VIEW_SRC;
  assert.match(src, /label: p\.check_state === 'pending' \? `Checks running…\$\{count\}` : 'Checks starting…',/);
});

test('app.js hands the events to the topic page before DevChat\'s early returns', () => {
  const src = read('public/js/app.js');
  const block = src.slice(src.indexOf("if (data.event === 'checks_ready') {"), src.indexOf("if (data.event === 'staging_ready')"));
  assert.match(block, /AppView\.applyChecksEvent\(data\)/);
  assert.match(block, /refreshCurrentSessionStatus\(data\.sessionId\)/, 'the focused-session refresh (pinned elsewhere) stays');
  // A progress tick (once a second, to every client, for the run's length)
  // must not fan out into fetches: only the start and verdict events do.
  assert.match(block, /const progressTick = data\.checkState === 'pending' && data\.progress && typeof data\.progress === 'object';/);
  assert.match(block, /if \(!progressTick\) \{\n\s+\/\/[^\n]*\n(\s+\/\/[^\n]*\n)*\s+\/\/[^\n]*\n\s+if \(typeof DevChat !== 'undefined' && DevChat\.refreshCurrentSessionStatus\)[\s\S]*?App\.refreshHomeProposals\(\);\n\s+\}/);
  const upd = src.slice(src.indexOf('handleSessionUpdate(data) {'), src.indexOf("if (data.action === 'sync_status')") + 400);
  assert.match(upd, /AppView\.applyBehindMainEvent\(data\.sessionId, data\.behindMain\)[\s\S]*DevChat\.applyBehindMainUpdate/);
  assert.match(upd, /AppView\.applyFreshnessEvent\(data\)[\s\S]*DevChat\.applyFreshnessUpdate/);
  assert.match(upd, /AppView\.applySyncStatusEvent\(data\)[\s\S]*DevChat\.applySyncStatusUpdate/);
});

test('the ledger island draws the bar and the row model declares it', () => {
  const tsx = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  const model = read('frontend/src/features/dev-board/topic/model.ts');
  assert.match(model, /progress\?: LedgerProgress \| null;/);
  assert.match(tsx, /className=\{cls\} aria-hidden="true"/, 'decorative: the numbers live in the sub text');
  assert.match(tsx, /const cls = `dev-ledger-progress\$\{indeterminate \? ' dev-ledger-progress-busy' : ''\}`;/);
  assert.match(tsx, /\{r\.progress \? <Progress p=\{r\.progress\} \/> : null\}/);
  assert.match(read('public/css/app.css'), /\.dev-ledger-progress-pass/);
  // The unit suite's own track, labelled, pulsing before its first test.
  assert.match(model, /unit\?: LedgerUnitProgress \| null;/);
  assert.match(tsx, /className="dev-ledger-progress-unit" data-unit-phase=\{u\.phase\}/);
  assert.match(tsx, /attr="data-unit-progress" value=\{`\$\{u\.ran\}\/\$\{u\.expected \?\? '\?'\}`\}/);
  assert.match(tsx, /indeterminate=\{!u\.done && u\.ran === 0\}/);
  assert.match(read('public/css/app.css'), /\.dev-ledger-progress-busy \{[^}]*animation:/);
  assert.match(read('public/css/app.css'), /prefers-reduced-motion: reduce\) \{\n\s+\.dev-ledger-progress-busy \{ animation: none; \}/);
});

// ── 4. the connector says how current it is ────────────────────────────

test('get_proposal exposes progress, asOf and pendingWrite', () => {
  const now = new Date('2026-09-07T08:00:00Z').toISOString();
  const session = {
    id: 5, status: 'promoted', source: 'imported', imported_pr_head_sha: 'ABC',
    check_state: 'pending', check_phase: 'testing', checks_checked_at: now,
    checks_progress: { ran: 3, passed: 3, failed: 0, expected: 9 },
    freshness_checked_at: now, yes_count: 1, no_count: 0, votes_required: 1,
  };
  const checks = tools.shapeChecks(session);
  assert.deepEqual(checks.progress, { ran: 3, passed: 3, failed: 0, expected: 9 });
  const p = tools.shapeProposal(session, 'https://x.test');
  assert.equal(typeof p.asOf.readAt, 'string');
  assert.equal(p.asOf.checks, now);
  assert.equal(p.asOf.freshness, now);
  assert.ok('buildInFlight' in p.pendingWrite);
  assert.equal(p.checks.progress.ran, 3);
});

test('a submit says WHEN its vote-clearing happens, not just a count', () => {
  const pu = read('src/services/proposal-update.js');
  assert.match(pu, /votesClearing: applied \? 'now' : \(votesCleared > 0 \? 'on_sync' : 'none'\)/);
  assert.match(pu, /votesClearing: settled \? 'now' : \(votesCleared > 0 \? 'on_sync' : 'none'\)/);
  const eat = read('src/services/external-agent-tasks.js');
  assert.match(eat, /votesClearing: result\.votesClearing \|\|/);
  assert.match(eat, /votesAtRisk: Number\.isInteger\(result\.votesAtRisk\)/);
});
