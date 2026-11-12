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

test('a members\' address a visitor opened: the bar names the place, in the brand\'s place or after it', () => {
  // Version 2 of the looks (o12 to o25): the sheet opens by itself, as in
  // the standard look, and the bar says where the link led.
  const messages = view({ crumb: 'Messages', actions: [SIGN_IN, SIGN_UP] });
  assert.match(messages, /<header class="fr-bar"><div class="fr-crumb"><span class="fr-ci fr-here fr-keep">Messages<\/span><\/div><span class="fr-sp"><\/span>/);
  assert.doesNotMatch(messages, /fr-brand/);
  const workshop = view({ trail: ['Workshop'] });
  assert.match(workshop, /Homeroom<\/span><div class="fr-crumb"><span class="fr-ci fr-here fr-keep">Workshop<\/span><\/div>/, 'a project\'s place follows the brand');
  const request = view({ trail: ['Workshop', 'Request #5998'] });
  assert.match(request, /<div class="fr-crumb"><span class="fr-ci">Workshop<\/span><svg[^>]*>.*?<\/svg><span class="fr-ci fr-here fr-keep">Request #5998<\/span><\/div>/s, 'the last word is where you are: the one a phone keeps');
  const tab = view({ back: true, crumb: 'Game Corner', trail: ['Workshop'] });
  assert.match(tab, /<span class="fr-ci">Game Corner<\/span><svg[^>]*>.*?<\/svg><span class="fr-ci fr-here fr-keep">Workshop<\/span>/s, 'a public project\'s tab, after its name');
  const src = read(CHROME);
  assert.match(src, /root\.querySelectorAll\('#landing-header \[data-guest-place\]'\)/, 'read off the landing\'s own header, which the bar already follows');
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /\{frame && gate \? <GatePlace target=\{gate\.target\} \/> : null\}/, 'under a look only, never in the first render');
});

test('it is up for a visitor only: under a look, while an anonymous screen is, and never on the first render', () => {
  const src = read(CHROME);
  assert.equal(renderComponent(CHROME, 'GuestFrame', {}, { cache: false, stubs: { '../../lib/visibility-store': { useVisibility: (id, initial) => initial } } }), '');
  assert.match(src, /const SCREENS = \['auth-landing-screen', 'auth-login-screen', 'auth-register-screen', 'auth-waitlist-screen', 'auth-more-screen', 'auth-waiting-screen'\] as const;/,
    'the anonymous shell\'s six screens: an account still in line has no member\'s chrome to be shown');
  assert.match(src, /if \(!isFrameSkin\(skin\)\) return null;\s*if \(at > -1\) return <GuestChrome screen=\{SCREENS\[at\]\} \/>;\s*return profile \? <GuestChrome screen=\{PROFILE\} \/> : null;/, 'an anonymous screen first; else a profile opened with nobody let in');
  assert.match(read('frontend/src/features/frame/frame-app.tsx'), /return on \? <FrameChrome \/> : <GuestFrame \/>;/, 'one or the other, never both');
  assert.match(src, /root\.setAttribute\('data-frame-chrome', 'guest'\);/, 'app.css knows which chrome is up');
});

