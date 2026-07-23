// Frontend tests for the reworked Approvers section + the
// initial-approvers draft step in the members modal (spec: "hide the
// misleading approvers empty state under Everyone, and set up the
// roster when switching to Invited approvers").
//
// Behaviour under test, all in app-view.js:
//   - _renderApprovers() now owns the section's visibility: under the
//     default 'anyone' policy an EMPTY roster hides the whole section
//     (the old "No approvers yet. Invite one below." was misleading
//     there); leftover rows show it with a dormant-roster note; under
//     'invited' the empty state names the platform-admin fallback.
//   - Tapping "Invited approvers" on an 'anyone' app reveals the
//     inline "Initial approvers" draft (no confirm, no POST) whose
//     Propose button opens the proposal with `initialApprovers`.
//   - Cancel / repaint-from-real-settings collapses the draft; the
//     'anyone' pill keeps the confirm-then-POST flow.
//
// Same harness pattern as tests/members-governance-pills.test.js: the
// real app-view.js runs in a vm context against a small DOM stub that
// supports _wireMembersModal's cloneNode-swap wiring.
//
// Run with: node --test tests/members-approvers-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);
const HTML_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);

// DOM element stub with enough behaviour for the clone-swap wiring plus
// the innerHTML-then-querySelectorAll pattern the list renderers use.
function makeEl({ id = '', dataset = {}, classes = [] } = {}) {
  const el = {
    id,
    dataset: { ...dataset },
    value: '',
    textContent: '',
    innerHTML: '',
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
    querySelectorAll() {
      const a = [];
      a.forEach = Array.prototype.forEach.bind(a);
      return a;
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

function makeRegistry() {
  const byId = {};
  const bySelectorGroup = {};
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

function makeHarness({ appData = {} } = {}) {
  const reg = makeRegistry();
  reg.register(makeEl({ dataset: { mApprovalsMode: 'default' } }), 'approvals-mode');
  reg.register(makeEl({ dataset: { mApprovalsMode: 'at_least' } }), 'approvals-mode');
  reg.register(makeEl({ dataset: { mApproverPolicy: 'anyone' } }), 'approver-policy');
  reg.register(makeEl({ dataset: { mApproverPolicy: 'invited' } }), 'approver-policy');
  reg.register(makeEl({ id: 'members-approvals-n', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-approvals-propose', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-governance-error', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-invite-input' }));
  reg.register(makeEl({ id: 'members-approver-invite-input' }));
  // Approvers section + dormant note.
  reg.register(makeEl({ id: 'members-approvers-section', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-approvers-list' }));
  reg.register(makeEl({ id: 'members-approvers-dormant-note', classes: ['hidden'] }));
  // Initial-approvers draft block.
  reg.register(makeEl({ id: 'members-initial-approvers', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-initial-approvers-status' }));
  reg.register(makeEl({ id: 'members-initial-approvers-list' }));
  reg.register(makeEl({ id: 'members-initial-approver-input' }));
  reg.register(makeEl({ id: 'members-initial-approver-suggestions', classes: ['hidden'] }));
  reg.register(makeEl({ id: 'members-initial-approvers-propose' }));
  reg.register(makeEl({ id: 'members-initial-approvers-cancel' }));

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
    confirm() {
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
        json: async () => ({ ok: true, prNumber: 42, approvers: [] }),
      };
    },
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  // Native-kit adoption: the governance confirm gate goes through
  // PlatformUI.confirm — delegate to the queued confirm stub above.
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
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);

  const AppView = sandbox.window.AppView;
  AppView.appData = {
    slug: 'demo-app',
    self_hosted: false,
    can_manage: true,
    can_collaborate: true,
    repo_url: 'https://github.com/o/r',
    approver_policy: 'anyone',
    approvals_required: null,
    ...appData,
  };
  AppView._membersGov = {
    policy: AppView.appData.approver_policy === 'invited' ? 'invited' : 'anyone',
    atLeast: null,
  };
  AppView._renderMembersGovPills();
  AppView._wireMembersModal();

  const live = () => ({
    policyAnyone: reg.bySelectorGroup['approver-policy'][0],
    policyInvited: reg.bySelectorGroup['approver-policy'][1],
    section: reg.byId['members-approvers-section'],
    list: reg.byId['members-approvers-list'],
    dormantNote: reg.byId['members-approvers-dormant-note'],
    draftBlock: reg.byId['members-initial-approvers'],
    draftStatus: reg.byId['members-initial-approvers-status'],
    draftInput: reg.byId['members-initial-approver-input'],
    draftPropose: reg.byId['members-initial-approvers-propose'],
    draftCancel: reg.byId['members-initial-approvers-cancel'],
    govError: reg.byId['members-governance-error'],
  });

  return { AppView, live, fetches, confirms };
}

const MEMBER_ROW = { userId: 7, username: 'zoe', status: 'member' };

// ── section visibility + empty-state copy ────────────────────────────────

test("'anyone' policy + empty roster hides the whole Approvers section", () => {
  const h = makeHarness();
  h.live().section.classList.remove('hidden'); // simulate a stale open state
  h.AppView._approversData = { approvers: [], approverPolicy: 'anyone', creatorId: 1 };
  h.AppView._renderApprovers([]);
  assert.equal(h.live().section.classList.contains('hidden'), true, 'section hidden');
  assert.equal(h.live().dormantNote.classList.contains('hidden'), true, 'no dormant note');
});

test("'anyone' policy + leftover rows shows the section with the dormant note", () => {
  const h = makeHarness();
  h.AppView._approversData = { approvers: [MEMBER_ROW], approverPolicy: 'anyone', creatorId: 1 };
  h.AppView._renderApprovers([MEMBER_ROW]);
  const l = h.live();
  assert.equal(l.section.classList.contains('hidden'), false, 'section shown for leftover rows');
  assert.equal(l.dormantNote.classList.contains('hidden'), false, 'dormant note shown');
  assert.match(l.list.innerHTML, /@zoe/, 'the dormant row renders');
});

test("'invited' policy + empty roster names the platform-admin fallback (no 'Invite one below')", () => {
  const h = makeHarness({ appData: { approver_policy: 'invited' } });
  h.AppView._approversData = { approvers: [], approverPolicy: 'invited', creatorId: 1 };
  h.AppView._renderApprovers([]);
  const l = h.live();
  assert.equal(l.section.classList.contains('hidden'), false, 'section shown under invited');
  assert.equal(l.dormantNote.classList.contains('hidden'), true, 'no dormant note under invited');
  assert.match(l.list.innerHTML, /platform admins can approve proposals/);
  assert.doesNotMatch(l.list.innerHTML, /Invite one below/);
});

test("'invited' policy + roster renders without the dormant note", () => {
  const h = makeHarness({ appData: { approver_policy: 'invited' } });
  h.AppView._approversData = { approvers: [MEMBER_ROW], approverPolicy: 'invited', creatorId: 1 };
  h.AppView._renderApprovers([MEMBER_ROW]);
  const l = h.live();
  assert.equal(l.section.classList.contains('hidden'), false);
  assert.equal(l.dormantNote.classList.contains('hidden'), true);
  assert.match(l.list.innerHTML, /@zoe/);
});

// ── the initial-approvers draft step ─────────────────────────────────────

test('tapping "Invited approvers" on an anyone app reveals the draft — no confirm, no POST', () => {
  const h = makeHarness();
  h.AppView._approversData = { approvers: [], approverPolicy: 'anyone', creatorId: 1 };
  h.live().policyInvited.dispatch('click');
  const l = h.live();
  assert.equal(l.draftBlock.classList.contains('hidden'), false, 'draft revealed');
  assert.match(l.draftStatus.textContent, /You'll automatically become this app's first approver/);
  assert.equal(l.policyInvited.classList.contains('active'), true, 'tapped pill highlights');
  assert.equal(h.confirms.asked, 0, 'no confirm dialog');
  assert.equal(h.fetches.length, 0, 'no POST yet');
});

test('the draft status line names the creator when the actor is an admin, and the admin fallback on the self-app', () => {
  const h = makeHarness();
  h.AppView._approversData = { approvers: [], approverPolicy: 'anyone', creatorId: 99 };
  h.live().policyInvited.dispatch('click');
  assert.match(h.live().draftStatus.textContent, /creator will automatically become the first approver/);

  const hs = makeHarness({ appData: { self_hosted: true } });
  hs.AppView._approversData = { approvers: [], approverPolicy: 'anyone', creatorId: null };
  hs.live().policyInvited.dispatch('click');
  assert.match(hs.live().draftStatus.textContent, /Platform admins can approve proposals/);
});

test('an existing roster is listed in the draft status line', () => {
  const h = makeHarness();
  h.AppView._approversData = { approvers: [MEMBER_ROW], approverPolicy: 'anyone', creatorId: 1 };
  h.live().policyInvited.dispatch('click');
  assert.match(h.live().draftStatus.textContent, /Current approvers stay in place: @zoe/);
});

test('Propose POSTs initialApprovers without a confirm and collapses the draft', async () => {
  const h = makeHarness();
  h.AppView._approversData = { approvers: [], approverPolicy: 'anyone', creatorId: 1 };
  h.live().policyInvited.dispatch('click');
  h.AppView._addDraftApprover('alice');
  h.AppView._addDraftApprover('@Alice'); // dedupes case-insensitively
  h.AppView._addDraftApprover('bob');
  h.live().draftPropose.dispatch('click');
  await new Promise((r) => setImmediate(r));

  assert.equal(h.confirms.asked, 0, 'the Propose button IS the consent');
  const post = h.fetches.find((f) => f.url === '/api/apps/demo-app/governance-pr');
  assert.ok(post, 'governance-pr POSTed');
  const body = JSON.parse(post.opts.body);
  assert.equal(body.approverPolicy, 'invited');
  assert.equal(body.approvalsRequired, null);
  assert.deepEqual(body.initialApprovers, ['alice', 'bob']);
  assert.equal(h.live().draftBlock.classList.contains('hidden'), true, 'draft collapsed on success');
  assert.match(h.live().govError.textContent, /Proposal opened \(PR #42\)/);
  assert.ok(
    h.fetches.some((f) => f.url === '/api/apps/demo-app/approvers'),
    'roster refetched so the fresh invites appear'
  );
});

test('Cancel collapses the draft and repaints from the real settings', () => {
  const h = makeHarness();
  h.AppView._approversData = { approvers: [], approverPolicy: 'anyone', creatorId: 1 };
  h.live().policyInvited.dispatch('click');
  assert.equal(h.live().draftBlock.classList.contains('hidden'), false);
  h.live().draftCancel.dispatch('click');
  const l = h.live();
  assert.equal(l.draftBlock.classList.contains('hidden'), true, 'draft collapsed');
  assert.equal(l.policyAnyone.classList.contains('active'), true, 'back on Everyone');
  assert.equal(l.policyInvited.classList.contains('active'), false);
  assert.equal(h.fetches.length, 0, 'nothing proposed');
  assert.equal(h.AppView._govDraftApprovers.length, 0, 'draft list cleared');
});

test('switching back to Everyone keeps the confirm-then-POST flow', async () => {
  const h = makeHarness({ appData: { approver_policy: 'invited' } });
  h.live().policyAnyone.dispatch('click');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.confirms.asked, 1, 'confirm dialog shown');
  assert.equal(h.fetches.length, 1, 'governance-pr POSTed');
  const body = JSON.parse(h.fetches[0].opts.body);
  assert.equal(body.approverPolicy, 'anyone');
  assert.equal(body.initialApprovers, undefined, 'no initialApprovers for this path');
});

test('tapping "Invited approvers" when the policy is already invited does nothing', () => {
  const h = makeHarness({ appData: { approver_policy: 'invited' } });
  h.live().policyInvited.dispatch('click');
  assert.equal(h.live().draftBlock.classList.contains('hidden'), true, 'no draft');
  assert.equal(h.fetches.length, 0, 'no POST (no-change early return)');
});

// ── markup contract ──────────────────────────────────────────────────────

test('index.html carries the draft block in the governance section and the dormant note in the approvers section', () => {
  const govSection = HTML_SRC.slice(
    HTML_SRC.indexOf('id="members-governance-section"'),
    HTML_SRC.indexOf('id="members-approvers-section"')
  );
  assert.match(govSection, /id="members-initial-approvers"/);
  assert.match(govSection, /id="members-initial-approvers-propose"/);
  assert.match(govSection, /id="members-initial-approvers-cancel"/);
  const approversSection = HTML_SRC.slice(HTML_SRC.indexOf('id="members-approvers-section"'));
  assert.match(approversSection, /id="members-approvers-dormant-note"/);
});
