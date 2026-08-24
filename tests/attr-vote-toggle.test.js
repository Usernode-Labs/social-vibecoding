// #1187: the assignee picker is a toggle — clicking the name you already
// voted for withdraws that vote (unassign) instead of re-casting it. Before
// this, once you'd picked someone there was no way to clear the assignment
// from the dropdown: re-clicking re-POSTed the same vote, a silent no-op.
//
// Covered here:
//   1. _renderAttrPopoverBody marks each option row with data-attr-opt-mine
//      so the row can tell "my pick" from the rest, and spells the affordance
//      out in a title on the assignee row.
//   2. The click dispatch: a mine assignee row goes to _withdrawAttrVote, any
//      other row (including a mine PRIORITY row — no toggle there) goes to
//      _castAttrVote.
//
// #1191 split those two across the seam: the module publishes the view model
// (1) and features/dev-board/attr-popover.tsx draws it and carries the click
// (2), so each half is checked where it lives — the model in the vm sandbox
// below, the row by rendering it and invoking its onClick for real.
//   3. _withdrawAttrVote DELETEs the caller's vote and repaints chips + the
//      open popover from the refreshed tally, mirroring _castAttrVote.
//   4. Source guard: the DELETE route feeds linkedIssues into clearVote so a
//      proposal's inherited issue votes survive in the response the popover
//      repaints from.
//
// Same vm-context harness as attr-vote-repaint.test.js.
//
// Run with: node --test tests/attr-vote-toggle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const POPOVER = 'frontend/src/features/dev-board/attr-popover.tsx';

// Invoke a row's onClick against a stubbed AppView, and report which method it
// reached. This is the dispatch the delegated listener used to do.
function clickRow(option, field) {
  const { AttrOptionRow } = loadTsx(POPOVER);
  const calls = [];
  const previous = global.window;
  global.window = {
    AppView: {
      _withdrawAttrVote: () => calls.push(['withdraw']),
      _castAttrVote: (v) => calls.push(['cast', v]),
    },
  };
  try {
    AttrOptionRow({ option, field }).props.onClick();
  } finally {
    if (previous === undefined) delete global.window; else global.window = previous;
  }
  return calls;
}

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// A minimal fake DOM node. Extend per test with whatever the code reads.
function fakeEl(extra) {
  const el = {
    innerHTML: '',
    style: {},
    value: '',
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    focus: () => {},
    select: () => {},
    removed: false,
  };
  el.remove = () => { el.removed = true; };
  return Object.assign(el, extra || {});
}

// `fakeBtn` lived here — a button stub that recorded the click listener
// `_renderAttrPopoverBody` bound to it, so a test could fire it. The rows are
// a component with an onClick prop now, which `clickRow` above invokes
// directly; there is no listener to intercept.

function fakeDoc(ids) {
  return {
    getElementById: (id) => (ids && ids[id]) || null,
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    createElement: () => fakeEl(),
    body: { appendChild: () => {} },
  };
}

function makeSandbox() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1, username: 'viewer' }, currentSubTab: 'dev' },
    PlatformUI: { toast: () => {} },
    document: fakeDoc({}),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    innerWidth: 1000,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, sandbox };
}

// A popover element wired for the assignee branch of _renderAttrPopoverBody:
// the option buttons come back from querySelectorAll, the name-box controls
// from querySelector.
function assigneePop(optBtns) {
  const inputs = {
    '#attr-assignee-input': fakeEl(),
    '#attr-assignee-add': fakeEl(),
    '#attr-assignee-suggest': fakeEl(),
  };
  return fakeEl({
    querySelectorAll: (sel) => (sel === '.attr-opt' ? optBtns : []),
    querySelector: (sel) => inputs[sel] || null,
  });
}

test('option rows carry data-attr-opt-mine, and the mine assignee row a deselect title', () => {
  const { AppView, sandbox } = makeSandbox();
  const published = [];
  sandbox.document = fakeDoc({ 'attr-popover': assigneePop([]) });
  sandbox.UsernodeReact = { devBoard: { publishAttrPopover: (p) => published.push(p) } };

  AppView._renderAttrPopoverBody({
    field: 'assignee',
    options: [
      { value: 'alice', count: 2, mine: true },
      { value: 'bob', count: 1, mine: false },
    ],
    myValue: 'alice',
  });

  // The module's half: which row is the viewer's.
  const view = JSON.parse(JSON.stringify(published.pop()));
  assert.equal(view.phase, 'ready');
  assert.deepEqual(view.groups[0].options.map((o) => [o.value, o.mine]),
    [['alice', true], ['bob', false]]);

  // The component's half: the attributes and the title that state it.
  const html = renderComponent(POPOVER, 'AttrPopoverView', { ...view, suggestions: [] });
  assert.match(html, /data-attr-opt-value="alice" data-attr-opt-mine="1" title="Click again to remove your pick"/);
  assert.match(html, /data-attr-opt-value="bob" data-attr-opt-mine="0"/);
  assert.ok(!/data-attr-opt-mine="0"[^>]*title=/.test(html), 'and only on the mine row');
});

