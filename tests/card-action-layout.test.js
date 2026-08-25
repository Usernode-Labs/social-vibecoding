// Card action contract (app-view.js) — the CARD-AS-POINTER budget.
//
// #404 routed every action through one flat .gc-card-actions row and
// DELIBERATELY rejected an overflow menu; the original version of this file
// pinned that by asserting the ABSENCE of gc-overflow-btn / gc-action-menu.
// The card-as-pointer revision REVERSES that decision, so this file now pins
// the opposite contract:
//
//   • at most ACTION_PRIMARY_MAX (3) text pills on the card face,
//   • one icon-only Preview affordance (kept as an icon so a read-only
//     viewer, who gets no vote buttons, still has a visible affordance),
//   • one ⋯ trigger carrying every demoted action as a descriptor,
//   • and NO ⋯ at all when a card has nothing to demote.
//
// assertNoOverflowMachinery is gone; assertCardActionContract replaces it.
// Permission rules are unchanged — an action only ever MOVED between the card
// face, the ⋯ menu and the detail view, so every per-viewer-role case from
// the original file is preserved, just re-pointed at wherever the action now
// lives.
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and assert on the markup —
// same harness as archive-proposal-card.test.js. Since #1367's card chunk
// the markup comes from card/dev-card.tsx rendered over the module's view
// model, which ./lib/dev-card-html.js composes.
//
// Run with: node --test tests/card-action-layout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  budgets, cardHtml, govCardHtml, hasAction, issueCardHtml, mergedCardHtml, proposalCardHtml,
} = require('./lib/dev-card-html');

// The two budgets moved to the component with the markup they govern.
const { ACTION_PRIMARY_MAX } = budgets();

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView(userId, opts) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: userId, canAdminWrite: !!(opts && opts.admin) } },
    // Kudos is a CONTROLLER HOST on the card now — the card renders an
    // empty `[data-kudos-host]` and `_fillKudosHosts` writes this in. Its
    // presence is asserted through that host.
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>', attach: () => {} },
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
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.__sandbox = sandbox;
  return AppView;
}

const ME = 42;

// How many text pills the card face actually rendered. The overflow trigger
// and the preview icon both carry .gc-vote-btn-icon, so they don't count.
// The kudos slot DOES: it is a promoted pill like any other, it is just a
// controller host that `_fillKudosHosts` writes the button into.
function primaryCount(html) {
  const row = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>/);
  if (!row) return 0;
  const buttons = row[1].match(/<button[^>]*>/g) || [];
  const kudos = row[1].match(/data-kudos-host=/g) || [];
  return buttons.filter((b) => !/gc-vote-btn-icon/.test(b)).length + kudos.length;
}

// The ⋯ trigger's registry key, or null when the card rendered no menu.
function menuKeyOf(html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  return m ? m[1] : null;
}

// The descriptor labels the card registered, in order.
function menuLabels(AppView, html) {
  const key = menuKeyOf(html);
  if (!key) return [];
  return (AppView._cardMenus[key] || []).map((it) => it.label);
}

// Does the registered menu carry an item whose label matches, and is it
// actionable (has an `act` closure) unless we expected it disabled?
function menuHas(AppView, html, re, opts) {
  const key = menuKeyOf(html);
  if (!key) return false;
  const it = (AppView._cardMenus[key] || []).find((x) => re.test(x.label));
  if (!it) return false;
  if (opts && opts.disabled) return !!it.disabled;
  return !!it.act;
}

