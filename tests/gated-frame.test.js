// A members' page opened by a visitor, in the one frame (frontend/src/
// features/guest/frame/gated-frame.tsx), as the 2026-11-06 screen tour draws
// it (o12 to o15): instead of the landing with a sheet on top, the address
// has its own page saying what lives there. Sign in is its one primary
// button, and a second group lists what is open without an account, so the
// page is not a dead end.
//
// Run with: node --test tests/gated-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const GATED = 'frontend/src/features/guest/frame/gated-frame.tsx';
const render = (over) => renderComponent(GATED, 'GatedFrame', { target: '#messages', title: 'Sign in to open Messages', waitlist: true, onSignIn() {}, onStart() {}, onBrowse() {}, ...over }, { cache: false });

test('Messages says what lives there, with Sign in as the one primary button', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-gated-frame="messages"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Messages<\/h1><p class="fr-purpose">Private chats with people and groups\. Sign in to open yours\.<\/p><\/div>/);
  assert.match(html, /<div class="fr-acts"><button type="button" class="fr-btn fr-line">Join the waitlist<\/button><button type="button" class="fr-btn" data-gated-sign-in=""><svg[^>]*>.*?<\/svg>Sign in<\/button><\/div>/s);
  assert.deepEqual([...html.matchAll(/<h2 class="fr-cap">([^<]+)<\/h2>/g)].map((m) => m[1]), ['What lives here', 'Open without an account', 'New here?']);
  assert.deepEqual([...html.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]),
    ['Direct messages', 'Group chats', 'Mentions', 'Communities and apps', 'Join the waitlist']);
  assert.match(html, /<span class="fr-t">Direct messages<\/span><span class="fr-s">One to one, with anyone in your communities<\/span>/);
});

test('the bot\'s page and yours are the same page with their own three rows', () => {
  const bot = render({ target: '#homeroom-bot/main', title: 'Sign in to open this page' });
  assert.match(bot, /data-gated-frame="bot".*?<h1 class="fr-title">Homeroom bot<\/h1><p class="fr-purpose">Ask for a change in plain words and follow what is being built for you\. Sign in to open yours\.<\/p>/s);
  assert.deepEqual([...bot.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]).slice(0, 3), ['Ask for a change', 'Watch it build', 'One list of what needs you']);
  const you = render({ target: '#profile', title: 'Sign in to open this page' });
  assert.match(you, /data-gated-frame="you".*?<h1 class="fr-title">You<\/h1>/s);
  assert.deepEqual([...you.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]).slice(0, 3), ['Your changes', 'Your requests', 'Challenges']);
});

test('any other members\' address keeps the product\'s own words for it, and still is not a dead end', () => {
  const html = render({ target: '/app/secret-club/workshop', title: 'Sign in to open Secret Club' });
  assert.match(html, /data-gated-frame="page".*?<h1 class="fr-title">Sign in to open Secret Club<\/h1><p class="fr-purpose">This page is for members\. Everything public is open to look around meanwhile\.<\/p>/s);
  assert.doesNotMatch(html, /What lives here/, 'nothing is claimed about a page the visitor cannot see');
  assert.deepEqual([...html.matchAll(/<h2 class="fr-cap">([^<]+)<\/h2>/g)].map((m) => m[1]), ['Open without an account', 'New here?']);
  assert.match(render({ waitlist: false }), /<button type="button" class="fr-btn fr-line">Create account<\/button>/);
});

test('which page it is comes from the address, as the product reads it', () => {
  const { gatedKind } = loadTsx(GATED, { cache: false });
  assert.equal(gatedKind('#messages/42'), 'messages');
  assert.equal(gatedKind('#chat'), 'messages');
  assert.equal(gatedKind('#homeroom-bot/thread/7'), 'bot');
  assert.equal(gatedKind('#profile'), 'you');
  assert.equal(gatedKind('#settings/theme'), 'page');
  assert.equal(gatedKind('/app/x/workshop?ws=needs'), 'page');
  assert.equal(gatedKind(''), 'page');
});

test('every class is the kit\'s', () => {
  const classes = [...render().matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('under a look the landing draws the page and the sheet waits for its button', () => {
  const src = read('frontend/src/features/auth/landing.tsx');
  assert.match(src, /\{frame && gate \? \(\s*<GatedFrame/);
  assert.match(src, /onSignIn=\{\(\) => setGateSheet\(true\)\}/);
  assert.match(src, /open=\{!frame \|\| gateSheet\}/, 'the standard look opens the sheet as the screen shows, as it did');
  assert.match(src, /if \(gateSheetUp\.current\) \{ setGateSheet\(false\); return; \}/, 'closing the sheet over the page closes the sheet, not the page');
  assert.match(src, /\{frame && guestPages && !guestProject && !linkPending && !gate \? \(\s*<LandingFrame/, 'one kit page at a time');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\] \[data-gated-frame\] ~ \[data-guest-discover\] \{ display: none; \}/);
  assert.match(hand, /html\[data-skin\] #auth-landing-screen:has\(\[data-gated-frame\]\) \[data-deep-link-backdrop\] \{ display: none; \}/, 'no blurred stand-in: the page is there');
});
