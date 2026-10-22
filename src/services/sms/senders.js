'use strict';

// The country-to-Sender-ID registry, and the fail-closed resolution a send
// goes through before Brevo is called.
//
// Brevo registers Sender IDs in its own dashboard and offers no API to read
// them back, so this is operator-maintained: BREVO_SMS_SENDER_IDS is a JSON
// object keyed by ISO 3166 alpha-2 country. A value is either a sender
// string or an object:
//
//   { "FR": "Homeroom",
//     "US": { "sender": "18885550100", "registered": true,
//             "optOut": "Reply STOP to opt out" } }
//
// A sender is 3 to 11 alphanumerics, or up to 15 digits. A malformed entry
// is logged and dropped. An example country is never defaulted in: an empty
// registry means Brevo is not ready, and a country that is not in it gets no
// text.

const log = require('../logger');
const { countryName, NEEDS_REGISTRATION } = require('./countries');
const { SmsError } = require('./errors');

const SENDER_RE = /^[A-Za-z0-9]{3,11}$/;
const NUMERIC_SENDER_RE = /^[0-9]{1,15}$/;

function validSender(value) {
  return typeof value === 'string'
    && (SENDER_RE.test(value) || NUMERIC_SENDER_RE.test(value));
}

/**
 * Validate and normalise BREVO_SMS_SENDER_IDS into
 * `{ FR: { sender, registered, optOut } }`. Accepts the raw JSON string or
 * an already-parsed object. Never throws: a malformed document is logged and
 * yields an empty registry, because a broken setting must fail closed rather
 * than stop boot.
 */
function parseRegistry(raw) {
  let document = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      document = JSON.parse(raw);
    } catch (err) {
      log.error('sms', 'BREVO_SMS_SENDER_IDS is not valid JSON — no country may be texted', {
        err: err.message,
      });
      return {};
    }
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    if (raw !== undefined && raw !== null && raw !== '') {
      log.error('sms', 'BREVO_SMS_SENDER_IDS must be a JSON object keyed by country');
    }
    return {};
  }

  const registry = {};
  for (const [rawCountry, value] of Object.entries(document)) {
    const country = String(rawCountry).toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      log.warn('sms', 'Dropping a Sender ID entry with an invalid country', { country: rawCountry });
      continue;
    }
    let sender;
    let registered = false;
    let optOut = null;
    if (typeof value === 'string') {
      sender = value.trim();
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      sender = typeof value.sender === 'string' ? value.sender.trim() : '';
      registered = value.registered === true;
      optOut = typeof value.optOut === 'string' && value.optOut.trim() ? value.optOut.trim() : null;
    }
    if (!validSender(sender)) {
      log.warn('sms', 'Dropping a Sender ID entry with an invalid sender', { country });
      continue;
    }
    registry[country] = { sender, registered, optOut };
  }
  return registry;
}

function registryOf(config) {
  const registry = config && config.brevoSmsSenderIds;
  if (!registry || typeof registry !== 'object') return {};
  return registry;
}

function hasAny(config) {
  return Object.keys(registryOf(config)).length > 0;
}

/**
 * The Sender ID a send to `country` must use. Throws SmsError:
 *   no_sender_id             the country is not in the registry
 *   country_not_registered   US or CA without `registered: true` and a
 *                            numeric sender
 */
function senderFor(config, country) {
  const entry = registryOf(config)[country];
  if (!entry) {
    throw new SmsError('no_sender_id', 'No Sender ID is registered for that country.', 422);
  }
  if (NEEDS_REGISTRATION.includes(country)
      && !(entry.registered === true && NUMERIC_SENDER_RE.test(entry.sender))) {
    throw new SmsError(
      'country_not_registered',
      'Text messages to that country need a registered number first.',
      422
    );
  }
  return { sender: entry.sender, registered: entry.registered === true, optOut: entry.optOut || null };
}

function readyFor(config, country) {
  try {
    senderFor(config, country);
    return true;
  } catch {
    return false;
  }
}

/** The rows Admin → SMS delivery shows. Sender values ARE returned: they
 *  appear in every text and an operator needs to see them. */
function list(config) {
  return Object.keys(registryOf(config))
    .sort()
    .map((country) => {
      const entry = registryOf(config)[country];
      const needsRegistration = NEEDS_REGISTRATION.includes(country);
      const ready = readyFor(config, country);
      return {
        country,
        countryName: countryName(country),
        sender: entry.sender,
        needsRegistration,
        registered: entry.registered === true,
        ready,
      };
    });
}

module.exports = {
  SENDER_RE,
  NUMERIC_SENDER_RE,
  validSender,
  parseRegistry,
  hasAny,
  senderFor,
  readyFor,
  list,
};
