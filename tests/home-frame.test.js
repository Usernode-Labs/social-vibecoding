// Home in the one frame, drawn with the kit as the 2026-11-06 screen tour
// draws it (docs/superpowers/plans/2026-11-09-every-screen-in-the-kit.md,
// M1). The standard Home is untouched: HomeScreen mounts <HomeFrame/> as
// the scroller's first child only after mount, when the device's look is
// one of the frame's nine (lib/skin.ts) and the viewer is signed in, and
// app.css hides the standard body beside it while data-frame-page is set.
//
// Run with: node --test tests/home-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');
const { shapeNeedsFeed } = require('../src/routes/workshop-overview');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const HOME_FRAME = 'frontend/src/features/home/frame/home-frame.tsx';
const NOW = Date.parse('2026-11-09T12:00:00Z');

// A store the way lib/plain-store.js shapes one, holding `state` for good.
const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });

// The modules HomeFrame reads, stubbed by the specifier it imports them as.
function homeStubs({ pins = [], joined = [], owed = {}, apps = [], info = {}, standing = null } = {}) {
  return {
    '../grid-store': { gridStore: fixedStore({ ready: true, view: 'grid', editing: false, items: apps.map((app) => ({ kind: 'card', placement: null, app })) }) },
    '../home-pins-store': {
      homePinsStore: fixedStore({ ready: true, pins, joined, owed }),
      loadHomePins: async () => {},
    },
    '../communities-to-join': { readDirectory: async () => [] },
    // What the two pages under Home read besides.
    '../../frame/frame-page-store': { useFramePage() {} },
    '../../leaderboard/my-standing.js': { myStandingStore: fixedStore(standing ? { status: 'ready', ranking: { rank: standing.rank, total_participants: standing.people, total_points: standing.points } } : { status: 'idle' }), MyStanding: { load: async () => {} }, standingView: (st) => (st.status === 'ready' ? { rank: st.ranking.rank, people: st.ranking.total_participants, pending: null, token: null } : null) },
    '../../workshop/community-scope': { communityScopeStore: fixedStore({ slug: null, list: [], info }) },
  };
}
const render = (props, stubs = homeStubs()) => renderComponent(HOME_FRAME, 'HomeFrame', { now: NOW, ...props }, { stubs, cache: false });
const pin = (slug, name) => ({ slug, name, iconUrl: null, iconEmoji: null, iconColor: null, member: true });
const app = (slug, name) => ({ slug, name, status: '', icon: { kind: 'letter', letter: name[0] }, locked: false, demo: false });

// Rows shaped by the server's own shapeNeedsFeed, so the contract the
// screen reads (approve, waitingOn, app.slug/name) cannot drift from it.
const feed = (n) => shapeNeedsFeed(Array.from({ length: n }, (_, i) => (
  { kind: 'proposal', id: 100 + i, title: `Change ${i + 1}`, number: 6400 + i, slug: i % 2 ? 'pourover' : 'homeroom', name: i % 2 ? 'Pourover Coffee' : 'Homeroom', waiting_on: null }
)));

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

