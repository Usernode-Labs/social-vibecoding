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

function withStores(pins, scope, run) {
  const mod = loadTsx('tests/fixtures/communities-page-api.ts');
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
  const html = renderComponent(PAGE, 'CommunitiesScreen', {});
  assert.match(html, /<main id="communities-screen" class="hidden /,
    'the root ships hidden, with `hidden` first in a constant class string');
  assert.match(html, /<section id="communities-pinned-section" class="px-3" hidden="">/);
  assert.match(html, /<section id="communities-joined-section" class="px-3" hidden="">/);
  assert.doesNotMatch(html, /data-home-community=/, 'the pins are client data: none of them in the first render');
  assert.doesNotMatch(html, /communities-new-community|communities-needs-tile|communities-new-top/);
  // The standard look draws the kit's page, so Discover (which only the brand
  // and frame looks draw) is absent from the prerender. It still mounts after
  // mount in a look that draws it.
  assert.doesNotMatch(html, /communities-discover-section/);
  assert.doesNotMatch(read(PAGE), /const wip = skin === 'wip';/, 'Standard is a kit page now');
  assert.match(read(PAGE), /\{kitPage \? null : \(\s*<section id="communities-discover-section"/);
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

test('the standard look draws the kit\'s page: a pinned shelf with emblems, Joined rows with app icons, New community above', () => {
  const html = withStores(
    { ready: true, pins: PINS, joined: JOINED, owed: { tide: 2, orchard: 1 } },
    { badgeNeeds: 3 },
    (mod) => renderToHtml(createElement(mod.CommunitiesScreen, {})),
  );
  const pinned = section(html, 'communities-pinned-section');
  assert.doesNotMatch(pinned.slice(0, pinned.indexOf('>')), /hidden/);
  assert.match(pinned, new RegExp(`>${message('communities:page.pinned')}<`));
  // Home has the Needs you card in this look, so its tile is not drawn here.
  assert.doesNotMatch(pinned, /communities-needs-tile/);
  assert.ok(pinned.indexOf('data-home-community="tide"') < pinned.indexOf('data-home-community="garden"'), 'the pins, in their order');
  assert.match(pinned, /data-home-community="tide" data-home-community-pinned=""/);
  assert.match(pinned, /data-home-community-votes="2"/, 'a pinned community says its own votes');
  assert.match(pinned, /class="app-icon-tile w-14 h-14 shrink-0 rounded-\[16px\] overflow-hidden flex items-center justify-center font-bold text-2xl home-community-emblem" data-emblem="[0-9]+" data-emblem-tone="[0-9]+"/,
    'a pinned community wears one of the kit\'s emblems, in one of its four colours');
  assert.doesNotMatch(pinned, /home-community-logo/, 'the soft glow is gone');
  assert.match(pinned, new RegExp(`id="communities-edit"[^>]*aria-label="${message('communities:page.editLabel')}"`), 'Edit rides Pinned');

  const joined = section(html, 'communities-joined-section');
  assert.match(joined, new RegExp(`>${message('communities:page.joined')}<`));
  assert.match(joined, /data-home-community="orchard"/, 'in it, not pinned');
  assert.doesNotMatch(joined, /data-home-community="tide"|data-home-community="garden"/, 'a pinned one is not listed twice');
  assert.doesNotMatch(joined, /home-community-emblem/, 'a Joined row shows the project\'s own icon');
  assert.match(joined, /class="app-icon-tile w-14 h-14 /, 'its icon face');
  assert.doesNotMatch(joined, /communities-edit/, 'one Edit on the page');
  assert.doesNotMatch(joined, new RegExp(message('home:communities.pinNamed', { community: 'Orchard' })), 'no + until Edit is pressed');
  assert.doesNotMatch(joined, /communities-new-community/, 'the dashed New community tile is gone');

  assert.match(html, /id="communities-new-top"/, 'New community is the filled button above, on every width');
  assert.match(read(PAGE), /const kitPage = isKitHome\(skin\);/);
  assert.match(read(PAGE), /const createTile = offerCreate && !q && !editing && !kitPage;/, 'a kit page draws the button, never the tile');
  assert.match(read(PAGE), /const kit = kitPage \|\| brand;/);
  assert.match(read(PAGE), /const needsTile = !kit && needs > 0 && !q && !editing;/, 'those looks say Needs you on Home');

  // Communities to join is listed under Joined, as on Home; Discover is not drawn.
  const all = section(html, 'communities-all-section');
  assert.match(all, /data-home-join-section/, 'the directory section is on the page');
  assert.ok(html.indexOf('communities-joined-section') < html.indexOf('communities-all-section'), 'under Joined');
  assert.doesNotMatch(html, /communities-discover-section|communities-discover-btn/);
  assert.match(read(PAGE), /win\.Home\?\.showCommunitiesToJoin\) win\.Home\.showCommunitiesToJoin\(\);/, 'Discover opens Home at Communities to join');
});

test('a group folds to its first 12, and its label opens the rest', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ slug: `c${i}`, name: `Community ${i}`, iconUrl: null, iconEmoji: null, iconColor: null, member: true }));
  const html = withStores(
    { ready: true, pins: many, joined: [], owed: {} },
    { badgeNeeds: 0 },
    (mod) => renderToHtml(createElement(mod.CommunitiesScreen, {})),
  );
  const pinned = section(html, 'communities-pinned-section');
  assert.equal((pinned.match(/data-home-community="/g) || []).length, 12, 'the first 12');
  assert.match(pinned, new RegExp(`id="communities-pinned-all"[^>]*aria-label="${message('communities:page.showAll', { count: 14 })}"`));
  assert.match(read(PAGE), /const FOLD_AT = 12;/);
  assert.match(read(PAGE), /const folds = kitPage && !q && !editing;/, 'a search or an edit shows all of a group');
  assert.match(read(PAGE), /<WipHeadMore id=\{`communities-\$\{key\}-all`\} direction="down" expanded=\{false\} label=\{t\('communities:page\.showAll', \{ count \}\)\}/);
  assert.match(read(PAGE), /<WipHeadMore id=\{`communities-\$\{key\}-less`\} direction="up" expanded label=\{t\('communities:page\.showLess'\)\}/);
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
  assert.match(none, /communities-new-top/, 'New community is still offered, as the filled button');
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

test('a community\'s emblem is the same every time, and within the ten marks and four colours', () => {
  const mod = loadTsx('frontend/src/features/home/pinned-communities.tsx');
  assert.equal(mod.EMBLEM_MARKS, 10);
  assert.equal(mod.EMBLEM_TONES, 4);
  const tide = mod.communityEmblem('tide');
  assert.deepEqual(mod.communityEmblem('tide'), tide, 'the same community, the same emblem');
  for (const slug of ['tide', 'garden', 'orchard', 'book-swap', 'c0', 'zzz']) {
    const e = mod.communityEmblem(slug);
    assert.ok(e.mark >= 1 && e.mark <= 10, `${slug}: mark within 1..10`);
    assert.ok(e.tone >= 1 && e.tone <= 4, `${slug}: tone within 1..4`);
  }
  const marks = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((s) => mod.communityEmblem(s).mark);
  assert.ok(new Set(marks).size > 1, 'two different addresses can differ');
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

test('the standard look draws the page as Home is: its typeface, the short search row on a phone too, and Communities to join under Joined', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'features', 'communities', 'index.tsx'), 'utf8');
  // The kit's page is the standard look's too; only its own ground stays Standard (WIP)'s.
  assert.match(css, /html:not\(\[data-skin\]\) #communities-screen \{\s*font-family: var\(--wip-font\);/);
  assert.match(css, /html\[data-skin-wip\] #communities-screen \{ background-color: var\(--wip-page-bg-communities\); \}/);
  assert.match(css, /html:not\(\[data-skin\]\) #communities-screen \.communities-grid \{\s*grid-template-columns: repeat\(var\(--wip-cols\), minmax\(0, 1fr\)\);/);
  assert.match(css, /html:not\(\[data-skin\]\) #communities-screen \.communities-grid \[data-home-community-meta\] \{\s*display: block;/);
  assert.match(css, /html:not\(\[data-skin\]\) #communities-screen \.communities-grid \[data-home-community-detail\] \{\s*display: flex;/, 'and what happened there this week');
  assert.match(page, /const cards = \(brand && wide\) \|\| kitPage;/, 'the members are read at every width the kit page draws');
  // Every community there is to join is listed under Joined, by Home's own section under ids of its own.
  assert.match(page, /ids=\{\{ section: 'communities-all-section', featured: 'communities-all-featured-label' \}\}/);
  assert.match(css, /html:not\(\[data-skin\]\) #communities-all-section > \[data-home-join-featured\] \{\s*order: -1;/);
});
