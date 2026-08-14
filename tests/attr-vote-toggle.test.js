// #1187: the assignee picker is a toggle — clicking the name you already
// voted for withdraws that vote (unassign) instead of re-casting it. Before
// this, once you'd picked someone there was no way to clear the assignment
// from the dropdown: re-clicking re-POSTed the same vote, a silent no-op.
//
// Covered here:
//   1. _renderAttrPopoverBody marks each option row with data-attr-opt-mine
//      so the click handler can tell "my pick" from the rest, and spells the
//      affordance out in a title on the assignee row.
//   2. The click dispatch: a mine assignee row goes to _withdrawAttrVote, any
//      other row (including a mine PRIORITY row — no toggle there) goes to
//      _castAttrVote.
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

// A button stub that records its click listener so the test can fire it.
function fakeBtn(dataset) {
  const btn = fakeEl({ dataset, _click: null });
  btn.addEventListener = (type, fn) => { if (type === 'click') btn._click = fn; };
  return btn;
}

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
  const pop = assigneePop([]);
  sandbox.document = fakeDoc({ 'attr-popover': pop });

  AppView._renderAttrPopoverBody({
    field: 'assignee',
    options: [
      { value: 'alice', count: 2, mine: true },
      { value: 'bob', count: 1, mine: false },
    ],
    myValue: 'alice',
  });

  assert.match(pop.innerHTML, /data-attr-opt-value="alice" data-attr-opt-mine="1" title="/);
  assert.match(pop.innerHTML, /data-attr-opt-value="bob" data-attr-opt-mine="0"/);
});

test('clicking my own assignee pick withdraws; clicking another name casts', () => {
  const { AppView, sandbox } = makeSandbox();
  const mineBtn = fakeBtn({ attrOptValue: 'alice', attrOptMine: '1' });
  const otherBtn = fakeBtn({ attrOptValue: 'bob', attrOptMine: '0' });
  sandbox.document = fakeDoc({ 'attr-popover': assigneePop([mineBtn, otherBtn]) });

  let withdrawals = 0;
  const casts = [];
  AppView._withdrawAttrVote = () => { withdrawals += 1; };
  AppView._castAttrVote = (v) => { casts.push(v); };

  AppView._renderAttrPopoverBody({
    field: 'assignee',
    options: [
      { value: 'alice', count: 2, mine: true },
      { value: 'bob', count: 1, mine: false },
    ],
    myValue: 'alice',
  });

  mineBtn._click();
  assert.equal(withdrawals, 1, 're-clicking my pick deselects it');
  assert.equal(casts.length, 0);

  otherBtn._click();
  assert.deepEqual(casts, ['bob'], 'other names still cast a vote');
  assert.equal(withdrawals, 1);
});

test('priority keeps the idempotent re-vote — no toggle on a mine row', () => {
  const { AppView, sandbox } = makeSandbox();
  const mineBtn = fakeBtn({ attrOptValue: 'high', attrOptMine: '1' });
  sandbox.document = fakeDoc({
    'attr-popover': fakeEl({
      querySelectorAll: (sel) => (sel === '.attr-opt' ? [mineBtn] : []),
    }),
  });

  let withdrawals = 0;
  const casts = [];
  AppView._withdrawAttrVote = () => { withdrawals += 1; };
  AppView._castAttrVote = (v) => { casts.push(v); };

  AppView._renderAttrPopoverBody({
    field: 'priority',
    options: [{ value: 'high', count: 1, mine: true }],
    myValue: 'high',
  });

  mineBtn._click();
  assert.equal(withdrawals, 0);
  assert.deepEqual(casts, ['high']);
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
