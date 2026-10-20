'use strict';

// The hub's first look card (frontend/src/features/dev-board/workshop/
// hub-cards.tsx FirstLookCard).
//
// Newcomer run six (14 Oct 2026, iPhone 17 Safari, Club Votes): after the
// tour's Done the maker landed on the hub, which said "Building it", then
// the Share it card, then nothing down to the Resume bar. The first look,
// the picture of the app's main screen Homeroom bot drew from the plan, was
// only on the App tab. Now, while their first version is built and the
// picture is there, a card after For you shows it small and phone-shaped,
// with "FIRST LOOK", "Here's what you're making", one line, and "Watch
// Homeroom bot build it", which opens the App tab. Nothing on it shares the
// picture: inviting is Share it's, and invitations are to the community.
//
// Run with: node --test tests/hub-first-look.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HUB = 'frontend/src/features/dev-board/workshop/hub-cards.tsx';
const LOOK = 'frontend/src/features/first-session/first-look.tsx';

const hub = loadTsx(HUB);

const building = (over = {}) => ({
  step: 4, of: 7, line: 'building', phase: { key: 'drawing', since: null }, ready: false, mine: true, creator: 'evan',
  waits_on: null, conversation_id: 41, session_id: null, ...over,
});

const community = (fv) => ({
  slug: 'club-votes', name: 'Club Votes', audience: 'solo', member_count: 1, is_member: true, can_manage: true,
  audience_change: null, first_version: fv,
});

const SRC = '/api/apps/club-votes/first-version/screens/first_look/0?v=1760464920000';

