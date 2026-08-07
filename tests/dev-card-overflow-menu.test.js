// The card overflow (⋯) menu — app-view.js _cardMenuTriggerHtml /
// _toggleCardMenu / the per-card-type descriptor builders.
//
// #404 deliberately rejected an overflow menu and every action sat inline.
// The card-as-pointer revision reverses that, so this file pins the menu's
// contract: descriptors (not HTML) so one list renders as both an anchored
// dropdown and a touch action sheet, a stable registry key per card, no
// trigger when there is nothing to demote, and the SAME permission rules the
// pills had — an action only ever MOVED.
//
// Run with: node --test tests/dev-card-overflow-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'), 'utf8');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

const ME = 42;

function makeAppView(opts) {
  const o = opts || {};
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: o.userId != null ? o.userId : ME, canAdminWrite: !!o.admin } },
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>',
      attach: () => {}, _ensureCache: () => ({ count: 0 }), give: () => {}, retract: () => {} },
    PlatformUI: { isTouch: () => !!o.touch, actionSheet: (spec) => { sandbox.__sheet = spec; },
      toast: () => {} },
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
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: o.majority != null ? o.majority : 3 };
  AppView._mergedCtx = { majority: 3 };
  AppView._visualsOpen = new Set();
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  if (o.readOnly) AppView.appData = { slug: 'x', can_collaborate: false };
  AppView.__sandbox = sandbox;
  return AppView;
}

const PR = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'someone',
  user_id: 999, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  yes_count: 0, no_count: 0, ...over,
});

function menuKeyOf(html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  return m ? m[1] : null;
}
function menuItems(AppView, html) {
  const k = menuKeyOf(html);
  return k ? (AppView._cardMenus[k] || []) : [];
}
function menuLabels(AppView, html) {
  return menuItems(AppView, html).map((it) => it.label);
}

const ISSUE = (over) => ({ number: 5, title: 'Fix the thing', ...over });
const GOV = (over) => ({
  id: 11, kind: 'secret_change', title: 'Set API key', up_count: 0, down_count: 0,
  created_by: 999, created_at: '2026-06-01T00:00:00Z', ...over,
});

// ── The trigger ─────────────────────────────────────────────────────────

test('no ⋯ trigger when there is nothing to demote', () => {
  const AppView = makeAppView();
  assert.equal(AppView._cardMenuTriggerHtml('k', []), '');
  assert.equal(AppView._cardMenuTriggerHtml('k', null), '');
  // Falsy entries are dropped, so callers can inline conditionals.
  assert.equal(AppView._cardMenuTriggerHtml('k', [null, false, undefined]), '');
});

test('the trigger registers its descriptors under a stable key', () => {
  const AppView = makeAppView();
  const html = AppView._cardMenuTriggerHtml('proposal:7', [{ label: 'A', act: () => {} }]);
  assert.match(html, /data-card-menu="proposal:7"/);
  assert.match(html, /aria-haspopup="true"/);
  assert.match(html, /aria-label="More actions"/);
  assert.match(html, /gc-vote-btn-icon/, 'the icon pill variant, so it never outsizes a text pill');
  assert.match(html, /dev-card-menu-btn/, 'and the corner-placement class');
  assert.equal(AppView._cardMenus['proposal:7'].length, 1);
});

test('the trigger is pinned in the top-right RAIL on every card type that has one', () => {
  const AppView = makeAppView({ admin: true });
  AppView._sharedById = {};
  const cards = {
    proposal: AppView._renderProposalCard(PR()),
    issue: AppView._renderIssueRow(ISSUE({ htmlUrl: 'https://gh/i/5' })),
    gov: AppView._renderGovCard(GOV()),
    merged: AppView._renderMergedCard(PR({ status: 'merged', chat_count: 0 }), 3),
    session: AppView._renderMySessionCard({ id: 51, session_title: 'Mine', status: 'active' }),
  };
  for (const [kind, html] of Object.entries(cards)) {
    assert.match(html, /dev-card-head-main/, `${kind}: uses the shared head`);
    // The rail is the card's LAST child — a right-edge column with the ⋯ on
    // top and the chevron centred below.
    assert.match(html, /dev-card-rail/, `${kind}: rail present`);
    const rail = html.slice(html.indexOf('dev-card-rail'));
    assert.match(rail, /dev-card-menu-btn/, `${kind}: trigger inside the rail`);
    // Never inside the badge row (where the 💬 lives) or the action row.
    const actions = html.match(/<div class="gc-card-actions">[\s\S]*?<\/div>/);
    if (actions) {
      assert.ok(!/data-card-menu/.test(actions[0]),
        `${kind}: the trigger is in the rail, not the action row`);
    }
    const badgeRow = html.match(/<div class="flex flex-wrap items-center gap-x-2 gap-y-1">[\s\S]*?<\/div>\s*<\/div>/);
    if (badgeRow) {
      assert.ok(!/data-card-menu/.test(badgeRow[0]),
        `${kind}: the trigger cannot collide with the 💬 badge`);
    }
  }
});

