'use strict';

// What people see of a proposal whose code did not come across when Homeroom
// moved off GitHub (src/services/code-missing.js; the server side is
// tests/proposal-code-missing.test.js). The row carries `code_missing`, and:
//
//   - the board card and the Workshop row say "Code missing" as their one red
//     status tag, with the sentence as its tooltip, in place of every other
//     tag (its checks and conflicts are about a head that is not there); the
//     status pill stays the vote, which still counts;
//   - the change's page says the sentence once, above Votes and Testing, in
//     the amber notice the project page's "code changes are paused" banner is
//     drawn with;
//   - the Needs you feeds (a project's own, and the Communities screen's)
//     say "Code missing" on the item's facts line, and never "your yes puts
//     it live";
//   - a vote on it is saved and the voter hears that it cannot go live yet.
//
// Run with: node --test tests/proposal-code-missing-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { proposalCardHtml } = require('./lib/dev-card-html');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP_VIEW_SRC = read('public', 'js', 'app-view.js');
const MERGE_STATUS_SRC = read('public', 'js', 'merge-status.js');

const SENTENCE = 'This proposal’s code didn’t come across when Homeroom moved off GitHub. '
  + 'Its creator can submit it again, or Homeroom restores it when GitHub’s copy of the code arrives.';

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 42 } },
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

// Up for a vote, one Yes short, with everything else a card could say wrong
// with it: failing checks, a conflict, behind main.
const PR = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'someone', user_id: 999,
  status: 'promoted', created_at: '2026-10-20T00:00:00Z', yes_count: 1, no_count: 0,
  check_state: 'failing', test_results: [{ name: 'header', status: 'fail' }],
  merge_conflict_state: 'conflict', integration_measured_at: '2026-10-25T00:00:00Z',
  integration_merges_clean: false, integration_behind_by: 4,
  code_missing: true,
  ...over,
});

test('the copy, from the catalogs', () => {
  assert.equal(message('changes:badge.reason.codeMissing.label'), 'Code missing');
  assert.equal(message('changes:badge.reason.codeMissing.detail'), SENTENCE);
  assert.equal(message('project:topic.change.codeMissing'), SENTENCE);
  assert.equal(message('project:needsYou.fact.codeMissing'), 'Code missing');
  assert.equal(message('project:needsYou.fact.codeMissingTitle'), SENTENCE);
  assert.equal(message('changes:vote.toast.codeMissing'), 'Your vote is saved. This proposal can’t go live until its code is back.');
  // A change underway (its own branch did not come across): the dev chat's
  // strip, its button, and the first message the button hands the agent.
  // The server's sentence (code-missing.js BRANCH_GONE) says the same.
  const UNDERWAY = 'This change’s code didn’t come across when Homeroom moved off GitHub, so it can’t be continued here. '
    + 'Nothing was changed. Start a new change from the current version (its plan comes with it), '
    + 'or wait: Homeroom restores the code when GitHub’s copy arrives.';
  assert.equal(message('devchat:banner.codeMissing.text'), UNDERWAY);
  assert.equal(require('../src/services/code-missing').BRANCH_GONE, UNDERWAY.replace(/’/g, "'"));
  assert.equal(message('devchat:banner.codeMissing.start'), 'Start a new change');
  assert.equal(message('devchat:banner.codeMissing.seed', { id: 4223 }),
    'Start a new change from the current version, with the plan from change 4223.');
  for (const key of ['text', 'start', 'seed']) assert.doesNotMatch(message(`devchat:banner.codeMissing.${key}`, { id: 1 }), /—/);
});

