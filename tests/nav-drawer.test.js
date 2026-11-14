'use strict';

// THE PHONE'S HEADER ON A COMMUNITY, MESSAGES AND HOMEROOM BOT (Evan's
// design, 18 Oct 2026; the Communities drawer removed 3 Nov 2026).
//
// Under 768px a community's page draws the platform header as its own: on
// its Hub the grid that opens All communities, on any other place the arrow
// up to the Hub, the community over its place, and the community's colour.
// Until 3 Nov 2026 the page was the deepest of three levels on one strip
// (your communities at 85%, its places at 80%, then the page); that drawer
// is gone, and the Hub's rows lead to the places. Messages and the bot tab
// keep a strip of two (the list, the whole screen, then the conversation),
// and the header moves with it. Desktop is untouched.
//
// These pin the numbers (drawer-math.ts), the store (drawer-store.ts), when
// the community header applies (nav-drawer.tsx), and the header's seams:
// the grid and the arrow, the titles, the lit tab and the CSS.
//
// Run with: node --test tests/nav-drawer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const DIR = 'frontend/src/features/nav-drawer';

const math = loadTsx(`${DIR}/drawer-math.ts`);

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≉ ${b}`);

test('3 Nov 2026: no levels beside a community\'s page; the strips that are left are two levels', () => {
  const src = read(`${DIR}/drawer-math.ts`);
  assert.doesNotMatch(src, /PLACES_SHARE|LEVEL_AT|export function landing\(/, 'the three-level strip is gone');
  assert.equal(math.OUTER_SHARE, 0.85);
  assert.equal(math.clampDepth(-1), 0);
  assert.equal(math.clampDepth(7), 2);
  assert.equal(math.clampDepth(NaN), 2, 'nonsense rests on the page');
  assert.equal(math.isPan(9, 2), true);
  assert.equal(math.isPan(7, 0), false, 'within the slop');
  assert.equal(math.isPan(12, 12), false, 'as much down as across is a scroll');
  assert.ok(!fs.existsSync(path.join(root, DIR, 'outer-level.tsx')), 'your communities are a page, not a level');
});

test('the header at a depth: colour, arrow, and the titles moving the drawer\'s way', () => {
  const slot = 44;
  const at0 = math.headerFrame(0, slot);
  assert.equal(at0.tint, 0, 'untinted on your communities');
  assert.equal(at0.back.opacity, 0, 'no arrow on the outermost level');
  assert.equal(at0.back.live, false);
  assert.equal(at0.back.x, 8, 'it waits 8px to the right');
  assert.deepEqual(at0.outer, { opacity: 1, x: -slot, y: 7 }, '"Communities" where the arrow is not');
  assert.equal(at0.inner.opacity, 0);
  assert.equal(at0.inner.x, 24, 'the name waits 24px to the right');

  const half = math.headerFrame(0.5, slot);
  assert.equal(half.tint, 0.5);
  assert.equal(half.outer.opacity, 0.5);
  assert.equal(half.outer.x, -slot - 6, 'going in, "Communities" drifts left');
  assert.equal(half.inner.x, 12, 'and the name arrives from the right');
  assert.equal(half.back.x, 4);

  const at1 = math.headerFrame(1, slot);
  assert.equal(at1.tint, 1);
  assert.equal(at1.back.opacity, 1);
  assert.equal(at1.back.live, true);
  assert.equal(at1.outer.opacity, 0);
  assert.deepEqual(at1.inner, { opacity: 1, x: 0, y: 7, subOpacity: 0, subX: 24, subY: -7 }, 'the name alone, centred');

  const mid = math.headerFrame(1.5, slot);
  assert.equal(mid.inner.x, 0, 'the name stays put');
  assert.equal(mid.inner.y, 3.5, 'rising to make room');
  assert.equal(mid.inner.subX, 12, 'the page slides in from the right');
  assert.equal(mid.inner.y + mid.inner.subY, 0, 'and cancels the rise, so it travels level');

  const at2 = math.headerFrame(2, slot);
  assert.deepEqual(at2.inner, { opacity: 1, x: 0, y: 0, subOpacity: math.SUB_OPACITY, subX: 0, subY: 0 });

  const calm = math.headerFrame(0.5, slot, true);
  assert.equal(calm.outer.x, -slot, 'Reduce Motion: crossfades in place');
  assert.equal(calm.inner.x, 0);
  assert.equal(calm.back.x, 0);
  assert.equal(calm.outer.opacity, 0.5, 'the fades stay');
});

test('another community keeps the place you were on when it has it, else its Hub', () => {
  const { keepPlace } = math;
  for (const p of ['status', 'needs', 'workshop', 'discussion']) assert.equal(keepPlace(p, null), p, `${p} is everywhere`);
  assert.equal(keepPlace('all', null), 'workshop', 'All items is under the Workshop');
  assert.equal(keepPlace('bot', null), 'workshop');
  assert.equal(keepPlace('plan', null), 'status', 'the plan is under the Hub');
  assert.equal(keepPlace('c:onboarding', ['onboarding', 'infra']), 'c:onboarding');
  assert.equal(keepPlace('c:onboarding', ['infra']), 'status', 'a topic it does not have');
  assert.equal(keepPlace('c:onboarding', null), 'status', 'or not known to have');
  assert.equal(keepPlace(undefined, null), 'status');
});

test('the store: whether the community header applies, and the community and place it names', () => {
  const store = loadTsx(`${DIR}/drawer-store.ts`);
  assert.deepEqual(store.drawerStore.get(), { on: false, shown: { slug: null, name: '', selfHosted: false, place: 'status' } });
  store.setOn(true);
  assert.equal(store.drawerStore.get().on, true);
  store.setShown({ slug: 'notes', name: 'Notes', selfHosted: false, place: 'workshop' });
  assert.equal(store.drawerStore.get().shown.place, 'workshop');
  assert.equal(store.communitiesDepth.live(), 2, 'the header rests on the page\'s frame');
  for (const gone of ['go', 'back', 'pressTab', 'requestOuter', 'holdBack', 'letGoBack', 'setBackRecords', 'registerSurface', 'setSearching', 'setPending']) {
    assert.equal(typeof store[gone], 'undefined', `${gone} went with the drawer`);
  }
  store.setOn(false);
  assert.equal(store.drawerStore.get().on, false);
});

test('it applies on a phone, on a community\'s own page and an item\'s page opened from it', () => {
  const { drawerApplies, NavDrawer } = loadTsx(`${DIR}/nav-drawer.tsx`);
  const page = { phone: true, screen: 'app-view', slug: 'notes', tab: 'dev', subTab: 'forum', viewMode: 'workshop' };
  assert.equal(drawerApplies(page), true);
  assert.equal(drawerApplies({ ...page, phone: false }), false, 'never at 768px and up');
  assert.equal(drawerApplies({ ...page, screen: 'messages-screen' }), false, 'another tab');
  assert.equal(drawerApplies({ ...page, tab: 'app' }), false, 'the running app');
  // Polish #23: an item opened from the community's pages keeps the
  // community's header; one opened from a conversation does not.
  assert.equal(drawerApplies({ ...page, subTab: 'topic' }), true, 'a card opened from the page (a deep link too)');
  assert.equal(drawerApplies({ ...page, subTab: 'topic', topicOrigin: '#app/notes/workshop' }), true);
  assert.equal(drawerApplies({ ...page, subTab: 'topic', topicOrigin: '#messages/12' }), false, 'a card opened from Messages');
  assert.equal(drawerApplies({ ...page, subTab: 'topic', topicOrigin: '#homeroom-bot' }), false,
    'a thread opened from the Homeroom bot tab\'s page, which goes back there');
  assert.equal(drawerApplies({ ...page, subTab: 'topic', viewMode: 'kanban' }), false, 'a card under the Kanban board');
  assert.equal(drawerApplies({ ...page, subTab: 'sessions' }), false, 'a change\'s own session');
  assert.equal(drawerApplies({ ...page, viewMode: 'kanban' }), false, 'the Kanban board');
  assert.equal(drawerApplies({ ...page, slug: null }), false, 'no community, no header of one');
  assert.equal(renderToHtml(createElement(NavDrawer)), '', 'nothing in the prerender, and nothing drawn after it');
});

test('nothing pans the page or moves it: places are the Hub\'s rows, All communities a page', () => {
  const island = read(`${DIR}/nav-drawer.tsx`);
  assert.doesNotMatch(island, /addEventListener\('touch|createPortal|style\.transform/, 'no strip, no pan, no transform on #app-view');
  assert.doesNotMatch(island, /pushDismissible/, 'no Back record: there is no level off the page to hold one for');
  // A gesture surface, not a page slide (tests/phone-no-page-slides.test.js).
  for (const file of ['nav-drawer.tsx', 'drawer-store.ts', 'header-drawer.tsx']) {
    assert.doesNotMatch(read(`${DIR}/${file}`), /PlatformUI\.transition\(/, file);
  }
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /\.nav-drawer \{|\.nav-drawer-strip|\.nav-drawer-outer|\.nav-drawer-places|\.nav-drawer-cover/, 'the strip\'s CSS went with it');
  const block = css.slice(css.indexOf('/* ── THE PHONE\'S COMMUNITY HEADER'));
  assert.match(block, /@media \(max-width: 767\.98px\) \{\s*html\[data-nav-drawer\] body \{/, 'the header\'s rules are the phone\'s');
  assert.match(block, /color-mix\(in srgb, #fff calc\(var\(--nav-k, 1\) \* 100%\), var\(--nav-brand-ink\)\)/, 'the ink follows the depth');
  assert.match(css, /\.platform-header-left:has\(> #back-btn\.hidden\):not\(:has\(> \.header-places-btn\)\):not\(:has\(> \.nav-drawer-back\)\) \{\s*display: none;/,
    'the left group stays for the grid and the arrow');
  const shell = read('frontend/src/Shell.tsx');
  assert.match(shell, /<Island name="NavDrawer"><NavDrawer \/><\/Island>/);
});

test('the header takes the grid or the arrow, and the titles, only while it applies', () => {
  const header = read('frontend/src/features/header/platform-header.tsx');
  assert.match(header, /<HeaderPlace slug=\{backSlug\} name=\{appName \|\| ''\} \/>[\s\S]*?<DrawerBack \/>\s*<\/div>/,
    'the arrow in the places button\'s seat');
  assert.match(header, /-mb-2'\}\s*>\s*\{\/\*[\s\S]*?\*\/\}\s*<DrawerUntint \/>/, 'the untinted bar, first in the header');
  const title = read('frontend/src/features/header/header-title.tsx');
  assert.match(title, /const drawerOn = useDrawerMode\(\) !== null;/, 'a community\'s, Messages\' or the bot tab\'s');
  assert.match(title, /\{drawerOn \? <DrawerTitles \/> : \(/);
  const bar = read('frontend/src/features/dev-board/workshop/place-bar.tsx');
  assert.match(bar, /if \(drawerOn\) return null;\s*if \(!phone \|\| !slug \|\| mounted !== slug \|\| screen !== 'app-view'\) return null;/,
    'no places button: the Hub\'s rows are the way to the places');
  const drawer = read(`${DIR}/header-drawer.tsx`);
  assert.match(drawer, /<button\s+ref=\{ref\}\s+type="button"/, 'a button: an href\'d arrow would turn on WebKit\'s history swipe');
  assert.doesNotMatch(drawer, /href=/);
  // Off, none of it renders: the prerendered header is untouched.
  const ui = loadTsx(`${DIR}/header-drawer.tsx`);
  assert.equal(renderToHtml(createElement(ui.DrawerBack)), '');
  assert.equal(renderToHtml(createElement(ui.DrawerUntint)), '');
  assert.equal(ui.pageLabel('c:onboarding'), '#onboarding');
  assert.equal(ui.pageLabel('discussion'), '#general');
  assert.equal(ui.pageLabel('workshop'), 'Workshop');
  assert.equal(ui.pageLabel('status'), 'Hub');
});

// Evan, 3 Nov 2026: "when you're on a community, the top left gets like one
// of those icons which represents lots of different apps. And then when you
// click that, you go back to seeing all the communities in a grid."
test('on the Hub the arrow goes back to Home (One Home, #6361); on a place it goes up to the Hub', () => {
  const calls = [];
  const ui = loadTsx(`${DIR}/header-drawer.tsx`, {
    stubs: {
      '../dev-board/workshop/place-store': { openPlace: (slug, key) => { calls.push(['place', slug, key]); return false; } },
    },
  });
  ui.upFromPlace('notes', 'workshop');
  ui.upFromPlace('notes', 'c:onboarding');
  ui.upFromPlace('notes', 'needs');
  assert.deepEqual(calls, [['place', 'notes', 'status'], ['place', 'notes', 'status'], ['place', 'notes', 'status']], 'a place goes up to the Hub');
  calls.length = 0;
  ui.upFromPlace('notes', 'all');
  ui.upFromPlace('notes', 'plan');
  assert.deepEqual(calls, [['place', 'notes', 'workshop'], ['place', 'notes', 'status']], 'a page under a place goes up to it');
  const saved = globalThis.window;
  const went = [];
  globalThis.window = { App: { navigateHome: () => went.push('home') }, location: { hash: '' } };
  try { ui.toHome(); } finally { globalThis.window = saved; }
  assert.deepEqual(went, ['home'], 'the Hub\'s back is Home, where your communities are');
  const drawer = read(`${DIR}/header-drawer.tsx`);
  assert.match(drawer, /if \(shown\.place === 'status'\) \{\s*return <BackDisc mode=\{mode\} label=\{t\('core:header\.drawer\.toHome'\)\} onBack=\{toHome\} \/>;/);
  assert.doesNotMatch(drawer, /Squares2X2Icon|toAllCommunities|data-nav-drawer-grid/, 'no grid of every community any more');
  assert.match(drawer, /t\('core:header\.drawer\.toHub', \{ community: shown\.name \}\)/);
  // The Hub names the community alone, as a name alone is drawn (depth 1).
  assert.match(drawer, /const hub = mode === 'communities' && shown\.place === 'status';/);
  assert.match(drawer, /const words = hubRef\.current \? headerFrame\(1, slot\.current, reducedMotion\(\)\)\.inner : frame\.inner;/);
  const hubWords = math.headerFrame(1, 44).inner;
  assert.equal(hubWords.subOpacity, 0, 'no line under it');
  assert.equal(math.headerFrame(2, 44).back.live, true, 'and the arrow is pressable where it rests');
});

test('the lit tab climbs the same ladder on a phone: a place to its Hub, the Hub to All communities', () => {
  const ladder = read('frontend/src/features/workshop/tab-ladder.ts');
  assert.doesNotMatch(ladder, /drawerStore|pressDrawerTab/, 'no drawer of its own to step through');
  const scope = read('frontend/src/features/workshop/community-scope.ts');
  assert.doesNotMatch(scope, /nav-drawer\/drawer-store/);
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /useEdgeSwipe\(!placesInColumn && !drawerOn && !trayOpen && !!v\.slug && !v\.loading,/, 'no tray on a phone either');
});

test('its words are catalog entries', () => {
  const core = JSON.parse(read('frontend/locales/en/core.json'));
  for (const key of ['header.drawer.toHome', 'header.drawer.toHub', 'header.drawer.toPlace',
    'header.drawer.messages', 'header.drawer.toMessages']) {
    assert.ok(core[key] && core[key].description, key);
  }
  assert.equal(core['header.drawer.toHub'].text, "Back to {{community}}'s Hub");
  assert.equal(core['header.drawer.toHome'].text, 'Back to Home');
  assert.equal(core['header.drawer.allCommunities'], undefined, 'the Hub\'s grid went with One Home (#6361)');
});

// ── Messages on the same drawer ────────────────────────────────────────

test('Messages\' strip: the list, then the conversation; a quarter of the way lands', () => {
  const { MESSAGES_AT, depthIn, landingIn } = math;
  assert.deepEqual([...MESSAGES_AT], [0, 0.85]);
  near(depthIn(MESSAGES_AT, 0.425), 0.5, 'halfway');
  near(depthIn(MESSAGES_AT, 0.85), 1, 'the conversation');
  assert.equal(landingIn(MESSAGES_AT, 0, 0.2, -1), 0, 'short of a quarter of 0.85');
  assert.equal(landingIn(MESSAGES_AT, 0, 0.22, -1), 1);
  assert.equal(landingIn(MESSAGES_AT, 1, 0.63, 1), 0, 'a quarter of 0.85 back toward the list');
  assert.equal(landingIn(MESSAGES_AT, 1, 0.65, 1), 1);
});


test('Messages\' header: no colour, and the conversation arrives with its line under it', () => {
  const at0 = math.headerFrame(0, 44, false, true);
  assert.equal(at0.tint, 0);
  assert.deepEqual(at0.outer, { opacity: 1, x: -44, y: 7 }, '"Messages", where the arrow is not');
  assert.equal(at0.back.opacity, 0);
  const half = math.headerFrame(0.5, 44, false, true);
  assert.equal(half.tint, 0, 'never a community\'s colour');
  assert.equal(half.outer.x, -44 - 6, 'going in, "Messages" drifts left');
  assert.equal(half.inner.x, 12, 'and the conversation arrives from the right');
  assert.equal(half.inner.subOpacity, math.SUB_OPACITY, 'with who it is with already under its name');
  assert.equal(half.inner.y, 0);
  const at1 = math.headerFrame(1, 44, false, true);
  assert.deepEqual(at1.inner, { opacity: 1, x: 0, y: 0, subOpacity: math.SUB_OPACITY, subX: 0, subY: 0 });
  assert.equal(at1.back.live, true);
  assert.equal(math.headerFrame(2, 44, false, true).inner.opacity, 1, 'a depth past 1 is the conversation');
});

test('Messages\' drawer holds the list, conversations and agent sessions, on a phone only', () => {
  const { messagesDrawerApplies } = loadTsx(`${DIR}/messages-drawer.ts`);
  const list = { phone: true, open: true, conversationId: null, appSlug: null, agent: null, threadRootId: null };
  assert.equal(messagesDrawerApplies(list), true);
  assert.equal(messagesDrawerApplies({ ...list, conversationId: 8, activeKind: 'group' }), true);
  assert.equal(messagesDrawerApplies({ ...list, conversationId: 8, activeKind: null }), true, 'before the conversation has loaded');
  assert.equal(messagesDrawerApplies({ ...list, phone: false }), false, 'never at 768px and up');
  assert.equal(messagesDrawerApplies({ ...list, open: false }), false, 'another screen');
  assert.equal(messagesDrawerApplies({ ...list, conversationId: 1, activeKind: 'channel' }), false, 'a channel is its community\'s');
  assert.equal(messagesDrawerApplies({ ...list, appSlug: 'notes' }), false);
  // Evan, 18 Oct 2026: an agent session is the drawer's second level on a
  // phone too, so a swipe goes back to the list; a dev session still opens
  // on its project's page.
  assert.equal(messagesDrawerApplies({ ...list, agent: { kind: 'agent', id: 3 } }), true, 'an agent session');
  assert.equal(messagesDrawerApplies({ ...list, agent: { kind: 'agent', id: 'new' } }), true, 'one not sent yet');
  assert.equal(messagesDrawerApplies({ ...list, agent: { kind: 'chat', id: 'c-1' } }), false, 'a removed Global Chat thread is no thread');
  assert.equal(messagesDrawerApplies({ ...list, agent: { kind: 'session', slug: 'notes', id: 4 } }), false, 'a dev session opens on its project\'s page');
  assert.equal(messagesDrawerApplies({ ...list, conversationId: 8, threadRootId: 40 }), false, 'a reply thread is a level over its conversation');
  assert.equal(messagesDrawerApplies({ ...list, embedded: true }), false);
});

test('the Messages screen: the panes are the levels, the list is alone, the arrow is the drawer\'s', () => {
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /const agentWords = useAgentThreadWords\(snap\.route\.agent\);\s*const drawer = useMessagesDrawer\(layoutRef, snap\.route, snap\.active, threadWords, agentWords\);/);
  // 3 Nov 2026: no peek. The list is alone on its level, the whole screen.
  assert.match(index, /const drawerClass = drawer\.on \? ` messages-drawer\$\{drawer\.level === 0 \? ' messages-drawer-alone' : ''\}` : '';/);
  assert.match(index, /<ConversationList drawer=\{drawer\.on\} \/>\s*<ConversationThread \/>/);
  assert.doesNotMatch(index, /ConversationPeek|messages-peek-body/);
  assert.match(index, /className=\{`messages-list-pane \$\{specBeside \? 'hidden' : drawer \? 'flex' : /, 'the list stays drawn under a conversation');
  assert.match(index, /\{inDrawer \? null : channel/, 'no avatar in the sheet\'s title row');
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /if \(\(state\.route\.conversationId \|\| state\.route\.agent\) && messagesDrawerApplies\(\{[\s\S]*?\}\)\) \{\s*app\.setBackIcon\?\.\('none'\);/,
    'no href\'d arrow, so WebKit\'s history swipe stays off');
  const drawer = read('frontend/src/features/messages/phone-drawer.tsx');
  // Polish #16: the panes start sliding in the release's own task, and the
  // address changes once the slide is running, in a task of its own; the
  // route's placement then finds them on their way.
  const land = drawer.slice(drawer.indexOf('const landAt = '), drawer.indexOf('// ── A finger ──'));
  assert.match(land, /put\(MESSAGES_AT\[to\], true\);\s*messagesDepth\.slide\(to\);\s*if \(to === from\) return;\s*landing\.current = to;/,
    'the slide first, whichever way the pan lands');
  assert.match(land, /afterSlideStarts\(\(\) => \{ window\.setTimeout\(\(\) => openConversation\(null\), 0\); \}\);/,
    'a pan back lands by opening the list\'s address, after the slide is running');
  assert.match(drawer, /if \(!first && landing\.current === level\) \{\s*\/\/[^\n]*\n\s*landing\.current = null;\s*put\(MESSAGES_AT\[level\], true\);\s*placed\.current = level;\s*return;\s*\}/,
    'the route confirms the slide rather than starting it again');
  assert.match(drawer, /run\(pane, el, running\.start, end, running\.t0, elapsed\)/, 'a pane the route swaps in joins the slide');
  assert.match(drawer, /el\.animate\(\[\{ transform: start \}, \{ transform: end \}\], \{ duration: SLIDE_MS, easing: SLIDE_EASE \}\)/);
  assert.doesNotMatch(drawer, /\.style\.transition/, 'the conversation\'s pane is the kit\'s keyboard column, whose transition the kit owns');
  assert.match(drawer, /if \(!on \|\| level === 0\) return undefined;\s*const from = level;\s*const takesEdge = pageTakesEdge\(\);/,
    'the list has nothing beside it to pan to');
  const header = read(`${DIR}/header-drawer.tsx`);
  assert.match(header, /if \(mode === 'messages'\) return <BackDisc mode=\{mode\} label=\{t\('core:header\.drawer\.toMessages'\)\} onBack=\{messagesBack\} \/>;/);
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-layout\.messages-drawer\.messages-drawer-alone > \.messages-list-pane/, 'alone, the list is the whole screen');
  assert.doesNotMatch(css, /\.messages-thread-peek|\.messages-peek-open/, 'nothing peeks');
});

