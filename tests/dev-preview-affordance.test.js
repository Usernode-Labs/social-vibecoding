// The ONE preview affordance (app-view.js `_cardPreviewSpec`, rendered by
// frontend/src/features/dev-board/card/dev-card.tsx's `Preview`).
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
const {
  hasAction, issueCardHtml, mySessionCardHtml, previewHtml, proposalCardHtml, sharedSessionCardHtml,
} = require('./lib/dev-card-html');

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
  const html = previewHtml(AppView, { id: 7, staging_url: 'https://stg.example' },
    { kind: 'proposal', sessionId: 7 });
  assert.match(html, /^<button/, 'interactive');
  assert.match(html, /gc-vote-btn-preview/);
  assert.match(html, /gc-vote-btn-icon/, 'icon-only on the board');
  assert.match(html, /aria-label="Open preview"/, 'a real accessible name, not just a glyph');
  const spec = AppView._cardPreviewSpec({ id: 7, staging_url: 'https://stg.example' },
    { kind: 'proposal', sessionId: 7 });
  assert.deepEqual([spec.state, spec.sessionId, spec.url], ['live', 7, 'https://stg.example'],
    'the click carries the session and its URL into swapToStagingForSession');
  assert.doesNotMatch(html, />Preview</, 'no text label in the icon variant');
});

test('building: a NON-interactive span, not a disabled button', () => {
  const AppView = makeAppView();
  const html = previewHtml(AppView, { id: 7, staging_building: true }, { sessionId: 7 });
  assert.match(html, /^<span/, 'a span — there is nothing to click through to yet');
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /dc-status-spinner-arc/);
  assert.match(html, /aria-label="Preview building"/);
  assert.match(html, /few minutes/, 'the tooltip says how long');
});

test('unavailable: a non-interactive span carrying the captured reason', () => {
  const AppView = makeAppView();
  const html = previewHtml(AppView, { id: 7, staging_error: 'docker build exploded' },
    { sessionId: 7 });
  assert.match(html, /^<span/);
  assert.match(html, /aria-label="Preview unavailable"/);
  assert.match(html, /docker build exploded/, 'the reason is in the tooltip');
  assert.match(html, /M4 20 20 4/, 'the eye-with-a-slash glyph (icons.tsx EyeOffIcon)');
});

test('neither flag: an empty slot (a GC\'d or not-yet-built native row)', () => {
  const AppView = makeAppView();
  assert.equal(previewHtml(AppView, { id: 7 }, { sessionId: 7 }), '');
  assert.equal(previewHtml(AppView, null, {}), '');
  assert.equal(previewHtml(AppView, {}, {}), '', 'no session id — nothing to open');
});

test('a long staging_error is clipped rather than pasted whole into an attribute', () => {
  const AppView = makeAppView();
  const html = previewHtml(AppView, { id: 7, staging_error: 'x'.repeat(900) }, { sessionId: 7 });
  assert.ok(html.length < 900, 'clipped');
});

// ── The rebuild path ────────────────────────────────────────────────────

test('can_preview with no live URL is offered, and routes through ensure-staging', () => {
  const AppView = makeAppView();
  const item = { id: 71, can_preview: true, staging_url: null };
  const opts = { kind: 'shared-session', sessionId: 71 };
  const html = previewHtml(AppView, item, opts);
  // No last-known URL — the click routes through ensure-staging and the
  // server decides live-vs-rebuild.
  assert.equal(AppView._cardPreviewSpec(item, opts).url, '');
  assert.match(html, /rebuilds it if it went to sleep/);
  // The card's own affordance renders from the same spec.
  const spec = AppView._cardPreviewSpec(item, opts);
  assert.equal(spec.state, 'live');
  assert.equal(spec.url, '');
});

test('an own session is previewable once a PR exists (pr_number)', () => {
  const AppView = makeAppView();
  assert.match(
    previewHtml(AppView, { id: 51, pr_number: 123 }, { kind: 'own-session', sessionId: 51 }),
    /gc-vote-btn-preview/);
  assert.equal(
    previewHtml(AppView, { id: 51, pr_number: null }, { kind: 'own-session', sessionId: 51 }),
    '');
});

test('read-only viewers cannot trigger a rebuild, but a live URL still opens', () => {
  const AppView = makeAppView({ readOnly: true });
  assert.equal(
    previewHtml(AppView, { id: 71, can_preview: true, staging_url: null }, { sessionId: 71 }),
    '', 'the ensure-staging POST is collab-gated');
  assert.match(
    previewHtml(AppView, { id: 71, can_preview: true, staging_url: 'https://s' }, { sessionId: 71 }),
    /gc-vote-btn-preview/);
});