test('a card with no ⋯ still gets its chevron, with no empty rail around it', () => {
  const AppView = makeAppView();
  // A shared session demotes nothing, so _cardRailHtml returns the bare
  // chevron rather than a one-child column.
  const html = AppView._renderSharedSessionCard({
    id: 71, session_title: 'Theirs', username: 'them', user_id: 9,
  });
  assert.equal(menuKeyOf(html), null);
  assert.doesNotMatch(html, /dev-card-rail/);
  assert.match(html, /M9 5l7 7-7 7/, 'the chevron survives on its own');
});

test('an applied close-issue card has no ⋯ and no action row at all', () => {
  const AppView = makeAppView();
  const html = AppView._renderCompletedCloseIssueCard({
    id: 9, chat_count: 0, created_at: '2026-06-01T00:00:00Z', up_count: 2, down_count: 0,
    payload: { issueNumber: 5, issueTitle: 'T', appliedAt: '2026-06-02T00:00:00Z', appliedBy: 'group-vote', required: 2 },
  });
  assert.equal(menuKeyOf(html), null);
  assert.doesNotMatch(html, /gc-card-actions/);
  assert.match(html, /dev-status-row/, 'but it does get the full-width pill');
});

test('a repaint under the same key OVERWRITES rather than accumulating', () => {
  const AppView = makeAppView();
  AppView._cardMenuTriggerHtml('proposal:7', [{ label: 'A', act: () => {} }]);
  AppView._cardMenuTriggerHtml('proposal:7', [{ label: 'B', act: () => {} }, { label: 'C', act: () => {} }]);
  assert.equal(AppView._cardMenus['proposal:7'].map((i) => i.label).join('|'), 'B|C');
});

test('the registry resets rather than growing without bound', () => {
  const AppView = makeAppView();
  AppView._cardMenuSeq = 4001;
  AppView._cardMenus['stale:1'] = [{ label: 'old' }];
  AppView._cardMenuTriggerHtml(null, [{ label: 'fresh', act: () => {} }]);
  assert.equal(AppView._cardMenus['stale:1'], undefined, 'the runaway backstop cleared it');
  assert.equal(AppView._cardMenuSeq, 1);
});

// ── Per-card-type × per-viewer-role allocation ──────────────────────────

test('proposal, foreign, plain collaborator', () => {
  const AppView = makeAppView();
  const labels = menuLabels(AppView, AppView._renderProposalCard(PR()));
  assert.ok(!labels.some((l) => /Admin merge/.test(l)), 'not an admin');
  assert.ok(!labels.some((l) => /Open session|Withdraw/.test(l)), 'not the author');
  assert.ok(labels.some((l) => /Explore in dev chat/.test(l)));
  assert.ok(labels.some((l) => /kudos/i.test(l)));
  assert.ok(labels.some((l) => /Set priority/.test(l)));
});

test('proposal, platform admin: Admin merge is offered and marked danger', () => {
  const AppView = makeAppView({ admin: true });
  const html = AppView._renderProposalCard(PR());
  const item = menuItems(AppView, html).find((i) => /Admin merge/.test(i.label));
  assert.ok(item, 'offered');
  assert.ok(item.danger, 'a vote bypass is a danger row');
  assert.match(item.title, /bypassing the vote/);
});

test('proposal, app admin: Admin merge, except on an admins-changing PR', () => {
  const AppView = makeAppView();
  AppView._proposalsCtx = { majority: 3, isAppAdmin: true };
  const ordinary = menuLabels(AppView, AppView._renderProposalCard(PR()));
  assert.ok(ordinary.some((l) => /Admin merge/.test(l)), 'app admins may force-merge');
  // Self-escalation carve-out: an app admin cannot force-merge a proposal
  // that edits the admins block.
  const escalating = menuLabels(AppView, AppView._renderProposalCard(
    PR({ requires_explicit_approval: true })));
  assert.ok(!escalating.some((l) => /Admin merge/.test(l)));
});

test('proposal, author: Open session + Withdraw, and no Explore', () => {
  const AppView = makeAppView();
  const labels = menuLabels(AppView, AppView._renderProposalCard(PR({ user_id: ME })));
  assert.ok(labels.some((l) => /Open session/.test(l)));
  assert.ok(labels.some((l) => /^Withdraw$/.test(l)));
  assert.ok(!labels.some((l) => /Explore in dev chat/.test(l)));
});

