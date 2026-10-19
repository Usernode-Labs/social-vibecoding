'use strict';

// Apps in their communities, in the desktop's sidebar of rows (18 Oct 2026).
//
// Each community's app is the first row under it (App), with the green
// "still open" dot while its frame is kept; a community whose app is still
// running keeps that row alone under its own while you are in another one,
// and is never pushed out of the sidebar. The strip's Pinned and Recent apps
// went with it: a pin is a community's, in a Pinned section above your
// communities and outside the five.
//
//   frontend/src/features/nav/rail-communities.tsx  the rows
//   frontend/src/features/nav/rail-pinned.tsx       the pinned section
//   frontend/src/features/nav/rail-nest.tsx         a part inside a part
//
// tests/desktop-sidebar-rows.test.js has which five; tests/nav-tab-bar.test.js
// the pin gestures; tests/resume-collapse.test.js the App row as the target a
// closing app shrinks into.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const RAIL = 'frontend/src/features/nav/rail-communities.tsx';
const PINNED = 'frontend/src/features/nav/rail-pinned.tsx';

// A row, drawn on its own against a list of yours.
function drawRow(here, { info, list, slug = 'chess', record = null } = {}) {
  const state = { slug: null, info: info || {}, list: list === undefined ? Object.keys(info || {}) : list };
  const { RailCommunityRow } = loadTsx(RAIL, {
    stubs: {
      '../workshop/community-scope': {
        communityScopeStore: { get: () => state, subscribe: () => () => {} },
        goToCommunity: () => {},
      },
    },
  });
  return renderToHtml(createElement(RailCommunityRow, {
    slug,
    record,
    here: { sidebarRows: true, screen: 'app-view', onPage: null, onApp: null, live: [], ...here },
  }));
}

const CHESS = { chess: { slug: 'chess', name: 'Chess', iconUrl: null, iconEmoji: null, iconColor: null, selfHosted: false } };

test('which communities lead with App: not Homeroom\'s own, and not before it is known', () => {
  const { hasAppRow } = loadTsx(RAIL);
  assert.equal(hasAppRow('chess', CHESS, ['chess']), true);
  assert.equal(hasAppRow('home', { home: { selfHosted: true } }, ['home']), false, 'the platform is its app');
  assert.equal(hasAppRow('chess', {}, null), false, 'not before the list of yours is read');
  assert.equal(hasAppRow('chess', { chess: { name: 'Chess' } }, ['chess']), false, 'one of yours, not yet known');
  assert.equal(hasAppRow('stranger', {}, ['chess']), true, 'one that is not yours is never Homeroom, which every account is in');
});

test('in its app: the community open, App first and lit with its dot, no place lit', () => {
  const html = drawRow({ onApp: 'chess', live: ['chess'] }, { info: CHESS });
  assert.match(html, /<a class="platform-rail-community" href="#app\/chess\/workshop" data-rail-community="chess" data-rail-open="" title="Chess" aria-current="page">/);
  const app = html.indexOf('data-rail-app="chess"');
  const places = html.indexOf('data-places="chess"');
  assert.ok(app > 0 && places > app, 'App, then its places');
  assert.match(html, /<div class="platform-rail-nest" data-nest="open"><div class="platform-rail-nest-in"><div class="platform-rail-app-row"><a class="platform-rail-sub platform-rail-app" href="\/app\/chess" data-rail-app="chess" data-live="true" title="Chess app" aria-label="Chess app, still open" aria-current="page">/);
  assert.match(html, /class="platform-rail-sub-glyph"/);
  assert.match(html, new RegExp(`<span class="platform-rail-sub-name">${message('core:rail.app')}</span><span class="app-live-dot platform-rail-live"`));
  assert.match(html, /<div class="platform-rail-nest platform-rail-places" data-nest="open">/, 'the places in a part inside it');
  assert.doesNotMatch(html.slice(places), /aria-current/, 'in the app, App is lit and no place is');
});

