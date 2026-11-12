// The sign-in sheet under a look (frontend/src/features/auth/sign-in-sheet
// .tsx, its kit branch): version 2 of the screen tour's o04, o04b, o04c, o05
// and o06. The first step, the email step, the phone step and the password
// step are laid out as the kit's sheet: the field in a card, the other ways
// as rows in one card under "or", the one primary button last, the terms as
// the foot.
// It is a branch of the sheet's own render, inside the sheet's own shell
// (dim, cover, panel, title and close): the same fields, ids, refs, handlers
// and data-sign-in-* hooks. The other steps, and every step under the
// standard look, are the standard render.
//
// Run with: node --test tests/sign-in-sheet-kit.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';
const SRC = read(SHEET);
const KIT = SRC.slice(SRC.indexOf('// THE KIT BRANCH'));

const under = (skin) => ({ cache: false, stubs: { '../../lib/skin': { isFrameSkin: (s) => s !== 'standard', useLiveSkin: () => skin } } });
const sheet = (skin, props) => {
  const { SignInSheet } = loadTsx(SHEET, under(skin));
  return renderToHtml(createElement(SignInSheet, { open: true, title: 'Sign in', from: 'signin', providers: ['apple', 'google'], onClose() {}, primaryClass: 'pill', ...props }));
};
const order = (html, marks) => marks.map((m) => html.indexOf(m));
const rising = (list) => list.every((n, i) => n > -1 && (i === 0 || n > list[i - 1]));

