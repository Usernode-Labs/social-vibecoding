'use strict';

// Email and text opt-ins (#6044): what a person has agreed Homeroom may send
// them, asked on the sign-up form and kept in Settings > Privacy > Email &
// texts. Three choices:
//
//   marketing_email   "Homeroom news by email". Off until they say yes
//                     (users.marketing_email). Nothing sends marketing email
//                     yet; this is the consent it will need.
//   activity_email    The emails that stand in for a push (build ready,
//                     invite news, a project opening; services/activity-mail.js).
//                     On by default, as before (users.activity_email); the
//                     switch in Settings is the same choice as the link at the
//                     foot of each of those emails.
//   marketing_sms     "Homeroom news by text", for the account's verified
//                     phone number (user_phone_identities). The consent is kept
//                     per number in sms_marketing_consents, which a STOP reply
//                     also writes (services/sms), so turning it off here is the
//                     same answer as replying STOP.
//
// Sign-in codes and other service texts and emails need no opt-in and are
// not touched here.
//
// Every answer that changes something is also written to
// contact_consent_events, the proof of consent: the channel, yes or no, where
// it was given (the sign-up form or Settings), the wording version the person
// saw, and the address or number it was about. Change a box's wording and its
// version here together, so each answer names the words it was given to.

const sms = require('./sms');

const WORDING = Object.freeze({
  marketing_email: 'marketing-email-2026-10-30',
  marketing_sms: 'marketing-sms-2026-10-30',
  activity_email: 'activity-email-2026-10-30',
});

const SOURCES = Object.freeze(['signup', 'settings']);

class ContactPreferencesError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** "•••• 1234": enough of the number to recognise it, never the whole. */
function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 4) return null;
  return `•••• ${phone.slice(-4)}`;
}

async function accountRow(pool, userId) {
  const { rows } = await pool.query(
    `SELECT u.email, u.email_confirmed, u.marketing_email, u.activity_email,
            p.phone_e164
       FROM users u
       LEFT JOIN user_phone_identities p ON p.user_id = u.id
      WHERE u.id = $1`,
    [Number(userId)]
  );
  return rows[0] || null;
}

async function smsOptedIn(pool, phone) {
  if (!phone) return false;
  const { rows } = await pool.query(
    'SELECT opted_in_at, opted_out_at FROM sms_marketing_consents WHERE phone_e164 = $1',
    [phone]
  );
  const consent = rows[0];
  return !!(consent && consent.opted_in_at && !sms.isOptedOut(consent));
}

/**
 * The three choices as Settings shows them, or null when there is no such
 * account. `email` is whether there is a confirmed address to send to;
 * `phone` the masked verified number, or null when there is none (the text
 * switch is then not offered).
 */
async function read(pool, userId) {
  const row = await accountRow(pool, userId);
  if (!row) return null;
  return {
    marketingEmail: row.marketing_email === true,
    activityEmail: row.activity_email !== false,
    marketingSms: await smsOptedIn(pool, row.phone_e164),
    email: !!(row.email && row.email_confirmed),
    phone: maskPhone(row.phone_e164),
  };
}

async function recordEvent(pool, { userId, channel, granted, source, email = null, phone = null }) {
  await pool.query(
    `INSERT INTO contact_consent_events
       (user_id, channel, granted, source, wording_version, email, phone_e164)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [Number(userId), channel, granted === true, source, WORDING[channel], email, phone]
  );
}

/**
 * Save any of the three choices. `changes` holds booleans for
 * `marketingEmail`, `activityEmail` and `marketingSms`; a key left out is
 * left as it is, and a choice that already has the value records nothing.
 * Resolves the choices as read() reports them, or null when there is no such
 * account.
 */
async function update(pool, userId, changes, { source = 'settings' } = {}) {
  if (!SOURCES.includes(source)) throw new ContactPreferencesError('invalid_source', 'Unknown source.');
  const row = await accountRow(pool, userId);
  if (!row) return null;
  const email = row.email || null;
  const phone = row.phone_e164 || null;

  if (typeof changes.marketingEmail === 'boolean' && changes.marketingEmail !== (row.marketing_email === true)) {
    if (changes.marketingEmail && !(row.email && row.email_confirmed)) {
      throw new ContactPreferencesError('no_email', 'Add and confirm an email address first.');
    }
    await pool.query('UPDATE users SET marketing_email = $1 WHERE id = $2', [changes.marketingEmail, Number(userId)]);
    await recordEvent(pool, { userId, channel: 'marketing_email', granted: changes.marketingEmail, source, email });
  }

  if (typeof changes.activityEmail === 'boolean' && changes.activityEmail !== (row.activity_email !== false)) {
    await pool.query('UPDATE users SET activity_email = $1 WHERE id = $2', [changes.activityEmail, Number(userId)]);
    await recordEvent(pool, { userId, channel: 'activity_email', granted: changes.activityEmail, source, email });
  }

  if (typeof changes.marketingSms === 'boolean') {
    if (!phone) throw new ContactPreferencesError('no_phone', 'Add a verified phone number first.');
    if (changes.marketingSms !== await smsOptedIn(pool, phone)) {
      if (changes.marketingSms) {
        await sms.recordConsent(pool, { phoneNumber: phone, userId: Number(userId), source });
      } else {
        await sms.recordOptOut(pool, phone, source);
      }
      await recordEvent(pool, { userId, channel: 'marketing_sms', granted: changes.marketingSms, source, phone });
    }
  }

  return read(pool, userId);
}

/**
 * The boxes ticked on the sign-up form. Only a yes is saved: an unticked box
 * is the default already, and nothing is recorded for a question that was
 * not answered yes. A box that does not apply to the account (no confirmed
 * address, no verified number) is ignored rather than refused, so a sign-up
 * never fails over it. Never throws: the account is made either way.
 */
async function recordSignupChoices(pool, userId, choices, log) {
  const changes = {};
  if (choices && choices.marketingEmail === true) changes.marketingEmail = true;
  if (choices && choices.marketingSms === true) changes.marketingSms = true;
  if (!Object.keys(changes).length) return;
  try {
    const row = await accountRow(pool, userId);
    if (!row) return;
    if (!(row.email && row.email_confirmed)) delete changes.marketingEmail;
    if (!row.phone_e164) delete changes.marketingSms;
    if (Object.keys(changes).length) await update(pool, userId, changes, { source: 'signup' });
  } catch (err) {
    if (log) log.warn('contact-preferences', 'Sign-up opt-ins could not be saved', { userId, err: err && err.message });
  }
}

/** The sign-up form's two boxes, from a request body: `marketingEmail`, `marketingSms`. */
function signupChoicesFrom(body) {
  return {
    marketingEmail: body?.marketingEmail === true,
    marketingSms: body?.marketingSms === true,
  };
}

module.exports = {
  WORDING,
  SOURCES,
  ContactPreferencesError,
  maskPhone,
  read,
  update,
  recordSignupChoices,
  signupChoicesFrom,
};
