// The frame's own chrome (frontend/src/features/frame/frame-app.tsx): the
// sidebar, bar and phone tab bar the 2026-11-06 screen tour draws around
// every page, shown in place of today's header and tab bar while the
// device's look is one of the frame's nine. It draws with the kit and reads
// the stores the shell's own navigation reads; today's chrome stays
// mounted, unseen, and a press here is handed to its control there.
//
// Run with: node --test tests/frame-app.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');
const { shellMarkup } = require('./lib/shell-markup');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const FRAME_APP = 'frontend/src/features/frame/frame-app.tsx';
const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });

const INFO = {
  homeroom: { slug: 'homeroom', name: 'Homeroom', iconUrl: '/h.png', iconEmoji: null, iconColor: null, needs: 2 },
  'game-corner': { slug: 'game-corner', name: 'Game Corner', iconUrl: null, iconEmoji: '🎮', iconColor: '#3b2d8f', needs: 0 },
  lobby: { slug: 'lobby', name: 'Lobby', iconUrl: null, iconEmoji: null, iconColor: null, needs: 9, unchosen: true },
};
function stubs({ tab = 'home', screen = 'home-screen', bot = false, messages = 2, ai = 18, slug = null, page = { crumb: null, onBack: null }, place = null, railOpen = true, botHead = { on: false, level: 0, title: '', sub: '' } } = {}) {
  return {
    '../dev-board/workshop/place-store': { placeStore: fixedStore({ slug: place ? slug : null, place: place || 'status', owed: 0, unread: 0, tray: false }), openPlace() {} },
    '../dev-board/workshop/places': { placeName: (key) => ({ status: 'Hub', needs: 'Needs you', workshop: 'Workshop', discussion: '#general' }[key] || key) },
    './frame-page-store': { framePageStore: fixedStore(page) },
    '../nav/nav-store.js': { navStore: fixedStore({ tab, screen, bot, messages, ai, railOpen, viewer: 'snait' }) },
    '../nav-drawer/bot-drawer': { botDrawerStore: fixedStore(botHead) },
    '../nav/rail-communities': { useRailCommunities: () => ['homeroom', 'game-corner', 'lobby'] },
    '../workshop/community-scope': { communityScopeStore: fixedStore({ slug, info: INFO, list: Object.keys(INFO) }), goToCommunity() {} },
    '../../lib/visibility-store': { useVisibility: (id, initial) => initial },
    '../../lib/platform-viewer': { whenPlatformViewer: () => () => {} },
  };
}
const chrome = (state) => renderComponent(FRAME_APP, 'FrameChrome', {}, { stubs: stubs(state), cache: false });

test('nothing is drawn on the first render, so the prerendered document does not know the chrome exists', () => {
  assert.equal(renderComponent(FRAME_APP, 'FrameApp', {}, { stubs: stubs(), cache: false }), '');
  const src = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  assert.match(src, /const on = isFrameSkin\(skin\) && viewer && routed;/, 'a frame look, a signed-in viewer, and a route that has navigation');
  assert.match(read('frontend', 'src', 'Shell.tsx'), /<Island name="FrameApp"><FrameApp \/><\/Island>/);
  assert.doesNotMatch(shellMarkup(), /data-frame-app|fr-shell/);
});

test('the sidebar is the kit\'s: the brand, three places, your recent communities, all of them, then you', () => {
  const html = chrome();
  const side = html.slice(html.indexOf('<aside class="fr-side" aria-label'), html.indexOf('</aside>', html.indexOf('<aside class="fr-side" aria-label')));
  assert.match(side, /<div class="fr-brand"><span class="fr-tile"[^>]*>.*?<\/span><span class="fr-bn">Homeroom<\/span><\/div>/s);
  const order = ['>Home<', '>Homeroom bot<', '>Messages<', '>Recents<', '>Game Corner<', '>All communities<', '>You<'].map((w) => side.indexOf(w));
  assert.ok(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1])), `in the tour's order: ${order}`);
  assert.match(side, /<a class="fr-nv fr-main fr-on" href="#home" aria-current="page">/, 'where you are is lit');
  assert.equal((side.match(/fr-on/g) || []).length, 1, 'and nothing else is');
  assert.match(side, /Homeroom bot<\/span><span class="fr-n">18<\/span>/, 'a count that asks for you');
  assert.match(side, /Messages<\/span><span class="fr-n">2<\/span>/);
  assert.match(side, /<a class="fr-nv fr-rec" href="#app\/homeroom\/workshop">.*?<span class="fr-nm">Homeroom<\/span><span class="fr-n">2<\/span>/s);
  assert.doesNotMatch(side, />Game Corner<\/span><span class="fr-n">/, 'a zero says nothing');
  assert.doesNotMatch(side, />Lobby<\/span><span class="fr-n">/, 'nor the votes of a community you have not taken part in');
  assert.match(side, /<div class="fr-sidefoot"><a class="fr-nv fr-me" href="#profile">/);
  assert.match(side, /<span class="fr-nm">You<\/span><span data-frame-settings="" role="link" tabindex="0" aria-label="Settings" title="Settings" style="display:contents">/, 'the glyph at the row\'s end opens Settings, as the standard rail\'s cog does');
  assert.doesNotMatch(side, /data-frame-menu/, 'the kit\'s account menu is gone: today has none');
});

