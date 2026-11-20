'use strict';

// Text alerts for platform limits: the numbers a full admin adds in Admin ›
// Limits ("Text alerts"), and the texts they get when a platform-wide limit
// is near, reached or over, or the bot's credit runs out.
//
// WHAT IS TEXTED. The same rows the admin limits area at the top of
// Notifications shows (services/platform-limits-view.js), so the area and the
// texts never disagree about a limit:
//
//   near     once, when a limit crosses into near. Waits out the number's
//            country's quiet hours (sms/countries.js).
//   broken   once, when it is reached, goes over, or the credit runs out, at
//            any hour; then a reminder at most every REMIND_MS while it stays
//            at, over or out.
//   unknown  once, when a figure has been unreadable for UNKNOWN_AFTER_MS.
//   turned away  (the app limit only, from #6901's count) the first person
//            refused while it is full, at once; then the count at most every
//            REFUSAL_TEXT_MS. A refusal text counts as that limit's reminder,
//            and a crossing or reminder carries the count, so the two
//            rhythms never double up.
//
// A crossing is texted once. The level a number was last texted at is kept
// per number and limit (limit_alert_marks), and it only re-arms when the row
// goes back down, which the view decides with the alerts' own margin
// (REARM_RATIO). So a count wobbling at a line texts once, not on every sweep.
//
// HOW. Through the SMS layer's own transactional send (sms/index.js
// sendLimitAlertSms: type "transactional", tag "limit_alert"), which validates
// the number, resolves the country's Sender ID (fail closed) and records an
// sms_deliveries row. That needs Admin › Platform › SMS delivery on Brevo or
// Twilio: Firebase sends only sign-in codes. When it is Firebase, or the
// provider is not set up, or no Sender ID covers a number's country, nothing
// is sent and the card says why; a due text that cannot go is recorded as a
// refusal, never dropped silently.
//
// A NUMBER IS ACTIVE ONLY ONCE ITS CODE IS ENTERED: adding one texts it a
// six-digit code, and the sweep texts verified numbers only, so a mistyped
// number is texted once (the code) and never again. Every text and refusal is
// recorded in limit_alert_sends with the number's last four digits; the full
// number is never logged.

const crypto = require('node:crypto');
const log = require('./logger');
const sms = require('./sms');
const smsSelect = require('./sms/select');
const senders = require('./sms/senders');
const { quietHoursAllow } = require('./sms/countries');
const { SmsError } = require('./sms/errors');

const REMIND_MS = 6 * 60 * 60 * 1000;
// #6901's rhythm for people turned away at the app limit: the first refusal
// of a run at once, then the count at most this often.
const REFUSAL_TEXT_MS = 3 * 60 * 60 * 1000;
const UNKNOWN_AFTER_MS = 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_PHONES = 10;
const MAX_LABEL = 60;
const KEYS = Object.freeze([
  'apps', 'openrouter_credit', 'sessions', 'db_connections',
  // The cluster's own (services/platform-capacity.js).
  'db_disk', 'quota_apps', 'quota_workers', 'quota_builds', 'node_pool',
]);
const RANK = Object.freeze({ ok: 0, near: 1, broken: 2 });
const BROKEN_STATES = Object.freeze(new Set(['over', 'at', 'out']));
const CREDITS_URL = 'https://openrouter.ai/settings/credits';
const NAMES = Object.freeze({
  apps: 'the app count',
  sessions: 'the session count',
  openrouter_credit: 'the OpenRouter credit',
  db_connections: 'the database connections',
  db_disk: 'the database disk',
  quota_apps: 'the apps quota',
  quota_workers: 'the workers quota',
  quota_builds: 'the builds quota',
  node_pool: 'the node volume pools',
});
// A namespace quota's name in a text, and what stops when it fills.
const QUOTA_TEXT = Object.freeze({
  quota_apps: { name: 'apps', near: 'apps and previews stop starting', at: "Apps and previews can't start" },
  quota_workers: { name: 'workers', near: 'new sessions and checks wait', at: 'New sessions and checks are waiting' },
  quota_builds: { name: 'builds', near: 'new image builds fail', at: 'New image builds are failing' },
});