test('a press is handed to the screen\'s own control, and the bar follows the screen\'s own header', () => {
  const src = read(CHROME);
  assert.match(src, /onBack=\{\(\) => pressIn\(screen, screen === 'auth-landing-screen' \? '#landing-back-btn' : SOLO_BACK\)\}/);
  assert.match(src, /const SOLO_BACK = '\[data-auth-back\], :scope > a\[href="#landing"\]';/, 'the shared disc, or the plain link "more ways" has');
  assert.match(read('frontend/src/features/auth/more.tsx'), /<a\s+href="#landing"\s+className="fixed start-4 z-10 /);
  assert.match(src, /pressIn\(screen, '\[data-landing-actions\] button', Number\(action\.key\)\)/, 'the landing\'s own button, by its place in the bar');
  assert.match(src, /crumb: title && !title\.querySelector\('svg'\) \? \(title\.textContent \|\| ''\)\.trim\(\) : words\('head'\)\[0\] \|\| '',/, 'the wordmark is a picture, a name is words; else the place the landing names');
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
  for (const id of ['auth-landing-screen', 'auth-login-screen', 'auth-register-screen', 'auth-waitlist-screen', 'auth-more-screen', 'auth-waiting-screen']) {
    assert.ok(block.includes(`html[data-frame-chrome="guest"] #${id}`), id);
  }
  assert.match(block, /top: var\(--fr-shell-top, 0px\);[^}]*inset-inline-start: var\(--fr-shell-left, 0px\);[^}]*background: none;/);
  assert.match(block, /html\[data-frame-chrome="guest"\] #landing-header,\s*html\[data-frame-chrome="guest"\] \[data-auth-back\],\s*html\[data-frame-chrome="guest"\] #auth-more-screen > a\[href="#landing"\] \{ display: none; \}/);
  assert.match(block, /html\[data-skin\] \.fr\.fr-app\.fr-shell\[data-frame-app="guest"\] \{ z-index: 41; \}/, 'over the anonymous screens (40), under their sheets and the install strip (45)');
  // The sign-in sheet lives inside the screen that opened it (40), so the
  // chrome at 41 stayed lit over the sheet's dimming: while one is up the
  // chrome goes under the screens and is dimmed with the page.
  assert.match(block, /html\[data-frame-chrome="guest"\]:has\(\[data-sign-in-sheet\]\) \.fr\.fr-app\.fr-shell\[data-frame-app="guest"\] \{ z-index: 39; \}/);
  assert.match(read('frontend/src/features/auth/sign-in-sheet.tsx'), /<div data-sign-in-sheet=\{step\}[^>]*className="fixed inset-0 z-50">/, 'the node the rule reads is there only while the sheet is');
});