test('the card: one red "Code missing" tag with the sentence on hover, and the vote stays its pill', () => {
  const AppView = makeAppView();
  assert.deepEqual(JSON.parse(JSON.stringify(AppView.blockReasons(PR()))), [
    { key: 'code_missing', label: 'Code missing', detail: SENTENCE },
  ], 'the one thing to say: its checks and conflicts are about a head that is not there');
  const tags = AppView.statusTagSpecs(PR({ check_state: 'pending' }));
  assert.equal(tags.length, 1, 'no "Checks running" beside it either: nothing runs on it');
  assert.equal(tags[0].cls, AppView.STATUS_TAG_CLS.blocking, 'red: it stops it merging');
  assert.equal(tags[0].title, SENTENCE);
  assert.equal(tags[0].data['data-status-tag'], 'code_missing');

  const pill = AppView.statusPillState(PR());
  assert.equal(pill.key, 'needs_vote', 'the bar is still the vote: a vote on it is recorded');
  assert.deepEqual([...pill.reasons.map((r) => r.key)], ['code_missing']);

  const html = proposalCardHtml(AppView, PR());
  assert.equal((html.match(/data-status-tag="/g) || []).length, 1, 'one status tag on the card');
  assert.match(html, /data-status-tag="code_missing"/);
  assert.match(html, /bg-red-500\/10 text-red-700/);
  assert.match(html, />Code missing</);
  assert.match(html, new RegExp(`title="${SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.doesNotMatch(html, /dc-status-dot|bg-emerald|bg-green-/, 'no status dot, nothing green');

  // A row without the flag, or one no longer open, reads as it always did.
  const plain = AppView.blockReasons(PR({ code_missing: false })).map((r) => r.key);
  assert.ok(plain.includes('checks_failing') && !plain.includes('code_missing'));
  assert.equal(AppView._codeMissing(PR({ status: 'merged' })), false);
  assert.equal(AppView._codeMissing(PR({ status: 'closed' })), false);
  assert.equal(AppView._codeMissing(PR({ status: 'paused' })), true, 'underway with its pull request: the same');
});

test('no yes puts it live, and a vote on it says it cannot go live yet', () => {
  const AppView = makeAppView();
  assert.equal(AppView._yesPutsItLive(PR({ code_missing: false, check_state: 'passing', merge_conflict_state: null })), true,
    'one Yes short, as it stands');
  assert.equal(AppView._yesPutsItLive(PR()), false, 'until its code is back');
  // castVote: the server says so when it knows, the row's own flag otherwise.
  const cast = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('  async castVote('), APP_VIEW_SRC.indexOf('  async retractVote('));
  assert.match(cast, /if \(data\.codeMissing === true \|\| AppView\._codeMissing\(pr\) \|\| AppView\._codeMissing\(live\)\) \{\s*window\.PlatformUI\?\.toast\?\.\(PlatformI18n\.t\('changes:vote\.toast\.codeMissing'\)\);/);
  assert.ok(cast.indexOf("'changes:vote.toast.codeMissing'") > cast.indexOf('if (!res.ok)'), 'only once the vote is saved');
});

test('the Workshop row says it as its red tag, with the sentence as its tooltip', () => {
  const AppView = makeAppView();
  const card = AppView._proposalCardModel(PR());
  const brief = AppView._workshopBrief('proposal', PR(), card);
  const bad = brief.tags.filter((t) => t.tone === 'bad');
  assert.deepEqual(JSON.parse(JSON.stringify(bad)), [{ label: 'Code missing', tone: 'bad', title: SENTENCE }]);
  const { lineTags } = loadTsx('frontend/src/features/dev-board/workshop/work-row.tsx');
  assert.equal(lineTags(brief, card).ranked[0].label, 'Code missing', 'first on the row: what is wrong leads');
});

test('the change\'s page: the notice above Votes and Testing, in the project page\'s amber', () => {
  const AppView = makeAppView();
  const pr = PR();
  const card = AppView._proposalCardModel(pr);
  const view = AppView._changeThreadView('proposal', pr, card, { hero: { author: 'someone' } });
  assert.equal(view.codeMissing, true);
  assert.equal(AppView._changeThreadView('proposal', PR({ code_missing: false }), card, { hero: {} }).codeMissing, false);
  assert.equal(AppView._changeThreadView('proposal', PR({ status: 'merged' }), card, { hero: {} }).codeMissing, false);
  // The Votes card does not promise it goes live once tested.
  const reached = AppView._changeVotesView(PR({ yes_count: 2, check_state: 'pending' }), null);
  assert.doesNotMatch(reached.note.join(' '), /once/i);

  const head = 'frontend/src/features/dev-board/topic/change-head.tsx';
  const notice = renderComponent(head, 'CodeMissingNotice', {});
  assert.equal(notice,
    `<div data-change-code-missing="" class="rounded-lg border border-amber-500/40 bg-amber-500/10 text-sm text-amber-800 dark:text-amber-300 px-3 py-2 mt-3"><span>${SENTENCE}</span></div>`);
  // The same notice the project page draws for paused code changes.
  const frame = read('frontend', 'src', 'features', 'dev-board', 'board-frame.tsx');
  assert.match(frame, /<Alert variant="notice" density="compact" data-code-pause="github">/);
  const src = read(head);
  assert.match(src, /\{v\.codeMissing \? <CodeMissingNotice \/> : null\}\s*<div ref=\{pair\} className="dev-change-pair">/,
    'above the Votes and Testing cards, which stay as they are');
});

test('Needs you: "Code missing" on the facts line, never "your yes puts it live"; the Communities feed carries it', () => {
  const { factsFor } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
  const row = (extra = {}) => ({
    t: 'card', key: 'vote:proposal:7', kind: 'vote', ask: 'Should this change go in?',
    card: { key: 'proposal:7', attrs: { 'data-proposal-row': '7' }, title: { text: 'Change 7', title: '' },
      pill: { state: { yes: 1, majority: 2, key: 'needs_vote', label: 'Vote · 1/2', plainVote: true } }, badges: [], chatCount: null,
      rail: { menuKey: '', preview: null }, actionPreview: null },
    yes: { label: 'Yes', act: { fn: 'castVote', args: [7, 'yes'] } }, no: { label: 'No', act: { fn: 'castVote', args: [7, 'no'] } },
    askAbout: { kind: 'proposal', ref: 7 }, ...extra,
  });
  const facts = factsFor(row({ codeMissing: true, lastYes: true }), null);
  assert.deepEqual(facts.find((f) => f.key === 'code_missing'), {
    key: 'code_missing', tone: 'blocked', text: 'Code missing', title: SENTENCE,
  });
  assert.equal(facts.some((f) => f.key === 'last'), false, 'its Yes puts nothing live');
  assert.ok(facts.find((f) => f.key === 'tally'), 'the count stays: the vote is recorded');
  assert.equal(factsFor(row(), null).some((f) => f.key === 'code_missing'), false);
  assert.match(read('frontend', 'src', 'features', 'dev-board', 'workshop', 'workshop.tsx'),
    /\{vote\.map\(\(f\) => <span key=\{f\.key\} className=\{factTone\(f\.tone\)\} title=\{f\.title\}>\{f\.text\}<\/span>\)\}/,
    'the fact carries its tooltip');

  // A project's own Needs you: the queue row carries it from the board row.
  assert.match(APP_VIEW_SRC, /\.\.\.\(x\.kind === 'proposal' && AppView\._codeMissing\(x\.item\) \? \{ codeMissing: true \} : \{\}\),/);
  // The Communities screen's: from the feed's item.
  const { reelRows } = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
  const base = {
    kind: 'proposal', id: 7, title: 'A change', summary: null, author: 'ada', number: 700, epoch: 1,
    at: null, yes: 1, no: 0, app: { slug: 'demo', name: 'Demo', icon_url: null, icon_emoji: null },
  };
  assert.equal(reelRows([{ ...base, codeMissing: true }])[0].codeMissing, true);
  assert.equal('codeMissing' in reelRows([base])[0], false);
  assert.equal('codeMissing' in reelRows([{ ...base, kind: 'governance', codeMissing: true }])[0], false);
});