// The card-as-pointer budget: at most 2 text pills, and a ⋯ trigger exactly
// when there is something behind it.
function assertCardActionContract(AppView, html, expect) {
  const e = expect || {};
  const n = primaryCount(html);
  assert.ok(n <= ACTION_PRIMARY_MAX,
    `at most ${ACTION_PRIMARY_MAX} text pills on the card face, saw ${n}`);
  if (e.primary !== undefined) {
    assert.equal(n, e.primary, `expected ${e.primary} primary pill(s), saw ${n}`);
  }
  const labels = menuLabels(AppView, html);
  if (e.menu === false) {
    assert.equal(menuKeyOf(html), null, 'no ⋯ trigger when nothing is demoted');
  } else if (e.menu === true) {
    assert.notEqual(menuKeyOf(html), null, '⋯ trigger present');
    assert.ok(labels.length > 0, '⋯ menu carries at least one descriptor');
  }
  if (e.previewIcon !== undefined) {
    const hasIcon = /gc-vote-btn-preview[^>]*gc-vote-btn-icon|gc-vote-btn-icon[^>]*gc-vote-btn-preview/.test(html);
    assert.equal(hasIcon, e.previewIcon,
      e.previewIcon ? 'icon-only Preview affordance present' : 'no Preview affordance');
    // On a dense card the eye is NOT in the action band at all: it is the
    // LAST child of the right-edge rail, i.e. the card's bottom-right corner,
    // under the ⋯ and the chevron. That is what lines every card's preview up
    // down a column — the band's trailing pill would slide left and right with
    // the width of the vote pills before it, and could be clipped by the
    // band's `max-height: 24px`. (`e.previewInBand` opts into the detail
    // head's variant, which keeps it in its uncapped action list.)
    if (hasIcon && !e.previewInBand) {
      const band = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>/);
      assert.ok(!band || !/gc-vote-btn-preview|gc-checks-running-badge|gc-conflict-badge/.test(band[1]),
        'the preview eye is not in the dense action band');
      assert.match(html, /dev-card-rail/, 'the card has a rail to pin it in');
      const rail = html.slice(html.indexOf('dev-card-rail'));
      const pills = (rail.match(/<(?:button|span)\b[^>]*class="[^"]*"/g) || []);
      assert.match(pills[pills.length - 1],
        /gc-vote-btn-preview|gc-checks-running-badge|gc-conflict-badge/,
        'the preview eye is the rail\'s last child — the card\'s bottom-right corner');
    }
  }
  // The demoted actions must NOT also sit on the card face.
  assert.doesNotMatch(html, /gc-card-actions[\s\S]*?>Withdraw</, 'Withdraw is not a card pill');
  assert.doesNotMatch(html, /gc-card-actions[\s\S]*?>Admin merge</, 'Admin merge is not a card pill');
}

// ── The action band (card/dev-card.tsx) ──────────────────────────────────

// A bare model, for the layout-only cases below.
const MODEL = (over) => ({
  key: 'k', cls: 'gc-vote-item', attrs: {}, icon: null,
  title: { text: 'T', title: 'T' }, meta: [], pill: null, linked: [], badges: [],
  chatCount: null, actions: [], rail: { chevron: false }, extra: [],
  dense: true, uncapped: false, ...over,
});
const pill = (label) => ({ key: label, cls: 'gc-vote-btn', label });

test('the action band wraps the primary pills in the shared container', () => {
  const html = cardHtml(MODEL({ actions: [pill('A'), pill('B')] }));
  assert.match(html, /<div class="gc-card-actions">/, 'uses the shared container');
  assert.match(html, />A</);
  assert.match(html, />B</);
});

// The cap is THREE now, not two: the four-band card reserves an action row
// on every card, so one action per thin card type was promoted out of ⋯ to
// fill it and has to fit beside Yes/No. The cap itself is what matters here —
// that a fourth primary is still dropped rather than wrapping the band onto a
// second (clipped) row.
test('the action band caps primaries and appends the preview icon', () => {
  assert.equal(ACTION_PRIMARY_MAX, 3);
  const html = cardHtml(MODEL({
    actions: [pill('A'), pill('B'), pill('C'), pill('D')],
    actionPreview: { state: 'live', sessionId: 1, url: 'u', title: 'p', iconOnly: true },
  }));
  assert.match(html, />A</);
  assert.match(html, />B</);
  assert.match(html, />C</);
  assert.doesNotMatch(html, />D</, 'the fourth primary is dropped — it belongs in ⋯');
  assert.equal(primaryCount(html), ACTION_PRIMARY_MAX);
  assert.match(html, /gc-vote-btn-preview gc-vote-btn-icon/, 'and the eye follows them');
  // The ⋯ is NOT in the action row — it is pinned in the card's rail.
  assert.equal(menuKeyOf(html), null);
});

