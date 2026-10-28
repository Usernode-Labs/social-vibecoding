'use strict';

// #5104: Settings › Privacy: "Who can message or invite me" and "Let people
// find my profile".
//
// What this pins about the pane (frontend/src/features/settings/sections/
// privacy.tsx), the registry row that offers it and the words the shell
// says when the server refuses:
//
//   - it is a part of the Account group, at #settings/contact-privacy, with
//     its own keywords, and its wrapper ships hidden like every part;
//   - the prerendered markup carries no choice: neither radio is checked and
//     the switch is off until the account's settings are read in an effect,
//     so hydration matches whatever the account says;
//   - it reads and writes GET/POST /api/me/contact-privacy, the route the
//     server rules sit behind;
//   - a refusal (code contact_restricted) is said in the screen's own words
//     on Messages, Friends and the Members dialog.
//
// The server side of both settings is pinned by
// tests/contact-privacy-postgres.test.js.
//
// Run with: node --test tests/settings-privacy-pane.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const escape = (text) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PANE = read('frontend/src/features/settings/sections/privacy.tsx');
const SETTINGS = read('frontend/src/features/settings/settings.js');
const AUTH = read('src/routes/auth.js');

test('Privacy is a part of the Account group with its own address and keywords', () => {
  assert.match(
    SETTINGS,
    /\{ key: 'contact-privacy', label: 'settings:nav\.part\.contactPrivacy', group: 'settings:nav\.group\.account' \}/
  );
  assert.match(SETTINGS, /'contact-privacy': 'settings:nav\.keywords\.contactPrivacy'/);
  assert.equal(message('settings:nav.part.contactPrivacy'), 'Privacy');
  assert.match(message('settings:nav.keywords.contactPrivacy'), /\bprivacy\b.*\bmessage\b/);
});

test('the prerendered pane is hidden and carries no choice', () => {
  const { PrivacySection } = loadTsx('frontend/src/features/settings/sections/privacy.tsx');
  const html = renderToHtml(createElement(PrivacySection, {}));
  assert.match(html, /^<div data-settings-section="contact-privacy" class="hidden">/);
  assert.match(html, /id="settings-who-can-message"/);
  assert.match(html, /id="settings-profile-discoverable"/);
  assert.doesNotMatch(html, /checked/, 'nothing is chosen before the account is read');
  assert.ok(html.includes(escape(message('settings:privacy.whoCanMessage.shared'))));
  assert.ok(html.includes(escape(message('settings:privacy.whoCanMessage.anyone'))));
  assert.ok(html.includes(escape(message('settings:privacy.discoverable.label'))));
  assert.equal(message('settings:privacy.whoCanMessage.shared'), "People in projects I'm in");
  assert.equal(message('settings:privacy.discoverable.label'), 'Let people find my profile');
});

test('the line under each choice says what is true now (#5926)', () => {
  const { PrivacySection } = loadTsx('frontend/src/features/settings/sections/privacy.tsx');
  const html = renderToHtml(createElement(PrivacySection, {}));
  // The switch is off until the account is read, and its line says so.
  assert.ok(html.includes(escape(message('settings:privacy.discoverable.descriptionOff'))));
  assert.ok(!html.includes(escape(message('settings:privacy.discoverable.descriptionOn'))));
  assert.match(PANE, /settings\?\.discoverable\s*\?\s*'settings:privacy\.discoverable\.descriptionOn'\s*:\s*'settings:privacy\.discoverable\.descriptionOff'/);
  assert.match(message('settings:privacy.discoverable.descriptionOn'), /^Anyone on Homeroom can find your username/);
  assert.doesNotMatch(message('settings:privacy.discoverable.descriptionOff'), /When this is off/);
  // "Anyone" says what it means in practice.
  assert.match(message('settings:privacy.whoCanMessage.anyoneDescription'), /people you don't know/);
});

test('the pane reads and writes the route the rules sit behind', () => {
  assert.match(PANE, /const ENDPOINT = '\/api\/me\/contact-privacy';/);
  assert.match(PANE, /method: 'POST'/);
  assert.match(PANE, /useEffect\(\(\) => \{ void load\(\); \}, \[load\]\);/, 'read in an effect, never during render');
  assert.match(AUTH, /router\.get\('\/api\/me\/contact-privacy'/);
  assert.match(AUTH, /router\.post\('\/api\/me\/contact-privacy', sameOriginBrowserOnly/);
});

test('a refusal is said in the screen\'s own words', () => {
  const messagesApi = read('frontend/src/features/messages/api.ts');
  const friendsApi = read('frontend/src/features/friends/api.ts');
  const members = read('frontend/src/features/dialogs/members-controller.js');
  assert.match(messagesApi, /pick\(body, 'code'\) === 'contact_restricted'[\s\S]{0,200}t\('messages:api\.contactRestricted'\)/);
  assert.match(friendsApi, /body\.code === 'contact_restricted'[\s\S]{0,80}t\('messages:api\.contactRestricted'\)/);
  assert.match(members, /data\.code === 'contact_restricted'[\s\S]{0,120}'dialogs:members\.invite\.contactRestricted'/);
  for (const id of ['messages:api.contactRestricted', 'dialogs:members.invite.contactRestricted']) {
    const text = message(id);
    assert.match(text, /invite link/, `${id} says what to do instead`);
    assert.doesNotMatch(text, /block/i, `${id} says nothing about blocking`);
  }
});
