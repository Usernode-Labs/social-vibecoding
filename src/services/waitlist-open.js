'use strict';

/**
 * Turning the waitlist off (#6633), and the people already waiting.
 *
 * The switch itself is `waitlist_enabled` (services/release-mail-setting.js):
 * off, an account a sign-up makes is let in at once (services/waitlist.js
 * admitIfOpen). It says nothing about the people who were waiting when it
 * was turned off: the admin chooses, each time, to keep them waiting or to
 * let them all in.
 *
 * "Let them all in" is a run, not a request. It is stored as one
 * platform_settings row, `waitlist_admit_all` (`{ lastId, maxId, by }`), and
 * the waitlist-admit-all clock (src/workflow/clock/services.ts) works through
 * it a few rows a minute, so a list of any length never holds a request open
 * and a restart picks up where it stopped. Each row goes through the same
 * releaseWaitlistSignup as an Admit by hand and gets the same notice
 * (services/waitlist-release-mail.js), so the release-email switch decides
 * whether anybody is emailed. The run covers the rows that existed when it
 * was started (`id <= maxId`) and walks them by id, once: a row that fails,
 * or a phone row held until Homeroom can send texts, stays waiting and is
 * not tried again by this run. Starting another run tries those again.
 *
 * Switching the waitlist back on ends a run where it stands.
 */

const log = require('./logger');
const waitlist = require('./waitlist');
const settings = require('./release-mail-setting');
const releaseMail = require('./waitlist-release-mail');

const ADMIT_ALL_KEY = 'waitlist_admit_all';
const ADMIT_ALL_DESCRIPTION = 'The "Let them all in" run started when the waitlist was turned off '
  + '(services/waitlist-open.js): which waitlist rows it still has to admit. Empty when none is running.';

// The clock's pace, a run a minute. With the release email on, every row is
// a mail, and the platform's hourly mail ceiling (mail/rate-limit.js
// DEFAULT_MAX_PER_HOUR, 300) is one budget shared with sign-in codes: two a
// minute spends 120 of it. With the email off nothing is sent, so the pace
// is only what one run can comfortably do.
const PER_RUN_MAILED = 2;
const PER_RUN_QUIET = 50;

// An admin's test release (services/test-accounts.js sendRelease) is a row
// nobody is waiting in.
const WAITING = `w.released_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM test_waitlist_releases t WHERE t.signup_id = w.id)`;

/** How many people are waiting now: the rows Admin › Waitlist lists as waiting. */
async function countWaiting(pool) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM waitlist_signups w WHERE ${WAITING}`);
  return rows[0] ? Number(rows[0].c) || 0 : 0;
}

function parseRun(value) {
  if (!value) return null;
  try {
    const run = JSON.parse(value);
    const lastId = Number(run.lastId);
    const maxId = Number(run.maxId);
    if (!Number.isSafeInteger(lastId) || !Number.isSafeInteger(maxId) || maxId <= lastId) return null;
    return { lastId, maxId, by: Number.isSafeInteger(run.by) ? run.by : null };
  } catch {
    return null;
  }
}

/** The run in progress, or null. Read from the database every time. */
async function readAdmitAll(pool) {
  const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [ADMIT_ALL_KEY]);
  return parseRun(rows[0] ? rows[0].value : null);
}

async function storeRun(pool, run, actorId = null) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, description, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW(),
           updated_by = COALESCE(EXCLUDED.updated_by, platform_settings.updated_by)`,
    [ADMIT_ALL_KEY, run ? JSON.stringify(run) : '', ADMIT_ALL_DESCRIPTION, actorId]
  );
}

/**
 * Start letting in everybody waiting now, as admin `actorId`. Covers the
 * rows that exist at this moment; replaces a run already in progress, which
 * also retries the rows that one passed over. Returns how many are waiting.
 */
