'use strict';

// #4938: Settings › Linked phones.
//
// What this pins about the pane (frontend/src/features/settings/sections/
// linked-phones.tsx), the registry row that offers it and its routes:
//
//   - it is a part of the Account group, at #settings/phones, with its own
//     keywords, and its wrapper ships hidden like every part;
//   - the prerendered markup carries no phone: the list is read in an
//     effect, so hydration matches whatever the account holds;
//   - it reads GET /api/me/phones and unlinks with DELETE /api/me/phones/:id,
//     a same-origin browser route that answers 404 for any phone that is not
//     the signed-in account's own;
//   - Unlink asks once more on the row before it acts.
//
// The service and the revocation are pinned by
// tests/linked-phones-postgres.test.js.
//
// Run with: node --test tests/settings-linked-phones-pane.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const escape = (text) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PANE = read('frontend/src/features/settings/sections/linked-phones.tsx');
const SECTIONS = read('frontend/src/features/settings/sections/index.tsx');
const SETTINGS = read('frontend/src/features/settings/settings.js');
const AUTH = read('src/routes/auth.js');

test('Linked phones is a part of the Account group with its own address and keywords', () => {
  assert.match(
    SETTINGS,
    /\{ key: 'phones', label: 'settings:nav\.part\.phones', group: 'settings:nav\.group\.account' \}/
  );
  assert.match(SETTINGS, /phones: 'settings:nav\.keywords\.phones'/);
  assert.match(SECTIONS, /<PrivacySection \/>[\s\S]*<LinkedPhonesSection \/>[\s\S]*<WalletSection \/>/);
  assert.equal(message('settings:nav.part.phones'), 'Linked phones');
  assert.match(message('settings:nav.keywords.phones'), /\bdevices?\b.*\bunlink\b/);
});

test('the prerendered pane is hidden and lists no phone', () => {
  const { LinkedPhonesSection } = loadTsx('frontend/src/features/settings/sections/linked-phones.tsx');
  const html = renderToHtml(createElement(LinkedPhonesSection, {}));
  assert.match(html, /^<div data-settings-section="phones" class="hidden">/);
  assert.match(html, /id="settings-phones-section"/);
  assert.match(html, /<div id="settings-phones-list" class="flex flex-col"><\/div>/);
  assert.ok(html.includes(escape(message('settings:phones.title'))));
  assert.ok(html.includes(escape(message('settings:phones.intro'))));
  assert.doesNotMatch(html, /data-linked-phone=/);
});

test('the pane reads and unlinks through the account\'s own routes', () => {
  assert.match(PANE, /const ENDPOINT = '\/api\/me\/phones';/);
  assert.match(PANE, /method: 'DELETE'/);
  assert.match(PANE, /useEffect\(\(\) => \{ void load\(\); \}, \[load\]\);/, 'read in an effect, never during render');
  assert.match(PANE, /if \(asking\) void unlink\(phone\); else setConfirming\(phone\.id\);/, 'the first press only asks');
  assert.match(AUTH, /router\.get\('\/api\/me\/phones'/);
  assert.match(AUTH, /router\.delete\('\/api\/me\/phones\/:id', sameOriginBrowserOnly/);
  assert.match(AUTH, /linkedPhones\.unlinkPhone\(client, req\.user\.id, phoneId\)/, 'scoped to the signed-in account');
  assert.match(AUTH, /if \(!unlinked\) return res\.status\(404\)/);
});

test('every phone row and confirmation is catalog text', () => {
  for (const id of [
    'settings:phones.platform.android', 'settings:phones.platform.ios', 'settings:phones.platform.unknown',
    'settings:phones.thisPhone', 'settings:phones.unlink', 'settings:phones.cancel',
    'settings:phones.confirm', 'settings:phones.confirmThisPhone', 'settings:phones.empty',
    'settings:phones.loadFailed', 'settings:phones.unlinkFailed',
  ]) {
    assert.ok(PANE.includes(`'${id}'`), `${id} is asked for by the pane`);
    assert.ok(message(id), `${id} has English text`);
  }
  assert.equal(
    message('settings:phones.detail', { lastUsed: 'Oct 1, 2026', linked: 'Sep 2, 2026' }),
    'Last used Oct 1, 2026 · Linked Sep 2, 2026'
  );
});
