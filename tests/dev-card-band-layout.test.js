// The four-band dev card (public/js/app-view.js + public/css/app.css).
//
// Every card on the dev board is now the same shape, top to bottom:
//
//   1 head    — type icon + title, clamped to TWO lines
//   2 meta    — the "PR#123 · author · 2h ago" subtitle, ONE line
//   3 status  — ONE merged band: the state bar, the Closes-#N pills and the
//               metadata chips, sharing a single row
//   4 actions — ONE row of action pills
//
// The point is alignment BETWEEN cards, not within one: a kanban column used
// to stack a card with a subtitle, three chips and a full-width tally row
// beside a card with a bare title, and nothing lined up. So bands 2 and 4 are
// RESERVED — they render, and hold their row open, even when the card has
// nothing to put in them — and bands 3–4 are CLIPPED rather than allowed to
// wrap, so a busy card loses its surplus pills whole instead of growing.
//
// Band 3 is the one exception, added by #1139: it is reserved whenever it has
// VISIBLE content, and stamped `data-empty="1"` (and hidden by CSS) when it
// has none. The reserve bought alignment between rows that, on most apps, are
// uniformly blank — an issue card can only fill the band if somebody voted an
// attribute, claimed it, commented or opened a close vote — so what it
// actually bought was 27px of empty band on every issue card. The element is
// still EMITTED when empty, because the action band's own cap is written as
// `.dev-card-status + .gc-card-actions` and removing the node would silently
// uncap it.
//
// Three things this file guards that are easy to break later:
//   • bands 2 and 4 reserve unconditionally on the board and collapse on the
//     detail head (`dense: false`), the one caller with no neighbour to align
//     to; band 3 additionally collapses when it is visually empty;
//   • the clip heights are FIXED (min === max), because a max-only height
//     would let a band with content collapse and take the alignment with it;
//   • band 3's empty flag comes from the render INPUTS, not the emitted HTML —
//     the 💬 badge ships at count 0 wearing Tailwind's `hidden`, so the band's
//     markup is never an empty string on an issue card.
//
// Companion files: dev-card-badge-cap.test.js owns which chips make it into
// band 3, card-action-layout.test.js owns which buttons make it into band 4,
// and dev-chip-geometry.test.js owns the chip box itself.
//
// Run with: node --test tests/dev-card-band-layout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

const ME = 42;

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => '2h ago',
    App: { user: { id: ME, canAdminWrite: false } },
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>' },
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
  AppView._proposalsCtx = { majority: 2 };
  AppView._mergedCtx = { majority: 2 };
  AppView._visualsOpen = new Set();
  AppView._sharedById = {};
  AppView._govProposals = [];
  return AppView;
}

// ── Fixtures: one of every card type, in its THINNEST form ────────────────
//
// Deliberately bare — no subtitle content to speak of, no chips, no actions
// where the card type allows none. A thin card is what the reserve exists for,
// so it is what these tests render.

const PR = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'them',
  user_id: 999, status: 'promoted', yes_count: 0, no_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});
const ISSUE = (over) => ({ number: 5, title: 'Something is wrong', ...over });
const GOV = (over) => ({
  id: 11, kind: 'secret_change', title: 'Set API key', up_count: 0, down_count: 0,
  created_by: 999, created_at: '2026-06-01T00:00:00Z', ...over,
});
const MERGED = (over) => ({
  id: 8, pr_number: 800, pr_title: 'Ship it', username: 'them', user_id: 999,
  status: 'merged', yes_count: 3, no_count: 0, chat_count: 0,
  created_at: '2026-06-01T00:00:00Z', ...over,
});
const CLOSE_ROW = (over) => ({
  id: 9, chat_count: 0, created_at: '2026-06-01T00:00:00Z',
  up_count: 2, down_count: 0,
  payload: {
    issueNumber: 5, issueTitle: 'T', appliedAt: '2026-06-02T00:00:00Z',
    appliedBy: 'group-vote', required: 2,
  },
  ...over,
});

