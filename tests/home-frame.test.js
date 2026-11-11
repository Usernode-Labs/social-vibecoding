// Home in the one frame, version 2 (docs/superpowers/plans/
// 2026-11-11-looks-v2-todays-content.md, lane H): the first tour's layout
// holding today's Home. The kit page binds the standard Home's own stores,
// handlers and catalog ids; what the first tour invented (Needs you rows,
// communities as rows, Live this week, Your week, the season row, picture
// cards, and the two pages All apps and All communities) is gone.
//
// The standard Home is untouched: HomeScreen mounts <HomeFrame/> as the
// scroller's first child only after mount, when the device's look is one of
// the frame's nine (lib/skin.ts) and the viewer is signed in, and app.css
// hides the standard body beside it while data-frame-page is set.
//
// Run with: node --test tests/home-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const HOME_FRAME = 'frontend/src/features/home/frame/home-frame.tsx';
const SRC = read(HOME_FRAME);

// A store the way lib/plain-store.js shapes one, holding `state` for good.
const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });
const matchesQuery = (query, ...fields) => !query || fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(query.toLowerCase()));

// The modules HomeFrame reads, stubbed by the specifier it imports them as.
function homeStubs({ pins = [], joined = [], owed = {}, apps = [], grid = {}, moreCount = 0, needs = 0, challenges = null, query = '', live = [] } = {}) {
  return {
    '../grid-store': { gridStore: fixedStore({ ready: true, view: 'grid', editing: false, rowTemplate: '', resultsHeading: null, emptyQuery: null, notice: null, create: null, items: apps.map((app) => ({ kind: 'card', placement: null, app })), ...grid }) },
    '../chrome-store': { chromeStore: fixedStore({ moreCount, strip: { active: false, helpVisible: false, tiles: [] } }) },
    '../home-pins-store': { homePinsStore: fixedStore({ ready: true, pins, joined, owed }), setHomePin: async () => {} },
    '../communities-to-join': {
      JOIN_PAGE: 8,
      joinOrder: (list) => [...list.filter((a) => a.featured), ...list.filter((a) => !a.featured)],
      readDirectory: async () => [],
      scrollParent: () => null,
    },
    '../add-apps-sheet': { openAddAppsSheet() {} },
    '../use-home-query': { useHomeQuery: () => query, matchesQuery },
    '../panels-store': { panelsStore: fixedStore({ painted: true, challenges }) },
    '../../app-frame/live-apps': { useLiveAppSlugs: () => live, liveAppLabel: () => 'Still open' },
    '../../workshop/community-scope': { communityScopeStore: fixedStore({ slug: null, list: [], badgeNeeds: needs }) },
  };
}
const render = (props = {}, stubs = homeStubs()) => renderComponent(HOME_FRAME, 'HomeFrame', props, { stubs, cache: false });
const pin = (slug, name) => ({ slug, name, iconUrl: null, iconEmoji: null, iconColor: null, member: true });
const joined = (slug, name) => ({ slug, name, icon_url: null, icon_emoji: null, icon_color: null });
const app = (slug, name, more = {}) => ({
  slug, name, status: 'running', icon: { kind: 'letter', letter: name[0] }, locked: false, demo: false, statusLabel: '', buildLine: null,
  isAwaiting: false, isError: false, clickable: true, failureReason: null, showRetry: false, forkName: null, audience: 'open', ...more,
});
const group = (html, id) => html.slice(html.indexOf(`id="${id}"`), html.indexOf('</section>', html.indexOf(`id="${id}"`)));
const count = (html, re) => (html.match(re) || []).length;
const CHALLENGES = { key: 'next', title: 'Challenges', mode: 'next', heading: 'Next challenges', seeAll: true, note: null, rows: [
  { id: '31', eventId: 7, icon: null, illustration: 'make-a-proposal', illustrationTone: null, goal: 'Use apps for 10 minutes', done: false, reward: '1,000 pts', earned: '', state: 'progress', stateLabel: 'Started', fill: 0.4 },
  { id: '32', eventId: null, icon: '🏆', illustration: null, illustrationTone: null, goal: 'Join a community', done: true, reward: '500 pts', earned: '500 pts', state: 'done', stateLabel: 'Done', fill: 1 },
] };

