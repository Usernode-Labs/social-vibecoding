// Which SMS transport actually sends, and what the admin console can say
// about it. The decision mirrors services/mail/select.js exactly, so the two
// outbound channels are chosen by one rule rather than two that drift.
//
// Order of decisions, most binding first:
//
//  1. USERNODE_ENV=staging -> ALWAYS the log transport. A staging preview is
//     a clone of production data (see the staging-privacy convention in
//     src/db/schema.sql), so it may hold real phone numbers. Letting a
//     preview reach a real carrier would text real people from a branch
//     nobody voted on yet. This is the single-outbound-boundary use of the
//     staging gate - no feature is disabled, only delivery.
//  2. An explicit PLATFORM_SMS_PROVIDER (twilio | http | log) -> that one,
//     or null if it isn't configured. An operator who names a provider wants
//     to know it's broken, not to be silently downgraded.
//  3. auto (the default) -> twilio, then http. If neither is configured:
//     null in production (so a loud "NOT delivered" error fires and no code
//     is printed to the production log), and the log transport outside
//     production, so a developer can read a code out of the console.
//
// A partially-configured provider is never a candidate: each transport's
// create() logs the missing keys and returns null, and selection falls
// through.
'use strict';

const log = require('../logger');
const twilio = require('./transports/twilio');
const httpApi = require('./transports/http');
const logTransport = require('./transports/log');

// The single sender for all platform texts. Committed as the default so a
// fresh deploy has a From without an operator setting anything - but the
// number still has to be registered with the provider (a US A2P 10DLC
// campaign) before a send reaches a US handset.
const DEFAULT_FROM = '+18005550100';

const PROVIDERS = ['twilio', 'http', 'log'];

function isStaging(env) {
  return (env && env.USERNODE_ENV) === 'staging';
}

function isProduction(env) {
  const e = env || {};
  return e.USERNODE_ENV === 'production' || e.NODE_ENV === 'production';
}

function resolveFrom(env) {
  return ((env && env.PLATFORM_SMS_FROM) || '').trim() || DEFAULT_FROM;
}

function requestedProvider(env) {
  const raw = ((env && env.PLATFORM_SMS_PROVIDER) || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return 'auto';
  if (PROVIDERS.includes(raw)) return raw;
  log.error('platform-sms',
    'PLATFORM_SMS_PROVIDER is not a known provider - falling back to auto',
    { allowed: [...PROVIDERS, 'auto'] });
  return 'auto';
}

// Returns { transport, provider, from, stagingLogOnly, requested }.
// `transport` is null when nothing can send; every caller treats that as
// "record it, don't deliver it", never as an error.
function chooseTransport(env) {
  const e = env || {};
  const from = resolveFrom(e);
  const requested = requestedProvider(e);
  const opts = { sender: from };

  if (isStaging(e)) {
    return {
      transport: logTransport.create(),
      provider: logTransport.PROVIDER,
      from,
      stagingLogOnly: true,
      requested,
    };
  }

  const build = {
    twilio: () => twilio.create(e, opts),
    http: () => httpApi.create(e, opts),
    log: () => logTransport.create(),
  };

  if (requested !== 'auto') {
    const transport = build[requested]();
    if (!transport) {
      log.error('platform-sms',
        `PLATFORM_SMS_PROVIDER=${requested} is not configured - texts will NOT be delivered`,
        { missing: missingFor(requested, e) });
      return { transport: null, provider: null, from, stagingLogOnly: false, requested };
    }
    return { transport, provider: requested, from, stagingLogOnly: false, requested };
  }

  for (const name of ['twilio', 'http']) {
    const transport = build[name]();
    if (transport) {
      return { transport, provider: name, from, stagingLogOnly: false, requested };
    }
  }

  if (isProduction(e)) {
    // Production must NOT fall back to logging: that would print login and
    // waitlist codes into the production log. Null instead, which is what
    // makes the loud error fire.
    return { transport: null, provider: null, from, stagingLogOnly: false, requested };
  }

  return {
    transport: logTransport.create(),
    provider: logTransport.PROVIDER,
    from,
    stagingLogOnly: false,
    requested,
  };
}

function missingFor(provider, env) {
  if (provider === 'twilio') return twilio.missingKeys(env);
  if (provider === 'http') return httpApi.missingKeys(env);
  return [];
}

// Presence only: never a key, never an endpoint. `from` IS returned - the
// sender number is public (it is on every text we send).
function describe(env) {
  const e = env || {};
  const chosen = chooseTransport(e);
  const twilioMissing = twilio.missingKeys(e);
  const httpMissing = httpApi.missingKeys(e);

  return {
    configured: Boolean(chosen.transport) && chosen.provider !== 'log',
    provider: chosen.provider,
    requestedProvider: chosen.requested,
    stagingLogOnly: chosen.stagingLogOnly,
    from: chosen.from,
    usingDefaultFrom: chosen.from === DEFAULT_FROM,
    providers: [
      { name: 'twilio', label: 'Twilio SMS', configured: twilioMissing.length === 0, missing: twilioMissing },
      { name: 'http', label: 'Generic HTTP SMS API', configured: httpMissing.length === 0, missing: httpMissing },
    ],
    missing: twilioMissing,
    affectedFlows: [
      'Waitlist sign-up by phone (confirmation codes)',
      'Waitlist release notices by text',
    ],
  };
}

module.exports = { chooseTransport, describe, resolveFrom, DEFAULT_FROM, PROVIDERS };
