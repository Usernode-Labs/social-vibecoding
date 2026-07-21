// Rendering tests for the "In progress" status feature (app-view.js):
//
//   1. issueChipsHtml — the reverse "#N" chip helper (sanitize / dedupe /
//      sort, in-app navigation, no pr_url requirement).
//   2. _inProgressChipHtml / _issueInProgress — the issue-card chip's
//      label, tooltip, clickable-vs-informational variants.
//   3. _renderIssueRow — chip placement, the Mark/Clear-in-progress claim
//      button, and the topic-view admin claim list.
//   4. Session cards + proposal cards — reverse chips (live proposals go
//      in-app; merged cards keep external GitHub links).
//   5. _bucketDevItems — kanban routing of in-progress issues.
//
// Same harness as tests/archive-proposal-card.test.js: app-view.js is a
// plain browser script, loaded into a vm sandbox with its external
// globals stubbed; assertions run on the returned HTML strings / pure
// bucketing output.
//
// Run with: node --test tests/issue-inprogress-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView(opts) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: {
      user: { id: 42, username: 'me', canAdminWrite: !!(opts && opts.admin) },
      switchTab: () => {},
    },
    Kudos: { renderButton: () => '', attach: () => {} },
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
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView._ghIssuesMeta = { myRemaining: 5 };
  AppView._govProposals = [];
  // AppView.readOnly is a getter over appData.can_collaborate (#621).
  AppView.appData = { slug: 'demo', can_collaborate: !(opts && opts.readOnly) };
  return AppView;
}

const baseIssue = (over) => ({
  number: 3, title: 'Fix the thing', body: '', htmlUrl: 'https://github.com/o/r/issues/3',
  bounty_count: 0, my_bounty: false, created_by_username: 'someone',
  headless: null, in_progress: null, myPrSessionId: null,
  chatCount: 0, lastMessageAt: null, title_fallback: false,
  priority: null, assignee: null, category: null,
  ...over,
});

// ── 1. issueChipsHtml ────────────────────────────────────────────────────

