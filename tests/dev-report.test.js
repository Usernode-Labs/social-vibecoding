// #1100 — the Reporting view mode for the dev board.
//
// AppView._buildReportModel() folds the cached dev data into a progress
// report split into Done / In progress / Backlog, and
// AppView._renderReportHtml() turns that model into either a fragment for
// #dev-report or a self-contained downloadable document.
//
// Both are pure (data in → plain object / string out; no DOM, no AppView
// state reads), so — exactly like tests/dev-kanban-buckets.test.js and
// tests/dev-pm-groups.test.js — we load app-view.js into a vm context and
// call them directly with synthetic rows.
//
// The three properties worth locking in beyond the mapping itself:
//
//   * The three sections are MUTUALLY EXCLUSIVE. The model delegates
//     classification to _bucketDevItems, which routes in-progress issues
//     away from the plain issue column. Issues an open proposal closes are
//     the one case the model handles ITSELF (#1251): the board shows such
//     an issue in its In progress column, because a column is somewhere you
//     go looking for your issue, but a report read top to bottom would
//     print the same work twice and inflate its counts.
//   * The report markup carries NONE of the delegated-click hooks
//     (data-issue-row / data-proposal-row / data-gov-row /
//     data-session-chip). #dev-body's delegated handler fires card actions
//     off exactly those, so emitting one would make a report line a live
//     control in a document that is supposed to be read-only.
//   * The view-mode helpers accept 'report' and still reject junk.
//
// Run with: node --test tests/dev-report.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// Minimal sandbox with app-view.js loaded. `over` can supply a custom
// localStorage / URL search so the view-mode helpers can be exercised too.
function makeCtx(over) {
  const o = over || {};
  const sandbox = {
    matchMedia: o.matchMedia,
    console,
    relTime: () => 'just now',
    // The report's own escaping is what we assert on, so give the sandbox
    // the real thing rather than the identity stubs the other dev tests use.
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    escapeAttr: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    App: { user: { id: 1 }, currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      documentElement: { classList: { contains: () => false } },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    location: { search: o.search || '' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: o.localStorage || { getItem: () => null, setItem: () => {} },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox;
}

function makeAppView(over) {
  return makeCtx(over).__AppView;
}

// A fixed "now" so the month grouping and the 30-day counter are
// deterministic. 2026-08-11T12:00:00Z.
const NOW = Date.parse('2026-08-11T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// `pri` / `asg` / `cat` are the top-voted attribute VALUES — deliberately
// named apart from the `priority` / `assignee` / `category` row fields they
// build, because `...over` is spread last and would otherwise clobber the
// {top, count} objects with a bare string.
const issue = (over) => ({
  number: over.number,
  title: over.title || `Issue ${over.number}`,
  htmlUrl: `https://github.com/acme/app/issues/${over.number}`,
  updatedAt: over.updatedAt || daysAgo(1),
  lastMessageAt: over.updatedAt || daysAgo(1),
  headless: null,
  in_progress: null,
  chatCount: over.chatCount || 0,
  ...over,
  priority: over.pri === undefined ? null : { top: over.pri, count: 1 },
  assignee: over.asg === undefined ? null : { top: over.asg, count: 1 },
  category: over.cat === undefined ? null : { top: over.cat, count: 1 },
});

const prop = (over) => ({
  id: over.id, pr_number: over.pr_number != null ? over.pr_number : over.id * 10,
  pr_title: over.pr_title || `Proposal ${over.id}`,
  username: over.username || 'alice', user_id: 1,
  status: over.status || 'promoted', linked_issues: over.linked_issues || [],
  yes_count: over.yes_count != null ? over.yes_count : 2,
  no_count: over.no_count != null ? over.no_count : 0,
  votes_required: over.votes_required != null ? over.votes_required : 3,
  created_at: over.created_at || daysAgo(2),
  promoted_at: over.promoted_at || daysAgo(2),
  last_message_at: over.last_message_at || daysAgo(2),
  ...over,
});

const govRow = (over) => ({
  id: over.id, kind: over.kind || 'rename',
  title: over.title || null, payload: over.payload || null,
  created_by_username: over.created_by_username || 'bob',
  github_issue_number: over.github_issue_number != null ? over.github_issue_number : null,
  yes_count: 1, no_count: 0, votes_required: 3,
  created_at: daysAgo(1), last_message_at: daysAgo(1),
  ...over,
});

const mergedRow = (over) => ({
  id: over.id, row_type: over.row_type || 'pr',
  pr_number: over.pr_number != null ? over.pr_number : over.id * 10,
  pr_title: over.pr_title || `Merged ${over.id}`,
  username: over.username || 'carol',
  yes_count: 3, no_count: 1, votes_required: 3,
  created_at: over.created_at || daysAgo(3),
  last_message_at: over.created_at || daysAgo(3),
  ...over,
});

const session = (over) => ({
  id: over.id,
  session_title: over.session_title || `Session ${over.id}`,
  username: over.username || 'dave',
  busy: !!over.busy,
  last_activity_at: over.last_activity_at || daysAgo(0),
  created_at: over.created_at || daysAgo(1),
  shared_at: over.shared_at || daysAgo(1),
  chat_count: 0,
  ...over,
});

const build = (AppView, data) => AppView._buildReportModel(
  { app: { name: 'Acme', slug: 'acme', url: 'https://acme.test', repoUrl: 'https://github.com/acme/app' }, ...data },
  { now: NOW }
);

// Titles/labels pulled across the vm realm boundary as plain strings.
// Everything the assertions touch must be rebuilt with a host-realm Array:
// arrays the sandbox produced have the sandbox's Array prototype, and
// assert.deepEqual rejects them as "not reference-equal".
const titles = (arr) => Array.from(arr || [], (e) => e.title);
const numbers = (arr) => Array.from(arr || [], (e) => e.number);
const groupNumbers = (groups) =>
  Array.from(groups || []).flatMap((g) => numbers(g.issues));

test('maps each data source into its own report section', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    issues: [
      issue({ number: 1, pri: 'high' }),
      issue({ number: 2, in_progress: { users: ['erin'], claims: [] } }),
    ],
    proposals: [prop({ id: 100 })],
    gov: [govRow({ id: 200, kind: 'rename', payload: { newName: 'Acme Two' } })],
    merged: [mergedRow({ id: 300 })],
    mySessions: [session({ id: 400, username: 'me' })],
    sharedSessions: [session({ id: 401, username: 'dave' })],
    mergedTotal: 1,
  });

  assert.deepEqual(titles(m.done.groups[0].entries), ['Merged 300']);
  assert.deepEqual(titles(m.inProgress.review), ['Proposal 100']);
  assert.deepEqual(titles(m.inProgress.gov), ['Acme Two']);
  assert.deepEqual(titles(m.inProgress.sessions).sort(), ['Session 400', 'Session 401']);
  assert.deepEqual(numbers(m.inProgress.issues), [2]);
  // Backlog holds only the issue with no live work.
  assert.deepEqual(groupNumbers(m.backlog.groups), [1]);
});

test('summary counters and the 30-day completed figure', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    issues: [issue({ number: 1 }), issue({ number: 2 })],
    proposals: [prop({ id: 100 }), prop({ id: 101 })],
    gov: [govRow({ id: 200 })],
    merged: [
      mergedRow({ id: 300, created_at: daysAgo(5) }),
      mergedRow({ id: 301, created_at: daysAgo(29) }),
      mergedRow({ id: 302, created_at: daysAgo(200) }),
    ],
    mySessions: [session({ id: 400 })],
    mergedTotal: 3,
  });
  assert.equal(m.summary.completed, 3);
  assert.equal(m.summary.awaitingReview, 3); // 2 proposals + 1 governance
  assert.equal(m.summary.beingWorkedOn, 1);  // 1 session, no in-progress issues
  assert.equal(m.summary.backlog, 2);
  assert.equal(m.summary.completedLast30, 2); // the 200-day-old row is excluded
});