test('proposal, author, imported PR: no Open session (there is no in-app session)', () => {
  const AppView = makeAppView();
  const labels = menuLabels(AppView, AppView._renderProposalCard(
    PR({ user_id: ME, source: 'imported' })));
  assert.ok(!labels.some((l) => /Open session/.test(l)));
});

test('proposal, read-only viewer: only read-safe rows survive', () => {
  const AppView = makeAppView({ readOnly: true, admin: true });
  const labels = menuLabels(AppView, AppView._renderProposalCard(PR({ pr_url: 'https://gh/pr/7' })));
  assert.equal(labels.join('|'), 'View PR on GitHub');
});

test('proposal: Retry preview only after a preview error', () => {
  const AppView = makeAppView();
  assert.ok(!menuLabels(AppView, AppView._renderProposalCard(PR({ staging_url: 'https://s' })))
    .some((l) => /Retry preview/.test(l)));
  assert.ok(menuLabels(AppView, AppView._renderProposalCard(PR({ staging_error: 'boom' })))
    .some((l) => /Retry preview/.test(l)));
});

test('proposal: Before/after only when captures exist, and it opens the detail view', () => {
  const AppView = makeAppView();
  assert.ok(!menuLabels(AppView, AppView._renderProposalCard(PR()))
    .some((l) => /Before\/after/.test(l)));
  const withVisuals = AppView._renderProposalCard(PR({
    // A real capture set: 32-hex artifact ids are what the tile renderer accepts.
    visuals: { before: { png: 'a'.repeat(32) }, after: { png: 'b'.repeat(32) } },
  }));
  const item = menuItems(AppView, withVisuals).find((i) => /Before\/after/.test(i.label));
  assert.ok(item, 'offered when there is something to show');
  // The captures live on the detail view now; the row pre-expands them there.
  let opened = null;
  AppView.openTopic = (kind, id) => { opened = [kind, id]; };
  item.act();
  assert.ok(AppView._visualsOpen.has(7), 'pre-expanded');
  assert.equal(opened.join(':'), 'proposal:7');
});

test('merged proposal: Undo, and never twice over a revert', () => {
  const AppView = makeAppView();
  const merged = (over) => PR({ status: 'merged', chat_count: 0, ...over });
  assert.ok(menuLabels(AppView, AppView._renderMergedCard(merged(), 3))
    .some((l) => /^Undo$/.test(l)));
  // Undoing a revert would be an infinite undo-undo loop.
  assert.ok(!menuLabels(AppView, AppView._renderMergedCard(merged({ revert_of_session_id: 4 }), 3))
    .some((l) => /^Undo$/.test(l)));
  // A revert already exists — its status reads on the meta line instead.
  assert.ok(!menuLabels(AppView, AppView._renderMergedCard(
    merged({ revert_session_id: 9, revert_pr_number: 900 }), 3))
    .some((l) => /^Undo$/.test(l)));
});

test('issue: the full demoted set, and Open on GitHub last', () => {
  const AppView = makeAppView();
  const labels = menuLabels(AppView, AppView._renderIssueRow(
    ISSUE({ htmlUrl: 'https://gh/i/5' })));
  assert.equal(labels[0], 'Generate proposal');
  assert.ok(labels.some((l) => /Pledge kudos/.test(l)));
  assert.ok(labels.some((l) => /Mark in progress/.test(l)));
  assert.ok(labels.some((l) => /Propose to close/.test(l)));
  assert.equal(labels[labels.length - 1], 'Open on GitHub');
});

test('issue: a disabled row still EXPLAINS itself rather than vanishing', () => {
  const AppView = makeAppView();
  // An open close proposal: the row stays, disabled, saying why.
  AppView._govProposals = [{ kind: 'close_issue', status: 'open', payload: { issueNumber: 5 } }];
  const closed = menuItems(AppView, AppView._renderIssueRow(ISSUE()))
    .find((i) => /Close proposed/.test(i.label));
  assert.ok(closed.disabled);
  assert.match(closed.title, /up for vote/);
  assert.ok(!closed.act, 'a disabled row carries no handler');

  // Weekly kudos allowance spent.
  AppView._govProposals = [];
  AppView._ghIssuesMeta = { myRemaining: 0 };
  const kudos = menuItems(AppView, AppView._renderIssueRow(ISSUE()))
    .find((i) => /Pledge kudos/.test(i.label));
  assert.ok(kudos.disabled);
  assert.match(kudos.title, /allowance spent/);
});

