'use strict';

// The Communities tab's page (`#communities`, 18 Nov 2026).
//
// One Home (#6361) had retired the Communities screen and listed your
// communities on Home. The tab is back, and its page holds them: the ones
// you pinned, the others you are in, and the way to the ones to join.
//
//   1. it ships hidden with both groups hidden and empty, so hydration
//      agrees with the prerender;
//   2. `#communities` routes to it, it is its tab's root, and `#workshop`,
//      the tab's older address, is rewritten to it;
//   3. the page draws Pinned (led by Needs you while a vote waits), then
//      Joined (ending on New community), then Discover;
//   4. Home lists none of them, and still finds them when you search.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderComponent, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PAGE = 'frontend/src/features/communities/index.tsx';

const PINS = [
  { slug: 'tide', name: 'Tide Table', iconUrl: null, iconEmoji: '🌊', iconColor: '#2e6660', member: true },
  { slug: 'garden', name: 'Garden Club', iconUrl: null, iconEmoji: '🌱', iconColor: null, member: false },
];
const JOINED = [
  { slug: 'tide', name: 'Tide Table', icon_emoji: '🌊', is_member: true },
  { slug: 'orchard', name: 'Orchard', icon_emoji: '🍎', is_member: true },
];

// The page as the brand look and every look before 20 Nov 2026 drew it (the
// tiles these tests hold). The standard look's page is the kit's since then
// (lib/skin.ts isKitHome): the last test here holds that one.
const LEGACY_PAGE = { stubs: { '../../lib/skin': { ...loadTsx('frontend/src/lib/skin.ts'), isKitHome: () => false } } };
function withStores(pins, scope, run) {
  const mod = loadTsx('tests/fixtures/communities-page-api.ts', LEGACY_PAGE);
  const before = [mod.homePinsStore.get(), mod.communityScopeStore.get()];
  mod.homePinsStore.set(pins);
  mod.communityScopeStore.set(scope);
  try {
    return run(mod);
  } finally {
    mod.homePinsStore.set(before[0]);
    mod.communityScopeStore.set(before[1]);
  }
}
const section = (html, id) => {
  const at = html.indexOf(`<section id="${id}"`);
  assert.ok(at >= 0, `#${id} renders`);
  return html.slice(at, html.indexOf('</section>', at));
};

test('the page ships hidden, with both groups hidden and empty', () => {
  const html = renderComponent(PAGE, 'CommunitiesScreen', {}, LEGACY_PAGE);
  assert.match(html, /<main id="communities-screen" class="hidden /,
    'the root ships hidden, with `hidden` first in a constant class string');
  assert.match(html, /<section id="communities-pinned-section" class="px-3" hidden="">/);
  assert.match(html, /<section id="communities-joined-section" class="px-3" hidden="">/);
  assert.doesNotMatch(html, /data-home-community=/, 'the pins are client data: none of them in the first render');
  assert.doesNotMatch(html, /communities-new-community|communities-needs-tile|communities-new-top/);
  // Discover needs no data, so it is in the first render.
  assert.match(section(html, 'communities-discover-section'), new RegExp(message('communities:page.discover.button')));
  // The header names the page, so it has no heading of its own.
  assert.doesNotMatch(html, /<h1/);
  assert.match(read('frontend/src/Shell.tsx'), /<Island name="CommunitiesScreen"><CommunitiesScreen \/><\/Island>/);
});