test('in another community: a running app keeps its App row alone; a stopped one keeps nothing', () => {
  const kept = drawRow({ screen: 'app-view', onPage: 'other', live: ['chess'] }, { info: CHESS });
  assert.match(kept, /data-rail-app="chess" data-live="true"/);
  assert.doesNotMatch(kept, /aria-current/, 'nothing of it is lit');
  assert.doesNotMatch(kept, /data-rail-open/);
  assert.doesNotMatch(kept, /data-places=/, 'its places folded away');
  const gone = drawRow({ screen: 'app-view', onPage: 'other', live: [] }, { info: CHESS });
  assert.doesNotMatch(gone, /platform-rail-nest/, 'no part at all');
  // On its page, App is there without the dot until the app has run.
  const page = drawRow({ onPage: 'chess' }, { info: CHESS });
  assert.match(page, /<div class="platform-rail-app-row"><a class="platform-rail-sub platform-rail-app" href="\/app\/chess" data-rail-app="chess" title="Chess app" aria-label="Chess app">/);
  // Homeroom's own community: its places, and no App row.
  const home = drawRow({ onPage: 'home' }, { slug: 'home', info: { home: { slug: 'home', name: 'Homeroom', selfHosted: true } } });
  assert.match(home, /data-places="home"/);
  assert.doesNotMatch(home, /data-rail-app/);
});

