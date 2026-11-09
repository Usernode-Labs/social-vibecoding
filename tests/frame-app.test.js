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
function stubs({ tab = 'home', screen = 'home-screen', bot = false, messages = 2, ai = 18, slug = null, page = { crumb: null, onBack: null } } = {}) {
  return {
    './frame-page-store': { framePageStore: fixedStore(page) },
    '../nav/nav-store.js': { navStore: fixedStore({ tab, screen, bot, messages, ai, viewer: 'snait' }) },
    '../nav/rail-communities': { useRailCommunities: () => ['homeroom', 'game-corner', 'lobby'] },
    '../workshop/community-scope': { communityScopeStore: fixedStore({ slug, info: INFO, list: Object.keys(INFO) }), goToCommunity() {} },
    '../../lib/visibility-store': { useVisibility: (id, initial) => initial },
    '../../lib/platform-viewer': { whenPlatformViewer: () => () => {} },
    './frame-sheets': { FrameSheets: () => null, openFrameSheet() {} },
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
  assert.match(html, /<header class="fr-bar">.*?<div class="fr-crumb"><span style="display:contents"><span class="fr-ci fr-here fr-keep">Messages<\/span><\/span><\/div><span class="fr-sp"><\/span>/s);
  assert.match(html, /<button type="button" class="fr-ib fr-d" aria-label="[^"]+">/, 'search, on a desktop');
  assert.match(html, /<button type="button" class="fr-ib" aria-label="Notifications">/);
  const bar = html.slice(html.indexOf('<nav class="fr-tabbar"'));
  assert.deepEqual([...bar.matchAll(/<a class="fr-tb[^"]*" href="([^"]+)"/g)].map((m) => m[1]), ['#home', '#homeroom-bot', '#messages', '#profile']);
  assert.match(bar, /<a class="fr-tb fr-on" href="#messages" aria-current="page">/);
  assert.match(bar, />Bot<span class="fr-n">18<\/span>/, 'the bar has room for one short word');
});

test('a kit page with places of its own gives the bar its breadcrumb and its back arrow', () => {
  const html = chrome({ page: { crumb: ['Home', 'All apps'], onBack() {} } });
  assert.match(html, /<button type="button" class="fr-ib" aria-label="Back">/, 'the back arrow, in place of the phone\'s mark');
  assert.match(html, /<span class="fr-ci">Home<\/span><\/span><span style="display:contents"><svg class="fr-ic"[^>]*>.*?<\/svg><span class="fr-ci fr-here fr-keep">All apps<\/span>/s,
    'each place, a chevron between, the last one where you are');
  const src = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  assert.match(src, /if \(page\.crumb && page\.onBack\) page\.onBack\(\); else press\('back-btn'\);/, 'its back, else the shell\'s');
  assert.match(src, /new CustomEvent\('frame:tab', \{ detail: key \}\)/, 'and a press on a tab is said, so such a page can come back to its first place');
});

test('a press is handed to the shell\'s own control, and a cmd-click keeps the address', () => {
  const src = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  assert.match(src, /document\.getElementById\(id\)\?\.click\(\)/);
  assert.match(src, /press\(`platform-tab-\$\{key\}`\)/);
  assert.match(src, /openFrameSheet\('notifications'\)/, 'the bell opens the kit\'s own sheet');
  assert.match(src, /openFrameSheet\('menu'\)/, 'and the sliders on the You row the account menu');
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
  assert.match(css, /html\[data-frame-chrome\] body \{ --platform-header-h: var\(--fr-shell-top\); \}/);
  assert.match(css, /@media \(min-width: 768px\) \{\s*html\[data-frame-chrome\] body \{ --platform-rail-full: var\(--fr-shell-left\); \}/);
  assert.match(css, /html\[data-frame-chrome\] body \{ --platform-bar-h: var\(--fr-shell-bottom\) !important; --platform-tabs-h: var\(--fr-shell-bottom\) !important; \}/);
  assert.match(css, /html\[data-skin\] \.fr\.fr-app\.fr-shell \{ position: fixed; inset: 0; z-index: 30;[^}]*pointer-events: none; \}/, 'over the screens, under the sheets, and taking presses only on what it draws');
  const src = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  for (const name of ['--fr-shell-left', '--fr-shell-top', '--fr-shell-bottom']) assert.ok(src.includes(`'${name}'`), `${name} is published`);
  assert.match(src, /root\.setAttribute\('data-frame-chrome', ''\)/);
  assert.match(src, /root\.removeAttribute\('data-frame-chrome'\)/, 'and taken back when the chrome goes');
});

test('the chrome\'s words are catalog text', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'core.json'));
  for (const k of ['frame.brand', 'frame.bot', 'frame.navigation', 'tabs.home', 'tabs.ai', 'tabs.messages', 'tabs.me', 'rail.communities', 'rail.allPlain', 'rail.search', 'header.back', 'header.notifications']) {
    assert.ok(en[k] && typeof en[k].text === 'string' && en[k].description, k);
  }
});
