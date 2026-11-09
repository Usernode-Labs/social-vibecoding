// The frame's chrome for a visitor (frontend/src/features/frame/guest-chrome
// .tsx), as the 2026-11-06 screen tour draws every guest page and every
// stand-alone page (o01 to o27): one bar and the page under it. No sidebar
// and no tab bar. The anonymous screens keep their own header and back disc,
// unseen under a look, and a press on the kit's bar is handed to them.
//
// Run with: node --test tests/guest-chrome.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const CHROME = 'frontend/src/features/frame/guest-chrome.tsx';
const view = (bar) => renderComponent(CHROME, 'GuestChromeView', { bar: { back: false, crumb: '', actions: [], ...bar }, onBack() {}, onAction() {} }, { cache: false });

const SIGN_IN = { key: '0', label: 'Sign in', primary: false, pressed: null };
const SIGN_UP = { key: '1', label: 'Sign up', primary: true, pressed: null };

test('the landing\'s bar: the brand, then Sign in, and on a desktop Sign up', () => {
  const html = view({ actions: [SIGN_IN, SIGN_UP] });
  assert.match(html, /<div class="fr fr-app fr-noside fr-shell" data-frame-app="guest"><div class="fr-colm"><header class="fr-bar">/, 'no sidebar: the frame\'s one-column form');
  assert.match(html, /<header class="fr-bar"><span class="fr-brand" style="margin:0;padding:0"><span class="fr-tile"[^>]*>.*?<\/span>Homeroom<\/span><span class="fr-sp"><\/span>/s);
  assert.match(html, /<button type="button" class="fr-btn fr-line fr-sm">Sign in<\/button><span class="fr-d"><button type="button" class="fr-btn fr-sm">Sign up<\/button><\/span><\/header>/,
    'the quiet way in for somebody with an account, the primary one beside it where there is room');
  assert.match(html, /<main class="fr-pagearea"><\/main><\/div><\/div>$/, 'the page area is empty: the screen under it shows through');
  assert.doesNotMatch(html, /fr-side|fr-tabbar|fr-ib/, 'no sidebar, no tab bar, nothing to go back to');
});

test('a screen with a way back says so first; an open app or project is named in place of the brand', () => {
  const solo = view({ back: true });
  assert.match(solo, /<header class="fr-bar"><button type="button" class="fr-ib" aria-label="Back"><svg[^>]*>.*?<\/svg><\/button><span class="fr-brand"/s);
  assert.doesNotMatch(solo, /fr-btn/, 'a stand-alone page has no ways in on its bar: it is one');
  const open = view({ back: true, crumb: 'Game Corner', actions: [{ key: '0', label: 'Pinned', primary: false, pressed: true }, { ...SIGN_IN, key: '1' }] });
  assert.match(open, /<div class="fr-crumb"><span class="fr-ci fr-here fr-keep">Game Corner<\/span><\/div>/);
  assert.doesNotMatch(open, /fr-brand/);
  assert.match(open, /<button type="button" class="fr-btn fr-line fr-sm" aria-pressed="true">Pinned<\/button><button type="button" class="fr-btn fr-line fr-sm">Sign in<\/button>/,
    'whatever the landing\'s own bar offers, in its order');
});

test('it is up for a visitor only: under a look, while an anonymous screen is, and never on the first render', () => {
  const src = read(CHROME);
  assert.equal(renderComponent(CHROME, 'GuestFrame', {}, { cache: false, stubs: { '../../lib/visibility-store': { useVisibility: (id, initial) => initial } } }), '');
  assert.match(src, /const SCREENS = \['auth-landing-screen', 'auth-login-screen', 'auth-register-screen', 'auth-waitlist-screen', 'auth-more-screen'\] as const;/,
    'the waiting room is a signed-in screen and is not one of them');
  assert.match(src, /return isFrameSkin\(skin\) && at > -1 \? <GuestChrome screen=\{SCREENS\[at\]\} \/> : null;/);
  assert.match(read('frontend/src/features/frame/frame-app.tsx'), /return on \? <FrameChrome \/> : <GuestFrame \/>;/, 'one or the other, never both');
  assert.match(src, /root\.setAttribute\('data-frame-chrome', 'guest'\);/, 'app.css knows which chrome is up');
});

