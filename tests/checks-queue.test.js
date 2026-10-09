'use strict';

// The checks queue (services/checks-queue.js): at most
// CHECKS_MAX_CONCURRENT_RUNS proposal checks runs have Jobs on the cluster at
// once, main-watch has a slot of its own, and everyone else waits after their
// preview is built and before any Job exists.
//
// Red checks followed load, not rollouts: across 701 runs from 5 Oct 2026
// that no rollout overlapped, 9% came back red while the check Jobs used
// under 10 cores of the cluster and 24 to 29% above it, because every preview
// under test loads the one shared Postgres primary. Nothing bounded how many
// runs went at once.
//
// This file holds the rules that need no database: the order and the slot
// rule (planAdmission), the stale sweeps' reading of a waiting run, where the
// gate sits in captureForSession, and what people and agents are told while a
// run waits. tests/checks-queue-postgres.test.js runs the queue on a real
// Postgres: two processes, a freed slot, a superseded run, a restart.
//
// Run with: node --test tests/checks-queue.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const checksQueue = require('../src/services/checks-queue');
const stagingRecovery = require('../src/services/staging-recovery');
const mergeRequirements = require('../src/services/merge-requirements');
const tools = require('../src/services/mcp-tools');
const botProgress = require('../src/services/homeroom-bot-progress');
const visuals = require('../src/services/visuals');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/^[ \t]*\/\/.*$/gm, '');

// A row as QUEUE_SQL returns it. `admitted` stamps admitted_at; a dead row
// has stopped heartbeating; `withinDeadline` is an admitted row whose Jobs
// may still be on the cluster.
let seq = 0;
function row(over = {}) {
  seq += 1;
  const { admitted = false, alive = true, withinDeadline = true, expired = false, ...rest } = over;
  return {
    run_id: `run-${seq}`, kind: 'proposal', session_id: seq, app_id: null, commit_sha: `sha${seq}`,
    owner: 'pod-a:1', queued_at: new Date(Date.UTC(2026, 9, 8, 12, 0, seq)),
    admitted_at: admitted ? new Date(Date.UTC(2026, 9, 8, 12, 1, seq)) : null,
    alive, within_deadline: admitted ? withinDeadline : false, expired, class: 4, ...rest,
  };
}
const promoted = (over) => row({ class: 2, ...over });
const handoff = (over) => row({ class: 3, ...over });
const draft = (over) => row({ class: 4, ...over });
const main = (over) => row({ kind: 'main', class: 1, session_id: null, app_id: 7, ...over });

// ── The slot count ──────────────────────────────────────────────────────

test('the cap defaults to four, reads CHECKS_MAX_CONCURRENT_RUNS, and 0 turns the queue off', (t) => {
  const saved = process.env.CHECKS_MAX_CONCURRENT_RUNS;
  t.after(() => {
    if (saved === undefined) delete process.env.CHECKS_MAX_CONCURRENT_RUNS;
    else process.env.CHECKS_MAX_CONCURRENT_RUNS = saved;
  });
  delete process.env.CHECKS_MAX_CONCURRENT_RUNS;
  assert.equal(checksQueue.maxConcurrentRuns(), 4);
  assert.equal(checksQueue.isEnabled(), true);
  process.env.CHECKS_MAX_CONCURRENT_RUNS = '6';
  assert.equal(checksQueue.maxConcurrentRuns(), 6);
  process.env.CHECKS_MAX_CONCURRENT_RUNS = '0';
  assert.equal(checksQueue.maxConcurrentRuns(), 0);
  assert.equal(checksQueue.isEnabled(), false, 'every run starts at once, as before the queue');
  process.env.CHECKS_MAX_CONCURRENT_RUNS = 'lots';
  assert.equal(checksQueue.maxConcurrentRuns(), 4, 'a value that is not a count falls back to the default');
});

