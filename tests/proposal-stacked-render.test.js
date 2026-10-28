'use strict';

// What people see of an imported change stacked on another open change's
// branch (src/workflow/rules/pr-base.ts; the machine side is
// tests/workflow-stacked-imports-postgres.test.js). The row carries
// `imported_pr_base_ref`, `waits_for_session_id` and `waits_for` (the
// change it waits for), and:
//
//   - the card says "Waits for #N" as an amber tag (nobody has to act on
//     this change, as with deferred checks), with what happens next on
//     hover; the bar stays the vote;
//   - one based on a branch no open change has says "Not based on main" in
//     red, with what a person does about it;
//   - the change's page says it once, above Votes and Testing, with a door
//     to the change it waits for.
//
// Run with: node --test tests/proposal-stacked-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { proposalCardHtml } = require('./lib/dev-card-html');
const { renderComponent } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP_VIEW_SRC = read('public', 'js', 'app-view.js');
const MERGE_STATUS_SRC = read('public', 'js', 'merge-status.js');

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 42 }, currentApp: 'demo' },
    Kudos: { renderButton: () => '', attach: () => {}, _ensureCache: () => ({ count: 0 }), give: () => {}, retract: () => {} },
    PlatformUI: { isTouch: () => false, actionSheet: () => {}, toast: () => {} },
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
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 2, activeUsers: 3 };
  AppView._mergedCtx = { majority: 2 };
  AppView._visualsOpen = new Set();
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  return AppView;
}

// #5957 on 28 Oct 2026: imported, up for a vote, stacked on #5956's branch.
const PR = (over) => ({
  id: 11569, pr_number: 5957, pr_title: 'SEC-09: no Kubernetes writes from web', username: 'bruno', user_id: 999,
  status: 'promoted', created_at: '2026-10-28T16:50:00Z', yes_count: 1, no_count: 0,
  check_state: 'passing', source: 'imported',
  imported_pr_base_ref: 'claude/sec09-conductor-runtime-writes', waits_for_session_id: 11568,
  waits_for: { id: 11568, prNumber: 5956, title: 'SEC-09: conductor runtime writes', status: 'promoted' },
  ...over,
});
const WAITS = 'This change is built on #5956, so it can go live only after #5956 does. Homeroom then moves it onto main and brings it up to date.';
const NOT_MAIN = 'Its pull request targets someone/else, not main, and no open change here is built on that branch. Change its base to main on GitHub before it can go live.';

test('the copy, from the catalogs', () => {
  assert.equal(message('changes:badge.reason.waitsFor.label', { number: 5956 }), 'Waits for #5956');
  assert.equal(message('changes:badge.reason.waitsFor.detail', { number: 5956 }), WAITS);
  assert.equal(message('changes:badge.reason.baseNotMain.label'), 'Not based on main');
  assert.equal(message('changes:badge.reason.baseNotMain.detail', { branch: 'someone/else' }), NOT_MAIN);
  assert.equal(message('project:topic.change.baseNotMain', { branch: 'someone/else' }), NOT_MAIN);
  for (const id of ['changes:badge.reason.waitsFor.detail', 'project:topic.change.waitsFor', 'project:topic.change.baseNotMain']) {
    assert.doesNotMatch(message(id, { number: 1, title: 't', branch: 'b' }), /—/);
  }
});