test('the ⋯ lives in the card\'s top-right RAIL, not in the action row', () => {
  const AppView = makeAppView(ME);
  const model = AppView._proposalCardModel(baseProposal());
  const html = cardHtml(model);
  // The rail is the card's last child: a right-edge column holding the ⋯ at
  // the top and the tap-through chevron centred below it. Sharing one column
  // rather than taking two is what keeps the badge row's width — a separate
  // flex slot for the ⋯ cost 30px of a ~175px row.
  assert.match(html, /dev-card-rail/);
  const rail = html.slice(html.indexOf('dev-card-rail'));
  assert.match(rail, /dev-card-menu-btn/, 'the trigger is inside the rail');
  assert.match(rail, /M9 5l7 7-7 7/, 'and the chevron below it');
  // Never in the action row.
  const actions = html.match(/<div class="gc-card-actions">[\s\S]*?<\/div>/);
  assert.ok(actions && !/data-card-menu/.test(actions[0]),
    'the action row carries only the primary pills');
  assert.match(html, /aria-haspopup="true"/);
  assert.match(html, /aria-label="More actions"/);
});

test('no ⋯ when there is nothing to demote', () => {
  const AppView = makeAppView(ME);
  assert.equal(menuKeyOf(cardHtml(MODEL())), null);
  // _registerCardMenu drops falsy descriptors before deciding, so a caller
  // may inline conditionals without growing a dead trigger.
  assert.equal(AppView._registerCardMenu('k', []), '');
  assert.equal(AppView._registerCardMenu('k', [null, false, undefined]), '');
  assert.equal(menuKeyOf(cardHtml(MODEL({ rail: { chevron: false, menuKey: '' } }))), null);
});

// Only the title is indented beside the type icon. Everything else — the
// meta line included — is a sibling of the head, so it starts at the card's
// own padding edge and gets its full width.
test('the head holds the icon and the title, and nothing else', () => {
  const AppView = makeAppView(ME);
  const html = cardHtml(MODEL({
    icon: AppView._devCardIcon('issue'),
    title: { text: 'The title', title: 'The title' },
    meta: [{ t: 'text', s: 'PR#1 · someone · 2h ago' }],
    badges: [AppView._attrChipSpec('priority', 'issue', 1, { top: 'high', count: 1 }, true)],
    chatCount: 3,
    actions: [pill('a')],
    extra: [{ t: 'note', key: 'n', text: 'note', workState: 'k' }],
  }));
  const head = html.slice(html.indexOf('dev-card-head"'), html.indexOf('dev-card-meta'));
  assert.match(head, /rounded-lg/, 'the icon leads the head');
  assert.match(head, /dev-card-title/, 'the title sits beside it');
  for (const cls of ['dev-card-meta', 'dev-card-badges',
    'gc-card-actions', 'data-work-note']) {
    assert.ok(!head.includes(cls), `${cls} is NOT inside the head`);
  }
  // …and in this order under it, meta first: it is the title's subtitle. The
  // pill no longer has a row of its own (.dev-status-row is retired) — it
  // LEADS the status band, which is the same band the chips ride.
  const order = ['dev-card-head"', 'dev-card-meta', 'dev-card-badges',
    'gc-card-actions', 'data-work-note'];
  const at = order.map((c) => html.indexOf(c));
  assert.ok(at.every((i) => i >= 0), 'every band renders');
  assert.deepEqual(at.slice().sort((a, b) => a - b), at, `bands out of order: ${order}`);
});

// A dense card RESERVES the band even with nothing in it (that is the
// four-band contract); the detail head collapses it instead.
test('the action band: empty renders an empty band, or none on the detail head', () => {
  assert.match(cardHtml(MODEL({ actions: [] })), /<div class="gc-card-actions"><\/div>/);
  assert.doesNotMatch(cardHtml(MODEL({ actions: [], dense: false })), /gc-card-actions/);
});

// ── Issue card ───────────────────────────────────────────────────────────

const baseIssue = (over) => ({ number: 5, title: 'Fix the thing', ...over });

