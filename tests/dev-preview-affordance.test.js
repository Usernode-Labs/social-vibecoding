// The ONE preview affordance (app-view.js cardPreviewHtml).
//
// "Preview" used to be built in four separate places with four different
// tooltips and four different gating rules — proposal cards (via
// voteButtonsHtml), the viewer's own session cards, other users' shared
// session cards, and the headless branch of an issue card. All four already
// funnelled into swapToStagingForSession(id, url), so the differences were
// wording and which of staging_url / can_preview / staging_building /
// staging_error each consulted. This file pins the single truth table.
//
// The board renders it ICON-ONLY on purpose: a read-only viewer gets no vote
// buttons, so the icon is the only visible "you can go and look at this" on
// their card. Dropping it would leave them a card with no affordance at all.
//
// Run with: node --test tests/dev-preview-affordance.test.js

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


// ── The three states ────────────────────────────────────────────────────

test('live: an interactive icon button wired to swapToStagingForSession', () => {
  const AppView = makeAppView();
  const html = AppView.cardPreviewHtml({ id: 7, staging_url: 'https://stg.example' },
    { kind: 'proposal', sessionId: 7 });
  assert.match(html, /^<button/, 'interactive');
  assert.match(html, /gc-vote-btn-preview/);
  assert.match(html, /gc-vote-btn-icon/, 'icon-only on the board');
  assert.match(html, /aria-label="Open preview"/, 'a real accessible name, not just a glyph');
  assert.match(html, /swapToStagingForSession\(7, 'https:\/\/stg\.example'\)/);
  assert.doesNotMatch(html, />Preview</, 'no text label in the icon variant');
});

test('building: a NON-interactive span, not a disabled button', () => {
  const AppView = makeAppView();
  const html = AppView.cardPreviewHtml({ id: 7, staging_building: true }, { sessionId: 7 });
  assert.match(html, /^<span/, 'a span — there is nothing to click through to yet');
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /dc-status-spinner-arc/);
  assert.match(html, /aria-label="Preview building"/);
  assert.match(html, /few minutes/, 'the tooltip says how long');
});

test('unavailable: a non-interactive span carrying the captured reason', () => {
  const AppView = makeAppView();
  const html = AppView.cardPreviewHtml({ id: 7, staging_error: 'docker build exploded' },
    { sessionId: 7 });
  assert.match(html, /^<span/);
  assert.match(html, /aria-label="Preview unavailable"/);
  assert.match(html, /docker build exploded/, 'the reason is in the tooltip');
  assert.match(html, /M4 20 20 4/, 'the eye-with-a-slash glyph');
});

test('neither flag: an empty slot (a GC\'d or not-yet-built native row)', () => {
  const AppView = makeAppView();
  assert.equal(AppView.cardPreviewHtml({ id: 7 }, { sessionId: 7 }), '');
  assert.equal(AppView.cardPreviewHtml(null, {}), '');
  assert.equal(AppView.cardPreviewHtml({}, {}), '', 'no session id — nothing to open');
});

test('a long staging_error is clipped rather than pasted whole into an attribute', () => {
  const AppView = makeAppView();
  const html = AppView.cardPreviewHtml({ id: 7, staging_error: 'x'.repeat(900) }, { sessionId: 7 });
  assert.ok(html.length < 900, 'clipped');
});

// ── The rebuild path ────────────────────────────────────────────────────

test('can_preview with no live URL is offered, and routes through ensure-staging', () => {
  const AppView = makeAppView();
  const html = AppView.cardPreviewHtml({ id: 71, can_preview: true, staging_url: null },
    { kind: 'shared-session', sessionId: 71 });
  assert.match(html, /swapToStagingForSession\(71, ''\)/, 'no last-known URL — the server decides');
  assert.match(html, /rebuilds it if it went to sleep/);
});

test('an own session is previewable once a PR exists (pr_number)', () => {
  const AppView = makeAppView();
  assert.match(
    AppView.cardPreviewHtml({ id: 51, pr_number: 123 }, { kind: 'own-session', sessionId: 51 }),
    /gc-vote-btn-preview/);
  assert.equal(
    AppView.cardPreviewHtml({ id: 51, pr_number: null }, { kind: 'own-session', sessionId: 51 }),
    '');
});

test('read-only viewers cannot trigger a rebuild, but a live URL still opens', () => {
  const AppView = makeAppView({ readOnly: true });
  assert.equal(
    AppView.cardPreviewHtml({ id: 71, can_preview: true, staging_url: null }, { sessionId: 71 }),
    '', 'the ensure-staging POST is collab-gated');
  assert.match(
    AppView.cardPreviewHtml({ id: 71, can_preview: true, staging_url: 'https://s' }, { sessionId: 71 }),
    /gc-vote-btn-preview/);
});