function everyCard(AppView) {
  return {
    proposal: AppView._renderProposalCard(PR()),
    issue: AppView._renderIssueRow(ISSUE()),
    gov: AppView._renderGovCard(GOV()),
    merged: AppView._renderMergedCard(MERGED(), 2),
    closeIssue: AppView._renderCompletedCloseIssueCard(CLOSE_ROW()),
    mySession: AppView._renderMySessionCard({ id: 51, session_title: 'Mine', status: 'active' }),
    sharedSession: AppView._renderSharedSessionCard({
      id: 71, session_title: 'Theirs', username: 'them', user_id: 9,
    }),
  };
}

// The band each card renders, in document order, by class.
//
// `( [^"]*)?` tolerates a band growing an extra class without this helper
// having to change — but NOT a longer first class, so `dev-card-head-main` is
// still correctly not a band. (#1139's empty flag rides as a data attribute,
// outside the class string, so it does not need the allowance; a later band
// that does grow a class will.)
function bandOrder(html) {
  const body = html.slice(html.indexOf('<div class="flex-1 min-w-0">'));
  const out = [];
  const re = /class="(dev-card-head|dev-card-meta|dev-card-badges dev-card-status|gc-card-actions)( [^"]*)?"/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}

// ── Band 1–4: present, in order, on every card type ──────────────────────

test('every board card renders all four bands, in order', () => {
  const AppView = makeAppView();
  const want = ['dev-card-head', 'dev-card-meta',
    'dev-card-badges dev-card-status', 'gc-card-actions'];
  for (const [kind, html] of Object.entries(everyCard(AppView))) {
    assert.deepEqual(bandOrder(html).slice(0, 4), want,
      `${kind} card should open with head → meta → status → actions`);
  }
});

test('bands 2 and 4 reserve unconditionally: a bare card still emits them empty', () => {
  const AppView = makeAppView();
  // The settled close-issue row is the extreme case: no actions of any kind
  // (by design — a decided vote has nothing to offer) and no chips.
  const html = AppView._renderCompletedCloseIssueCard(CLOSE_ROW());
  assert.match(html, /<div class="gc-card-actions"><\/div>/,
    'the action band renders EMPTY rather than not at all');
  assert.match(html, /class="dev-card-badges dev-card-status"/,
    'and the status band renders too — this card has a settled tally pill');
  assert.doesNotMatch(html, /data-empty/,
    'so it is NOT flagged empty');
  // A session card has no subtitle-less form, so use the raw composer for the
  // truly empty meta case.
  const bare = AppView._cardContentHtml({ titleHtml: 'x' });
  assert.match(bare, /<div class="dev-card-meta"><\/div>/, 'empty meta band too');
  assert.match(bare, /<div class="gc-card-actions"><\/div>/);
});

// ── Band 3 only: reserved when it has content, flagged when it doesn't ────

test('#1139: an empty status band is still EMITTED, but flagged data-empty', () => {
  const AppView = makeAppView();
  const bare = AppView._cardContentHtml({ titleHtml: 'x' });
  // Emitted — the action band's cap is `.dev-card-status + .gc-card-actions`,
  // so dropping the node would uncap the action row on exactly these cards,
  // and several dapp.json checks walk the same four-band chain.
  assert.match(bare,
    /<div class="dev-card-badges dev-card-status" data-empty="1"><\/div>/);
  // The class attribute is byte-identical either way: the flag is a data
  // attribute precisely so every existing selector keeps matching.
  assert.match(bandOrder(bare).join(','),
    /dev-card-badges dev-card-status/);
});

