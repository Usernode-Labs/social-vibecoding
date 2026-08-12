// Frontend tests for the Proposal-approvals mode pills in the members
// modal (issues #646/#650, bug: "clicking 'At least' does nothing on the
// self-edit app").
//
// The bug: the mode pills' click handler was NOT optimistic by design (the
// real settings only change when the governance PR merges), but it also
// never moved the segmented control — tapping "At least" left
// "Time & majority" highlighted, so the tap read as a dead click. On
// mobile there is additionally no Enter key on the numeric keypad, so the
// old "press Enter to open the proposal" flow could never complete.
//
// The fix, all in app-view.js:
//   - _showMembersGovModeDraft(mode): paints the tapped mode immediately
//     (pill highlight + at-least count input + Propose button reveal)
//     without touching _membersGov — a display-only draft.
//   - a visible #members-approvals-propose button opens the proposal (in
//     addition to Enter), so the flow works on touch keyboards.
//   - _proposeGovernance() repaints from _membersGov when the user cancels
//     the confirm or the proposal fails, so the draft can't misreport the
//     app's real settings.
//
// We load the real app-view.js into a vm context (so the tests can't drift
// from shipped code), give it a small DOM stub that supports the clone-swap
// wiring in _wireMembersModal, and drive clicks.
//
// Run with: node --test tests/members-governance-pills.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);
// The members dialog's behaviour moved into the island's controller in #1078
// chunk I (see its header for why it is a controller and not JSX). The sandbox
// runs it the way init() does in the browser: Object.assign back onto the live
// window.AppView. Evaluated as an expression, because its file-local
// `let AppView` would otherwise collide with app-view.js's top-level const in
// the one lexical scope a vm context shares.
const MEMBERS_SRC = `(function () {\n${
  fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dialogs', 'members-controller.js'),
    'utf8',
  ).replace(/^export \{[^}]*\};$/gm, '').replace(/^export /gm, '')
}\nreturn { init, MembersDialog };\n})()`;
const HTML_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);

// DOM element stub with enough behaviour for _wireMembersModal's
// cloneNode-swap wiring: classList, dataset, listeners, click dispatch.
function makeEl({ id = '', dataset = {}, classes = [] } = {}) {
  const el = {
    id,
    dataset: { ...dataset },
    value: '',
    textContent: '',
    className: classes.join(' '),
    disabled: false,
    _listeners: {},
    _focused: false,
    parentNode: null,
    classList: null,
    focus() { el._focused = true; },
    addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
    dispatch(type, event = {}) {
      (el._listeners[type] || []).forEach((fn) => fn(event));
    },
    cloneNode() {
      const c = makeEl({ id: el.id, dataset: { ...el.dataset } });
      el._set.forEach((cls) => c.classList.add(cls));
      c.value = el.value;
      c.disabled = el.disabled;
      return c;
    },
  };
  const set = new Set(classes);
  el._set = set;
  el.classList = {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => {
      const want = on === undefined ? !set.has(c) : !!on;
      if (want) set.add(c); else set.delete(c);
      return want;
    },
  };
  return el;
}

// A parent that supports replaceChild the way _wireMembersModal uses it,
// re-registering the fresh clone in the harness's element registry.
function makeRegistry() {
  const byId = {};
  const bySelectorGroup = {}; // selector-fragment -> array of elements
  const parent = {
    replaceChild(fresh, old) {
      fresh.parentNode = parent;
      if (old.id) byId[old.id] = fresh;
      for (const group of Object.values(bySelectorGroup)) {
        const i = group.indexOf(old);
        if (i !== -1) group[i] = fresh;
      }
    },
  };
  const register = (el, groupKey) => {
    el.parentNode = parent;
    if (el.id) byId[el.id] = el;
    if (groupKey) (bySelectorGroup[groupKey] ||= []).push(el);
    return el;
  };
  return { byId, bySelectorGroup, register };
}

