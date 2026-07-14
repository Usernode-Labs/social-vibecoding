// PM view-mode: AppView._groupByAssignee() folds the cached dev data into a
// project-manager's assignment overview:
//
//   groups          — one per person with ≥1 assigned open task, ordered by
//                     count desc then name asc; items within a group are
//                     newest-activity first
//   unassigned      — open work with no assignee, newest-first, capped to
//                     PM_UNASSIGNED_MAX (10)
//   unassignedTotal — the pre-cap count, for the "+N more unassigned" note
//
// Only open issues + open proposals are passed in; merged + governance are
// excluded by the caller (_renderPmInner), never reaching this helper.
//
// The helper is pure (data in → groups out, no DOM, no AppView state), so we
// load app-view.js into a vm context the same way dev-kanban-buckets does and
// call it directly with synthetic rows.
//
// Run with: node --test tests/dev-pm-groups.test.js

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
// document / localStorage so the view-mode helpers can be exercised too.
function makeCtx(over) {
  const o = over || {};
  const sandbox = {
    matchMedia: o.matchMedia,
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: o.document || {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: o.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: o.localStorage || { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox;
}

function makeAppView() {
  return makeCtx().__AppView;
}

// Distinct, non-equal activity timestamps so recency ordering is unambiguous.
const at = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00Z`;

// `a` is the top-voted assignee display name (null/omitted → unassigned).
const issue = (over) => ({
  number: over.number, title: `Issue ${over.number}`,
  updatedAt: over.updatedAt || at(1), lastMessageAt: over.lastMessageAt || at(1),
  headless: null,
  assignee: over.a === undefined ? null : { top: over.a, count: 1, myValue: null },
  ...over,
});
const prop = (over) => ({
  id: over.id, pr_number: over.id * 10, pr_title: `PR ${over.id}`,
  username: 'me', user_id: 1, status: 'promoted', linked_issues: [],
  created_at: over.created_at || at(1), promoted_at: over.promoted_at || at(1),
  last_message_at: over.last_message_at || at(1),
  assignee: over.a === undefined ? null : { top: over.a, count: 1, myValue: null },
  ...over,
});

// Compare across the vm realm boundary by stable scalar keys.
const namesOf = (groups) => Array.from(groups, (g) => g.name);
const countsOf = (groups) => Array.from(groups, (g) => g.count);
// A group's items tagged as "issue#N" / "proposal#id" in order.
const tagOf = (c) => (c.kind === 'issue' ? `issue#${c.item.number}` : `proposal#${c.item.id}`);
const tagsOf = (items) => Array.from(items, tagOf);

test('groups cards by assignee; unassigned collected separately', () => {
  const AppView = makeAppView();
  const r = AppView._groupByAssignee({
    issues: [
      issue({ number: 1, a: 'alice' }),
      issue({ number: 2, a: 'bob' }),
      issue({ number: 3 }), // unassigned
    ],
    proposals: [
      prop({ id: 10, a: 'alice' }),
      prop({ id: 11 }), // unassigned
    ],
  });
  assert.deepEqual(namesOf(r.groups).sort(), ['alice', 'bob']);
  const alice = r.groups.find((g) => g.name === 'alice');
  assert.equal(alice.count, 2);
  assert.deepEqual(tagsOf(alice.items).sort(), ['issue#1', 'proposal#10']);
  assert.deepEqual(tagsOf(r.unassigned).sort(), ['issue#3', 'proposal#11']);
  assert.equal(r.unassignedTotal, 2);
});

test('assignee grouping is case-insensitive; first-seen casing is the display name', () => {
  const AppView = makeAppView();
  const r = AppView._groupByAssignee({
    issues: [
      issue({ number: 1, a: 'Evan', updatedAt: at(3) }),
      issue({ number: 2, a: 'evan', updatedAt: at(2) }),
      issue({ number: 3, a: 'EVAN', updatedAt: at(1) }),
    ],
    proposals: [],
  });
  assert.equal(r.groups.length, 1, 'all three collapse into one group');
  assert.equal(r.groups[0].name, 'Evan', 'first-encountered casing wins');
  assert.equal(r.groups[0].count, 3);
});

test('groups ordered by count desc, then name asc; unassigned excluded from groups', () => {
  const AppView = makeAppView();
  const r = AppView._groupByAssignee({
    issues: [
      issue({ number: 1, a: 'carol' }),
      issue({ number: 2, a: 'carol' }),
      issue({ number: 3, a: 'alice' }),
      issue({ number: 4, a: 'bob' }),
      issue({ number: 5 }),
    ],
    proposals: [],
  });
  // carol=2 first; alice/bob tie at 1 → alphabetical.
  assert.deepEqual(namesOf(r.groups), ['carol', 'alice', 'bob']);
  assert.deepEqual(countsOf(r.groups), [2, 1, 1]);
});

test('items within a group are newest-activity first (issue + proposal timestamps)', () => {
  const AppView = makeAppView();
  const r = AppView._groupByAssignee({
    issues: [
      issue({ number: 1, a: 'alice', updatedAt: at(1), lastMessageAt: at(1) }),
      issue({ number: 2, a: 'alice', updatedAt: at(5), lastMessageAt: at(2) }),
    ],
    proposals: [
      prop({ id: 10, a: 'alice', promoted_at: at(4), last_message_at: at(9) }),
    ],
  });
  const alice = r.groups.find((g) => g.name === 'alice');
  // Recency keys: issue#2 = max(5,2)=5; proposal#10 = max(4,9)=9; issue#1 = 1.
  assert.deepEqual(tagsOf(alice.items), ['proposal#10', 'issue#2', 'issue#1']);
});

test('unassigned sorted newest-first and capped to PM_UNASSIGNED_MAX with overflow count', () => {
  const AppView = makeAppView();
  assert.equal(AppView.PM_UNASSIGNED_MAX, 10);
  // 13 unassigned issues, hours 1..13 → newest (13) first, capped at 10.
  const issues = [];
  for (let h = 1; h <= 13; h += 1) {
    issues.push(issue({ number: h, updatedAt: at(h), lastMessageAt: at(h) }));
  }
  const r = AppView._groupByAssignee({ issues, proposals: [] });
  assert.equal(r.groups.length, 0);
  assert.equal(r.unassignedTotal, 13);
  assert.equal(r.unassigned.length, 10);
  // Newest ten: issues 13 down to 4.
  assert.deepEqual(
    Array.from(r.unassigned, (c) => c.item.number),
    [13, 12, 11, 10, 9, 8, 7, 6, 5, 4]
  );
});

test('empty / null-top assignees count as unassigned', () => {
  const AppView = makeAppView();
  const r = AppView._groupByAssignee({
    issues: [
      { number: 1, updatedAt: at(1), lastMessageAt: at(1), assignee: { top: null } },
      { number: 2, updatedAt: at(2), lastMessageAt: at(2), assignee: { top: '   ' } },
      { number: 3, updatedAt: at(3), lastMessageAt: at(3) }, // no assignee field
    ],
    proposals: [],
  });
  assert.equal(r.groups.length, 0);
  assert.equal(r.unassignedTotal, 3);
});

test('missing / non-array inputs are tolerated', () => {
  const AppView = makeAppView();
  const r = AppView._groupByAssignee();
  assert.equal(r.groups.length, 0);
  assert.equal(r.unassigned.length, 0);
  assert.equal(r.unassignedTotal, 0);
});

// ── View-mode plumbing: 'pm' round-trips and routes ──────────────────────

test("_setViewMode / _getViewMode round-trip the 'pm' value", () => {
  let stored = null;
  const ctx = makeCtx({
    localStorage: { getItem: () => stored, setItem: (_k, v) => { stored = v; } },
  });
  const AppView = ctx.__AppView;
  AppView._setViewMode('pm');
  assert.equal(stored, 'pm');
  assert.equal(AppView._getViewMode(), 'pm');
  // An unknown value still falls back to 'list' via _setViewMode's coercion.
  AppView._setViewMode('bogus');
  assert.equal(stored, 'list');
});

test("_repaintDevBody routes 'pm' to the PM branch (mounts #dev-pm, calls _repaintPmView)", () => {
  let stored = 'pm';
  // A tiny DOM double: #dev-body exists; #dev-pm is created on first mount.
  const nodes = {};
  const makeNode = () => ({ innerHTML: '', classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => ({ forEach() {} }), addEventListener() {} });
  nodes['dev-body'] = makeNode();
  const document = {
    getElementById: (id) => nodes[id] || null,
    querySelector: () => null,
    querySelectorAll: () => ({ forEach() {} }),
    addEventListener() {},
    createElement: () => makeNode(),
    body: { appendChild() {} },
  };
  const ctx = makeCtx({
    document,
    localStorage: { getItem: () => stored, setItem: (_k, v) => { stored = v; } },
  });
  const AppView = ctx.__AppView;

  let pmCalls = 0;
  let kanbanCalls = 0;
  AppView._repaintPmView = () => { pmCalls += 1; };
  AppView._repaintKanbanBoard = () => { kanbanCalls += 1; };
  // Setting #dev-body's innerHTML in the pm branch should create #dev-pm.
  Object.defineProperty(nodes['dev-body'], 'innerHTML', {
    set(v) { if (String(v).includes('dev-pm')) nodes['dev-pm'] = makeNode(); },
    get() { return ''; },
  });

  AppView._repaintDevBody();
  assert.equal(pmCalls, 1, 'PM branch invoked');
  assert.equal(kanbanCalls, 0, 'kanban branch not invoked');
});