test('inside a community its row is lit, and no tab is', () => {
  const html = chrome({ tab: null, screen: 'app-view', slug: 'game-corner' });
  assert.match(html, /<a class="fr-nv fr-rec fr-on" href="#app\/game-corner\/workshop" aria-current="page">/);
  assert.doesNotMatch(html, /fr-main fr-on/);
});

test('the bot\'s chat lights Homeroom bot, though it is drawn on the Messages screen', () => {
  const html = chrome({ tab: 'messages', bot: true });
  assert.match(html, /<a class="fr-nv fr-main fr-on" href="#homeroom-bot" aria-current="page">/);
  assert.doesNotMatch(html, /fr-main fr-on" href="#messages"/);
});

test('the bar says where you are, with search and the bell; the phone\'s tab bar has the four places', () => {
  const html = chrome({ tab: 'messages' });
  assert.match(html, /<header class="fr-bar">.*?<div class="fr-crumb"><span class="fr-ci fr-here fr-keep"><span class="fr-cw"><span class="fr-cn">Messages<\/span><\/span><\/span><\/div><span class="fr-sp"><\/span>/s);
  assert.match(html, /<button type="button" class="fr-ib fr-d" aria-label="[^"]+">/, 'search, on a desktop');
  assert.match(html, /<button type="button" class="fr-ib" aria-label="Notifications" aria-haspopup="dialog" data-frame-bell="">/);
  // The Homeroom mark and the menu behind it (the standard header's
  // #platform-mark-btn: the app switcher, About, Invite), kept under every
  // look at the bar's end, after the bell: the same tile and chevron, the
  // same controller, on a desktop and on a phone alike.
  assert.match(html, /<button type="button" class="fr-ib" aria-label="Notifications"[^>]*>.*?<\/button><button type="button" class="fr-ib fr-markbtn" aria-label="Homeroom menu" aria-expanded="false" data-frame-mark=""><span class="fr-tile" style="--fr-ts:26px;--fr-tc:#0f1116" aria-hidden="true"><img src="\/brand\/homeroom-mark\.png"[^>]*><\/span><svg class="fr-ic"[^>]*>.*?<\/svg><\/button>/s, 'the bell, then the mark, as the standard header orders them');
  assert.doesNotMatch(html, /<span class="fr-p"><span class="fr-tile"/, 'the phone bar no longer leads with a second mark: the one at its end is the brand');
  assert.match(html, /<\/button><a class="fr-p" href="#profile" aria-label="You"><span class="fr-av"/, 'a phone\'s avatar, after the mark, is the way to You');
  const frameSrc = read(FRAME_APP);
  assert.match(frameSrc, /onClick=\{\(\) => \{ \(window as any\)\.AppContext\?\.toggle\?\.\(\); \}\}/, 'the standard header\'s own controller');
  // The menu's desktop popover hangs under whichever mark has a box: the
  // frame's while the standard header is folded away.
  const ctx = read('frontend/src/features/app-context/index.tsx');
  assert.match(ctx, /function visibleMark\(\): HTMLElement \| null \{/);
  assert.match(ctx, /document\.querySelector\('\[data-frame-mark\]'\)/);
  assert.match(ctx, /const mark = visibleMark\(\);\s*if \(!mark\) return;/, 'anchored under it');
  assert.match(ctx, /frameMark\?\.contains\(t\)/, 'a click on it is not a click outside');
  const bar = html.slice(html.indexOf('<nav class="fr-tabbar"'));
  assert.deepEqual([...bar.matchAll(/<a class="fr-tb[^"]*" href="([^"]+)"/g)].map((m) => m[1]), ['#home', '#homeroom-bot', '#messages', '#profile']);
  assert.match(bar, /<a class="fr-tb fr-on" href="#messages" aria-current="page">/);
  assert.match(bar, />Bot<span class="fr-n">18<\/span>/, 'the bar has room for one short word');
});

test('a long place name is cut before the bar\'s buttons, and a phone\'s bar says Main Chat\'s line under its title', () => {
  const css = read('public', 'css', 'app.css');
  // The crumb's words are a box of their own that may shrink: without it a
  // request's, a project's or a Settings section's name ran under the look
  // picker and the bell on a phone, in every look.
  assert.ok(css.includes('html[data-skin] .fr-crumb .fr-cn,html[data-skin] .fr-crumb .fr-cs{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3}'));
  // The standard phone header says "Only you can see this chat" under
  // "Main Chat" (nav-drawer/bot-drawer.ts); the kit's bar reads the same
  // store, on a phone only (from 768px the chat's own head says it).
  const main = chrome({ tab: 'messages', bot: true, botHead: { on: true, level: 1, title: 'Main Chat', sub: 'Only you can see this chat' } });
  assert.match(main, /<span class="fr-cw"><span class="fr-cn">[^<]*<\/span><span class="fr-cs fr-p" data-frame-crumb-line="">Only you can see this chat<\/span><\/span>/);
  assert.doesNotMatch(chrome({ tab: 'messages', bot: true, botHead: { on: true, level: 0, title: '', sub: 'Only you can see this chat' } }), /data-frame-crumb-line/, 'not on the list');
  assert.doesNotMatch(chrome({ tab: 'messages' }), /data-frame-crumb-line/);
});

test('the bar hides and shows the sidebar with the standard header\'s own toggle', () => {
  const src = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  const open = chrome();
  assert.match(open, /<header class="fr-bar"><button type="button" class="fr-ib fr-d" data-frame-sidebar="" aria-pressed="true" aria-label="Hide sidebar" title="Hide sidebar">/, 'first in the bar, on a desktop only');
  assert.match(open, /<div class="fr fr-app fr-shell" data-frame-app="">/);
  const folded = chrome({ railOpen: false });
  assert.match(folded, /data-frame-sidebar="" aria-pressed="false" aria-label="Show sidebar"/);
  // Folded, both layers are the kit's frame with no sidebar, so the page
  // area the chrome publishes starts at the window's edge.
  assert.match(folded, /^<div class="fr fr-app fr-shell fr-shell-under fr-noside" aria-hidden="true">/);
  assert.match(folded, /<div class="fr fr-app fr-shell fr-noside" data-frame-app="">/);
  assert.match(src, /onClick=\{\(\) => press\('sidebar-toggle'\)\}/, 'the press is the product\'s own control\'s (features/nav/sidebar-toggle.tsx)');
  assert.match(src, /const \{ railOpen \} = useStoreState\(navStore\);/, 'and the state is the one fact it writes');
});

test('the chrome starts under the offline strip, as it does under the install strip', () => {
  const css = read('public', 'css', 'app.css');
  assert.match(css, /body\.is-offline \.fr\.fr-app\.fr-shell\[data-frame-app\],\s*body\.is-offline \.fr\.fr-app\.fr-shell\.fr-shell-under \{ top: calc\(var\(--platform-safe-top, 0px\) \+ var\(--browser-banner-h, 0px\)\); \}/);
  assert.match(css, /html\[data-frame-chrome\] body\.is-offline #platform-header \{ height: calc\(var\(--fr-shell-top\) - var\(--browser-banner-h, 0px\)\) !important; \}/);
  assert.match(css, /html\[data-frame-chrome\] body\.is-offline \{ --platform-header-h: calc\(var\(--fr-shell-top\) - var\(--browser-banner-h, 0px\) - var\(--platform-safe-top, 0px\)\); \}/);
  assert.match(css, /body\.is-offline \.fr\.fr-shell \.fr-bar \{ margin-top: 0; \}/);
  // After the install strip's rules, at the same weight: with both strips up these say the height of both.
  assert.ok(css.indexOf('body.is-offline .fr.fr-shell .fr-bar { margin-top: 0; }') > css.indexOf('body.has-install-strip .fr.fr-shell .fr-bar { margin-top: 0; }'));
});

test('a kit page with places of its own gives the bar its breadcrumb and its back arrow', () => {
  const html = chrome({ page: { crumb: ['Home', 'All apps'], onBack() {} } });
  assert.match(html, /<button type="button" class="fr-ib" aria-label="Back">/, 'the back arrow, in place of the phone\'s mark');
  assert.match(html, /<div class="fr-crumb"><span class="fr-ci"><span class="fr-cw"><span class="fr-cn">Home<\/span><\/span><\/span><svg class="fr-ic"[^>]*>.*?<\/svg><span class="fr-ci fr-here fr-keep"><span class="fr-cw"><span class="fr-cn">All apps<\/span><\/span><\/span><\/div>/s,
    'each place, a chevron between, the last one where you are; flat, so a phone keeps only the last (.crumb > *:not(.keep))');
  const src = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  assert.match(src, /if \(page\.crumb && page\.onBack\) page\.onBack\(\); else press\('back-btn'\);/, 'its back, else the shell\'s');
  assert.match(src, /new CustomEvent\('frame:tab', \{ detail: key \}\)/, 'and a press on a tab is said, so such a page can come back to its first place');
});

test('on a project\'s page the bar leads with its tile and name, then the place, and its arrow goes up', () => {
  // The tour's bar on every project page (s23 on): back, the community's
  // tile and name, then where you are in it.
  const hub = chrome({ tab: null, screen: 'app-view', slug: 'game-corner', place: 'status' });
  assert.match(hub, /<button type="button" class="fr-ib" aria-label="Back">/);
  assert.match(hub, /<div class="fr-crumb"><span class="fr-ci fr-here fr-keep"><span class="fr-tile" style="--fr-ts:24px;--fr-tc:#3b2d8f" aria-hidden="true">🎮<\/span><span class="fr-cw"><span class="fr-cn">Game Corner<\/span><\/span><\/span><\/div>/,
    'on the Hub the project is where you are');
  const ws = chrome({ tab: null, screen: 'app-view', slug: 'game-corner', place: 'workshop' });
  assert.match(ws, /<div class="fr-crumb"><span class="fr-ci"><span class="fr-tile"[^>]*>🎮<\/span><span class="fr-cw"><span class="fr-cn">Game Corner<\/span><\/span><\/span><svg class="fr-ic"[^>]*>.*?<\/svg><span class="fr-ci fr-here fr-keep"><span class="fr-cw"><span class="fr-cn">Workshop<\/span><\/span><\/span><\/div>/s);
  const src = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  assert.match(src, /if \(here && here !== 'status'\) openPlace\(inCommunity, 'status'\); else pressTab\('home'\);/,
    'from a place up to the Hub, from the Hub back to Home, as the standard header\'s arrow goes');
  // A kit page that says its own breadcrumb still has the last word.
  assert.match(chrome({ tab: null, screen: 'app-view', slug: 'game-corner', place: 'status', page: { crumb: ['Home', 'All apps'], onBack() {} } }), /<span class="fr-ci fr-here fr-keep"><span class="fr-cw"><span class="fr-cn">All apps<\/span><\/span><\/span>/);
});

test('a press is handed to the shell\'s own control, and a cmd-click keeps the address', () => {
  const src = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  assert.match(src, /document\.getElementById\(id\)\?\.click\(\)/);
  assert.match(src, /press\(`platform-tab-\$\{key\}`\)/);
  assert.match(src, /data-frame-bell="" onClick=\{\(\) => \{ \(window as any\)\.NotificationsSheet\?\.toggle\?\.\(\); \}\}/, 'the bell opens the product\'s own sheet, as the standard header\'s bell does');
  assert.match(read('frontend/src/features/header/platform-header.tsx'), /\(window as any\)\.NotificationsSheet\?\.toggle\?\.\(\);/, 'the same call');
  assert.match(src, /aria-label=\{t\('core:rail\.search'\)\} onClick=\{\(\) => \{ \(window as any\)\.Home\?\.focusSearch\?\.\(\); \}\}/, 'search lands in Home\'s field, which finds apps and communities');
  assert.match(src, /function openSettings\(\) \{\s*window\.location\.hash = '#settings';/, 'the You row\'s glyph goes to Settings by its address');
  assert.match(src, /onClick=\{\(event\) => handing\(event, \(\) => pressTab\('me'\)\)\}/, 'the phone\'s avatar is the You tab\'s press');
  assert.doesNotMatch(src, /frame-sheets|openFrameSheet|FrameSheets/, 'the chrome has no sheet of its own');
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/frame/frame-sheets.tsx')), 'the kit\'s notifications and account menu sheets are deleted');
  assert.match(src, /press\('back-btn'\)/);
  assert.match(src, /NavLink\?\.isNativeClick\?\.\(event\)/);
  assert.match(src, /goToCommunity\(slug\)/);
  for (const id of ['platform-tab-home', 'platform-tab-ai', 'platform-tab-messages', 'platform-tab-me', 'back-btn', 'header-title-name', 'notifications-badge']) {
    assert.match(shellMarkup(), new RegExp(`id="${id}"`), `${id} is in the shell for the chrome to read or press`);
  }
});

test('an inert copy behind the screens paints what a look gives the page column', () => {
  const html = chrome();
  assert.match(html, /^<div class="fr fr-app fr-shell fr-shell-under" aria-hidden="true"><aside class="fr-side"><\/aside><div class="fr-colm"><\/div><\/div>/);
  const css = read('public', 'css', 'app.css');
  assert.match(css, /html\[data-skin\] \.fr\.fr-app\.fr-shell\.fr-shell-under \{ z-index: -1; \}/);
  assert.match(css, /html\[data-frame-chrome\] body \{ isolation: isolate; \}/, 'or the layer sinks under the wallpaper');
  assert.match(css, /html\[data-skin\] \.fr\.fr-shell:not\(\.fr-shell-under\) > \.fr-colm \{ background: none; box-shadow: none; \}/);
});

test('today\'s header and tab bar stay mounted, unseen, and the screens take the page area the chrome measured', () => {
  const css = read('public', 'css', 'app.css');
  assert.match(css, /html\[data-frame-chrome\] #platform-header \{ visibility: hidden !important; pointer-events: none !important;[^}]*height: var\(--fr-shell-top\) !important;/);
  assert.match(css, /html\[data-frame-chrome\] #platform-tabs \{ visibility: hidden !important; pointer-events: none !important; \}/);
  assert.match(css, /html\[data-frame-chrome\] body \{ --platform-header-h: calc\(var\(--fr-shell-top\) - var\(--platform-safe-top, 0px\)\); \}/);
  assert.match(css, /@media \(min-width: 768px\) \{\s*html\[data-frame-chrome\] body \{ --platform-rail-full: var\(--fr-shell-left\); \}/);
  assert.match(css, /html\[data-frame-chrome\] body \{ --platform-bar-h: var\(--fr-shell-bottom\) !important; --platform-tabs-h: var\(--fr-shell-bottom\) !important; \}/);
  assert.match(css, /html\[data-skin\] \.fr\.fr-app\.fr-shell \{ position: fixed; inset: 0; z-index: 30;[^}]*pointer-events: none; \}/, 'over the screens, under the sheets, and taking presses only on what it draws');
  // In the tour's mock the page scrolls inside the page area, under the
  // bar's edge; in the shell it scrolls in the document and passes behind
  // the bar, which the looks draw with no ground of its own. The shell's
  // bar wears the look's ground as a tint, no blur (tests/no-glass-one-
  // scheme.test.js), so a flat ground stays one colour, a wallpaper shows
  // faintly, and what scrolls under is put away either way.
  assert.match(css, /html\[data-skin\] :where\(\.fr\.fr-shell:not\(\.fr-shell-under\)\) \.fr-bar \{ background: color-mix\(in srgb, var\(--fr-ground\) 90%, transparent\); \}/);
  // A phone browser's install strip is fixed over the top of the window
  // (#1372): the chrome starts under it, as the guest's does, and the
  // header's placeholder in the padded column is the bar alone, since the
  // body's padding already holds the strip's row. Without the first the
  // strip covered the bar (no back, no title); with it and without the
  // second the page started a strip's height too low.
  assert.match(css, /body\.has-install-strip \.fr\.fr-app\.fr-shell\[data-frame-app\],\s*body\.has-install-strip \.fr\.fr-app\.fr-shell\.fr-shell-under \{ top: calc\(var\(--platform-safe-top, 0px\) \+ var\(--install-strip-h\)\); \}/);
  assert.match(css, /html\[data-frame-chrome\] body\.has-install-strip #platform-header \{ height: calc\(var\(--fr-shell-top\) - var\(--install-strip-h\)\) !important; \}/);
  // …and the header token the screens subtract from the window (`--ws-area`
  // takes the strip off by --browser-banner-h already): the bar alone too,
  // or a project's fitted Discussion was a strip shorter than the room.
  assert.match(css, /html\[data-frame-chrome\] body\.has-install-strip \{ --platform-header-h: calc\(var\(--fr-shell-top\) - var\(--install-strip-h\) - var\(--platform-safe-top, 0px\)\); \}/);
  // On a phone the kit's tab bar is fixed over the page's foot, and a kit
  // page scrolls in the document or in a pane that gave up its own
  // allowance for it: the page's last card ended under the bar. A spacer
  // the bar's height after the page's inner, so each look's own padding
  // stands and the page ends clear of the bar.
  assert.match(css, /@media \(max-width: 767\.98px\) \{\s*html\[data-frame-chrome\] :is\(\.fr:not\(\.fr-app, \[data-project-frame\]\) > \.fr-inner, \[data-project-frame\]:is\(\[data-project-frame=\"status\"\], \[data-project-frame=\"topics\"\], \[data-project-frame=\"workshop-kit\"\]\) > \.fr-inner, \.fr-pane > \.fr-scroll\)::after \{ content: ''; display: block; height: var\(--fr-shell-bottom, 0px\); \}/, 'a page and a pane (Messages\' list, the bot\'s) alike; a project page\'s head only where it is the whole page, since a channel\'s body follows it');
  const src = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  for (const name of ['--fr-shell-left', '--fr-shell-top', '--fr-shell-bottom']) assert.ok(src.includes(`'${name}'`), `${name} is published`);
  assert.match(src, /root\.setAttribute\('data-frame-chrome', ''\)/);
  assert.match(src, /root\.removeAttribute\('data-frame-chrome'\)/, 'and taken back when the chrome goes');
});

test('the chrome keeps clear of a phone\'s status bar and home strip', () => {
  // The fixed layer starts at the window's edges, so each look's bar and
  // tab bar meet the notch and the home strip. Both grow around the inset
  // with their own ground filling it; the page area the chrome measures
  // moves with them, and the screens follow. Margin, not padding, so each
  // look keeps its own border-box height.
  const css = read('public', 'css', 'app.css');
  assert.match(css, /html\[data-skin\] \.fr\.fr-shell \.fr-bar \{\s*position: relative;\s*margin-top: var\(--platform-safe-top, 0px\);\s*\}/);
  assert.match(css, /html\[data-skin\] \.fr\.fr-shell \.fr-bar::before \{[^}]*bottom: 100%;[^}]*height: var\(--platform-safe-top, 0px\);[^}]*background: inherit;/,
    'the bar\'s own ground fills the status bar\'s strip');
  assert.match(css, /html\[data-skin\]:not\(\[data-skin="pastel"\]\) \.fr\.fr-shell > \.fr-side \{\s*border-top: var\(--platform-safe-top, 0px\) solid transparent;\s*border-bottom: var\(--platform-safe-bottom, 0px\) solid transparent;\s*\}/,
    'a tablet\'s sidebar keeps its first and last rows clear, its ground under the transparent borders');
  assert.match(css, /@media \(max-width: 767\.98px\) \{\s+html\[data-skin\]:is\(\.un-kb, \.platform-kb-open\) \.fr\.fr-shell \.fr-tabbar \{ display: none; \}/, 'with the keys up the bar goes, on every page');
  assert.match(css, /html\[data-skin\] \.fr\.fr-shell \.fr-tabbar \{\s*position: relative;\s*margin-bottom: var\(--platform-safe-bottom, 0px\);\s*\}/);
  assert.match(css, /html\[data-skin\] \.fr\.fr-shell \.fr-tabbar::after \{[^}]*top: 100%;[^}]*height: var\(--platform-safe-bottom, 0px\);[^}]*background: inherit;/,
    'the tab bar\'s ground fills the home strip');
  assert.match(css, /html\[data-skin="glass"\] \.fr\.fr-shell \.fr-tabbar,\s*html\[data-skin="pastel"\] \.fr\.fr-shell \.fr-tabbar \{\s*margin-bottom: 0;\s*\}/,
    'a floating tab bar reaches the foot of the screen');
  assert.match(css, /html\[data-skin="glass"\] \.fr\.fr-shell \.fr-tabbar \{\s*height: calc\(64px \+ var\(--platform-tabs-inset, 0px\)\);\s*padding-bottom: calc\(8px \+ var\(--platform-tabs-inset, 0px\)\);\s*\}/,
    'and spends the home strip as its own padding, the way #platform-tabs does');
  assert.match(css, /html\[data-skin="pastel"\] \.fr\.fr-shell \.fr-tabbar \{\s*height: calc\(62px \+ var\(--platform-tabs-inset, 0px\)\);\s*padding-bottom: calc\(6px \+ var\(--platform-tabs-inset, 0px\)\);\s*\}/,
    'Pastel too, at its own height');
  assert.match(css, /html\[data-skin="glass"\] \.fr\.fr-shell \.fr-tabbar::after,\s*html\[data-skin="pastel"\] \.fr\.fr-shell \.fr-tabbar::after \{ content: none; \}/,
    'the bar\'s own box fills the strip under it, so the general rule\'s strip is not drawn');
  assert.match(css, /html\[data-skin="pastel"\] \.fr\.fr-app\.fr-shell \{ top: var\(--platform-safe-top, 0px\); \}/,
    'Pastel\'s horizontal pill is in the top row, so its layer is offset instead');
  // --platform-header-h is defined without the inset and the screens add it
  // themselves; --fr-shell-top now includes it, so it is subtracted once.
  assert.match(css, /html\[data-frame-chrome\] body \{ --platform-header-h: calc\(var\(--fr-shell-top\) - var\(--platform-safe-top, 0px\)\); \}/);
  assert.match(css, /html\[data-frame-chrome\] body\.has-install-strip \{ --platform-header-h: calc\(var\(--fr-shell-top\) - var\(--install-strip-h\) - var\(--platform-safe-top, 0px\)\); \}/);
  // The install strip already moves the layer below the inset; the bar must
  // not add it again.
  assert.match(css, /body\.has-install-strip \.fr\.fr-shell \.fr-bar \{ margin-top: 0; \}/);
  assert.match(css, /body\.has-install-strip \.fr\.fr-shell \.fr-bar::before \{ content: none; \}/);
});

test('the chrome\'s words are catalog text', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'core.json'));
  assert.deepEqual(Object.keys(en).filter((key) => key.startsWith('frame.menu.')), [], 'the account menu\'s words went with it');
  assert.deepEqual(Object.keys(JSON.parse(read('frontend', 'locales', 'en', 'notifications.json'))).filter((key) => key.startsWith('frame.')), [], 'and the kit sheet\'s');
  for (const k of ['frame.brand', 'frame.bot', 'frame.navigation', 'tabs.home', 'tabs.ai', 'tabs.messages', 'tabs.me', 'rail.communities', 'rail.allPlain', 'rail.search', 'header.back', 'header.notifications']) {
    assert.ok(en[k] && typeof en[k].text === 'string' && en[k].description, k);
  }
});

test('the Homeroom menu wears the look: the kit\'s sheet, its primary button, its rows and its small print', () => {
  // The menu stays the product's (its rows, its panes, its controller);
  // what it is drawn with under a look is the kit's, as the sign-in sheet
  // is: the look's ground and shadow, the accent-filled Suggest row as the
  // kit's button, the rows in the look's ink with the look's hover, the
  // Homeroom card as the look's card, the legal links and the version muted.
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.ok(looks.wear.roots.btn.to.includes('#improve-row-feedback'), 'its one filled control is the kit\'s button');
  assert.ok(looks.wear.roots.card.to.includes('#app-menu-homeroom-card'), 'the Go to Homeroom card is the kit\'s card');
  const css = read('public/css/app.css');
  assert.ok(css.includes('THE HOMEROOM MENU'));
  const hand = css.slice(css.indexOf('THE HOMEROOM MENU'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) #apps-switcher-sheet \{[^}]*background: var\(--fr-solid, var\(--fr-ground\)\);[^}]*backdrop-filter: none;[^}]*box-shadow: var\(--fr-sh\), inset 0 0 0 1px var\(--fr-line\);[^}]*border-radius: 24px;[^}]*color: var\(--fr-ink\);[^}]*font-family: var\(--fr-f\);/);
  assert.match(hand, /@media \(max-width: 639\.98px\) \{[^}]*#apps-switcher-sheet \{ border-radius: 24px 24px 0 0; \}/, 'a phone\'s bottom sheet keeps its square foot');
  assert.match(hand, /#apps-switcher-title \{ color: var\(--fr-ink\); \}/);
  assert.match(hand, /#apps-switcher-close \{ background: var\(--fr-sunk\); color: var\(--fr-ink\); \}/);
  assert.match(hand, /#switcher-nav :is\(a, button\)(?:[^{]*) \{ color: var\(--fr-ink\); \}/, 'rows in the look\'s ink');
  assert.match(hand, /#switcher-nav :is\(a, button\):hover \{ background: var\(--fr-sunk\); \}/, 'the look\'s hover');
  assert.match(hand, /#switcher-nav :is\(a, button\) :is\(\.text-zinc-500, \.text-zinc-400\),[^{]*#app-menu-legal,[^{]*#app-menu-version \{ color: var\(--fr-mut\); \}/, 'the small print muted');
  assert.match(hand, /#switcher-nav :is\(\.text-violet-600, \.text-violet-400\) \{ color: var\(--fr-acc\); \}/, 'what asks for you in the accent');
  // The hooks those rules read are the menu's own.
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  for (const hook of ['id="apps-switcher-sheet"', 'id="apps-switcher-title"', 'id="apps-switcher-close"', 'id="switcher-nav"', 'id="app-menu-homeroom-card"', 'id="app-menu-legal"', 'id="app-menu-version"']) assert.ok(sheet.includes(hook), hook);
  assert.ok(read('frontend/src/features/improve/actions.tsx').includes('id="improve-row-feedback"'));
});

test('the bell\'s sheet is the product\'s own, wearing the look', () => {
  // Version 2: the sheet keeps everything it has (search, Unread and All,
  // the groups, what happened, the older weeks); under a look only its
  // dress changes, by the wear map and one hand-written block.
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.ok(looks.wear.roots.card.to.includes('.notifications-card:where(#notifications-sheet *)'), 'each of its cards is the look\'s card');
  assert.equal(looks.wear.roots.tabs.to, '#notifications-screen-tabs', 'Unread and All are the look\'s tabs');
  assert.deepEqual(looks.wear.roots.tabs.skip, ['.tabs .end', '.tabs .end .search', '.tabs .end .inp'], 'less the end slot, which the sheet does not have');
  // (New message's dialog is a second wearer of the tab, "also": tests/messages-frame-new.test.js.)
  assert.deepEqual({ to: looks.wear.roots.tab.to, parts: looks.wear.roots.tab.parts }, { to: '#notifications-screen-tabs > [role="tab"]', parts: { on: '[aria-selected="true"]' } }, 'and the one that is on is the one selected');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE BELL\'S SHEET'), css.indexOf('/* looks:begin'));
  assert.ok(hand.length > 500, 'located the block');
  const P = 'html\\[data-skin\\]:where\\(:not\\(\\[data-skin="brand"\\]\\)\\) ';
  const has = (re, why) => assert.match(hand, new RegExp(P + re), why);
  has('#notifications-sheet \\{[^}]*background: var\\(--fr-solid, var\\(--fr-ground\\)\\);[^}]*color: var\\(--fr-ink\\);[^}]*font-family: var\\(--fr-f\\);', 'the look\'s ground, ink and type');
  has('#notifications-sheet > div:first-child > h2 \\{ font-size: 24px;', 'the title at the kit sheet\'s size');
  has('#notifications-search-input \\{[^}]*border-radius: 999px;[^}]*background: var\\(--fr-surface\\);', 'the search as the kit\'s field');
  has('#notifications-screen-tabs > \\[role="tab"\\] \\{ padding: 0; border-radius: 0; background: none;', 'the tablist\'s own pills are cleared for the look\'s tabs');
  has('#notifications-screen-mark-all \\{ background: var\\(--fr-sunk\\); color: var\\(--fr-ink\\);', 'Mark all read as the kit\'s quiet button');
  has('#notifications-sheet :is\\(\\.text-zinc-600, \\.text-zinc-500, \\.text-zinc-400\\) \\{ color: var\\(--fr-mut\\); \\}', 'the small print muted');
  assert.ok(css.indexOf('THE BELL\'S SHEET') < css.indexOf('/* looks:begin'), 'before the generated section, so a look\'s own tabs and card win');
  for (const line of hand.split('\n').filter((l) => l.includes('{') && !l.trim().startsWith('@media'))) {
    assert.match(line, /^\s*html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) /, `only under a look: ${line.slice(0, 80)}`);
  }
  assert.doesNotMatch(hand, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no colour of its own');
  // The hooks those rules read are the sheet's own.
  const sheet = read('frontend/src/features/notifications/notifications-sheet.tsx');
  for (const hook of ['notifications-sheet', 'notifications-search-input', 'notifications-screen-tabs', 'notifications-screen-mark-all', 'notifications-sheet-close', 'notifications-card']) assert.ok(sheet.includes(hook), hook);
});

test('the Homeroom menu is the tour\'s small sheet: its title, Suggest the whole width, the rows as one card', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE HOMEROOM MENU'), css.indexOf('THE BELL\'S SHEET'));
  assert.match(hand, /#apps-switcher-title \{ font-size: 24px; line-height: 1\.15; font-weight: 700;/);
  assert.match(hand, /#improve-quick-actions #improve-row-feedback \{ flex: 1 1 0; height: 44px;/, 'the kit button would not stretch: the menu\'s own row does');
  assert.match(hand, /#switcher-nav > \[id\^="app-menu-row-"\] \{[^}]*background: var\(--fr-surface\);/, 'the rows are the card');
  assert.match(hand, /#switcher-nav > \[id\^="app-menu-row-"\]:first-child \{ border-start-start-radius: 20px; border-start-end-radius: 20px; \}/);
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  for (const hook of ['app-menu-row-workshop', 'app-menu-row-about', 'app-menu-row-add-homeroom', 'improve-quick-actions']) assert.ok(sheet.includes(hook) || read('frontend/src/features/improve/actions.tsx').includes(hook), hook);
});
