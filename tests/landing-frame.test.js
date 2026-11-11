// The landing in the one frame (frontend/src/features/guest/frame/landing
// -frame.tsx), version 2 of the screen tour's o01 to o03 and w03: the first
// tour's layout (a head with one primary button, two columns) holding
// today's signed-out Home. The welcome over the headline, the three points
// beside the page, one search, this device's pins, and Communities drawn
// by the one view Home has for it under a look (home/frame/to-join.tsx).
// What the first tour invented is gone: Try an app first, Try an app now,
// Look on each row, Homeroom today.
//
// Run with: node --test tests/landing-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const LANDING = 'frontend/src/features/guest/frame/landing-frame.tsx';

const NOW = new Date().toISOString();
const app = (slug, name, over = {}) => ({ slug, name, url: `https://${slug}.example`, icon_emoji: '🎮', icon_url: null, icon_color: '#3b2d8f', category: 'games', member_count: 12, active_users: 0, requires_login: false, ...over });
const APPS = [
  app('game-corner', 'Game Corner', { featured: true, featured_order: 1, active_users: 41 }),
  app('best-color', 'The Best Color', { category: 'social', active_users: 5, created_at: NOW, description: 'Find your favorite color.' }),
  app('tier-lists', 'Community Tier Lists', { category: 'social', active_users: 3, requires_login: true }),
  app('todo', 'Todo List', { category: 'other', active_users: 33, description: 'A shared list.' }),
];
const stubsFor = (pins = { apps: [], communities: [] }) => ({
  '../device-pins': { devicePinsStore: { get: () => pins, subscribe: () => () => {} }, loadDevicePins() {}, toggleDevicePin() {} },
  '../../auth/sign-up-from': { noteSignUpFrom() {} },
});
const render = (over, pins) => renderComponent(LANDING, 'LandingFrame', { apps: APPS, failed: false, waitlist: true, onStart() {}, onOpenInside() {}, ...over }, { cache: false, stubs: stubsFor(pins) });
const caps = (html) => [...html.matchAll(/<h2 class="fr-cap"[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);

test('the head: the welcome over the headline, its sentence, and the one primary button', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-landing-frame=""><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><div class="fr-cap fr-over">Welcome to Homeroom<\/div><h1 class="fr-title">On Homeroom, communities make apps together\.<\/h1><p class="fr-purpose">Look around and try what we&#x27;re making\.<\/p><\/div>/);
  assert.match(html, /<div class="fr-acts"><button type="button" class="fr-btn" data-landing-frame-join="">Join the waitlist<\/button><\/div>/, 'one button, as the story\'s short version has');
  assert.match(render({ waitlist: false }), /data-landing-frame-join="">Sign up<\/button>/, 'where accounts open at once, the button says so');
  assert.match(render({ welcomeEmail: 'mina@example.com' }), /<h1 class="fr-title">[^<]+<\/h1><div class="fr-sub13">mina@example\.com<\/div>/, 'a "You\'re in" link\'s address is greeted, as the story greets it');
});

test('the three points are the side column, first on a phone, and do not change with the kind or the search', () => {
  const html = render();
  const side = html.slice(html.indexOf('<div class="fr-stack fr-first">'));
  assert.ok(html.includes('<div class="fr-stack fr-first"><div class="fr-card"><div class="fr-row fr-wrap">'), 'one card with no label of its own');
  assert.deepEqual([...side.matchAll(/<span class="fr-t">([^<]+)<\/span><span class="fr-s">([^<]+)<\/span>/g)].map((m) => m[1]), ['Vote on what changes', 'Ask for what you want', 'Make your own']);
  for (const over of [{ initialKind: 'social' }, { initialQuery: 'todo' }]) assert.match(render(over), /fr-stack fr-first.*Vote on what changes.*Make your own/s);
});

test('Communities is Home\'s own section: the kinds, Featured as cards, the rest as rows, and a visitor\'s card has no button', () => {
  const html = render();
  assert.deepEqual(caps(html), ['Communities'], 'a first visit has no pins: the search, then the directory');
  assert.match(html, /<div class="fr-cols"><div class="fr-stack"><div class="fr-search fr-flush"><label class="fr-inp">.*?<\/label><\/div><section class="fr-sec"><div class="fr-sechead"><h2 class="fr-cap">Communities<\/h2>/s, 'the search leads the work column');
  assert.deepEqual([...html.matchAll(/<button type="button" class="fr-btn(?: fr-quiet)? fr-sm" aria-pressed="(true|false)" data-home-join-kind="[a-z]+">([^<]+)<\/button>/g)].map((m) => [m[2], m[1]]),
    [['All', 'true'], ['Games', 'false'], ['Social', 'false'], ['Other', 'false']]);
  // Featured: the whole card is the door; the pill is how many people used it lately, heard with the name.
  assert.match(html, /<h3 class="fr-cap fr-sub">Featured<\/h3><div class="fr-grid fr-across" data-home-join-featured=""><a class="fr-card fr-pad fr-hcard" href="\/app\/game-corner" aria-label="Game Corner, 41 people used it lately"><span class="fr-hc-top"><span class="fr-tile"[^>]*>🎮<\/span><span class="fr-btnrow" aria-hidden="true"><span class="fr-pill" data-kind="none"><svg[^>]*>.*?<\/svg>41<\/span><\/span><\/span><span class="fr-t2">Game Corner<\/span><\/a><\/div>/s);
  // The rest: rows, the most used first, each its sentence, "New" for its first 30 days, people from five.
  const rows = html.slice(html.indexOf('data-home-join-featured'), html.indexOf('fr-stack fr-first'));
  assert.deepEqual([...rows.matchAll(/<a class="fr-row[^"]*" href="\/app\/([a-z-]+)"/g)].map((m) => m[1]), ['todo', 'best-color', 'tier-lists']);
  assert.match(rows, /<a class="fr-row" href="\/app\/best-color" aria-label="The Best Color, 5 people used it lately">.*?<span class="fr-t">The Best Color<\/span><span class="fr-s">Find your favorite color\.<\/span><\/span><span class="fr-btnrow" aria-hidden="true"><span class="fr-pill" data-kind="none">New<\/span><span class="fr-pill" data-kind="none"><svg.*?<\/svg>5<\/span><\/span><\/a>/s);
  assert.match(rows, /<a class="fr-row fr-sm" href="\/app\/tier-lists">(?:(?!fr-pill).)*<\/a>/s, 'fewer than five people is not said');
  assert.doesNotMatch(html, /<button[^>]*data-home-join=|>Join<|>Look<|members<|up for a vote/, 'no Join, no Look, no member count: the page behind the card has Try it, Join and Pin');
});

test('a kind: its featured communities, then the rest under More communities', () => {
  const apps = [...APPS, app('snake', 'Snake', { active_users: 9 })];
  const html = render({ apps, initialKind: 'games' });
  assert.match(html, /aria-pressed="true" data-home-join-kind="games">Games</);
  assert.match(html, /<h3 class="fr-cap fr-sub">Featured<\/h3>.*?Game Corner.*?<h3 class="fr-cap fr-sub">More communities<\/h3><div class="fr-card"><a class="fr-row fr-sm" href="\/app\/snake"/s);
  assert.doesNotMatch(html, /Todo List|The Best Color/);
});

test('this device\'s pins come first once it has any: an app opens, its corner takes it off; a community opens its page', () => {
  const html = render({}, { apps: ['todo', 'gone'], communities: ['game-corner'] });
  assert.deepEqual(caps(html), ['Pinned apps', 'Pinned communities', 'Communities']);
  assert.match(html, /<section class="fr-sec" data-guest-pinned-apps="">.*?<div class="fr-at"><a class="fr-atl" href="https:\/\/todo\.example">.*?<span class="fr-nm">Todo List<\/span><\/a><button type="button" class="fr-corner fr-un" aria-label="Unpin Todo List from Home"><span aria-hidden="true">−<\/span><\/button><\/div>/s);
  assert.match(html, /<section class="fr-sec" data-guest-pinned-communities="">.*?<a class="fr-at" href="\/app\/game-corner">/s);
  assert.deepEqual(caps(render({ initialQuery: 'corner' }, { apps: ['todo'], communities: ['game-corner'] })), ['Pinned communities', 'Communities'], 'the one search narrows the pins too');
  const src = read(LANDING);
  assert.match(src, /toggleDevicePin\('apps', app\.slug\)/);
  assert.match(src, /if \(!waiting && app\.requires_login !== false\) return;\s*event\.preventDefault\(\);\s*onOpenInside\(app\);/, 'an app that asks for no account opens in the landing\'s viewer, any other at its own address');
  assert.match(src, /window\.history\.replaceState\(withGuestSearch\(window\.history\.state, value\), ''\)/, 'the search is kept on the history entry, as the standard page keeps it');
});

test('it says when the directory is on its way and when it could not be read; a search with no match shows nothing, as the standard page', () => {
  assert.match(render({ apps: null }), /<section class="fr-sec" aria-busy="true"><div class="fr-sechead"><h2 class="fr-cap">Communities<\/h2><\/div><p class="fr-secnote">Loading apps<\/p><\/section>/);
  const failed = render({ apps: null, failed: true, onRetry() {} });
  assert.match(failed, /<div class="fr-note fr-bad"[^>]*>.*?<button type="button" class="fr-btn fr-quiet fr-sm" data-guest-retry="">Try again<\/button>/s);
  assert.doesNotMatch(failed, />Communities</);
  assert.doesNotMatch(render({ initialQuery: 'zzz' }), />Communities<|fr-row" href/);
  assert.match(render({ initialQuery: 'todo' }), /<span class="fr-t">Todo List<\/span>/);
});

test('what the first tour invented is gone, with its words', () => {
  const html = render();
  assert.doesNotMatch(html, /Try an app first|Try an app now|No account needed|Homeroom today|With an account|fr-fact|fr-tabs/);
  const catalog = JSON.parse(read('frontend/locales/en/auth.json'));
  assert.deepEqual(Object.keys(catalog).filter((key) => key.startsWith('frame.landing.')), []);
  assert.doesNotMatch(read(LANDING), /auth:frame\./);
});

test('every class is the kit\'s', () => {
  for (const html of [render({}, { apps: ['todo'], communities: ['game-corner'] }), render({ waiting: { email: null } })]) {
    const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
    for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
  }
});

test('the landing draws it ahead of its own page under a look, and app.css puts that page away', () => {
  const src = read('frontend/src/features/auth/landing.tsx');
  assert.match(src, /\{frame && guestPages && !guestProject && !linkPending && !gate \? \(\s*<LandingFrame/, 'not under a members\' address, which is the sheet over an outline (tests/deep-link-sign-in.test.js)');
  assert.match(src, /waiting=\{waitingGuest \? \{ email: sessionEmail\(\) \} : null\}\s*welcomeEmail=\{releaseEmail\}/);
  assert.ok(src.indexOf('<LandingFrame') < src.indexOf('<GuestDiscover'), 'ahead of the standard page, which stays mounted');
  assert.match(src, /const frame = isFrameSkin\(useSkin\(\)\);/, 'standard until mount: the landing is prerendered');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\] \[data-landing-frame\] ~ \[data-guest-discover\] \{ display: none; \}/);
  // One drawing of the directory under a look, Home's.
  assert.match(read(LANDING), /import \{ ToJoinView \} from '\.\.\/\.\.\/home\/frame\/to-join';/);
  assert.match(read('frontend/src/features/home/frame/home-frame.tsx'), /import \{ ToJoinView \} from '\.\/to-join';/);
});

test('an account still in line looks around on the same Home: where it stands is the side column', () => {
  // The tour's w03: signed in, not let in yet. Today's chrome (the guest's
  // bar), Home's title, and the standard waitlist card's words beside the page.
  const html = render({ waiting: { email: 'mina@example.com' } });
  assert.match(html, /^<div class="fr" data-landing-frame="waiting"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Home<\/h1><p class="fr-purpose">Your apps and your communities\.<\/p><\/div><\/div><div class="fr-search"><label class="fr-inp">/, 'the search under the head, as on Home; no button');
  assert.match(html, /<div class="fr-stack fr-first"><section class="fr-sec" data-guest-waitlist=""><div class="fr-sechead"><h2 class="fr-cap">You&#x27;re on the waitlist<\/h2><\/div><div class="fr-card"><p class="fr-cardnote">[^<]*mina@example\.com[^<]*<\/p><a class="fr-row fr-sm" href="#waiting"><span class="fr-tx"><span class="fr-t">Your spot on the waitlist<\/span><\/span><svg/);
  assert.doesNotMatch(html, /Welcome to Homeroom|Join the waitlist|Vote on what changes|data-landing-frame-join/);
  assert.match(html, /<h2 class="fr-cap">Communities<\/h2>.*?<h3 class="fr-cap fr-sub">Featured<\/h3>/s);
  assert.match(render({ waiting: { email: null } }), /<p class="fr-cardnote">[^<]+<\/p>/);
});