test('no entity appears in two sections', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    // #7 is linked to an open proposal; #8 has a live headless run.
    issues: [
      issue({ number: 7 }),
      issue({ number: 8, headless: { status: 'generating' } }),
      issue({ number: 9 }),
    ],
    proposals: [prop({ id: 100, linked_issues: [7] })],
    merged: [],
    mergedTotal: 0,
  });
  const backlogNums = groupNumbers(m.backlog.groups);
  const workNums = numbers(m.inProgress.issues);
  // #7 is represented once, by its proposal — not in the backlog.
  assert.ok(!backlogNums.includes(7));
  assert.ok(!workNums.includes(7));
  // #8 is under work, and therefore NOT also in the backlog.
  assert.deepEqual(workNums, [8]);
  assert.deepEqual(backlogNums, [9]);
  // No number is in both lists.
  assert.equal(backlogNums.filter((n) => workNums.includes(n)).length, 0);
});

// #1251: the exclusion above is the REPORT's own, not something the
// bucketer does for it. The board deliberately keeps #7 on screen, so a
// future "simplify" that deletes the report's filter would silently start
// printing it under two headings — this pins both halves at once.
test('an issue its proposal closes is on the board but not twice in the report', () => {
  const AppView = makeAppView();
  const issues = [issue({ number: 7 })];
  const proposals = [prop({ id: 100, linked_issues: [7] })];

  const buckets = AppView._bucketDevItems({
    issues, proposals, gov: [], merged: [], mySessions: [], sharedSessions: [],
  });
  const boardIssues = Array.from(buckets.inProgress)
    .filter((e) => e.kind === 'issue')
    .map((e) => e.item.number);
  assert.deepEqual(boardIssues, [7], 'the board keeps it in In progress');

  const m = build(AppView, { issues, proposals, merged: [], mergedTotal: 0 });
  assert.deepEqual(numbers(m.inProgress.issues), [], 'the report does not repeat it');
  assert.equal(m.summary.awaitingReview, 1);
  assert.equal(m.summary.beingWorkedOn, 0, 'and does not double-count it');
});

test('backlog groups by voted priority: high, medium, low, then unset', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    issues: [
      issue({ number: 1 }),                // no priority
      issue({ number: 2, pri: 'low' }),
      issue({ number: 3, pri: 'high' }),
      issue({ number: 4, pri: 'medium' }),
      issue({ number: 5, pri: 'bogus' }),  // unknown → unset bucket
    ],
    merged: [], mergedTotal: 0,
  });
  assert.deepEqual(
    Array.from(m.backlog.groups, (g) => g.key),
    ['high', 'medium', 'low', 'none']
  );
  assert.deepEqual(
    Array.from(m.backlog.groups, (g) => g.label),
    ['High', 'Medium', 'Low', 'No priority set']
  );
  const none = m.backlog.groups.find((g) => g.key === 'none');
  assert.deepEqual(numbers(none.issues).sort((a, b) => a - b), [1, 5]);
  // Empty priority groups are dropped rather than rendered as blank headings.
  const m2 = build(AppView, { issues: [issue({ number: 1, pri: 'high' })], merged: [] });
  assert.deepEqual(Array.from(m2.backlog.groups, (g) => g.key), ['high']);
});

test('Done groups into months, newest month first, dated by created_at', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    merged: [
      mergedRow({ id: 300, created_at: '2026-08-02T10:00:00Z' }),
      mergedRow({ id: 301, created_at: '2026-07-20T10:00:00Z' }),
      mergedRow({ id: 302, created_at: '2026-08-09T10:00:00Z' }),
      mergedRow({ id: 303, created_at: '2026-06-01T10:00:00Z' }),
    ],
    mergedTotal: 4,
  });
  assert.deepEqual(Array.from(m.done.groups, (g) => g.key), ['2026-08', '2026-07', '2026-06']);
  assert.deepEqual(Array.from(m.done.groups, (g) => g.label),
    ['August 2026', 'July 2026', 'June 2026']);
  // Within a month, newest first (_bucketDevItems' own sort).
  assert.deepEqual(titles(m.done.groups[0].entries), ['Merged 302', 'Merged 300']);
  // These fixtures carry no merged_at (legacy rows), so the entries keep
  // the created_at date labelled "Started" — see the #1264 tests below
  // for the merged_at-preferred path.
  assert.equal(m.done.groups[0].entries[0].dateLabel, 'Started');
});

test('applied close-issue rows land in Done, dated by payload.appliedAt', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    merged: [mergedRow({
      id: 5, row_type: 'close_issue', pr_number: null, pr_title: null,
      created_at: '2026-08-01T10:00:00Z',
      created_by_username: 'frank',
      payload: { issueNumber: 42, issueTitle: 'Stale docs', appliedAt: '2026-08-04T09:00:00Z' },
    })],
    mergedTotal: 1,
  });
  const e = m.done.groups[0].entries[0];
  assert.equal(e.kind, 'close-issue');
  assert.equal(e.title, 'Stale docs');
  assert.equal(e.issueNumber, 42);
  assert.equal(e.dateLabel, 'Closed');
  assert.equal(e.atMs, Date.parse('2026-08-04T09:00:00Z'));
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /Issue .*#42.*closed by vote/);
});

test('truncation flags produce the disclosure lines', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    merged: [mergedRow({ id: 300 })],
    mergedTotal: 812,
    mergedTruncated: true,
    issuesTruncated: true,
    issues: [issue({ number: 1 })],
  });
  assert.equal(m.done.truncated, true);
  assert.equal(m.done.total, 812);
  assert.equal(m.done.shown, 1);
  assert.equal(m.backlog.truncatedList, true);
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /Showing the 1 most recent of 812 completed items\./);
  assert.match(html, /GitHub returned more open issues than the platform fetches/);
  assert.match(html, /full issue list/);
});

test('a failed pager reports partial history rather than under-claiming', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    merged: [mergedRow({ id: 300 })], mergedTotal: 1, mergedPartial: true,
  });
  assert.equal(m.done.partial, true);
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /full history could not be loaded/);
});

test('empty input yields every empty state and no crash', () => {
  const AppView = makeAppView();
  const m = build(AppView, {});
  assert.equal(m.done.empty, true);
  assert.equal(m.inProgress.empty, true);
  assert.equal(m.inProgress.emptyAwaiting, true);
  assert.equal(m.inProgress.emptyWork, true);
  assert.equal(m.backlog.empty, true);
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /Nothing has been completed yet\./);
  // #1112: the old single "No work is in progress." became one empty string
  // per section, so an empty report says which half is empty.
  assert.match(html, /Nothing is waiting for review or a vote\./);
  assert.match(html, /Nothing is underway\./);
  assert.match(html, /The backlog is empty\./);
  // Still a real document, with every section present.
  for (const s of ['done', 'awaiting-review', 'inprogress', 'backlog']) {
    assert.ok(html.includes(`data-section="${s}"`), `missing section ${s}`);
  }
  // And it survives being called with nothing at all.
  assert.doesNotThrow(() => AppView._renderReportHtml(null, {}));
  assert.doesNotThrow(() => AppView._buildReportModel(null, null));
});