test('issueChipsHtml sanitizes, dedupes, sorts, and navigates in-app', () => {
  const AppView = makeAppView();
  const html = AppView.issueChipsHtml([9, '2', 9, -1, 'junk', 2.5, 4]);
  // Sorted ascending, deduped, junk dropped.
  const order = [...html.matchAll(/data-issue-chip="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [2, 4, 9]);
  // Chips are in-app buttons (openTopic), never external links.
  assert.match(html, /onclick="AppView\.openTopic\('issue', 2\)"/);
  assert.ok(!html.includes('<a '), 'no external anchors');
  // Empty / invalid input renders nothing.
  assert.equal(AppView.issueChipsHtml([]), '');
  assert.equal(AppView.issueChipsHtml(null), '');
  assert.equal(AppView.issueChipsHtml(['x', -3]), '');
  // Optional label prefix (the proposal card's "Closes #N" wording).
  assert.match(AppView.issueChipsHtml([5], { label: 'Closes' }), /Closes #5/);
});

// ── 2. the "In progress" chip ────────────────────────────────────────────

test('_issueInProgress ORs sessions/claims with live headless state', () => {
  const AppView = makeAppView();
  assert.equal(AppView._issueInProgress(baseIssue()), false);
  assert.equal(AppView._issueInProgress(baseIssue({
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: null },
  })), true);
  assert.equal(AppView._issueInProgress(baseIssue({ headless: { status: 'generating' } })), true);
  assert.equal(AppView._issueInProgress(baseIssue({ headless: { status: 'ready' } })), true);
  assert.equal(AppView._issueInProgress(baseIssue({ headless: { status: 'failed' } })), false);
});

test('chip label: single person by name, viewer as "you", several as a count', () => {
  const AppView = makeAppView();
  const chip = (ip) => AppView._inProgressChipHtml(baseIssue({ in_progress: ip }));

  assert.match(chip({ count: 1, users: ['maya'], mine: false, claims: [], target: null }),
    /In progress · maya/);
  assert.match(chip({ count: 1, users: ['me'], mine: true, claims: [], target: null }),
    /In progress · you/);
  // Distinct people across sessions AND claims are counted, deduped.
  assert.match(chip({
    count: 1, users: ['maya'], mine: false,
    claims: [{ username: 'bob', mine: false }], target: null,
  }), /In progress · 2/);
  assert.match(chip({
    count: 1, users: ['maya'], mine: false,
    claims: [{ username: 'maya', mine: false }], target: null,
  }), /In progress · maya/, 'same person claiming AND working counts once');
});

test('chip is a button when a target exists, a plain span otherwise', () => {
  const AppView = makeAppView();
  const linked = AppView._inProgressChipHtml(baseIssue({
    in_progress: {
      count: 1, users: ['maya'], mine: false, claims: [],
      target: { kind: 'proposal', sessionId: 88 },
    },
  }));
  assert.match(linked, /<button/);
  assert.match(linked, /AppView\.openInProgressTarget\('proposal', 88\)/);

  const plain = AppView._inProgressChipHtml(baseIssue({
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: null },
  }));
  assert.match(plain, /<span/);
  assert.ok(!plain.includes('openInProgressTarget'));

  // Headless-only status renders the informational chip (its row's own
  // auto-solve buttons navigate).
  const headlessOnly = AppView._inProgressChipHtml(baseIssue({
    headless: { status: 'generating' },
  }));
  assert.match(headlessOnly, /<span/);
  assert.match(headlessOnly, /In progress/);
  assert.match(headlessOnly, /auto-solve/i);
});

test('openInProgressTarget dispatches to the existing navigation handlers', () => {
  const AppView = makeAppView();
  const calls = [];
  AppView.openTopic = (kind, id) => calls.push(['topic', kind, id]);
  AppView.openInProgressTarget('proposal', 5);
  AppView.openInProgressTarget('session-shared', 6);
  assert.deepEqual(calls, [['topic', 'proposal', 5], ['topic', 'session', 6]]);
  // A session-own target goes through App.switchTab, not openTopic.
  AppView.openInProgressTarget('session-own', 7);
  assert.equal(calls.length, 2, 'own sessions never open a topic');
  // Bad input is a no-op.
  AppView.openInProgressTarget('proposal', 'junk');
  assert.equal(calls.length, 2);
});

// ── 3. the issue row: chip + claim button + admin list ──────────────────

test('issue row renders the chip and a "Mark in progress" button when the viewer holds no claim', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow(baseIssue({
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: null },
  }));
  assert.match(html, /In progress · maya/);
  assert.match(html, /Mark in progress/);
  assert.match(html, /AppView\.markIssueInProgress\(3\)/);
  assert.ok(!html.includes('Clear in progress'));
});

test('issue row swaps to "Clear in progress" when the viewer holds a claim', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow(baseIssue({
    in_progress: {
      count: 0, users: [], mine: true,
      claims: [{ username: 'me', userId: 42, mine: true }], target: null,
    },
  }));
  assert.match(html, /Clear in progress/);
  assert.match(html, /AppView\.clearIssueClaim\(3\)/);
  assert.ok(!html.includes('Mark in progress'));
});

test('other users\' claims never block the viewer\'s own Mark button', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow(baseIssue({
    in_progress: {
      count: 0, users: [], mine: false,
      claims: [{ username: 'maya', userId: 8, mine: false }], target: null,
    },
  }));
  assert.match(html, /Mark in progress/);
});

test('read-only viewers see the chip but no action buttons', () => {
  const AppView = makeAppView({ readOnly: true });
  const html = AppView._renderIssueRow(baseIssue({
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: null },
  }));
  assert.match(html, /In progress · maya/);
  assert.ok(!html.includes('Mark in progress'));
});

test('admin claim list renders in the topic view (noNav) only, for write-admins only', () => {
  const withClaims = {
    in_progress: {
      count: 0, users: [], mine: false,
      claims: [{ username: 'maya', userId: 8, mine: false }], target: null,
    },
  };
  const admin = makeAppView({ admin: true });
  const topicHtml = admin._renderIssueRow(baseIssue(withClaims), { noNav: true });
  assert.match(topicHtml, /In-progress claims:/);
  assert.match(topicHtml, /AppView\.clearIssueClaim\(3, 8\)/);
  // Feed variant: no admin list even for admins.
  const feedHtml = admin._renderIssueRow(baseIssue(withClaims));
  assert.ok(!feedHtml.includes('In-progress claims:'));
  // Non-admin topic view: no list.
  const user = makeAppView();
  const userTopic = user._renderIssueRow(baseIssue(withClaims), { noNav: true });
  assert.ok(!userTopic.includes('In-progress claims:'));
});

