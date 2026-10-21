'use strict';

// The hub's first look (frontend/src/features/dev-board/workshop/
// hub-cards.tsx useFirstLook, FirstLookView).
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
// Evan, 21 Oct 2026: "merge the working out the details card and the first
// look card, keeping the Watch Homeroom bot build it button". The First
// version card under the hero is now that card for its maker once the
// picture is there: the picture in place of the thumbnail, the name, the
// build line, the one line and Watch.
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

const LINE = { state: 'building', words: 'Working out the details', note: '2 min so far' };

test('the card: the picture small and phone-shaped, the name, the build line, the one line and the Watch button', () => {
  // React's server render hoists a preload for the picture ahead of the
  // card; the card is what follows it.
  const html = renderToHtml(createElement(hub.FirstLookView, { slug: 'club-votes', name: 'Club Votes', src: SRC, stage: 'building', line: LINE }))
    .replace(/^<link rel="preload" as="image" href="[^"]*"\/>/, '');
  assert.match(html, /^<section class="dev-ws-strip dev-ws-hub-first dev-ws-first-look" data-ws-first-version="building" data-ws-first-look="">/,
    'the First version card, one of the hub\'s strip cards');
  assert.match(html, new RegExp(`<img src="${SRC.replace(/[?.]/g, '\\$&')}" alt="The first look at Club Votes&#x27;s main screen" width="64" height="138" draggable="false" class="dev-ws-first-look-shot"/>`),
    'a fixed phone-shaped box, so nothing moves as it loads');
  assert.match(html, /<div class="dev-ws-first-look-body"><p class="dev-ws-first-look-name">Club Votes<\/p><span role="status" data-build-line="building"[^>]*>.*<span class="truncate">Working out the details<\/span><span data-build-line-note=""[^>]*>2 min so far<\/span><\/span><p class="dev-ws-strip-text">/,
    'the name, then the line the card draws without the picture, its time on a line of its own');
  assert.match(html, /animate-spin/);
  assert.match(html, /<p class="dev-ws-strip-text">Drawn from your answers\. We&#x27;ll tell you when the working app is live\.<\/p>/);
  assert.match(html, /<button[^>]*data-ws-first-look-watch=""[^>]*>Watch Homeroom bot build it<\/button><\/div><\/section>$/);
  // The words, as the product lead wrote them.
  assert.equal(message('project:hub.firstLook.text'), 'Drawn from your answers. We\'ll tell you when the working app is live.');
  assert.equal(message('project:hub.firstLook.watch'), 'Watch Homeroom bot build it');
  // Its old heading said the project's state a second time: the name and
  // the line say it now.
  assert.doesNotMatch(html, /First look<|what you&#x27;re making|dev-ws-first-look-kicker/);
  assert.doesNotMatch(read('frontend/locales/en/project.json'), /"hub\.firstLook\.(kicker|title)"/);
  // One button, and nothing that shares the picture or invites.
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.doesNotMatch(html, /[Ss]hare|[Ii]nvite|[Cc]opy/);
  // The name as the thumbnail row draws it (15px at 650, AGENTS.md).
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-ws-first-look-name \{\n  margin: 0; max-width: 100%; font-size: 15px; font-weight: 650; line-height: 20px;/);
  assert.doesNotMatch(css, /\.dev-ws-first-look-kicker/);
  assert.match(css, /\.dev-ws-first-look-shot \{\n  flex: none; width: 64px; height: 138px; border-radius: 12px;\n  object-fit: cover; object-position: top;/);
});

test('something waiting on its maker: the card\'s own button over Watch, and no line above it', () => {
  const answer = createElement('button', { type: 'button', 'data-ws-first-version-action': 'answer' }, 'Answer the question');
  const html = renderToHtml(createElement(hub.FirstLookView, { slug: 'club-votes', name: 'Club Votes', src: SRC, stage: 'building', line: null, action: answer }))
    .replace(/^<link rel="preload" as="image" href="[^"]*"\/>/, '');
  assert.doesNotMatch(html, /data-build-line/, 'the button says where it is');
  assert.match(html, /<p class="dev-ws-strip-text">[^<]*<\/p><button type="button" data-ws-first-version-action="answer">Answer the question<\/button><button[^>]*data-ws-first-look-watch=""/);
  // The First version card hands it its line, its button and its press.
  const src = read(HUB);
  const card = src.slice(src.indexOf('export function FirstVersionCard('), src.indexOf('/* ── First look'));
  assert.match(card, /line=\{lineShown \? \{ state: line, words: named\.words, note: named\.note \} : null\}/);
  assert.match(card, /data-ws-first-version-action=\{action\}\s+onClick=\{press\}/);
  assert.match(card, /sectionRef=\{ref\}/, 'read again while it is on screen, as the card without the picture is');
});

test('tapping the picture or the words opens the maker\'s chat with Homeroom bot (#5618)', () => {
  assert.equal(message('project:hub.firstLook.open'), 'Open your chat with Homeroom bot');
  // Without onOpen the card is what it was: no door.
  const plain = renderToHtml(createElement(hub.FirstLookView, { slug: 'club-votes', name: 'Club Votes', src: SRC }));
  assert.doesNotMatch(plain, /data-ws-first-look-open/);
  // With it, an empty button is the section's first child (absolute, so the
  // picture and the words after it keep their places), and Watch stays last.
  const html = renderToHtml(createElement(hub.FirstLookView, { slug: 'club-votes', name: 'Club Votes', src: SRC, stage: 'building', line: LINE, onOpen() {} }))
    .replace(/^<link rel="preload" as="image" href="[^"]*"\/>/, '');
  assert.match(html, /^<section class="dev-ws-strip dev-ws-hub-first dev-ws-first-look" data-ws-first-version="building" data-ws-first-look=""><button type="button" class="dev-ws-first-look-open" data-ws-first-look-open="" aria-label="Open your chat with Homeroom bot"><\/button><img /,
    'the door first, empty, over the picture');
  assert.match(html, /<button[^>]*data-ws-first-look-watch=""[^>]*>Watch Homeroom bot build it<\/button><\/div><\/section>$/,
    'Watch keeps its place, and its own tap');
  // It opens the maker's own conversation, or the chat with the bot, as the
  // First version card's Review the plan does.
  const src = read(HUB);
  const card = src.slice(src.indexOf('export function FirstVersionCard('), src.indexOf('/* ── First look'));
  assert.match(card, /onOpen=\{\(\) => \{\n\s+if \(fv\.conversation_id\) openConversation\(fv\.conversation_id\);\n\s+else void openBot\(\);/);
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
  // The first render, before anything is read, has no picture: the First
  // version card is the thumbnail and its line, as for anyone else.
  const first = renderToHtml(createElement(hub.FirstVersionCard, { slug: 'club-votes', data: community(building()) }));
  assert.match(first, /^<section class="dev-ws-strip dev-ws-hub-first" data-ws-first-version="building"><div class="dev-ws-hub-first-row"><div data-thumb-row=""/);
  assert.doesNotMatch(first, /data-ws-first-look/);
  assert.equal(renderToHtml(createElement(hub.FirstVersionCard, { slug: 'club-votes', data: null })), '');
  const src = read(HUB);
  const card = src.slice(src.indexOf('export function useFirstLook('), src.indexOf('export function watchBuild('));
  assert.match(card, /fetch\(madeAppUrl\(slug\), \{ credentials: 'same-origin', cache: 'no-store' \}\)/, 'GET /api/apps/:slug, past the worker\'s cache, as the tour reads it');
  assert.match(card, /const found = firstLookSrc\(body, slug, FIRST_LOOK_ONLY\);/);
  assert.match(src, /const FIRST_LOOK_ONLY: readonly string\[\] = \['first_look'\];/);
  assert.match(card, /if \(!wanted \|\| !slug \|\| \(src && src !== broken && !isDrawnLook\(src\)\)\) return undefined;/,
    'asked again only while it is not there, or only drawn (15 Oct 2026, tests/first-look-drawn.test.js)');
  assert.match(card, /\}, FIRST_VERSION_POLL_MS\);/);
  assert.match(card, /if \(!wanted \|\| !shown\) return null;/);
  // Only the maker's, and held back while the tour runs: its own last card
  // is this picture.
  const fvCard = src.slice(src.indexOf('export function FirstVersionCard('), src.indexOf('/* ── First look'));
  assert.match(fvCard, /const look = useFirstLook\(slug, hubShowsFirstLook\(fv\)\);/);
  assert.match(fvCard, /if \(look && !touring\) \{/);
});

test('in the First version card\'s place, under the hero, and no second card after For you', () => {
  // 21 Oct 2026: the first look was its own card after For you, under the
  // First version card that said the same build's state; it is that card now.
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const at = (s) => lander.indexOf(s);
  assert.ok(at('<FirstVersionCard slug={slug}') > 0);
  assert.ok(at('<FirstVersionCard slug={slug}') < at('<ShareItCard slug={slug}'));
  assert.doesNotMatch(lander, /FirstLookCard/);
  assert.equal(hub.FirstLookCard, undefined);
  assert.match(lander, /import \{ FirstVersionCard, ForYouCard, HubSkeleton, RecentlyLive, hubAlone, owesVote \} from '\.\/hub-cards';/);
});