test('the card: the picture small and phone-shaped, the kicker, the title, the line and the one button', () => {
  // React's server render hoists a preload for the picture ahead of the
  // card; the card is what follows it.
  const html = renderToHtml(createElement(hub.FirstLookView, { slug: 'club-votes', name: 'Club Votes', src: SRC }))
    .replace(/^<link rel="preload" as="image" href="[^"]*"\/>/, '');
  assert.match(html, /^<section class="dev-ws-strip dev-ws-first-look" data-ws-first-look="">/, 'one of the hub\'s strip cards');
  assert.match(html, new RegExp(`<img src="${SRC.replace(/[?.]/g, '\\$&')}" alt="The first look at Club Votes&#x27;s main screen" width="64" height="138" draggable="false" class="dev-ws-first-look-shot"/>`),
    'a fixed phone-shaped box, so nothing moves as it loads');
  assert.match(html, /<p class="dev-ws-first-look-kicker">First look<\/p>/);
  assert.match(html, /<p class="dev-ws-head-title">Here&#x27;s what you&#x27;re making<\/p>/);
  assert.match(html, /<p class="dev-ws-strip-text">Drawn from your answers\. We&#x27;ll tell you when the working app is live\.<\/p>/);
  assert.match(html, /<button[^>]*data-ws-first-look-watch=""[^>]*>Watch Homeroom bot build it<\/button><\/div><\/section>$/);
  // The words, as the product lead wrote them.
  assert.equal(message('project:hub.firstLook.kicker'), 'First look');
  assert.equal(message('project:hub.firstLook.title'), 'Here\'s what you\'re making');
  assert.equal(message('project:hub.firstLook.text'), 'Drawn from your answers. We\'ll tell you when the working app is live.');
  assert.equal(message('project:hub.firstLook.watch'), 'Watch Homeroom bot build it');
  // One button, and nothing that shares the picture or invites.
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.doesNotMatch(html, /[Ss]hare|[Ii]nvite|[Cc]opy/);
  // The kicker is small caps (AGENTS.md: 12px bold, tracked 0.06em, muted).
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-ws-first-look-kicker \{\n  margin: 0; font-size: 12px; font-weight: 700; line-height: 16px;\n  letter-spacing: 0\.06em; text-transform: uppercase; color: var\(--text-muted\);\n\}/);
  assert.match(css, /\.dev-ws-first-look-shot \{\n  flex: none; width: 64px; height: 138px; border-radius: 12px;\n  object-fit: cover; object-position: top;/);
});

test('tapping the picture or the words opens the maker\'s chat with Homeroom bot (#5618)', () => {
  assert.equal(message('project:hub.firstLook.open'), 'Open your chat with Homeroom bot');
  // Without onOpen the card is what it was: no door.
  const plain = renderToHtml(createElement(hub.FirstLookView, { slug: 'club-votes', name: 'Club Votes', src: SRC }));
  assert.doesNotMatch(plain, /data-ws-first-look-open/);
  // With it, an empty button is the section's first child (absolute, so the
  // picture and the words after it keep their places), and Watch stays last.
  const html = renderToHtml(createElement(hub.FirstLookView, { slug: 'club-votes', name: 'Club Votes', src: SRC, onOpen() {} }))
    .replace(/^<link rel="preload" as="image" href="[^"]*"\/>/, '');
  assert.match(html, /^<section class="dev-ws-strip dev-ws-first-look" data-ws-first-look=""><button type="button" class="dev-ws-first-look-open" data-ws-first-look-open="" aria-label="Open your chat with Homeroom bot"><\/button><img /,
    'the door first, empty, over the picture');
  assert.match(html, /<button[^>]*data-ws-first-look-watch=""[^>]*>Watch Homeroom bot build it<\/button><\/div><\/section>$/,
    'Watch keeps its place, and its own tap');
  // It opens the maker's own conversation, or the chat with the bot, as the
  // First version card's Review the plan does.
  const src = read(HUB);
  const card = src.slice(src.indexOf('export function FirstLookCard('), src.indexOf('export function watchBuild('));
  assert.match(card, /const id = data\?\.first_version\?\.conversation_id;/);
  assert.match(card, /if \(id\) openConversation\(id\);\n\s+else void openBot\(\);/);
  // The door lies under the Watch button, and only a hover tint and the
  // focus ring show it.
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-ws-strip\.dev-ws-first-look \{ position: relative; /);
  assert.match(css, /\.dev-ws-first-look-open \{\n  position: absolute; inset: 0; z-index: 1; border: 0; padding: 0;\n  background: transparent; border-radius: inherit; cursor: pointer;\n\}/);
  assert.match(css, /\.dev-ws-first-look-open:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 2px; \}/);
  assert.match(css, /\.dev-ws-first-look-body > button \{ position: relative; z-index: 2; margin-top: 8px; \}/);
});

test('its button opens the project\'s App tab, where the live picture of the build is', () => {
  const calls = [];
  const had = Object.hasOwn(globalThis, 'window');
  const before = globalThis.window;
  globalThis.window = { App: { openAppTab: (...args) => calls.push(args) } };
  try {
    hub.watchBuild('club-votes');
  } finally {
    if (had) globalThis.window = before; else delete globalThis.window;
  }
  assert.deepEqual(calls, [['club-votes', 'app']]);
  assert.match(read(HUB), /data-ws-first-look-watch=""\s+onClick=\{\(\) => watchBuild\(slug\)\}/);
});

test('shown to its maker while it is built or tested, never once it is ready to try or live', () => {
  const { hubShowsFirstLook } = hub;
  assert.equal(hubShowsFirstLook(building()), true, 'being built');
  assert.equal(hubShowsFirstLook(building({ line: 'testing', phase: null })), true, 'being tested');
  assert.equal(hubShowsFirstLook(building({ line: 'ready', ready: true })), false, 'ready to try: the First version card has Try it');
  assert.equal(hubShowsFirstLook(building({ line: 'live', ready: true })), false, 'live: gone');
  assert.equal(hubShowsFirstLook(building({ line: 'live' })), false);
  assert.equal(hubShowsFirstLook(building({ mine: false })), false, '"your answers" are the maker\'s');
  assert.equal(hubShowsFirstLook(building({ line: 'plan', waits_on: 'plan' })), false, 'nothing drawn before the plan is decided');
  assert.equal(hubShowsFirstLook(null), false);
  assert.equal(hubShowsFirstLook(undefined), false);
});

test('only the first look, read as the tour\'s last card reads it, and nothing until it is there', () => {
  const { firstLookSrc } = loadTsx(LOOK);
  const body = (screens) => ({ app: { first_version: { line: 'building', screens } } });
  assert.equal(firstLookSrc(body({ kind: 'first_look', count: 1, v: '1760464920000' }), 'club-votes', ['first_look']), SRC);
  assert.equal(firstLookSrc(body({ kind: 'real', count: 3, v: '9' }), 'club-votes', ['first_look']), null,
    'the real screens are not "drawn from your answers"');
  assert.equal(firstLookSrc(body({ kind: 'real', count: 3, v: '9' }), 'club-votes'), '/api/apps/club-votes/first-version/screens/real/0?v=9',
    'the tour\'s card still takes either');
  assert.equal(firstLookSrc(body({ kind: 'first_look', count: 1 }), 'club-votes', ['bogus']), null, 'only a kind the server draws');
  // The first render, before anything is read, draws nothing: built, not
  // built, or touring alike.
  for (const fv of [building(), building({ line: 'live', ready: true }), null]) {
    assert.equal(renderToHtml(createElement(hub.FirstLookCard, { slug: 'club-votes', data: community(fv) })), '');
  }
  assert.equal(renderToHtml(createElement(hub.FirstLookCard, { slug: 'club-votes', data: null })), '');
  const src = read(HUB);
  const card = src.slice(src.indexOf('export function FirstLookCard('), src.indexOf('export function watchBuild('));
  assert.match(card, /fetch\(madeAppUrl\(slug\), \{ credentials: 'same-origin', cache: 'no-store' \}\)/, 'GET /api/apps/:slug, past the worker\'s cache, as the tour reads it');
  assert.match(card, /const found = firstLookSrc\(body, slug, FIRST_LOOK_ONLY\);/);
  assert.match(src, /const FIRST_LOOK_ONLY: readonly string\[\] = \['first_look'\];/);
  assert.match(card, /if \(!wanted \|\| !slug \|\| \(src && src !== broken && !isDrawnLook\(src\)\)\) return undefined;/,
    'asked again only while it is not there, or only drawn (15 Oct 2026, tests/first-look-drawn.test.js)');
  assert.match(card, /\}, FIRST_VERSION_POLL_MS\);/);
  // Held back while the tour runs: its own last card is this picture.
  assert.match(card, /const touring = useTourRunning\(\);/);
  assert.match(card, /if \(!wanted \|\| touring \|\| !shown\) return null;/);
});

test('on the hub after For you, before Recently live', () => {
  // 15 Oct 2026: Share it moved up, under the hero and the First version
  // card; the first look stays where it was, over Recently live.
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const at = (s) => lander.indexOf(s);
  assert.ok(at('<ShareItCard slug={slug}') > 0);
  assert.ok(at('<ShareItCard slug={slug}') < at('<ForYouCard'));
  assert.ok(at('<ForYouCard') < at('<FirstLookCard slug={slug} data={community} />'));
  assert.ok(at('<FirstLookCard slug={slug} data={community} />') < at('<RecentlyLive slug={slug}'));
  assert.match(lander, /import \{ FirstLookCard, FirstVersionCard, ForYouCard, HubSkeleton, RecentlyLive, hubAlone, owesVote \} from '\.\/hub-cards';/);
});