test('escapes hostile titles in both forms', () => {
  const AppView = makeAppView();
  const evil = '<script>alert(1)</script>';
  const m = build(AppView, {
    issues: [issue({ number: 1, title: evil })],
    proposals: [prop({ id: 100, pr_title: evil })],
    merged: [mergedRow({ id: 300, pr_title: evil })],
    mergedTotal: 1,
  });
  for (const standalone of [false, true]) {
    const html = AppView._renderReportHtml(m, { standalone });
    assert.ok(!html.includes('<script>alert(1)</script>'),
      `unescaped script survived (standalone=${standalone})`);
    assert.ok(html.includes('&lt;script&gt;'), 'expected escaped form');
  }
});

test('the standalone export is a self-contained document with inline CSS', () => {
  const AppView = makeAppView();
  const m = build(AppView, { merged: [mergedRow({ id: 300 })], mergedTotal: 1 });
  const doc = AppView._renderReportHtml(m, { standalone: true });
  assert.ok(doc.startsWith('<!doctype html>'), 'must start with the doctype');
  assert.match(doc, /<meta charset="utf-8">/);
  assert.match(doc, /<title>Acme &mdash; progress report<\/title>|<title>Acme — progress report<\/title>/);
  assert.ok(doc.includes(AppView.REPORT_CSS), 'REPORT_CSS must be inlined');
  assert.ok(doc.includes('@media print'), 'print rules must be inlined');
  // No cross-origin assets: text, inline CSS and links only.
  assert.ok(!/<img\b/i.test(doc), 'export must contain no images');
  assert.ok(!/<link\b/i.test(doc), 'export must link no external stylesheet');
  assert.ok(!/<script\b/i.test(doc), 'export must contain no scripts');
  // The export is always light. REPORT_CSS legitimately *defines* the dark
  // modifier (it is inlined verbatim), so assert no ELEMENT carries it.
  assert.ok(doc.includes('<body><div class="ur-rpt">'),
    'export root must be the plain light root');
  const classed = Array.from(doc.matchAll(/class="([^"]*)"/g), (mt) => mt[1]);
  assert.ok(classed.length > 0, 'expected classed elements');
  assert.ok(!classed.some((c) => c.split(/\s+/).includes('ur-rpt--dark')),
    'no exported element may carry the dark modifier');
  // GitHub numbers stay working links back to GitHub.
  assert.match(doc, /href="https:\/\/github\.com\/acme\/app\/pull\/3000"[^>]*target="_blank"[^>]*rel="noopener"/);
});

test('report markup carries none of the delegated card-click hooks', () => {
  const AppView = makeAppView();
  // Populate every section so every row renderer is exercised.
  const m = build(AppView, {
    issues: [
      issue({ number: 1, pri: 'high', asg: 'alice', cat: 'bug', chatCount: 4 }),
      issue({ number: 2, in_progress: { users: ['erin'], claims: [{ username: 'erin' }] } }),
    ],
    proposals: [prop({ id: 100, check_state: 'passing', merge_window_ends_at: daysAgo(-1) })],
    gov: [govRow({ id: 200, kind: 'secret_change', title: 'Set STRIPE_KEY' })],
    merged: [
      mergedRow({ id: 300 }),
      mergedRow({ id: 301, row_type: 'close_issue', payload: { issueNumber: 9, issueTitle: 'Old bug', appliedAt: daysAgo(4) } }),
    ],
    mySessions: [session({ id: 400, username: 'me', busy: true })],
    sharedSessions: [session({ id: 401 })],
    mergedTotal: 2,
  });
  const forbidden = ['data-issue-row', 'data-proposal-row', 'data-gov-row', 'data-session-chip'];
  for (const standalone of [false, true]) {
    const html = AppView._renderReportHtml(m, { standalone });
    for (const hook of forbidden) {
      assert.ok(!html.includes(hook),
        `${hook} must not appear in report markup (standalone=${standalone})`);
    }
    // Nor any inline handler that could act on the board.
    assert.ok(!/onclick=/.test(html), 'report rows must not carry onclick handlers');
    // Every anchor is an external GitHub link opened safely.
    for (const a of html.match(/<a\b[^>]*>/g) || []) {
      assert.match(a, /target="_blank"/);
      assert.match(a, /rel="noopener"/);
      assert.match(a, /href="https:\/\//);
    }
  }
});

test('the on-screen fragment renders every populated group heading', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    issues: [issue({ number: 2, in_progress: { users: ['erin'], claims: [] } })],
    proposals: [prop({ id: 100, check_state: 'failing' })],
    gov: [govRow({ id: 200, kind: 'close_issue', title: 'Close #7', github_issue_number: 7 })],
    merged: [mergedRow({ id: 300 })],
    mySessions: [session({ id: 400, username: 'me', busy: true })],
    mergedTotal: 1,
  });
  const html = AppView._renderReportHtml(m, { standalone: false });
  for (const heading of ['Awaiting review or vote', 'Governance proposals',
    'Being worked on right now', 'Issues with work underway']) {
    assert.ok(html.includes(heading), `missing heading: ${heading}`);
  }
  assert.match(html, /Checks failing/);
  assert.match(html, /agent running/);
  assert.match(html, /2 of 3 yes/);
  // The privacy note the spec requires on the export footer.
  assert.match(html, /reflects what the person who generated it can see/);
});

// ── #1112: "In progress" split into "Awaiting review" + "Underway" ─────────
// One H2 used to cover four lists: two of finished work waiting on people and
// two of work still happening. A reader scanning the report could not tell
// whether anything needed them.

test('the report splits Awaiting review from Underway, in that order', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    issues: [issue({ number: 2, in_progress: { count: 1, users: ['erin'], claims: [] } })],
    proposals: [prop({ id: 100 })],
    gov: [govRow({ id: 200, kind: 'rename', payload: { newName: 'Acme Two' } })],
    merged: [mergedRow({ id: 300 })],
    mySessions: [session({ id: 400, username: 'me' })],
    mergedTotal: 1,
  });
  assert.equal(m.inProgress.emptyAwaiting, false);
  assert.equal(m.inProgress.emptyWork, false);
  const html = AppView._renderReportHtml(m, { standalone: false });

  // Done → Awaiting review → Underway → Backlog.
  const at = (s) => html.indexOf(`data-section="${s}"`);
  assert.ok(at('done') < at('awaiting-review'), 'Done first');
  assert.ok(at('awaiting-review') < at('inprogress'), 'Awaiting review before Underway');
  assert.ok(at('inprogress') < at('backlog'), 'Backlog last');
  // #1264: the H2s carry item counts now.
  assert.match(html, /data-section="awaiting-review"><h2 class="ur-rpt-h2">Awaiting review \(2\)<\/h2>/);
  assert.match(html, /data-section="inprogress"><h2 class="ur-rpt-h2">Underway \(2\)<\/h2>/);
  assert.ok(!/<h2 class="ur-rpt-h2">In progress<\/h2>/.test(html), 'the old H2 is gone');

  // The proposal and the governance row are in the FIRST section; the session
  // and the issue are in the second.
  const ar = html.slice(at('awaiting-review'), at('inprogress'));
  const uw = html.slice(at('inprogress'), at('backlog'));
  assert.ok(ar.includes('Proposal 100') && ar.includes('Acme Two'));
  assert.ok(!ar.includes('Session 400') && !ar.includes('Issue 2'));
  assert.ok(uw.includes('Session 400') && uw.includes('Issue 2'));
  // The section key stays `inprogress` — the retitle is copy only.
  assert.ok(html.includes('data-section="inprogress"'));
});

