// PM view filters (#625): the kanban filter bar is shared with the PM view.
// _renderPmInner filters the cached issues/proposals with _devCardMatches
// BEFORE handing them to _groupByAssignee (pre-group filtering is safe here
// — PM grouping has no cross-item dedup), hides the Unassigned section while
// a user filter is active, and shows a "No cards match the current filters."
// note when the active filters match nothing. _repaintDevBody's PM branch
// mounts the same #dev-kanban-filterbar node the kanban branch does.
//
// Same vm-context harness as dev-pm-groups.test.js / dev-kanban-filters
// .test.js: app-view.js is loaded into a sandbox and the helpers are called
// directly with synthetic rows.
//
// Run with: node --test tests/dev-pm-filters.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// Minimal in-memory Web Storage stand-in so the persistence helpers can
// round-trip without a browser.
function makeMemoryStore(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

// Generic inert element: enough surface for the filter-bar wiring
// (addEventListener / setAttribute / classList) without doing anything.
function fakeEl(id) {
  return {
    id: id || '',
    innerHTML: '',
    className: '',
    value: '',
    disabled: false,
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// Container element whose innerHTML setter registers any id="…" it is given
// into the shared element map — so `body.innerHTML = '<div id="dev-pm">…'`
// makes a later document.getElementById('dev-pm') succeed, mirroring what a
// real DOM would do. querySelector hands back inert elements so the filter
// bar's control wiring runs without a browser.
function containerEl(id, els) {
  const el = fakeEl(id);
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v) => {
      html = String(v);
      for (const m of html.matchAll(/id="([^"]+)"/g)) {
        if (!els.has(m[1])) els.set(m[1], containerEl(m[1], els));
      }
    },
  });
  el.querySelector = () => fakeEl('');
  return el;
}

