'use strict';

// A shots run that could not get a database connection in time is the
// platform's fault, and a person reads it in plain words (23 Nov 2026).
//
// Three runs failed in the same half minute on pg-pool's "timeout exceeded
// when trying to connect" while a release's replaced processes finished
// their work on their drain-sized pools; nothing retried them, and the card
// read "Couldn't take the screenshots. timeout exceeded when trying to
// connect." Pinned here:
//   - a step that meets such an error reports it as the database's fault
//     (src/workflow/shots/services.ts failureOf), under one code,
//     `database_busy`, whatever the driver said, with the driver's words kept
//     as the run's reason for admins;
//   - the shots machine takes such a run again once, on its own, and says so;
//   - every reader of the run (rules/shots-detail.ts runSummary) and every
//     line on the card (public/js/app-view.js) says "Homeroom was too busy",
//     never the driver's words, while the retry is pending and after it.
//
// Run with: node --test tests/shots-database-busy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
const { message } = require('./lib/platform-i18n');
const AppView = require('../public/js/app-view.js');
const shotsState = require('../src/services/shots-state');
const { shots, WORK } = require('../src/workflow/shots/machine.ts');

const DRIVER = 'timeout exceeded when trying to connect';
const RAW = /timeout exceeded|trying to connect|ECONNREFUSED|57P01/i;
const SHA = (c) => c.repeat(40);

// ── The step's report ───────────────────────────────────────────────────

function stubOrchestrator(t, patch) {
  const orchestrator = require('../src/services/shots-orchestrator');
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = orchestrator[k]; orchestrator[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) orchestrator[k] = v; });
}

function copiesContext() {
  return {
    workId: 'w1', kind: WORK.copies, key: 'copies:1', attempt: 1, lostAttempts: 0, resumeFrom: null,
    input: { runId: 'r'.repeat(32), sessionId: 42, n: 1, intent: { stories: [] }, baseSha: SHA('a'), headSha: SHA('b'), budgetMs: 60_000 },
    checkpoint: async () => {}, signal: new AbortController().signal, steps: () => null,
  };
}

test('a step that could not get a connection reports the database\'s fault under one code, keeping the driver\'s words', async (t) => {
  const { shotsServices } = require('../src/workflow/shots/services.ts');
  stubOrchestrator(t, { buildCopies: async () => { throw new Error(DRIVER); } });
  const handlers = shotsServices({ config: {}, pool: {} });
  const out = await handlers[WORK.copies].run(copiesContext());
  assert.equal(out.failed.code, 'database_busy');
  assert.equal(out.failed.fault, 'database', 'the platform\'s fault, taken again once');
  assert.equal(out.failed.message, DRIVER, 'the run\'s own reason keeps the driver\'s words, for admins');
});

// ── The machine ─────────────────────────────────────────────────────────

const machine = shots({ execute: true, agentBudgetMs: 480000, runBudgetMs: 1440000 });
const ctx = { now: new Date('2026-11-23T17:28:40Z'), key: 'session:42', version: 3 };
const facts = { session: { id: 42, appId: 10, appSlug: 'usernode-2d5619', status: 'promoted', source: null, head: SHA('b'),
  pins: { imported: null, reviewed: SHA('b'), handoff: null }, readyHeads: [SHA('b')], agentBusy: false,
  slot: { state: null, runId: null, detail: null, run: null }, temporaryWorker: false } };
function building() {
  return { name: 'building_copies', data: {
    sessionId: 42, appId: 10, appSlug: 'usernode-2d5619', declared: { intent: { version: 1, stories: [] }, required: true },
    head: SHA('b'), n: 1, last: null, cleaning: [],
    run: { id: 'r'.repeat(32), n: 1, head: SHA('b'), base: SHA('a'), trigger: 'preview-ready', startedAt: '2026-11-23T17:20:00Z',
      busy: 0, died: 0, dispatches: 0, copiesAt: null, agentStartedAt: null, agentWaitUntil: null, platformRetry: false, afterOnly: false },
  } };
}

test('the machine takes a run that met a busy database again once, on its own', () => {
  const e = { id: 9, type: 'WorkSucceeded', source: { kind: 'service', workId: 'w1' }, payload: {
    sessionId: 42, kind: WORK.copies, workKey: 'copies:1', attempt: 1,
    result: { failed: { code: 'database_busy', message: DRIVER, fault: 'database', retryAt: null } } } };
  const s = building();
  const out = machine.entryFor(s.name, e.type).to(s, e, facts, ctx);
  assert.equal(out.next.name, 'failed');
  assert.equal(out.timer.event.type, 'RetryDue', 'taken again once');
  const moved = out.writes.find((w) => w.type === 'runMoved');
  assert.equal(moved.patch.failureCode, 'database_busy');
  assert.equal(moved.patch.traceSummary.automaticRetry, true);
  assert.deepEqual(moved.patch.traceSummary.platformFault.kind, 'database');
});

// ── What a person reads ─────────────────────────────────────────────────

function summary({ retry }) {
  return shotsState.runSummary({
    id: 'r'.repeat(32), state: 'failed', intent: null, base_sha: SHA('a'), head_sha: SHA('b'),
    failure_code: 'database_busy', failure_reason: DRIVER, hard_verdict: null,
    trace_summary: retry ? { automaticRetry: true, platformFault: { kind: 'database' } } : { platformFault: { kind: 'database' } },
  });
}