// ── The labelled variant, and all four call sites ───────────────────────

test('iconOnly:false gives the detail view a labelled affordance', () => {
  const AppView = makeAppView();
  const html = previewHtml(AppView, { id: 7, staging_url: 'https://s' },
    { sessionId: 7, iconOnly: false });
  assert.match(html, />Preview</, 'the detail view has room to say what it is');
  assert.doesNotMatch(html, /gc-vote-btn-icon/);
  const building = previewHtml(AppView, { id: 7, staging_building: true },
    { sessionId: 7, iconOnly: false });
  assert.match(building, /Preview building…/);
  const err = previewHtml(AppView, { id: 7, staging_error: 'boom' },
    { sessionId: 7, iconOnly: false });
  assert.match(err, /Preview unavailable/);
});

test('each kind gets its own wording, and all four call sites use this helper', () => {
  const AppView = makeAppView();
  for (const kind of ['proposal', 'own-session', 'shared-session', 'issue-run']) {
    const html = previewHtml(AppView, { id: 1, staging_url: 'https://s' }, { kind, sessionId: 1 });
    assert.match(html, /title="[^"]+"/, `${kind} carries a tooltip`);
    assert.ok(AppView.PREVIEW_TITLES[kind], `${kind} has declared wording`);
  }

  // 1. proposal card
  assert.match(proposalCardHtml(AppView, PR({ staging_url: 'https://s' })),
    /gc-vote-btn-preview[^>]*gc-vote-btn-icon|gc-vote-btn-icon[^>]*gc-vote-btn-preview/);
  // 2. own session card
  AppView._sharedById = {};
  assert.match(mySessionCardHtml(AppView, { id: 51, session_title: 'M', pr_number: 9 }),
    /gc-vote-btn-preview/);
  // 3. shared session card
  assert.match(sharedSessionCardHtml(AppView, { id: 71, session_title: 'T', username: 'them', staging_url: 'https://s' }),
    /gc-vote-btn-preview/);
  // 4. the issue card's headless run
  assert.match(issueCardHtml(AppView, {
    number: 5, title: 'x',
    headless: { status: 'ready', outcome: 'code', sessionId: 90, stagingUrl: 'https://s' },
  }), /gc-vote-btn-preview/);
});

// ── A session shared with no pull request ─────────────────────────────
//
// `submit_work({ share: true })` lands a branch in the app's in-progress area
// with a staging preview and NO pull request. Its card is a shared-session
// card like any other, but `pr_number` is null — and `can_preview` used to be
// derived from exactly that, so the moment the idle staging GC nulled
// staging_url the card rendered NOTHING: no eye, no rebuild, no explanation,
// for the author as much as for anyone else.
//
// The server had authorized this case all along — ensure-staging lets any app
// member rebuild an explicitly-shared session — so the affordance was the only
// thing missing. can_preview now also reads checks_commit_sha, which is set
// once a real commit on the branch has been built and, unlike staging_url,
// survives teardown.

test('a shared session with a slept preview and no PR still offers the eye', () => {
  const AppView = makeAppView();
  const slept = {
    id: 72, session_title: 'Shared, no PR', username: 'them',
    staging_url: null, can_preview: true,
  };
  assert.match(sharedSessionCardHtml(AppView, slept), /gc-vote-btn-preview/,
    'a collaborator can wake it, so the eye is live');
  // …and it says so: the title is the wake wording, not the plain one.
  assert.match(sharedSessionCardHtml(AppView, slept), /rebuilds it if it went to sleep/);
});

test('a read-only viewer needs a LIVE url — they cannot POST ensure-staging', () => {
  const AppView = makeAppView({ readOnly: true });
  assert.doesNotMatch(sharedSessionCardHtml(AppView, {
    id: 73, session_title: 'Shared, no PR', username: 'them',
    staging_url: null, can_preview: true,
  }), /gc-vote-btn-preview/, 'no live url and no rebuild right → no eye');
  // A live preview is a link, and needs no permission at all.
  assert.match(sharedSessionCardHtml(AppView, {
    id: 74, session_title: 'Shared, no PR', username: 'them',
    staging_url: 'https://s', can_preview: true,
  }), /gc-vote-btn-preview/, 'a live url is openable by anyone who can see the card');
});