// Whole MiB (the capacity limits' volume figures) as GiB.
function gib(mib) {
  const n = Number(mib) / 1024;
  return n < 10 ? String(Math.round(n * 10) / 10) : String(Math.round(n));
}

/** A refusal the card shows as it is: `code` for the client, `status` for HTTP. */
class LimitTextError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function origin(env = process.env) {
  const domain = String((env && env.USERNODE_DOMAIN) || '').trim();
  return domain ? `https://${domain}` : 'https://app.onhomeroom.com';
}

function last4(phone) {
  const tail = String(phone || '').slice(-4);
  return /^[0-9]{4}$/.test(tail) ? tail : null;
}

function masked(phone) {
  const tail = last4(phone);
  return tail ? `•••• ${tail}` : '••••';
}

function ms(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value
    : value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
}

// ── The rules (pure) ───────────────────────────────────────────────────

/**
 * What a row means for a text: 'ok' (no row), 'near', 'broken' or
 * 'unknown'. A counted limit's level is the one the view held with the
 * alerts' margin, so a count just back under the cap is still 'broken' and
 * a new crossing needs a real fall first.
 */
function alertLevel(row) {
  if (!row) return 'ok';
  if (row.state === 'unknown') return 'unknown';
  if (row.key === 'openrouter_credit') return row.state === 'out' ? 'broken' : 'near';
  if (row.level === 'full' || BROKEN_STATES.has(row.state)) return 'broken';
  return 'near';
}

/**
 * One number's next step for one limit. Pure. `mark` is what it was last
 * told ({ level, textedAt, unknownSince, unknownTexted }, or null for
 * nothing yet), `row` the limit's row now (or null), `country` the number's.
 * Returns { action: 'crossing' | 'reminder' | 'unknown' | null, level,
 * mark, held? }: `mark` is what to store whether or not anything is sent.
 */
function decide(mark, row, { now = Date.now(), country = null } = {}) {
  const m = {
    level: RANK[mark && mark.level] != null ? mark.level : 'ok',
    textedAt: ms(mark && mark.textedAt),
    unknownSince: ms(mark && mark.unknownSince),
    unknownTexted: !!(mark && mark.unknownTexted),
    refusalsAt: ms(mark && mark.refusalsAt),
    refusalsCount: Number(mark && mark.refusalsCount) || 0,
  };
  const quietOk = () => quietHoursAllow(country, new Date(now));
  const level = alertLevel(row);

  if (level === 'unknown') {
    const next = { ...m, unknownSince: m.unknownSince != null ? m.unknownSince : now };
    if (!m.unknownTexted && now - next.unknownSince >= UNKNOWN_AFTER_MS) {
      if (!quietOk()) return { action: null, level: m.level, mark: next, held: 'quiet_hours' };
      return { action: 'unknown', level: m.level, mark: { ...next, unknownTexted: true } };
    }
    return { action: null, level: m.level, mark: next };
  }

  const base = { ...m, unknownSince: null, unknownTexted: false };
  // #6901: people turned away at the app limit while it is full. Any text
  // sent now carries the count and marks it told.
  const away = level === 'broken' && row && row.key === 'apps' && Number(row.turnedAway) > 0 ? Number(row.turnedAway) : 0;
  const awaySince = away ? ms(row.turnedAwaySince) : null;
  const told = (next) => (away ? { ...next, refusalsAt: now, refusalsCount: away } : next);
  if (RANK[level] > RANK[m.level]) {
    if (level === 'near' && !quietOk()) return { action: null, level: m.level, mark: base, held: 'quiet_hours' };
    return { action: 'crossing', level, turnedAway: away, mark: told({ ...base, level, textedAt: now }) };
  }
  if (RANK[level] < RANK[m.level]) return { action: null, level, mark: { ...base, level } };
  if (away && awaySince != null) {
    const newRun = m.refusalsAt == null || m.refusalsAt < awaySince;
    const more = away > m.refusalsCount && m.refusalsAt != null && now - m.refusalsAt >= REFUSAL_TEXT_MS;
    if (newRun || more) {
      // Counts as the limit's reminder too: the six hours start again.
      return { action: 'turned_away', level, turnedAway: away, firstOfRun: newRun, mark: told({ ...base, textedAt: now }) };
    }
  }
  if (level === 'broken' && row && BROKEN_STATES.has(row.state)
      && (m.textedAt == null || now - m.textedAt >= REMIND_MS)) {
    return { action: 'reminder', level, turnedAway: away, mark: told({ ...base, textedAt: now }) };
  }
  return { action: null, level, mark: base };
}

