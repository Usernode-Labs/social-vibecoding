'use strict';

// #4452 — the change page's ONE run bar: AppView._runBarView builds its
// segments off the item, run-bar.ts turns the app's medians and the clock
// into "About 4 minutes left", and the hero draws the bar in place of the
// "Testing it…" and "Taking before & after shots" spinner lines.
//
// Run with: node --test tests/change-run-bar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');

function context(user = { id: 42, username: 'Builder' }) {
  const c = { console, App: { user, currentApp: 'example', currentTab: 'dev' },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams, ...{} };
  c.window = c;
  vm.createContext(c);
  for (const p of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  const av = c.av;
  av.appData = { slug: 'example', can_collaborate: true };
  av._proposalsCtx = { majority: 2, activeUsers: 5, locked: false };
  return av;
}

// A change mid-run: the build half has finished its first step, the row
// carries no checks stamp yet, and no shots row exists.
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const ago = (ms) => new Date(NOW - ms).toISOString();

function runItem(over = {}) {
  return {
    id: 4091, user_id: 7, username: 'maya', status: 'promoted', source: 'native',
    pr_number: 12, pr_title: 'Authenticate previews',
    pr_summary_md: 'Previews wait for sign-in.', linked_issues: [],
    yes_count: 0, no_count: 0, votes_required: 2,
    created_at: '2026-09-11T12:00:00Z', staging_url: 'https://preview.example',
    check_state: 'pending', check_phase: 'building',
    checks_checked_at: null,
    checks_progress: {
      build: {
        step: 'image_build', startedAt: ago(30 * 1000),
        steps: [{ key: 'source_fetch', ms: 8000 }],
      },
    },
    test_results: [],
    freshness: { mergeability: 'clean', behindBy: 0, checkedAt: ago(60 * 1000) },
    ...over,
  };
}

const seg = (bar, key) => bar.segments.find((s) => s.key === key) || null;

// ── _runBarView ─────────────────────────────────────────────────────────

test('the bar shows while the build runs: build filling, checks and shots to come', () => {
  const av = context();
  const bar = av._runBarView(runItem({
    shots: { state: 'planned', required: true, updatedAt: new Date(Date.now() - 10 * 1000).toISOString(), claims: [] },
  }));
  assert.ok(bar, 'a live run has a bar');
  assert.equal(bar.label, 'Building the preview');
  assert.equal(bar.phase, 'building');
  assert.deepEqual(Array.from(bar.segments, (s) => [s.key, s.state, s.fill]), [
    ['build', 'now', 0.2], ['checks', 'todo', 0], ['shots', 'todo', 0],
  ], 'one finished step of the five the pipeline has');
  assert.equal(bar.timing.buildLive, true);
  assert.equal(bar.timing.checksLive, false);
});

test('three of five finished build steps fill 0.6, and no step yet is a pulse', () => {
  const av = context();
  const steps = ['source_fetch', 'image_build', 'clone'].map((key) => ({ key, ms: 1000 }));
  const bar = av._runBarView(runItem({
    checks_progress: { build: { step: 'health', startedAt: ago(5000), steps } },
  }));
  assert.equal(seg(bar, 'build').fill, 0.6);
  const fresh = av._runBarView(runItem({
    checks_progress: { build: { step: 'source_fetch', startedAt: ago(500), steps: [] } },
  }));
  assert.equal(seg(fresh, 'build').fill, null, 'nothing to size against yet: the segment pulses');
});

test('a queued run says its place in line, and the build counts as done', () => {
  const av = context();
  const bar = av._runBarView(runItem({
    check_phase: 'queued',
    checks_progress: { build: { step: 'done', totalMs: 20000, steps: [{ key: 'source_fetch', ms: 8000 }] }, queue: { ahead: 2 } },
  }));
  assert.equal(bar.label, 'Waiting for a checks slot (2 ahead)');
  assert.equal(bar.phase, 'queued');
  assert.equal(seg(bar, 'build').state, 'done');
  assert.equal(seg(bar, 'checks').state, 'todo');
});

test('while testing, the two check jobs share one part, each filling its half', () => {
  const av = context();
  const bar = av._runBarView(runItem({
    check_phase: 'testing',
    checks_checked_at: ago(60 * 1000),
    checks_progress: {
      build: { step: 'done', totalMs: 20000, steps: [{ key: 'source_fetch', ms: 8000 }] },
      ran: 6, passed: 6, failed: 0, expected: 8,
      unit: { phase: 'running', ran: 100, passed: 100, failed: 0, expected: 200 },
    },
    shots: { state: 'exploring', required: true, startedAt: ago(30 * 1000), updatedAt: ago(10 * 1000), claims: [] },
  }));
  assert.equal(bar.label, 'Testing it…');
  assert.equal(bar.phase, 'testing');
  assert.equal(seg(bar, 'build').state, 'done');
  assert.equal(seg(bar, 'checks').state, 'now');
  assert.equal(seg(bar, 'checks').fill, 0.625, 'mean of 6/8 and 100/200');
  assert.equal(seg(bar, 'shots').state, 'now', 'the shots run while the checks do');
  assert.equal(seg(bar, 'shots').fill, null, 'the shots report a phase and no count');
  assert.equal(bar.timing.checksStartedAt, Date.parse(ago(60 * 1000)));
});

test('a job that is done counts as 1; one with no total is left out; all unknown pulses', () => {
  const av = context();
  const done = av._runBarView(runItem({
    check_phase: 'testing',
    checks_progress: { build: null, done: true, ran: 12, passed: 12, failed: 0, expected: 12 },
  }));
  assert.equal(seg(done, 'checks').fill, 1);
  const half = av._runBarView(runItem({
    check_phase: 'testing',
    checks_progress: { build: null, done: true, ran: 12, passed: 12, failed: 0, expected: 12, unit: { phase: 'cloning', ran: 0, passed: 0, failed: 0, expected: null } },
  }));
  assert.equal(seg(half, 'checks').fill, 1, 'the unit job with no total is left out, not a zero');
  const unknown = av._runBarView(runItem({
    check_phase: 'testing',
    checks_progress: { build: null, ran: 3, passed: 3, failed: 0, expected: null, unit: { phase: 'running', ran: 0, passed: 0, failed: 0, expected: null } },
  }));
  assert.equal(seg(unknown, 'checks').fill, null);
});

test('once the checks settle, the bar stays for the shots and says so', () => {
  const av = context();
  const bar = av._runBarView(runItem({
    check_state: 'passing', check_phase: 'testing',
    checks_progress: { build: { step: 'done', totalMs: 20000, steps: [] }, ran: 8, passed: 8, failed: 0, expected: 8 },
    shots: { state: 'exploring', required: true, startedAt: ago(30 * 1000), updatedAt: ago(10 * 1000), claims: [] },
  }));
  assert.equal(bar.label, 'Taking before & after shots');
  assert.equal(bar.phase, 'shots');
  assert.deepEqual(Array.from(bar.segments, (s) => [s.key, s.state]), [
    ['build', 'done'], ['checks', 'done'], ['shots', 'now'],
  ]);
  const retrying = av._runBarView(runItem({
    check_state: 'passing',
    shots: { state: 'failed', automaticRetryPending: true, required: true, startedAt: ago(30 * 1000), updatedAt: ago(10 * 1000), claims: [] },
  }));
  assert.equal(retrying.label, 'Trying the shots again');
  assert.equal(seg(retrying, 'shots').state, 'now');
});

test('a run that needs no shots, failed, never started, or needs none, leaves the Shots part out', () => {
  const av = context();
  const shotsList = [
    { state: 'exploring', required: false, updatedAt: ago(1000), claims: [] },
    { state: 'not_required', updatedAt: ago(1000), claims: [] },
    { state: 'failed', failureReason: 'no', updatedAt: ago(1000), claims: [] },
    { state: 'planned', updatedAt: ago(10 * 60 * 1000), claims: [] },
  ];
  for (const shots of shotsList) {
    const bar = av._runBarView(runItem({ check_state: 'passing', shots }));
    assert.equal(bar, null, `${shots.state}: nothing left running, no bar`);
    const during = av._runBarView(runItem({ shots }));
    if (during) assert.equal(seg(during, 'shots'), null, `${shots.state}: no Shots part while the checks run`);
  }
});

test('a settled or deferred run has no bar, and neither has a run with nothing at all', () => {
  const av = context();
  assert.equal(av._runBarView(runItem({ check_state: 'passing' })), null);
  assert.equal(av._runBarView(runItem({ check_phase: 'deferred' })), null);
  assert.equal(av._runBarView(null), null);
});

test('the estimate rides along from the app’s cache, and the bar starts the load', () => {
  const av = context();
  av._runEstimates = { example: { at: Date.now(), data: { runs: 5, buildMs: 20000, checksMs: 180000, shotsMs: null } } };
  let asked = 0;
  av._loadRunEstimate = () => { asked += 1; };
  const bar = av._runBarView(runItem());
  assert.equal(asked, 1, 'a bar starts the estimate load');
  assert.deepEqual(JSON.parse(JSON.stringify(bar.estimate)), { runs: 5, buildMs: 20000, checksMs: 180000, shotsMs: null });
  assert.equal(av._runBarView(runItem({ check_state: 'passing' })), null);
  assert.equal(asked, 1, 'no bar, no load');
});

// ── remainingMs / etaText ────────────────────────────────────────────────

const runBar = require('../frontend/src/features/dev-board/topic/run-bar.ts');
const { remainingMs, etaText } = runBar;

function barFor(over = {}) {
  const av = context();
  av._runEstimates = { example: { at: Date.now(), data: {
    runs: 5, buildMs: 20000, checksMs: 240000, shotsMs: 120000, ...over.estimate } } };
  const base = runItem({
    check_phase: 'testing',
    checks_checked_at: ago(0),
    checks_progress: {
      build: { step: 'done', totalMs: 20000, steps: [] },
      ran: 1, passed: 1, failed: 0, expected: 8,
    },
    shots: { state: 'exploring', required: true, startedAt: ago(0), updatedAt: ago(0), claims: [] },
    ...over.item,
  });
  return av._runBarView(base);
}

test('what is left is the build’s remainder plus the longer of checks and shots', () => {
  // The build is done; the checks have been running a minute of their 4;
  // the shots half a minute of their 2. The checks are the longer wait.
  const bar = barFor({
    item: { checks_checked_at: ago(60 * 1000), checks_progress: {
      build: { step: 'done', totalMs: 20000, steps: [] }, ran: 1, passed: 1, failed: 0, expected: 8,
    } },
  });
  bar.timing.shotsStartedAt = NOW - 30 * 1000;
  assert.equal(remainingMs(bar, NOW), 180000);
});

test('a run waiting for a checks slot has no estimate, and neither has an app with too few runs', () => {
  assert.equal(remainingMs(barFor({ item: { check_phase: 'queued' } }), NOW), null);
  assert.equal(remainingMs(barFor({ estimate: { checksMs: null } }), NOW), null,
    'the running part has no median to age against');
  const noEstimate = barFor();
  noEstimate.estimate = null;
  assert.equal(remainingMs(noEstimate, NOW), null, 'no estimate at all');
});

test('the shots alone running with no median of their own is no estimate; beside checks they are left out', () => {
  const solo = barFor({ item: { check_state: 'passing' }, estimate: { shotsMs: null } });
  solo.timing = { ...solo.timing, buildLive: false, checksLive: false, shotsLive: true };
  assert.equal(remainingMs(solo, NOW), null);
  const withChecks = barFor({ estimate: { shotsMs: null } });
  assert.ok(withChecks.timing.checksLive);
  assert.ok(remainingMs(withChecks, NOW) > 0, 'the checks still carry the estimate');
});

test('past the estimate the words change, and a minute or less reads as one minute', () => {
  const bar = barFor({ item: {
    checks_checked_at: ago(10 * 60 * 1000),
    shots: { state: 'exploring', required: true, startedAt: ago(10 * 60 * 1000), updatedAt: ago(10 * 60 * 1000), claims: [] },
  } });
  assert.equal(remainingMs(bar, NOW), 0, 'floored at zero, not negative');
  assert.equal(etaText(remainingMs(bar, NOW)), 'Taking longer than usual');
  assert.equal(etaText(90 * 1000), 'About a minute left');
  assert.equal(etaText(60000), 'About a minute left');
  assert.equal(etaText(240000), 'About 4 minutes left');
  assert.equal(etaText(null), '');
});

// ── the hero renders the bar in place of the spinner lines ──────────────

test('the change page shows the one bar and neither the running Tested line nor the shots spinner', () => {
  const av = context();
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const item = runItem({
    check_phase: 'testing',
    checks_progress: {
      build: { step: 'done', totalMs: 20000, steps: [{ key: 'source_fetch', ms: 8000 }] },
      ran: 2, passed: 2, failed: 0, expected: 8,
    },
    shots: { state: 'exploring', required: true, startedAt: ago(30 * 1000), updatedAt: ago(10 * 1000), claims: [] },
  });
  const v = av._topicViewFor('proposal', item);
  assert.ok(v.body.runBar, 'the view model carries the bar');
  const page = renderToHtml(createElement(ChangeDetail, { card: v.card, body: v.body, item, conversation: true }));
  assert.match(page, /<button type="button" class="dev-topic-run" data-run-phase="testing"/);
  assert.match(page, /Testing it…/);
  assert.ok(!page.includes('dev-topic-tested'), 'no spinner Tested line while the bar is up');
  assert.ok(!page.includes('dev-topic-hero-shots'), 'no shots spinner line while the bar carries the shots');
  assert.match(page, /class="dev-topic-run-seg is-now" data-step="shots"/);
});
