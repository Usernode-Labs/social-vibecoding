// A running app under one of the frame's looks (the first screen tour's
// s38, holding what the standard screen has today: version 2). The app
// fills everything under the bar; the frame's bar names the project and
// "App", and carries Suggest on a desktop, the one control the standard
// header has there besides the bell and the mark. On a phone the product
// gives the app the whole screen and takes the tabs down, and the frame's
// chrome goes with them: that is not changed.
//
// Run with: node --test tests/frame-running-app.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const FRAME_APP = 'frontend/src/features/frame/frame-app.tsx';
const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });

const INFO = { 'game-corner': { slug: 'game-corner', name: 'Game Corner', iconUrl: null, iconEmoji: '🎮', iconColor: '#3b2d8f', needs: 0 } };
function stubs({ tab = 'app', suggest = true, place = null, page = { crumb: null, onBack: null } } = {}) {
  return {
    '../dev-board/workshop/place-store': { placeStore: fixedStore({ slug: place ? 'game-corner' : null, place: place || 'status', owed: 0, unread: 0, tray: false }), openPlace() {} },
    '../dev-board/workshop/places': { placeName: (key) => ({ status: 'Hub', needs: 'Needs you', workshop: 'Workshop' }[key] || key) },
    './frame-page-store': { framePageStore: fixedStore(page) },
    '../nav/nav-store.js': { navStore: fixedStore({ tab: null, screen: 'app-view', bot: false, messages: 0, ai: 0, viewer: 'snait' }) },
    '../nav/rail-communities': { useRailCommunities: () => ['game-corner'] },
    '../workshop/community-scope': { communityScopeStore: fixedStore({ slug: 'game-corner', info: INFO, list: Object.keys(INFO) }), goToCommunity() {} },
    '../../lib/visibility-store': { useVisibility: (id, initial) => initial },
    '../../lib/platform-viewer': { whenPlatformViewer: () => () => {} },
    './frame-sheets': { FrameSheets: () => null, openFrameSheet() {} },
    '../improve/improve-store.js': { improveStore: fixedStore({ target: 'app', slug: 'game-corner', tab, selfHosted: false }) },
    '../improve/improve-controller.js': { Improve: { giveFeedback() {} } },
    '../header/in-app-actions': { useInAppShown: () => suggest },
  };
}
const bar = (state) => {
  const html = renderComponent(FRAME_APP, 'FrameChrome', {}, { stubs: stubs(state), cache: false });
  const at = html.indexOf('<header class="fr-bar">');
  return html.slice(at, html.indexOf('</header>', at));
};

test('beside a running app the bar says the project and "App", whatever place its page last said', () => {
  const html = bar({ place: 'workshop' });
  assert.match(html, /<span class="fr-ci"><span class="fr-tile"[^>]*>.*?<\/span>Game Corner<\/span><svg[^>]*>.*?<\/svg><span class="fr-ci fr-here fr-keep">App<\/span>/s);
  assert.doesNotMatch(html, />Workshop</, 'the app tab publishes no place; a stale one is not read');
  const src = read(FRAME_APP);
  assert.match(src, /const onApp = !!inCommunity && improve\.target === 'app' && improve\.tab === 'app';/, 'the store the standard header reads, not App.currentTab');
  assert.match(src, /\.\.\.\(onApp \? \[\{ word: tProject\('project:places\.list\.app'\) \}\] : here && here !== 'status' \? \[\{ word: placeName\(here\) \}\] : \[\]\)/, 'the word the places list has for that row');
  assert.equal(JSON.parse(read('frontend/locales/en/project.json'))['places.list.app'].text, 'App');
  // On the project's own pages the trail is as before.
  assert.match(bar({ tab: 'dev', place: 'workshop' }), /<span class="fr-ci fr-here fr-keep">Workshop<\/span>/);
});

test('the way back beside a running app is the shell\'s own, not the project page\'s arrow up to the Hub', () => {
  assert.doesNotMatch(bar(), /aria-label="Back"/, 'the standard header shows none there on a desktop, and the stub shell has none');
  assert.match(bar({ tab: 'dev', place: 'workshop' }), /^<header class="fr-bar"><button type="button" class="fr-ib" aria-label="Back">/);
  const src = read(FRAME_APP);
  assert.match(src, /const back = page\.crumb \? !!page\.onBack : inCommunity && !onApp \? true : shellBack;/);
  assert.match(src, /onClick=\{!page\.crumb && inCommunity && !onApp \? goUp : goBack\}/);
});

test('Suggest stands in the bar on a desktop, by the standard header\'s rule and with its press', () => {
  const html = bar();
  assert.match(html, /<span class="fr-sp"><\/span><button type="button" class="fr-btn fr-line fr-sm fr-d" data-frame-suggest="" aria-label="Suggest an improvement"><svg[^>]*>.*?<\/svg>Suggest<\/button><button type="button" class="fr-ib fr-d" aria-label="[^"]+">/s,
    'the kit\'s small outlined button, before search; .d is drawn on a desktop only');
  assert.doesNotMatch(bar({ suggest: false }), /data-frame-suggest/);
  const src = read(FRAME_APP);
  assert.match(src, /const suggest = useInAppShown\(\);/);
  assert.match(src, /onClick=\{\(\) => Improve\.giveFeedback\(\{ target: 'app' \}\)\}/);
  const std = read('frontend/src/features/header/in-app-actions.tsx');
  assert.match(std, /export function useInAppShown\(\): boolean \{\s*const \{ target, slug, tab, selfHosted \} = useStoreState\(improveStore\);\s*return target === 'app' && \(tab === 'app' \|\| tab === 'dev'\) && !!slug && !selfHosted;/,
    'one rule for both bars: a project\'s app and its pages');
  assert.match(std, /onClick=\{\(\) => Improve\.giveFeedback\(\{ target: 'app' \}\)\}/);
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\]\[data-skin\] \.fr-d\{display:none(?:!important)?\}/, 'a phone reaches Suggest through the mark\'s menu, as under the standard header');
});

test('on a phone the product still takes the tabs down for a running app, and the frame\'s chrome with them', () => {
  const src = read(FRAME_APP);
  assert.match(src, /const routed = useVisibility\('platform-tabs', true\);\s*const on = isFrameSkin\(skin\) && viewer && routed;/);
  const app = read('public/js/app.js');
  assert.match(app, /App\.embeddedPanel \? false : !!screen && !App\.chromeless && \(!inApp \|\| railPinned\),/, 'app.js decides, as before: tabs stay only where the rail is pinned beside the app');
});
