// The run-progress bar (app-view.js _buildProgressSpec / _fmtEta, card/dev-card.tsx
// BuildBar): one segmented bar while a change builds and runs its checks,
// replacing the two spinner chips on the card's meta line and the change
// page's two spinner lines.
//
// The contract:
//   - null unless the run is in flight (pending non-deferred checks, or the
//     shots in one of the in-flight states / retrying); a settled, merged or
//     deferred row never gets one
//   - four segments in run order — build, checks, npm test, shots — each
//     filling from its own counts, no fill where there are none yet
//   - the caption names the phases still moving, in the words the change
//     already uses today, plus "about N min" when the row carries an
//     estimate
//   - while the bar is up, the spinning "Checks running…" chip and the
//     running shots tag stand down; every settled-state tag still draws
//
// Run with: node --test tests/dev-build-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { api, proposalCardHtml } = require('./lib/dev-card-html');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
void api;

const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'), 'utf8');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

const ME = 42;

// The same sandbox tests/dev-status-pill.test.js builds — the card builders
// read App, PlatformUI and the DOM shim.
function makeAppView(opts) {
  const o = opts || {};
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: o.userId != null ? o.userId : ME, canAdminWrite: !!o.admin } },
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>',
      attach: () => {}, _ensureCache: () => ({ count: 0 }), give: () => {}, retract: () => {} },
    PlatformUI: { isTouch: () => !!o.touch, actionSheet: (spec) => { sandbox.__sheet = spec; },
      toast: () => {} },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: o.majority != null ? o.majority : 3 };
  AppView._mergedCtx = { majority: 3 };
  AppView._visualsOpen = new Set();
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  AppView.__sandbox = sandbox;
  return AppView;
}

const PR = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'someone',
  user_id: 999, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  yes_count: 0, no_count: 0, ...over,
});

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();

// ── The builder: when the bar exists at all ─────────────────────────────

test('no bar on a settled, merged or governance row', () => {
  const AppView = makeAppView();
  assert.equal(AppView._buildProgressSpec(PR({ check_state: 'passing' })), null,
    'a verdict is a settled run');
  assert.equal(AppView._buildProgressSpec(PR({ status: 'merged', check_state: 'passing' })), null);
  assert.equal(AppView._buildProgressSpec(PR({ check_state: 'failing' })), null,
    'a failed run is a verdict too: the red tag and Tested line return');
  assert.equal(AppView._buildProgressSpec(PR({ check_state: 'pending', check_phase: 'deferred' })), null,
    'deferred checks run nothing: the soft chip keeps explaining the wait');
  assert.equal(AppView._buildProgressSpec(null), null);
});

test('a run in flight gets a bar: pending checks, or the shots in flight', () => {
  const AppView = makeAppView();
  assert.ok(AppView._buildProgressSpec(PR({ check_state: 'pending', check_phase: 'building' })),
    'the build half');
  assert.ok(AppView._buildProgressSpec(PR({ check_state: 'pending', check_phase: 'testing' })),
    'the testing half');
  assert.ok(AppView._buildProgressSpec(PR({ check_state: 'pending', check_phase: 'queued' })),
    'a queued run keeps the bar, with the waiting words in its caption');
  assert.ok(AppView._buildProgressSpec(PR({
    check_state: 'passing',
    shots: { state: 'exploring', updatedAt: minutesAgo(1) },
  })), 'the shots alone can keep the bar up after the verdict');
  assert.ok(AppView._buildProgressSpec(PR({
    check_state: 'passing',
    shots: { state: 'failed', failureCode: 'shots_change_failed', automaticRetryPending: true, updatedAt: minutesAgo(1) },
  })), 'an interrupted run the sweep restarts is under way, not settled');
  assert.equal(AppView._buildProgressSpec(PR({
    check_state: 'passing',
    shots: { state: 'planned', updatedAt: minutesAgo(90) },
  })), null, 'a planned run past the idle threshold has not started: no bar');
});

// ── The builder: segment fill rules ─────────────────────────────────────

test('no frames yet: the bar shows, every run segment in the spinner state', () => {
  const AppView = makeAppView();
  const spec = AppView._buildProgressSpec(PR({ check_state: 'pending', check_phase: 'building' }));
  const [build, checks, unit, shots] = spec.segments;
  assert.equal(spec.segments.length, 4);
  assert.equal(build.state, 'now');
  assert.equal(build.fraction, null);
  // "Keep the spinners' states where a phase has no duration yet": with no
  // frame at all, nothing is counted and nothing fills.
  assert.equal(checks.state, 'now');
  assert.equal(checks.fraction, null);
  assert.equal(unit.state, 'now');
  assert.equal(unit.fraction, null);
  assert.equal(shots.state, 'todo');
  assert.ok(spec.caption, 'the caption still says something is happening');
  assert.match(spec.caption, /building/i);
});