test('an underway issue row prints its exact work state, not "in progress"', () => {
  const AppView = makeAppView();
  const sess = (over) => ({
    sessionId: 1, username: 'erin', mine: false, status: 'active',
    busy: false, lastActivityAt: '2026-08-01T00:00:00Z', ...over,
  });
  const cases = [
    ['in_review', 'in review', { count: 1, users: ['erin'], claims: [], sessions: [sess({ status: 'promoted' })] }, null],
    ['working', 'being worked on', { count: 1, users: ['erin'], claims: [], sessions: [sess()] }, null],
    ['paused', 'paused', { count: 1, users: ['erin'], claims: [], sessions: [sess({ status: 'paused' })] }, null],
    ['claimed', 'claimed', { count: 0, users: [], claims: [{ username: 'erin', mine: false }], sessions: [] }, null],
    ['auto_solving', 'auto-solving', null, { status: 'generating' }],
    ['answer_needed', 'needs an answer', null, { status: 'ready', outcome: 'question' }],
    ['draft_ready', 'draft ready to review', null, { status: 'ready', outcome: 'spec' }],
  ];
  for (const [key, phrase, ip, headless] of cases) {
    const m = build(AppView, {
      issues: [issue({ number: 2, in_progress: ip, headless })],
      merged: [], mergedTotal: 0,
    });
    assert.equal(m.inProgress.issues.length, 1, `${key}: the issue is underway`);
    assert.equal(m.inProgress.issues[0].state, key);
    assert.equal(m.inProgress.issues[0].stateLabel, phrase);
    const html = AppView._renderReportHtml(m, { standalone: false });
    assert.match(html, new RegExp(`data-work-state="${key}"`), `${key}: row carries its state`);
    assert.ok(html.includes(phrase), `${key}: row prints "${phrase}"`);
  }
  // The old catch-all notes are gone.
  const any = AppView._renderReportHtml(build(AppView, {
    issues: [issue({ number: 2, headless: { status: 'generating' } })], merged: [], mergedTotal: 0,
  }), { standalone: false });
  assert.ok(!any.includes('auto-solve run in progress'));
});

test('owner counts say "underway", matching the section they come from', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    issues: [issue({ number: 2, asg: 'carol', in_progress: { count: 1, users: ['carol'], claims: [] } })],
    merged: [], mergedTotal: 0,
  });
  const html = AppView._renderReportHtml(m, { standalone: false, ai: { owners: [] } });
  assert.match(html, /1 underway/);
  assert.ok(!html.includes('1 in progress'));
});

test('governance kind labels cover every non-code proposal kind', () => {
  const AppView = makeAppView();
  assert.equal(AppView._reportGovKindLabel('rename'), 'App rename');
  assert.equal(AppView._reportGovKindLabel('secret_change'), 'Secret change');
  assert.equal(AppView._reportGovKindLabel('close_issue'), 'Close an issue');
  assert.equal(AppView._reportGovKindLabel('maintenance_campaign'), 'Maintenance campaign');
  assert.equal(AppView._reportGovKindLabel('who_knows'), 'Governance proposal');
});

// ── View-mode registration (extends tests/dev-kanban-tabs.test.js) ──────

test("VIEW_MODES is the single whitelist and includes 'report'", () => {
  const AppView = makeAppView();
  assert.deepEqual(Array.from(AppView.VIEW_MODES), ['list', 'kanban', 'pm', 'report']);
  for (const v of ['list', 'kanban', 'pm', 'report']) {
    assert.equal(AppView._isViewMode(v), true, `${v} should be a mode`);
  }
  for (const v of ['report ', 'REPORT', 'reporting', '', null, undefined, 'kanban2']) {
    assert.equal(AppView._isViewMode(v), false, `${String(v)} should not be a mode`);
  }
});

test("?view=report is accepted as a one-shot override; junk is rejected", () => {
  let AppView = makeAppView({ search: '?view=report' });
  assert.equal(AppView._readViewModeOverride(), 'report');
  assert.equal(AppView._getViewMode(), 'report');

  AppView = makeAppView({ search: '?view=nonsense' });
  assert.equal(AppView._readViewModeOverride(), null);

  // The override still wins over a stored preference.
  AppView = makeAppView({
    search: '?view=report',
    localStorage: { getItem: () => 'kanban', setItem: () => {} },
  });
  assert.equal(AppView._getViewMode(), 'report');
});

test("_setViewMode persists 'report' and retires the URL override", () => {
  const store = {};
  const AppView = makeAppView({
    search: '?view=kanban',
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
  });
  assert.equal(AppView._getViewMode(), 'kanban'); // override first
  AppView._setViewMode('report');
  assert.equal(store[AppView.VIEW_MODE_KEY], 'report');
  assert.equal(AppView._getViewMode(), 'report');
  // Unknown values still fall back to 'list'.
  AppView._setViewMode('nonsense');
  assert.equal(store[AppView.VIEW_MODE_KEY], 'list');
});

test('_resetReportCaches drops the paged history so Refresh re-pages', () => {
  const AppView = makeAppView();
  AppView._reportMerged = [mergedRow({ id: 1 })];
  AppView._reportTruncated = true;
  AppView._reportPartial = true;
  AppView._resetReportCaches();
  assert.equal(AppView._reportMerged, null);
  assert.equal(AppView._reportTruncated, false);
  assert.equal(AppView._reportPartial, false);
});

test('the merged pager is capped at 10 pages / 500 rows', () => {
  const AppView = makeAppView();
  assert.equal(AppView.REPORT_MERGED_PAGE, 50);
  assert.equal(AppView.REPORT_MERGED_MAX_PAGES, 10);
  assert.equal(AppView.REPORT_MERGED_MAX_ROWS, 500);
  // 10 × 50 is exactly the row cap — a mismatch would make one of the two
  // bounds unreachable and the disclosure line wrong.
  assert.equal(
    AppView.REPORT_MERGED_PAGE * AppView.REPORT_MERGED_MAX_PAGES,
    AppView.REPORT_MERGED_MAX_ROWS
  );
});

