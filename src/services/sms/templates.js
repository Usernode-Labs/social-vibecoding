// Text bodies for every kind of platform SMS, in one place.
//
// `kind` is the discriminator every caller passes (see index.js). A template
// returns a plain string. Nothing here knows about a provider: transports/
// takes the string and encodes it however their API wants.
//
// EVERY body stays under one SMS segment (the GSM-7 single-segment budget of
// 160 characters). That is deliberate rather than incidental: a body that
// splits is billed as two messages and, worse, the halves can arrive out of
// order, so a code lands after the sentence that explains it. The templates
// below are the reason the store/release/signup links carry no capability
// token - the token alone is longer than the whole message.
//
// An unknown kind is a programming error, so it throws rather than sending a
// blank text. index.js swallows that (it must never make an always-200
// endpoint fail) and logs it.
'use strict';

const { PRODUCTION_ORIGIN } = require('../cli-auth-constants');

const BRAND = 'Homeroom';

// One segment of GSM-7 is 160 characters. Kept as a named constant so a test
// can assert the ceiling without restating the number.
const MAX_SEGMENT_CHARS = 160;

// Waitlist join confirmation. Optional code: a first join sends the code that
// proves the number; an idempotent re-join that minted nothing sends only the
// welcome, so the copy must not grow an empty code line when it is absent.
function waitlistJoinedSms(payload) {
  const code = payload.code || null;
  const head = `You're on the ${BRAND} waitlist.`;
  if (!code) {
    return `${head} We'll text you when your spot comes up.`;
  }
  return `${head} Your code is ${code}. It works for 15 minutes.`;
}

// A requested confirmation code: the resend path, and the re-join branch.
// The six digits and nothing else to read - the person chasing a code is
// here to type six digits.
function waitlistCodeSms(payload) {
  const code = payload.code;
  return `${BRAND} waitlist code: ${code}. It works for 15 minutes.`;
}

// Waitlist release, the "you're in" notice. One short line, the one link, and
// the sender name - the whole of what a text can carry. The link is a plain
// sign-in or sign-up URL rather than the mail's tokenized one: an SMS segment
// cannot hold a 48-character capability beside anything worth reading.
function waitlistReleasedSms(payload) {
  const url = payload.url || PRODUCTION_ORIGIN;
  const lead = payload.hasAccount
    ? "You're off the waitlist. Sign in:"
    : "You're off the waitlist. Create your account:";
  return `${lead} ${url} - ${BRAND}`;
}

const TEMPLATES = {
  waitlist_joined_sms: waitlistJoinedSms,
  waitlist_code_sms: waitlistCodeSms,
  waitlist_released_sms: waitlistReleasedSms,
};

function buildBody(kind, payload = {}) {
  const template = Object.prototype.hasOwnProperty.call(TEMPLATES, kind)
    ? TEMPLATES[kind]
    : null;
  if (!template) throw new Error(`unknown sms kind: ${kind}`);
  return template(payload);
}

const KINDS = Object.keys(TEMPLATES);

module.exports = { buildBody, KINDS, MAX_SEGMENT_CHARS, BRAND };