test('a dead admitted run holds its slot only while its Jobs may still be running', () => {
  assert.ok(checksQueue.jobHoldMs() >= visuals.RUN_TIMEOUT_MS,
    'past the capture Job\'s own deadline, plus slack for the preparation between admission and the Job');
  const plan = checksQueue.planAdmission([
    promoted({ admitted: true, alive: false, withinDeadline: true }),
    promoted({ admitted: true, alive: false, withinDeadline: false }),
    promoted(),
  ], { cap: 2 });
  assert.deepEqual(plan.holding, { main: 0, proposal: 2 },
    'the first still counts (its Jobs may run on); the second is past its Jobs\' deadline');
  assert.equal(plan.admit.length, 1, 'so the waiting run takes the second slot');
});

// ── The order ───────────────────────────────────────────────────────────

test('slots go to main-watch, then promoted proposals, then submitted hand-offs, then drafts', () => {
  // Enqueued in the reverse order, so FIFO alone would get it wrong.
  const rows = [main(), promoted(), handoff(), draft()].reverse()
    .map((r, i) => ({ ...r, queued_at: new Date(Date.UTC(2026, 9, 8, 12, 0, i)) }));
  // QUEUE_SQL sorts; planAdmission keeps the order it is given.
  rows.sort((a, b) => a.class - b.class || a.queued_at - b.queued_at);
  const plan = checksQueue.planAdmission(rows, { cap: 1 });
  const by = (cls) => plan.runs.find((r) => r.class === cls);
  assert.equal(by(1).admitted, true, 'main-watch: its own slot');
  assert.equal(by(2).admitted, true, 'the promoted proposal: the one shared slot');
  assert.equal(by(3).admitted, false);
  assert.equal(by(3).ahead, 0, 'the hand-off is next');
  assert.equal(by(4).ahead, 1, 'the draft after it');
});

test('first come, first served within a class, and the line is strict', () => {
  const first = promoted({ queued_at: new Date(Date.UTC(2026, 9, 8, 12, 0, 1)) });
  const second = promoted({ queued_at: new Date(Date.UTC(2026, 9, 8, 12, 0, 2)) });
  const third = promoted({ queued_at: new Date(Date.UTC(2026, 9, 8, 12, 0, 3)) });
  const holder = promoted({ admitted: true });
  const plan = checksQueue.planAdmission([holder, first, second, third], { cap: 2 });
  assert.deepEqual(plan.admit, [first.run_id]);
  assert.equal(plan.byRun.get(second.run_id).ahead, 0);
  assert.equal(plan.byRun.get(third.run_id).ahead, 1);
  assert.equal(plan.waiting, 2);
});

test('a dead waiting run neither holds a slot nor stands in line; the asking run always does', () => {
  const dead = promoted({ alive: false });
  const live = promoted();
  const plan = checksQueue.planAdmission([dead, live], { cap: 1 });
  assert.deepEqual(plan.admit, [live.run_id], 'the harvest re-drives the dead one in its place');
  assert.equal(plan.byRun.get(dead.run_id).ahead, null);
  // A waiter whose own heartbeat lapsed (a slow UPDATE) still counts itself.
  const late = promoted({ alive: false });
  assert.deepEqual(checksQueue.planAdmission([late], { cap: 1, self: late.run_id }).admit, [late.run_id]);
});

// ── Main-watch's slot ───────────────────────────────────────────────────