test('mid-build: the build fills from its finished steps over the five keys', () => {
  const AppView = makeAppView();
  const spec = AppView._buildProgressSpec(PR({
    check_state: 'pending',
    check_phase: 'building',
    checks_progress: {
      build: {
        step: 'clone',
        startedAt: minutesAgo(2),
        steps: [{ key: 'source_fetch', ms: 2555 }, { key: 'image_build', ms: 5372 }],
      },
      updatedAt: minutesAgo(0.2),
    },
  }));
  const [build, checks, unit, shots] = spec.segments;
  assert.equal(build.state, 'now');
  assert.equal(build.fraction, 2 / 5);
  assert.match(spec.caption, /cloning the database/, "the build step's own words");
  assert.equal(checks.state, 'todo', 'the checks cannot run before the build is done');
  assert.equal(shots.state, 'todo');
});

test('testing: the checks fill from ran/expected and npm test from its own counts', () => {
  const AppView = makeAppView();
  const spec = AppView._buildProgressSpec(PR({
    check_state: 'pending',
    check_phase: 'testing',
    checks_progress: {
      build: { step: 'done', steps: [{ key: 'source_fetch', ms: 1 }, { key: 'image_build', ms: 1 }, { key: 'clone', ms: 1 }, { key: 'health', ms: 1 }], totalMs: 19964 },
      ran: 6, passed: 6, failed: 0, expected: 8,
      unit: { phase: 'running', ran: 120, passed: 118, failed: 0, skipped: 2, expected: 190 },
      updatedAt: minutesAgo(0.2),
    },
  }));
  const [build, checks, unit] = spec.segments;
  assert.equal(build.state, 'done');
  assert.equal(build.fraction, 1);
  assert.equal(checks.state, 'now');
  assert.ok(Math.abs(checks.fraction - 6 / 8) < 1e-9);
  assert.equal(unit.state, 'now');
  assert.ok(Math.abs(unit.fraction - 120 / 190) < 1e-9);
  assert.equal(spec.caption, 'Checks 6 of 8 run · npm test: 120 of ~190 run',
    'two jobs run at once, both are named');
  // The checks that finished their expected count fill full even before the
  // verdict lands — 8 of 8 ran is 8 of 8.
  const doneChecks = AppView._buildProgressSpec(PR({
    check_state: 'pending',
    check_phase: 'testing',
    checks_progress: {
      build: { step: 'done', steps: [], totalMs: 1 },
      ran: 8, passed: 8, failed: 0, expected: 8,
      unit: { phase: 'running', ran: 1, passed: 1, failed: 0, expected: 190 },
    },
  }));
  assert.equal(doneChecks.segments[1].fraction, 1);
});

test('queued: the waiting words are the caption, the run segments wait', () => {
  const AppView = makeAppView();
  const spec = AppView._buildProgressSpec(PR({
    check_state: 'pending',
    check_phase: 'queued',
    checks_progress: {
      build: { step: 'done', steps: [{ key: 'source_fetch', ms: 1 }], totalMs: 1000 },
      queue: { ahead: 2, since: minutesAgo(3) },
    },
  }));
  assert.equal(spec.segments[0].state, 'done');
  assert.equal(spec.segments[1].state, 'todo');
  assert.equal(spec.segments[2].state, 'todo');
  assert.match(spec.caption, /Waiting for a checks slot/);
  assert.match(spec.caption, /2 ahead/, 'the place in line rides the waiting words');
});

test('after the verdict only the shots segment can still be moving', () => {
  const AppView = makeAppView();
  const spec = AppView._buildProgressSpec(PR({
    check_state: 'passing',
    shots: { state: 'exploring', updatedAt: minutesAgo(1) },
    // #2170: a settled row's checks_progress is reduced to the finished
    // build block and checksMs — the three run segments read as done.
    checks_progress: { build: { step: 'done', steps: [{ key: 'source_fetch', ms: 1 }], totalMs: 20000 }, checksMs: 400000 },
  }));
  const [build, checks, unit, shots] = spec.segments;
  assert.equal(build.state, 'done');
  assert.equal(checks.state, 'done');
  assert.equal(unit.state, 'done');
  assert.equal(shots.state, 'now');
  assert.equal(shots.fraction, null, 'the capture job reports no counts: no fill');
  assert.equal(spec.caption, 'Taking before & after shots');
});

test('the estimate rides the caption when the row carries one, and words itself past the hour', () => {
  const AppView = makeAppView();
  const withEta = AppView._buildProgressSpec(PR({
    check_state: 'pending', check_phase: 'testing', run_eta: { ms: 240000, samples: 4 },
  }));
  assert.equal(withEta.etaText, 'about 4 min');
  const withoutEta = AppView._buildProgressSpec(PR({
    check_state: 'pending', check_phase: 'testing',
  }));
  assert.equal(withoutEta.etaText, undefined,
    'no estimate until the project has settled runs enough to median over');
  // The estimate never rides INSIDE the caption: BuildBar joins the two in
  // the note line under the bar.
  assert.ok(!withEta.caption.includes('about'));
  assert.equal(AppView._fmtEta(60000), 'about 1 min');
  assert.equal(AppView._fmtEta(240000), 'about 4 min');
  assert.equal(AppView._fmtEta(4200000), 'about 1h 10m');
  assert.equal(AppView._fmtEta(7200000), 'about 2h');
});