test('#1139: a bare issue card — nothing voted, claimed or said — is flagged', () => {
  const AppView = makeAppView();
  // The common case, and the one the issue was filed about: no attribute
  // votes, no claim, no close vote, an empty thread.
  const html = AppView._renderIssueRow(ISSUE({ chatCount: 0 }));
  const open = html.indexOf('class="dev-card-badges dev-card-status"');
  assert.ok(open > 0, 'the band is still in the DOM');
  assert.match(html.slice(open, open + 120), /data-empty="1"/);
  // And it really is visually blank: the only child is the hidden 💬 badge,
  // which is WHY emptiness cannot be decided from the markup.
  const band = html.slice(open, html.indexOf('<div class="gc-card-actions"', open));
  assert.match(band, /dev-chat-badge[^"]*hidden/,
    'the 0-count badge ships hidden — a string/`:empty` test would never fire');
  assert.doesNotMatch(band, /dev-status-pill-block|Closes #/);
});

test('#1139: a 0 chat count is not content, a real one is', () => {
  const AppView = makeAppView();
  const zero = AppView._cardContentHtml({ titleHtml: 'x', chatCount: 0 });
  assert.match(zero, /data-empty="1"/, '💬 0 is invisible, so the band is empty');
  const one = AppView._cardContentHtml({ titleHtml: 'x', chatCount: 1 });
  assert.doesNotMatch(one, /data-empty/, 'one message fills the band');
  assert.match(one, /dev-chat-badge/);
  // null/undefined mean "this card type has no thread badge at all".
  assert.match(AppView._cardContentHtml({ titleHtml: 'x', chatCount: null }),
    /data-empty="1"/);
});

test('#1139: any single visible pill keeps the band reserved', () => {
  const AppView = makeAppView();
  const cases = {
    'a state bar': { pill: '<div class="dev-status-pill-block">2/3</div>' },
    'a Closes-#N pill': { linkedHtml: '<span class="dev-badge">Closes #4</span>' },
    'one metadata chip': { badges: ['<span class="dev-badge">High</span>'] },
    'an In progress chip': { badges: ['', '<span class="dev-badge">In progress</span>'] },
  };
  for (const [what, opts] of Object.entries(cases)) {
    const html = AppView._cardContentHtml({ titleHtml: 'x', ...opts });
    assert.doesNotMatch(html, /data-empty/, `${what} is content`);
  }
  // All-empty strings in `badges` are not content — every chip helper returns
  // '' when it has nothing to say, which is what makes this check enough.
  assert.match(AppView._cardContentHtml({ titleHtml: 'x', badges: ['', '', ''] }),
    /data-empty="1"/);
});

test('#1139: the non-dense head omits a row holding only a hidden badge', () => {
  const AppView = makeAppView();
  // Reachable from a shared session's own discussion page, which passes
  // `chatCount: s.chat_count` with `noNav: true`. `badges` was non-empty (the
  // hidden 0-count 💬), so the old truthiness test rendered a 5px strip.
  const loose = AppView._cardContentHtml({
    titleHtml: 'x', dense: false, chatCount: 0,
  });
  assert.doesNotMatch(loose, /dev-card-badges/, 'no row at all');
  assert.doesNotMatch(loose, /data-empty/, 'and no flag needed — it collapses');
  // With a real count it still renders, uncapped and unflagged as before.
  const withChat = AppView._cardContentHtml({
    titleHtml: 'x', dense: false, chatCount: 3,
  });
  assert.match(withChat, /<div class="dev-card-badges">/);
  assert.doesNotMatch(withChat, /dev-card-status/);
});

test('#1139: bumpThreadBadge clears the flag when it reveals the badge', () => {
  // The one path that makes a pill visible without a repaint — so it is the
  // one path that has to un-hide the band itself.
  const bump = SRC.slice(SRC.indexOf('bumpThreadBadge(type, ref) {'));
  const body = bump.slice(0, bump.indexOf('\n  },'));
  assert.match(body, /classList\.remove\('hidden'/, 'it un-hides the badge');
  assert.match(body, /closest\('\.dev-card-status'\)/,
    'and walks up to the band it lives in');
  assert.match(body, /removeAttribute\('data-empty'\)/);
});

test('bands are SIBLINGS of the head, so only the head is indented', () => {
  const AppView = makeAppView();
  const html = AppView._renderProposalCard(PR());
  // The head closes before the meta line opens — the meta/status/action bands
  // are not nested inside the icon's flex row.
  const head = html.indexOf('class="dev-card-head"');
  const main = html.indexOf('class="dev-card-head-main"');
  const meta = html.indexOf('class="dev-card-meta"');
  assert.ok(head < main && main < meta, 'head → head-main → meta');
  const headBlock = html.slice(head, meta);
  assert.doesNotMatch(headBlock, /dev-card-badges|gc-card-actions/,
    'nothing but the title shares the icon\'s row');
});

// ── Band 1: the two-line title clamp ─────────────────────────────────────

test('a board title carries the clamp class AND its full text as `title`', () => {
  const AppView = makeAppView();
  const long = 'A deliberately enormous proposal title that runs well past two '
    + 'lines in a narrow kanban column so the clamp has something to bite on';
  const html = AppView._renderProposalCard(PR({ pr_title: long }));
  assert.match(html, /class="dev-card-title dev-card-title-clamp" title="/,
    'the clamped element itself carries the tooltip');
  assert.ok(html.includes(long), 'the full title is still in the DOM, un-truncated');
});

test('every board card type clamps its title', () => {
  const AppView = makeAppView();
  for (const [kind, html] of Object.entries(everyCard(AppView))) {
    assert.match(html, /dev-card-title dev-card-title-clamp/,
      `${kind} card should clamp`);
    assert.match(html, /dev-card-title-clamp"[^>]*title="/,
      `${kind} card's clamped title should carry a tooltip`);
  }
});

// ── Band 3: one merged status band ───────────────────────────────────────

test('the state bar, the Closes pills and the chips share ONE band', () => {
  const AppView = makeAppView();
  const html = AppView._renderProposalCard(PR({
    linked_issues: [4],
    priority: { top: 'high', count: 1, myValue: null },
  }));
  const open = html.indexOf('class="dev-card-badges dev-card-status"');
  assert.ok(open > 0, 'the merged band exists');
  const band = html.slice(open, html.indexOf('<div class="gc-card-actions"', open));
  assert.match(band, /dev-status-pill-block/, 'state bar in the band');
  assert.match(band, /Closes #4/, 'linked-issue pill in the same band');
  assert.match(band, /High/, 'and the metadata chips');
  // Only ONE status band per card: .dev-status-row is retired, and a second
  // full-width row is exactly what the merge removed.
  assert.equal(html.split('dev-card-badges dev-card-status').length - 1, 1);
  assert.doesNotMatch(html, /dev-status-row/);
});

test('Closes-#N pills left the META line for the status band', () => {
  const AppView = makeAppView();
  const html = AppView._renderProposalCard(PR({ linked_issues: [4] }));
  const meta = html.slice(html.indexOf('class="dev-card-meta"'),
    html.indexOf('class="dev-card-badges dev-card-status"'));
  assert.doesNotMatch(meta, /dev-badge/,
    'the meta line is words only now — it truncates, and a pill in it was the '
    + 'thing that got cut first');
  assert.match(html.slice(html.indexOf('dev-card-status')), /dev-badge/);
});

test('the state bar LEADS the band and flexes rather than filling it', () => {
  const AppView = makeAppView();
  const html = AppView._renderProposalCard(PR({
    priority: { top: 'high', count: 1, myValue: null },
  }));
  const band = html.indexOf('dev-card-badges dev-card-status');
  assert.ok(html.indexOf('dev-status-pill-block', band) < html.indexOf('High', band),
    'state first — it is the card\'s headline, and the band clips at its end');
});

// ── dense: false — the one caller that opts out ──────────────────────────

test('the detail head (noNav) collapses its empty bands instead of reserving', () => {
  const AppView = makeAppView();
  const head = AppView._renderProposalCard(PR(), { noNav: true });
  assert.doesNotMatch(head, /dev-card-status/, 'no reserved status band');
  assert.doesNotMatch(head, /dev-card-title-clamp/, 'and no two-line clamp');
  assert.match(head, /dev-card-title/, 'it still uses the shared title cell');
  // Its pill is the inline capsule, and it is inside the (collapsible) badge
  // row rather than a band of its own.
  assert.match(head, /gc-vote-count/);
  assert.doesNotMatch(head, /dev-status-pill-block/);
});

test('the composer\'s dense flag is what decides all of it', () => {
  const AppView = makeAppView();
  const dense = AppView._cardContentHtml({ titleHtml: 'x' });
  const loose = AppView._cardContentHtml({ titleHtml: 'x', dense: false });
  assert.match(dense, /dev-card-title-clamp/);
  assert.match(dense, /dev-card-meta/);
  assert.match(dense, /dev-card-status/);
  assert.match(dense, /gc-card-actions/);
  // Nothing to show → nothing rendered, exactly as before the four bands.
  assert.doesNotMatch(loose, /dev-card-title-clamp/);
  assert.doesNotMatch(loose, /dev-card-meta/);
  assert.doesNotMatch(loose, /dev-card-badges/);
  assert.doesNotMatch(loose, /gc-card-actions/);
});

// ── The CSS geometry ─────────────────────────────────────────────────────

function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

test('.dev-card-title-clamp clamps at two lines and reserves the second', () => {
  const r = rule('.dev-card-title-clamp');
  assert.match(r, /-webkit-line-clamp: 2/);
  // -webkit-line-clamp is inert without both of these.
  assert.match(r, /display: -webkit-box/);
  assert.match(r, /-webkit-box-orient: vertical/);
  assert.match(r, /overflow: hidden/);
  const min = parseFloat(r.match(/min-height:\s*([\d.]+)px/)[1]);
  // Two lines of the 13.5px/1.35 card title.
  assert.ok(Math.abs(min - 2 * 1.35 * 13.5) < 0.5,
    `min-height should reserve exactly two title lines, got ${min}px`);
});

test('the meta band reserves — and caps — its single line', () => {
  const r = rule('.dev-card-meta');
  assert.match(r, /white-space: nowrap/, 'one line, truncated — never two');
  assert.match(r, /text-overflow: ellipsis/);
  assert.match(r, /overflow: hidden/);
  const min = parseFloat(r.match(/min-height:\s*([\d.]+)px/)[1]);
  const max = parseFloat(r.match(/max-height:\s*([\d.]+)px/)[1]);
  const size = parseFloat(r.match(/font-size:\s*([\d.]+)px/)[1]);
  const lh = parseFloat(r.match(/line-height:\s*([\d.]+)/)[1]);
  assert.ok(Math.abs(min - size * lh) < 0.5,
    `min-height should be one ${size}px/${lh} line, got ${min}px`);
  // Same min === max contract as the other two reserved bands, and here it is
  // load-bearing for a reason the browser found: a subtitle carrying the
  // `#123` mono link is a mixed-font line box, which measured 17.09px against
  // 16.09px for a plain-text one. Reserving without capping let every linked
  // card push its status and action bands 1px below its neighbours'.
  assert.equal(min, max, 'reserved AND capped at one line');
});

test('the status band is a FIXED-height, clipping row', () => {
  const r = rule('.dev-card-badges.dev-card-status');
  const min = parseFloat(r.match(/min-height:\s*(\d+)px/)[1]);
  const max = parseFloat(r.match(/max-height:\s*(\d+)px/)[1]);
  // min === max is the whole contract: max alone would let an empty band
  // collapse, and min alone would let a busy one grow.
  assert.equal(min, max, 'reserved AND capped at the same height');
  assert.match(r, /overflow: hidden/, 'the surplus row is hidden, not shrunk');
  // It composes with .dev-card-badges, which is what makes the children wrap
  // (so the overflow is a whole row rather than a half-cut pill).
  assert.match(rule('.dev-card-badges'), /flex-wrap: wrap/);
  assert.equal(min, parseFloat(rule('.dev-status-pill-block').match(/height:\s*(\d+)px/)[1]),
    'one row = the tallest child, the state bar');
});

test('#1139: a flagged-empty status band is hidden, not merely collapsed', () => {
  const r = rule('.dev-card-badges.dev-card-status[data-empty="1"]');
  assert.match(r, /display: none/,
    'display:none takes the 5px margin-top with it — a height of 0 would not');
  // Higher specificity than .dev-card-badges, so source order in app.css
  // cannot resurrect the margin.
  assert.ok(CSS.indexOf('\n.dev-card-badges {')
    < CSS.indexOf('\n.dev-card-badges.dev-card-status[data-empty="1"] {'),
    'and it comes after the base rule anyway');
  // THE regression this whole design exists to prevent: the action band's cap
  // is an adjacent-sibling rule, so the flagged band must stay in the DOM.
  // display:none preserves sibling adjacency; removing the node would not.
  const cap = rule('.dev-card-status + .gc-card-actions');
  assert.match(cap, /max-height: 24px/, 'the action-band cap still exists…');
  assert.match(SRC, /dev-card-badges dev-card-status"\$\{[^}]*data-empty/,
    '…and the composer still emits the band either way, flag or no flag');
});

test('the action band is capped only where it follows a dense status band', () => {
  const r = rule('.dev-card-status + .gc-card-actions');
  const min = parseFloat(r.match(/min-height:\s*(\d+)px/)[1]);
  const max = parseFloat(r.match(/max-height:\s*(\d+)px/)[1]);
  assert.equal(min, max, 'reserved AND capped');
  assert.equal(min, 24, "one row of .gc-vote-btn, whose box is 24px");
  assert.match(r, /overflow: hidden/);
  // The bare .gc-card-actions — the detail view's own list — keeps wrapping
  // freely. Capping it there would hide real actions on a page that has the
  // room for them.
  const bare = rule('.gc-card-actions');
  assert.doesNotMatch(bare, /max-height/);
  assert.match(bare, /flex-wrap: wrap/);
});

test('the kudos pill hugs its wrapper inside the capped action band', () => {
  // Kudos.renderButton hands back its 24px button inside an inline-block
  // positioning span (it anchors the absolute popover). An inline-block is
  // sized by a LINE box, so the span measured 25.5px and its font descender
  // pushed the button 1.5px down — clipped through its own bottom border in a
  // band with zero slack. inline-flex sizes the span by its child instead.
  const r = rule('.dev-card-status + .gc-card-actions .kudos-wrap');
  assert.match(r, /display: inline-flex/);
  assert.match(r, /align-items: center/);
  // Scoped to the dense band: the detail view's kudos button sits in an
  // uncapped row, where the phantom line-box height changes nothing.
  assert.doesNotMatch(CSS, /\n\.kudos-wrap \{[^}]*inline-flex/);
});

test('the preview eye is pinned to the BOTTOM of the card\'s right-hand rail', () => {
  // The eye is the one action that leaves the platform, so it is parked in the
  // card's bottom-right corner: a column of cards then shows its previews in
  // one vertical line, instead of at whatever x the text pills before it
  // happen to end. It shares the rail with the two other right-edge controls —
  // ⋯ at the top, chevron centred between them — and being out of the action
  // band means the band's `max-height: 24px` can no longer clip it.
  const r = rule('.dev-card-rail');
  assert.match(r, /flex-direction: column/);
  assert.match(r, /align-self: stretch/,
    'the rail spans the card\'s full height — that is what gives it a bottom');
  // ONE pair of auto margins does all the positioning, and it is scoped to
  // `> svg`: the chevron is the rail's only direct <svg> child (the ⋯ is a
  // <button>, the preview a <button>/<span>). So the ⋯ keeps the top, the eye
  // keeps the bottom, and the chevron centres in whatever is left between.
  const c = rule('.dev-card-rail > svg');
  assert.match(c, /margin-top: auto/);
  assert.match(c, /margin-bottom: auto/);
  assert.match(SRC, /gc-vote-btn gc-vote-btn-icon dev-card-menu-btn/,
    'the ⋯ trigger is a <button>, so the centring rule does not match it');
  assert.match(rule('.dev-card-rail > .gc-vote-btn-icon'), /flex: none/,
    'and neither pill may be shrunk in height by a short card');
  // The dead rule from the previous placement must be gone, not left to fight
  // the rail: nothing in the action band pushes a trailing icon pill any more.
  assert.doesNotMatch(CSS, /gc-card-actions > \.gc-vote-btn-icon/);
  const band = rule('.dev-card-status + .gc-card-actions');
  assert.doesNotMatch(band, /justify-content/,
    'the band itself stays a plain left-aligned flex row');
});

test('the rail emits ⋯, then the chevron, then the preview — in that order', () => {
  const AppView = makeAppView();
  const menu = [{ label: 'Withdraw', act: () => {} }];
  const eye = '<button class="gc-vote-btn gc-vote-btn-preview gc-vote-btn-icon">eye</button>';
  const full = AppView._cardRailHtml('k:1', menu, { preview: eye });
  // The order IS the layout: the auto margins on the chevron centre it in the
  // gap between whatever precedes and follows it, so emitting the eye before
  // the chevron would put the eye in the middle and the chevron at the bottom.
  assert.match(full, /^<div class="dev-card-rail"><button [^>]*dev-card-menu-btn[\s\S]*?<svg [^>]*class="w-4 h-4[\s\S]*?<\/svg><button [^>]*gc-vote-btn-preview[^>]*>eye<\/button><\/div>$/);

  // No preview → byte-for-byte the rail as it was before this moved: no
  // reserved slot, so a card with nothing to preview looks untouched.
  assert.equal(AppView._cardRailHtml('k:1', menu, { preview: '' }),
    AppView._cardRailHtml('k:1', menu));

  // A card with a preview but no ⋯ still needs the column (the shared-session
  // card): a bare chevron is only returned when it is the rail's sole content.
  const noMenu = AppView._cardRailHtml('', null, { preview: eye });
  assert.match(noMenu, /^<div class="dev-card-rail"><svg [\s\S]*>eye<\/button><\/div>$/);
  assert.doesNotMatch(AppView._cardRailHtml('', null, {}), /dev-card-rail/,
    'a lone chevron needs no column to be centred in');
  assert.equal(AppView._cardRailHtml('', null, { chevron: false }), '');
});

test('no dense renderer puts the preview back in the action band', () => {
  // The four dense card types that have something to preview pass it to the
  // rail; only the noNav (detail head) branch keeps it in the action list,
  // because that head has no chevron for the eye to sit under and its band is
  // uncapped and wrapping.
  const calls = SRC.match(/_cardActionsHtml\(\{[^}]*preview[^}]*\}\)/g) || [];
  for (const c of calls) {
    assert.match(c, /preview: noNav \? preview : ''/,
      `dense action band must not carry the preview: ${c}`);
  }
  const rails = SRC.match(/_cardRailHtml\([^;]*?preview[^;]*?\}\)/g) || [];
  assert.ok(rails.length >= 4,
    `expected the dense renderers to pass a preview to the rail, saw ${rails.length}`);
});

test('the state bar flexes into whatever the chips leave, over a floor', () => {
  const r = rule('.dev-status-pill-block');
  assert.match(r, /flex: 1 1 auto/, 'it grows and shrinks — it is no longer a row');
  assert.match(r, /min-width: 7rem/, 'but never so narrow that the tally is unreadable');
  // max-width: 100% stays (it must not overflow its band); `width: 100%` is
  // the full-width row the merge removed.
  assert.doesNotMatch(r, /\n\s*width: 100%/, 'the full-width bar is gone');
  assert.match(r, /max-width: 100%/, 'it still cannot exceed the band');
});

test('the two legacy merge badges are boxed INSIDE the clipped band only', () => {
  // They size themselves from their own line-height, so in a clipped band they
  // were the one child that could wrap its label and be cut through the text.
  const r = rule('.dev-card-status > .gc-merging-badge,\n.dev-card-status > .gc-checks-running-badge');
  assert.match(r, /height: 20px/);
  assert.match(r, /box-sizing: border-box/);
  assert.match(r, /flex-shrink: 0/);
  // Scoped: the same classes are also an icon-sized preview state in the
  // action row and appear in the feed/home strips, which own their geometry.
  assert.doesNotMatch(CSS, /\n\.gc-merging-badge \{[^}]*height: 20px/);
});

test('.dev-status-row is retired — no rule, no reference', () => {
  assert.doesNotMatch(CSS, /dev-status-row/, 'the CSS rule is gone');
  assert.doesNotMatch(SRC, /dev-status-row/, 'and nothing renders the class');
});