test('issue card: the state-driven primary + the in-progress toggle; kudos / close stay in ⋯', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue());
  const html = cardHtml(model);
  assert.match(html, /gc-card-actions/, 'shared action row present');
  // The state-driven primary for a never-started issue.
  assert.ok(hasAction(model, 'createPrForIssue', 5), 'the primary is wired');
  assert.match(html, />Create proposal</);
  // …plus the promoted claim toggle. The card reserves an action band on
  // every row now, and this issue card had one button to put in it; claiming
  // is what a reader does with an issue before writing any code, and the
  // chip it toggles is right above it in the status band.
  assert.ok(hasAction(model, 'markIssueInProgress', 5), 'the claim toggle is wired');
  assert.match(html, />Claim this issue</);
  assertCardActionContract(AppView, html, { primary: 2, menu: true, previewIcon: false });
  // Generating a headless proposal spends the viewer's credits, so it is a
  // chosen ⋯ action rather than the card's most prominent button.
  assert.ok(menuHas(AppView, html, /^Generate proposal$/), 'Generate proposal in ⋯');
  assert.ok(menuHas(AppView, html, /Pledge kudos/), 'Pledge kudos in ⋯');
  assert.ok(menuHas(AppView, html, /Propose to close/), 'Propose to close in ⋯');
  assert.ok(menuHas(AppView, html, /Set priority/), 'Set priority… in ⋯');
  // Promoted, so it is NOT also a menu row — one action, one place.
  assert.ok(!menuHas(AppView, html, /Claim this issue/),
    'the claim toggle is on the face, so not duplicated in ⋯');
  // …and the ones that stayed demoted are not on the card face.
  assert.ok(!hasAction(model, 'giveIssueBounty'), 'no kudos pill');
  assert.ok(!hasAction(model, 'promptCloseIssue'), 'no close pill');
});

// The other half of the toggle: a claim the viewer already holds renders as
// "Release my claim", keyed off `mine` exactly as the menu row it replaced.
test('issue card: the promoted claim toggle flips to Clear for the viewer\'s own claim', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue({
    in_progress: { claims: [{ mine: true, username: 'me' }] },
  }));
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'clearIssueClaim', 5), 'the release toggle is wired');
  assert.match(html, />Release my claim</);
  assert.ok(!hasAction(model, 'markIssueInProgress'), 'not both states at once');
  assert.ok(!menuHas(AppView, html, /Release my claim/), 'and not duplicated in ⋯');
});

// A read-only viewer can't claim anything, so the promoted button is absent
// exactly like the ⋯ row it replaced (which is itself inside the
// `if (!readOnly)` block) — the promotion changes where an action lives, never
// who may take it.
test('issue card (read-only): no claim pill at all', () => {
  const AppView = makeAppView(ME);
  // AppView.readOnly is a derived getter, so read-only is expressed the only
  // way it can be: through appData.can_collaborate.
  AppView.appData = { slug: 'x', can_collaborate: false };
  const model = AppView._issueCardModel(baseIssue());
  const html = cardHtml(model);
  assert.doesNotMatch(html, /markIssueInProgress|clearIssueClaim/,
    'no claim affordance for a read-only viewer');
  AppView.appData = null;
});

test('issue card: a ready headless run IS the primary, replacing Create proposal', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue({
    headless: { status: 'ready', outcome: 'spec', sessionId: 90 },
  }));
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'startFromAutoSession', 90), 'contextual ready run is the primary');
  assert.match(html, />Review spec/, 'and it wears the contextual label');
  assert.ok(!hasAction(model, 'createPrForIssue'), 'Create proposal is superseded, not stacked beside it');
  // Two primaries: the state-driven one, plus the promoted claim toggle.
  assertCardActionContract(AppView, html, { primary: 2, menu: true });
  assert.ok(menuHas(AppView, html, /Pledge kudos/), 'kudos still reachable, from ⋯');
});

test('issue card: a question outcome folds TWO competing pills into one primary', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue({
    headless: { status: 'ready', outcome: 'question', sessionId: 91 },
  }));
  const html = cardHtml(model);
  // Previously this row rendered the clone action AND a second "Generate
  // proposal" pill side by side. Now: one "Answer & regenerate" primary,
  // with the re-run in ⋯.
  assert.match(html, /Answer &amp; regenerate/, 'single folded primary');
  // Two pills in the band, but only ONE of them is about the headless run: the
  // fold is still a fold. The second is the promoted claim toggle.
  assertCardActionContract(AppView, html, { primary: 2, menu: true });
  assert.ok(menuHas(AppView, html, /^Generate proposal$/), 're-run reachable from ⋯');
});

test('issue card: a run the viewer already cloned offers no competing re-run', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue({
    headless: { status: 'ready', outcome: 'question', sessionId: 91, mySessionId: 92 },
  }));
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'goToAutoSessionClone', 92));
  assert.match(html, />Go to session</);
  assert.ok(!menuHas(AppView, html, /^Generate proposal$/),
    'no re-run beside "Go to session" — the proposal already exists (#150)');
});

