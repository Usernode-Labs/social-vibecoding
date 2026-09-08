// The Board's columns fold their cards (#1787).
//
// The four kanban columns drew every card at full size — head, meta line,
// status band, action band, ⋯ — which is what made a busy board busy. They
// draw the Workshop's one-line row now and unfold the one you tap into the
// dense card, in place, through the same fold the Workshop uses
// (frontend/src/features/dev-board/card/fold.tsx). This file pins:
//
//   * every card row renders folded, carrying the item's data-*-row hook;
//   * `?cards=open` renders every card at full size, hooks intact — the
//     board as it was, and the state the checks that read a card's anatomy
//     run in;
//   * the column owns which card is open, one per column;
//   * the delegated #dev-body open handler stands aside inside a fold;
//   * `?shot=board-unfold` taps the first folded row for the capture;
//   * the declared checks that reach into a board card's anatomy carry
//     `cards=open`, and two pin the fold itself.
//
// Run with: node --test tests/dev-board-fold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { kanbanHtml } = require('./lib/dev-card-html');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_VIEW_SRC = read('public/js/app-view.js');
const KANBAN = read('frontend/src/features/dev-board/card/dev-kanban.tsx');
const LIST_ROWS = read('frontend/src/features/dev-board/card/list-rows.tsx');
const FOLD = read('frontend/src/features/dev-board/card/fold.tsx');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const CSS = read('public/css/app.css');
const DAPP = JSON.parse(read('dapp.json'));

const at = (d) => new Date(Date.now() - d * 86400000).toISOString();