test('the card: an amber "Waits for #5956", first; the bar stays the vote', () => {
  const AppView = makeAppView();
  const reasons = JSON.parse(JSON.stringify(AppView.blockReasons(PR())));
  // It stops the merge (not `soft`: the card says it can't merge yet), and
  // nobody has to act on this change (`waiting`: drawn amber).
  assert.deepEqual(reasons[0], { key: 'waits_for_change', label: 'Waits for #5956', detail: WAITS, waiting: true });
  const tags = AppView.statusTagSpecs(PR());
  assert.equal(tags[0].cls, AppView.STATUS_TAG_CLS.soft, 'amber: nobody has to act on this change');
  assert.match(APP_VIEW_SRC, /list\.some\(\(r\) => !r\.soft\) \? PlatformI18n\.t\('changes:card\.reasons\.cantMerge'\)/,
    'a reason that is not soft makes the card say why it can\'t merge yet');
  assert.match(APP_VIEW_SRC, /key: r\.key, tone: r\.soft \|\| r\.waiting \? 'warn' : 'bad',/, 'its ledger row is amber too');
  assert.equal(tags[0].data['data-status-tag'], 'waits_for_change');
  assert.equal(tags[0].spinner, false, 'nothing is in flight');
  assert.equal(AppView.statusPillState(PR()).key, 'needs_vote', 'its vote goes on meanwhile');
  const html = proposalCardHtml(AppView, PR());
  assert.match(html, /data-status-tag="waits_for_change"/);
  assert.match(html, />Waits for #5956</);
  // The change it waits for has no number yet.
  const unnumbered = AppView.blockReasons(PR({ waits_for: { id: 11568, prNumber: null, title: null } }))[0];
  assert.equal(unnumbered.label, 'Waits for another change');
});

test('the card: a base no open change has is a red "Not based on main"; on main (no other base) says nothing', () => {
  const AppView = makeAppView();
  const lone = AppView.blockReasons(PR({ imported_pr_base_ref: 'someone/else', waits_for_session_id: null, waits_for: null }))[0];
  assert.deepEqual(JSON.parse(JSON.stringify(lone)), { key: 'base_not_main', label: 'Not based on main', detail: NOT_MAIN });
  const tags = AppView.statusTagSpecs(PR({ imported_pr_base_ref: 'someone/else', waits_for_session_id: null, waits_for: null }));
  assert.equal(tags[0].cls, AppView.STATUS_TAG_CLS.blocking);
  for (const over of [{ imported_pr_base_ref: null, waits_for_session_id: null, waits_for: null }, { source: 'native' }]) {
    const keys = AppView.blockReasons(PR(over)).map((r) => r.key);
    assert.ok(!keys.includes('waits_for_change') && !keys.includes('base_not_main'), JSON.stringify(over));
  }
});

test('the change\'s page: the notice above Votes and Testing, with a door to the change it waits for', () => {
  const AppView = makeAppView();
  const card = AppView._proposalCardModel(PR());
  const view = AppView._changeThreadView('proposal', PR(), card, { hero: { author: 'bruno' } });
  assert.deepEqual(JSON.parse(JSON.stringify(view.waitsFor)), {
    sessionId: 11568, number: 5956, title: 'SEC-09: conductor runtime writes', href: '#app/demo/dev/changes/5956',
  });
  assert.equal(view.baseNotMain, undefined);
  const lone = AppView._changeThreadView('proposal', PR({ imported_pr_base_ref: 'someone/else', waits_for_session_id: null, waits_for: null }), card, { hero: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(lone.baseNotMain)), { branch: 'someone/else' });
  for (const status of ['merged', 'closed']) {
    const done = AppView._changeThreadView('proposal', PR({ status }), card, { hero: {} });
    assert.equal(done.waitsFor, undefined, `${status}: nothing to wait for`);
  }

  const head = 'frontend/src/features/dev-board/topic/change-head.tsx';
  const notice = renderComponent(head, 'StackNotice', { v: view });
  assert.match(notice, /^<div data-change-waits-for="11568" class="rounded-lg border border-amber-500\/40 bg-amber-500\/10 text-sm text-amber-800 dark:text-amber-300 px-3 py-2 mt-3">/);
  assert.match(notice, /Waits for <a href="#app\/demo\/dev\/changes\/5956" class="font-semibold underline" data-change-waits-for-link="11568">#5956: SEC-09: conductor runtime writes<\/a>\. This change is built on that change’s branch, so it can go live only after #5956 does\./);
  // The change it waits for has no number yet: the notice still says so.
  const unnumbered = renderComponent(head, 'StackNotice', { v: { ...view, waitsFor: { ...view.waitsFor, number: null, href: '#app/demo/dev/proposals/11568' } } });
  assert.match(unnumbered, /Waits for <a href="#app\/demo\/dev\/proposals\/11568" class="font-semibold underline" data-change-waits-for-link="11568">another change<\/a>\./);
  const red = renderComponent(head, 'StackNotice', { v: lone });
  assert.match(red, /data-change-base-not-main=""/);
  assert.match(red, /Its pull request targets someone\/else, not main/);
  assert.match(read(head), /\{v\.codeMissing \? <CodeMissingNotice \/> : null\}\s*\{v\.waitsFor \|\| v\.baseNotMain \? <StackNotice v=\{v\} \/> : null\}\s*<div ref=\{pair\} className="dev-change-pair">/,
    'above the Votes and Testing cards, which stay as they are');
});