test('main-watch has a slot of its own besides the cap, and goes first for any free shared one', () => {
  const full = [promoted({ admitted: true }), promoted({ admitted: true })];
  // The shared slots are full: the first main-watch run still goes.
  const m1 = main();
  let plan = checksQueue.planAdmission([m1, ...full], { cap: 2 });
  assert.deepEqual(plan.admit, [m1.run_id]);
  assert.deepEqual(plan.holding, { main: 1, proposal: 2 }, 'cap + 1 runs on the cluster, at most');

  // Its slot taken, a second main-watch run (another app's merge) waits for
  // a shared one, ahead of every proposal.
  const m2 = main({ app_id: 8 });
  const p = promoted();
  plan = checksQueue.planAdmission([main({ admitted: true }), m2, ...full, p], { cap: 2 });
  assert.deepEqual(plan.admit, []);
  assert.equal(plan.byRun.get(m2.run_id).ahead, 0);
  assert.equal(plan.byRun.get(p.run_id).ahead, 1);
  // One shared slot frees: the main-watch run takes it, not the proposal.
  plan = checksQueue.planAdmission([main({ admitted: true }), m2, full[0], p], { cap: 2 });
  assert.deepEqual(plan.admit, [m2.run_id]);

  // With no main-watch run at all, proposals never take its slot.
  const waiting = promoted();
  plan = checksQueue.planAdmission([...full, waiting], { cap: 2 });
  assert.deepEqual(plan.admit, [], 'the reserved slot is main-watch\'s alone');
});

// ── A waiting run is not stuck ──────────────────────────────────────────

test('checkRunOverdue never reads a run waiting for a slot as overdue, however long it has waited', () => {
  const now = Date.now();
  const old = new Date(now - 6 * 3600 * 1000);
  assert.equal(stagingRecovery.checkRunOverdue({
    check_state: 'pending', check_phase: 'queued', checks_commit_sha: 'head', checks_checked_at: old,
  }, { now, staleMs: 600000 }), false);
  assert.equal(stagingRecovery.checkRunOverdue({
    check_state: 'pending', check_phase: 'testing', checks_commit_sha: 'head', checks_checked_at: old,
  }, { now, staleMs: 600000 }), true, 'a run that is running is judged as before');
});

test('the stale sweep skips a queued session while it has a row in line, and only then', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
  await stagingRecovery.findStuckCheckSessions({ pool, staleMs: 600000, maxAutoRetries: 6 });
  const sql = queries[0].sql;
  assert.match(sql, /cs\.check_phase IS DISTINCT FROM 'queued'\s+OR NOT EXISTS \(SELECT 1 FROM check_runs cr\s+WHERE cr\.session_id = cs\.id AND cr\.admitted_at IS NULL\)/,
    'a queued session with no row left in line is overdue by the usual clock: the backstop');
  assert.deepEqual(queries[0].params, [600000, 6, 50]);
});