test('issue card: a generating run disables the primary and hides Generate', () => {
  const AppView = makeAppView(ME);
  const model = AppView._issueCardModel(baseIssue({
    headless: { status: 'generating', sessionId: 93 },
  }));
  const html = cardHtml(model);
  assert.match(html, /disabled[^>]*>Generating proposal/);
  assert.ok(!menuHas(AppView, html, /^Generate proposal$/), 'nothing to generate while one runs');
});

test('issue card: read-only viewer gets no primary, keeps a read-safe ⋯', () => {
  const AppView = makeAppView(ME);
  AppView.appData = { slug: 'x', can_collaborate: false };
  const model = AppView._issueCardModel(baseIssue({ htmlUrl: 'https://github.com/o/r/issues/5' }));
  const html = cardHtml(model);
  assertCardActionContract(AppView, html, { primary: 0, menu: true });
  // join(), not deepEqual: the vm context has its own Array prototype, so
  // deepStrictEqual on a cross-realm array fails on the prototype alone.
  assert.equal(menuLabels(AppView, html).join('|'), 'Open on GitHub',
    'only the read-safe row survives for a read-only viewer');
  AppView.appData = null;
});

// ── Proposal card ──────────────────────────────────────────────────────────

const baseProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'me',
  user_id: 999, status: 'promoted', yes_count: 0, no_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

test('proposal card: Yes/No lead the band, with Explore promoted beside them', () => {
  const AppView = makeAppView(ME);
  const model = AppView._proposalCardModel(baseProposal());
  const html = cardHtml(model);
  assert.match(html, /gc-vote-btn-yes/);
  assert.ok(hasAction(model, 'castVote', 7, 'yes'));
  assert.match(html, /gc-vote-btn-no/);
  assert.ok(hasAction(model, 'castVote', 7, 'no'));
  // Three primaries — the whole reason ACTION_PRIMARY_MAX went 2 → 3. Yes/No
  // stay first so the vote is still what the eye lands on; Explore fills the
  // reserved band's remaining width instead of hiding behind ⋯.
  assert.match(html, /gc-explore-chat-btn/, 'Explore promoted onto the face');
  assertCardActionContract(AppView, html, { primary: 3, menu: true });
});

test('proposal card: read-only viewer keeps the icon Preview and loses Yes/No', () => {
  const AppView = makeAppView(ME);
  AppView.appData = { slug: 'x', can_collaborate: false };
  const model = AppView._proposalCardModel(baseProposal({ staging_url: 'https://stg.example' }));
  const html = cardHtml(model);
  assert.ok(!hasAction(model, 'castVote'), 'no vote buttons for a read-only viewer');
  // The whole reason Preview is an icon: without it this card would carry no
  // visible affordance at all for someone who cannot vote.
  assertCardActionContract(AppView, html, { primary: 0, previewIcon: true });
  assert.match(html, /aria-label="Open preview"/, 'the icon has a real accessible name');
  AppView.appData = null;
});

test('proposal card (admin, not author): Admin merge / kudos stay in ⋯, Explore does not', () => {
  const AppView = makeAppView(ME, { admin: true });
  const model = AppView._proposalCardModel(baseProposal({ staging_url: 'https://stg.example' }));
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'swapToStagingForSession', 7), 'Preview present, as the icon');
  assertCardActionContract(AppView, html, { primary: 3, menu: true, previewIcon: true });
  assert.ok(menuHas(AppView, html, /Admin merge/), 'Admin merge in ⋯');
  assert.ok(menuHas(AppView, html, /kudos/i), 'kudos in ⋯');
  // One action, one place: Explore is on the face now, so its ⋯ row is gone.
  assert.match(html, /gc-explore-chat-btn/, 'Explore pill on the card face');
  assert.ok(!menuHas(AppView, html, /Explore in dev chat/),
    'and therefore NOT also a ⋯ row');
});

test('proposal card (author): Open session + Withdraw move to ⋯', () => {
  const AppView = makeAppView(ME);
  const model = AppView._proposalCardModel(baseProposal({ user_id: ME }));
  const html = cardHtml(model);
  assert.ok(menuHas(AppView, html, /Open session/), 'Open session in ⋯');
  assert.ok(menuHas(AppView, html, /Withdraw/), 'Withdraw in ⋯');
  assert.ok(!menuHas(AppView, html, /Explore in dev chat/),
    'owners reach the Mayor via Open session, so no Explore row on their own PR');
  assertCardActionContract(AppView, html, { primary: 2, menu: true });
});