test('REPORT_CSS is plain CSS scoped under .ur-rpt with a dark modifier', () => {
  const AppView = makeAppView();
  const css = AppView.REPORT_CSS;
  assert.ok(css.includes('.ur-rpt{'), 'must define the root class');
  assert.ok(css.includes('.ur-rpt--dark{'), 'must define the dark modifier');
  // No Tailwind utilities and no @import / url() — the export is offline-safe.
  assert.ok(!css.includes('@apply'), 'must not use Tailwind @apply');
  assert.ok(!css.includes('@import'), 'must not import anything');
  assert.ok(!/url\(/.test(css), 'must not reference external assets');
});

// ── AI layer (report-ai): owner stats + AI section renderer ──────────
//
// The LLM writes PROSE only; every number beside it comes from
// _buildOwnerStats, aggregated deterministically from the same model the
// deterministic sections render. Both helpers are pure and carry the
// report's hard markup rule: escaped text, no live-card data-* hooks.

test('_buildOwnerStats aggregates across all four buckets', () => {
  const AppView = makeAppView();
  const model = AppView._buildReportModel({
    issues: [
      issue({ number: 1, asg: 'bob' }),
      issue({ number: 2, asg: 'bob' }),
      issue({ number: 3, in_progress: { users: ['carol'], claims: [] } }),
    ],
    proposals: [prop({ id: 1, username: 'alice', status: 'promoted' })],
    gov: [], mySessions: [], sharedSessions: [],
    merged: [mergedRow({ id: 9, username: 'alice' })],
    mergedTotal: 1, majority: 2,
  }, { now: NOW });
  const stats = AppView._buildOwnerStats(model);
  const byName = Object.fromEntries(stats.map((s) => [s.username, s]));
  assert.equal(byName.alice.completed, 1);
  assert.equal(byName.alice.inReview, 1);
  assert.equal(byName.bob.backlog, 2);
  assert.equal(byName.carol.inProgress, 1);
  // sorted by total desc, alice (2) first
  assert.equal(stats[0].username, 'alice');
});

test('_renderReportAiHtml escapes LLM text and orders sections', () => {
  const AppView = makeAppView();
  const html = AppView._renderReportAiHtml({
    narrative: 'First para <script>alert(1)</script>.\n\nSecond para.',
    risks: [{ title: 'Risk <b>one</b>', detail: 'Bad & scary', severity: 'high' }],
    owners: [{ username: 'alice', blurb: 'Did <i>things</i>' }],
    model: 'claude-haiku-4-5', generatedAt: '2026-08-10T00:00:00Z', stale: false,
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Bad &amp; scary'));
  assert.ok(html.includes('ur-rpt-risk-sev--high'));
  // narrative before risks; the owners section moved into the
  // deterministic document (#1264) and no longer renders here.
  const iN = html.indexOf('data-section="ai-summary"');
  const iR = html.indexOf('data-section="ai-risks"');
  assert.ok(iN > -1 && iR > iN, 'sections must appear in order');
  assert.ok(!html.includes('data-section="ai-owners"'),
    'owners render in the deterministic document, not the AI layer (#1264)');
  // no live-card hooks
  for (const attr of ['data-issue-row', 'data-proposal-row', 'data-gov-row', 'data-session-chip']) {
    assert.ok(!html.includes(attr), `report AI markup must not carry ${attr}`);
  }
});

test('_renderReportAiHtml with null ai renders a single invite line', () => {
  const AppView = makeAppView();
  const html = AppView._renderReportAiHtml(null, []);
  assert.ok(html.includes('ur-rpt-empty'));
  assert.ok(!html.includes('ur-rpt-risk'));
});

test('_renderReportHtml includes the AI layer only when opts.ai is present', () => {
  const AppView = makeAppView();
  const model = AppView._buildReportModel({
    issues: [], proposals: [], gov: [], mySessions: [], sharedSessions: [],
    merged: [mergedRow({ id: 1 })], mergedTotal: 1, majority: 1,
  }, { now: NOW });
  const withAi = AppView._renderReportHtml(model, {
    standalone: false,
    ai: { narrative: 'N.', risks: [], owners: [], model: 'm', generatedAt: '2026-08-10T00:00:00Z', stale: false },
  });
  const withoutAi = AppView._renderReportHtml(model, { standalone: false });
  assert.ok(withAi.includes('data-section="ai-summary"'));
  assert.ok(!withoutAi.includes('data-section="ai-summary"'));
  // AI layer sits between the summary strip and the Done section
  assert.ok(withAi.indexOf('ur-rpt-summary') < withAi.indexOf('data-section="ai-summary"'));
  assert.ok(withAi.indexOf('data-section="ai-summary"') < withAi.indexOf('data-section="done"'));
});

test('report toolbar offers the AI generate button and staleness hint', () => {
  const AppView = makeAppView();
  AppView._reportAi = undefined;
  AppView._reportAiGenerating = false;
  AppView._reportLoading = false;
  const bar = AppView._renderReportToolbar();
  assert.ok(bar.includes('dev-report-ai'));
  assert.ok(bar.includes('Generate AI summary'));
  assert.ok(!bar.includes('Data has changed'));
  AppView._reportAi = { narrative: 'x', risks: [], owners: [], stale: true };
  const bar2 = AppView._renderReportToolbar();
  assert.ok(bar2.includes('Regenerate AI summary'));
  assert.ok(bar2.includes('Data has changed'));
});

test('AI highlights render as an escaped bullet list above the narrative', () => {
  const AppView = makeAppView();
  const html = AppView._renderReportAiHtml({
    narrative: 'All good.',
    highlights: ['Shipped <payments>', 'Review queue cleared'],
    risks: [], owners: [],
  }, []);
  assert.match(html, /data-section="ai-highlights"/);
  assert.match(html, /Progress highlights/);
  assert.match(html, /Shipped &lt;payments&gt;/);
  assert.ok(!html.includes('<payments>'));
  assert.ok(
    html.indexOf('data-section="ai-highlights"') < html.indexOf('data-section="ai-summary"'),
    'highlights come before the narrative'
  );
});

test('AI highlights section is omitted when empty or absent', () => {
  const AppView = makeAppView();
  const none = AppView._renderReportAiHtml({ narrative: 'n', risks: [], owners: [] }, []);
  assert.ok(!none.includes('ai-highlights'));
  const empty = AppView._renderReportAiHtml({ narrative: 'n', highlights: [], risks: [], owners: [] }, []);
  assert.ok(!empty.includes('ai-highlights'));
});

// ── Locked snapshots (report-lock-share): Lock button, Previous reports ──

test('report toolbar shows Lock report only for managers', () => {
  const canManage = makeAppView();
  canManage.appData = { slug: 'demo', can_manage: true };
  assert.match(canManage._renderReportToolbar(), /id="dev-report-lock"/);
  assert.match(canManage._renderReportToolbar(), /Lock report/);

  const viewer = makeAppView();
  viewer.appData = { slug: 'demo', can_manage: false };
  assert.ok(!viewer._renderReportToolbar().includes('dev-report-lock'));
});

test('snapshots list renders dates, badges, and admin-only actions', () => {
  const AppView = makeAppView();
  const snaps = [
    { id: 4, lockedAt: '2026-08-11T10:00:00Z', lockedBy: 'ali<ce', shared: true,
      sharePath: `/reports/${'a'.repeat(32)}`, htmlPath: '/api/apps/demo/report-snapshots/4/html' },
    { id: 3, lockedAt: '2026-08-01T09:00:00Z', lockedBy: 'bob', shared: false,
      sharePath: null, htmlPath: '/api/apps/demo/report-snapshots/3/html' },
  ];
  const admin = AppView._renderReportSnapshotsHtml(snaps, true);
  assert.match(admin, /data-section="snapshots"/);
  assert.match(admin, /Previous reports/);
  assert.match(admin, /ali&lt;ce/);
  assert.ok(!admin.includes('ali<ce'));
  assert.match(admin, /Shared/);
  assert.match(admin, /data-snap-copy="\/reports\/a{32}"/);
  assert.match(admin, /data-snap-unshare="4"/);
  assert.match(admin, /data-snap-share="3"/);
  assert.match(admin, /href="\/api\/apps\/demo\/report-snapshots\/4\/html"/);
  // Read-only document rules still hold: no live-card hooks, no inline handlers.
  assert.ok(!/onclick=/.test(admin));
  assert.ok(!/data-issue-row|data-proposal-row|data-gov-row|data-session-chip/.test(admin));

  const viewer = AppView._renderReportSnapshotsHtml(snaps, false);
  assert.ok(!viewer.includes('data-snap-share'));
  assert.ok(!viewer.includes('data-snap-unshare'));
  assert.ok(!viewer.includes('data-snap-copy'));
  assert.match(viewer, /href="\/api\/apps\/demo\/report-snapshots\/3\/html"/);
});

test('snapshots list renders nothing when empty', () => {
  const AppView = makeAppView();
  assert.equal(AppView._renderReportSnapshotsHtml([], true), '');
  assert.equal(AppView._renderReportSnapshotsHtml(undefined, true), '');
});

// ── Report period (reporting-period) ─────────────────────────────────
// _buildReportModel gains opts.since (ms): Done entries dated before the
// start are dropped, undated ones are kept, and the completed counts
// follow the filtered list. Backlog / Awaiting review / Underway are
// untouched — they describe the present, not a period.

const buildSince = (AppView, data, since) => AppView._buildReportModel(
  { app: { name: 'Acme', slug: 'acme', url: 'https://acme.test', repoUrl: 'https://github.com/acme/app' }, ...data },
  { now: NOW, since }
);

test('period filter drops Done entries before the start, keeps the boundary and undated ones', () => {
  const AppView = makeAppView();
  const SINCE = Date.parse('2026-08-01T00:00:00Z');
  const merged = [
    mergedRow({ id: 300, pr_title: 'After', created_at: daysAgo(2) }),
    mergedRow({ id: 301, pr_title: 'Boundary', created_at: '2026-08-01T00:00:00Z' }),
    mergedRow({ id: 302, pr_title: 'Before', created_at: '2026-07-20T10:00:00Z' }),
    mergedRow({ id: 303, pr_title: 'Undated', created_at: 'not-a-date' }),
  ];
  const m = buildSince(AppView, { merged, mergedTotal: 4 }, SINCE);
  const shown = Array.from(m.done.groups || []).flatMap((g) => titles(g.entries));
  assert.ok(shown.includes('After'));
  assert.ok(shown.includes('Boundary'), 'an entry exactly at the start date is kept (inclusive)');
  assert.ok(!shown.includes('Before'));
  assert.ok(shown.includes('Undated'), 'undated entries are kept, never silently hidden');
  // The filtered count IS the total — mergedTotal describes all history.
  assert.equal(m.summary.completed, 3);
  assert.equal(m.done.total, 3);
  assert.equal(m.done.shown, 3);
  assert.equal(m.periodStartMs, SINCE);
  // Without a period the model is unchanged.
  const all = build(AppView, { merged, mergedTotal: 4 });
  assert.equal(all.periodStartMs, null);
  assert.equal(all.summary.completed, 4);
});

test('period leaves Backlog / Awaiting review / Underway alone', () => {
  const AppView = makeAppView();
  const SINCE = Date.parse('2026-08-01T00:00:00Z');
  const m = buildSince(AppView, {
    issues: [issue({ number: 1, updatedAt: '2026-05-01T00:00:00Z' })],
    proposals: [prop({ id: 100, created_at: '2026-05-02T00:00:00Z', promoted_at: '2026-05-02T00:00:00Z' })],
    merged: [mergedRow({ id: 300, created_at: '2026-05-03T00:00:00Z' })],
    mySessions: [session({ id: 400, created_at: '2026-05-04T00:00:00Z', last_activity_at: '2026-05-04T00:00:00Z' })],
    mergedTotal: 1,
  }, SINCE);
  assert.equal(m.summary.completed, 0);
  assert.equal(m.summary.awaitingReview, 1);
  assert.equal(m.summary.beingWorkedOn, 1);
  assert.equal(m.summary.backlog, 1);
});

test('periodIncomplete only when the truncated page cannot cover the period', () => {
  const AppView = makeAppView();
  const merged = [mergedRow({ id: 300, created_at: daysAgo(5) })];
  // Start predates the oldest paged row AND the pager hit its cap.
  const far = buildSince(AppView, { merged, mergedTotal: 900, mergedTruncated: true }, NOW - 400 * 86400000);
  assert.equal(far.done.periodIncomplete, true);
  assert.equal(far.done.truncated, false, 'the all-history "showing N of M" note never applies in period mode');
  const html = AppView._renderReportHtml(far, { standalone: false });
  assert.match(html, /this period may be incomplete/);
  // Start inside the paged window: complete even though the page truncated.
  const near = buildSince(AppView, { merged, mergedTotal: 900, mergedTruncated: true }, NOW - 2 * 86400000);
  assert.equal(near.done.periodIncomplete, false);
  // No truncation: never flagged.
  const ok = buildSince(AppView, { merged, mergedTotal: 1 }, NOW - 400 * 86400000);
  assert.equal(ok.done.periodIncomplete, false);
});

test('renderer adds the Covering header line and drops the 30-day line in period mode', () => {
  const AppView = makeAppView();
  const merged = [mergedRow({ id: 300, created_at: daysAgo(2) })];
  const scoped = AppView._renderReportHtml(
    buildSince(AppView, { merged, mergedTotal: 1 }, Date.parse('2026-08-01T00:00:00Z')),
    { standalone: false }
  );
  assert.match(scoped, /Covering /);
  assert.ok(!/completed in the last 30 days/.test(scoped));
  const all = AppView._renderReportHtml(
    build(AppView, { merged, mergedTotal: 1 }),
    { standalone: false }
  );
  assert.ok(!/Covering /.test(all));
  assert.match(all, /completed in the last 30 days/);
});

test('AI note names the period the shared cache was generated for', () => {
  const AppView = makeAppView();
  const ai = {
    narrative: 'n', highlights: [], risks: [], owners: [],
    model: 'claude-haiku-4-5', generatedAt: '2026-08-10T00:00:00Z',
    periodStart: '2026-08-01T00:00:00Z',
  };
  assert.match(AppView._renderReportAiHtml(ai, []), /covering since /);
  assert.ok(!/covering since /.test(AppView._renderReportAiHtml({ ...ai, periodStart: null }, [])));
});

// ── Discord message (reporting-period): pure builder ─────────────────

test('_buildDiscordMessage composes title, highlights, numbers, risks and link', () => {
  const AppView = makeAppView();
  const m = buildSince(AppView, {
    merged: [mergedRow({ id: 300, created_at: daysAgo(2) })],
    proposals: [prop({ id: 100 }), prop({ id: 101 })],
    issues: [issue({ number: 1 })],
    mergedTotal: 1,
  }, Date.parse('2026-08-01T00:00:00Z'));
  const msg = AppView._buildDiscordMessage(m, {
    highlights: ['The board got faster', 'Search now finds drafts'],
    risks: [
      { title: 'A change has waited two weeks for votes', severity: 'high' },
      { title: 'Minor styling drift', severity: 'low' },
      { title: 'Backlog is growing', severity: 'medium' },
    ],
  });
  assert.match(msg, /^\*\*Acme — progress update\*\* _\(covering since .+\)_/);
  assert.match(msg, /\*\*What's new\*\*/);
  assert.match(msg, /- The board got faster/);
  assert.match(msg, /\*\*By the numbers\*\*/);
  assert.match(msg, /1 improvement finished · 2 changes waiting for votes · 0 in progress · 1 idea in the backlog/);
  assert.match(msg, /\*\*Needs attention\*\*/);
  assert.match(msg, /- A change has waited two weeks for votes/);
  assert.match(msg, /- Backlog is growing/);
  assert.ok(!msg.includes('Minor styling drift'), 'low-severity risks are omitted');
  assert.ok(msg.trimEnd().endsWith('https://acme.test'), 'the app link is the last line');
});

test('_buildDiscordMessage omits Needs attention when nothing qualifies, caps highlights at 6', () => {
  const AppView = makeAppView();
  const m = build(AppView, { merged: [mergedRow({ id: 300 })], mergedTotal: 1 });
  const msg = AppView._buildDiscordMessage(m, {
    highlights: Array.from({ length: 8 }, (_, i) => `Highlight ${i + 1}`),
    risks: [],
  });
  assert.ok(!msg.includes('Needs attention'));
  assert.ok(msg.includes('- Highlight 6'));
  assert.ok(!msg.includes('- Highlight 7'), 'highlights are capped at 6');
  assert.ok(!/covering since/.test(msg), 'no period suffix in all-history mode');
});

test('_buildDiscordMessage fallback (no AI) uses finished-item titles and no technical jargon', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    merged: Array.from({ length: 7 }, (_, i) => mergedRow({
      id: 300 + i, pr_title: `Improvement number ${i + 1}`, created_at: daysAgo(i + 1),
    })),
    mergedTotal: 7,
  });
  const msg = AppView._buildDiscordMessage(m, null);
  assert.match(msg, /\*\*Acme — progress update\*\*/);
  assert.match(msg, /- Improvement number 1/);
  const bulletCount = msg.split('\n').filter((l) => l.startsWith('- ')).length;
  assert.equal(bulletCount, 5, 'fallback caps at 5 finished-item titles');
  assert.match(msg, /7 improvements finished/);
  // The scaffolding vocabulary is general-audience only.
  assert.ok(!/\bPR\b/.test(msg));
  assert.ok(!/merge/i.test(msg));
  assert.ok(!/checks/i.test(msg));
  assert.ok(!/governance/i.test(msg));
});

test('_buildDiscordMessage stays under 1,900 characters, trimming bullets first', () => {
  const AppView = makeAppView();
  const m = build(AppView, { merged: [mergedRow({ id: 300 })], mergedTotal: 1 });
  const msg = AppView._buildDiscordMessage(m, {
    highlights: Array.from({ length: 6 }, (_, i) => `Highlight ${i + 1} ${'x'.repeat(400)}`),
    risks: [{ title: `Risk ${'y'.repeat(200)}`, severity: 'high' }],
  });
  assert.ok(msg.length <= 1900, `message must fit Discord's limit (got ${msg.length})`);
  // The numbers line and title survive the trim.
  assert.match(msg, /\*\*By the numbers\*\*/);
  assert.match(msg, /\*\*Acme — progress update\*\*/);
});

// ── #1264: the more descriptive report ──────────────────────────────────
// Six summary tiles, the momentum comparison, the zero-filled monthly
// strip, the deterministic Needs-attention layer, always-on Work by
// owner, merged_at-preferred dating, per-line detail and heading counts.

test('summary strip renders six tiles including Contributors and High priority backlog (#1264)', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    issues: [issue({ number: 1, pri: 'high' }), issue({ number: 2, pri: 'high' }), issue({ number: 3 })],
    proposals: [prop({ id: 100, username: 'alice' })],
    merged: [mergedRow({ id: 300, username: 'carol' })],
    mergedTotal: 1,
  });
  assert.equal(m.summary.backlogHighPriority, 2);
  assert.equal(m.summary.contributors, m.owners.length);
  assert.equal(m.summary.contributors, 2, 'alice (in review) + carol (completed)');
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.ok(html.includes('Contributors'));
  assert.ok(html.includes('High priority backlog'));
  assert.equal((html.match(/ur-rpt-stat-l/g) || []).length, 6, 'exactly six tiles');
});

