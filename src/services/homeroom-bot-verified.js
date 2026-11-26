'use strict';

// #6632: Homeroom bot only for verified accounts.
//
// An admin's rule over who the bot works for (Admin, Homeroom bot, "Who
// Homeroom bot works for"): everyone who is let in, as before, or verified
// accounts only, with a tick list of which signals count. Any ONE ticked
// signal is enough. It is the bot's own rule, apart from the
// verified-identity rule in Admin, Limits (identity_rule_since, SQL
// identity_verified: a phone, OR GitHub AND X, OR zkPassport), which limits
// public votes, making a project public and the general AI cap, and which
// this never reads or changes.
//
// What counts is only what the platform proved:
//
//   phone       an SMS code through Firebase       user_phone_identities
//   x           an OAuth round trip                user_social_identities, provider 'x'
//   github      an OAuth round trip                user_social_identities, provider 'github'
//   github_x_age  BOTH of the two above, and each account made on its
//               provider at least settings.verifiedMinAccountAgeDays ago
//               (user_social_identities.account_created_at,
//               services/social-account-age.js). An unknown date never
//               counts, the closed side as everywhere here.
//   zkpassport  a proof the bridge confirmed       user_activities, source 'zkpassport'
//   oauth       a Google or Apple sign-in          user_oauth_identities
//   email       a confirmed email address          users.email_confirmed
//
// Never the self-declared users.github / users.x text, and never a legacy
// users.github_login alone.
//
// Admins always have the bot. With "Members let in before this was switched
// on keep the bot" ticked (the default, the same grandfathering the
// verified-identity rule uses), an account let in before the rule's moment
// (settings.verifiedSince, written once when the rule is switched on) keeps
// it too.
//
// homeroom-bot-dm.js hasBot is the one answer to "may the bot work for this
// person"; this module is what it reads the rule from.

const log = require('./logger');

const SIGNALS = Object.freeze(['phone', 'x', 'github', 'github_x_age', 'zkpassport', 'oauth', 'email']);
// What starts ticked when "Verified accounts only" is first chosen: GitHub
// and X count only together and old enough. A list an admin saved before
// github_x_age existed is kept as it was.
const DEFAULT_SIGNALS = Object.freeze(['phone', 'github_x_age']);
// The minimum age of both accounts for github_x_age, in days.
const DEFAULT_MIN_ACCOUNT_AGE_DAYS = 365;
const MAX_MIN_ACCOUNT_AGE_DAYS = 3650;

/** The minimum account age the settings ask for, in whole days. Pure. */
function minAccountAgeDaysOf(settings) {
  const n = Number(settings?.verifiedMinAccountAgeDays);
  return Number.isInteger(n) && n >= 0 && n <= MAX_MIN_ACCOUNT_AGE_DAYS ? n : DEFAULT_MIN_ACCOUNT_AGE_DAYS;
}
const AUDIENCES = Object.freeze(['everyone', 'verified']);
// The code a refused press carries, which the client opens the verify sheet
// for (frontend/src/lib/bot-verify-required.ts), as join_required opens Join.
const VERIFY_CODE = 'bot_verify_required';
const VERIFY_ERROR = 'Homeroom bot works for verified accounts. Verify your account to use it.';

/** Whether the rule is on at all. Off (or unreadable settings) is today's behaviour. */
function ruleOn(settings) {
  return !!settings && settings.worksFor === 'verified';
}

/** The ticked signals, in SIGNALS' order. Stored junk is dropped. */
function signalsOf(settings) {
  const ticked = new Set(Array.isArray(settings?.verifiedSignals) ? settings.verifiedSignals : []);
  return SIGNALS.filter((s) => ticked.has(s));
}

/**
 * Every signal an account holds, and when it was let in, in one query.
 * `db` is a pool or a transaction's connection. Throws when the read fails:
 * the caller decides (verifyRequired answers "required", the closed side).
 */