async function startAdmitAll(pool, { actorId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(w.id), 0)::bigint AS max_id, COUNT(*)::int AS c
       FROM waitlist_signups w WHERE ${WAITING}`
  );
  const maxId = Number(rows[0].max_id) || 0;
  const count = Number(rows[0].c) || 0;
  if (!count) {
    await storeRun(pool, null, actorId);
    return 0;
  }
  await storeRun(pool, { lastId: 0, maxId, by: Number.isSafeInteger(actorId) ? actorId : null }, actorId);
  log.info('waitlist', 'Let them all in: run started', { waiting: count, adminId: actorId });
  return count;
}

/** End a run where it stands. The people it has not reached stay waiting. */
async function cancelAdmitAll(pool, { actorId = null } = {}) {
  const run = await readAdmitAll(pool);
  if (!run) return false;
  await storeRun(pool, null, actorId);
  log.info('waitlist', 'Let them all in: run ended early', { lastId: run.lastId, maxId: run.maxId, adminId: actorId });
  return true;
}

/** How many rows a run in progress still has to reach. */
async function remainingFor(pool, run) {
  if (!run) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM waitlist_signups w
      WHERE ${WAITING} AND w.id > $1 AND w.id <= $2`,
    [run.lastId, run.maxId]
  );
  return rows[0] ? Number(rows[0].c) || 0 : 0;
}

/**
 * One beat of the clock: admit the run's next few rows. Does nothing with
 * no run; ends the run when the waitlist is back on or no row is left.
 */
async function admitAllTick(config, pool) {
  const run = await readAdmitAll(pool);
  if (!run) return { off: true };
  // Read past the cache: a waitlist switched back on must stop this at once.
  if (await settings.waitlistEnabled(pool, { fresh: true })) {
    await storeRun(pool, null);
    log.info('waitlist', 'Let them all in: the waitlist is on again, run ended', { lastId: run.lastId });
    return { ended: 'waitlist_on' };
  }
  const mailed = await settings.releaseMailEnabled(pool);
  const { rows } = await pool.query(
    `SELECT w.id, (u.has_platform_access IS TRUE) AS already_in
       FROM waitlist_signups w
       LEFT JOIN users u ON u.id = w.linked_user_id
      WHERE ${WAITING} AND w.id > $1 AND w.id <= $2
      ORDER BY w.id
      LIMIT $3`,
    [run.lastId, run.maxId, mailed ? PER_RUN_MAILED : PER_RUN_QUIET]
  );
  if (!rows.length) {
    await storeRun(pool, null);
    log.info('waitlist', 'Let them all in: run finished', { maxId: run.maxId });
    return { ended: 'done' };
  }

  let admitted = 0;
  let held = 0;
  let failed = 0;
  let mobile;
  for (const row of rows) {
    const id = Number(row.id);
    try {
      const released = await waitlist.releaseWaitlistSignup(pool, id);
      if (released && released.newly_released) {
        admitted += 1;
        // Somebody already in (an invite link, or a sign-up while the
        // waitlist was off) is not told "you're in" again.
        if (!row.already_in) {
          try {
            if (mobile === undefined) mobile = await releaseMail.loadReleaseMailMobile(pool);
            await releaseMail.sendReleaseMail(config, pool, released, mobile);
          } catch (err) {
            // The admit stands; only the notice failed.
            log.error('waitlist', 'Let them all in: notice failed', { signupId: id, message: err.message });
          }
        }
      }
    } catch (err) {
      if (err instanceof waitlist.WaitlistReleaseError && err.code === 'needs_sms') held += 1;
      else {
        failed += 1;
        log.error('waitlist', 'Let them all in: one entry failed', { signupId: id, message: err.message });
      }
    }
  }

  // Move past these rows whatever happened to each, so one that cannot be
  // admitted never holds the rest. Only if the run is still the one read
  // above: an admin may have ended or restarted it meanwhile.
  const lastId = Number(rows[rows.length - 1].id);
  const next = lastId >= run.maxId ? '' : JSON.stringify({ ...run, lastId });
  await pool.query(
    'UPDATE platform_settings SET value = $2, updated_at = NOW() WHERE key = $1 AND value = $3',
    [ADMIT_ALL_KEY, next, JSON.stringify(run)]
  );
  if (!next) log.info('waitlist', 'Let them all in: run finished', { maxId: run.maxId });
  return { admitted, held, failed, ...(next ? {} : { ended: 'done' }) };
}

module.exports = {
  ADMIT_ALL_KEY,
  PER_RUN_MAILED,
  PER_RUN_QUIET,
  countWaiting,
  readAdmitAll,
  startAdmitAll,
  cancelAdmitAll,
  remainingFor,
  admitAllTick,
};