test('momentum line compares the last 30 days against the 30 before (#1264)', () => {
  const AppView = makeAppView();
  const mUp = build(AppView, {
    merged: [
      mergedRow({ id: 300, created_at: daysAgo(5) }),
      mergedRow({ id: 301, created_at: daysAgo(10) }),
      mergedRow({ id: 302, created_at: daysAgo(45) }),
    ],
    mergedTotal: 3,
  });
  assert.equal(mUp.summary.completedLast30, 2);
  assert.equal(mUp.summary.completedPrev30, 1);
  const up = AppView._renderReportHtml(mUp, { standalone: false });
  assert.match(up, /2 completed in the last 30 days vs 1 in the 30 days before that/);
  assert.match(up, /pace is up/);

  const mDown = build(AppView, {
    merged: [mergedRow({ id: 300, created_at: daysAgo(45) })],
    mergedTotal: 1,
  });
  const down = AppView._renderReportHtml(mDown, { standalone: false });
  assert.match(down, /pace is down/);

  const mSteady = build(AppView, {
    merged: [
      mergedRow({ id: 300, created_at: daysAgo(5) }),
      mergedRow({ id: 301, created_at: daysAgo(45) }),
    ],
    mergedTotal: 2,
  });
  const steady = AppView._renderReportHtml(mSteady, { standalone: false });
  assert.match(steady, /pace is steady/);

  // Period mode drops the line exactly like the old 30-day count did.
  const scoped = AppView._renderReportHtml(
    buildSince(AppView, { merged: [mergedRow({ id: 300, created_at: daysAgo(2) })], mergedTotal: 1 },
      Date.parse('2026-08-01T00:00:00Z')),
    { standalone: false }
  );
  assert.ok(!/completed in the last 30 days/.test(scoped));
});

