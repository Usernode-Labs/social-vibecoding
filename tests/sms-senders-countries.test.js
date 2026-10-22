'use strict';

// Country awareness and the Sender ID registry: the fail-closed checks that
// stand between a send and Brevo.
//
// Run with: node --test tests/sms-senders-countries.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { countryOf, countryName, quietHoursAllow, inQuietHours } = require('../src/services/sms/countries');
const senders = require('../src/services/sms/senders');

test('countryOf matches the longest calling code and tells NANP countries apart', () => {
  assert.equal(countryOf('+33680065433'), 'FR');
  assert.equal(countryOf('+447700900123'), 'GB');
  assert.equal(countryOf('+358401234567'), 'FI', '+358 must win over the shorter +35x prefix');
  assert.equal(countryOf('+15551234567'), 'US');
  assert.equal(countryOf('+14165551234'), 'CA', 'a Toronto area code');
  assert.equal(countryOf('+18765551234'), 'JM', 'a Jamaican area code on +1');
  assert.equal(countryOf('+5511999999999'), 'BR');
  assert.equal(countryOf('+9991234567'), null, 'an unknown prefix is refused, not guessed');
  assert.equal(countryOf('not a number'), null);
  assert.equal(countryOf('+1'), null, '+1 alone has no area code to attribute');
});

test('countryName gives the English name, falling back to the code', () => {
  assert.equal(countryName('FR'), 'France');
  assert.equal(countryName('US'), 'United States');
  assert.equal(countryName('ZZ'), 'ZZ');
});

test('parseRegistry accepts both value shapes and drops malformed entries', () => {
  const registry = senders.parseRegistry(JSON.stringify({
    FR: 'Homeroom',
    GB: ' Homeroom ',
    US: { sender: '18885550100', registered: true, optOut: 'Reply STOP to opt out' },
    CA: { sender: 'Homeroom', registered: true },
    XX1: 'Homeroom',
    DE: 'no spaces allowed',
    ES: 'ab',
  }));
  assert.deepEqual(registry.FR, { sender: 'Homeroom', registered: false, optOut: null });
  assert.equal(registry.GB.sender, 'Homeroom');
  assert.deepEqual(registry.US, { sender: '18885550100', registered: true, optOut: 'Reply STOP to opt out' });
  assert.equal(registry.XX1, undefined);
  assert.equal(registry.DE, undefined, 'a space is not a valid sender');
  assert.equal(registry.ES, undefined, 'a sender is at least three characters');
});

test('a malformed registry document yields an empty registry rather than throwing', () => {
  assert.deepEqual(senders.parseRegistry('{not json'), {});
  assert.deepEqual(senders.parseRegistry('[]'), {});
  assert.deepEqual(senders.parseRegistry(''), {});
});

test('an unmapped country is refused with no_sender_id', () => {
  const config = { brevoSmsSenderIds: { FR: { sender: 'Homeroom', registered: false, optOut: null } } };
  assert.throws(() => senders.senderFor(config, 'BR'), (err) => err.code === 'no_sender_id');
});

test('US and Canada need registration marked and a numeric sender', () => {
  const config = {
    brevoSmsSenderIds: {
      US: { sender: 'Homeroom', registered: true, optOut: null },
      CA: { sender: '18885550100', registered: false, optOut: null },
      FR: { sender: 'Homeroom', registered: false, optOut: null },
    },
  };
  assert.throws(() => senders.senderFor(config, 'US'), (err) => err.code === 'country_not_registered',
    'an alphanumeric sender is not enough for the US');
  assert.throws(() => senders.senderFor(config, 'CA'), (err) => err.code === 'country_not_registered');
  assert.equal(senders.senderFor(config, 'FR').sender, 'Homeroom', 'other countries need no registration');
});

test('the admin list says which countries are not ready', () => {
  const rows = senders.list({
    brevoSmsSenderIds: {
      US: { sender: '18885550100', registered: false, optOut: null },
      FR: { sender: 'Homeroom', registered: false, optOut: null },
    },
  });
  const us = rows.find((r) => r.country === 'US');
  const fr = rows.find((r) => r.country === 'FR');
  assert.equal(us.ready, false);
  assert.equal(us.needsRegistration, true);
  assert.equal(fr.ready, true);
});

test('French marketing quiet hours: 08:00 to 20:00 Paris, no Sundays', () => {
  // 2026-10-22 is a Thursday; Paris is UTC+2 in October.
  assert.equal(quietHoursAllow('FR', new Date('2026-10-22T05:59:00Z')), false, '07:59 Paris');
  assert.equal(quietHoursAllow('FR', new Date('2026-10-22T06:00:00Z')), true, '08:00 Paris');
  assert.equal(quietHoursAllow('FR', new Date('2026-10-22T17:59:00Z')), true, '19:59 Paris');
  assert.equal(quietHoursAllow('FR', new Date('2026-10-22T18:00:00Z')), false, '20:00 Paris');
  // 2026-10-25 is a Sunday.
  assert.equal(inQuietHours('FR', new Date('2026-10-25T10:00:00Z')), true);
});

test('US and Canada: 11:00 to 20:00 Eastern', () => {
  assert.equal(quietHoursAllow('US', new Date('2026-10-22T14:59:00Z')), false, '10:59 EDT');
  assert.equal(quietHoursAllow('US', new Date('2026-10-22T15:00:00Z')), true, '11:00 EDT');
  assert.equal(quietHoursAllow('US', new Date('2026-10-22T23:59:00Z')), true, '19:59 EDT');
  assert.equal(quietHoursAllow('CA', new Date('2026-10-23T00:00:00Z')), false, '20:00 EDT');
});

test('a country with no encoded window is allowed, and the docs say so', () => {
  assert.equal(quietHoursAllow('BR', new Date('2026-10-22T03:00:00Z')), true);
});
