'use strict';

// An invite's Join sheet, by the screen it opens on (Nov 2026, the
// bring-a-friend proposal): on a touch screen it stays phone-first, with
// Apple and Google under its "or", then "Sign up with email instead" and
// "Already on Homeroom? Sign in"; on a computer it opens on the email (with
// Apple and Google when they are set up), "Use a phone number instead" a
// link away. Which one is decided as the sheet opens, never in the first
// render, so the prerendered document is the same on every device. The
// phone steps themselves are pinned in tests/phone-invite-join.test.js, and
// the other sheets in tests/sign-in-sheet-flow.test.js.
//
// Run with: node --test tests/invite-join-sheet.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';

const sheet = () => loadTsx(SHEET);

function renderJoin(props = {}) {
  const { SignInSheet } = sheet();
  return renderToHtml(createElement(SignInSheet, {
    open: true, title: 'Join Best brunch spots', from: 'invite', followInvite: true,
    phone: true, providers: ['apple', 'google'], onClose() {}, primaryClass: 'pill', ...props,
  }));
}

test('the step an invite\'s Join opens on: the phone on a touch screen, the email elsewhere', () => {
  const { opensOn } = sheet();
  // Phone sign-in offered: a touch screen types the number and gets the code on the same phone.
  assert.equal(opensOn({ phone: true, touch: true, otherWays: 'choose' }), 'phone');
  assert.equal(opensOn({ phone: true, touch: true, otherWays: 'email' }), 'phone');
  // A computer: the email, with Apple and Google when they are set up (the choose step).
  assert.equal(opensOn({ phone: true, touch: false, otherWays: 'choose' }), 'choose');
  assert.equal(opensOn({ phone: true, touch: false, otherWays: 'email' }), 'email');
  // No phone sign-in, or any other sheet: its other ways, whatever the screen.
  for (const touch of [true, false]) {
    assert.equal(opensOn({ phone: false, touch, otherWays: 'choose' }), 'choose');
    assert.equal(opensOn({ phone: false, touch, otherWays: 'email' }), 'email');
  }
});