test('the phone\'s header names a conversation as its sheet does', () => {
  const { threadWords } = loadTsx('frontend/src/features/messages/index.tsx');
  const base = { id: 8, members: [], memberCount: 3, membershipStatus: 'member', title: 'Launch crew' };
  assert.deepEqual(threadWords({ ...base, kind: 'group', myRole: 'owner' }), { title: 'Launch crew', sub: '3 members · you own this group' });
  assert.deepEqual(threadWords({ ...base, kind: 'group', myRole: 'member', memberCount: 1 }), { title: 'Launch crew', sub: '1 member' });
  assert.equal(threadWords({ ...base, kind: 'group', membershipStatus: 'invited' }).sub, 'Invitation pending');
  const ada = { id: 3, username: 'ada' };
  assert.deepEqual(threadWords({ ...base, kind: 'direct', title: 'ada', peer: ada }), { title: 'ada', sub: 'Direct message' });
  assert.equal(threadWords({ ...base, kind: 'direct', title: 'ada', peer: ada, awaitingAcceptance: true }).sub, 'Request pending');
  const bot = { id: 2, username: 'homeroom_bot', bot: true, displayName: 'Homeroom bot' };
  assert.deepEqual(threadWords({ ...base, kind: 'direct', title: 'homeroom_bot', peer: bot, homeroomBot: true }),
    { title: 'Homeroom bot', sub: 'Builds what you ask for' });
  // The sheet builds the same words from the same ids.
  const index = read('frontend/src/features/messages/index.tsx');
  const words = index.slice(index.indexOf('export function threadWords('), index.indexOf('function ThreadHeader('));
  const header = index.slice(index.indexOf('function ThreadHeader('), index.indexOf('/** The day a message was sent'));
  for (const id of ['header.subtitle.channel', 'header.subtitle.invited', 'header.subtitle.groupOwner', 'header.subtitle.group',
    'header.subtitle.requestPending', 'header.subtitle.direct', 'header.subtitle.homeroomBot']) {
    assert.ok(words.includes(`'messages:${id}'`) && header.includes(`'messages:${id}'`), id);
  }
});

test('a request\'s page has one back, its chip: the drawer draws no arrow beside it (audit N05)', () => {
  const drawer = read(`${DIR}/header-drawer.tsx`);
  assert.match(drawer, /if \(mode !== 'communities'\) return null;[\s\S]{0,600}if \(subTab === 'topic'\) return null;/);
});