// #1045 was about the owner of an IMPORTED proposal: there is no in-app
// session behind it, so "Open session" must not render — and precisely
// because of that, Explore's promotion DOES reach this card. "An owner
// reaches the Mayor from their own session" (#313/#827) has no session to
// point at here, so without the pill the owner of a PR they imported gets
// no AI affordance at all. _showExplorePill is the shared predicate:
// not-mine OR mine-but-imported gets the pill, live cards on the face.
test('proposal card (author of an imported PR): Withdraw in ⋯, no session, Explore on the face', () => {
  const AppView = makeAppView(ME);
  const model = AppView._proposalCardModel(baseProposal({ user_id: ME, source: 'imported' }));
  const html = cardHtml(model);
  assert.ok(menuHas(AppView, html, /Withdraw/), 'Withdraw in ⋯');
  assert.ok(!menuHas(AppView, html, /Open session/), 'no dev session behind an imported PR');
  assert.match(html, /gc-explore-chat-btn/,
    'Explore promoted onto the face — the owner\'s only AI affordance (#1045)');
  assert.ok(!menuHas(AppView, html, /Explore in dev chat/),
    'one action, one place: on the face means no ⋯ row');
  assert.match(html, /gc-card-actions/, 'shared action row present');
  assertCardActionContract(AppView, html, { primary: 3, menu: true });
});

// ── Governance card ──────────────────────────────────────────────────────

const baseGov = (over) => ({
  id: 11, kind: 'secret_change', title: 'Set API key', up_count: 0, down_count: 0,
  created_by: 999, created_at: '2026-06-01T00:00:00Z', ...over,
});

test('gov card: Yes/No are the primaries, Admin merge + Withdraw go to ⋯', () => {
  const AppView = makeAppView(ME, { admin: true });
  const model = AppView._govCardModel(baseGov({ created_by: ME }));
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'castIssueVote', 11, 'up'), 'castIssueVote');
  assert.ok(hasAction(model, 'castIssueVote', 11, 'down'), 'castIssueVote');
  assertCardActionContract(AppView, html, { primary: 2, menu: true });
  assert.ok(menuHas(AppView, html, /Admin merge/), 'Admin merge in ⋯');
  assert.ok(menuHas(AppView, html, /Withdraw/), 'Withdraw in ⋯');
});

test('gov card: a settled row renders the frozen pill and NO ⋯', () => {
  const AppView = makeAppView(ME, { admin: true });
  const model = AppView._govCardModel(baseGov({
    status: 'applied', payload: { issueNumber: 5, appliedAt: '2026-06-02T00:00:00Z', required: 3 },
    kind: 'close_issue',
  }));
  const html = cardHtml(model);
  assert.ok(!hasAction(model, 'castIssueVote'), 'the vote is history');
  assertCardActionContract(AppView, html, { primary: 0, menu: false });
});

test('gov card: non-admin non-creator sees only yes/no, and no ⋯ at all', () => {
  const AppView = makeAppView(ME);
  const model = AppView._govCardModel(baseGov());
  const html = cardHtml(model);
  assert.ok(hasAction(model, 'castIssueVote', 11, 'up'), 'castIssueVote');
  assert.ok(!menuHas(AppView, html, /Admin merge/), 'no admin merge for non-admin');
  assert.ok(!menuHas(AppView, html, /Withdraw/), 'no withdraw for non-creator');
  // Nothing to demote → no dead ⋯ button.
  assertCardActionContract(AppView, html, { primary: 2, menu: false });
});

// ── Merged card ────────────────────────────────────────────────────────────

