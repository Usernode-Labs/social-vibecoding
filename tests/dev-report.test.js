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
//     classification to _bucketDevItems, which already drops issues linked
//     to an open proposal and routes in-progress issues away from the plain
//     issue column — so no entity can appear twice.
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
  // Every proposal entry is labelled "Started" — there is no merge timestamp.
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

test('empty input yields all three empty states and no crash', () => {
  const AppView = makeAppView();
  const m = build(AppView, {});
  assert.equal(m.done.empty, true);
  assert.equal(m.inProgress.empty, true);
  assert.equal(m.backlog.empty, true);
  const html = AppView._renderReportHtml(m, { standalone: false });
  assert.match(html, /Nothing has been completed yet\./);
  assert.match(html, /No work is in progress\./);
  assert.match(html, /The backlog is empty\./);
  // Still a real document, with all three sections present.
  for (const s of ['done', 'inprogress', 'backlog']) {
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
  }, [{ username: 'alice', completed: 2, inReview: 1, inProgress: 0, backlog: 0 }]);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Bad &amp; scary'));
  assert.ok(html.includes('ur-rpt-risk-sev--high'));
  // narrative before risks before owners
  const iN = html.indexOf('data-section="ai-summary"');
  const iR = html.indexOf('data-section="ai-risks"');
  const iO = html.indexOf('data-section="ai-owners"');
  assert.ok(iN > -1 && iR > iN && iO > iR, 'sections must appear in order');
  // deterministic counts rendered alongside the blurb
  assert.ok(html.includes('2 completed'));
  assert.ok(html.includes('Did &lt;i&gt;things&lt;/i&gt;'));
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