function makeHarness() {
  const reg = makeRegistry();
  // The elements _wireMembersModal + the governance helpers touch.
  const pillDefault = reg.register(
    makeEl({ dataset: { mApprovalsMode: 'default' } }), 'approvals-mode');
  const pillAtLeast = reg.register(
    makeEl({ dataset: { mApprovalsMode: 'at_least' } }), 'approvals-mode');
  const policyAnyone = reg.register(
    makeEl({ dataset: { mApproverPolicy: 'anyone' } }), 'approver-policy');
  const policyInvited = reg.register(
    makeEl({ dataset: { mApproverPolicy: 'invited' } }), 'approver-policy');
  const nInput = reg.register(makeEl({ id: 'members-approvals-n', classes: ['hidden'] }));
  const proposeBtn = reg.register(makeEl({ id: 'members-approvals-propose', classes: ['hidden'] }));
  const govError = reg.register(makeEl({ id: 'members-governance-error', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-invite-input' }));

  const querySelectorAll = (sel) => {
    let list = [];
    if (sel.includes('data-m-approvals-mode')) list = reg.bySelectorGroup['approvals-mode'] || [];
    else if (sel.includes('data-m-approver-policy')) list = reg.bySelectorGroup['approver-policy'] || [];
    list = [...list];
    list.forEach = Array.prototype.forEach.bind(list);
    return list;
  };

  const fetches = [];
  const confirms = { queue: [], asked: 0 };
  const sandbox = {
    console: { ...console, debug: () => {}, warn: () => {} },
    Date,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    resolveDevHost: (u) => u,
    App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    confirm(msg) {
      confirms.asked += 1;
      return confirms.queue.length ? confirms.queue.shift() : true;
    },
    document: {
      getElementById: (id) => reg.byId[id] || null,
      querySelector: () => null,
      querySelectorAll,
      addEventListener: () => {},
      createElement: () => makeEl(),
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts) => {
      fetches.push({ url, opts });
      return {
        ok: true, status: 201,
        json: async () => ({ ok: true, prNumber: 42 }),
      };
    },
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // Native-kit adoption: the governance confirm gate goes through
  // PlatformUI.confirm now — delegate to the same queued confirm stub
  // so the accept/cancel scenarios keep driving it.
  sandbox.PlatformUI = {
    isTouch: () => false,
    hasKit: () => false,
    toast: () => {},
    alert: async () => ({}),
    confirm: async () => sandbox.confirm(''),
    transition: (fn) => fn(),
    attachScreenFx: () => {},
    detachScreenFx: () => {},
    pullToRefresh: () => ({ detach() {} }),
    swipeActions: () => ({ detach() {} }),
    actionSheet: async () => null,
    gestures: () => null,
  };
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  vm.runInContext(MEMBERS_SRC, sandbox).init();

  const AppView = sandbox.window.AppView;
  AppView.appData = {
    slug: 'usernode-2d5619',
    self_hosted: true,
    can_manage: true,
    repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
    approver_policy: 'invited',
    approvals_required: null,
  };
  // Same state openMembersModal derives before wiring.
  AppView._membersGov = { policy: 'invited', atLeast: null };
  AppView._renderMembersGovPills();
  AppView._wireMembersModal();

  // _wireMembersModal clone-swapped the pills/input/button — read back the
  // live ones from the registry.
  const live = () => ({
    pillDefault: reg.bySelectorGroup['approvals-mode'][0],
    pillAtLeast: reg.bySelectorGroup['approvals-mode'][1],
    nInput: reg.byId['members-approvals-n'],
    proposeBtn: reg.byId['members-approvals-propose'],
    govError: reg.byId['members-governance-error'],
  });

  return { AppView, live, fetches, confirms };
}

// ── the reported bug: tapping "At least" must visibly respond ────────────

test('clicking "At least" switches the segmented control and reveals the count + Propose', () => {
  const h = makeHarness();
  const { pillDefault, pillAtLeast } = h.live();
  assert.equal(pillDefault.classList.contains('active'), true, 'starts on Time & majority');

  pillAtLeast.dispatch('click');

  const l = h.live();
  assert.equal(l.pillAtLeast.classList.contains('active'), true, '"At least" highlights on tap');
  assert.equal(l.pillDefault.classList.contains('active'), false, '"Time & majority" un-highlights');
  assert.equal(l.nInput.classList.contains('hidden'), false, 'count input revealed');
  assert.equal(l.nInput.value, '1', 'count defaults to 1');
  assert.equal(l.nInput._focused, true, 'count input focused');
  assert.equal(l.proposeBtn.classList.contains('hidden'), false, 'Propose button revealed');
  assert.match(l.govError.textContent, /Propose/, 'hint tells the user how to proceed');
  assert.equal(h.fetches.length, 0, 'no proposal opened yet — N not confirmed');
});

test('Propose button opens the governance proposal with the picked N', async () => {
  const h = makeHarness();
  h.live().pillAtLeast.dispatch('click');
  h.live().nInput.value = '3';
  h.live().proposeBtn.dispatch('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.confirms.asked, 1, 'confirm dialog shown');
  assert.equal(h.fetches.length, 1, 'governance-pr POSTed');
  assert.equal(h.fetches[0].url, '/api/apps/usernode-2d5619/governance-pr');
  const body = JSON.parse(h.fetches[0].opts.body);
  assert.equal(body.approvalsRequired, 3);
  assert.equal(body.approverPolicy, 'invited');
});

test('Enter in the count input still opens the proposal', async () => {
  const h = makeHarness();
  h.live().pillAtLeast.dispatch('click');
  h.live().nInput.value = '2';
  h.live().nInput.dispatch('keydown', { key: 'Enter', preventDefault: () => {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetches.length, 1, 'governance-pr POSTed');
  assert.equal(JSON.parse(h.fetches[0].opts.body).approvalsRequired, 2);
});

test('cancelling the confirm snaps the pills back to the real settings', async () => {
  const h = makeHarness();
  h.live().pillAtLeast.dispatch('click');
  h.confirms.queue.push(false); // user cancels
  h.live().proposeBtn.dispatch('click');
  await new Promise((r) => setImmediate(r));
  const l = h.live();
  assert.equal(h.fetches.length, 0, 'no proposal opened');
  assert.equal(l.pillDefault.classList.contains('active'), true, 'back on Time & majority');
  assert.equal(l.pillAtLeast.classList.contains('active'), false);
  assert.equal(l.nInput.classList.contains('hidden'), true, 'count input hidden again');
  assert.equal(l.proposeBtn.classList.contains('hidden'), true, 'Propose hidden again');
});

test('clicking "Time & majority" from an at-least app asks to propose the default mode', async () => {
  const h = makeHarness();
  h.AppView._membersGov = { policy: 'invited', atLeast: 3 };
  h.AppView._renderMembersGovPills();
  const before = h.live();
  assert.equal(before.pillAtLeast.classList.contains('active'), true, 'starts on At least');
  assert.equal(before.proposeBtn.classList.contains('hidden'), false, 'Propose visible for at-least apps');

  before.pillDefault.dispatch('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.fetches.length, 1, 'governance-pr POSTed');
  const body = JSON.parse(h.fetches[0].opts.body);
  assert.equal(body.approvalsRequired, null, 'default mode proposes null (time & majority)');
  const l = h.live();
  assert.equal(l.pillDefault.classList.contains('active'), true, 'tap visibly switched the control');
  assert.equal(l.nInput.classList.contains('hidden'), true, 'count input hidden for default mode');
});

// ── markup contract: the Propose button ships in index.html ─────────────

test('index.html carries the #members-approvals-propose button inside the governance section', () => {
  assert.match(HTML_SRC, /id="members-approvals-propose"/);
  const section = HTML_SRC.slice(
    HTML_SRC.indexOf('id="members-governance-section"'),
    HTML_SRC.indexOf('id="members-approvers-section"')
  );
  assert.match(section, /members-approvals-propose/, 'button lives in the governance section');
});