test('#communities routes to the page, which is its tab\'s root; #workshop is rewritten to it', () => {
  const appJs = read('public/js/app.js');
  const route = appJs.slice(appJs.indexOf("if (parts[0] === 'communities' || parts[0] === 'workshop') {"), appJs.indexOf("if (parts[0] === 'apps' || parts[0] === 'discover') {"));
  assert.match(route, /if \(toNeeds\) \{[\s\S]*?App\._rootUrl\('#needs'\)[\s\S]*?App\.navigateToWorkshop\(\);\s*return;\s*\}/,
    'with ?ws=needs it is still Needs you');
  assert.match(route, /if \(parts\[0\] === 'workshop'\) \{\s*try \{ history\.replaceState\(null, '', App\._rootUrl\('#communities'\)\); \}/);
  assert.match(route, /App\.navigateToCommunities\(\);\s*return;\s*\}\s*$/);
  assert.doesNotMatch(route, /App\.navigateHome\(\)/, 'no longer Home');
  const nav = appJs.slice(appJs.indexOf('  navigateToCommunities() {'), appJs.indexOf('  navigateToAi() {'));
  assert.match(nav, /if \(\(App\._inCommunities \|\| App\._revealedScreen === 'communities-screen'\) && !App\.currentApp\) return;/,
    'popstate and hashchange land in one tick: the second run does nothing');
  assert.match(nav, /App\._inCommunities = true;[\s\S]*?window\.UsernodeReact\?\.communities\?\.open\?\.\(\);\s*PlatformUI\.transition\(\(\) => \{/,
    'the flag and the read come before the transition');
  assert.match(nav, /App\._showOnlyScreen\('communities-screen'\);\s*App\._enterScreenChrome\(\);\s*App\.setHeaderTitle\(PlatformI18n\.t\('shell:title\.communities'\)\);/);
  assert.match(appJs, /if \(revealId !== 'communities-screen'\) App\._inCommunities = false;/, 'any other reveal ends the visit');
  assert.match(appJs, /else if \(App\._inCommunities\) App\.navigateHome\(\);/, 'Back to "/" leaves the page for Home');
  assert.match(appJs, /'communities-screen': \['none'\]/, 'a tab root has no back control');
  assert.match(appJs, /case 'communities': return 'communities-screen';/);
  assert.match(appJs, /SCREEN_IDS: \['app-view', 'home-screen', 'communities-screen',/);
  assert.match(appJs, /'communities-screen',\s*\n\s*\/\/ This week \(#6371\)/, 'the visibility seam lists it');
  const { tabForScreen } = loadTsx('frontend/src/features/nav/nav-store.js');
  assert.equal(tabForScreen('communities-screen'), 'workshop', 'it lights the Communities tab');
  assert.equal(tabForScreen('workshop-screen'), 'home', 'Needs you stays a page under Home');
  // "All communities" anywhere, and the lit tab's last step, come here.
  const scope = read('frontend/src/features/workshop/community-scope.ts');
  assert.match(scope, /if \(!slug\) \{\s*setScope\(null\);\s*openCommunitiesPage\(\);\s*return;\s*\}/);
  assert.match(scope, /export function openCommunitiesPage\(\): void \{[\s\S]*?_forgetWorkshopView[\s\S]*?if \(window\.location\.hash !== '#communities'\) window\.location\.hash = '#communities';\s*\}/);
});

test('the page draws Pinned, led by Needs you while a vote waits, then Joined, then Discover', () => {
  const html = withStores(
    { ready: true, pins: PINS, joined: JOINED, owed: { tide: 2, orchard: 1 } },
    { badgeNeeds: 3 },
    (mod) => renderToHtml(createElement(mod.CommunitiesScreen, {})),
  );
  const pinned = section(html, 'communities-pinned-section');
  assert.doesNotMatch(pinned.slice(0, pinned.indexOf('>')), /hidden/);
  assert.match(pinned, new RegExp(`>${message('communities:page.pinned')}<`));
  // The standard look's Home has no Needs you card, so its tile leads here.
  assert.match(pinned, /<a href="#needs" id="communities-needs-tile"[^>]*data-home-needs="3"/);
  assert.ok(pinned.indexOf('communities-needs-tile') < pinned.indexOf('data-home-community="tide"'), 'Needs you first');
  assert.ok(pinned.indexOf('data-home-community="tide"') < pinned.indexOf('data-home-community="garden"'), 'then the pins, in their order');
  assert.match(pinned, /data-home-community="tide" data-home-community-pinned=""/);
  assert.match(pinned, /data-home-community-votes="2"/, 'a pinned community says its own votes');
  assert.match(pinned, new RegExp(`id="communities-edit"[^>]*aria-label="${message('communities:page.editLabel')}"`), 'Edit rides Pinned');

  const joined = section(html, 'communities-joined-section');
  assert.match(joined, new RegExp(`>${message('communities:page.joined')}<`));
  assert.match(joined, /data-home-community="orchard"/, 'in it, not pinned');
  assert.doesNotMatch(joined, /data-home-community="tide"|data-home-community="garden"/, 'a pinned one is not listed twice');
  assert.doesNotMatch(joined, /communities-edit/, 'one Edit on the page');
  assert.doesNotMatch(joined, new RegExp(message('home:communities.pinNamed', { community: 'Orchard' })), 'no + until Edit is pressed');
  assert.match(joined, /id="communities-new-community"[^>]*data-panel-slot="create"/);
  assert.ok(joined.indexOf('data-home-community="orchard"') < joined.indexOf('communities-new-community'), 'New community is the group\'s last tile');
  assert.match(joined, new RegExp(`>${message('home:communities.new')}<`));
  // No filled button in the standard look: it is the kit's, for Standard (WIP) and the brand look.
  assert.doesNotMatch(html, /communities-new-top/);
  assert.match(read(PAGE), /const kit = wip \|\| brand;/);
  assert.match(read(PAGE), /const needsTile = !kit && needs > 0 && !q && !editing;/, 'those looks say Needs you on Home');

  const discover = section(html, 'communities-discover-section');
  assert.match(discover, new RegExp(message('communities:page.discover.title')));
  assert.match(discover, /<button type="button" id="communities-discover-btn"/);
  assert.match(read(PAGE), /win\.Home\?\.showCommunitiesToJoin\) win\.Home\.showCommunitiesToJoin\(\);/, 'it opens Home at Communities to join');
});

test('a quiet account: no Needs you tile, Edit on Joined with nothing pinned, and words when there is nothing at all', () => {
  const onlyJoined = withStores(
    { ready: true, pins: [], joined: JOINED, owed: {} },
    { badgeNeeds: 0 },
    (mod) => renderToHtml(createElement(mod.CommunitiesScreen, {})),
  );
  assert.match(onlyJoined, /<section id="communities-pinned-section" class="px-3" hidden="">/, 'nothing pinned, no Pinned group');
  assert.doesNotMatch(onlyJoined, /communities-needs-tile/, 'a zero says nothing');
  assert.match(section(onlyJoined, 'communities-joined-section'), /id="communities-edit"/, 'the first pin can be made from Joined');
  const none = withStores(
    { ready: true, pins: [], joined: [], owed: {} },
    { badgeNeeds: 0 },
    (mod) => renderToHtml(createElement(mod.CommunitiesScreen, {})),
  );
  assert.match(none, new RegExp(`<p id="communities-empty"[^>]*>${message('communities:page.empty')}</p>`));
  assert.doesNotMatch(none, /communities-edit/, 'nothing to edit');
  assert.match(section(none, 'communities-joined-section'), /communities-new-community/, 'New community is still offered');
});

test('Home lists none of your communities until you search, and then finds them', () => {
  const island = read('frontend/src/features/home/index.tsx');
  assert.match(island, /<HomeCommunityMatches \/>/);
  assert.doesNotMatch(island, /<PinnedCommunities \/>/);
  const quiet = withStores(
    { ready: true, pins: PINS, joined: JOINED, owed: {} },
    { badgeNeeds: 3 },
    (mod) => renderToHtml(createElement(mod.HomeCommunityMatches, {})),
  );
  assert.match(quiet, /<section id="home-communities-section" class="px-3" hidden="">/, 'with nothing typed the section is hidden');
  assert.doesNotMatch(quiet, /data-home-community=/);
  const src = read('frontend/src/features/home/pinned-communities.tsx');
  assert.match(src, /if \(!query\) return \[\];/);
  assert.match(src, /return \[\.\.\.state\.pins, \.\.\.joined\]\.filter\(\(c\) => matchesQuery\(query, c\.name, c\.slug\)\);/, 'pinned first, then the others you are in');
  assert.match(src, /const visible = state\.ready && matches\.length > 0;/);
  assert.match(src, /<SectionHeading>\{t\('home:communities\.matches'\)\}<\/SectionHeading>/);
  assert.equal(message('home:communities.matches'), 'Your communities');
  // It is also what keeps the account's pins read, under every look.
  assert.match(src, /const unwire = wireHomePins\(moved\);/);
});

test('the page\'s words are in the catalog, and say nothing of pinning to Home', () => {
  assert.equal(message('communities:page.pinned'), 'Pinned');
  assert.equal(message('communities:page.joined'), 'Joined');
  assert.equal(message('communities:page.discover.button'), 'Discover communities');
  assert.equal(message('communities:page.search.placeholder'), 'Search your communities');
  assert.equal(message('home:communities.pinNamed', { community: 'Orchard' }), 'Pin Orchard');
  assert.equal(message('home:communities.pinned', { community: 'Orchard' }), 'Orchard pinned to Communities');
  assert.equal(message('project:menu.homeCommunity.add'), 'Pin community');
  assert.equal(message('home:membership.joinedPinned', { community: 'Orchard' }), 'Joined Orchard · pinned to Communities');
});

test('Standard (WIP) draws the page as Home is: its ground, the community cards, the kit\'s filled actions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'features', 'communities', 'index.tsx'), 'utf8');
  assert.match(css, /html\[data-skin-wip\] #communities-screen \{\s*background-color: var\(--wip-page-bg-communities\);/);
  assert.match(css, /html:not\(\[data-skin\]\) #communities-screen \.home-column \{ max-width: none; \}/);
  // The standard look's page too (20 Nov 2026), on its own wallpaper: the page's ground is Standard (WIP)'s alone.
  assert.match(page, /const wip = isKitHome\(skin\);/);
  assert.doesNotMatch(css, /html:not\(\[data-skin\]\) #communities-screen \{[^}]*background-color/);
  const first = renderComponent(PAGE, 'CommunitiesScreen', {});
  assert.doesNotMatch(first, /communities-discover-section|communities-needs-tile|communities-new-community/, 'the first render is the kit page: no Discover card, no tiles');
  // A pin is the big card from 768px and a joined community the compact card at every width (./communities-card.test.js holds the card).
  assert.match(page, /const pinCards = wip \? wideCards : brand && brandCards;/);
  assert.match(page, /const joinCards = wip \|\| \(brand && brandCards\);/);
  assert.match(page, /const wideCards = useMinWidth\(768\);/);
  // The members are read only where a pinned card is drawn.
  assert.match(page, /if \(pinCards && shown && state\.ready && pinKey\) void loadHomePinsActivity\(\);/);
  // A group folds to three rows of four; its label unfolds the rest and folds it back.
  assert.match(page, /const FOLD_AT = 12;/);
  assert.match(page, /const folds = wip && !q && !editing;/, 'a search or an edit shows all of a group');
  assert.match(page, /<WipHeadMore id=\{`communities-\$\{key\}-all`\} direction="down" expanded=\{false\} label=\{t\('communities:page\.showAll', \{ count \}\)\}/);
  assert.match(page, /<WipHeadMore id=\{`communities-\$\{key\}-less`\} direction="up" expanded label=\{t\('communities:page\.showLess'\)\}/);
  // Every community there is to join is listed under Joined, by Home's own section under ids of its own.
  assert.match(page, /ids=\{\{ section: 'communities-all-section', featured: 'communities-all-featured-label' \}\}/);
  assert.match(page, /\{wip \? null : \(\s*<section id="communities-discover-section"/, 'Discover leads to that list, so it is not drawn where the list is');
  assert.match(css, /html:not\(\[data-skin\]\) #communities-all-section > \[data-home-join-featured\] \{\s*order: -1;/);
  assert.match(page, /<WipCta id="communities-discover-btn" glyph=\{false\} onClick=\{discover\}>/);
  // The look's own card for the community cards: its white, one soft hairline that firms under the pointer, its inks and the link's blue.
  const tokens = css.match(/html:not\(\[data-skin\]\) \{\s*--cm-bg:[^}]*\}/);
  assert.ok(tokens, 'the look sets the card\'s tokens');
  for (const [name, value] of [
    ['--cm-bg', 'var(--wip-card-bg)'], ['--cm-radius', 'var(--wip-card-radius)'],
    ['--cm-edge', 'inset 0 0 0 1px var(--wip-soft-line)'], ['--cm-edge-on', 'inset 0 0 0 1px var(--wip-card-line)'],
    ['--cm-ink', 'var(--wip-ink)'], ['--cm-muted', 'var(--wip-ink-muted)'], ['--cm-body', 'var(--wip-ink-soft)'],
    ['--cm-link', 'var(--wip-mark-2-ink)'], ['--cm-card-min', 'var(--wip-pin-card)'], ['--cm-gap', 'var(--wip-card-gap)'], ['--cm-cols', 'var(--wip-cols)'],
  ]) assert.ok(tokens[0].includes(`${name}: ${value};`), `${name}: ${value}`);
  // The old card's emblem, row of apps, faces and rule are gone with it.
  assert.doesNotMatch(css, /home-community-apps|home-community-emblem|data-home-community-detail|data-home-community-meta|--wip-emblem-|--wip-app-chip|--wip-logo-orb/);
});

test('Pinned: the community cards wrap onto rows from 768px, four where four fit; under 768px the small tiles, nothing sideways', () => {
  const css = read('public/css/app.css');
  // The cards' grid (A COMMUNITY'S CARD): each card at least --cm-card-min wide, and no more in a row than --cm-cols.
  assert.match(css, /\.cm-grid \{\s*display: grid;\s*grid-template-columns: repeat\(auto-fill, minmax\(max\(var\(--cm-card-min\), \(100% - \(var\(--cm-cols\) - 1\) \* var\(--cm-gap\)\) \/ var\(--cm-cols\)\), 1fr\)\);\s*gap: var\(--cm-gap\);\s*\}/);
  assert.doesNotMatch(css, /\.cm-grid\[data-cm-grid="pinned"\] \{ grid-auto-rows: 1fr; \}/, 'a row is as tall as its own tallest card');
  // Joined on a phone: one compact card to a line, 8px apart.
  assert.match(css, /@media \(max-width: 767\.98px\) \{\s*\.cm-grid\[data-cm-grid="joined"\] \{\s*grid-template-columns: minmax\(0, 1fr\);\s*gap: 8px;/);
  // Under 768px a pin is the small tile: as many as fit, three on a phone.
  const P = 'html:not\\(\\[data-skin\\]\\) #communities-body #communities-pinned-section \\.communities-grid';
  assert.match(css, new RegExp(`${P} \\{\\s*display: grid;\\s*grid-template-columns: repeat\\(auto-fill, minmax\\(var\\(--wip-pin-tile\\), 1fr\\)\\);\\s*grid-auto-rows: 1fr;\\s*gap: var\\(--wip-card-gap\\);\\s*padding: 0;\\s*\\}`));
  assert.match(css, /--wip-pin-card: 16\.5rem;/);
  assert.match(css, /--wip-pin-tile: 6\.25rem;/);
  assert.doesNotMatch(css, /--wip-shelf-card/, 'the one sideways row is gone, and its widths with it');
  // Nothing in the section scrolls or snaps sideways, and only the standard look's rules (the brand look draws the cards from its tokens).
  const rules = [...css.matchAll(/([^{}]*#communities-pinned-section[^{}]*)\{([^{}]*)\}/g)];
  assert.ok(rules.length > 5, 'the section\'s rules are found');
  for (const [, selector, body] of rules) {
    assert.doesNotMatch(body, /overflow-x|scroll-snap|overscroll-behavior|flex-basis|flex: 0 0/, `no sideways row: ${selector.trim()}`);
    const last = selector.trim().split('\n').pop().trim();
    assert.match(last, /^html:not\(\[data-skin\]\)(\.dark)? /, `the standard look's own: ${last}`);
  }
  // The tile's band: the community's own picture over its brand background, which shows where it has none or it fails.
  assert.match(css, new RegExp(`${P} > \\[data-home-community\\]::before \\{[^}]*background: var\\(--cm-pic, none\\) center \\/ cover no-repeat, var\\(--cm-scene\\) center \\/ cover no-repeat;`));
  assert.match(css, /html:not\(\[data-skin\]\)\.dark #communities-body #communities-pinned-section \.communities-grid > \[data-home-community\]::before \{\s*background-image: var\(--cm-pic-dark, var\(--cm-pic, none\)\), var\(--cm-scene\);/, 'its dark twin in the dark');
  assert.match(css, new RegExp(`${P} > \\[data-home-community\\]\\[data-home-community-scene="1"\\] \\{ --cm-scene: var\\(--wip-scene-4\\); \\}`), 'the background the tile has always had');
  // The tile's face is the community's own icon on the thin light outline.
  assert.match(css, /html:not\(\[data-skin\]\) #communities-screen \.communities-grid \[data-home-community\] \.home-community-logo \{\s*border-color: transparent;\s*background-color: transparent;\s*box-shadow: 0 0 0 1\.5px var\(--cm-icon-outline\);/);
});

// The cards, drawn: the page with a window wide enough for them.
const WIDE = (wide) => ({ '../../lib/use-min-width': { useMinWidth: (px) => wide >= px } });
function withCards(wide, skin, pins, run) {
  const skinMod = loadTsx('frontend/src/lib/skin.ts');
  const stubs = { ...WIDE(wide), '../../lib/skin': { ...skinMod, useSkin: () => skin } };
  const mod = loadTsx('tests/fixtures/communities-page-api.ts', { stubs });
  const before = [mod.homePinsStore.get(), mod.communityScopeStore.get(), mod.homePinsActivityStore.get()];
  mod.homePinsStore.set(pins);
  mod.communityScopeStore.set({ badgeNeeds: 0 });
  mod.homePinsActivityStore.set({ ready: true, bySlug: { tide: { members: 93, liveWeek: 5, activeWeek: 33, people: [], description: 'Tides for the bay.' } } });
  try {
    return run(mod);
  } finally {
    mod.homePinsStore.set(before[0]);
    mod.communityScopeStore.set(before[1]);
    mod.homePinsActivityStore.set(before[2]);
  }
}
const PICTURED = [
  { ...PINS[0], illustrationUrl: '/app-illustrations/aaaa', illustrationDarkUrl: '/app-illustrations/bbbb' },
  PINS[1],
];
const JOINED_COUNTED = [
  { slug: 'tide', name: 'Tide Table', icon_emoji: '🌊', is_member: true, member_count: 93 },
  { slug: 'orchard', name: 'Orchard', icon_emoji: '🍎', is_member: true, member_count: 34 },
];

test('from 768px a pin is the big card and a joined community the compact card, with the tiles\' hooks, votes and edit discs', () => {
  const html = withCards(1440, 'standard', { ready: true, pins: PICTURED, joined: JOINED_COUNTED, owed: { tide: 2, orchard: 1 } },
    (mod) => renderToHtml(createElement(mod.CommunitiesScreen, {})));
  const pinned = section(html, 'communities-pinned-section');
  assert.match(pinned, /<div class="cm-grid" data-cm-grid="pinned">/);
  assert.doesNotMatch(pinned, /communities-grid/, 'no tiles beside the cards');
  // One link to the hub, with the tile's hooks, the picture first.
  assert.match(pinned, /<a href="\/app\/tide\/workshop" class="cm-card" data-home-community="tide" data-home-community-pinned=""><span class="cm-card-pic"><img src="\/app-illustrations\/aaaa" alt="" loading="lazy" draggable="false" class="cm-card-img dark:hidden"\/><img src="\/app-illustrations\/bbbb"/);
  // The name over the members, what it is, and this week on one line.
  assert.match(pinned, /<span class="cm-card-name">Tide Table<\/span><span class="cm-card-members" data-cm-members="">93 members<\/span>/);
  assert.match(pinned, /<span class="cm-card-desc" data-cm-desc="">Tides for the bay\.<\/span>/);
  assert.match(pinned, /<span class="cm-week-in"><span>33 active<\/span><span class="cm-week-live">5 changes live this week<\/span><\/span>/);
  // The votes waiting on the icon's corner, with their words for a screen reader.
  assert.match(pinned, /<span class="cm-card-face"><span class="cm-card-icon" data-icon="emoji" aria-hidden="true">[\s\S]*?data-home-community-votes="2"/);
  assert.match(pinned, new RegExp(`<span class="sr-only">${message('communities:row.toVote', { count: 2 })}</span>`));
  // A pin with no picture wears its background; with no week, it says nothing; with no activity yet, its joined count or no line at all.
  const garden = pinned.slice(pinned.indexOf('data-home-community="garden"'));
  assert.match(garden, /^data-home-community="garden" data-home-community-pinned=""><span class="cm-card-pic" data-cm-scene="[1-6]"><\/span>/);
  assert.doesNotMatch(garden, /cm-card-week|cm-card-members|cm-card-desc/);

  const joined = section(html, 'communities-joined-section');
  assert.match(joined, /<div class="cm-grid" data-cm-grid="joined">/);
  assert.doesNotMatch(joined, /class="wip-card"/, 'the compact cards stand on the page, no group card round them');
  assert.match(joined, /<a href="\/app\/orchard\/workshop" class="cm-card" data-cm-size="compact" data-home-community="orchard" data-home-community-pinned=""><span class="cm-card-head"><span class="cm-card-face"><span class="cm-card-icon" data-icon="emoji"/);
  assert.match(joined, /<span class="cm-card-name">Orchard<\/span><span class="cm-card-members" data-cm-members="">34 members<\/span>/, 'the joined list\'s own count');
  assert.match(joined, /data-home-community-votes="1"/);
  assert.doesNotMatch(joined, /cm-card-pic|cm-card-week|cm-card-desc/, 'no picture, no sentence, no week');
});

test('under 768px the standard look keeps the small tiles, with the picture on the band and the real icon on it', () => {
  const html = withCards(393, 'standard', { ready: true, pins: PICTURED, joined: JOINED_COUNTED, owed: {} },
    (mod) => renderToHtml(createElement(mod.CommunitiesScreen, {})));
  const pinned = section(html, 'communities-pinned-section');
  assert.match(pinned, /class="communities-grid grid grid-cols-4 /);
  assert.match(pinned, /data-home-community="tide" data-home-community-pinned="" data-home-community-scene="[1-6]" data-home-community-picture="" style="--cm-pic:url\(&quot;\/app-illustrations\/aaaa&quot;\);--cm-pic-dark:url\(&quot;\/app-illustrations\/bbbb&quot;\)"/);
  assert.match(pinned, /data-home-community="garden" data-home-community-pinned="" data-home-community-scene="[1-6]">/, 'no picture: the background alone');
  assert.match(pinned, /<span class="app-icon-tile w-14 h-14 [^"]* home-community-logo" data-icon="emoji" aria-hidden="true">/, 'the icon at the tile\'s own size');
  assert.doesNotMatch(read('frontend/src/features/home/pinned-communities.tsx'), /CommunityEmblem|CommunityApps|CommunityDetail/, 'no emblem, no row of apps, no faces');
  // Joined is the compact card at every width.
  assert.match(section(html, 'communities-joined-section'), /<div class="cm-grid" data-cm-grid="joined">/);
});

test('the brand look draws the cards from 1280px and keeps its tiles under that', () => {
  const state = { ready: true, pins: PICTURED, joined: JOINED_COUNTED, owed: {} };
  const wide = withCards(1440, 'brand', state, (mod) => renderToHtml(createElement(mod.CommunitiesScreen, {})));
  assert.match(section(wide, 'communities-pinned-section'), /<div class="cm-grid" data-cm-grid="pinned">/);
  assert.match(section(wide, 'communities-joined-section'), /<div class="cm-grid" data-cm-grid="joined">/);
  const narrow = withCards(1024, 'brand', state, (mod) => renderToHtml(createElement(mod.CommunitiesScreen, {})));
  assert.match(section(narrow, 'communities-pinned-section'), /class="communities-grid /);
  assert.doesNotMatch(narrow, /cm-card/);
  assert.match(section(narrow, 'communities-pinned-section'), /<span class="rounded-\[21px\] p-\[3px\]/, 'its tile is the icon in its ring, as before');
});
