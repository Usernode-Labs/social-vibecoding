// The landing in the one frame (frontend/src/features/guest/frame/landing
// -frame.tsx), as the 2026-11-06 screen tour draws it (o01 to o03): the
// product's own frame for a visitor. A title, one sentence, one primary
// button; the kinds of community as the page's tabs; what an account adds,
// apps to try and communities to look at in the 720px column; what is here
// today beside it. Nothing on it is a layout a member will not see inside.
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

const app = (slug, name, over = {}) => ({ slug, name, url: `https://${slug}.example`, icon_emoji: '🎮', icon_url: null, icon_color: '#3b2d8f', category: 'games', member_count: 12, requires_login: false, ...over });
const APPS = [
  app('game-corner', 'Game Corner', { featured: true, featured_order: 1, member_count: 89 }),
  app('best-color', 'The Best Color', { category: 'social', member_count: 5 }),
  app('tier-lists', 'Community Tier Lists', { category: 'social', member_count: 1, requires_login: true, guest_ready: false }),
  app('todo', 'Todo List', { category: 'other', member_count: 33 }),
];
const stubs = {
  '../device-pins': { devicePinsStore: { get: () => ({ apps: [], communities: [] }), subscribe: () => () => {} }, loadDevicePins() {} },
  '../../auth/sign-up-from': { noteSignUpFrom() {} },
};
const render = (over) => renderComponent(LANDING, 'LandingFrame', { apps: APPS, failed: false, waitlist: true, onStart() {}, onOpenInside() {}, ...over }, { cache: false, stubs });

test('the head: what Homeroom is, one sentence, and the one primary button', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-landing-frame=""><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">On Homeroom, communities make apps together\.<\/h1><p class="fr-purpose">Look around and try what we&#x27;re making\.<\/p><\/div>/);
  assert.match(html, /<div class="fr-acts"><button type="button" class="fr-btn fr-line"><svg[^>]*>.*?<\/svg>Try an app first<\/button><button type="button" class="fr-btn" data-landing-frame-join="">Join the waitlist<\/button><\/div>/s);
  assert.match(render({ waitlist: false }), /data-landing-frame-join="">Sign up<\/button>/, 'where accounts open at once, the button says so');
});

test('the kinds of community are the page\'s tabs, the same control as everywhere', () => {
  const html = render();
  assert.deepEqual([...html.matchAll(/<button type="button" class="fr-tab(?: fr-on)?" aria-pressed="(true|false)">([^<]+)<\/button>/g)].map((m) => [m[2], m[1]]),
    [['All', 'true'], ['Games', 'false'], ['Social', 'false'], ['Other', 'false']]);
  assert.doesNotMatch(render({ apps: [app('a', 'A', { category: 'other' })] }), /fr-tabs/, 'All and Other alone would sort nothing');
});

test('All: what an account adds, apps to try, communities to look at; what is here today beside them', () => {
  const html = render();
  const caps = [...html.matchAll(/<h2 class="fr-cap"[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
  assert.deepEqual(caps, ['With an account', 'Try an app now', 'Communities', 'Homeroom today']);
  assert.deepEqual([...html.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]).slice(0, 3), ['Vote on what changes', 'Ask for what you want', 'Make your own']);
  // An app that needs no account is a tile that opens it; one that does is not offered.
  const tiles = html.slice(html.indexOf('fr-tiles'), html.indexOf('Communities</h2>'));
  assert.deepEqual([...tiles.matchAll(/<span class="fr-nm">([^<]+)<\/span>/g)].map((m) => m[1]), ['Game Corner', 'The Best Color', 'Todo List']);
  assert.match(tiles, /<a class="fr-at" href="https:\/\/game-corner\.example">/);
  assert.match(html, /No account needed/);
  // Every community is a row, the featured one first, its people said in words, ending in Look.
  const rows = html.slice(html.indexOf('Communities</h2>'), html.indexOf('Homeroom today'));
  assert.deepEqual([...rows.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]), ['Game Corner', 'The Best Color', 'Community Tier Lists', 'Todo List']);
  assert.match(rows, /<a class="fr-row" href="\/app\/game-corner"[^>]*>.*?<span class="fr-s">89 members<\/span>.*?<span class="fr-btn fr-quiet fr-sm">Look<\/span><\/a>/s);
  assert.match(rows, /<span class="fr-s">1 member<\/span>/);
  assert.match(html, /<div class="fr-fact"><div class="fr-v">4<\/div><div class="fr-l">communities<\/div><\/div><div class="fr-fact"><div class="fr-v">3<\/div><div class="fr-l">apps to try<\/div><\/div>/);
});

test('a kind shows its communities and its apps, and the side column does not change', () => {
  const html = render({ initialKind: 'social' });
  assert.match(html, /class="fr-tab fr-on" aria-pressed="true">Social</);
  assert.doesNotMatch(html, /With an account/, 'the three points are the page\'s, said once on All');
  const rows = html.slice(html.indexOf('fr-cols'), html.indexOf('Homeroom today'));
  assert.deepEqual([...rows.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]), ['The Best Color', 'Community Tier Lists']);
  assert.deepEqual([...rows.matchAll(/<span class="fr-nm">([^<]+)<\/span>/g)].map((m) => m[1]), ['The Best Color']);
  assert.match(html, /<div class="fr-v">4<\/div><div class="fr-l">communities<\/div>/);
});

test('it says when the directory is on its way, when it could not be read, and when nothing matches', () => {
  assert.match(render({ apps: null }), /<div class="fr-card fr-pad">Loading…<\/div>/);
  assert.match(render({ apps: null, failed: true, onRetry() {} }), /<div class="fr-note fr-bad"[^>]*>.*?<button type="button" class="fr-btn fr-quiet fr-sm">Try again<\/button>/s);
  assert.match(render({ initialQuery: 'zzz' }), /<div class="fr-card fr-pad">No communities match that\.<\/div>/);
  assert.match(render({ initialQuery: 'todo' }), /<span class="fr-t">Todo List<\/span>/);
});

test('every class is the kit\'s', () => {
  const classes = [...render().matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('the landing draws it ahead of its own page under a look, and app.css puts that page away', () => {
  const src = read('frontend/src/features/auth/landing.tsx');
  assert.match(src, /\{frame && guestPages && !guestProject && !linkPending && !waitingGuest && !gate \? \(\s*<LandingFrame/, 'not under a members\' page, which has its own (tests/gated-frame.test.js)');
  assert.ok(src.indexOf('<LandingFrame') < src.indexOf('<GuestDiscover'), 'ahead of the standard page, which stays mounted');
  assert.match(src, /const frame = isFrameSkin\(useSkin\(\)\);/, 'standard until mount: the landing is prerendered');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\] \[data-landing-frame\] ~ \[data-guest-discover\] \{ display: none; \}/);
});
