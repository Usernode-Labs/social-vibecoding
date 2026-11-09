'use strict';

// Reminders to people let in from the waitlist who have not signed in.
//
// Two, then stop. The first goes at least FIRST_AFTER_DAYS (2) after the
// admit; the last at least LAST_AFTER_DAYS (6) after it AND at least
// LAST_GAP_DAYS (4) after the first. A row never gets a third, and never the
// same one twice. Old admits are included: the spacing alone decides when
// theirs go, so somebody let in a month ago gets the first now and the last
// four days later.
//
// WHO. Every waitlist row with `released_at` set and an email address that is
// not an admin's test release (test_waitlist_releases), and that has not
// signed in since it was let in. Signed in since means any of:
//   - its admit mail's one-time sign-in link was followed
//     (`release_link_followed_at`, services/release-links.js spend);
//   - a sign-in code was asked for after the admit (an `otp` delivery to the
//     address at or after `released_at`, or `release_code_asked_at`, which the
//     mail log's retention sweep keeps on the row: services/mail/index.js);
//   - its linked account has a session made, or used, after the admit
//     (`sessions.created_at`, `last_seen_at`): a person still using a
//     session from before the admit is in, too.
// Never: a row that stopped reminders (`reminders_stopped_at`, the stop link
// below), an address on the bounce and complaint list (mail_suppressions), a
// phone-only row (no email; Homeroom sends no texts yet, #4096).
//
// HOW. The waitlist-reminders clock (src/workflow/clock/services.ts) lists
// the rows owed one (owedTargets), at most PER_RUN a run, each a target of
// its own; its item (remindItem) claims the reminder and sends it. The claim
// is a compare-and-set on the reminder's own column (`SET reminder_1_sent_at
// = NOW() WHERE reminder_1_sent_at IS NULL AND ...`, every rule above checked
// again in the same statement), so two processes, or the clock and an
// admin's "Send a reminder now", can never both send one. The stamp is the
// claim: a send the mailer refused before it reached a provider (the hourly
// budget, no transport, no template) gives it back, so it is owed again; one
// that reached a provider keeps it, whatever the provider said.
//
// Each reminder to an address with no account carries a FRESH one-time
// sign-in link (services/release-links.js mintLink), good for seven days
// from that mail; the admit mail's own link keeps working until its own
// expiry. An address with an account gets the sign-in form (`/?login=1`), as
// the admit mail does. The last reminder's replies go to a person
// (config.mailReplyTo, PLATFORM_MAIL_REPLY_TO).
//
// THE STOP LINK. Most of these people have no account, so the link is keyed
// to the waitlist row: an HMAC of the row's id and address under the
// session secret (stopToken). GET /mail/reminders/stop shows a page with one
// button, so a link scanner that opens every URL in a mail stops nothing;
// POST, the button or a mail client's own one-click unsubscribe (RFC 8058,
// `List-Unsubscribe-Post`), stamps `reminders_stopped_at`
// (routes/waitlist-reminders.js). A row whose address changed has a link
// that no longer matches.
//
// Admin → Waitlist's Reminders switch (services/release-mail-setting.js) turns
// the clock off and on; it is independent of the Release email switch. An
// admin's "Send a reminder now" (POST /api/v4/admin/waitlist/:id/remind,
// remindNow) sends a row's next reminder whatever the spacing or the switch,
// and refuses a row that signed in, stopped reminders, or had both.

const crypto = require('crypto');
const log = require('./logger');
const { PRODUCTION_ORIGIN } = require('./cli-auth-constants');
const releaseLinks = require('./release-links');
const settings = require('./release-mail-setting');

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_AFTER_DAYS = 2;
const LAST_AFTER_DAYS = 6;
const LAST_GAP_DAYS = 4;
const KINDS = Object.freeze({ 1: 'waitlist_reminder', 2: 'waitlist_reminder_last' });

// The clock's pace: at most PER_RUN reminders a run, a run every EVERY_MS.
// Six runs an hour stay under the reminders' own hourly budget
// (mail/rate-limit.js REMINDER_MAX_PER_HOUR), so the clock never spends what
// it would only have to give back.
const EVERY_MS = 10 * 60 * 1000;
const PER_RUN = 8;