test('HomeScreen mounts the kit page only after mount, for a signed-in viewer under a frame look', () => {
  const src = read('frontend', 'src', 'features', 'home', 'index.tsx');
  assert.match(src, /import \{ isFrameSkin, useSkin \} from '\.\.\/\.\.\/lib\/skin'/);
  assert.match(src, /const skin = useSkin\(\)/);
  assert.match(src, /useEffect\(\(\) => whenPlatformViewer\(\(\) => setViewer\(true\)\), \[\]\)/,
    'only for a viewer the member APIs answer: the landing and the waiting room keep the standard body');
  assert.match(src, /const frame = isFrameSkin\(skin\) && viewer;/, 'never on the first render: useSkin answers standard until mounted');
  assert.match(src, /data-frame-page=\{frame \? '' : undefined\}/, 'the scroller says a kit page is in it');
  assert.match(src, /\{frame \? <HomeFrame \/> : null\}/);
  assert.match(src, /id="home-apps-section"/, 'the standard body is still there, mounted beside it');
  assert.match(read('public', 'css', 'app.css'), /html\[data-skin\] \[data-frame-page\] > :not\(\.fr\) \{ display: none !important; \}/,
    'and app.css hides the standard body while the kit page is up');
});

test('the page is the kit\'s: the head with one fixed sentence, the search field, then the tour\'s two columns', () => {
  const html = render({}, homeStubs({ apps: [app('a', 'Alpha')], challenges: CHALLENGES }));
  assert.match(html, /^<div class="fr" data-home-frame=""><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Home<\/h1><p class="fr-purpose">Your apps and your communities\.<\/p><\/div><\/div><div data-home-frame-search=""><div class="fr-search">/);
  assert.doesNotMatch(html, /class="fr-acts"/, 'no button in the head: New project is Pinned apps\' own');
  assert.match(html, /<input type="search" class="fr-v" placeholder="Search apps and communities… \(Ctrl\+K\)" aria-label="Search apps and communities" value=""\/>/, 'the standard field\'s own words');
  assert.match(html, /<div class="fr-cols"><div class="fr-stack">/, 'the tour\'s 720 and 320, not the wide Home of 10 Nov');
  assert.doesNotMatch(html, /fr-wide|fr-first/, 'and the side column comes after the main one on a phone');
  assert.match(render(), /<div class="fr-cols fr-one"><div class="fr-stack">/, 'no side column without challenges');
  // Kit classes only: a utility class beside a look's rule would break one of the nine.
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  assert.ok(classes.length > 10);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('what the first tour invented is gone: no Needs you rows, Live this week, Your week, season, picture cards or pages', () => {
  const html = render({ initialDirectory: [{ slug: 'star', name: 'Star', featured: true, illustration_url: '/i/9' }] }, homeStubs({ apps: [app('a', 'Alpha')], pins: [pin('p', 'Pourover')], owed: { p: 2 }, needs: 2, challenges: CHALLENGES }));
  for (const id of ['home-frame-needs"', 'home-frame-live', 'home-frame-week', 'home-frame-featured']) assert.doesNotMatch(html, new RegExp(`id="${id}`), id);
  assert.doesNotMatch(html, /Live this week|Your week|Season|Make a project|Browse all|fr-fcard|fr-ccard|fr-facts/);
  for (const gone of ['needs-feed', 'bot-questions', 'live-feed', '/api/workshop/counts', 'MyStanding', 'HomeAllApps', 'HomeAllCommunities', 'useFramePage', 'APPS_SHOWN', 'JOIN_SHOWN', 'fetch(']) {
    assert.ok(!SRC.includes(gone), `${gone} is no longer read`);
  }
  for (const f of ['home-all-apps.tsx', 'home-all-communities.tsx']) {
    assert.ok(!fs.existsSync(path.join(ROOT, 'frontend', 'src', 'features', 'home', 'frame', f)), `${f} is retired: Home opens both in place`);
  }
  const en = JSON.parse(read('frontend', 'locales', 'en', 'home.json'));
  assert.deepEqual(Object.keys(en).filter((key) => key.startsWith('frame.')), ['frame.title', 'frame.purpose'], 'the page words only its title and its sentence');
  for (const key of ['frame.title', 'frame.purpose']) assert.doesNotMatch(en[key].description, /glass/i, `${key}: described for every look`);
  assert.doesNotMatch(SRC, />[A-Z][a-z]+ [a-z]+</, 'no English literal in the component');
});

test('the search field drives Home\'s own search, and the shortcut finds it', () => {
  assert.match(SRC, /own\.value = next;\s*own\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\);/, 'each change is written into #home-search-input with the event home.js and use-home-query listen for');
  assert.match(SRC, /const query = useHomeQuery\(\);/, 'the communities read the same words');
  assert.match(SRC, /setAttribute\('aria-keyshortcuts', HOME_SEARCH_SHORTCUT_KEYS\)/);
  assert.match(SRC, /if \(event\.key !== 'Escape' \|\| !words\) return;/, 'Escape clears it, as on the standard field');
  const home = read('frontend', 'src', 'features', 'home', 'home.js');
  assert.match(home, /_searchField\(\) \{\s*return document\.querySelector\('\[data-home-frame-search\] input'\) \|\| document\.getElementById\('home-search-input'\);/);
  assert.match(home, /const input = Home\._searchField\(\);/, 'Home.focusSearch (the bar\'s search, the sidebar\'s) lands in it');
  assert.match(home, /if \(!showing \|\| Home\._searchField\(\) !== input\) \{ Home\.focusSearch\(\); return; \}/, 'and so do Ctrl+K and /');
  assert.match(home, /document\.getElementById\('home-frame-communities'\) \|\| document\.getElementById\('home-communities-section'\)/, 'Home.showCommunities scrolls to the kit section under a look');
});

test('Pinned apps: the launcher\'s tiles, Edit, and the row that unfolds the grid', () => {
  const few = render({}, homeStubs({ apps: [app('game-corner', 'Game Corner'), app('viatales', 'ViaTales')], moreCount: 94 }));
  const g = group(few, 'home-frame-apps');
  assert.match(g, /<h2 class="fr-cap">Pinned apps<\/h2><button type="button" class="fr-link">Edit<\/button><\/div>/);
  assert.match(g, /<div class="fr-card"><div class="fr-tiles"><div class="fr-at" title="Game Corner\. Hold or right-click for app actions"><a class="fr-atl" href="\/app\/game-corner">/);
  assert.match(g, /<span class="fr-tile" style="--fr-ts:52px;--fr-tc:#fff" aria-hidden="true">G<\/span><span class="fr-nm">Game Corner<\/span>/);
  assert.equal(count(g, /class="fr-at"/g), 2);
  assert.doesNotMatch(g, /class="fr-n"/, 'an app tile carries no count: the standard tile has none');
  assert.match(g, /<\/div><button type="button" class="fr-row fr-sm fr-showall"><span class="fr-tx"><span class="fr-t">Show all 94 apps<\/span><\/span><svg class="fr-ic fr-go"/, 'the row that ends the card, from the chrome store\'s count');
  assert.match(SRC, /N\._appsExpanded = true;\s*N\.render\(\);/, 'pressing it is apps-more.tsx\'s own press: Home unfolds its grid');
  assert.doesNotMatch(group(render({}, homeStubs({ apps: [app('a', 'Alpha')] })), 'home-frame-apps'), /fr-showall/, 'nothing folded: no row');
  assert.doesNotMatch(render(), />Pinned apps</, 'a private member\'s empty grid: no group (the standard rule, noApps)');
});

test('New project: the heading\'s link while the folded grid holds the tile back, else the grid\'s last tile', () => {
  const held = group(render({}, homeStubs({ apps: [app('a', 'Alpha')], grid: { create: { enabled: true, hint: 'h', heldBack: true, placement: null } } })), 'home-frame-apps');
  assert.match(held, />Edit<\/button><button type="button" class="fr-link">New project<\/button><\/div>/);
  assert.doesNotMatch(held, /id="home-frame-create"/);
  const tile = group(render({}, homeStubs({ apps: [app('a', 'Alpha')], grid: { create: { enabled: true, hint: 'h', heldBack: false, placement: null } } })), 'home-frame-apps');
  assert.match(tile, /<div class="fr-at" title="Start a project: an app for you or for a community"><button type="button" class="fr-atl" id="home-frame-create"><span class="fr-lead fr-dash"[^>]*>.*?<\/span><span class="fr-nm">New project<\/span><\/button><\/div><\/div><\/div>$/s, 'dashed, the last tile');
  assert.doesNotMatch(tile, />New project<\/button><\/div><div class="fr-card">/, 'not both at once: the store decides');
  const locked = group(render({}, homeStubs({ grid: { create: { enabled: false, hint: 'View your app allowance.', heldBack: false, placement: null } } })), 'home-frame-apps');
  assert.match(locked, /<div class="fr-at fr-dim" title="New project\. View app quota\. View your app allowance\."><button type="button" class="fr-atl" id="home-frame-create" aria-label="New project\. View app quota\. View your app allowance\.">/, 'an account at rest with no slot left: the tile alone, muted, saying why');
});

test('editing Pinned apps: every tile takes a − that removes it, and the heading offers Add other apps and Done', () => {
  const g = group(render({}, homeStubs({ apps: [app('a', 'Alpha'), app('demo', 'Demo', { demo: true })], grid: { editing: true } })), 'home-frame-apps');
  assert.match(g, /data-editing=""/);
  assert.match(g, /<button type="button" class="fr-link">Add other apps<\/button><button type="button" class="fr-link">Done<\/button><\/div>/);
  assert.match(g, /<span class="fr-atl"><span class="fr-tile"[^>]*>A<\/span><span class="fr-nm">Alpha<\/span><\/span><button type="button" class="fr-corner fr-un" aria-label="Remove Alpha from Pinned apps"><span aria-hidden="true">−<\/span><\/button>/, 'a tile being arranged is not a door');
  assert.equal(count(g, /fr-corner/g), 1, 'never on a demo tile');
  assert.match(SRC, /home\(\)\?\._editRemove\?\.\(app\.slug\)/, 'the − is the standard badge\'s own action');
  assert.match(SRC, /home\(\)\?\.setEditing\?\.\(true\)/);
  assert.match(SRC, /home\(\)\?\.setEditing\?\.\(false\)/);
  assert.match(SRC, /<GroupLink onClick=\{\(\) => \{ openAddAppsSheet\(\); \}\}>/);
});

test('an app tile says what the standard tile says: who it is for, where it came from, still open, and a failed start', () => {
  const g = group(render({}, homeStubs({ live: ['solo'], apps: [
    app('solo', 'Solo', { audience: 'solo' }),
    app('team', 'Team', { audience: 'invited', forkName: 'Origin' }),
    app('broken', 'Broken', { clickable: false, showRetry: true, statusLabel: 'Error', isError: true, failureReason: 'boot failed' }),
    app('making', 'Making', { clickable: false, statusLabel: 'Spinning up...', isAwaiting: true }),
  ] })), 'home-frame-apps');
  assert.match(g, /<span class="fr-tag fr-r" role="img" title="Just you" aria-label="Just you">/);
  assert.match(g, /<span class="fr-live" role="img" title="Still open" aria-label="Still open"><\/span>/);
  assert.match(g, /<span class="fr-tag fr-l" role="img" title="Made from Origin" aria-label="Made from Origin">.*?<span class="fr-tag fr-r" role="img" title="Private community"/s);
  assert.match(g, /<div class="fr-at" title="Broken[^"]*"><span class="fr-atl">.*?<\/span><span class="fr-st fr-bad" title="boot failed">Error<\/span><button type="button" class="fr-link" aria-label="Retry Broken">Retry<\/button><\/div>/s, 'it cannot open: no door, its status, and Retry');
  assert.match(g, /<div class="fr-at fr-dim" title="Making[^"]*"><span class="fr-atl">.*?<span class="fr-st fr-wait">Spinning up\.\.\.<\/span><\/div>/s);
  assert.match(SRC, /N\.openCardMenu\(app\.slug, event\.currentTarget\)/, 'a right-click opens the tile\'s own menu');
});

test('a search shows Home\'s own results: its heading, its no-match line, and a failed load says so', () => {
  const found = group(render({}, homeStubs({ query: 'al', apps: [app('a', 'Alpha')], grid: { view: 'search', resultsHeading: '1 result' } })), 'home-frame-apps');
  assert.match(found, /<h3 class="fr-cap fr-sub">1 result<\/h3><div class="fr-card"><div class="fr-tiles">/);
  assert.doesNotMatch(found, />Edit</, 'a search is not the shelf');
  const none = group(render({}, homeStubs({ query: 'zz', grid: { view: 'search', emptyQuery: 'zz' } })), 'home-frame-apps');
  assert.match(none, /<p class="fr-secnote">No apps match “zz”\. Clear the search and try <span class="fr-acc">Discover communities<\/span> below\.<\/p>/);
  const failed = group(render({}, homeStubs({ grid: { notice: { text: 'Couldn\'t load your apps', tone: 'error' } } })), 'home-frame-apps');
  assert.match(failed, /<div class="fr-note fr-bad">.*?Couldn&#x27;t load your apps.*?<button type="button" class="fr-btn fr-quiet fr-sm">Try again<\/button>/s);
});

test('Pinned communities are tiles: the pins with what is owed, then Needs you, All communities and New community', () => {
  const html = render({}, homeStubs({
    pins: [pin('pourover', 'Pourover Coffee'), pin('quiet', 'Quiet Place')], joined: [joined('pourover', 'Pourover Coffee'), joined('other', 'Other One')],
    owed: { pourover: 1, quiet: 0 }, needs: 7,
  }));
  const g = group(html, 'home-frame-communities');
  assert.match(g, /<h2 class="fr-cap">Pinned communities<\/h2><button type="button" class="fr-link" aria-label="Edit Pinned communities">Edit<\/button>/);
  assert.match(g, /<div class="fr-card"><div class="fr-tiles"><div class="fr-at"><a class="fr-atl" href="\/app\/pourover\/workshop\?ws=status"><span class="fr-tile"[^>]*>P<\/span><span class="fr-n">1<\/span><span class="fr-nm">Pourover Coffee<\/span><\/a><\/div>/, 'a tile, with the votes waiting there');
  assert.doesNotMatch(g, /class="fr-row/, 'no rows: today\'s Home draws communities as tiles');
  assert.doesNotMatch(g, /Other One/, 'a community you are in and have not pinned stays out until All communities is pressed');
  assert.match(g, /<a class="fr-atl" id="home-frame-needs-tile" href="#needs" aria-label="Needs you: 7 votes waiting on you"><span class="fr-lead fr-acc"[^>]*>.*?<\/span><span class="fr-n">7<\/span><span class="fr-nm">Needs you<\/span><\/a>/s);
  assert.match(g, /<button type="button" class="fr-atl" id="home-frame-all-communities" aria-pressed="false">.*?<span class="fr-nm">All communities<\/span>/s);
  assert.match(g, /<button type="button" class="fr-atl" id="home-frame-new-community"[^>]*><span class="fr-lead fr-dash"/);
  assert.ok(g.indexOf('home-frame-needs-tile') < g.indexOf('home-frame-all-communities') && g.indexOf('home-frame-all-communities') < g.indexOf('home-frame-new-community'), 'in the standard order');
  const quiet = group(render({}, homeStubs({ pins: [pin('a', 'Alpha')], joined: [joined('a', 'Alpha')] })), 'home-frame-communities');
  assert.doesNotMatch(quiet, /home-frame-needs-tile|home-frame-all-communities/, 'a zero says nothing, and with every community pinned there is no All tile');
  assert.match(SRC, /document\.addEventListener\('home:show-all-communities', open\)/, 'All communities anywhere else opens the section\'s');
  assert.match(SRC, /lit=\{showAll\}\s*pressed=\{showAll\}/);
  assert.match(SRC, /\{\(showAll \|\| query\) && !editing \? unpinned\.map/, 'while it is on, or while searching, the unpinned ones follow');
  assert.match(SRC, /void setHomePin\(\{ \.\.\.c, member: true \} as HomePin, true, say\(c\.name\)\)/, 'a + pins one');
  assert.match(SRC, /void setHomePin\(pin, false, say\(pin\.name\)\)/, 'Edit\'s − unpins one');
});

test('a search finds a community you have not pinned, faded, with a + to pin it', () => {
  const g = group(render({}, homeStubs({ query: 'oth', pins: [pin('a', 'Alpha')], joined: [joined('a', 'Alpha'), joined('other', 'Other One')], needs: 3 })), 'home-frame-communities');
  assert.match(g, /<div class="fr-at fr-dim"><a class="fr-atl" href="\/app\/other\/workshop\?ws=status">.*?<span class="fr-nm">Other One<\/span><\/a><button type="button" class="fr-corner" aria-label="Pin Other One to Home">/s);
  assert.doesNotMatch(g, /Alpha|home-frame-needs-tile|home-frame-new-community|>Edit</, 'only what matches; the section\'s own tiles and Edit wait for the search to end');
});

test('Communities to join: the kind filter, Featured as cards, then the rest as rows, each with a real Join', () => {
  const dir = [
    { slug: 'plain', name: 'Plain', member_count: 3, description: 'A plain one.', category: 'games' },
    { slug: 'busy', name: 'Busy', member_count: 30, open_votes: 2, category: 'social' },
    { slug: 'star', name: 'Star', member_count: 9, featured: true, featured_order: 1, description: 'Twelve small games.', category: 'games' },
    { slug: 'moon', name: 'Moon', member_count: 4, featured: true, featured_order: 0, icon_emoji: '🌙', category: 'social' },
    { slug: 'mine', name: 'Mine', member_count: 1, category: 'games' },
  ];
  const html = render({ initialDirectory: dir }, homeStubs({ pins: [pin('mine', 'Mine')] }));
  const g = group(html, 'home-frame-to-join');
  assert.match(g, /<h2 class="fr-cap">Communities to join<\/h2><\/div><div class="fr-btnrow fr-chips" role="group" aria-label="[^"]+"><button type="button" class="fr-btn fr-sm" aria-pressed="true" data-home-join-kind="all">All<\/button><button type="button" class="fr-btn fr-quiet fr-sm" aria-pressed="false" data-home-join-kind="games">Games<\/button>/);
  assert.match(g, /<h3 class="fr-cap fr-sub">Featured<\/h3><div class="fr-grid fr-across" data-home-join-featured=""><div class="fr-card fr-pad fr-hcard"><span class="fr-hc-top"><span class="fr-tile" style="--fr-ts:44px;--fr-tc:#fff" aria-hidden="true">🌙<\/span><button type="button" class="fr-btn fr-sm" data-home-join="moon" aria-label="Join Moon">Join<\/button><\/span><span class="fr-t2"><a class="fr-door" href="\/app\/moon\/workshop\?ws=status">Moon<\/a><\/span><span class="fr-s2">4 members<\/span><\/div>/, 'in their featured order: the tile and Join, the name as the door, the standard line');
  assert.match(g, /<span class="fr-t2"><a class="fr-door" href="\/app\/star\/workshop\?ws=status">Star<\/a><\/span><span class="fr-s2">9 members<\/span><span class="fr-s2 fr-two">Twelve small games\.<\/span>/);
  assert.match(g, /<div class="fr-card"><div class="fr-row"><span class="fr-tile"[^>]*>P<\/span><span class="fr-tx"><span class="fr-t"><a class="fr-door" href="\/app\/plain\/workshop\?ws=status">Plain<\/a><\/span><span class="fr-s">3 members<\/span><\/span><button type="button" class="fr-btn fr-sm" data-home-join="plain" aria-label="Join Plain">Join<\/button><\/div>/);
  assert.match(g, /<span class="fr-s">2 up for a vote<\/span>/, 'votes when a change waits, else members: the standard footer\'s rule');
  assert.doesNotMatch(g, /Mine/, 'what is already on this Home is left out');
  assert.equal(count(g, />Moon</g), 1, 'a featured community is not listed twice');
  assert.doesNotMatch(g, /fr-fcard|Browse all|Public community/, 'no picture cards, no Browse all');
  assert.match(SRC, /void win\(\)\?\.Home\?\.setMembership\?\.\(app\.slug, true\)/, 'Join is Home.setMembership, which joins and pins');
  assert.match(SRC, /setShown\(\(n\) => n \+ JOIN_PAGE\)/, 'more as the reader reaches the end, by the standard page');
  assert.match(SRC, /kind \? t\('home:join\.endKind'\) : t\('home:join\.end'\)/);
  assert.match(SRC, /t\('home:join\.failed'\)/);
  assert.match(SRC, /t\('home:join\.empty'\) : t\('home:join\.allJoined'\)/);
  const searched = group(render({ initialDirectory: dir }, homeStubs({ query: 'star' })), 'home-frame-to-join');
  assert.doesNotMatch(searched, /Featured|fr-chips/, 'a search leaves Featured and the filter out: its matches are the list');
  assert.match(searched, /<span class="fr-t"><a class="fr-door" href="\/app\/star\/workshop\?ws=status">Star<\/a>/);
});

test('Next challenges is the side column: Home\'s own strip as rows', () => {
  const html = render({}, homeStubs({ challenges: CHALLENGES }));
  assert.match(html, /<\/div><div class="fr-stack"><section class="fr-sec" id="home-frame-challenges"><div class="fr-sechead"><h2 class="fr-cap">Next challenges<\/h2><a class="fr-link" href="#leaderboard\/challenges">See all<\/a><\/div><div class="fr-card"><a class="fr-row fr-wrap" href="#leaderboard\/challenges\/7\/31"><span class="fr-lead" aria-hidden="true"><svg.*?<\/svg><\/span><span class="fr-tx"><span class="fr-t">Use apps for 10 minutes<\/span><span class="fr-s">Started<\/span><\/span><span class="fr-pill" data-kind="none">1,000 pts<\/span><\/a>/s);
  assert.match(html, /<a class="fr-row fr-wrap" href="#leaderboard\/challenges"><span class="fr-lead">🏆<\/span>.*?<span class="fr-pill fr-ok" data-kind="ok">500 pts<\/span><\/a>/s, 'a done one: what it earned, in green; no event, so the list');
  assert.match(SRC, /win\(\)\?\.HomePanels\?\.goToChallenge\?\.\(row\.eventId, row\.id\)/, 'a row opens its challenge, as the standard card does');
  const none = render({}, homeStubs({ challenges: { ...CHALLENGES, mode: 'none', heading: 'Challenges', seeAll: false, rows: [], note: { title: 'No challenges right now', text: 'New ones will show up here.' } } }));
  assert.match(none, /<h2 class="fr-cap">Challenges<\/h2><\/div><div class="fr-card fr-text"><div class="fr-sub15"><b>No challenges right now<\/b><\/div><span class="fr-mut">New ones will show up here\.<\/span><\/div>/, 'nothing open: the standard note, as one card');
  assert.doesNotMatch(render(), /home-frame-challenges/, 'nothing until the panel is known');
});

test('every tile and row is a door, not a page load', () => {
  assert.match(SRC, /NavLink\?\.isNativeClick\?\.\(event\)/, 'cmd-click and middle-click keep the href');
  assert.match(SRC, /AppView\?\._landOnHub\?\.\(slug\)/, 'a community lands on its hub');
  assert.match(SRC, /App\?\.navigateToApp\?\.\(slug, 'dev'\)/);
  assert.match(SRC, /win\(\)\?\.App\?\.navigateToApp\?\.\(slug\);/, 'an app tile launches the app');
});
