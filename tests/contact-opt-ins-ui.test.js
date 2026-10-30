'use strict';

// The screens of #6044: the sign-up form's opt-in boxes
// (frontend/src/features/auth/signup-opt-in.tsx) and Settings › Privacy ›
// Email & texts (frontend/src/features/settings/sections/contact-preferences.tsx).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a sign-up box starts unticked, with its label and the line saying it is optional', () => {
  const { SignupOptIn } = loadTsx('frontend/src/features/auth/signup-opt-in.tsx');
  for (const [kind, label, note] of [
    ['email', 'auth:signupOptIn.email', 'auth:signupOptIn.emailNote'],
    ['sms', 'auth:signupOptIn.sms', 'auth:signupOptIn.smsNote'],
  ]) {
    const html = renderToHtml(createElement(SignupOptIn, { id: `box-${kind}`, kind, checked: false, onChange() {} }));
    assert.match(html, new RegExp(`<input id="box-${kind}" type="checkbox"`));
    assert.doesNotMatch(html, /checked=""/, `${kind} arrives unticked`);
    assert.ok(html.includes(message(label)), `${kind} label`);
    assert.ok(html.includes(message(note).replace(/&/g, '&amp;')), `${kind} note`);
  }
  assert.match(message('auth:signupOptIn.smsNote'), /Reply STOP/);
  assert.match(message('auth:signupOptIn.emailNote'), /Not required/);
});

test('the boxes are on the account-creating steps, never on a plain sign-in', () => {
  const sheet = read('frontend/src/features/auth/sign-in-sheet.tsx');
  // The email account step shows it only for an account still being made.
  assert.match(sheet, /\{needsUsername \? \([\s\S]*?<SignupOptIn id="sign-in-sheet-news-email"[\s\S]*?\) : null\}/);
  // The invite's phone step, not when linking a phone to an existing account.
  assert.match(sheet, /\{askName && !phoneLink \? \(\s*<SignupOptIn id="sign-in-sheet-news-text" kind="sms"/);
  // Only ticked boxes are sent.
  assert.match(sheet, /optIns\.marketingEmail \? \{ marketingEmail: true \} : \{\}/);
  const login = read('frontend/src/features/auth/login.tsx');
  assert.match(login, /otpSignup\?\.needsUsername && otpNewsByEmail \? \{ marketingEmail: true \} : \{\}/);
  const welcome = read('frontend/src/features/auth/welcome-page.tsx');
  assert.match(welcome, /saveAccount\(handle, \{ marketingEmail: account\.needsUsername && newsByEmail \}\)/);
});

test('Settings › Privacy shows Email & texts before usage analytics, switches off until read', () => {
  const { ContactPreferencesSection } = loadTsx('frontend/src/features/settings/sections/contact-preferences.tsx');
  const html = renderToHtml(createElement(ContactPreferencesSection, {}));
  assert.ok(html.includes(message('settings:privacy.contact.title').replace(/&/g, '&amp;')));
  for (const id of ['settings-contact-marketing-email', 'settings-contact-activity-email']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*disabled`), `${id} is disabled until the choices are read`);
  }
  // No number yet, so no text switch in the first render.
  assert.doesNotMatch(html, /settings-contact-marketing-sms"/);
  const privacy = read('frontend/src/features/settings/sections/privacy.tsx');
  assert.ok(privacy.indexOf('<ContactPreferencesSection />') < privacy.indexOf('<UsageAnalyticsSection />'));
});