// ── The labelled variant, and all four call sites ───────────────────────

test('iconOnly:false gives the detail view a labelled affordance', () => {
  const AppView = makeAppView();
  const html = AppView.cardPreviewHtml({ id: 7, staging_url: 'https://s' },
    { sessionId: 7, iconOnly: false });
  assert.match(html, />Preview</, 'the detail view has room to say what it is');
  assert.doesNotMatch(html, /gc-vote-btn-icon/);
  const building = AppView.cardPreviewHtml({ id: 7, staging_building: true },
    { sessionId: 7, iconOnly: false });
  assert.match(building, /Preview building…/);
  const err = AppView.cardPreviewHtml({ id: 7, staging_error: 'boom' },
    { sessionId: 7, iconOnly: false });
  assert.match(err, /Preview unavailable/);
});

test('each kind gets its own wording, and all four call sites use this helper', () => {
  const AppView = makeAppView();
  for (const kind of ['proposal', 'own-session', 'shared-session', 'issue-run']) {
    const html = AppView.cardPreviewHtml({ id: 1, staging_url: 'https://s' }, { kind, sessionId: 1 });
    assert.match(html, /title="[^"]+"/, `${kind} carries a tooltip`);
    assert.ok(AppView.PREVIEW_TITLES[kind], `${kind} has declared wording`);
  }

  // 1. proposal card
  assert.match(AppView._renderProposalCard(PR({ staging_url: 'https://s' })),
    /gc-vote-btn-preview[^>]*gc-vote-btn-icon|gc-vote-btn-icon[^>]*gc-vote-btn-preview/);
  // 2. own session card
  AppView._sharedById = {};
  assert.match(AppView._renderMySessionCard({ id: 51, session_title: 'M', pr_number: 9 }),
    /gc-vote-btn-preview/);
  // 3. shared session card
  assert.match(AppView._renderSharedSessionCard({ id: 71, session_title: 'T', username: 'them', staging_url: 'https://s' }),
    /gc-vote-btn-preview/);
  // 4. the issue card's headless run
  assert.match(AppView._renderIssueRow({
    number: 5, title: 'x',
    headless: { status: 'ready', outcome: 'code', sessionId: 90, stagingUrl: 'https://s' },
  }), /gc-vote-btn-preview/);
});

test('an issue run with no preview (or a spec-only outcome) shows no affordance', () => {
  const AppView = makeAppView();
  assert.doesNotMatch(AppView._renderIssueRow({
    number: 5, title: 'x', headless: { status: 'ready', outcome: 'spec', sessionId: 90 },
  }), /gc-vote-btn-preview/);
  assert.doesNotMatch(AppView._renderIssueRow({
    number: 5, title: 'x',
    headless: { status: 'ready', outcome: 'code', sessionId: 90, stagingUrl: null },
  }), /gc-vote-btn-preview/);
});

test('on a board card the eye is the action band\'s LAST child — the right edge', () => {
  // The dense action band pushes its trailing icon pill to the card's right
  // edge with an auto margin (app.css, `.dev-card-status + .gc-card-actions >
  // .gc-vote-btn-icon:last-child`), so a column of cards shows every preview
  // in one vertical line rather than at wherever the text pills before it end.
  // That selector is only ever the preview while it is emitted last, which is
  // what this pins: a primary added after it would be the pill that moves.
  const AppView = makeAppView();
  const cards = {
    proposal: AppView._renderProposalCard(PR({ staging_url: 'https://s' })),
    issue: AppView._renderIssueRow({
      number: 5, title: 'x',
      headless: { status: 'ready', outcome: 'code', sessionId: 90, stagingUrl: 'https://s' },
    }),
    ownSession: AppView._renderMySessionCard({ id: 51, session_title: 'M', pr_number: 9 }),
    sharedSession: AppView._renderSharedSessionCard({
      id: 71, session_title: 'T', username: 'them', staging_url: 'https://s',
    }),
  };
  for (const [kind, html] of Object.entries(cards)) {
    const band = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>\s*(?:<div|<\/div)/);
    assert.ok(band, `${kind}: an action band`);
    const children = band[1].match(/<(?:button|span)\b[^>]*class="[^"]*"/g) || [];
    assert.ok(children.length, `${kind}: the band has pills`);
    assert.match(children[children.length - 1], /gc-vote-btn-icon/,
      `${kind}: the eye trails every text pill, so :last-child is the preview`);
    // And it is the ONLY icon pill in the band — the ⋯ trigger, which shares
    // the class, lives in the card's rail instead.
    assert.equal(children.filter((c) => /gc-vote-btn-icon/.test(c)).length, 1,
      `${kind}: exactly one icon pill in the action band`);
  }
});