test('every reader of the run says Homeroom was too busy, never the driver\'s words', () => {
  for (const retry of [true, false]) {
    const s = summary({ retry });
    assert.equal(s.failureCode, 'database_busy');
    assert.equal(s.failureReason, shotsState.DATABASE_BUSY_REASON);
    assert.doesNotMatch(s.failureReason, RAW);
    assert.equal(s.automaticRetryPending, retry);
  }
});

test('the card, the change page\'s line and the status tag say it plainly while the retry is pending', () => {
  const s = summary({ retry: true });
  const sentence = AppView._shotsSentence(s, 'failed', { notStarted: false, running: false });
  assert.equal(sentence, message('changes:shots.sentence.retryingBusy'));
  assert.equal(sentence, 'Couldn’t take the screenshots: Homeroom was too busy to take them. It tries again on its own shortly.');
  const [label, detail] = AppView._shotsStateCopy(s).failed;
  assert.equal(label, message('changes:shots.state.retrying.label'));
  assert.equal(detail, 'Homeroom was too busy to take them. It tries again on its own shortly.');
  const tag = AppView.blockReasons({ shots: s }).find((r) => r.key === 'shots');
  assert.equal(tag.label, message('changes:badge.reason.shots.retrying'));
  assert.equal(tag.detail, message('changes:badge.reason.shots.retryingBusyDetail'));
  assert.equal(tag.running, true, 'under way, not a failure to act on');
  for (const text of [sentence, label, detail, tag.label, tag.detail]) assert.doesNotMatch(text, RAW);
});

test('after the retry, or with none left, it asks for them again in a few minutes, still in plain words', () => {
  const s = summary({ retry: false });
  const sentence = AppView._shotsSentence(s, 'failed', { notStarted: false, running: false });
  assert.equal(sentence, message('changes:shots.sentence.busy'));
  const [label, detail] = AppView._shotsStateCopy(s).failed;
  assert.equal(label, message('changes:shots.state.couldNot.label'));
  assert.equal(detail, message('changes:shots.state.busy.detail'));
  const tag = AppView.blockReasons({ shots: s }).find((r) => r.key === 'shots');
  assert.equal(tag.detail, message('changes:shots.sentence.busy'));
  for (const text of [sentence, label, detail, tag.detail]) assert.doesNotMatch(text, RAW);
  // Even a view that carried the driver's words (a row written before the
  // code mapped them) is not quoted under this code.
  const raw = { ...s, failureReason: DRIVER };
  assert.doesNotMatch(AppView._shotsSentence(raw, 'failed', { notStarted: false, running: false }), RAW);
  assert.doesNotMatch(AppView._shotsStateCopy(raw).failed[1], RAW);
  assert.doesNotMatch(AppView.blockReasons({ shots: raw }).find((r) => r.key === 'shots').detail, RAW);
});

// ── The ?demo=1 change that shows it ────────────────────────────────────

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function demoProposal(id) {
  const src = read('src/routes/votes.js');
  const start = src.indexOf('function stagingMockProposals(viewer)');
  let depth = 0; let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  const ctx = { module: {}, console, connectionExhaustionMessage: () => '', ROLLOUT_RETRY_DETAIL: '' };
  ctx.globalThis = ctx;
  ctx.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\n;globalThis.__rows = stagingMockProposals;`, ctx);
  return JSON.parse(JSON.stringify(ctx.__rows('me').find((r) => r.id === id)));
}

function pageAppView() {
  const sandbox = {
    console, relTime: () => '1 minute ago',
    App: { user: { id: 1 }, currentTab: 'dev', currentSubTab: 'topic' },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null, querySelector: () => ({ innerHTML: '' }), querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} }, hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} }, location: { search: '', hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext([read('public/js/merge-status.js'), read('public/js/app-view.js'), ';globalThis.__AppView = AppView;'].join('\n'), sandbox);
  const view = sandbox.__AppView;
  view._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  view.appData = { slug: 'usernode-2d5619', can_collaborate: true };
  return view;
}

test('the ?demo=1 change 9000098 is a run that met a busy database, and its page says so in words', () => {
  const mock = demoProposal(9000098);
  assert.match(mock.pr_title, /^\[Mock\] /);
  assert.equal(mock.shots.failureCode, 'database_busy');
  assert.equal(mock.shots.automaticRetryPending, true);
  assert.equal(mock.shots.failureReason, shotsState.DATABASE_BUSY_REASON, 'as the server serves it');
  const want = message('changes:shots.sentence.retryingBusy');
  assert.ok(!mock.pr_title.includes(want), 'the title alone cannot show the words');

  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const mergeRequirements = require('../src/services/merge-requirements');
  mock.mergeRequirements = JSON.parse(JSON.stringify(mergeRequirements.readRequirements(mock)));
  const view = pageAppView();
  const v = view._topicViewFor('proposal', mock);
  // The change page's Before and after card: still under way, in words.
  assert.equal(v.body.thread.shots.line, want);
  assert.equal(v.body.thread.shots.waiting, true);
  const page = renderToHtml(createElement(ChangeDetail, { card: v.card, body: v.body, item: mock }));
  const text = page.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '\'').replace(/\s+/g, ' ');
  assert.ok(text.includes('Homeroom was too busy to take them. It tries again on its own shortly.'), text.slice(0, 800));
  assert.doesNotMatch(text, RAW);
});