const DEFAULT_REPLY_TO = 'support@usernodelabs.org';

// What the mailer recorded when nothing reached a provider: the reminder was
// not sent, so its stamp is given back and it is owed again. A throttled send
// counts only when it was the hourly budget that refused it: the
// per-recipient rule refuses one only after a reminder of that kind already
// went to the address, and giving that stamp back would send it twice.
const NOT_SENT = new Set(['suppressed_rate_limit', 'no_transport', 'no_template']);
function notSent(delivery) {
  if (!delivery || !NOT_SENT.has(delivery.status)) return false;
  return delivery.status !== 'suppressed_rate_limit' || /^global cap\b/.test(String(delivery.error || ''));
}

// ── The rules, in SQL ──────────────────────────────────────────────────

// A row a reminder may go to at all.
const REACHABLE_SQL = `w.released_at IS NOT NULL
   AND w.email IS NOT NULL
   AND w.reminders_stopped_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM test_waitlist_releases t WHERE t.signup_id = w.id)
   AND NOT EXISTS (SELECT 1 FROM mail_suppressions ms WHERE ms.recipient = lower(w.email))`;

// Whether the row signed in since it was let in (the top of this file).
const SIGNED_IN_SQL = `(w.release_link_followed_at IS NOT NULL
   OR w.release_code_asked_at IS NOT NULL
   OR EXISTS (SELECT 1 FROM mail_deliveries d
               WHERE d.recipient = w.email AND d.kind = 'otp' AND d.created_at >= w.released_at)
   OR EXISTS (SELECT 1 FROM sessions s
               WHERE w.linked_user_id IS NOT NULL AND s.user_id = w.linked_user_id
                 AND (s.created_at > w.released_at OR s.last_seen_at > w.released_at)))`;

// When each reminder is due. The intervals are FIRST_AFTER_DAYS,
// LAST_AFTER_DAYS and LAST_GAP_DAYS (tests pin that they agree).
const FIRST_DUE_SQL = `(w.reminder_1_sent_at IS NULL
   AND w.released_at <= NOW() - INTERVAL '2 days')`;
const LAST_DUE_SQL = `(w.reminder_1_sent_at IS NOT NULL AND w.reminder_2_sent_at IS NULL
   AND w.released_at <= NOW() - INTERVAL '6 days'
   AND w.reminder_1_sent_at <= NOW() - INTERVAL '4 days')`;

// The rows owed a reminder now, oldest admit first, and which one.
const OWED_SQL = `SELECT w.id, CASE WHEN w.reminder_1_sent_at IS NULL THEN 1 ELSE 2 END AS reminder
    FROM waitlist_signups w
   WHERE ${REACHABLE_SQL}
     AND NOT ${SIGNED_IN_SQL}
     AND (${FIRST_DUE_SQL} OR ${LAST_DUE_SQL})
   ORDER BY w.released_at, w.id
   LIMIT $1`;

// What a claim hands the send: the address, whether it has an account, its
// prefill token and its language.
const CLAIMED_SQL = `w.id, w.email, w.released_at, w.linked_user_id, w.more_token,
    (w.linked_user_id IS NOT NULL OR EXISTS (SELECT 1 FROM users ua WHERE ua.email = w.email)) AS has_account,
    (SELECT u.locale FROM users u WHERE u.id = w.linked_user_id OR u.email = w.email
      ORDER BY (u.id = w.linked_user_id) DESC NULLS LAST LIMIT 1) AS recipient_locale`;

// The claims: each reminder's stamp, set only if it is still unset and every
// rule still holds, the spacing too unless an admin asked ($2).
const CLAIM_FIRST_SQL = `UPDATE waitlist_signups w
     SET reminder_1_sent_at = NOW()
   WHERE w.id = $1
     AND w.reminder_1_sent_at IS NULL
     AND ${REACHABLE_SQL}
     AND NOT ${SIGNED_IN_SQL}
     AND ($2::boolean OR ${FIRST_DUE_SQL})
  RETURNING ${CLAIMED_SQL}, w.reminder_1_sent_at::text AS claimed_at`;