test('the owner of a share-only session gets the same affordance', () => {
  // The owner's card is built from /api/me/active-sessions, which is a
  // different query — it carries the same derived can_preview now, so the two
  // cards cannot disagree about whether a slept preview can be woken.
  const AppView = makeAppView();
  AppView._sharedById = {};
  assert.match(mySessionCardHtml(AppView, {
    id: 52, session_title: 'Mine, no PR', pr_number: null, staging_url: null,
    can_preview: true,
  }), /gc-vote-btn-preview/);
});

test('an issue run with no preview (or a spec-only outcome) shows no affordance', () => {
  const AppView = makeAppView();
  assert.doesNotMatch(issueCardHtml(AppView, {
    number: 5, title: 'x', headless: { status: 'ready', outcome: 'spec', sessionId: 90 },
  }), /gc-vote-btn-preview/);
  assert.doesNotMatch(issueCardHtml(AppView, {
    number: 5, title: 'x',
    headless: { status: 'ready', outcome: 'code', sessionId: 90, stagingUrl: null },
  }), /gc-vote-btn-preview/);
});

test('on a board card the eye is the RAIL\'s last child — the bottom-right corner', () => {
  // Every dense card's preview hangs off the bottom of the right-hand rail,
  // under the ⋯ and the chevron (app.css, `.dev-card-rail`). A column of cards
  // then shows every preview in one vertical line, rather than at wherever the
  // text pills before it happened to end. The ORDER inside the rail is the
  // layout — the chevron's auto margins centre it in the gap between the two
  // pills — so this pins the eye as the rail's final child, and pins that the
  // dense action band no longer carries it at all.
  const AppView = makeAppView();
  const cards = {
    proposal: proposalCardHtml(AppView, PR({ staging_url: 'https://s' })),
    issue: issueCardHtml(AppView, {
      number: 5, title: 'x',
      headless: { status: 'ready', outcome: 'code', sessionId: 90, stagingUrl: 'https://s' },
    }),
    ownSession: mySessionCardHtml(AppView, { id: 51, session_title: 'M', pr_number: 9 }),
    sharedSession: sharedSessionCardHtml(AppView, {
      id: 71, session_title: 'T', username: 'them', staging_url: 'https://s',
    }),
  };
  for (const [kind, html] of Object.entries(cards)) {
    const band = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>\s*(?:<div|<\/div)/);
    assert.ok(band, `${kind}: an action band is still reserved`);
    assert.doesNotMatch(band[1], /gc-vote-btn-preview/,
      `${kind}: the eye has left the action band`);

    const railAt = html.indexOf('dev-card-rail');
    assert.ok(railAt > 0, `${kind}: a rail to hang it off`);
    const rail = html.slice(railAt);
    const children = rail.match(/<(?:button|span|svg)\b[^>]*class="[^"]*"/g) || [];
    assert.match(children[children.length - 1], /gc-vote-btn-preview/,
      `${kind}: the eye is the rail's last child`);
    // The chevron must sit BEFORE it (its auto margins centre it in the gap
    // between the ⋯ above and the eye below); the ⋯, when the card has one,
    // stays first.
    const chevronAt = rail.indexOf('M9 5l7 7-7 7');
    const eyeAt = rail.indexOf('gc-vote-btn-preview');
    assert.ok(chevronAt > 0 && chevronAt < eyeAt,
      `${kind}: the chevron is between the ⋯ and the eye`);
    const dotsAt = rail.indexOf('dev-card-menu-btn');
    if (dotsAt > 0) {
      assert.ok(dotsAt < chevronAt, `${kind}: the ⋯ keeps the top of the rail`);
    }
  }
});

test('a card with nothing to preview keeps exactly the rail it had before', () => {
  // The move must not cost a reserved empty slot at the bottom of every other
  // card's rail — that would read as a broken gap under the chevron.
  const AppView = makeAppView();
  const html = proposalCardHtml(AppView, PR({ staging_url: null }));
  const rail = html.slice(html.indexOf('dev-card-rail'));
  assert.doesNotMatch(rail, /gc-vote-btn-preview|gc-checks-running-badge|gc-conflict-badge/);
  const children = rail.match(/<(?:button|span|svg)\b[^>]*class="[^"]*"/g) || [];
  assert.match(children[children.length - 1], /w-4 h-4/,
    'the chevron is still the rail\'s last child, centred below the ⋯');
});