test('a press is handed to the screen\'s own control, and the bar follows the screen\'s own header', () => {
  const src = read(CHROME);
  assert.match(src, /onBack=\{\(\) => pressIn\(screen, screen === 'auth-landing-screen' \? '#landing-back-btn' : SOLO_BACK\)\}/);
  assert.match(src, /const SOLO_BACK = '\[data-auth-back\], :scope > a\[href="#landing"\]';/, 'the shared disc, or the plain link "more ways" has');
  assert.match(read('frontend/src/features/auth/more.tsx'), /<a\s+href="#landing"\s+className="fixed start-4 z-10 /);
  assert.match(src, /onAction=\{\(action\) => pressIn\(screen, '\[data-landing-actions\] button', Number\(action\.key\)\)\}/);
  assert.match(src, /crumb: title && !title\.querySelector\('svg'\) \? \(title\.textContent \|\| ''\)\.trim\(\) : '',/, 'the wordmark is a picture, a name is words');
  // The landing's own hooks, which this reads: they must still be there.
  const landing = read('frontend/src/features/auth/landing.tsx');
  for (const hook of ['id="landing-header"', 'id="landing-back-btn"', 'id="landing-header-title"', 'data-landing-actions=""', 'data-landing-sign-in=""', 'data-landing-sign-up=""']) {
    assert.ok(landing.includes(hook), hook);
  }
  assert.match(read('frontend/src/features/auth/back-button.tsx'), /data-auth-back=""/);
});

test('under the guest\'s chrome the anonymous screens sit in its page area, their own header and back disc put away', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  const block = hand.slice(hand.indexOf('THE GUEST\'S FRAME'));
  assert.ok(hand.includes('THE GUEST\'S FRAME'));
  for (const id of ['auth-landing-screen', 'auth-login-screen', 'auth-register-screen', 'auth-waitlist-screen', 'auth-more-screen']) {
    assert.ok(block.includes(`html[data-frame-chrome="guest"] #${id}`), id);
  }
  assert.match(block, /top: var\(--fr-shell-top, 0px\);[^}]*inset-inline-start: var\(--fr-shell-left, 0px\);[^}]*background: none;/);
  assert.match(block, /html\[data-frame-chrome="guest"\] #landing-header,\s*html\[data-frame-chrome="guest"\] \[data-auth-back\],\s*html\[data-frame-chrome="guest"\] #auth-more-screen > a\[href="#landing"\] \{ display: none; \}/);
  assert.match(block, /html\[data-skin\] \.fr\.fr-app\.fr-shell\[data-frame-app="guest"\] \{ z-index: 41; \}/, 'over the anonymous screens (40), under their sheets and the install strip (45)');
});

test('a stand-alone page is the kit\'s one column: the product\'s own form, wearing the title, the card and the button', () => {
  // Sign-in, register, the waitlist form and "more ways" (the tour's o07 to
  // o11) keep their forms and every step in them; the look reaches them
  // through the wear map, and app.css gives them the column and the field.
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  const AUTH = ':is(#auth-login-screen,#auth-register-screen,#auth-waitlist-screen,#auth-more-screen)';
  assert.ok(looks.wear.roots.title.to.includes(`${AUTH} h1`));
  assert.ok(looks.wear.roots.card.to.includes(`${AUTH} .rounded-2xl.overflow-hidden`));
  assert.equal(looks.wear.roots.btn.to, `${AUTH} :is(button,a):is(.bg-violet-600,.rounded-full:is(.bg-white,.bg-zinc-100)):not([data-auth-back])`,
    'the one accent-filled control is the primary button; a white or grey pill is a quiet one');
  assert.deepEqual(looks.wear.roots.btn.parts, { quiet: ':is(.bg-white,.bg-zinc-100)' });
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('A STAND-ALONE PAGE'), css.indexOf('/* looks:begin'));
  assert.match(hand, /:is\(\.max-w-sm, \.max-w-2xl\) \{ max-width: 504px; padding: 64px 32px 48px !important; \}/, 'the tour\'s column');
  assert.match(hand, /@media \(max-width: 767\.98px\) \{[^}]*:is\(\.max-w-sm, \.max-w-2xl\) \{ padding: 32px 16px !important; \}/);
  assert.match(hand, /#auth-login-screen svg\[role="img"\]\[aria-label="Homeroom"\] \{ display: none; \}/, 'the bar carries the brand');
  assert.match(hand, /input:not\(\[type="checkbox"\], \[type="radio"\]\) \{\s*min-height: 44px; padding: 0 12px; border-radius: 12px;\s*background: var\(--fr-ground\); box-shadow: inset 0 0 0 1px var\(--fr-line\);/, 'the kit\'s field');
  // The classes those selectors read are the forms' own.
  for (const file of ['login.tsx', 'register.tsx']) {
    assert.match(read('frontend/src/features/auth', file), /const AUTH_CARD = 'rounded-2xl bg-white dark:bg-zinc-900 overflow-hidden';/, file);
  }
});

test('in a phone browser, where the document scrolls, the screen starts under the bar by a margin', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE GUEST\'S FRAME'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-frame-chrome="guest"\]\[data-browser-scroller\^="auth-"\] body :is\([^)]*\):not\(\.hidden\) \{\s*margin-top: var\(--fr-shell-top, 0px\);/);
});