test('the merge gate kicks no recheck for a queued run, and says it is waiting', () => {
  const src = stripComments(read('src/routes/votes.js'));
  assert.match(src, /const checksQueued = checkRows\[0\]\?\.check_state === 'pending'\s+&& checkRows\[0\]\?\.check_phase === 'queued';/);
  assert.match(src, /const stalePending = !checksDeferred && !checksQueued && \(checkState === null/);
  assert.match(src, /checksQueued \? 'is waiting for a checks slot' : 'is still running its tests'/);
});

test('merge-queue counts a queued run as in flight, so nothing re-drives it', () => {
  const src = stripComments(read('src/services/merge-queue.js'));
  assert.match(src, /function checkRunInFlight\(row\) \{[\s\S]{0,400}return !require\('\.\/staging-recovery'\)\.checkRunOverdue\(row\);/);
});

test('main-watch\'s interrupted-run sweep leaves a run alive in the queue, and re-drives a dead waiting one now', () => {
  const src = stripComments(read('src/services/main-watch.js'));
  const sweep = src.slice(src.indexOf('async function resumeInterrupted('));
  assert.match(sweep, /AND NOT EXISTS \(\s*SELECT 1 FROM check_runs cr\s+WHERE cr\.kind = 'main' AND cr\.app_id = apps\.id[\s\S]{0,120}cr\.heartbeat_at >= NOW\(\)/);
  assert.match(sweep, /OR EXISTS \(\s*SELECT 1 FROM check_runs cr\s+WHERE cr\.kind = 'main'[\s\S]{0,200}cr\.admitted_at IS NULL\)\)/);
});

test('the harvest leaves main-watch rows to main-watch, and runOnCluster counts a waiting run as the run', () => {
  const runs = stripComments(read('src/services/check-runs.js'));
  assert.match(runs, /FROM check_runs\s+WHERE kind = 'proposal' AND session_id IS NOT NULL/);
  assert.equal(checksQueue.isWaitingRow({ admitted_at: null }), true);
  assert.equal(checksQueue.isWaitingRow({ admitted_at: new Date() }), false);
  assert.equal(checksQueue.isWaitingRow({}), false, 'a row that does not say is not a waiting one');
});

// ── Where the gate sits ─────────────────────────────────────────────────

test('captureForSession waits for its slot after the preview is up and before anything a slot is for', () => {
  const src = read('src/services/visuals.js');
  const live = src.slice(src.indexOf('async function captureForSession('), src.indexOf('function holdCapture('));
  const ready = live.indexOf("throw new Error('Preview revision is not ready for capture')");
  const redundant = live.indexOf('checksAlreadyDecided(pool, session.id, commitHash)');
  const enqueue = live.indexOf('checksQueue.enqueue(runsPool');
  const wait = live.indexOf('await waitForChecksSlot(pool, runsPool');
  const testing = live.indexOf("setChecksPending(pool, session.id, commitHash, 'testing', trigger)");
  const token = live.indexOf('mintCaptureToken(captureUser, app.id)');
  const cookie = live.indexOf("'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)'");
  const unit = live.indexOf('unitSuite.maybeRunUnitSuite({');
  const capture = live.indexOf('kubernetes.runCaptureJob(');
  assert.ok(ready > 0 && redundant > ready && enqueue > redundant && wait > enqueue,
    'the preview is checked live, a redundant run skipped, then the run joins the line');
  assert.ok(testing > wait, '"testing" only once it has a slot');
  assert.ok(token > wait && cookie > wait,
    'the capture tokens and the 15-minute "before" cookie are minted after the wait, not before it');
  assert.ok(unit > wait && capture > wait, 'no Job exists, so no Job deadline runs, while it waits');
  assert.match(live, /if \(slot\.outcome === 'superseded'\) \{[\s\S]{0,300}traceStatus = 'superseded';\s+return undefined;/,
    'a superseded waiting run leaves with no verdict; its finally clears its row');
  assert.match(live, /const place = checksQueue\.isEnabled\(\)\s+\? await checksQueue\.enqueue\(runsPool, \{ \.\.\.provisional, queuedSince: opts\.queuedSince \|\| null \}\)\s+: null;\s+if \(!place\) await checkRuns\.record\(runsPool, provisional\);/,
    'the queue row is the provisional manifest; without the queue it is written as before');
});

test('a newer request for a session whose run is still waiting supersedes it at once', () => {
  const src = read('src/services/visuals.js');
  assert.match(src, /if \(movedOn && typeof running\.leaveQueue === 'function' && running\.leaveQueue\(\)\) \{/);
  assert.match(src, /const flight = \{ operation, commitHash: commitHash \|\| null \};\s+_inFlight\.set\(key, flight\);/);
});

test('every run\'s row going wakes this process\'s waiters', () => {
  const src = stripComments(read('src/services/check-runs.js'));
  assert.match(src, /async function finish\(pool, runId\) \{[\s\S]{0,400}\} finally \{\s+require\('\.\/checks-queue'\)\.slotFreed\(\);/);
});

test('the harvest re-drives a run in the place it had in line', () => {
  const src = stripComments(read('src/services/check-harvest.js'));
  assert.match(src, /const queuedSince = row\.queued_at \|\| null;/);
  assert.match(src, /recheckSessionChecks\(\{\s+config, pool, session, reason: 'orphaned-run', \.\.\.\(queuedSince \? \{ queuedSince \} : \{\}\),\s+\}\)/);
  const recovery = stripComments(read('src/services/staging-recovery.js'));
  assert.match(recovery, /async function recheckSessionChecks\(\{ config, pool, session, reason, queuedSince = null \}\)/);
  assert.match(recovery, /\.\.\.\(queuedSince \? \{ queuedSince \} : \{\}\),/);
});

// ── What people and agents read ─────────────────────────────────────────

const QUEUED = {
  id: 77, app_slug: 'recipe-box', status: 'promoted', pr_number: 41, branch_name: 'usernode/s77',
  check_state: 'pending', check_phase: 'queued', check_trigger: 'commit-push',
  checks_commit_sha: 'abc123', checks_checked_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
  checks_progress: { queue: { ahead: 2, since: new Date().toISOString() } },
  test_results: [],
};

test('the phase is in the closed vocabulary every surface normalises to', () => {
  assert.ok(visuals.CHECK_PHASES.has('queued'));
  const schema = read('src/db/schema.sql');
  assert.match(schema, /'queued'\s+— the preview is healthy and the run is waiting for a\s+--\s+checks slot/);
});

test('the merge requirements read a queued run as in progress, waiting its turn', () => {
  const step = mergeRequirements.provisional(QUEUED).find((s) => s.key === 'checks');
  assert.equal(step.state, 'active');
  assert.equal(step.detail.note, 'waiting for a checks slot; they start on their own');
});

test('the connector tells an agent it is waiting and not to push again', () => {
  const shaped = tools.shapeProposal(QUEUED, 'https://social-vibecoding.usernodelabs.org');
  assert.equal(shaped.checks.phase, 'queued');
  assert.deepEqual(shaped.checks.progress.queue.ahead, 2);
  assert.match(shaped.nextStep, /the staging preview is built and the run is waiting for a checks slot/);
  assert.match(shaped.nextStep, /Poll get_proposal rather than pushing again/);
  const change = tools.changeNextStep(QUEUED, tools.shapeChecks(QUEUED), {}, 'external');
  assert.match(change, /are waiting for a checks slot; they start on their own\. Call get_change again for the verdict\./);
});

test('the bot says where a waiting run is in line', () => {
  assert.equal(botProgress.checksWords(QUEUED), 'waiting for a checks slot (2 ahead)');
  assert.equal(botProgress.checksWords({ ...QUEUED, checks_progress: null }), 'waiting for a checks slot');
});

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => '40 minutes ago',
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
  vm.runInContext([
    read('public/js/merge-status.js'),
    read('public/js/session-transcript.js'),
    read('public/js/app-view.js'),
    ';globalThis.__AppView = AppView;',
  ].join('\n'), sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  AppView.appData = { slug: 'app' };
  return AppView;
}

test('the card says "Waiting for a checks slot (2 ahead)", offers no re-run, and does not call it stuck', () => {
  const AppView = makeAppView();
  assert.equal(AppView._checksPhaseCopy('queued', QUEUED).title, 'Waiting for a checks slot (2 ahead)');
  assert.equal(AppView._checksPhaseCopy('queued', { checks_progress: { queue: { ahead: 0 } } }).title,
    'Waiting for a checks slot (next in line)');
  assert.equal(AppView._checksPhaseCopy('queued').title, 'Waiting for a checks slot', 'a row that does not say');
  assert.equal(AppView._checksPhaseCopy('testing', QUEUED).title, 'Running the automated tests…', 'other phases are untouched');

  const [note] = AppView._checksStatusNotes(QUEUED);
  assert.equal(note.heading, 'Waiting for a checks slot (2 ahead)');
  assert.equal(note.spinner, true, 'in progress');
  assert.equal(note.action, null, 'forty minutes in line is not stuck, so no "Re-run checks"');
  const text = note.rows.map((r) => (r.parts || []).join('')).join(' ');
  assert.match(text, /these start on their own when a slot frees up/);
  assert.match(text, /Waiting since 40\S* ago\./, 'since when, rather than "Started"');
  assert.doesNotMatch(text, /Started /);
  assert.doesNotMatch(text, /re-runs the checks automatically/);
  assert.doesNotMatch(`${note.heading} ${text}`, /—/, 'user-facing copy carries no em dash');

  assert.equal(AppView._checksLine({ state: 'active' }, QUEUED, false), 'Waiting for a slot · 2 ahead');
  // #4452: the change page's Testing card says it, still moving.
  assert.equal(AppView._changeTestingView(QUEUED).note.join(' '), 'Waiting for a checks slot (2 ahead)');
  assert.equal(AppView._changeTestingView({ ...QUEUED, checks_progress: null }).note.join(' '), 'Waiting for a checks slot');
  assert.equal(AppView._changeTestingView(QUEUED).figure, 'Waiting for a slot');
  assert.equal(AppView._changeTestingView(QUEUED).done, false);
});

// #4502 — the deferred card's note explains itself on hover, the same
// sentence the board's Checks deferred chip shows. Queued shares the branch
// and must gain no tooltip: waiting for a slot is not a why.
test('the Testing card\'s deferred line carries its why as the note\'s tooltip, and queued stays untitled', () => {
  const AppView = makeAppView();
  const deferred = { ...QUEUED, check_phase: 'deferred' };
  const v = AppView._changeTestingView(deferred);
  assert.equal(v.note.join(' '), 'Checks deferred');
  assert.equal(v.figure, 'Waiting');
  assert.equal(v.noteTitle, AppView.CHECKS_PHASE_COPY.deferred.detail);
  assert.equal(AppView._changeTestingView(QUEUED).noteTitle, undefined, 'queued gains no tooltip');
});

test('the status pill says the run is waiting, with its place, and keeps the running treatment', () => {
  const MergeStatus = require('../public/js/merge-status.js');
  const pill = MergeStatus.lifecycle(QUEUED);
  assert.equal(pill.key, 'checks_queued');
  assert.equal(pill.label, 'Checks waiting · 2 ahead');
  assert.equal(pill.spinner, true);
  assert.match(pill.title, /^The preview is up, and its checks are waiting for a slot/);
  assert.doesNotMatch(pill.title, /—/);
  assert.equal(MergeStatus.lifecycle({ ...QUEUED, checks_progress: { queue: { ahead: 0 } } }).label, 'Checks waiting · next');
  assert.equal(MergeStatus.lifecycle({ ...QUEUED, checks_progress: null }).label, 'Checks waiting');
});

test('the ?demo=1 fixture serves a queued run, and a declared check reads its card', () => {
  const src = read('src/routes/votes.js');
  const start = src.indexOf('function stagingMockProposals(viewer)');
  let depth = 0; let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  const ctx = { module: {}, console, connectionExhaustionMessage: () => '', ROLLOUT_RETRY_DETAIL: '' };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\n;globalThis.__rows = stagingMockProposals;`, ctx);
  const mock = JSON.parse(JSON.stringify(ctx.__rows('me').find((r) => r.id === 9000054)));
  assert.equal(mock.check_phase, 'queued');
  assert.equal(mock.checks_progress.queue.ahead, 2);
  assert.match(mock.pr_title, /^\[Mock\] /);
  assert.equal(makeAppView()._checksStatusNotes({ ...mock, status: 'promoted' })[0].heading,
    'Waiting for a checks slot (2 ahead)');

  const declared = JSON.parse(read('dapp.json')).tests.filter((t) => String(t.path).includes('/proposals/9000054'));
  assert.equal(declared.length, 1);
  assert.equal(declared[0].expectText, 'Waiting for a checks slot (2 ahead)');
});

// The declared check on 9000054 reads the page's innerText, case-blind
// (capture/capture.js), and Details is a sheet kept hidden until opened. So
// the words have to be on the page itself: the Testing card's line, the one
// line about the checks a reader sees without opening anything. The mock's
// own title must not carry them, or the check would pass on the title alone
// (as "running the automated tests" does on 9000026's).
test('the proposal page itself says where a waiting run is in line, without opening Details', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const src = read('src/routes/votes.js');
  const start = src.indexOf('function stagingMockProposals(viewer)');
  let depth = 0; let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  const ctx = { module: {}, console, connectionExhaustionMessage: () => '', ROLLOUT_RETRY_DETAIL: '' };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\n;globalThis.__rows = stagingMockProposals;`, ctx);
  const mock = JSON.parse(JSON.stringify(ctx.__rows('me').find((r) => r.id === 9000054)));
  // As the list route serves it: with the merge requirements it computes.
  mock.mergeRequirements = JSON.parse(JSON.stringify(mergeRequirements.readRequirements(mock)));
  const [declared] = JSON.parse(read('dapp.json')).tests.filter((t) => String(t.path).includes('/proposals/9000054'));
  const want = declared.expectText.toLowerCase();
  assert.ok(!mock.pr_title.toLowerCase().includes(want), 'the title alone cannot satisfy the check');

  const AppView = makeAppView();
  AppView.appData = { slug: 'usernode-2d5619', can_collaborate: true };
  const v = AppView._topicViewFor('proposal', mock);
  const page = renderToHtml(createElement(ChangeDetail, { card: v.card, body: v.body, item: mock }));
  const text = page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  assert.ok(text.includes(want), `the page says "${declared.expectText}"; it read: ${text.slice(0, 600)}`);
  assert.match(page, /data-change-gate="testing" data-done="false"[\s\S]*?<p class="dev-change-gate-note">Waiting for a checks slot \(2 ahead\)<\/p>/,
    'on the Testing card\'s line');
});

// #4502 — the same page with the run deferred: the note line carries the
// reason as its title, the browser's own tooltip, as the board chip does.
test('the drawn Testing card puts the deferred reason on the note line\'s title', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const src = read('src/routes/votes.js');
  const start = src.indexOf('function stagingMockProposals(viewer)');
  let depth = 0; let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  const ctx = { module: {}, console, connectionExhaustionMessage: () => '', ROLLOUT_RETRY_DETAIL: '' };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\n;globalThis.__rows = stagingMockProposals;`, ctx);
  const deferred = JSON.parse(JSON.stringify(ctx.__rows('me').find((r) => r.id === 9000054)));
  deferred.check_phase = 'deferred';
  deferred.mergeRequirements = JSON.parse(JSON.stringify(mergeRequirements.readRequirements(deferred)));

  const AppView = makeAppView();
  AppView.appData = { slug: 'usernode-2d5619', can_collaborate: true };
  const v = AppView._topicViewFor('proposal', deferred);
  const page = renderToHtml(createElement(ChangeDetail, { card: v.card, body: v.body, item: deferred }));
  const detail = AppView.CHECKS_PHASE_COPY.deferred.detail;
  assert.match(page, new RegExp(`data-change-gate="testing"[\\s\\S]*?<p class="dev-change-gate-note" title="${detail}">Checks deferred</p>`),
    'the note line\'s title carries the deferred reason');
});

test('the Helm chart passes the cap through, documented beside CAPTURE_CPUS', () => {
  const template = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  assert.match(template, /- \{name: CHECKS_MAX_CONCURRENT_RUNS, value: \{\{ \.Values\.config\.checksMaxConcurrentRuns \| int64 \| quote \}\}\}/);
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.match(values, /\n {2}checksMaxConcurrentRuns: 4\n/);
  assert.match(read('deploy/helm/social-vibecoding-platform/README.md'), /`config\.checksMaxConcurrentRuns` \(`CHECKS_MAX_CONCURRENT_RUNS`, default 4\)/);
});