// app-view.js in a vm, with a `location` the board's URL states are read
// from. Same shape as tests/dev-kanban-buckets.test.js's sandbox.
function makeAppView({ search = '' } = {}) {
  const sandbox = {
    console, relTime: () => '2h ago',
    escapeHtml: (s) => String(s == null ? '' : s), escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo-app', currentSubTab: 'forum', _appUrl: () => '#x', switchTab: () => {} },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }), addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search, hash: '', href: `http://localhost/${search}` }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo-app', can_collaborate: true };
  AppView._ghIssues = [
    { number: 1575, title: 'Replace the oversized Game Corner header with bottom tabs', createdAt: at(4), updatedAt: at(2), lastMessageAt: at(2), user: 'sam', htmlUrl: 'x', assignee: { top: 'priya' } },
    { number: 1574, title: 'Cut the Game Corner header’s self-explanation', createdAt: at(4), updatedAt: at(3), lastMessageAt: null, user: 'sam', htmlUrl: 'x' },
  ];
  AppView._proposals = [{
    id: 34, pr_number: 1540, pr_title: 'Rewrite the email-confirmation email around one clear CTA',
    pr_url: 'https://github.com/acme/app/pull/1540',
    status: 'promoted', username: 'evan', created_at: at(1), promoted_at: at(1), last_message_at: at(1),
    linked_issues: [], my_vote: null, votes_for: 3, votes_against: 1, yes_count: 3, no_count: 1,
    checks_state: 'success', checks_total: 412, checks_passed: 412, message_count: 5,
  }];
  AppView._govProposals = [];
  AppView._merged = [{
    id: 78, pr_number: 1572, pr_title: 'Add screen transitions to Game Corner', status: 'merged',
    username: 'alice', created_at: at(2), merged_at: at(2), last_message_at: at(2), row_type: 'pr',
  }];
  AppView._mergedCtx = { majority: 2, activeUsers: 7 };
  AppView._mergedTotal = 1; AppView._mergedHasMore = false;
  AppView._mySessions = []; AppView._sharedSessions = []; AppView._devDataReady = true;
  return AppView;
}

const cardRowsOf = (view) => view.cols.reduce((n, c) => n + c.rows.filter((r) => r.t === 'card').length, 0);
const count = (html, re) => (html.match(re) || []).length;

test('every board card draws folded: one row per card, no card face, the item’s hook on the row', () => {
  const AppView = makeAppView();
  const view = AppView._kanbanView();
  const cards = cardRowsOf(view);
  assert.ok(cards >= 4, `the fixture fills the columns (${cards})`);
  assert.equal(view.unfolded, false);

  const html = kanbanHtml(AppView);
  assert.equal(count(html, /class="dev-ws-rowwrap"/g), cards, 'one fold wrapper per card');
  assert.equal(count(html, /class="dev-ws-rowwrap dev-ws-rowwrap-open"/g), 0, 'and none of them open');
  assert.ok(!html.includes('gc-vote-item'), 'no card face is drawn while everything is folded');
  assert.equal(count(html, /class="dev-ws-row hover:bg-zinc-50 dark:hover:bg-zinc-800"[^>]*aria-expanded="false"/g), cards,
    'each row is a closed disclosure wearing the card’s own hover');
  // The hooks the checks and the lookups name an item by ride on the row.
  assert.match(html, /class="dev-ws-row[^"]*"[^>]*data-ws-row="issue:1575"[^>]*data-issue-row="1575"/);
  assert.match(html, /class="dev-ws-row[^"]*"[^>]*data-ws-row="proposal:34"[^>]*data-proposal-row="34"/);
  // And the row keeps the card's edge and number, as on the Workshop.
  assert.match(html, /class="dev-ws-row[^"]*"[^>]*data-edge="[a-z]+"[^>]*data-ws-row="issue:1575"/);
  assert.match(html, /<span class="font-mono">#1575<\/span>/);
  assert.match(html, /<span class="font-mono">PR#1540<\/span>/);
  // The proposal's vote rides on its row, as the Workshop's rows carry it.
  assert.match(html, /data-ws-row="proposal:34"[\s\S]*?<span class="dev-ws-row-trailing"><button [^>]*class="dev-vote-btn"/);
});

test('?cards=open draws every card at full size, hooks intact: the board as it was', () => {
  const AppView = makeAppView({ search: '?cards=open&demo=1' });
  const view = AppView._kanbanView();
  assert.equal(view.unfolded, true);
  const cards = cardRowsOf(view);

  const html = kanbanHtml(AppView);
  assert.equal(count(html, /class="dev-ws-rowwrap dev-ws-rowwrap-open"/g), cards, 'every wrapper open');
  assert.equal(count(html, /class="dev-ws-row hover/g), 0, 'and no folded row drawn beside a card');
  assert.equal(count(html, /class="gc-vote-item [^"]*dev-card-dense"/g), cards, 'the dense card, once per item');
  assert.equal(count(html, /class="gc-vote-btn dev-ws-open-btn"/g), cards, 'each with its Open card toggle');
  // The open card is a DIRECT child of the sheet, which is a direct child of
  // the wrapper — the declared unfold check selects it that way.
  assert.match(html, /class="dev-ws-rowwrap dev-ws-rowwrap-open"><div class="dev-feed-entry dev-ws-sheet"[^>]*><div class="gc-vote-item [^"]*dev-card-dense"/);
  // The card keeps its hooks: the checks that read a card's anatomy name the
  // item by them, and nothing strips them any more.
  assert.match(html, /class="gc-vote-item [^"]*dev-card-dense"[^>]*data-issue-row="1575"/);
  assert.match(html, /class="gc-vote-item [^"]*dev-card-dense"[^>]*data-proposal-row="34"/);
  // The way out to the item's own page.
  assert.match(html, /<a href="#app\/demo-app\/dev\/issues\/1575" class="dev-ws-link">Open on its own page ›<\/a>/);
  assert.match(html, /<a href="#app\/demo-app\/dev\/proposals\/34" class="dev-ws-link">/);
});

test('the view carries what the open card needs, and reads ?cards=open per build', () => {
  const AppView = makeAppView();
  const v = AppView._kanbanView();
  assert.equal(v.slug, 'demo-app');
  assert.equal(v.canPost, true);
  assert.equal(v.unfolded, false);
  assert.equal(AppView._cardsOpen(), false);
  // A sandbox with no location at all answers false rather than throwing —
  // the other board tests' sandboxes have none.
  const bare = makeAppView();
  bare._cardsOpen = AppView._cardsOpen;
  assert.equal(typeof bare._cardsOpen(), 'boolean');
});

test('the column owns which card is open, one per column, through the shared fold', () => {
  // State in the component, not the view model: the WS-driven republishes
  // that repaint the board must not fold what somebody has open.
  assert.match(KANBAN, /const \[openKey, setOpenKey\] = useState<string \| null>\(null\);/);
  assert.match(KANBAN, /open: unfolded \|\| openKey === row\.key,/);
  assert.match(KANBAN, /onToggle: \(\) => setOpenKey\(\(k\) => \(k === row\.key \? null : row\.key\)\),/);
  assert.match(KANBAN, /slug=\{v\.slug \|\| ''\}/);
  assert.match(KANBAN, /unfolded=\{!!v\.unfolded\}/);
  // A merged card's kudos slot is legacy-filled after every publish; a fold
  // happens between publishes, so the column re-runs the filler.
  assert.match(KANBAN, /callAppView\('_fillKudosHosts', hostRef\.current\)/);
  // The row renderer hands a card to the fold when it is given one, and
  // draws the plain card otherwise.
  assert.match(LIST_ROWS, /<CardRowView row=\{row\} slug=\{fold\.slug\} canPost=\{fold\.canPost\} open=\{fold\.open\} onToggle=\{fold\.onToggle\} \/>/);
  assert.match(LIST_ROWS, /: <DevCard model=\{row\.card\} \/>/);
  // And the Workshop draws its rows from the SAME module — no second copy.
  assert.match(WORKSHOP, /import \{ CardRowView, callAppView \} from '\.\.\/card\/fold';/);
  for (const fn of ['function FoldedRow', 'function UnfoldedRow', 'function CardRowView', 'function RowBand']) {
    assert.ok(FOLD.includes(fn), `${fn} lives in fold.tsx`);
    assert.ok(!WORKSHOP.includes(fn), `${fn} is not also in workshop.tsx`);
  }
});

test('the delegated #dev-body open handler leaves a fold’s clicks and keys to the fold', () => {
  const click = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf("if (e.target.closest('a, button, input, form')) return;"));
  const guard = click.indexOf("if (e.target.closest('.dev-ws-rowwrap')) return;");
  assert.ok(guard > 0, 'the click handler checks for the wrapper');
  assert.ok(guard < click.indexOf("e.target.closest('[data-session-chip]')"),
    'before it reads any of the item hooks, which both sizes now carry');
  assert.match(APP_VIEW_SRC, /if \(ev\.target\.closest && ev\.target\.closest\('\.dev-ws-rowwrap'\)\) return;/,
    'and the keydown handler, which would otherwise open a session on the Enter that toggles its row');
  // The folded row carries the hooks, so a lookup by hook finds it either way.
  assert.match(FOLD, /const ITEM_HOOKS = \[\s*'data-issue-row', 'data-proposal-row', 'data-gov-row',\s*'data-shared-session-row', 'data-session-chip', 'data-discussion-row',\s*\];/);
  assert.match(FOLD, /\{\.\.\.itemHooks\(c\)\}/);
});

test('?shot=board-unfold taps the first folded row, through the real event path', () => {
  const from = APP_VIEW_SRC.indexOf("if (shot === 'board-unfold') {");
  assert.ok(from > 0);
  const block = APP_VIEW_SRC.slice(from, APP_VIEW_SRC.indexOf("if (shot === 'feed-comments') {", from));
  assert.match(block, /document\.querySelector\('#dev-kanban \.dev-ws-rowwrap-open'\)/, 'stops once a card is up');
  assert.match(block, /const row = document\.querySelector\('#dev-kanban \.dev-ws-row'\);/);
  assert.match(block, /if \(row\) row\.click\(\);/, 'a click, not a state poke: the fold’s own handler must take it');
  assert.match(block, /if \(!e \|\| e\.isTrusted\) done\(\);/, 'a human’s first real gesture ends the window');
  assert.match(block, /\(tries \+= 1\) > 40/, 'and it is capped');
});

test('the declared checks that read a board card’s anatomy run with the cards open; two pin the fold', () => {
  const anatomy = /gc-vote-item|dev-card-|gc-card-actions|data-card-menu|attr-chip|dc-status-spinner|gc-merging-badge|gc-checks-running-badge|dev-badge|dev-status-pill|dev-chat-badge|dev-vote-btn/;
  const board = /#app\/usernode-2d5619\/board|view=kanban|col=(issues|inprogress|inreview|done)/;
  const offenders = [];
  let moved = 0;
  for (const t of DAPP.tests) {
    const p = t.path || '';
    const sel = t.expectSelector || '';
    if (/workshop/.test(p) || /#gc-thread-head/.test(sel) || /\/(governance|issues|proposals)\//.test(p)) continue;
    if (!board.test(p) || !anatomy.test(sel)) continue;
    // A check that selects the folded row, or taps one open, is about the
    // fold itself and runs in the default state on purpose.
    if (/dev-ws-row\b/.test(sel) || /shot=board-unfold/.test(p)) continue;
    if (!/[?&]cards=open(&|#|$)/.test(p)) offenders.push(t.name);
    else moved += 1;
  }
  assert.deepEqual(offenders, [], 'a check that reaches into a board card must ask for the cards open');
  assert.ok(moved >= 20, `and a good number do (${moved})`);

  const folded = DAPP.tests.find((t) => t.name === '#app/<slug>/board is the card area as a kanban, its cards folded to rows');
  assert.ok(folded, 'the board route check pins the fold');
  assert.equal(folded.path, '/?demo=1#app/usernode-2d5619/board', 'with no cards=open: this IS the default');
  assert.match(folded.expectSelector, /#dev-kanban-board #dev-kanban \.dev-kanban-col \.dev-ws-rowwrap > \.dev-ws-row\[role="button"\]\[aria-expanded="false"\]\[data-issue-row\]/);

  const unfold = DAPP.tests.find((t) => /shot=board-unfold/.test(t.path || ''));
  assert.ok(unfold, 'one check taps a row open');
  assert.match(unfold.expectSelector, /\.dev-ws-rowwrap-open > \.dev-ws-sheet > \.gc-vote-item\.dev-card-dense\[data-edge\] \.dev-card-status-end > \.dev-ws-open-btn\[aria-expanded="false"\]/,
    'and reads the card it unfolded into, with its Open card toggle');
  assert.ok(!/cards=open/.test(unfold.path), 'without cards=open, or the tap would prove nothing');

  // The ⋯ menu capture needs a card up to have a trigger to tap.
  const menu = DAPP.tests.find((t) => /shot=card-menu/.test(t.path || '') && /#dev-kanban/.test(t.expectSelector || ''));
  assert.ok(menu && /cards=open/.test(menu.path), 'the card-menu shot runs with the cards open');
  // The manifest did not grow: the fold is pinned by extending two checks.
  assert.equal(DAPP.tests.length, 560);
});

test('the board’s fold rules: the column’s rhythm, not the wrapper’s, and a bare sheet', () => {
  assert.match(CSS, /#dev-kanban \.dev-ws-rowwrap \{ margin-bottom: 0; \}/);
  assert.match(CSS, /#dev-kanban \.dev-ws-sheet-actions \{/);
  // The Workshop's frosted sheet stays the Workshop's: on the board the open
  // card is the column's tile, as it always was.
  assert.ok(!/#dev-kanban \.dev-feed-entry \{/.test(CSS));
  assert.match(CSS, /#dev-workshop \.dev-feed-entry \{/);
});