const baseMerged = (over) => ({
  id: 8, pr_number: 800, pr_title: 'Ship it', username: 'someone', user_id: 999,
  status: 'merged', yes_count: 3, no_count: 1, chat_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

// A merged card has no vote to take, so its reserved action band would sit
// empty. Kudos is what a reader actually wants to do with a change that landed,
// so it is the one promoted onto this card's face.
test('merged card: kudos is the single promoted pill; Undo / Explore stay in ⋯', () => {
  const AppView = makeAppView(ME);
  const model = AppView._mergedCardModel(baseMerged({ my_vote: 'yes' }), 1);
  const html = cardHtml(model);
  // The "You voted X" box is gone from the card face — the pill's tooltip
  // and the detail view's vote roster carry that now.
  assert.doesNotMatch(html, /gc-vote-voted-box/, 'no "You voted X" box on the board');
  assertCardActionContract(AppView, html, { primary: 1, menu: true });
  // Kudos is a controller host: the card renders the slot, and
  // `_fillKudosHosts` writes Kudos.renderButton's markup into it.
  assert.match(html, /gc-card-actions[\s\S]*?data-kudos-host="8"/,
    'the kudos slot fills the band');
  assert.ok(menuHas(AppView, html, /Undo/), 'Undo in ⋯');
  assert.ok(!menuHas(AppView, html, /kudos/i), 'kudos is on the face, so not also in ⋯');
  assert.ok(menuHas(AppView, html, /Explore in dev chat/), 'Explore in dev chat in ⋯');
});

// Read-only: the promotion moves an action, it does not grant one.
test('merged card (read-only): no kudos pill, band still rendered', () => {
  const AppView = makeAppView(ME);
  AppView.appData = { slug: 'x', can_collaborate: false };
  const model = AppView._mergedCardModel(baseMerged(), 1);
  const html = cardHtml(model);
  assertCardActionContract(AppView, html, { primary: 0 });
  assert.match(html, /gc-card-actions/, 'the band is reserved even when empty');
  AppView.appData = null;
});

test('merged card: revert status reads on the META LINE, not as an action', () => {
  const AppView = makeAppView(ME);
  const model = AppView._mergedCardModel(baseMerged({
    revert_session_id: 9, revert_status: 'merged', revert_pr_number: 900,
  }), 1);
  const html = cardHtml(model);
  assert.match(html, /dev-card-meta[\s\S]*?Undone by PR#900/,
    'the revert relationship is a FACT about the change, so it lives in the meta line');
  assert.ok(!menuHas(AppView, html, /^Undo$/), 'no Undo once a revert exists');
});

// ── voteButtonsHtml: group-chat collapsed-vote path unchanged ──────────────

test('voteButtonsHtml: collapseVoted returns the read-only "You voted X" box', () => {
  const AppView = makeAppView(ME);
  const yes = AppView.voteButtonsHtml(baseProposal({ my_vote: 'yes' }), { collapseVoted: true });
  assert.match(yes, /gc-vote-voted-box gc-vote-voted-box-yes/);
  assert.match(yes, />You voted Yes</);
  // A non-promoted PR with no vote collapses to nothing.
  const none = AppView.voteButtonsHtml(baseProposal({ status: 'merged' }), { collapseVoted: true });
  assert.equal(none, '');
});

test('voteButtonsHtml: full set concatenates Preview/Yes/No/Admin (group-chat row)', () => {
  const AppView = makeAppView(ME, { admin: true });
  // voteButtonsHtml is NOT the card's builder — it is the group chat's
  // inline activity row, the work drawer and the home strip, all still
  // innerHTML surfaces. It keeps its onclick attributes.
  const html = AppView.voteButtonsHtml(baseProposal({ staging_url: 'https://stg' }));
  assert.match(html, /swapToStagingForSession/, 'Preview');
  assert.match(html, /castVote\(7, 'yes'\)/, 'Yes');
  assert.match(html, /castVote\(7, 'no'\)/, 'No');
  assert.match(html, /castAdminMerge\(7\)/, 'Admin merge');
});

test('native vote controls and request carry the exact rendered revision', async () => {
  const AppView = makeAppView(ME);
  const head = 'a'.repeat(40);
  const html = AppView.voteButtonsHtml(baseProposal({ reviewed_head_sha: head }));
  assert.match(html, new RegExp(`castVote\\(7, 'yes', '${head}'\\)`));
  assert.match(html, new RegExp(`castVote\\(7, 'no', '${head}'\\)`));
  const importedHtml = AppView.voteButtonsHtml(baseProposal({
    source: 'imported', reviewed_head_sha: head, imported_pr_head_sha: 'b'.repeat(40),
  }));
  assert.doesNotMatch(importedHtml, new RegExp(head),
    'imported proposals keep their established imported-head vote flow');

  let request = null;
  AppView.__sandbox.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await AppView.castVote(7, 'yes', head);
  assert.equal(request.url, '/api/sessions/7/vote');
  assert.deepEqual(JSON.parse(request.options.body), {
    vote: 'yes', expectedHeadSha: head,
  });
});