// ── The chips stand down only while the bar is up ───────────────────────

test('the checks-running chip and the running shots tag stand down while the bar is up', () => {
  const AppView = makeAppView();
  const pending = PR({
    check_state: 'pending', check_phase: 'testing',
    checks_progress: {
      build: { step: 'done', steps: [], totalMs: 1 },
      ran: 1, passed: 1, failed: 0, expected: 8,
    },
    shots: { state: 'exploring', updatedAt: minutesAgo(1) },
  });
  const keys = AppView.statusTagSpecs(pending, {}).map((t) => t.key);
  assert.ok(!keys.includes('tag-checks-running'), 'no spinning checks chip beside the bar');
  assert.ok(!keys.includes('tag-shots'), 'no running shots tag beside the bar');

  const failing = PR({ check_state: 'failing', test_results: [{ name: 'a', status: 'fail' }] });
  const failingKeys = AppView.statusTagSpecs(failing, {}).map((t) => t.key);
  assert.ok(failingKeys.includes('tag-checks_failing'),
    'a settled failure keeps its red tag: the bar is gone with the run');

  const deferred = PR({ check_state: 'pending', check_phase: 'deferred' });
  const deferredKeys = AppView.statusTagSpecs(deferred, {}).map((t) => t.key);
  assert.ok(deferredKeys.includes('tag-checks-deferred'),
    'the deferred chip stays: nothing is running');

  // A shots run that never started keeps its chip — it is the one pending
  // state with something for the reader to do.
  const notStarted = PR({
    check_state: 'passing',
    shots: { state: 'planned', notStartedReason: 'Nothing has picked this preview up yet.', updatedAt: minutesAgo(90) },
  });
  const notStartedKeys = AppView.statusTagSpecs(notStarted, {}).map((t) => t.key);
  assert.ok(notStartedKeys.includes('tag-shots'), 'the not-started shots chip keeps explaining the wait');
});

// ── The rendered markup ─────────────────────────────────────────────────

test('the card draws the bar after the meta line, four segments, no chips', () => {
  const AppView = makeAppView();
  const html = proposalCardHtml(AppView, PR({
    check_state: 'pending', check_phase: 'testing',
    checks_progress: {
      build: { step: 'done', steps: [{ key: 'source_fetch', ms: 1 }], totalMs: 20000 },
      ran: 8, passed: 8, failed: 0, expected: 8,
      unit: { phase: 'running', ran: 120, passed: 118, failed: 0, expected: 190 },
    },
    run_eta: { ms: 240000, samples: 4 },
  }));
  assert.match(html, /data-run-progress="1"/);
  assert.equal((html.match(/dev-progress-seg/g) || []).length, 4, 'four segments');
  assert.match(html, /dev-progress-done/, 'the finished build fills');
  assert.match(html, /dev-progress-part/, 'the running suite shows its partial fill');
  assert.match(html, /npm test: 120 of ~190 run/);
  assert.match(html, /about 4 min/);
  assert.ok(!html.includes('Checks running…'), 'the spinner chip is not drawn beside the bar');
});

test('BuildBar renders the caption, the estimate and the aria reading', () => {
  const { BuildBar } = loadTsx('frontend/src/features/dev-board/card/dev-card.tsx');
  const spec = {
    segments: [
      { key: 'build', title: 'Preview built in 20s', state: 'done', fraction: 1 },
      { key: 'checks', title: 'Checks: 8 of 8 run, 8 passed', state: 'done', fraction: 1 },
      { key: 'unit', title: 'npm test: 120 of ~190 run · 118 passed', state: 'now', fraction: 0.63 },
      { key: 'shots', title: 'Before & after shots, not started yet', state: 'todo', fraction: null },
    ],
    caption: 'npm test: 120 of ~190 run',
    etaText: 'about 4 min',
  };
  const html = renderToHtml(createElement(BuildBar, { p: spec }));
  assert.match(html, /data-run-progress="1"/);
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="npm test: 120 of ~190 run · about 4 min"/);
  assert.match(html, /title="Preview built in 20s"/);
  assert.match(html, /style="width:63%"/, 'the partial fill is the fraction');
  assert.match(html, /dc-status-spinner-arc/, 'the shell’s own spinner arc');
  assert.equal((html.match(/dev-progress-seg/g) || []).length, 4);
});

test('a settled card draws no bar at all', () => {
  const AppView = makeAppView();
  const html = proposalCardHtml(AppView, PR({
    status: 'merged', check_state: 'passing',
  }));
  assert.ok(!html.includes('data-run-progress'), 'the bar leaves with the run');
});