test('a stand-alone page is the kit\'s one column: the product\'s own form, wearing the title, the card and the button', () => {
  // Sign-in, register, the waitlist form and "more ways" (the tour's o07 to
  // o11) keep their forms and every step in them; the look reaches them
  // through the wear map, and app.css gives them the column and the field.
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  const AUTH = ':is(#auth-login-screen,#auth-register-screen,#auth-waitlist-screen,#auth-more-screen)';
  assert.ok(looks.wear.roots.title.to.includes(' h1'));
  assert.ok(looks.wear.roots.card.to.includes(`:is(${AUTH},[data-sign-in-sheet]) .rounded-2xl.overflow-hidden`));
  assert.ok(looks.wear.roots.btn.to.includes(`${AUTH} :is(button,a):is(.bg-violet-600,.rounded-full:is(.bg-white,.bg-zinc-100)):not([data-auth-back])`),
    'the one accent-filled control is the primary button; a white or grey pill is a quiet one');
  assert.deepEqual(looks.wear.roots.btn.parts, { quiet: ':is(.bg-white,.bg-zinc-100)' });
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('A STAND-ALONE PAGE'), css.indexOf('/* looks:begin'));
  assert.match(hand, /:is\(\.max-w-sm, \.max-w-2xl\) \{ max-width: 504px; padding: 64px 32px 48px !important; \}/, 'the tour\'s column');
  assert.match(hand, /@media \(max-width: 767\.98px\) \{[^}]*:is\(\.max-w-sm, \.max-w-2xl\) \{ padding: 32px 16px !important; \}/);
  assert.match(hand, /#auth-login-screen svg\[role="img"\]\[aria-label="Homeroom"\] \{ display: none; \}/, 'the bar carries the brand');
  // The field is the look's own, by the wear map (each look says its field's
  // fill, ring and corners; a hand-set ground was a cream box on Paper's white).
  assert.doesNotMatch(hand.slice(0, hand.indexOf('/* Version 2 (11 Nov 2026) lays')).replace(/\/\*[\s\S]*?\*\//g, ''), /input[^{]*\{[^}]*background:/, 'no hand-set field');
  const field = [looks.wear.roots.inp, ...looks.wear.roots.inp.also].find((w) => w.to.includes('#auth-login-screen'));
  assert.ok(field && field.to.includes(':is(:is(#auth-login-screen,#auth-register-screen,#auth-waitlist-screen,#auth-more-screen),[data-sign-in-sheet]) .rounded-2xl.overflow-hidden input:not([type="checkbox"],[type="radio"])'), 'the kit\'s field');
  for (const id of ['#recovery-email-input', '#waitlist-confirm-email']) assert.ok(field.to.includes(id), id);
  assert.deepEqual(field.parts, { val: '', focus: ':focus' });
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

test('the sign-in sheet is the kit\'s sheet: the look\'s surface, title, field and button around the product\'s own steps', () => {
  // The tour's o04 to o06. The sheet keeps every step it has (a code by
  // email or by text, a password, a reset, Apple and Google, a username)
  // and where it stands on the screen; what it is drawn with is the look's.
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.ok(looks.wear.roots.btn.to.includes('[data-sign-in-sheet] [role="dialog"] button.bg-violet-600'), 'its one primary button; Apple\'s and Google\'s keep their own faces');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE SIGN-IN SHEET'), css.indexOf('/* looks:begin'));
  assert.ok(css.includes('THE SIGN-IN SHEET'));
  assert.match(hand, /\[data-sign-in-sheet\] > \[role="dialog"\] \{[^}]*background: var\(--fr-solid, var\(--fr-ground\)\);[^}]*box-shadow: var\(--fr-sh\), inset 0 0 0 1px var\(--fr-line\);/);
  assert.match(hand, /#sign-in-sheet-title \{ font-size: 24px; line-height: 1\.15; font-weight: 700; letter-spacing: -0\.02em; color: var\(--fr-ink\); \}/);
  assert.match(hand, /\[data-sign-in-sheet-method\]:not\(\.fr-tabs\) \{ background: var\(--fr-sunk\); \}/, 'the two ways are the look\'s own switch (the kit\'s tabs on the three steps laid out as the kit\'s sheet: tests/sign-in-sheet-kit.test.js)');
  const sheet = read('frontend/src/features/auth/sign-in-sheet.tsx');
  for (const hook of ['data-sign-in-sheet={step}', 'role="dialog"', 'id="sign-in-sheet-title"', 'data-sign-in-sheet-method=""', 'role="radio"']) assert.ok(sheet.includes(hook), hook);
});

test('the waiting room is a stand-alone page whose bar says whose it is and holds Sign out', () => {
  // The tour's w01 and w02. The room keeps everything it does (the two
  // questions, the invite box, the check that lets the account in).
  const html = view({ who: 'tourwaitlist1106', actions: [{ key: 'logout', label: 'Sign out', primary: false, pressed: null }] });
  assert.match(html, /<span class="fr-sp"><\/span><div class="fr-crumb"><span class="fr-ci fr-here fr-keep"><span class="fr-av"[^>]*>t<\/span><span class="fr-d">@tourwaitlist1106<\/span><\/span><\/div><button type="button" class="fr-btn fr-line fr-sm">Sign out<\/button><\/header>/);
  const src = read(CHROME);
  assert.match(src, /action\.key === 'logout' \? pressIn\(screen, '#waiting-logout'\)/, 'the room\'s own Sign out does it');
  assert.match(read('frontend/src/features/auth/waiting.tsx'), /id="waiting-logout"/);
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE WAITING ROOM'), css.indexOf('/* looks:begin'));
  assert.ok(css.includes('THE WAITING ROOM'));
  assert.match(hand, /#auth-waiting-screen > \.max-w-sm \{ max-width: 504px; padding: 64px 32px 48px; text-align: start; \}/);
  assert.match(hand, /html\[data-frame-chrome="guest"\] #waiting-logout \{ display: none; \}/, 'said once, in the bar');
  // Look around is the one primary button, and the look's own: worn (looks.json,
  // btn), never a hand-set accent, which Sunrise's gradient could not reach.
  assert.doesNotMatch(hand.slice(0, hand.indexOf('/* THE SIGN-IN SHEET')), /\[data-waiting-look-around\] \{[^}]*background:/, 'no hand-set fill on Look around');
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.ok(looks.wear.roots.card.to.includes('#auth-waiting-screen :is([data-waiting-queued],[data-waiting-invite])'));
  assert.ok(looks.wear.roots.title.to.includes('#auth-waiting-screen'));
});

test('version 2: a stand-alone page reads title, fields, the other ways as rows, the primary button last; by CSS alone, the nodes do not move', () => {
  // The tour's o07 to o11. The forms' nodes and ids are in the shell
  // baseline and the declared checks, so no id moves. The two real forms keep
  // their box (an older Safari drops a `display: contents` form from the
  // accessibility tree): the ways that stood after each are its last child,
  // in a neutral wrapper, and `order` places the form's own children.
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('Version 2 (11 Nov 2026) lays each stand-alone page out'), css.indexOf('/* THE WAITING ROOM'));
  assert.ok(hand.length > 0);
  const G = 'html\\[data-frame-chrome="guest"\\]';
  const has = (re, why) => assert.match(hand, new RegExp(re.replace(/G /g, `${G} `)), why);
  // o07 Sign in.
  has('G #login-form \\{ gap: 0; margin-top: 0; \\}', 'the form is the column: its own gap gives way to each seam\'s figure');
  has('G #login-form > \\.auth-ways \\{ order: 3; margin-top: 24px; \\}\\s*G #auth-login-screen #forgot-link-wrap \\{ margin-top: 0; \\}\\s*G #auth-login-screen #otp-link-wrap \\{ margin-top: -1px; \\}\\s*G #login-form > button\\[type="submit"\\] \\{ order: 5; margin-top: 24px; \\}\\s*G #login-form > p \\{ order: 6;', 'the two ways over Sign in, the terms after it');
  has('G #auth-login-screen #forgot-password-link \\{ border-end-start-radius: 0; border-end-end-radius: 0; \\}\\s*G #auth-login-screen #otp-link \\{ border-start-start-radius: 0; border-start-end-radius: 0; \\}', 'two rows of one card');
  // o09 Sign in with email, its first step only.
  has('G #otp-step-email:not\\(\\.hidden\\) \\{ display: contents; \\}');
  has('G #otp-view:has\\(> #otp-step-email:not\\(\\.hidden\\)\\) > #btn-otp-back \\{ order: 3;', 'the way back to a password is a row over the button; the code and account steps keep theirs');
  has('G #otp-step-email > #btn-otp-request \\{ order: 4;');
  // o08 Reset your password.
  has('G #recovery-email:not\\(\\.hidden\\) \\{ display: contents; \\}');
  has('G #recovery-admin \\{ order: 3; \\}\\s*G #recovery-admin > hr \\{ display: none; \\}\\s*G #recovery-admin > div \\{[^}]*background: var\\(--fr-wait-t\\); color: var\\(--fr-wait\\);', 'the warning is the kit\'s note');
  has('G #auth-login-screen #btn-recovery-back \\{ order: 4; \\}\\s*G #recovery-email > #btn-email-reset \\{ order: 5;', 'Back to login as a row, the button last');
  // o10 Register.
  has('G #register-form \\{ display: flex; flex-direction: column; \\}');
  has('G #auth-register-screen h1 \\+ p \\+ p \\{[^}]*font-size: 15px; font-weight: 650; color: var\\(--fr-ink\\); \\}', '"Create your account" is the form\'s own heading');
  has('G #register-form > \\.auth-ways \\{ order: 3; \\}\\s*G #register-form > \\.auth-ways > p \\{ margin-top: 24px; \\}\\s*G #register-form > button\\[type="submit"\\] \\{ order: 4;');
  // No real form steps aside: only the two <div> steps do, which have no role to lose.
  const rules = hand.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual((rules.match(/[^{}]*\{ display: contents; \}/g) || []).map((r) => r.trim().replace('html[data-frame-chrome="guest"] ', '')),
    ['#otp-step-email:not(.hidden) { display: contents; }', '#recovery-email:not(.hidden) { display: contents; }']);
  // The wrappers: the form's last child, neutral in the standard look (each
  // takes back the one gap the form would put before it), with no id.
  const loginSrc = read('frontend/src/features/auth/login.tsx');
  assert.match(loginSrc, /<TermsNotice verb="signing in" \/>[\s\S]*?<div className="auth-ways -mt-4">\s*<p id="forgot-link-wrap" className=\{hiddenLast\(!base, 'mt-2\.5'\)\}>[\s\S]*?<p id="otp-link-wrap" className=\{hiddenLast\(!base, 'mt-2\.5'\)\}>[\s\S]*?<\/p>\s*<\/div>\s*<\/form>/);
  assert.match(read('frontend/src/features/auth/register.tsx'), /<div className="auth-ways !mt-0">\s*<p className="mt-3">\s*<a href="#login" className=\{PILL_LINK\}>[\s\S]*?<\/p>\s*<\/div>\s*<\/form>/);
  for (const line of read('public/css/app.css').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => l.includes('.auth-ways'))) {
    assert.ok(line.startsWith('html[data-frame-chrome="guest"] '), `nothing dresses the wrapper outside a look: ${line.slice(0, 80)}`);
  }
  // o11 Check your status.
  has('G #waitlist-confirm-address::before \\{ content: \'\'; grid-area: 1 / 1 / span 3 / auto;[^}]*background: var\\(--fr-surface\\);', 'the card is drawn behind the label, the field and its hint');
  has('G #waitlist-confirm-address > #waitlist-request-code \\{ grid-row: 4;');
  has('G #waitlist-have-code \\{[^}]*background: var\\(--fr-sunk\\);', 'the quiet button under the primary one');
  assert.doesNotMatch(hand.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(|margin-(left|right)|padding-(left|right)|border-(top|bottom)-(left|right)-radius/, 'the kit\'s tokens and logical sides only');
  // The ids those rules read are the forms' own.
  const login = read('frontend/src/features/auth/login.tsx');
  for (const id of ['login-form', 'forgot-link-wrap', 'forgot-password-link', 'otp-link-wrap', 'otp-link', 'otp-view', 'otp-step-email', 'btn-otp-request', 'btn-otp-back', 'recovery-view', 'recovery-email', 'recovery-email-input', 'recovery-admin', 'btn-recovery-back', 'btn-email-reset']) {
    assert.match(login, new RegExp(`id="${id}"`), id);
  }
  assert.match(read('frontend/src/features/auth/register.tsx'), /id="register-form"/);
  const waitlist = read('frontend/src/features/auth/waitlist.tsx');
  for (const id of ['waitlist-confirm-address', 'waitlist-confirm-email', 'waitlist-request-code', 'waitlist-have-code']) assert.match(waitlist, new RegExp(`id="${id}"`), id);
  // The reset view's heading is not the screen's h1: it wears the title as a further wearer.
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  const title = looks.wear.roots.title;
  assert.ok([title.to, ...(title.also || []).map((w) => w.to)].includes('#auth-login-screen #recovery-view > h2'));
  has('G #recovery-view > h2 \\{ margin: 0 0 -4px; text-align: start; \\}');
});

test('version 2: in the waiting room Look around goes last and the invite card\'s title is the label over it', () => {
  // The tour's w01 and w02 (and w04 to w09 and w14, which the router sends
  // to this room). No account in line can be made on a local copy, so this
  // is held here and by the room's own suites.
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('/* THE WAITING ROOM'), css.indexOf('/* THE SIGN-IN SHEET (features'));
  assert.match(hand, /html\[data-frame-chrome="guest"\] #auth-waiting-screen \[data-waiting-look-around\] \{ order: 9; margin-top: 24px; \}/);
  assert.match(hand, /\[data-waiting-invite\] \{ position: relative; overflow: visible !important; margin-top: 56px; \}/);
  assert.match(hand, /\[data-waiting-invite\] > h2 \{ position: absolute; inset-block-end: 100%; inset-inline-start: 4px; margin: 0 0 8px; \}/);
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  const wearers = (root) => [looks.wear.roots[root], ...(looks.wear.roots[root].also || [])];
  assert.ok(wearers('cap').map((w) => w.to).includes('#auth-waiting-screen [data-waiting-invite] > h2'), 'the kit\'s label, whatever the look');
  // Every control of the room is the look's own (the visual pass found the
  // "Two quick questions" card, Join and Look around in the standard look's
  // dress): worn, so each look's button, field and card reach them.
  const btn = wearers('btn').find((w) => w.to.includes('[data-waiting-look-around]'));
  assert.ok(btn, 'the room\'s buttons are a wearer of btn');
  for (const piece of ['a[data-waiting-look-around][href="#apps"]', 'form[data-waiting-invite] button[type="submit"]', '#waiting-about-save', '#waiting-about-discovery > button', '#auth-landing-screen [data-landing-invite-dead-continue]']) assert.ok(btn.to.includes(piece), piece);
  assert.deepEqual(btn.parts, { quiet: '.bg-zinc-100', block: ':is([data-waiting-look-around],[data-landing-invite-dead-continue])', sm: ':is(#waiting-about-discovery > *)', off: ':disabled' },
    'a choice not taken is the quiet small button, the chosen one the look\'s primary; Look around and Continue fill the column; Save and Join dim until they can be pressed');
  assert.ok(wearers('card').map((w) => w.to).includes('form[data-waiting-about="ask"]'), 'the questions\' card');
  assert.ok(wearers('cap').map((w) => w.to).includes('form[data-waiting-about="ask"] > h2'), 'its title is the label over it, as the invite card\'s is');
  assert.ok(wearers('link').map((w) => w.to).includes('#waiting-about-skip'), 'Skip is the look\'s link');
  const inp = wearers('inp').find((w) => w.to.includes('#waiting-about-country'));
  assert.ok(inp && inp.to.includes('form[data-waiting-invite] input[type="url"]'), 'the country and the invite\'s field are the look\'s field');
  assert.match(hand, /\[data-waiting-about="ask"\] \{ position: relative; overflow: visible !important; margin-top: 56px; \}/);
  assert.match(hand, /#auth-waiting-screen h1 \+ p > strong \{ word-break: normal; overflow-wrap: anywhere; color: var\(--fr-ink\); \}/, 'the address is not cut mid-word');
  assert.doesNotMatch(hand.replace(/\/\*[\s\S]*?\*\//g, ''), /\[data-waiting-invite\] input \{[^}]*background:/, 'no hand-set field');
  const about = read('frontend/src/features/auth/waiting-about.tsx');
  for (const hook of ['data-waiting-about="ask"', 'id="waiting-about-country"', 'id="waiting-about-discovery"', 'id="waiting-about-save"', 'id="waiting-about-skip"']) assert.ok(about.includes(hook), hook);
  const room = read('frontend/src/features/auth/waiting.tsx');
  assert.match(room, /components=\{\[<strong className="break-all /, 'the standard room\'s own breaking is untouched');
  assert.match(room, /className="mx-auto flex min-h-full w-full max-w-sm flex-col /, 'the room\'s column is a flex column, which `order` needs');
  assert.match(room, /<form\s+data-waiting-invite=""[\s\S]*?<h2 className="[^"]*">\{t\('auth:waiting\.invite\.title'\)\}<\/h2>/);
});

test('a profile opened signed out: the bar names it and holds the two ways in, and the page is its one line', () => {
  // The tour's o26. Today a visitor's #profile/<name> answers "This profile
  // is unavailable." under the member's chrome; under a look it is the
  // guest's bar, since the frame's own chrome needs somebody let in.
  const html = view({ crumb: '@evan', actions: [{ key: 'signin', label: 'Sign in', primary: false, pressed: null }, { key: 'signup', label: 'Sign up', primary: true, pressed: null }] });
  assert.match(html, /<header class="fr-bar"><div class="fr-crumb"><span class="fr-ci fr-here fr-keep">@evan<\/span><\/div><span class="fr-sp"><\/span><button type="button" class="fr-btn fr-line fr-sm">Sign in<\/button><span class="fr-d"><button type="button" class="fr-btn fr-sm">Sign up<\/button><\/span><\/header>/);
  const src = read(CHROME);
  assert.match(src, /const profile = useVisibility\(PROFILE, false\);/, 'one more hook, every render');
  assert.match(src, /const PROFILE = 'profile-screen';/);
  assert.match(src, /crumb: name \? `@\$\{name\}` : '',\s*actions: who \? \[\] : \[/, 'an account still in line is signed in already: its name, no ways in');
  assert.match(src, /if \(screens\?\.showSignInFor\) screens\.showSignInFor\(location\.hash\);/, 'Sign in is the landing\'s sheet over the page asked for, which signing in lands on');
  assert.match(src, /action\.key === 'signup' \? \(location\.hash = '#landing'\)/, 'Sign up is the landing, where the way in for somebody new is');
  assert.match(read('public/js/auth-screens.js'), /showSignInFor\(fullHash\) \{/);
  const profile = read('frontend/src/features/profile/profile-view.tsx');
  assert.match(profile, /if \(frame\) return <div className=\{k\('lone'\)\} data-profile-unavailable="">\{t\('profile:public\.unavailable'\)\}<\/div>;/, 'the kit\'s lone line');
  assert.ok(profile.indexOf("data-profile-unavailable") < profile.indexOf('className="text-sm text-zinc-500 py-12 text-center'), 'ahead of the standard line, which stands under the standard look');
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-frame-chrome="guest"\]:has\(:is\(#auth-landing-screen, #auth-login-screen, #auth-register-screen, #auth-waitlist-screen, #auth-more-screen, #auth-waiting-screen\):not\(\.hidden\)\) #profile-screen \{ display: none; \}/, 'not under the landing its Sign in brings up');
});

test('a dead invite link is a stand-alone page: the welcome over the title, what to do, one button across the column', () => {
  // The tour's o27, every reason a link can be dead for. The section's
  // nodes are the product's; the picture is not drawn.
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('/* A dead invite link'), css.indexOf('/* THE WAITING ROOM'));
  assert.ok(hand.length > 0);
  assert.match(hand, /\[data-landing-invite="dead"\] \{ flex-grow: 0; align-items: stretch; justify-content: flex-start; max-width: 504px; margin-inline: auto; padding: 64px 32px 48px; text-align: start; \}/, 'the stand-alone column');
  assert.match(hand, /\[data-landing-invite="dead"\] > img \{ display: none; \}/);
  // The title and the button are the look's own (Sunrise's gradient): worn, not set by hand.
  assert.doesNotMatch(hand.replace(/\/\*[\s\S]*?\*\//g, ''), /data-landing-invite-dead-continue|font-size: 28px/);
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.ok([looks.wear.roots.title.to, ...looks.wear.roots.title.also.map((w) => w.to)].includes('#auth-landing-screen [data-landing-invite="dead"] > h1'), 'the look\'s title');
  assert.ok(looks.wear.roots.btn.also.some((w) => w.to.includes('#auth-landing-screen [data-landing-invite-dead-continue]') && w.parts.block.includes('[data-landing-invite-dead-continue]')), 'the look\'s button, across the column');
  assert.ok([looks.wear.roots.cap.to, ...(looks.wear.roots.cap.also || []).map((w) => w.to)].includes('#auth-landing-screen [data-landing-invite="dead"] > img + div'), '"Welcome to Homeroom" is the kit\'s label');
  const card = read('frontend/src/features/auth/invite-card.tsx');
  assert.match(card, /<section data-landing-invite="dead" className="[^"]*flex grow flex-col[^"]*">/);
  assert.match(card, /<div className=\{`mt-4 \$\{SMALL_CAPS\}`\}>\{t\('auth:story\.welcome'\)\}<\/div>\s*<h1 data-landing-invite-dead-title=""/);
  assert.match(card, /<a href="\/" data-landing-invite-dead-continue="" className=\{primaryClass\}>/);
});