test('a kept app off screen wears a close button over its dot; the app on screen and a stopped one wear none (#5525)', () => {
  const kept = drawRow({ screen: 'app-view', onPage: 'other', live: ['chess'] }, { info: CHESS });
  const anchorEnd = kept.indexOf('</a>', kept.indexOf('data-rail-app="chess"'));
  const dot = kept.indexOf('<span class="app-live-dot platform-rail-live"');
  const button = kept.indexOf('<button type="button" class="platform-rail-live-stop"');
  assert.ok(dot > 0 && dot < anchorEnd, 'the dot stays inside the App anchor, where the declared check finds it');
  assert.ok(button > anchorEnd, 'the button is the anchor\'s sibling, never inside it');
  assert.match(kept, /<div class="platform-rail-app-row">/);
  assert.match(kept, /<button type="button" class="platform-rail-live-stop" title="Close app" aria-label="Close Chess app">/);
  assert.match(kept, /d="M6 18L18 6M6 6l12 12"/, 'the shell\'s X glyph');
  // On its own page the places are open: the row stays, the X still offered.
  const page = drawRow({ onPage: 'chess', live: ['chess'] }, { info: CHESS });
  assert.match(page, /class="platform-rail-live-stop" title="Close app" aria-label="Close Chess app"/);
  // The app on screen: no way to close the frame you are looking at.
  const onScreen = drawRow({ onApp: 'chess', live: ['chess'] }, { info: CHESS });
  assert.doesNotMatch(onScreen, /platform-rail-live-stop/);
  // Not running: nothing to close.
  const stopped = drawRow({ onPage: 'chess' }, { info: CHESS });
  assert.doesNotMatch(stopped, /platform-rail-live-stop/);
  // The press closes that one app through the frame bridge's eviction.
  const src = read(RAIL);
  assert.match(src, /event\.currentTarget\.parentElement\?\.querySelector\('a\.platform-rail-app'\)\?\.focus\(\);/,
    'focus moves to the row before the button goes');
  assert.match(src, /closeLiveApp\(slug\);/);
  const evicted = [];
  const { closeLiveApp } = loadTsx('frontend/src/features/app-frame/live-apps.tsx', {
    stubs: { './app-frame-bridge.js': { appFrameBridge: { evict: (slug) => { evicted.push(slug); return true; } } } },
  });
  closeLiveApp('chess');
  assert.deepEqual(evicted, ['chess'], 'the button evicts the app it names');
  // The reveal, and the dot that hides under it.
  const css = read('public/css/app.css');
  assert.match(css, /\.platform-rail-app-row \{\n {4}position: relative;\n {2}\}/);
  assert.match(css, /\.platform-rail-live-stop \{\n {4}position: absolute;/, 'the X sits where the dot sits');
  assert.match(css, /\.platform-rail-live-stop:is\(:hover, :focus-visible\) \{\n {4}opacity: 1;\n {2}\}/);
  assert.match(css, /\.platform-rail-app-row:has\(\.platform-rail-live-stop:is\(:hover, :focus-visible\)\) \.platform-rail-live \{\n {4}visibility: hidden;\n {2}\}/,
    'the dot and the X never show together');
});

test('in the app of a community you have not joined: its App row alone, lit, and no record read', () => {
  const html = drawRow({ onApp: 'stranger', live: ['stranger'] }, { slug: 'stranger', info: {}, list: ['chess'] });
  assert.match(html, /data-rail-community="stranger" title="stranger" aria-current="page"/, 'lit, named by what is known');
  assert.match(html, /data-rail-app="stranger" data-live="true"[^>]*aria-current="page"/);
  assert.doesNotMatch(html, /data-places=|data-rail-open/, 'no places, so nothing reads its community record');
  // Only a page you are visiting is read for its name.
  assert.match(read(RAIL), /const visit = useCommunity\(c \|\| record \|\| recent \|\| onPage !== slug \? '' : slug\);/);
});

test('a pin is drawn as any community is, named by its own record when the list does not have it', () => {
  const html = drawRow({ onPage: 'x' }, { slug: 'gym', info: {}, list: ['chess'], record: { name: 'Gym', iconUrl: null, iconEmoji: '🏋️' } });
  assert.match(html, /data-rail-community="gym" title="Gym"/);
  assert.match(html, /<span class="platform-rail-name">Gym<\/span>/);
});

test('the source: the part holds App, then the places; the five leave the pins out and keep a running app', () => {
  const src = read(RAIL);
  assert.match(src, /const part = open \|\| \(sidebarRows && app && \(running \|\| onApp === slug\)\);/);
  assert.match(src, /<NestSlot open=\{part\} className="platform-rail-nest" rows="\.platform-rail-app, \.dev-ws-place, \.dev-ws-places-head">\s*\{app \? \(/);
  assert.match(src, /\(window as unknown as \{ App\?: \{ openAppTab\?: \(slug: string, tab: string\) => void \} \}\)\.App\?\.openAppTab\?\.\(slug, 'app'\);/,
    'App opens through the router, which switches to a kept app');
  // The five are the most recent of yours that are not pinned, and opening
  // one keeps a running app's community in.
  assert.match(src, /const listKey = yours \? yours\.filter\(\(s\) => !pinned\.includes\(s\)\)\.join\(\) : null;/);
  assert.match(src, /const next = noteOpened\(shown, slug, list, RAIL_COMMUNITIES, live\);/);
  // The section: a visit, a running app not among the five, then the five,
  // less the pinned ones.
  assert.match(src, /railRows\(shown, here\.onPage \|\| here\.onApp, here\.live\)/);
  assert.match(src, /\.filter\(\(slug\) => !pinned\.includes\(slug\)\);/);
  // The All row counts neither the five's votes nor the pins'.
  assert.match(read('frontend/src/features/nav/tab-bar.tsx'),
    /votesElsewhere\(\[\.\.\.pins\.map\(\(app: \{ slug: string \}\) => app\.slug\), \.\.\.railShown\], scope\.list, scope\.info\)/);
});

test('the pinned section: its own heading, the pins drawn as rows, the slot while a tile is in the air', () => {
  const src = read(PINNED);
  assert.match(src, /<RailCommunityRow key=\{app\.slug\} slug=\{app\.slug\} here=\{here\} record=\{app\} pin=\{handlers\(app\)\} \/>/);
  assert.match(src, /readPinnedApps\(who\)/, 'the stored pins, read after mount');
  const store = read('frontend/src/features/nav/pinned-apps-store.js');
  assert.match(store, /const KEY = 'usernode_community_pins_v1';/, 'the account\'s list as this device last read it');
  assert.match(store, /const DEVICE_KEY = 'usernode_pinned_apps_v2';/,
    'the key an app was pinned under before: sent up once, so it is its community\'s pin now');
  assert.equal(message('core:rail.pin.here'), 'Pin here');
  assert.equal(message('core:rail.pin.unpin'), 'Unpin');
});

test('a part inside a part: the inner one opens with the outer, not after it', () => {
  const src = read('frontend/src/features/nav/rail-nest.tsx');
  assert.match(src, /const Appearing = createContext\(false\);/);
  assert.match(src, /const appearing = open && !present\.current;/);
  assert.match(src, /const still = reducedMotion\(\) \|\| typeof el\.animate !== 'function' \|\| \(fresh && withParent\);/);
  assert.match(src, /<Appearing\.Provider value=\{appearing\}>\{open \? children : kept\.current\}<\/Appearing\.Provider>/);
  // The outer part draws the one line and the padding round both.
  const css = read('public/css/app.css');
  assert.match(css, /\.platform-rail-nest \.platform-rail-places > \.platform-rail-nest-in \{\n {4}padding: 0;\n {2}\}/);
  assert.match(css, /\.platform-rail-nest \.platform-rail-app-row \+ \.platform-rail-places > \.platform-rail-nest-in \{\n {4}padding-top: 1px;\n {2}\}/);
  assert.match(css, /\.platform-rail-nest \.platform-rail-places > \.platform-rail-nest-in::before \{\n {4}display: none;\n {2}\}/);
  assert.match(css, /\.platform-rail-nest \.platform-rail-live \{\n {4}width: 8px;\n {4}height: 8px;/, 'the dot at a row\'s size');
});