test('gov: Admin merge / View campaign / Withdraw by role', () => {
  const AppView = makeAppView({ admin: true });
  const mine = menuLabels(AppView, AppView._renderGovCard(GOV({ created_by: ME })));
  assert.equal(mine.join('|'), 'Admin merge|Withdraw');

  const campaign = menuLabels(AppView, AppView._renderGovCard(GOV({
    kind: 'maintenance_campaign', payload: { campaignId: 3 },
  })));
  assert.equal(campaign.join('|'), 'Admin merge|View campaign');

  // A rename proposal is not admin-appliable, so a non-creator admin gets
  // nothing and therefore no ⋯ at all.
  const rename = AppView._renderGovCard(GOV({ kind: 'rename', payload: { newName: 'X' } }));
  assert.equal(menuKeyOf(rename), null);
});

test('own session: visibility, chat-sharing, discussion and Archive', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 2 } };
  const sess = (over) => ({ id: 51, session_title: 'Mine', status: 'active', ...over });

  const priv = menuLabels(AppView, AppView._renderMySessionCard(sess()));
  assert.equal(priv.join('|'), 'Make visible|Archive',
    'a private session has nowhere for a reader to reach its chat from');

  const vis = menuLabels(AppView, AppView._renderMySessionCard(
    sess({ shared_at: '2026-06-01T00:00:00Z' })));
  assert.equal(vis.join('|'), 'Hide|Share chat|Open public discussion (2)|Archive');

  const shared = menuItems(AppView, AppView._renderMySessionCard(
    sess({ shared_at: '2026-06-01T00:00:00Z', transcript_shared_at: '2026-06-01T01:00:00Z' })));
  assert.ok(shared.some((i) => /Chat shared/.test(i.label)));
  assert.ok(shared.find((i) => /Archive/.test(i.label)).danger, 'Archive is a danger row');
});

// ── Presentation: dropdown vs action sheet ──────────────────────────────

test('touch presents the SAME descriptors as an action sheet', () => {
  const AppView = makeAppView({ touch: true });
  let ran = false;
  AppView._cardMenus['k'] = [
    { label: 'Do it', icon: 'merge', act: () => { ran = true; } },
    { label: 'Inert', icon: 'close', disabled: true },
    { label: 'Nuke', icon: 'withdraw', danger: true, act: () => {} },
  ];
  AppView._toggleCardMenu({ dataset: { cardMenu: 'k' }, setAttribute: () => {} });
  const sheet = AppView.__sandbox.__sheet;
  assert.ok(sheet, 'an action sheet was presented, not an anchored dropdown');
  // Disabled rows carry no handler, so they are not offered as sheet actions.
  // The kit's sheet takes a plain string per row, so the descriptor's icon
  // rides in as a label prefix — the SAME glyph the dropdown draws in its
  // leading column, resolved from the one descriptor.
  const I = AppView.MENU_ICONS;
  assert.equal(sheet.actions.map((a) => a.label).join('|'),
    `${I.merge}  Do it|${I.withdraw}  Nuke`);
  assert.equal(sheet.actions[1].destructive, true);
  sheet.actions[0].handler();
  assert.ok(ran, 'the descriptor\'s own closure runs');
  assert.equal(AppView._openCardMenu, null, 'no dropdown state on the touch path');
});

test('a menu with no actionable rows still presents nothing on touch', () => {
  const AppView = makeAppView({ touch: true });
  AppView.__sandbox.__sheet = null;
  AppView._cardMenus['empty'] = [];
  AppView._toggleCardMenu({ dataset: { cardMenu: 'empty' }, setAttribute: () => {} });
  assert.equal(AppView.__sandbox.__sheet, null);
});

// ── Leading icons ───────────────────────────────────────────────────────
//
// One vocabulary, keyed by MEANING and resolved from the descriptor, so the
// anchored dropdown and the touch sheet cannot drift apart and the same
// action wears the same glyph on every card type.