// ── 4. reverse chips on session + proposal cards ─────────────────────────

const baseSession = (over) => ({
  id: 12, session_title: 'My session', pr_title: null, branch_name: 'dev/x',
  status: 'active', pr_number: null, staging_url: null, shared_at: null,
  linked_issues: [], busy: false, chat_count: 0,
  ...over,
});

test('own session card renders "#N" chips from linked_issues', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(baseSession({ linked_issues: [7, 4] }));
  const order = [...html.matchAll(/data-issue-chip="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [4, 7]);
  // No chips when the session links nothing.
  const empty = AppView._renderMySessionCard(baseSession());
  assert.ok(!empty.includes('data-issue-chip'));
});

test('shared session card renders "#N" chips from linked_issues', () => {
  const AppView = makeAppView();
  const html = AppView._renderSharedSessionCard(baseSession({
    username: 'maya', linked_issues: [11], can_preview: false,
  }));
  assert.match(html, /data-issue-chip="11"/);
});

const baseProposal = (over) => ({
  id: 9, pr_number: 900, pr_title: 'A change', username: 'maya', user_id: 8,
  status: 'promoted', pr_url: 'https://github.com/o/r/pull/900',
  linked_issues: [6], chat_count: 0, created_at: '2026-06-12T00:00:00Z',
  visuals: null, my_vote: null,
  ...over,
});

test('LIVE proposal card links "Closes #N" to the in-app issue topic', () => {
  const AppView = makeAppView();
  const html = AppView._renderProposalCard(baseProposal());
  assert.match(html, /data-issue-chip="6"/);
  assert.match(html, /Closes #6/);
  assert.match(html, /AppView\.openTopic\('issue', 6\)/);
  assert.ok(!html.includes('github.com/o/r/issues/6'), 'no external issue link on live cards');
});

test('MERGED proposal card keeps the external GitHub "Closed #N" links', () => {
  const AppView = makeAppView();
  const html = AppView._renderProposalCard(baseProposal({ status: 'merged' }));
  assert.ok(!html.includes('data-issue-chip'), 'merged cards do not use in-app chips');
  assert.match(html, /github\.com\/o\/r\/issues\/6/);
  assert.match(html, /Closed #6/);
});

// ── 5. kanban routing ────────────────────────────────────────────────────

test('_bucketDevItems routes in-progress issues (sessions, claims, headless) to the In-progress column', () => {
  const AppView = makeAppView();
  const plain = baseIssue({ number: 1 });
  const viaSessions = baseIssue({
    number: 2,
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: null },
  });
  const viaClaim = baseIssue({
    number: 3,
    in_progress: { count: 0, users: [], mine: false, claims: [{ username: 'bob', userId: 5, mine: false }], target: null },
  });
  const viaHeadless = baseIssue({ number: 4, headless: { status: 'generating' } });
  const behindProposal = baseIssue({
    number: 5,
    in_progress: { count: 1, users: ['maya'], mine: false, claims: [], target: { kind: 'proposal', sessionId: 77 } },
  });

  const buckets = AppView._bucketDevItems({
    issues: [plain, viaSessions, viaClaim, viaHeadless, behindProposal],
    proposals: [{ id: 77, status: 'promoted', linked_issues: [5] }],
    gov: [], merged: [], mySessions: [], sharedSessions: [],
  });

  // Array.from re-realms the vm-created arrays — deepEqual under
  // assert/strict compares prototypes, and cross-realm Array fails it.
  assert.deepEqual(Array.from(buckets.issues, (i) => i.number), [1], 'only the plain issue stays');
  const inProgressNums = Array.from(buckets.inProgress)
    .filter((x) => x.kind === 'issue')
    .map((x) => x.item.number)
    .sort((a, b) => a - b);
  assert.deepEqual(inProgressNums, [2, 3, 4]);
  // The issue represented by a promoted proposal card stays hidden from
  // both issue columns (it lives in In review as the proposal).
  assert.ok(!buckets.inProgress.some((x) => x.kind === 'issue' && x.item.number === 5));
});