async function readSignals(db, userId, { minAccountAgeDays = DEFAULT_MIN_ACCOUNT_AGE_DAYS } = {}) {
  const days = minAccountAgeDaysOf({ verifiedMinAccountAgeDays: minAccountAgeDays });
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM user_phone_identities up WHERE up.user_id = u.id) AS has_phone,
            EXISTS (SELECT 1 FROM user_social_identities usi
                     WHERE usi.user_id = u.id AND usi.provider = 'x') AS has_x,
            EXISTS (SELECT 1 FROM user_social_identities usi
                     WHERE usi.user_id = u.id AND usi.provider = 'github') AS has_github,
            EXISTS (SELECT 1 FROM user_social_identities g
                      JOIN user_social_identities x ON x.user_id = g.user_id AND x.provider = 'x'
                     WHERE g.user_id = u.id AND g.provider = 'github'
                       AND g.account_created_at <= NOW() - make_interval(days => $2)
                       AND x.account_created_at <= NOW() - make_interval(days => $2)) AS has_github_x_age,
            EXISTS (SELECT 1 FROM user_activities ua
                     WHERE ua.user_id = u.id AND ua.source = 'zkpassport') AS has_zkpassport,
            EXISTS (SELECT 1 FROM user_oauth_identities uo WHERE uo.user_id = u.id) AS has_oauth,
            u.email_confirmed AS has_email,
            u.is_admin,
            COALESCE(u.platform_access_granted_at, u.private_member_since, u.created_at) AS let_in_at
       FROM users u WHERE u.id = $1`,
    [Number(userId), days],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    phone: !!row.has_phone,
    x: !!row.has_x,
    github: !!row.has_github,
    github_x_age: !!row.has_github_x_age,
    zkpassport: !!row.has_zkpassport,
    oauth: !!row.has_oauth,
    email: !!row.has_email,
    isAdmin: !!row.is_admin,
    letInAt: row.let_in_at instanceof Date ? row.let_in_at.toISOString() : (row.let_in_at || null),
  };
}

/**
 * Pure: whether an account with these signals passes the rule. An admin
 * always does; so does an account let in before the rule's moment while the
 * grandfather box is ticked; else any one ticked signal.
 */
function passes(settings, flags) {
  if (!ruleOn(settings)) return true;
  if (!flags) return false;
  if (flags.isAdmin) return true;
  if (settings.verifiedGrandfather !== false && settings.verifiedSince && flags.letInAt) {
    const since = Date.parse(settings.verifiedSince);
    const at = Date.parse(flags.letInAt);
    if (Number.isFinite(since) && Number.isFinite(at) && at < since) return true;
  }
  return signalsOf(settings).some((signal) => flags[signal] === true);
}

/**
 * Whether the rule keeps the bot from this person: true only while the rule
 * is on and the account neither holds a ticked signal nor is exempt. With
 * the rule off it reads nothing and answers false. `person` is anybody
 * hasBot reads ({ id | userId, isAdmin }); one with `botVerified` already
 * decided is not read again. A failed read answers true: with the rule on,
 * the closed side.
 */
async function verifyRequired(db, settings, person) {
  if (!ruleOn(settings)) return false;
  if (!person) return true;
  if (person.isAdmin) return false;
  if (person.botVerified === true) return false;
  if (person.botVerified === false) return true;
  const userId = Number(person.id ?? person.userId);
  if (!Number.isInteger(userId) || userId <= 0) return true;
  try {
    return !passes(settings, await readSignals(db, userId, { minAccountAgeDays: minAccountAgeDaysOf(settings) }));
  } catch (err) {
    log.warn('homeroom-bot-verified', 'Could not read an account\'s signals; the bot stays locked for it', {
      userId, err: err.message,
    });
    return true;
  }
}

/**
 * The refusal a locked press gets: 403 with the code, the ticked signals
 * and, when github_x_age is one, the minimum age it asks of both accounts.
 */
function refusal(settings) {
  const signals = signalsOf(settings);
  const out = { ok: false, status: 403, error: VERIFY_ERROR, code: VERIFY_CODE, signals };
  if (signals.includes('github_x_age')) out.minAccountAgeDays = minAccountAgeDaysOf(settings);
  return out;
}

/**
 * The refusal for `person` when the rule keeps the bot from them, else
 * null: what a door that starts the bot's work (a new thread, Build it, a
 * first version) asks before it does anything. With the rule off it reads
 * the settings and nothing else.
 */
async function refusalFor(db, person, { settings = null, botSvc = null } = {}) {
  const svc = botSvc && typeof botSvc.readSettings === 'function' ? botSvc : require('./homeroom-bot');
  const s = settings || await svc.readSettings(db);
  return (await verifyRequired(db, s, person)) ? refusal(s) : null;
}

/**
 * hasBot with the rule read first, through whichever homeroom-bot-dm a
 * caller was handed (a test's stand-in may know only hasBot, which with the
 * rule on answers the closed side for anybody it was not read for).
 */
async function worksFor(dm, db, settings, person) {
  if (typeof dm.botWorksFor === 'function') return dm.botWorksFor(db, settings, person);
  return dm.hasBot(settings, person);
}

module.exports = {
  worksFor,
  refusalFor,
  SIGNALS,
  DEFAULT_SIGNALS,
  DEFAULT_MIN_ACCOUNT_AGE_DAYS,
  MAX_MIN_ACCOUNT_AGE_DAYS,
  minAccountAgeDaysOf,
  AUDIENCES,
  VERIFY_CODE,
  VERIFY_ERROR,
  ruleOn,
  signalsOf,
  readSignals,
  passes,
  verifyRequired,
  refusal,
};