function makeCtx(over) {
  const o = over || {};
  const sandbox = {
    matchMedia: o.matchMedia,
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentSubTab: 'forum', currentApp: 'test-app' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: o.document || {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => fakeEl(''),
      body: { appendChild: () => {} },
    },
    fetch: o.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: o.localStorage || { getItem: () => null, setItem: () => {} },
    sessionStorage: o.sessionStorage || makeMemoryStore(),
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

const none = { q: '', priority: null, assignee: null, needsVote: false };

const at = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00Z`;

// `a` / `p` are the top-voted assignee / priority (omitted → unset).
const issue = (over) => ({
  number: over.number, title: `Issue ${over.number}`,
  updatedAt: over.updatedAt || at(1), lastMessageAt: over.lastMessageAt || at(1),
  headless: null,
  assignee: over.a === undefined ? null : { top: over.a, count: 1, myValue: null },
  priority: over.p === undefined ? null : { top: over.p, count: 1, myValue: null },
  ...over,
});
const prop = (over) => ({
  id: over.id, pr_number: over.id * 10, pr_title: `PR ${over.id}`,
  username: 'me', user_id: 1, status: 'promoted', my_vote: null, linked_issues: [],
  created_at: over.created_at || at(1), promoted_at: over.promoted_at || at(1),
  last_message_at: over.last_message_at || at(1),
  assignee: over.a === undefined ? null : { top: over.a, count: 1, myValue: null },
  priority: over.p === undefined ? null : { top: over.p, count: 1, myValue: null },
  ...over,
});

// Replicates _renderPmInner's pre-group filtering step so the pure pipeline
// (filter with _devCardMatches → group with _groupByAssignee) is exercised
// without the DOM-bound renderer.
function pmGroups(AppView, data, f) {
  const issues = (data.issues || []).filter((i) => AppView._devCardMatches('issue', i, f));
  const proposals = (data.proposals || []).filter((p) => AppView._devCardMatches('proposal', p, f));
  return AppView._groupByAssignee({ issues, proposals });
}

test('priority filter drops non-matching and attribute-less cards; group counts recompute', () => {
  const AppView = makeAppView();
  const r = pmGroups(AppView, {
    issues: [
      issue({ number: 1, a: 'alice', p: 'high' }),
      issue({ number: 2, a: 'alice', p: 'low' }),
      issue({ number: 3, a: 'alice' }), // no priority set → fails the match
      issue({ number: 4, a: 'bob', p: 'low' }),
      issue({ number: 5, p: 'high' }), // unassigned but matching
    ],
    proposals: [prop({ id: 10, a: 'alice', p: 'high' })],
  }, { ...none, priority: 'high' });
  // bob's only card is low → his group disappears entirely.
  assert.deepEqual(Array.from(r.groups, (g) => g.name), ['alice']);
  assert.equal(r.groups[0].count, 2, 'alice keeps only her two high cards');
  assert.equal(r.unassignedTotal, 1, 'unassigned recounts post-filter');
});

test('assignee filter yields only that user\'s group; unassigned recomputes to zero', () => {
  const AppView = makeAppView();
  const r = pmGroups(AppView, {
    issues: [
      issue({ number: 1, a: 'alice' }),
      issue({ number: 2, a: 'bob' }),
      issue({ number: 3 }), // unassigned → fails an assignee match by design
    ],
    proposals: [prop({ id: 10, a: 'bob' })],
  }, { ...none, assignee: 'bob' });
  assert.deepEqual(Array.from(r.groups, (g) => g.name), ['bob']);
  assert.equal(r.groups[0].count, 2);
  assert.equal(r.unassignedTotal, 0);
});

test('priority and assignee filters combine (intersection)', () => {
  const AppView = makeAppView();
  const r = pmGroups(AppView, {
    issues: [
      issue({ number: 1, a: 'alice', p: 'high' }),
      issue({ number: 2, a: 'alice', p: 'low' }),
      issue({ number: 3, a: 'bob', p: 'high' }),
    ],
    proposals: [],
  }, { ...none, priority: 'high', assignee: 'alice' });
  assert.deepEqual(Array.from(r.groups, (g) => g.name), ['alice']);
  assert.equal(r.groups[0].count, 1, 'only alice\'s high card survives both filters');
});

test('unassigned cap and "+N more" total count post-filter', () => {
  const AppView = makeAppView();
  // 13 unassigned high-priority issues + 5 unassigned low ones. Filtering
  // on high must cap at PM_UNASSIGNED_MAX (10) with a total of 13 — the low
  // cards must not inflate the "+N more" count.
  const issues = [];
  for (let h = 1; h <= 13; h += 1) {
    issues.push(issue({ number: h, p: 'high', updatedAt: at(h), lastMessageAt: at(h) }));
  }
  for (let h = 14; h <= 18; h += 1) {
    issues.push(issue({ number: h, p: 'low', updatedAt: at(h), lastMessageAt: at(h) }));
  }
  const r = pmGroups(AppView, { issues, proposals: [] }, { ...none, priority: 'high' });
  assert.equal(r.unassignedTotal, 13);
  assert.equal(r.unassigned.length, AppView.PM_UNASSIGNED_MAX);
});

// ── _renderPmInner (render-level behaviour) ──────────────────────────────

test('_renderPmInner: empty-state note when active filters match nothing', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [issue({ number: 1, a: 'alice', p: 'low' })];
  AppView._proposals = [];
  AppView._kanbanFilters = { ...none, priority: 'high' };
  const html = AppView._renderPmInner();
  assert.match(html, /No cards match the current filters\./);
  assert.doesNotMatch(html, /Unassigned/, 'empty sections are replaced by the note');
});

test('_renderPmInner: without filters the empty board keeps its original wording', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [];
  AppView._proposals = [];
  AppView._kanbanFilters = { ...none };
  const html = AppView._renderPmInner();
  assert.match(html, /No tasks are assigned to anyone yet\./);
  assert.match(html, /Unassigned/, 'Unassigned section still renders unfiltered');
});

test('_renderPmInner: Unassigned section hidden while a user filter is active', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [
    issue({ number: 1, a: 'alice' }),
    issue({ number: 2 }), // unassigned
  ];
  AppView._proposals = [];
  AppView._kanbanFilters = { ...none, assignee: 'alice' };
  const html = AppView._renderPmInner();
  assert.match(html, /@alice/, 'the filtered user\'s section renders');
  assert.doesNotMatch(html, /Unassigned/);
  assert.doesNotMatch(html, /Issue 2/, 'the unassigned card is gone');
});

test('_renderPmInner: priority filter recounts section headers and drops empty groups', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [
    issue({ number: 1, a: 'alice', p: 'high' }),
    issue({ number: 2, a: 'alice', p: 'low' }),
    issue({ number: 3, a: 'bob', p: 'low' }),
  ];
  AppView._proposals = [];
  AppView._kanbanFilters = { ...none, priority: 'high' };
  const html = AppView._renderPmInner();
  assert.match(html, /@alice/);
  assert.match(html, /· 1/, 'alice\'s header count reflects the filtered card');
  assert.doesNotMatch(html, /@bob/, 'bob has no matching cards');
  assert.doesNotMatch(html, /Issue 2/);
});

// ── PM mount (DOM-level) ─────────────────────────────────────────────────

// Stubbed document + localStorage forcing view mode 'pm'; asserts the PM
// branch of _repaintDevBody now mounts the shared filter bar next to
// #dev-pm, mirroring the kanban shell.
test('_repaintDevBody in PM mode mounts the filter bar alongside #dev-pm', () => {
  const els = new Map();
  const doc = {
    getElementById: (id) => els.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    createElement: () => fakeEl(''),
    body: { appendChild: () => {} },
    activeElement: null,
  };
  els.set('dev-body', containerEl('dev-body', els));
  const AppView = makeCtx({
    document: doc,
    localStorage: { getItem: (k) => (k === 'devViewMode' ? 'pm' : null), setItem: () => {} },
  }).__AppView;
  AppView._ghIssues = [];
  AppView._proposals = [];
  AppView._repaintDevBody();
  assert.ok(els.get('dev-kanban-filterbar'), 'filter bar node is mounted in PM mode');
  assert.ok(els.get('dev-pm'), '#dev-pm container is mounted');
  assert.match(
    els.get('dev-kanban-filterbar').innerHTML,
    /dev-kanban-priority/,
    'priority control rendered'
  );
  assert.match(
    els.get('dev-kanban-filterbar').innerHTML,
    /dev-kanban-assignee/,
    'assignee control rendered'
  );
  assert.match(els.get('dev-pm').innerHTML, /Unassigned/, 'PM body painted');
});