function dollars(cents) {
  const n = Number.isFinite(Number(cents)) ? Math.max(0, Number(cents)) / 100 : 0;
  return n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/** The text for a step. Pure, short, and about the platform only. */
function textFor(row, step, { site = origin() } = {}) {
  const limits = `${site}/#admin/limits`;
  const status = `${site}/#admin/status`;
  if (step.action === 'unknown') {
    return `Homeroom: couldn't read ${NAMES[row.key] || 'a limit'} for an hour. Check it: ${limits}`;
  }
  const lead = step.action === 'reminder' ? 'Homeroom reminder: ' : 'Homeroom: ';
  const near = row.state === 'near';
  const figures = `${row.used} of ${row.cap}`;
  const people = (n) => (n === 1 ? '1 person' : `${n} people`);
  if (step.action === 'turned_away') {
    if (step.firstOfRun && step.turnedAway === 1) {
      return `Homeroom: someone was just turned away at the app limit (${figures}). Raise the limit: ${limits}`;
    }
    return `Homeroom: ${people(step.turnedAway)} turned away at the app limit since it filled (${figures}). Raise the limit: ${limits}`;
  }
  const away = step.turnedAway ? ` ${people(step.turnedAway)} turned away so far.` : '';
  if (row.key === 'apps') {
    if (near) return `${lead}apps at ${figures}, near the limit. New projects stop at ${row.cap}. Raise it: ${limits}`;
    if (row.state === 'over') return `${lead}apps over the limit, ${figures}. New projects are being refused.${away} Raise the limit: ${limits}`;
    return `${lead}apps at ${figures}. New projects are being refused.${away} Raise the limit: ${limits}`;
  }
  if (row.key === 'sessions') {
    if (near) return `${lead}sessions at ${figures}, near the limit. Raise it: ${limits}`;
    return `${lead}sessions at ${figures}. New sessions are pausing idle ones or being refused. Raise the limit: ${limits}`;
  }
  if (row.key === 'db_disk') {
    const size = `${gib(row.used)} of ${gib(row.cap)} GiB`;
    if (near) return `${lead}database disk at ${size}. When it fills, Postgres stops writing. See: ${status}`;
    return `${lead}database disk full, ${size}. Saves are failing until the volume grows. See: ${status}`;
  }
  if (row.key === 'node_pool') {
    const size = `${gib(row.used)} of ${gib(row.cap)} GiB`;
    if (near) return `${lead}a node's volume pool is at ${size}. When it fills, new volumes fail to mount. See: ${status}`;
    return `${lead}a node's volume pool is full, ${size}. New worker and preview volumes are failing. See: ${status}`;
  }
  if (QUOTA_TEXT[row.key]) {
    const q = QUOTA_TEXT[row.key];
    if (near) return `${lead}${q.name} quota ${row.percent}% used. When it fills, ${q.near}. See: ${status}`;
    return `${lead}${q.name} quota used up. ${q.at}. See: ${status}`;
  }
  if (row.key === 'db_connections') {
    if (near) return `${lead}database connections at ${figures}, near the limit. Apps fail at ${row.cap}. See: ${status}`;
    return `${lead}database connections at ${figures}. Apps can't open new connections. See: ${status}`;
  }
  if (row.state === 'out') return `${lead}OpenRouter credit is out. The bot has stopped planning and building. Add credit: ${CREDITS_URL}`;
  return `${lead}OpenRouter credit is down to ${dollars(row.balanceCents)}. The bot stops at $0. Add credit: ${CREDITS_URL}`;
}

// ── Whether texts can go at all ────────────────────────────────────────

/**
 * Whether texts can be sent, and to which countries:
 * { ready, reason: 'firebase' | 'not_configured' | null, provider, countries }.
 * Firebase sends only sign-in codes; Brevo and Twilio need their key and
 * at least one Sender ID, and a country is covered only with a ready one.
 */
async function availability(pool, config, deps = {}) {
  const env = deps.env || process.env;
  const chosen = await smsSelect.selection(pool, { env }).catch(() => null);
  const provider = (chosen && chosen.provider) || smsSelect.selectedSync(config);
  if (!smsSelect.isGateway(provider)) return { ready: false, reason: 'firebase', provider, countries: [] };
  const missing = provider === 'twilio' ? smsSelect.twilioMissing(config, env) : smsSelect.brevoMissing(config, env);
  if (missing.length) return { ready: false, reason: 'not_configured', provider, countries: [] };
  const countries = senders.list(config, provider).filter((entry) => entry.ready).map((entry) => entry.country);
  if (!countries.length) return { ready: false, reason: 'not_configured', provider, countries: [] };
  return { ready: true, reason: null, provider, countries };
}

function unavailable(reason) {
  return reason === 'firebase'
    ? new LimitTextError('sms_unavailable',
      'Text alerts need Brevo or Twilio. Admin › Platform › SMS delivery uses Firebase, which only sends sign-in codes.', 409)
    : new LimitTextError('sms_unavailable',
      'The selected text provider is not set up (its key or Sender IDs are missing), so nothing can be texted.', 409);
}

// ── The numbers ────────────────────────────────────────────────────────

const PHONE_COLUMNS = `p.id, p.phone_e164, p.country, p.label, p.created_at, p.verified_at,
       p.verify_code_hash, p.verify_expires_at, p.verify_sent_at, p.last_texted_at,
       p.last_status, p.last_error, u.username AS added_by_username`;

function publicPhone(row, now = Date.now()) {
  const verified = !!row.verified_at;
  return {
    id: Number(row.id),
    label: row.label,
    country: row.country,
    // A verified number shows only its last four digits; one still waiting
    // for its code shows in full, so a typo can be seen and removed.
    number: verified ? masked(row.phone_e164) : row.phone_e164,
    verified,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    waitingForCode: !verified && !!row.verify_code_hash && (ms(row.verify_expires_at) || 0) > now,
    addedBy: row.added_by_username || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    lastTextedAt: row.last_texted_at ? new Date(row.last_texted_at).toISOString() : null,
    lastStatus: row.last_status || null,
    lastError: row.last_error || null,
  };
}

async function phoneRow(pool, id) {
  const { rows } = await pool.query(
    `SELECT ${PHONE_COLUMNS} FROM limit_alert_phones p LEFT JOIN users u ON u.id = p.added_by WHERE p.id = $1`,
    [id],
  );
  return rows[0] || null;
}

/** The card: whether texts can go, and every number. Full admins only (the route). */
async function list(pool, config, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const [ready, { rows }] = await Promise.all([
    availability(pool, config, deps),
    pool.query(`SELECT ${PHONE_COLUMNS} FROM limit_alert_phones p LEFT JOIN users u ON u.id = p.added_by ORDER BY p.created_at, p.id`),
  ]);
  return {
    availability: ready,
    phones: rows.map((row) => publicPhone(row, now)),
    maxPhones: MAX_PHONES,
  };
}

/** Record one text or refusal, and the number's last outcome. Never throws. */
async function recordSend(pool, { phoneId = null, phone = null, what, limitKey = null, level = null, status, errorCode = null }) {
  try {
    await pool.query(
      `INSERT INTO limit_alert_sends (phone_id, phone_last4, limit_key, what, level, status, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [phoneId, last4(phone), limitKey, what, level, status, errorCode],
    );
    if (phoneId != null) {
      await pool.query(
        `UPDATE limit_alert_phones
            SET last_texted_at = CASE WHEN $2 IN ('sent', 'logged') THEN NOW() ELSE last_texted_at END,
                last_status = $2, last_error = $3
          WHERE id = $1`,
        [phoneId, status, errorCode],
      );
    }
  } catch (err) {
    log.warn('limit-texts', 'Could not record a text', { err: err.message, what, status });
  }
}

/** Send one text through the SMS layer; answers { status, errorCode }. */
async function sendOne(pool, config, { phone, content }, deps = {}) {
  try {
    const out = await sms.sendLimitAlertSms(pool, config, { phoneNumber: phone, content }, deps);
    return { status: out.status, errorCode: null };
  } catch (err) {
    if (err instanceof SmsError) {
      return { status: err.code === 'provider_unreachable' ? 'failed' : 'refused', errorCode: err.code, error: err };
    }
    throw err;
  }
}

function codeHash(id, code) {
  return crypto.createHash('sha256').update(`${id}:${code}`).digest('hex');
}

function newCode(deps) {
  if (deps.code) return String(deps.code());
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function sendCode(pool, config, row, deps) {
  const code = newCode(deps);
  await pool.query(
    `UPDATE limit_alert_phones
        SET verify_code_hash = $2, verify_expires_at = NOW() + make_interval(secs => $3::double precision / 1000),
            verify_attempts = 0, verify_sent_at = NOW()
      WHERE id = $1`,
    [row.id, codeHash(row.id, code), CODE_TTL_MS],
  );
  const content = `Homeroom: ${code} is your code to get platform limit alerts on this number. It expires in 10 minutes.`;
  const sent = await sendOne(pool, config, { phone: row.phone_e164, content }, deps);
  await recordSend(pool, { phoneId: Number(row.id), phone: row.phone_e164, what: 'verify', status: sent.status, errorCode: sent.errorCode });
  if (sent.error) throw sent.error;
}

/**
 * Add a number and text it a code. Refused, before anything is written or
 * sent, when texts cannot go (Firebase, or no provider set up) or no Sender
 * ID covers the number's country. A number already waiting for its code is
 * sent a new one instead.
 */
async function addPhone(pool, config, { phoneNumber, label, userId = null }, deps = {}) {
  const name = typeof label === 'string' ? label.trim() : '';
  if (!name || name.length > MAX_LABEL) {
    throw new LimitTextError('invalid_label', `Give the number a label of 1 to ${MAX_LABEL} characters.`, 400);
  }
  const ready = await availability(pool, config, deps);
  if (!ready.ready) throw unavailable(ready.reason);
  const { phone, country } = sms.validatePhone(phoneNumber);
  if (!ready.countries.includes(country)) {
    throw new LimitTextError('no_sender_id',
      "No Sender ID covers that number's country, so it can't be texted. Add one in Admin › Platform › SMS delivery.", 422);
  }
  const { rows: existing } = await pool.query(
    'SELECT id, phone_e164, verified_at, verify_sent_at FROM limit_alert_phones WHERE phone_e164 = $1',
    [phone],
  );
  let row = existing[0] || null;
  if (row && row.verified_at) throw new LimitTextError('already_added', 'That number already gets text alerts.', 409);
  if (row && (ms(row.verify_sent_at) || 0) > (deps.now ? deps.now() : Date.now()) - RESEND_AFTER_MS) {
    throw new LimitTextError('resend_too_soon', 'A code was just sent to that number. Try again in a minute.', 429);
  }
  if (row) {
    await pool.query('UPDATE limit_alert_phones SET label = $2 WHERE id = $1', [row.id, name]);
  } else {
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM limit_alert_phones');
    if (Number(n) >= MAX_PHONES) {
      throw new LimitTextError('too_many_numbers', `Text alerts go to at most ${MAX_PHONES} numbers. Remove one first.`, 409);
    }
    const { rows: inserted } = await pool.query(
      `INSERT INTO limit_alert_phones (phone_e164, country, label, added_by)
       VALUES ($1, $2, $3, $4) RETURNING id, phone_e164`,
      [phone, country, name, userId],
    );
    row = inserted[0];
  }
  await sendCode(pool, config, row, deps);
  log.info('limit-texts', 'Text alert number added', { id: Number(row.id), country, phone: `…${last4(phone)}`, by: userId });
  return publicPhone(await phoneRow(pool, row.id), deps.now ? deps.now() : Date.now());
}

/** Send a number still waiting for its code a new one. */
async function resendCode(pool, config, { id }, deps = {}) {
  const row = await phoneRow(pool, id);
  if (!row) throw new LimitTextError('not_found', 'That number is not on the list.', 404);
  if (row.verified_at) throw new LimitTextError('already_verified', 'That number is already confirmed.', 409);
  if ((ms(row.verify_sent_at) || 0) > (deps.now ? deps.now() : Date.now()) - RESEND_AFTER_MS) {
    throw new LimitTextError('resend_too_soon', 'A code was just sent to that number. Try again in a minute.', 429);
  }
  const ready = await availability(pool, config, deps);
  if (!ready.ready) throw unavailable(ready.reason);
  await sendCode(pool, config, row, deps);
  return publicPhone(await phoneRow(pool, id), deps.now ? deps.now() : Date.now());
}

/** Confirm a number with the code it was texted. Five tries per code. */
async function verifyPhone(pool, { id, code }, deps = {}) {
  const { rows } = await pool.query(
    'SELECT id, verified_at, verify_code_hash, verify_expires_at, verify_attempts FROM limit_alert_phones WHERE id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) throw new LimitTextError('not_found', 'That number is not on the list.', 404);
  if (row.verified_at) return publicPhone(await phoneRow(pool, id));
  const now = deps.now ? deps.now() : Date.now();
  if (!row.verify_code_hash || (ms(row.verify_expires_at) || 0) <= now) {
    throw new LimitTextError('code_expired', 'That code has expired. Send a new one.', 410);
  }
  if (Number(row.verify_attempts) >= MAX_CODE_ATTEMPTS) {
    throw new LimitTextError('too_many_attempts', 'Too many wrong codes. Send a new one.', 429);
  }
  const given = Buffer.from(codeHash(row.id, String(code || '').trim()), 'hex');
  const stored = Buffer.from(String(row.verify_code_hash), 'hex');
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
    await pool.query('UPDATE limit_alert_phones SET verify_attempts = verify_attempts + 1 WHERE id = $1', [id]);
    throw new LimitTextError('wrong_code', 'That is not the code that was texted.', 400);
  }
  await pool.query(
    `UPDATE limit_alert_phones
        SET verified_at = NOW(), verify_code_hash = NULL, verify_expires_at = NULL, verify_attempts = 0
      WHERE id = $1`,
    [id],
  );
  log.info('limit-texts', 'Text alert number confirmed', { id: Number(id) });
  return publicPhone(await phoneRow(pool, id), now);
}

/** Text a confirmed number a plain test. */
async function testPhone(pool, config, { id }, deps = {}) {
  const row = await phoneRow(pool, id);
  if (!row) throw new LimitTextError('not_found', 'That number is not on the list.', 404);
  if (!row.verified_at) throw new LimitTextError('not_verified', 'Confirm the number with its code first.', 409);
  const ready = await availability(pool, config, deps);
  if (!ready.ready) throw unavailable(ready.reason);
  const content = 'Homeroom test: platform limit alerts will reach this number. No action needed.';
  const sent = await sendOne(pool, config, { phone: row.phone_e164, content }, deps);
  await recordSend(pool, { phoneId: Number(row.id), phone: row.phone_e164, what: 'test', status: sent.status, errorCode: sent.errorCode });
  if (sent.error) throw sent.error;
  return publicPhone(await phoneRow(pool, id), deps.now ? deps.now() : Date.now());
}

async function removePhone(pool, { id }) {
  const { rows } = await pool.query('DELETE FROM limit_alert_phones WHERE id = $1 RETURNING id', [id]);
  if (!rows.length) throw new LimitTextError('not_found', 'That number is not on the list.', 404);
  log.info('limit-texts', 'Text alert number removed', { id: Number(id) });
  return { id: Number(id) };
}

// ── The sweep ──────────────────────────────────────────────────────────

function sameMark(a, b) {
  return a.level === b.level && a.textedAt === b.textedAt
    && a.unknownSince === b.unknownSince && a.unknownTexted === b.unknownTexted
    && (a.refusalsAt ?? null) === (b.refusalsAt ?? null) && (a.refusalsCount || 0) === (b.refusalsCount || 0);
}

/**
 * Text every confirmed number what it is owed, from the limits as they stand
 * now. Runs on the clock (workflow/clock/services.ts, every five minutes).
 */
async function sweep(pool, config, deps = {}) {
  return withSweepLock(pool, () => sweepOnce(pool, config, deps));
}

/**
 * One pass at a time across every process: a session advisory try-lock on
 * its own connection, held for the pass. A pass that cannot take it skips,
 * so two clocks never both text a crossing before either writes its mark.
 */
async function withSweepLock(pool, run) {
  if (typeof pool.connect !== 'function') return run();
  const { LIMIT_TEXTS_LOCK } = require('./advisory-locks');
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1, 0) AS acquired', [LIMIT_TEXTS_LOCK]);
    if (!rows[0] || !rows[0].acquired) return { texts: 0, refused: 0, held: 0, skipped: true };
    try {
      return await run();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, 0)', [LIMIT_TEXTS_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function sweepOnce(pool, config, deps = {}) {
  const out = { texts: 0, refused: 0, held: 0 };
  const now = deps.now ? deps.now() : Date.now();
  const { rows: phones } = await pool.query(
    'SELECT id, phone_e164, country FROM limit_alert_phones WHERE verified_at IS NOT NULL ORDER BY id',
  );
  if (!phones.length) return out;
  const payload = deps.limits
    ? await deps.limits()
    : await require('./platform-limits-view').compute(pool, config);
  const byKey = new Map((payload.rows || []).map((row) => [row.key, row]));
  const { rows: markRows } = await pool.query(
    `SELECT phone_id, limit_key, level, texted_at, unknown_since, unknown_texted, refusals_texted_at, refusals_texted
       FROM limit_alert_marks WHERE phone_id = ANY($1::bigint[])`,
    [phones.map((p) => p.id)],
  );
  const marks = new Map(markRows.map((m) => [`${m.phone_id}:${m.limit_key}`, {
    level: m.level, textedAt: ms(m.texted_at), unknownSince: ms(m.unknown_since), unknownTexted: !!m.unknown_texted,
    refusalsAt: ms(m.refusals_texted_at), refusalsCount: Number(m.refusals_texted) || 0,
  }]));
  let ready = null;
  for (const phone of phones) {
    for (const key of KEYS) {
      const before = marks.get(`${phone.id}:${key}`)
        || { level: 'ok', textedAt: null, unknownSince: null, unknownTexted: false, refusalsAt: null, refusalsCount: 0 };
      const row = byKey.get(key) || null;
      const step = decide(before, row, { now, country: phone.country });
      if (step.held) out.held += 1;
      if (step.action) {
        if (!ready) ready = await availability(pool, config, deps);
        let sent;
        if (!ready.ready) sent = { status: 'refused', errorCode: ready.reason === 'firebase' ? 'firebase_selected' : 'sms_not_configured' };
        else if (!ready.countries.includes(phone.country)) sent = { status: 'refused', errorCode: 'no_sender_id' };
        else sent = await sendOne(pool, config, { phone: phone.phone_e164, content: textFor(row, step, { site: origin(deps.env) }) }, deps);
        await recordSend(pool, {
          phoneId: Number(phone.id), phone: phone.phone_e164, what: step.action,
          limitKey: key, level: step.level, status: sent.status, errorCode: sent.errorCode,
        });
        if (sent.status === 'sent' || sent.status === 'logged') out.texts += 1;
        else out.refused += 1;
      }
      if (!sameMark(before, step.mark)) {
        await pool.query(
          `INSERT INTO limit_alert_marks
             (phone_id, limit_key, level, texted_at, unknown_since, unknown_texted, refusals_texted_at, refusals_texted, updated_at)
           VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000), to_timestamp($5::double precision / 1000), $6,
                   to_timestamp($7::double precision / 1000), $8, NOW())
           ON CONFLICT (phone_id, limit_key) DO UPDATE
             SET level = EXCLUDED.level, texted_at = EXCLUDED.texted_at, unknown_since = EXCLUDED.unknown_since,
                 unknown_texted = EXCLUDED.unknown_texted, refusals_texted_at = EXCLUDED.refusals_texted_at,
                 refusals_texted = EXCLUDED.refusals_texted, updated_at = NOW()`,
          [phone.id, key, step.mark.level, step.mark.textedAt, step.mark.unknownSince, step.mark.unknownTexted,
            step.mark.refusalsAt, step.mark.refusalsCount],
        );
      }
    }
  }
  if (out.texts || out.refused) log.info('limit-texts', 'Limit texts swept', out);
  return out;
}

module.exports = {
  REMIND_MS,
  REFUSAL_TEXT_MS,
  UNKNOWN_AFTER_MS,
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  MAX_PHONES,
  KEYS,
  LimitTextError,
  alertLevel,
  decide,
  textFor,
  availability,
  list,
  addPhone,
  resendCode,
  verifyPhone,
  testPhone,
  removePhone,
  sweep,
  masked,
};