test('the first step in the kit\'s order: the field, the other ways as rows under "or", the primary button, the terms', () => {
  const html = sheet('glass', { phoneLink: true });
  assert.match(html, /^<div data-sign-in-sheet="choose" class="fixed inset-0 z-50">/);
  assert.match(html, /<\/h2><button type="button" aria-label="Close"[^>]*>.*?<\/button><\/div><div data-sign-in-sheet-kit=""><div class="mt-4"><div role="radiogroup"/s, 'inside the sheet\'s own panel, under its own title and close');
  assert.ok(rising(order(html, ['id="sign-in-sheet-title"', 'data-sign-in-sheet-method=""', 'id="sign-in-sheet-email"', 'data-sign-in-sheet-or=""', 'data-sign-in-provider="apple"', 'data-sign-in-provider="google"', 'data-sign-in-sheet-to-phone=""', 'data-sign-in-provider="email"', 'By continuing'])), 'the kit sheet\'s order');
  assert.match(html, /<section class="fr-sec"><div class="fr-sechead" data-sign-in-sheet-or=""><h3 class="fr-cap">or<\/h3><\/div><div class="fr-card"><button type="button" data-sign-in-provider="apple" class="fr-row fr-sm"><span class="fr-lead" aria-hidden="true"><svg.*?<\/svg><\/span><span class="fr-tx"><span class="fr-t">Continue with Apple<\/span><\/span><\/button><button type="button" data-sign-in-provider="google" class="fr-row fr-sm">.*?Continue with Google<\/span><\/span><\/button><button type="button" data-sign-in-sheet-to-phone="" class="fr-row fr-sm">.*?Use a phone number instead<\/span><\/span><\/button><\/div><\/section>/s,
    'one card of single-line rows, each the sheet\'s own button with its hook');
  assert.match(html, /<button type="submit" data-sign-in-provider="email" data-sign-in-email-empty="" class="fr-btn fr-block fr-off">Continue with email<\/button><\/form>/, 'dimmed until an address is typed, and still pressable');
  assert.doesNotMatch(html.match(/<button type="submit" data-sign-in-provider="email"[^>]*>/)[0], /\sdisabled/);
  // The switch is the product's computed state (the bar's Sign in has it on the first step too): drawn as the kit's tabs.
  assert.match(html, /<div role="radiogroup" aria-label="[^"]+" data-sign-in-sheet-method="" class="fr-tabs fr-seg"><button type="button" role="radio" aria-checked="true" data-sign-in-sheet-method-email="" class="fr-tab fr-on">Email code<\/button><button type="button" role="radio" aria-checked="false" data-sign-in-sheet-method-password="" class="fr-tab">Password<\/button><\/div>/);
  assert.doesNotMatch(html, /<p class="mt-1 /, 'no sentence under the title, as today');
  // The shell is the sheet's own.
  for (const hook of ['role="dialog"', 'aria-modal="true"', 'aria-labelledby="sign-in-sheet-title"', 'platform-kb-sheet', 'data-sign-in-sheet-cover=""']) assert.ok(html.includes(hook), hook);
  assert.match(sheet('paper', { title: 'Continue to Homeroom', from: 'story' }), /<h2 id="sign-in-sheet-title"[^>]*>Continue to Homeroom<\/h2>/, 'o05 and o06: the same step under the other title');
});

test('the phone step: the number in its card, Apple and Google under "or", Text me a code, then the way back to email and the terms', () => {
  const html = sheet('mosaic', { phone: false, phoneLink: true, askName: false });
  assert.match(html, /data-sign-in-sheet="choose"/, 'the landing\'s sheets open on the first step; the phone is a row away');
  assert.match(KIT, /\{step === 'phone' \? \(\s*<form className=\{`mt-5 \$\{k\('stack'\)\}`\} onSubmit=\{\(e\) => \{ e\.preventDefault\(\); void submitPhoneStep\(\); \}\}>/);
  assert.match(KIT, /<PhoneInput inputRef=\{phoneField\} id="sign-in-sheet-phone" defaultValue=\{phoneNumber\} \/>/, 'the product\'s own field, with its country code');
  assert.match(KIT, /\{providerRows\.length \|\| wayRows\.length \? or\(\[\.\.\.providerRows, \.\.\.wayRows\], 'providers'\) : null\}\s*<button type="submit" disabled=\{busy\} className=\{k\('btn', 'block', busy && 'off'\)\} \{\.\.\.HOLD_FIELD_FOCUS\}>\{busy \? t\('auth:signInSheet\.phone\.sending'\) : t\('auth:signInSheet\.phone\.send'\)\}<\/button>/);
  assert.match(KIT, /<RichMessage id="auth:signInSheet\.phone\.haveAccount"/);
  assert.match(KIT, /<TermsNotice recaptcha=\{step === 'phone' && recaptchaInUse \? RECAPTCHA_LINE : null\} \/>/);
  // An invite's sheet opens on the phone where it asks for one: rendered whole.
  const invite = sheet('glass', { phone: true, from: 'invite', askName: true });
  if (/data-sign-in-sheet="phone"/.test(invite)) {
    assert.ok(rising(order(invite, ['data-sign-in-sheet-name-note=""', 'id="sign-in-sheet-name"', 'id="sign-in-sheet-phone"', 'data-sign-in-sheet-providers=""', 'data-sign-in-provider="apple"', 'data-sign-in-sheet-to-email-signup=""', 'Text me a code', 'data-sign-in-sheet-ways=""', 'By continuing'])));
  }
});

test('the email step is the kit\'s sheet too: what a sheet opens on before Apple and Google are known, and where the switch\'s Email code leads', () => {
  // The visual pass (o12, o04): a members' address opened by a visitor asks
  // for the sheet before the providers have answered, so it opens on the
  // email step, which only wore the look: plain blue links, and the
  // standard segmented switch where the next step drew the look's tabs.
  const html = sheet('glass', { providers: [], phoneLink: true, title: 'Sign in to open Messages' });
  assert.match(html, /^<div data-sign-in-sheet="email" class="fixed inset-0 z-50">/, 'no providers: the sheet opens on the email step');
  assert.match(html, /<\/div><div data-sign-in-sheet-kit=""><div class="mt-4"><div role="radiogroup"[^>]* data-sign-in-sheet-method="" class="fr-tabs fr-seg"><button type="button" role="radio" aria-checked="true" data-sign-in-sheet-method-email="" class="fr-tab fr-on">Email code<\/button>/, 'the switch is one drawing on every step that has it');
  assert.ok(rising(order(html, ['id="sign-in-sheet-title"', 'data-sign-in-sheet-method=""', 'id="sign-in-sheet-email"', 'data-sign-in-sheet-or=""', 'data-sign-in-sheet-to-phone=""', '>Send code</button>'])), 'the kit sheet\'s order');
  assert.match(html, /<button type="submit" class="fr-btn fr-block">Send code<\/button><\/form>/, 'the step\'s own button and words');
  assert.doesNotMatch(html, /By continuing|data-sign-in-sheet-other-ways|class="fr-foot/, 'no terms here (sending a code makes nothing) and no way to providers that are not there, as the standard step');
  // Once the providers are known the step keeps its own way to them, as a row.
  assert.match(KIT, /\.\.\.\(providers\.length \? \[\(\s*<button key="other-ways" type="button" data-sign-in-sheet-other-ways="" className=\{k\('row', 'sm'\)\} onClick=\{\(\) => \{ setError\(null\); setStep\('choose'\); \}\}>/);
  assert.match(KIT, /<span className=\{k\('t'\)\}>\{t\('auth:signInSheet\.email\.otherWays'\)\}<\/span>/, 'the standard step\'s own words');
  assert.match(KIT, /\{step === 'email' \? \(\s*<form className=\{`mt-5 \$\{k\('stack'\)\}`\} onSubmit=\{\(e\) => \{ e\.preventDefault\(\); void requestCode\(firstField\.current\?\.value \|\| ''\); \}\}>/);
  assert.match(KIT, /\{step === 'email' \? emailFoot : <TermsNotice /, 'the terms only where the standard step says them (an invite\'s Join)');
  // An invite's Join on the email step says the terms, in the foot.
  const invite = sheet('paper', { providers: [], from: 'invite' });
  if (/data-sign-in-sheet="email"/.test(invite)) assert.match(invite, /class="mt-4 flex flex-col gap-2 fr-foot">.*By continuing/s);
  // The standard look's email step is untouched.
  const standard = sheet('standard', { providers: [], phoneLink: true });
  assert.match(standard, /^<div data-sign-in-sheet="email"/);
  assert.doesNotMatch(standard, /data-sign-in-sheet-kit|class="fr-/);
});

test('the password step: the switch as the kit\'s tabs, the two fields in one card, Sign in, then Forgot password?', () => {
  assert.match(KIT, /\{step === 'password' \? \(\s*<form className=\{`mt-5 \$\{k\('stack'\)\}`\} onSubmit=\{\(e\) => \{ e\.preventDefault\(\); void signInWithPassword\(\); \}\}>/);
  assert.match(KIT, /<input ref=\{identifierField\} id="sign-in-sheet-identifier" name="username" type="text" required autoComplete="username"/);
  assert.match(KIT, /<PasswordInput ref=\{currentPasswordField\} id="sign-in-sheet-current-password" name="password" required autoComplete="current-password"/);
  assert.match(KIT, /<button type="button" data-sign-in-sheet-forgot="" className=\{k\('link'\)\} onClick=\{\(\) => \{ typedIdentifier\.current = \(identifierField\.current\?\.value \|\| ''\)\.trim\(\); toStep\('forgot'\); \}\}>/);
  assert.match(KIT, /\{step === 'password' \|\| \(step === 'email' && !lineWays\.length && !emailFoot\) \? null : \(\s*<div className=\{`mt-4 flex flex-col gap-2 \$\{k\('foot'\)\}`\}>/, 'no terms on this step, as today');
});

test('it is a branch: four steps under a look, and the standard render is untouched', () => {
  assert.match(SRC, /const kit = isFrameSkin\(useLiveSkin\(\)\);/, 'a hook at the top, never behind a condition');
  assert.doesNotMatch(SRC, /(&&|\|\||\?)\s*!?isFrameSkin\(use(Live)?Skin\(\)\)/);
  assert.match(SRC, /const kitStep = kit && \(step === 'choose' \|\| step === 'email' \|\| step === 'phone' \|\| step === 'password'\);/);
  assert.match(SRC, /\{kitStep \? kitSteps\(\) : \(<>\s*\{methodSwitch \? \(\s*<div role="radiogroup"/, 'one shell: the kit\'s steps or the standard ones inside it');
  assert.match(KIT, /^\/\/ THE KIT BRANCH[\s\S]*?\n  function kitSteps\(\) \{/, 'a hoisted function after the standard render, which stays the first the suites find');
  assert.ok(SRC.indexOf("{step === 'choose' ? (") < SRC.indexOf('// THE KIT BRANCH'));
  const standard = sheet('standard', { phoneLink: true });
  assert.doesNotMatch(standard, /data-sign-in-sheet-kit|class="fr-/, 'the standard look draws no kit markup');
  assert.ok(rising(order(standard, ['data-sign-in-provider="apple"', 'By continuing', 'data-sign-in-sheet-or=""', 'id="sign-in-sheet-email"', 'data-sign-in-provider="email"', 'data-sign-in-sheet-to-phone=""'])), 'the standard order stands');
  // Every hook of the three standard steps is in the branch too.
  for (const hook of ['data-sign-in-sheet-method=""', 'data-sign-in-sheet-method-email=""', 'data-sign-in-sheet-method-password=""',
    'data-sign-in-provider={provider}', 'data-sign-in-provider="email"', 'data-sign-in-email-empty=', 'data-sign-in-sheet-to-phone=""', 'data-sign-in-sheet-to-email-signup=""', 'data-sign-in-sheet-or=""', 'data-sign-in-sheet-providers=', 'data-sign-in-sheet-ways=""', 'data-sign-in-sheet-to-email=""',
    'data-sign-in-sheet-name-note=""', 'data-sign-in-sheet-forgot=""', 'ref={firstField}', 'ref={nameField}', 'inputRef={phoneField}', 'ref={identifierField}', 'ref={currentPasswordField}', '{...HOLD_FIELD_FOCUS}', '{...HANDLE_FIELD}', '<SessionConfirmationNotice completion={completion} />', 'role="alert"']) {
    assert.ok(KIT.includes(hook), `${hook} is in the kit branch`);
  }
  // The steps the mockups do not draw keep wearing the look (app.css, THE SIGN-IN SHEET).
  for (const step of ['code', 'phone-code', 'forgot', 'account']) assert.doesNotMatch(KIT, new RegExp(`step === '${step}' \\?`), step);
});

test('app.css: the switch takes the look\'s tabs in the kit branch, and the rows stand in for the kit\'s reset', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE SIGN-IN SHEET'), css.indexOf('THE HOMEROOM MENU'));
  assert.match(hand, /\[data-sign-in-sheet-method\]:not\(\.fr-tabs\) \{ background: var\(--fr-sunk\); \}/, 'the worn switch is the other steps\'');
  assert.match(hand, /html\[data-skin\] \[data-sign-in-sheet-kit\] \.fr-row \{ width: 100%; text-align: start; font: inherit; color: inherit; \}/);
  assert.match(hand, /html\[data-skin\] \[data-sign-in-sheet-kit\] \.fr-btn\.fr-block \{ height: 44px; \}/);
});