test('the page is the kit\'s: a frame root, the head, one primary action, then the columns', () => {
  const html = render({ initialFeed: feed(1), initialQuestions: [] });
  assert.match(html, /^<div class="fr" data-home-frame=""><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Home<\/h1><p class="fr-purpose">/);
  assert.match(html, /<div class="fr-acts"><button type="button" class="fr-btn"><svg class="fr-ic"[^>]*>.*?<\/svg>Make a project<\/button><\/div>/s);
  assert.equal((html.match(/class="fr-btn"/g) || []).length, 1, 'one primary action on the page');
  assert.match(html, /<div class="fr-cols fr-one"><div class="fr-stack">/, 'no side column when nothing went live');
  // Kit classes only: a utility class beside a look's rule would break one of the nine.
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  assert.ok(classes.length > 10);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('the sentence under the title says what needs you, and where', () => {
  assert.match(render({ initialFeed: feed(3), initialQuestions: [] }), /<p class="fr-purpose">3 things need you today, across 2 communities\.<\/p>/);
  assert.match(render({ initialFeed: feed(1), initialQuestions: [] }), /<p class="fr-purpose">1 thing needs you today, in Homeroom\.<\/p>/);
  assert.match(render({ initialFeed: [], initialQuestions: [] }), /<p class="fr-purpose">Nothing needs you right now\.<\/p>/);
});

test('Needs you shows three rows, each ending in the one word that says what to do, and a link to the rest', () => {
  const html = render({
    initialFeed: [...feed(5), ...shapeNeedsFeed([{ kind: 'proposal', id: 9, title: 'Waits on checks', number: 7, slug: 'homeroom', name: 'Homeroom', waiting_on: ['checks'] }])],
    initialQuestions: [{ messageId: 1, appSlug: 'gamecorner', appName: 'Game Corner', issueNumber: 402, question: 'Which part of the screen should zoom in?' }],
  });
  const group = html.slice(html.indexOf('id="home-frame-needs"'), html.indexOf('</section>', html.indexOf('id="home-frame-needs"')));
  assert.match(group, /<h2 class="fr-cap">Needs you<\/h2><a class="fr-link" href="#needs">All 7<\/a>/, 'the label, then one link to all of them');
  assert.equal((group.match(/class="fr-row"/g) || []).length, 3, 'three rows');
  assert.ok(group.indexOf('Which part of the screen should zoom in?') < group.indexOf('Change 1'), 'what the bot asked comes first: an answer unblocks a build');
  assert.match(group, /Game Corner · Homeroom bot asked on request #402/);
  assert.match(group, /<span class="fr-pill fr-act" data-kind="act">Reply<\/span>/);
  assert.equal((group.match(/<span class="fr-pill fr-act" data-kind="act">Vote<\/span>/g) || []).length, 2);
  assert.match(group, /Homeroom · 0 yes votes so far/);
  assert.match(group, /<svg class="fr-ic fr-go"/, 'a row that opens something ends in the chevron');
});

test('a change still waiting on its checks says so in amber, and one whose Yes is the viewer\'s alone says Approve', () => {
  const src = read('src', 'routes', 'workshop-overview.js');
  assert.match(src, /approvedAlone\(row\) \? \{ approve: true \}/, 'the server\'s own flag');
  const html = render({
    initialQuestions: [],
    initialFeed: [
      ...shapeNeedsFeed([{ kind: 'proposal', id: 8, title: 'A header colour', number: 6413, slug: 'pourover', name: 'Pourover Coffee', waiting_on: ['checks'] }]),
      { kind: 'proposal', id: 1, title: 'Mine', number: 3, approve: true, app: { slug: 'solo', name: 'Solo', icon_url: null, icon_emoji: null } },
    ],
  });
  assert.match(html, /<span class="fr-pill fr-wait" data-kind="wait">Checks<\/span>/);
  assert.match(html, /<span class="fr-pill fr-act" data-kind="act">Approve<\/span>/);
});

test('Pinned apps are tiles, the only tiles on the page, with a tile for the rest past eleven', () => {
  const few = render({ initialFeed: [], initialQuestions: [] }, homeStubs({ apps: [app('game-corner', 'Game Corner'), app('viatales', 'ViaTales')] }));
  const group = few.slice(few.indexOf('id="home-frame-apps"'), few.indexOf('</section>', few.indexOf('id="home-frame-apps"')));
  assert.match(group, /<h2 class="fr-cap">Pinned apps<\/h2><button type="button" class="fr-link">Edit<\/button>/);
  assert.match(group, /<div class="fr-card"><div class="fr-tiles"><a class="fr-at" href="\/app\/game-corner">/);
  assert.match(group, /<span class="fr-tile" style="--fr-ts:52px;--fr-tc:#fff" aria-hidden="true">G<\/span><span class="fr-nm">Game Corner<\/span>/);
  assert.equal((group.match(/class="fr-at"/g) || []).length, 2);
  const many = render({ initialFeed: [], initialQuestions: [] }, homeStubs({ apps: Array.from({ length: 14 }, (_, i) => app(`a${i}`, `App ${i}`)) }));
  assert.equal((many.match(/class="fr-at"/g) || []).length, 12, 'eleven apps and one tile for all of them');
  assert.match(many, /<span class="fr-nm">All 14<\/span>/);
  assert.doesNotMatch(render({ initialFeed: [], initialQuestions: [] }), />Pinned apps</, 'no pinned apps: no empty group (a zero says nothing)');
});

test('Pinned communities are rows that say what is new there', () => {
  const html = render({ initialFeed: [], initialQuestions: [], initialCounts: { pourover: { working: 2 }, quiet: { working: 0 } } }, homeStubs({
    pins: [pin('pourover', 'Pourover Coffee'), pin('quiet', 'Quiet Place')],
    owed: { pourover: 1, quiet: 0 },
  }));
  const group = html.slice(html.indexOf('id="home-frame-communities"'), html.indexOf('</section>', html.indexOf('id="home-frame-communities"')));
  assert.match(group, /<h2 class="fr-cap">Pinned communities<\/h2>/);
  assert.match(group, /<a class="fr-row" href="\/app\/pourover\/workshop\?ws=status">/, 'a row is the door to the hub');
  assert.match(group, /<span class="fr-s">1 to vote · 2 in progress<\/span>/);
  assert.match(group, /<span class="fr-pill fr-act" data-kind="act">1 to vote<\/span>/, 'what waits for the viewer is the row\'s one pill, in blue');
  assert.match(group, /<a class="fr-row fr-sm" href="\/app\/quiet\/workshop\?ws=status">/, 'a community with nothing to say is the single-line row');
  assert.doesNotMatch(group, /0 to vote|0 in progress/, 'a zero says nothing');
  assert.equal((group.match(/data-kind="act"/g) || []).length, 1);
});

test('Communities to join are the same rows, with Join as the row\'s word', () => {
  const html = render({
    initialFeed: [], initialQuestions: [],
    initialDirectory: [{ slug: 'game-corner', name: 'Game Corner', member_count: 12 }, { slug: 'solo', name: 'Solo', member_count: 1 }],
  });
  const group = html.slice(html.indexOf('id="home-frame-to-join"'), html.indexOf('</section>', html.indexOf('id="home-frame-to-join"')));
  assert.match(group, /<a class="fr-row" href="\/app\/game-corner\/workshop\?ws=status">/);
  assert.match(group, /12 members/);
  assert.match(group, /1 member</);
  assert.equal((group.match(/<span class="fr-btn fr-sm">Join<\/span>/g) || []).length, 2);
  assert.doesNotMatch(html, /<a[^>]*>(?:(?!<\/a>).)*<button/s, 'no button inside a link');
});

test('what went live this week sits in the side column, newest first, with how long ago', () => {
  const html = render({
    initialFeed: [], initialQuestions: [],
    initialLive: [
      { id: 1, number: 6412, title: 'Penalty shoot-out mode', at: '2026-11-09T10:00:00Z', author: 'Bruno', app: { slug: 'goal', name: 'GOAL!', icon_url: null, icon_emoji: null } },
      { id: 2, number: 6410, title: 'Daily puzzle streaks', at: '2026-11-06T11:00:00Z', author: 'maragung', app: { slug: 'game-corner', name: 'Game Corner', icon_url: null, icon_emoji: '🎮' } },
    ],
  });
  assert.match(html, /<div class="fr-cols"><div class="fr-stack">/, 'two columns once there is context');
  const side = html.slice(html.indexOf('id="home-frame-live"'));
  assert.match(side, /<h2 class="fr-cap">Live this week<\/h2>/);
  assert.match(side, /Penalty shoot-out mode<\/span><span class="fr-s">GOAL! · Bruno<\/span><\/span><span class="fr-meta">2h<\/span>/);
  assert.match(side, /<span class="fr-meta">3d<\/span>/);
});

// ── The two pages under Home (the tour's s03 and s04) ───────────────────

test('All apps: tabs and a search, then the pinned tiles and everything else in order', () => {
  const html = renderComponent('frontend/src/features/home/frame/home-all-apps.tsx', 'HomeAllApps', {
    onBack() {},
    initialApps: [{ slug: 'zeta', name: 'Zeta' }, { slug: 'alpha', name: 'Alpha', icon_emoji: '🅰️' }, { slug: 'game-corner', name: 'Game Corner' }],
  }, { stubs: homeStubs({ apps: [app('game-corner', 'Game Corner')] }), cache: false });
  assert.match(html, /^<div class="fr" data-home-frame="apps"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">All apps<\/h1><p class="fr-purpose">3 apps you can open\. Pinned ones show on Home\.<\/p>/);
  assert.match(html, /<nav class="fr-tabs"><button type="button" class="fr-tab fr-on" aria-pressed="true">All<\/button><button type="button" class="fr-tab" aria-pressed="false">Pinned<\/button><\/nav>/);
  assert.match(html, /<div class="fr-search"><label class="fr-inp"><svg[^>]*>.*?<\/svg><input type="search" class="fr-v" placeholder="Search your apps" aria-label="Search your apps" value=""\/><\/label><\/div>/s);
  const pinned = html.indexOf('>Pinned to Home<');
  const rest = html.indexOf('>Everything else, A to Z<');
  assert.ok(pinned > -1 && rest > pinned, 'pinned first, then the rest');
  assert.equal((html.slice(pinned, rest).match(/class="fr-at"/g) || []).length, 1);
  assert.ok(html.indexOf('>Alpha<', rest) < html.indexOf('>Zeta<', rest), 'the rest in alphabetical order');
  assert.doesNotMatch(html.slice(rest), />Game Corner</, 'a pinned app is not listed twice');
  assert.match(html, /<a class="fr-at" href="\/app\/alpha">/, 'a tile launches its app');
});

test('All communities: tabs by audience, a search, rows grouped by what they need, context beside them', () => {
  const html = renderComponent('frontend/src/features/home/frame/home-all-communities.tsx', 'HomeAllCommunities', {
    onBack() {},
    mine: [pin('homeroom', 'Homeroom'), pin('quiet', 'Quiet Place'), pin('solo', 'Solo')],
    votes: [{ key: 'proposal:1', title: 'Email templates', community: 'Homeroom', slug: 'homeroom' }],
  }, { stubs: homeStubs({
    pins: [pin('homeroom', 'Homeroom')], owed: { homeroom: 1 },
    info: { homeroom: { audience: 'open', memberCount: 228 }, quiet: { audience: 'invited', memberCount: 6 }, solo: { audience: 'solo', memberCount: 1 } },
  }), cache: false });
  assert.match(html, /<h1 class="fr-title">All communities<\/h1><p class="fr-purpose">The 3 communities you are in\. 1 pinned to Home\.<\/p>/);
  assert.match(html, /<div class="fr-acts"><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>New community<\/button>/s, 'the page\'s one primary action');
  assert.deepEqual([...html.matchAll(/class="fr-tab[^"]*" aria-pressed="[a-z]+">([^<]+)</g)].map((m) => m[1]), ['All', 'Public', 'Private', 'Just you', 'Not pinned']);
  assert.match(html, /placeholder="Search your communities"/);
  const needs = html.indexOf('>Needs you<');
  const rest = html.indexOf('>Your communities<');
  assert.ok(needs > -1 && rest > needs);
  assert.match(html.slice(needs, rest), /<span class="fr-t">Homeroom<\/span><span class="fr-s">Public community · 228 members<\/span><\/span><span class="fr-pill fr-act" data-kind="act">1 to vote<\/span>/,
    'a community that waits for you says its audience and size, and ends in the blue pill');
  assert.match(html.slice(rest), /<span class="fr-t">Quiet Place<\/span><span class="fr-s">Private community · 6 members<\/span>/);
  assert.match(html.slice(rest), /<span class="fr-s">Just you · 1 member<\/span>/);
  assert.equal((html.match(/data-kind="act"/g) || []).length, 2, 'blue only on the community that asks and on the vote owed beside it');
  const side = html.slice(html.indexOf('>Votes waiting on you<'));
  assert.match(side, /<a class="fr-link" href="#needs">Review all<\/a>/);
  assert.match(side, /<span class="fr-t">Email templates<\/span><span class="fr-s">Homeroom<\/span><\/span><span class="fr-pill fr-act" data-kind="act">Vote<\/span>/);
  assert.match(side, /<div class="fr-note"><svg[^>]*>.*?<\/svg><div>Pins live on Home\. Pin a community to keep it one tap away\.<\/div><\/div>/s);
});

test('Home opens each page from its own group, and comes back', () => {
  const src = read('frontend', 'src', 'features', 'home', 'frame', 'home-frame.tsx');
  assert.match(src, /if \(view === 'apps'\) return <HomeAllApps onBack=\{backHome\} \/>;/);
  assert.match(src, /return <HomeAllCommunities onBack=\{backHome\} mine=\{mine\} votes=\{owedVotes\} \/>;/);
  assert.match(src, /onClick=\{\(\) => show\('apps'\)\}/, 'the All tile of Pinned apps');
  assert.match(src, /<GroupLink onClick=\{\(\) => show\('communities'\)\}>/, 'the All link of Pinned communities');
  assert.match(src, /document\.addEventListener\('home:show-all-communities', all\)/, 'the shell\'s own All communities lands on the page too');
  assert.match(src, /if \(\(event as CustomEvent\)\.detail === 'home'\) show\('home'\)/, 'and a press on Home in the chrome comes back');
  for (const f of ['home-all-apps.tsx', 'home-all-communities.tsx']) {
    assert.match(read('frontend', 'src', 'features', 'home', 'frame', f), /useFramePage\(\[tc\('core:tabs\.home'\), t\('home:frame\.all(Apps|Communities)\.title'\)\], onBack\)/, `${f} gives the bar its breadcrumb and back`);
  }
});

test('every row is a door, not a page load', () => {
  const src = read('frontend', 'src', 'features', 'home', 'frame', 'home-frame.tsx');
  assert.match(src, /NavLink\?\.isNativeClick\?\.\(event\)/, 'cmd-click and middle-click keep the href');
  assert.match(src, /AppView\?\._landOnHub\?\.\(slug\)/, 'a community row lands on the hub');
  assert.match(src, /AppView\?\._landOnTab\?\.\(slug, 'needs'\)/, 'a Needs you row lands on Needs you');
  assert.match(src, /App\?\.navigateToApp\?\.\(slug, 'dev'\)/);
});

test('the words are catalog text', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'home.json'));
  for (const k of ['frame.title', 'frame.purposeNeeds_one', 'frame.purposeNeeds_other', 'frame.purposeNeedsIn_one', 'frame.purposeNeedsIn_other', 'frame.purposeQuiet',
    'frame.make', 'frame.needs', 'frame.all', 'frame.edit', 'frame.browseAll', 'frame.pinnedApps', 'frame.pinnedCommunities', 'frame.toJoin', 'frame.join',
    'frame.vote', 'frame.reply', 'frame.approve', 'frame.waiting.checks', 'frame.waiting.conflict', 'frame.toVote_one', 'frame.toVote_other',
    'frame.voteLine_one', 'frame.voteLine_other', 'frame.askedLine', 'frame.inProgress_one', 'frame.inProgress_other',
    'frame.liveThisWeek', 'frame.ago.minutes', 'frame.ago.hours', 'frame.ago.days']) {
    assert.ok(en[k] && typeof en[k].text === 'string' && en[k].description, k);
    assert.doesNotMatch(en[k].description, /glass/i, `${k}: described for every look`);
  }
  assert.doesNotMatch(read('frontend', 'src', 'features', 'home', 'frame', 'home-frame.tsx'), />[A-Z][a-z]+ [a-z]+</, 'no English literal in the component');
});

test('your season is one row of the side column, to Challenges, once the standings know you (the tour\'s s01)', () => {
  const html = render({}, homeStubs({ standing: { rank: 15, people: 149, points: 16128 } }));
  assert.match(html, /<h2 class="fr-cap">Season<\/h2><\/div><div class="fr-card"><a class="fr-row" href="#leaderboard\/challenges"><span class="fr-lead">15<\/span><span class="fr-tx"><span class="fr-t">Rank 15 of 149<\/span><span class="fr-s">16,128 points<\/span><\/span><svg class="fr-ic fr-go"/);
  assert.doesNotMatch(render(), /Season/, 'nothing until the standing is known');
  assert.match(read(HOME_FRAME), /useEffect\(\(\) => \{ void MyStanding\.load\(\); \}, \[\]\);/, 'asked for once, as Challenges asks');
});