test('monthly buckets: six zero-filled months, oldest first, rendered as bars (#1264)', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    merged: [
      mergedRow({ id: 300, created_at: '2026-07-01T00:00:00Z', merged_at: '2026-08-02T10:00:00Z' }),
      mergedRow({ id: 301, created_at: '2026-07-01T00:00:00Z', merged_at: '2026-08-05T10:00:00Z' }),
      mergedRow({ id: 302, created_at: '2026-04-01T00:00:00Z', merged_at: '2026-05-05T10:00:00Z' }),
    ],
    mergedTotal: 3,
  });
  assert.equal(m.monthly.length, 6);
  assert.deepEqual(Array.from(m.monthly, (x) => x.key),
    ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
  assert.deepEqual(Array.from(m.monthly, (x) => x.count), [0, 0, 1, 0, 0, 2],
    'counts follow the MERGE month, zero-filled');
  assert.equal(m.monthly[5].label, 'August 2026');
  assert.equal(m.monthly[5].shortLabel, 'Aug');
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /data-section="monthly"/);
  assert.match(html, /Completed by month/);
  assert.match(html, /style="width:100%"/);
  assert.match(html, /style="width:50%"/);
  assert.ok(!/oldest months may be incomplete/.test(html));

  // All-zero six months → the strip is omitted entirely.
  const empty = AppView._renderReportHtml(build(AppView, { merged: [], mergedTotal: 0 }), { standalone: false });
  assert.ok(!empty.includes('data-section="monthly"'));

  // Truncated history discloses that the oldest months may under-count.
  const trunc = AppView._renderReportHtml(build(AppView, {
    merged: [mergedRow({ id: 300, merged_at: daysAgo(2) })], mergedTotal: 900, mergedTruncated: true,
  }), { standalone: false });
  assert.equal(build(AppView, {
    merged: [mergedRow({ id: 300, merged_at: daysAgo(2) })], mergedTotal: 900, mergedTruncated: true,
  }).monthlyIncomplete, true);
  assert.match(trunc, /oldest months may be incomplete/);
});

test('Done entries prefer merged_at ("Merged"), fall back to created_at ("Started") (#1264)', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    merged: [
      mergedRow({ id: 300, pr_title: 'Dated one', created_at: '2026-07-01T10:00:00Z', merged_at: '2026-08-03T10:00:00Z' }),
      mergedRow({ id: 301, pr_title: 'Legacy one', created_at: '2026-07-02T10:00:00Z' }),
    ],
    mergedTotal: 2,
  });
  const entries = Array.from(m.done.groups || []).flatMap((g) => Array.from(g.entries));
  const dated = entries.find((e) => e.title === 'Dated one');
  const legacy = entries.find((e) => e.title === 'Legacy one');
  assert.equal(dated.dateLabel, 'Merged');
  assert.equal(dated.atMs, Date.parse('2026-08-03T10:00:00Z'));
  assert.equal(dated.hasMergeDate, true);
  assert.equal(legacy.dateLabel, 'Started');
  assert.equal(legacy.atMs, Date.parse('2026-07-02T10:00:00Z'));
  assert.equal(legacy.hasMergeDate, false);
  // Month grouping follows the effective date: merged row in August,
  // legacy row under its July start.
  assert.deepEqual(Array.from(m.done.groups, (g) => g.key), ['2026-08', '2026-07']);
  // The disclaimer renders only because a shown row lacks a merge time.
  assert.equal(m.done.anyUndatedMerge, true);
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /Items without a recorded merge time are dated by when the work was started\./);

  const allDated = build(AppView, {
    merged: [mergedRow({ id: 300, merged_at: daysAgo(1) })], mergedTotal: 1,
  });
  assert.equal(allDated.done.anyUndatedMerge, false);
  const html2 = AppView._renderReportHtml(allDated, { standalone: false });
  assert.ok(!html2.includes('dated by when the work was started'));

  // The period filter follows the merge date too: created before the
  // start but merged after it is INSIDE the period.
  const scoped = buildSince(AppView, {
    merged: [mergedRow({ id: 300, created_at: '2026-07-01T00:00:00Z', merged_at: '2026-08-03T00:00:00Z' })],
    mergedTotal: 1,
  }, Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(scoped.summary.completed, 1);
});