// Every descriptor a card can produce, across all five card types and the
// roles that unlock the privileged rows.
function everyDescriptor(AppView) {
  AppView._sharedById = { 51: { id: 51, chat_count: 2 } };
  const out = [];
  const collect = (html) => out.push(...menuItems(AppView, html));
  collect(AppView._renderProposalCard(PR({
    pr_url: 'https://gh/pr/7', staging_error: 'boom',
    visuals: { before: { png: 'a'.repeat(32) }, after: { png: 'b'.repeat(32) } },
  })));
  collect(AppView._renderProposalCard(PR({ user_id: ME, pr_url: 'https://gh/pr/7' })));
  collect(AppView._renderMergedCard(PR({ status: 'merged', chat_count: 0, pr_url: 'https://gh/pr/7' }), 3));
  collect(AppView._renderIssueRow(ISSUE({ htmlUrl: 'https://gh/i/5' })));
  collect(AppView._renderIssueRow(ISSUE({
    number: 6, htmlUrl: 'https://gh/i/6', my_bounty: 1,
    in_progress: { claims: [{ mine: true }] },
  })));
  collect(AppView._renderGovCard(GOV({ created_by: ME })));
  collect(AppView._renderGovCard(GOV({ kind: 'maintenance_campaign', payload: { campaignId: 3 } })));
  collect(AppView._renderMySessionCard({ id: 51, session_title: 'Mine', status: 'active' }));
  collect(AppView._renderMySessionCard({
    id: 51, session_title: 'Mine', status: 'active',
    shared_at: '2026-06-01T00:00:00Z', transcript_shared_at: '2026-06-01T01:00:00Z',
  }));
  return out;
}

test('every descriptor on every card type declares an icon from the vocabulary', () => {
  const AppView = makeAppView({ admin: true });
  const all = everyDescriptor(AppView);
  assert.ok(all.length > 20, `expected the full descriptor inventory, got ${all.length}`);
  const missing = all.filter((it) => !it.icon).map((it) => it.label);
  assert.deepEqual(missing, [], 'no row falls back to the default bullet');
  const unknown = all.filter((it) => !AppView.MENU_ICONS[it.icon])
    .map((it) => `${it.label} → ${it.icon}`);
  assert.deepEqual(unknown, [], 'every icon key resolves in MENU_ICONS');
});

test('the same action wears the same glyph on every card type', () => {
  const AppView = makeAppView({ admin: true });
  const byLabel = new Map();
  for (const it of everyDescriptor(AppView)) {
    const glyph = AppView._menuIconGlyph(it);
    if (byLabel.has(it.label)) {
      assert.equal(byLabel.get(it.label), glyph, `${it.label} drifted between card types`);
    }
    byLabel.set(it.label, glyph);
  }
  // The three that genuinely repeat across card types.
  assert.equal(byLabel.get('Admin merge'), AppView.MENU_ICONS.merge);
  assert.equal(byLabel.get('Withdraw'), AppView.MENU_ICONS.withdraw);
  assert.equal(byLabel.get('View PR on GitHub'), AppView.MENU_ICONS.github);
  assert.equal(byLabel.get('Open on GitHub'), AppView.MENU_ICONS.github);
});

test('an unknown or absent icon key still gets a glyph, so the column never collapses', () => {
  const AppView = makeAppView();
  assert.equal(AppView._menuIconGlyph({ label: 'x' }), AppView.MENU_ICONS.default);
  assert.equal(AppView._menuIconGlyph({ label: 'x', icon: 'nope' }), AppView.MENU_ICONS.default);
});

test('the dropdown draws the glyph in a decorative leading column', () => {
  const AppView = makeAppView();
  let menuEl = null;
  const sandbox = AppView.__sandbox;
  sandbox.document.createElement = () => (menuEl = {
    className: '', innerHTML: '', style: {}, offsetWidth: 200, offsetHeight: 120,
    setAttribute: () => {}, addEventListener: () => {},
    querySelector: () => null,
  });
  sandbox.window.innerWidth = 1280;
  sandbox.window.innerHeight = 800;
  AppView._cardMenus['k'] = [{ label: 'Withdraw', icon: 'withdraw', danger: true, act: () => {} }];
  AppView._toggleCardMenu({
    dataset: { cardMenu: 'k' }, setAttribute: () => {},
    getBoundingClientRect: () => ({ top: 100, bottom: 120, right: 400, left: 380 }),
  });
  assert.ok(menuEl, 'a dropdown was built');
  assert.match(menuEl.innerHTML,
    new RegExp(`<span class="dev-card-menu-icon" aria-hidden="true">${AppView.MENU_ICONS.withdraw}</span>`),
    'glyph in its own aria-hidden span');
  assert.match(menuEl.innerHTML, /<span class="dev-card-menu-label">Withdraw<\/span>/,
    'the LABEL is still the accessible name — the glyph is not part of it');
});

test('the ✨ that used to live inside the Explore label is now its icon', () => {
  const AppView = makeAppView();
  const item = menuItems(AppView, AppView._renderProposalCard(PR()))
    .find((i) => /Explore in dev chat/.test(i.label));
  assert.equal(item.label, 'Explore in dev chat', 'no glyph baked into the label');
  assert.equal(AppView._menuIconGlyph(item), AppView.MENU_ICONS.explore);
});