test('the step is decided as the sheet opens, from the screen it is on then', () => {
  const src = read(SHEET);
  const opened = src.slice(src.indexOf('// A fresh start each time it opens'), src.indexOf('// The step\'s first field'));
  assert.match(opened, /useEffect\(\(\) => \{\s+if \(!open\) return;\s+const opening = opensOn\(\{ \.\.\.firstStepRef\.current, touch: touchScreen\(\) \}\);\s+setOpenedOn\(opening\);\s+setSignIn\(false\);\s+setStep\(resume === 'username' \? 'username' : opening\);/);
  // The first render keeps the step it always had: the prerender has no screen to ask.
  assert.match(src, /const \[step, setStep\] = useState<Step>\(firstStep\);/);
  assert.match(src, /const \[openedOn, setOpenedOn\] = useState<OpeningStep \| null>\(null\);/);
  // touchScreen() is read in that effect and in mayFocusByCodeNow, never while rendering.
  const body = src.slice(src.indexOf('export function SignInSheet('));
  const reads = body.split('touchScreen()').length - 1;
  assert.equal(reads, 1, 'one read, in the open effect');
  // The landing still opens the Join only from a tap or a provider's way back.
  const landing = read('frontend/src/features/auth/landing.tsx');
  assert.match(landing, /useState<null \| 'join' \| 'start' \| 'signin'>\(null\)/);
  assert.match(landing, /<SignInSheet\s+open=\{sheet === 'join'\}/);
});

test('no hydration change: the first render is the same on a touch screen and a computer', (t) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const before = globalThis.window;
  t.after(() => { if (had) globalThis.window = before; else delete globalThis.window; });
  const screen = (coarse) => {
    globalThis.window = { matchMedia: (q) => ({ matches: q === '(pointer: coarse)' ? coarse : false }) };
  };
  screen(true);
  const touch = renderJoin();
  screen(false);
  const desktop = renderJoin();
  assert.equal(touch, desktop, 'nothing in the first render asks the screen');
  assert.match(desktop, /data-sign-in-sheet="phone"/, 'the markup the sheet always shipped first');
  // Closed, as the landing renders it until Join is pressed: nothing at all.
  const { SignInSheet } = sheet();
  assert.equal(renderToHtml(createElement(SignInSheet, {
    open: false, title: 'Join Best brunch spots', from: 'invite', phone: true, providers: ['google'], onClose() {}, primaryClass: 'pill',
  })), '');
});

test('the links under each step of the Join, and where each goes', () => {
  const { inviteWays, inviteWayTarget } = sheet();
  // On the phone: the email for a new account, the way in for one made before.
  assert.deepEqual(inviteWays('phone', false), ['email-signup', 'sign-in']);
  // The email ways while making an account: the phone, and the way in.
  assert.deepEqual(inviteWays('choose', false), ['phone', 'sign-in']);
  assert.deepEqual(inviteWays('email', false), ['phone', 'sign-in']);
  // Signing in: back to making one.
  assert.deepEqual(inviteWays('choose', true), ['sign-up']);
  assert.deepEqual(inviteWays('email', true), ['sign-up']);
  for (const step of ['code', 'phone-code', 'password', 'forgot', 'account', 'username', 'link']) {
    assert.deepEqual(inviteWays(step, false), [], step);
  }
  // "Sign up with email instead": the email step, making a NEW account.
  assert.deepEqual(inviteWayTarget('email-signup', 'phone'), { step: 'email', signIn: false });
  // "Already on Homeroom? Sign in": the email step, signing an account in.
  for (const opened of ['phone', 'choose', 'email']) {
    assert.deepEqual(inviteWayTarget('sign-in', opened), { step: 'email', signIn: true });
    assert.deepEqual(inviteWayTarget('phone', opened), { step: 'phone', signIn: false });
    // "New to Homeroom? Sign up": the step it opened on.
    assert.deepEqual(inviteWayTarget('sign-up', opened), { step: opened, signIn: false });
  }
  // The sheet follows the table: every link sets signing in, then the step.
  const src = read(SHEET);
  assert.match(src, /const takeWay = \(way: InviteWay\) => \{\s+const to = inviteWayTarget\(way, startStep\);\s+setSignIn\(to\.signIn\);\s+toStep\(to\.step\);\s+\};/);
  assert.match(src, /const ways = phone \? inviteWays\(step, signIn\) : \[\];/);
  assert.equal((src.match(/\{ways\.map\(wayLine\)\}/g) || []).length, 3, 'the choose, email and phone steps');
});

test('signing in is the email with the Email code | Password switch; making an account says the terms', () => {
  const { firstStepLine, hasMethodSwitch } = sheet();
  // Making an account from the Join: the terms under the email, no switch.
  assert.equal(firstStepLine('invite', false), 'terms');
  assert.equal(hasMethodSwitch('email', 'invite', false), false);
  // "Already on Homeroom? Sign in": the switch, and "Use a password" under the choose step.
  assert.equal(firstStepLine('invite', true), 'password');
  assert.equal(hasMethodSwitch('email', 'invite', true), true);
  assert.equal(hasMethodSwitch('password', 'invite', true), true);
  // The other sheets are as they were.
  for (const from of ['story', 'signin']) {
    assert.equal(firstStepLine(from), 'password');
    assert.equal(hasMethodSwitch('email', from), true);
  }
  const src = read(SHEET);
  assert.match(src, /const methodSwitch = hasMethodSwitch\(step, from, signIn\);/);
  assert.match(src, /const emailFoot = firstStepLine\(from, signIn\) === 'terms' \? <TermsNotice \/> : null;/);
  assert.equal(hasMethodSwitch('choose', 'signin'), true);
  assert.equal(hasMethodSwitch('choose', 'invite'), false);
  // The choose step says it is for an account made before only when signing in.
  assert.match(src, /: step === 'choose'\s+\? \(signIn \? t\('auth:signInSheet\.choose\.lead'\) : ''\)/);
});

test('the links as they are drawn: words, ids and order', () => {
  const { InviteWayLink } = sheet();
  const draw = (way) => renderToHtml(createElement(InviteWayLink, { way, onTake() {} }));
  assert.match(draw('email-signup'), /^<button type="button" data-sign-in-sheet-to-email-signup="" class="py-1 text-\[15px\] font-medium text-violet-700[^"]*">Sign up with email instead<\/button>$/);
  assert.match(draw('phone'), /^<button type="button" data-sign-in-sheet-to-phone=""[^>]*>Use a phone number instead<\/button>$/);
  assert.match(draw('sign-in'), /^<p class="text-center text-\[13px\] text-zinc-500 dark:text-zinc-400">Already on Homeroom\? <a href="#login" data-sign-in-sheet-to-email=""[^>]*>Sign in<\/a><\/p>$/);
  assert.match(draw('sign-up'), /^<p class="text-center text-\[13px\] text-zinc-500 dark:text-zinc-400">New to Homeroom\? <button type="button" data-sign-in-sheet-to-signup=""[^>]*>Sign up<\/button><\/p>$/);
  // On a touch screen, under the phone step's "or" and its Apple and Google.
  const phone = renderJoin();
  const at = (needle) => { const i = phone.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at('>Continue with Google<') < at('>Sign up with email instead<'));
  assert.ok(at('>Sign up with email instead<') < at('Already on Homeroom? <a'));
  assert.ok(at('Already on Homeroom? <a') < at('data-terms-notice='));
  // The catalog's words, and no dash in any of them.
  assert.equal(message('auth:signInSheet.invite.signUpWithEmail'), 'Sign up with email instead');
  assert.equal(message('auth:signInSheet.invite.haveAccount'), 'Already on Homeroom? <0>Sign in</0>');
  assert.equal(message('auth:signInSheet.invite.newHere'), 'New to Homeroom? <0>Sign up</0>');
  assert.equal(message('auth:signInSheet.toPhoneLink'), 'Use a phone number instead');
  for (const html of [phone, draw('sign-up'), draw('phone')]) assert.doesNotMatch(html, /—/);
});

test('only the invite\'s Join changes: the landing\'s sheets keep their phone link and its way back', () => {
  const { SignInSheet } = sheet();
  const landing = (props) => renderToHtml(createElement(SignInSheet, {
    open: true, title: 'Continue to Homeroom', from: 'story', phoneLink: true, askName: false,
    providers: ['google'], onClose() {}, primaryClass: 'pill', ...props,
  }));
  const html = landing();
  assert.match(html, /data-sign-in-sheet="choose"/);
  assert.match(html, /data-sign-in-sheet-to-phone=""[^>]*>Use a phone number instead<\/button>/);
  assert.doesNotMatch(html, /Sign up with email instead|Already on Homeroom\? <a|New to Homeroom\?/);
  assert.match(html, /data-sign-in-sheet-method-password=""/, 'Password is offered before a code is sent');
  // Its phone step keeps "Already on Homeroom? Sign in with email" (the phone-step source).
  const src = read(SHEET);
  assert.match(src, /\{step === 'phone' && !phone \? \(\s+<p className="mt-4 text-center text-\[13px\] text-zinc-500 dark:text-zinc-400">\s+<RichMessage id="auth:signInSheet\.phone\.haveAccount"/);
  assert.equal(message('auth:signInSheet.phone.haveAccount'), 'Already on Homeroom? <0>Sign in with email</0>');
  // An invite with no phone sign-in is the email sheet it was.
  const bare = renderJoin({ phone: false, providers: [] });
  assert.match(bare, /data-sign-in-sheet="email"/);
  assert.doesNotMatch(bare, /Already on Homeroom|Use a phone number|Sign up with email/);
});