test('Needs attention flags failing checks, closed windows and answer-needed issues (#1264)', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    proposals: [
      prop({ id: 100, pr_title: 'Failing one', check_state: 'failing' }),
      prop({ id: 101, pr_title: 'Errored one', check_state: 'error' }),
      prop({ id: 102, pr_title: 'Window closed one', merge_window_ends_at: daysAgo(1) }),
      prop({ id: 103, pr_title: 'Healthy one', check_state: 'passing', merge_window_ends_at: daysAgo(-1) }),
      prop({ id: 104, pr_title: 'Merging one', status: 'merging', merge_window_ends_at: daysAgo(1) }),
    ],
    gov: [govRow({ id: 200, kind: 'rename', payload: { newName: 'Acme Two' }, merge_window_ends_at: daysAgo(2) })],
    issues: [issue({ number: 5, title: 'Question issue', headless: { status: 'ready', outcome: 'question' } })],
    merged: [], mergedTotal: 0,
  });
  const names = Array.from(m.attention, (e) => e.title);
  assert.ok(names.includes('Failing one'));
  assert.ok(names.includes('Errored one'));
  assert.ok(names.includes('Window closed one'));
  assert.ok(names.includes('Acme Two'), 'a governance row with a closed window qualifies');
  assert.ok(names.includes('Question issue'));
  assert.ok(!names.includes('Healthy one'));
  assert.ok(!names.includes('Merging one'), 'a merging proposal is not stuck');
  const reasons = Object.fromEntries(Array.from(m.attention, (e) => [e.title, Array.from(e.reasons).join(', ')]));
  assert.match(reasons['Failing one'], /checks failing/);
  assert.match(reasons['Errored one'], /checks could not run/);
  assert.match(reasons['Window closed one'], /merge window closed without a merge/);
  assert.match(reasons['Question issue'], /waiting on an answer/);
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /data-section="attention"><h2 class="ur-rpt-h2">Needs attention<\/h2>/);
  assert.ok(html.includes('checks failing'));
});

test('Needs attention renders its explicit empty state between summary and the AI layer (#1264)', () => {
  const AppView = makeAppView();
  const m = build(AppView, { merged: [mergedRow({ id: 300 })], mergedTotal: 1 });
  assert.deepEqual(Array.from(m.attention), []);
  const html = AppView._renderReportHtml(m, {
    standalone: false,
    ai: { narrative: 'N.', risks: [], owners: [], model: 'm', generatedAt: '2026-08-10T00:00:00Z', stale: false },
  });
  assert.match(html, /Nothing needs attention right now\./);
  const idx = (s) => html.indexOf(s);
  assert.ok(idx('ur-rpt-summary') < idx('data-section="attention"'), 'summary before attention');
  assert.ok(idx('data-section="attention"') < idx('data-section="ai-summary"'), 'attention before the AI layer');
  assert.ok(idx('data-section="ai-summary"') < idx('data-section="owners"'), 'AI layer before owners');
  assert.ok(idx('data-section="owners"') < idx('data-section="done"'), 'owners directly before Done');
});

test('Work by owner renders without an AI summary and folds blurbs in when present (#1264)', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    proposals: [prop({ id: 100, username: 'alice' })],
    merged: [mergedRow({ id: 300, username: 'carol' })],
    mergedTotal: 1,
  });
  const plain = AppView._renderReportHtml(m, { standalone: false });
  assert.match(plain, /data-section="owners"/);
  assert.match(plain, /Work by owner \(2\)/);
  assert.match(plain, /1 completed/);
  assert.ok(!plain.includes('data-section="ai-owners"'));
  const withAi = AppView._renderReportHtml(m, {
    standalone: false,
    ai: { narrative: 'n', risks: [], owners: [{ username: 'carol', blurb: 'Did <i>things</i>' }] },
  });
  assert.ok(withAi.includes('Did &lt;i&gt;things&lt;/i&gt;'));
  assert.ok(!withAi.includes('<i>things</i>'));
  // The empty state still reads deliberately.
  const none = AppView._renderReportHtml(build(AppView, {}), { standalone: false });
  assert.match(none, /No attributable work yet\./);
});

test('Done rows carry kudos, discussion, closes-links and provenance tags (#1264)', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    merged: [mergedRow({
      id: 300, pr_title: 'Rich change', kudos_count: 3, chat_count: 5,
      linked_issues: [12, 13], source: 'imported', imported_pr_author: 'octo<cat>',
      external_agent: 'codex', merged_at: daysAgo(1),
    })],
    mergedTotal: 1,
  });
  const e = m.done.groups[0].entries[0];
  assert.equal(e.kudos, 3);
  assert.equal(e.chatCount, 5);
  assert.deepEqual(Array.from(e.linkedIssues), [12, 13]);
  assert.equal(e.imported, true);
  assert.equal(e.externalAgent, 'codex');
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /3 kudos/);
  assert.match(html, /5 in discussion/);
  assert.match(html, /closes /);
  assert.match(html, /href="https:\/\/github\.com\/acme\/app\/issues\/12"/);
  assert.match(html, /Imported PR by octo&lt;cat&gt;/);
  assert.ok(!html.includes('octo<cat>'));
  assert.match(html, /built with codex/);
});

test('review, session and backlog rows print the new provenance details (#1264)', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    proposals: [prop({ id: 100, promoted_at: '2026-08-05T00:00:00Z', chat_count: 4 })],
    issues: [issue({
      number: 1, title: 'Backlog issue', createdAt: '2026-07-01T00:00:00Z',
      created_by_username: 'gina', bounty_count: 2, chatCount: 0,
    })],
    mySessions: [session({ id: 400, username: 'me', chat_count: 7 })],
    merged: [], mergedTotal: 0,
  });
  assert.equal(m.inProgress.review[0].waitingSinceMs, Date.parse('2026-08-05T00:00:00Z'));
  const bl = m.backlog.groups[0].issues[0];
  assert.equal(bl.reporter, 'gina');
  assert.equal(bl.bountyCount, 2);
  assert.equal(bl.createdAtMs, Date.parse('2026-07-01T00:00:00Z'));
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /waiting since /);
  assert.match(html, /4 in discussion/);
  assert.match(html, /filed .+ by gina/);
  assert.match(html, /2 bounties/);
  assert.match(html, /7 in discussion/);
  // Singular bounty copy.
  const one = AppView._renderReportHtml(build(AppView, {
    issues: [issue({ number: 2, bounty_count: 1 })], merged: [], mergedTotal: 0,
  }), { standalone: false });
  assert.match(one, /1 bounty</);
});

test('section and group headings carry item counts (#1264)', () => {
  const AppView = makeAppView();
  const m = build(AppView, {
    issues: [issue({ number: 1, pri: 'high' }), issue({ number: 2 })],
    proposals: [prop({ id: 100 })],
    merged: [mergedRow({ id: 300, merged_at: '2026-08-02T10:00:00Z' })],
    mySessions: [session({ id: 400 })],
    mergedTotal: 1,
  });
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /Done &mdash; completed work \(1\)/);
  assert.match(html, /August 2026 \(1\)/);
  assert.match(html, /Awaiting review \(1\)/);
  assert.match(html, /Underway \(1\)/);
  assert.match(html, /Backlog \(2\)/);
  assert.match(html, /High \(1\)/);
  assert.match(html, /Work by owner \(\d+\)/);
});
