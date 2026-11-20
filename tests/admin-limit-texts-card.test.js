'use strict';
// Admin › Limits, "Text alerts" (frontend/src/features/admin/admin-limit-texts.tsx):
// the card in each state it can be in. A view-only admin is told the numbers
// are full admins' only; Firebase and an unconfigured provider say so and
// turn adding off; a number waiting for its code shows in full with the code
// field; a confirmed one shows masked with Send a test text; a refused last
// text says so.
//
// Run with: node --test tests/admin-limit-texts-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ENTRY = 'frontend/src/features/admin/admin-limit-texts.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function mod() {
  globalThis.window = globalThis.window || globalThis;
  return loadTsx(ENTRY, {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, { get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_x, k) => `${String(key)}-${String(k)}` }) : String(key)) }),
      },
    },
  });
}

const words = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const render = (props) => words(renderToHtml(createElement(mod().LimitTextsCard, props)));

const READY = { ready: true, reason: null, provider: 'brevo', countries: ['GB', 'FR'] };
const PENDING = {
  id: 1, label: 'On call', country: 'GB', number: '+447700900123', verified: false, verifiedAt: null,
  waitingForCode: true, addedBy: 'evan', createdAt: '2026-11-20T10:00:00Z', lastTextedAt: '2026-11-20T10:00:00Z', lastStatus: 'sent', lastError: null,
};
const CONFIRMED = {
  ...PENDING, id: 2, label: "Evan's phone", number: '•••• 0123', verified: true, verifiedAt: '2026-11-20T10:02:00Z', waitingForCode: false,
};

test('a view-only admin is told the numbers are for full admins, and sees none', () => {
  const html = render({ canWrite: false, initialData: { availability: READY, phones: [CONFIRMED], maxPhones: 10 } });
  assert.match(html, />Text alerts</);
  assert.match(html, /id="admin-limit-texts-view-only"[^>]*>Only full admins can see or change the numbers texted\./);
  assert.doesNotMatch(html, /0123|admin-limit-texts-add/);
});

test('Firebase: the card says why, and adding a number is off', () => {
  const html = render({ canWrite: true, initialData: { availability: { ready: false, reason: 'firebase', provider: 'firebase', countries: [] }, phones: [], maxPhones: 10 } });
  assert.match(html, /id="admin-limit-texts-unavailable"[^>]*>Texts can't go out: Admin › Platform › SMS delivery uses Firebase, which only sends sign-in codes\./);
  assert.match(html, /id="admin-limit-texts-add"[^>]*disabled=""/);
  assert.match(html, /id="admin-limit-texts-phone"[^>]*disabled=""/);
});

test('a provider that is not set up says so too', () => {
  const html = render({ canWrite: true, initialData: { availability: { ready: false, reason: 'not_configured', provider: 'brevo', countries: [] }, phones: [], maxPhones: 10 } });
  assert.match(html, /missing its key or its Sender IDs/);
  assert.match(html, /id="admin-limit-texts-add"[^>]*disabled=""/);
});

test('ready with no numbers: who sends, to where, and the add form', () => {
  const html = render({ canWrite: true, initialData: { availability: READY, phones: [], maxPhones: 10 } });
  assert.match(html, /Sent through Brevo to numbers in GB, FR\./);
  assert.match(html, /id="admin-limit-texts-empty"[^>]*>No numbers yet\./);
  assert.match(html, /id="admin-limit-texts-label"/);
  assert.match(html, /id="admin-limit-texts-phone"[^>]*placeholder="\+44 7700 900123"/);
  assert.match(html, />Text a code</);
  assert.doesNotMatch(html, /id="admin-limit-texts-phone"[^>]*disabled=""/);
});

test('a number waiting for its code: in full, the code field, and no alerts yet', () => {
  const html = render({ canWrite: true, initialData: { availability: READY, phones: [PENDING], maxPhones: 10 } });
  assert.match(html, /id="admin-limit-text-1"[^>]*data-verified="false"/);
  assert.match(html, /\+447700900123/);
  assert.match(html, /Waiting for its code/);
  assert.match(html, /Gets no alerts until its code is entered\./);
  assert.match(html, /id="admin-limit-text-code-1"[^>]*autoComplete="one-time-code"|id="admin-limit-text-code-1"[^>]*autocomplete="one-time-code"/);
  assert.match(html, /data-limit-text-action="verify"/);
  assert.match(html, /data-limit-text-action="resend"/);
  assert.doesNotMatch(html, /data-limit-text-action="test"/, 'no test text before it is confirmed');
});

test('a confirmed number: masked, when it was last texted, test and remove', () => {
  const html = render({ canWrite: true, initialData: { availability: READY, phones: [CONFIRMED], maxPhones: 10 } });
  assert.match(html, /•••• 0123/);
  assert.doesNotMatch(html, /7700900123/);
  assert.match(html, />Confirmed</);
  assert.match(html, /Last texted /);
  assert.match(html, /Added by @evan\./);
  assert.match(html, /data-limit-text-action="test"[^>]*>Send a test text|>Send a test text</);
  assert.match(html, /data-limit-text-action="remove"/);
  assert.match(html, /id="admin-limit-texts-count"[^>]*>1 of 1 numbers confirmed/);
});

test('a refused last text is said, in red, with its reason', () => {
  const html = render({ canWrite: true, initialData: { availability: READY, phones: [{ ...CONFIRMED, lastStatus: 'refused', lastError: 'no_sender_id' }], maxPhones: 10 } });
  assert.match(html, /The last text was refused \(no_sender_id\)\./);
  assert.match(html, /text-red-600/);
});

test('at the most numbers, adding is off and the card says why', () => {
  const many = Array.from({ length: 2 }, (_, i) => ({ ...CONFIRMED, id: 10 + i }));
  const html = render({ canWrite: true, initialData: { availability: READY, phones: many, maxPhones: 2 } });
  assert.match(html, /At most 2 numbers\. Remove one to add another\./);
  assert.match(html, /id="admin-limit-texts-add"[^>]*disabled=""/);
});

test('the card sits in Admin › Limits after the limit settings, and has no em dash', () => {
  const src = read('frontend/src/features/admin/admin-limits.tsx');
  assert.match(src, /<LiveDraftsCard canWrite=\{canWrite\} \/>\n\n\s+<LimitTextsCard canWrite=\{canWrite\} \/>/);
  assert.doesNotMatch(read(ENTRY), /—/);
});