const CLAIM_LAST_SQL = `UPDATE waitlist_signups w
     SET reminder_2_sent_at = NOW()
   WHERE w.id = $1
     AND w.reminder_1_sent_at IS NOT NULL
     AND w.reminder_2_sent_at IS NULL
     AND ${REACHABLE_SQL}
     AND NOT ${SIGNED_IN_SQL}
     AND ($2::boolean OR ${LAST_DUE_SQL})
  RETURNING ${CLAIMED_SQL}, w.reminder_2_sent_at::text AS claimed_at`;

// A claim given back, only if it is still the one this send made. The claim's
// time travels as text, which keeps its microseconds (a Date would not).
const UNCLAIM_FIRST_SQL = `UPDATE waitlist_signups
     SET reminder_1_sent_at = NULL
   WHERE id = $1 AND reminder_1_sent_at = $2::timestamptz`;
const UNCLAIM_LAST_SQL = `UPDATE waitlist_signups
     SET reminder_2_sent_at = NULL
   WHERE id = $1 AND reminder_2_sent_at = $2::timestamptz`;

// One row's reminder state, for "Send a reminder now" and its refusals.
const STATE_SQL = `SELECT w.id, w.email, w.released_at, w.reminder_1_sent_at, w.reminder_2_sent_at,
         w.reminders_stopped_at,
         EXISTS (SELECT 1 FROM test_waitlist_releases t WHERE t.signup_id = w.id) AS test_release,
         EXISTS (SELECT 1 FROM mail_suppressions ms WHERE ms.recipient = lower(w.email)) AS suppressed,
         ${SIGNED_IN_SQL} AS signed_in
    FROM waitlist_signups w
   WHERE w.id = $1`;

// ── The stop link ──────────────────────────────────────────────────────

function secretOf(config) {
  return (config && config.sessionSecret) || null;
}

const validId = (id) => Number.isSafeInteger(Number(id)) && Number(id) > 0;

/** The token in a row's stop link: an HMAC of the row and its address. */
function stopToken(signupId, email, key) {
  if (!key || !validId(signupId) || typeof email !== 'string' || !email.trim()) return null;
  return crypto.createHmac('sha256', key)
    .update(`waitlist-reminders:stop:${Number(signupId)}:${email.trim().toLowerCase()}`)
    .digest('base64url').slice(0, 32);
}

function tokenMatches(signupId, email, token, key) {
  const want = stopToken(signupId, email, key);
  if (!want || typeof token !== 'string' || token.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(token));
}

/** A row's "Stop these reminders" link, or null without a secret. */
function stopUrl(config, { id, email }) {
  const token = stopToken(id, email, secretOf(config));
  return token ? `${PRODUCTION_ORIGIN}/mail/reminders/stop?w=${Number(id)}&t=${token}` : null;
}

/**
 * The stop link's POST: stamps the row's `reminders_stopped_at` (the first
 * stop stands). True when the token is the row's, whether or not it had
 * already stopped; false for anything else, which changes nothing.
 */
async function stop(config, pool, { signupId, token }) {
  if (!validId(signupId) || typeof token !== 'string' || !token) return false;
  const { rows: [row] } = await pool.query('SELECT id, email FROM waitlist_signups WHERE id = $1', [Number(signupId)]);
  if (!row || !row.email || !tokenMatches(row.id, row.email, token, secretOf(config))) return false;
  await pool.query(
    `UPDATE waitlist_signups SET reminders_stopped_at = NOW()
      WHERE id = $1 AND reminders_stopped_at IS NULL`,
    [Number(row.id)],
  );
  log.info('waitlist-reminders', 'Reminders stopped from the link', { signupId: Number(row.id) });
  return true;
}

/** Whether `token` is row `signupId`'s stop token (the GET page's check). */
async function stopLinkWorks(config, pool, { signupId, token }) {
  if (!validId(signupId) || typeof token !== 'string' || !token) return false;
  const { rows: [row] } = await pool.query('SELECT id, email FROM waitlist_signups WHERE id = $1', [Number(signupId)]);
  return !!(row && row.email && tokenMatches(row.id, row.email, token, secretOf(config)));
}

// ── Sending ────────────────────────────────────────────────────────────