test('clicking my own assignee pick withdraws; clicking another name casts', () => {
  assert.deepEqual(
    clickRow({ value: 'alice', dot: null, label: 'alice', count: 2, mine: true }, 'assignee'),
    [['withdraw']],
    're-clicking my pick deselects it',
  );
  assert.deepEqual(
    clickRow({ value: 'bob', dot: null, label: 'bob', count: 1, mine: false }, 'assignee'),
    [['cast', 'bob']],
    'other names still cast a vote',
  );
});

test('priority keeps the idempotent re-vote — no toggle on a mine row', () => {
  assert.deepEqual(
    clickRow({ value: 'high', dot: 'bg-red-500/10 text-red-500', label: 'High', count: 1, mine: true }, 'priority'),
    [['cast', 'high']],
    'a mine priority row re-casts rather than withdrawing',
  );
  // …and it carries no deselect title, because there is no deselect.
  const html = renderComponent(POPOVER, 'AttrPopoverView', {
    phase: 'ready',
    field: 'priority',
    groups: [{
      head: 'Priority',
      divided: false,
      options: [{ value: 'high', dot: 'bg-red-500/10 text-red-500', label: 'High', count: 1, mine: true }],
    }],
    emptyNote: null,
    add: null,
    suggestions: [],
  });
  assert.ok(!html.includes('title='), 'no toggle affordance is offered');
  assert.match(html, /<span class="attr-dot bg-red-500\/10 text-red-500"><\/span>High/);
});

test('_withdrawAttrVote DELETEs the vote and repaints from the refreshed tally', async () => {
  const { AppView, sandbox } = makeSandbox();
  AppView._attrPopover = { field: 'assignee', targetType: 'issue', targetRef: 7, slug: 'my-app' };

  const refreshed = { field: 'assignee', options: [{ value: 'bob', count: 1, mine: false }], myValue: null };
  let fetched = null;
  sandbox.fetch = async (url, opts) => {
    fetched = { url, opts };
    return { ok: true, json: async () => refreshed };
  };

  const applied = [];
  let refreshes = 0;
  let rendered = null;
  AppView._applyAttrSummary = (...args) => { applied.push(args); };
  AppView._refreshAttrCards = () => { refreshes += 1; };
  AppView._renderAttrPopoverBody = (data) => { rendered = data; };

  await AppView._withdrawAttrVote();

  assert.equal(fetched.opts.method, 'DELETE');
  assert.equal(fetched.url, '/api/apps/my-app/topics/issue/7/attributes?field=assignee');
  assert.deepEqual(applied, [['issue', 7, 'assignee', refreshed]]);
  assert.equal(refreshes, 1, 'chips repaint from the refreshed tally');
  assert.equal(rendered, refreshed, 'the still-open popover repaints too');
});

test('_withdrawAttrVote surfaces a failed DELETE as a toast, repaints nothing', async () => {
  const { AppView, sandbox } = makeSandbox();
  AppView._attrPopover = { field: 'assignee', targetType: 'issue', targetRef: 7, slug: 'my-app' };
  sandbox.fetch = async () => ({ ok: false, json: async () => ({ error: 'nope' }) });

  let toasted = null;
  sandbox.PlatformUI.toast = (msg) => { toasted = msg; };
  let refreshes = 0;
  AppView._refreshAttrCards = () => { refreshes += 1; };

  await AppView._withdrawAttrVote();
  assert.equal(toasted, 'nope');
  assert.equal(refreshes, 0);
});

// ── Source guards ────────────────────────────────────────────────────────

test('DELETE route feeds linkedIssues into clearVote (proposal-inherited tally)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'topic-attributes.js'), 'utf8');
  const del = src.slice(src.indexOf("router.delete('/api/apps/:slug/topics"));
  assert.match(del, /linkedIssuesFor\(pool, app\.id, t\)/,
    'the DELETE handler resolves the proposal\'s linked issues');
  assert.match(del, /attrs\.clearVote\([\s\S]*?linkedIssues[\s\S]*?\)/,
    'and passes them into clearVote so the refreshed tally keeps inherited votes');
});
