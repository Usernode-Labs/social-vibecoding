'use strict';

// The shared phone field (#4208): a country selector in front of the number,
// so a person types it the local way and the client builds the E.164 the
// server takes. readPhone is the whole contract the two phone forms rely on;
// the rendered field keeps the ids the declared checks select on.
//
// Run with: node --test tests/phone-field.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const FIELD = 'frontend/src/features/auth/phone-field.tsx';

test('readPhone builds E.164 from a number typed the local way', () => {
  const { readPhone } = loadTsx(FIELD);
  const read = (country, raw) => readPhone(country, raw);
  assert.equal(read('US', '415 555 0100').e164, '+14155550100', 'a test number typed without the +1');
  assert.equal(read('US', '(415) 555-0199').e164, '+14155550199');
  assert.equal(read('GB', '07700 900123').e164, '+447700900123', 'the UK trunk 0 dropped');
  assert.equal(read('DE', '0151 23456789').e164, '+4915123456789');
  // Italy's leading 0 is part of the number, not a trunk prefix.
  assert.equal(read('IT', '06 6982 1234').e164, '+390669821234');
  const us = read('US', '415 555 0123');
  assert.equal(us.ok, true);
  assert.equal(us.country, 'US');
});

test('readPhone takes a number that already carries its own "+", as it is', () => {
  const { readPhone } = loadTsx(FIELD);
  const pasted = readPhone('US', '+44 7700 900123');
  assert.equal(pasted.ok, true);
  assert.equal(pasted.e164, '+447700900123', 'used as it is, not reformatted');
  assert.equal(readPhone('US', '+1 (415) 555-0123').e164, '+14155550123');
});

test('readPhone refuses what does not fit the chosen country, in plain words', () => {
  const { readPhone } = loadTsx(FIELD);
  const short = readPhone('GB', '0770');
  assert.equal(short.ok, false);
  assert.equal(short.error, "That doesn't look like a mobile number in the UK.");
  assert.equal(readPhone('FR', '06 12').error, "That doesn't look like a mobile number in France.");
  assert.equal(readPhone('US', '').error, 'Enter your phone number.');
  assert.equal(readPhone('US', '   ').error, 'Enter your phone number.');
  // A "+" value that is not a number either says so in words, never an em dash.
  const bad = readPhone('US', '+');
  assert.equal(bad.ok, false);
  assert.ok(bad.error.length > 0);
  for (const result of [short, readPhone('US', ''), bad]) {
    if (!result.ok) assert.doesNotMatch(result.error, /—/);
  }
});

test('phoneE164 is the shape the server takes, and no country code is guessed', () => {
  const { phoneE164 } = loadTsx(FIELD);
  assert.equal(phoneE164('+1 (415) 555-0123'), '+14155550123');
  assert.equal(phoneE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(phoneE164('+1.415.555.0123'), '+14155550123');
  assert.equal(phoneE164('4155550123'), null, 'no country code is guessed');
  assert.equal(phoneE164('+0 415'), null);
  assert.equal(phoneE164(''), null);
});

test('the country helpers', () => {
  const { countryFlag, countryPhrase, defaultCountry } = loadTsx(FIELD);
  assert.equal(countryFlag('US'), '🇺🇸');
  assert.equal(countryFlag('GB'), '🇬🇧');
  assert.equal(countryPhrase('GB'), 'the UK');
  assert.equal(countryPhrase('US'), 'the US');
  assert.ok(countryPhrase('FR').length > 0);
  // This process has no localStorage, so the device's own country falls
  // through to what the locale says; either way it is a country that works.
  const cc = defaultCountry();
  assert.match(cc, /^[A-Z]{2}$/);
});

test('the rendered field: the selector before the number, the local placeholder, the ids kept', () => {
  const { PhoneField } = loadTsx(FIELD);
  const html = renderToHtml(createElement(PhoneField, { id: 'sign-in-sheet-phone' }));
  assert.match(html, /<label for="sign-in-sheet-phone"[^>]*>Phone number<\/label>/);
  assert.match(html, /<select aria-label="Country"/);
  assert.match(html, /🇺🇸 \+1/, 'the flag and dial code, before the number');
  assert.match(html, /id="sign-in-sheet-phone"[^>]*type="tel"/);
  assert.match(html, /autoComplete="tel"|autocomplete="tel"/);
  // The placeholder is a local example, never a "+number" to copy.
  const placeholder = html.match(/placeholder="([^"]*)"/);
  assert.ok(placeholder, 'there is a placeholder');
  assert.doesNotMatch(placeholder[1], /\+/);
  // The selector carries the countries, each with its flag, name and dial code.
  assert.match(html, /🇬🇧 United Kingdom \+44/);
  assert.match(html, /🇫🇷 France \+33/);
  assert.doesNotMatch(html, /—/);
});