function replyToOf(config) {
  return (config && typeof config.mailReplyTo === 'string' && config.mailReplyTo.trim()) || DEFAULT_REPLY_TO;
}

/**
 * Claim reminder `reminder` (1 or 2) for row `signupId`: the row as the send
 * needs it, or null when it is not owed (already claimed, signed in, stopped,
 * not due unless `manual`).
 */
async function claim(pool, signupId, reminder, { manual = false } = {}) {
  if (!validId(signupId) || !KINDS[reminder]) return null;
  // Written out, not chosen, so the SQL inventory can read each statement.
  const params = [Number(signupId), !!manual];
  const { rows: [row] } = reminder === 1
    ? await pool.query(CLAIM_FIRST_SQL, params)
    : await pool.query(CLAIM_LAST_SQL, params);
  return row || null;
}

/**
 * Send a claimed reminder: a fresh sign-in link for an address with no
 * account, the mail, and what the mailer recorded for it. A send that never
 * reached a provider gives the claim back. Resolves `{ status, error,
 * owedAgain }`.
 */
async function deliver(config, pool, claimed, reminder) {
  const mail = require('./mail');
  const hasAccount = !!claimed.has_account;
  const kind = KINDS[reminder];
  let link = null;
  if (!hasAccount) {
    // A failed mint drops the link, not the reminder: the button still
    // prefills the address and sends a code, as the admit mail's does.
    try {
      link = await releaseLinks.mintLink(pool, { signupId: claimed.id, email: claimed.email });
    } catch (err) {
      log.error('waitlist-reminders', 'Reminder sign-in link not minted', { signupId: Number(claimed.id), message: err.message });
    }
  }
  const { rows: [{ at }] } = await pool.query('SELECT clock_timestamp() AS at');
  await mail.sendWaitlistReminderMail(config, claimed.email, {
    last: reminder === 2,
    hasAccount,
    moreToken: claimed.more_token || null,
    signInToken: link ? link.token : null,
    signInExpiresAt: link ? link.expiresAt : null,
    releasedAt: claimed.released_at,
    stopUrl: stopUrl(config, claimed),
    replyTo: replyToOf(config),
    ...(claimed.recipient_locale ? { locale: claimed.recipient_locale } : {}),
  });
  // What the mailer recorded. Read after the send, so a failure here must not
  // throw: the item would run again and send a second one. Unknown keeps the
  // stamp.
  let delivery = null;
  try {
    ({ rows: [delivery] } = await pool.query(
      `SELECT status, error FROM mail_deliveries
        WHERE recipient = $1 AND kind = $2 AND created_at >= $3
        ORDER BY id DESC
        LIMIT 1`,
      [claimed.email, kind, at],
    ));
  } catch (err) {
    log.warn('waitlist-reminders', 'Reminder sent, its delivery not read', { signupId: Number(claimed.id), message: err.message });
  }
  const status = delivery ? delivery.status : null;
  const owedAgain = notSent(delivery);
  if (owedAgain) {
    const params = [Number(claimed.id), claimed.claimed_at];
    if (reminder === 1) await pool.query(UNCLAIM_FIRST_SQL, params);
    else await pool.query(UNCLAIM_LAST_SQL, params);
    log.warn('waitlist-reminders', 'Reminder not sent; owed again', { signupId: Number(claimed.id), reminder, status });
  } else {
    log.info('waitlist-reminders', 'Reminder sent', { signupId: Number(claimed.id), reminder, status });
  }
  return { status, error: delivery ? delivery.error || null : null, owedAgain };
}

// ── The clock ──────────────────────────────────────────────────────────

/**
 * The waitlist-reminders clock's run: each row owed a reminder now, a target
 * of its own (`waitlist-reminder:<row>:<1|2>`). Nothing while the Reminders
 * switch is off, or with no secret to sign stop links with.
 */
async function owedTargets(config, pool, { limit = PER_RUN } = {}) {
  if (!secretOf(config)) return { off: 'no_secret', items: [] };
  if (!(await settings.reminderMailEnabled(pool))) return { off: 'switched_off', items: [] };
  const { rows } = await pool.query(OWED_SQL, [Math.max(1, Math.min(PER_RUN, Number(limit) || PER_RUN))]);
  return {
    owed: rows.length,
    items: rows.map((r) => ({
      target: `waitlist-reminder:${Number(r.id)}:${Number(r.reminder)}`,
      input: { signupId: Number(r.id), reminder: Number(r.reminder) },
    })),
  };
}

