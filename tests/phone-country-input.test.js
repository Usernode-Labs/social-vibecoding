'use strict';

// Every phone number field has a country in front of it (#4208): one shared
// field (frontend/src/features/auth/phone-input.tsx) builds the E.164 number
// the server takes from the country and the number as people write it, and
// says in plain words when it is the wrong length for that country. The
// server is unchanged: normalizePhone still refuses anything but E.164
// (tests/phone-auth.test.js).
//
// Run with: node --test tests/phone-country-input.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const INPUT = 'frontend/src/features/auth/phone-input.tsx';
const NUMBERS = 'frontend/src/features/auth/phone-numbers.ts';

test('the number is built from the country, as people type it', () => {
  const { toE164 } = loadTsx(NUMBERS);
  // The fictional test numbers keep working with the US selected.
  assert.deepEqual(toE164('415 555 0100', 'US'), { ok: true, e164: '+14155550100' });
  assert.deepEqual(toE164('(415) 555-0199', 'US'), { ok: true, e164: '+14155550199' });
  assert.deepEqual(toE164('1 415 555 0100', 'US'), { ok: true, e164: '+14155550100' });
  // The UK's trunk 0 is dropped.
  assert.deepEqual(toE164('07700 900123', 'GB'), { ok: true, e164: '+447700900123' });
  assert.deepEqual(toE164('020 7946 0958', 'GB'), { ok: true, e164: '+442079460958' });
  // Italy keeps its leading 0 in the international number.
  assert.deepEqual(toE164('06 1234 5678', 'IT'), { ok: true, e164: '+390612345678' });
  // A pasted "+…" number is used as it is, whatever the country says.
  assert.deepEqual(toE164('+44 7700 900123', 'US'), { ok: true, e164: '+447700900123' });
  assert.deepEqual(toE164('+1 (415) 555-0100', 'GB'), { ok: true, e164: '+14155550100' });
});

test('a number of the wrong length is refused in plain words, before anything is sent', () => {
  const { toE164 } = loadTsx(NUMBERS);
  assert.deepEqual(toE164('07700 9001', 'GB'), { ok: false, error: 'That doesn\'t look like a UK mobile number.' });
  assert.deepEqual(toE164('555 0100', 'US'), { ok: false, error: 'That doesn\'t look like a US mobile number.' });
  assert.deepEqual(toE164('+44 7700', 'US'), { ok: false, error: 'That doesn\'t look like a UK mobile number.' });
  assert.deepEqual(toE164('', 'US'), { ok: false, error: 'Enter your phone number.' });
  assert.equal(toE164('call me', 'US').ok, false);
  assert.match(toE164('12', 'FR').error, /^That doesn't look like a mobile number in France\.$/);
  assert.doesNotMatch(toE164('12', 'FR').error, /country code|E\.164/);
});

test('a "+…" number moves the selector to its country', () => {
  const { countryOfPlus, localeCountry } = loadTsx(NUMBERS);
  const { flag } = loadTsx(INPUT);
  assert.equal(countryOfPlus('+44 7700 900123', 'US'), 'GB');
  assert.equal(countryOfPlus('+33 6 12 34 56 78', 'US'), 'FR');
  // +1 keeps Canada when Canada is chosen; otherwise the US, its main country.
  assert.equal(countryOfPlus('+1 415 555 0100', 'CA'), 'CA');
  assert.equal(countryOfPlus('+1 415 555 0100', 'GB'), 'US');
  assert.equal(countryOfPlus('+', 'US'), null);
  assert.equal(countryOfPlus('415', 'US'), null);
  // The browser's region is the default, when it has a dial code.
  assert.equal(localeCountry('en-GB'), 'GB');
  assert.equal(localeCountry('fr'), 'FR');
  assert.equal(localeCountry(''), null);
  assert.equal(flag('US'), '\u{1F1FA}\u{1F1F8}');
});

test('the field: a country chip over a native select, then the number, and the last choice remembered', () => {
  const { PhoneInput } = loadTsx(INPUT);
  const html = renderToHtml(createElement(PhoneInput, { id: 'x-phone', inputRef: { current: null } }));
  // The prerender is the US, with one option; the list and the device's
  // default arrive in an effect, so hydration matches.
  assert.match(html, /data-phone-country-chip=""/);
  assert.match(html, /<span>\+1<\/span>/);
  assert.match(html, /<select aria-label="Country"/);
  assert.equal((html.match(/<option /g) || []).length, 1);
  assert.match(html, /id="x-phone" type="tel" autoComplete="tel" inputMode="tel"/);
  assert.match(html, /data-phone-country="US"/);
  assert.match(html, /placeholder="415 555 0123"/);
  const src = read(NUMBERS);
  assert.match(src, /new Intl\.Locale\(lang\)\.maximize\(\)\.region/);
  assert.match(src, /try \{ localStorage\.setItem\(PHONE_COUNTRY_KEY, country\); \} catch/);
  assert.match(src, /from 'libphonenumber-js\/min\/metadata'/);
  assert.doesNotMatch(src, /libphonenumber-js\/(max|mobile)/, 'the min metadata only');
  // The library is a chunk of its own, loaded when a phone field is drawn.
  const input = read(INPUT);
  assert.doesNotMatch(input, /from 'libphonenumber-js/);
  assert.match(input, /import\('\.\/phone-numbers'\)/);
  const pkg = JSON.parse(read('frontend/package.json'));
  assert.match(pkg.dependencies['libphonenumber-js'], /^\d+\.\d+\.\d+$/);
});

test('every phone step uses the shared field; Admin SMS keeps the raw +number', () => {
  for (const rel of ['frontend/src/features/auth/sign-in-sheet.tsx', 'frontend/src/features/auth/add-phone.tsx']) {
    const src = read(rel);
    assert.match(src, /<PhoneInput inputRef=\{phoneField\} /, rel);
    assert.match(src, /const read = await readPhone\(phoneField\.current\);/, rel);
    assert.doesNotMatch(src, /placeholder="\+1 415 555 0123"|Enter your number with its country code/, rel);
  }
  // The first-run step and the vote's Verify sheet draw the add-phone card.
  assert.match(read('frontend/src/features/auth/verify-identity.tsx'), /<AddPhoneCard /);
  assert.doesNotMatch(read('frontend/src/features/admin/admin-sms.tsx'), /PhoneInput/);
});