/**
 * One target: claim the reminder, then send it. `steps` (the item's,
 * kernel/steps.ts) keeps both, so an item run again after a restart sends a
 * claimed reminder rather than finding it claimed and sending nothing.
 */
async function remindItem(config, pool, { signupId, reminder }, steps = null) {
  const once = steps && typeof steps.once === 'function' ? (key, fn) => steps.once(key, fn) : (_key, fn) => fn();
  if (!KINDS[reminder] || !validId(signupId)) return { said: 'settled' };
  if (!secretOf(config) || !(await settings.reminderMailEnabled(pool))) return { said: 'off' };
  const claimed = await once('claim', () => claim(pool, signupId, reminder));
  if (!claimed) return { said: 'settled' };
  const sent = await once('sent', () => deliver(config, pool, claimed, reminder));
  return { said: (sent && sent.status) || 'sent' };
}

// ── An admin's "Send a reminder now" ───────────────────────────────────

class ReminderRefused extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * Send row `signupId`'s next reminder now, whatever the spacing or the
 * Reminders switch. Throws ReminderRefused with a sentence for the admin when
 * it cannot go; resolves `{ reminder, kind, status, error, owed_again }`
 * otherwise: what the mailer recorded, and whether a send it refused before
 * any provider left the reminder owed again.
 */
async function remindNow(config, pool, signupId) {
  if (!validId(signupId)) throw new ReminderRefused('not_found', 'Waitlist entry not found.', 404);
  const { rows: [row] } = await pool.query(STATE_SQL, [Number(signupId)]);
  if (!row || row.test_release) throw new ReminderRefused('not_found', 'Waitlist entry not found.', 404);
  if (!row.released_at) throw new ReminderRefused('not_admitted', 'This signup has not been admitted, so there is nothing to remind them of.', 422);
  if (!row.email) throw new ReminderRefused('no_email', 'This signup has no email address, so no reminder can go to it.', 422);
  if (row.signed_in) throw new ReminderRefused('signed_in', 'They have signed in since they were admitted, so they need no reminder.');
  if (row.reminders_stopped_at) throw new ReminderRefused('stopped', 'They stopped these reminders from the link in one.');
  if (row.reminder_1_sent_at && row.reminder_2_sent_at) throw new ReminderRefused('had_both', 'They have had both reminders already. There is no third.');
  if (row.suppressed) throw new ReminderRefused('suppressed', 'This address bounced or marked Homeroom mail as spam, so nothing is sent to it.');
  if (!secretOf(config)) throw new ReminderRefused('no_secret', 'Reminders cannot be sent: there is no session secret to sign their stop link with.', 503);
  const reminder = row.reminder_1_sent_at ? 2 : 1;
  const claimed = await claim(pool, row.id, reminder, { manual: true });
  // Another send claimed it, or the row changed, between the read and now.
  if (!claimed) throw new ReminderRefused('changed', 'This signup changed just now. Reload and try again.');
  const { status, error, owedAgain } = await deliver(config, pool, claimed, reminder);
  return { reminder, kind: KINDS[reminder], status, error, owed_again: owedAgain };
}

module.exports = {
  DAY_MS,
  FIRST_AFTER_DAYS,
  LAST_AFTER_DAYS,
  LAST_GAP_DAYS,
  KINDS,
  EVERY_MS,
  PER_RUN,
  DEFAULT_REPLY_TO,
  NOT_SENT,
  notSent,
  REACHABLE_SQL,
  SIGNED_IN_SQL,
  FIRST_DUE_SQL,
  LAST_DUE_SQL,
  OWED_SQL,
  CLAIM_FIRST_SQL,
  CLAIM_LAST_SQL,
  STATE_SQL,
  stopToken,
  tokenMatches,
  stopUrl,
  stop,
  stopLinkWorks,
  claim,
  deliver,
  owedTargets,
  remindItem,
  remindNow,
  ReminderRefused,
};
