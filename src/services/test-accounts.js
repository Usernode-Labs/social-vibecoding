'use strict';

// Test accounts: a genuinely new account for first-time-user testing, minted
// by a full platform admin through the connector (create_test_account,
// routes/test-accounts.js) and retired with one call when testing is done.
//
// Why a new account rather than "Reset first run" on an old one: a reset
// brings back the join screen and the tour but keeps memberships, votes and
// history, so Getting started shows progress a newcomer would not have. A test
// account is a REAL account — it signs in through the ordinary form (username
// and a generated password is the one method that works on the web and in the
// iOS app, against local, staging and production alike), auto-joins the
// Homeroom community and can vote — and that is exactly why it is fenced:
//
//   * users.test_account_created_at marks it, for good (schema.sql).
//   * Its votes on an app a real person made are recorded and shown but not
//     counted, and it is left out of the active-member denominator
//     (counts_toward_outcome in schema.sql; D1).
//   * Leaderboards (exclude_podium) and the Journey page (a 'test' left-out
//     entry) do not see it.
//   * No welcome DM unless the creator asked; never a season wallet on a
//     native sign-in (native-session-protocol.js; D2).
//   * At most MAX_LIVE at once, so app slots, the wallet pool and the bot's 50
//     DM places cannot be drained by a loop.
//
// The password is returned ONCE, to the admin who asked, and never logged,
// stored in plain text or written to an event or audit payload.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('./logger');
const usernames = require('./usernames');
const waitlist = require('./waitlist');
const journeyLeftOut = require('./journey-left-out');
const { withTransaction } = require('./cli-auth');

const MAX_LIVE = 25;
const NOTE_MAX = 200;
const PASSWORD_BYTES = 12;
const BCRYPT_COST = 12;
const RETIRE_CONFIRMATION = 'RETIRE';
// One advisory lock serialises creates, so two admins at 24 cannot both make
// the 25th and the 26th.
const CAP_LOCK_KEY = 'test-accounts:cap';

class TestAccountError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function fail(status, code, message, extra) {
  throw new TestAccountError(status, code, message, extra);
}

// The one-time password: 16 base64url characters, 96 bits.
function generatePassword() {
  return crypto.randomBytes(PASSWORD_BYTES).toString('base64url');
}

function parseCreate(body) {
  const b = body && typeof body === 'object' ? body : {};
  let username = null;
  if (b.username != null && String(b.username).trim() !== '') {
    const check = usernames.validateUsername(b.username);
    if (!check.ok) fail(400, 'invalid_username', check.error, { field: 'username' });
    username = check.value;
  }
  const flag = (value, fallback, field) => {
    if (value == null) return fallback;
    if (typeof value !== 'boolean') fail(400, 'invalid_request', `${field} must be true or false.`, { field });
    return value;
  };
  const note = b.note == null ? '' : String(b.note).trim();
  if (note.length > NOTE_MAX) {
    fail(400, 'note_too_long', `Keep the note to ${NOTE_MAX} characters.`, { field: 'note', limitChars: NOTE_MAX, actualChars: note.length });
  }
  return {
    username,
    platformAccess: flag(b.platformAccess, true, 'platformAccess'),
    homeroomBotDm: flag(b.homeroomBotDm, false, 'homeroomBotDm'),
    welcomeDm: flag(b.welcomeDm, false, 'welcomeDm'),
    note,
  };
}

/**
 * Make one test account as full admin `actorId`. Everything that decides
 * what the account is commits together: the row, its access, its Journey
 * entry, the audit row and its bot DM place. Only the included OpenRouter key
 * is made after the commit, as sign-up makes it, because it calls out.
 *
 * Returns { userId, username, password, needsUsernameChoice, platformAccess,
 * homeroomBotDm, welcomeDm, note }. The password is in nothing else.
 */
async function create(pool, body, { actorId, config = {} } = {}) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail(403, 'forbidden', 'A full administrator is required.');
  const input = parseCreate(body);
  const password = generatePassword();
  // Hashed before the transaction: bcrypt must not run while locks are held.
  const hash = await bcrypt.hash(password, BCRYPT_COST);

  let created;
  try {
    created = await withTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CAP_LOCK_KEY]);
      const { rows: [{ n }] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM users
          WHERE test_account_created_at IS NOT NULL AND anonymised_at IS NULL`
      );
      if (n >= MAX_LIVE) {
        fail(429, 'at_capacity', `There are already ${n} live test accounts, the most allowed at once. `
          + 'Retire one you have finished with (list_test_accounts shows them), then try again.', { live: n, max: MAX_LIVE });
      }
      if (input.username) {
        const free = await usernames.checkAvailability(client, input.username, null);
        if (!free.available) fail(409, 'username_taken', free.error, { field: 'username' });
      }
      const username = input.username || usernames.placeholderUsername();
      // terms consent and tour_done_at stay unset, so the terms, the
      // community picker, the tour and Getting started all come up as they do
      // for a real newcomer. With no username the account wears a
      // placeholder and needs_username_choice, so the tester picks a handle
      // in the real first-run step (frontend/src/features/auth/
      // username-first-run.js). exclude_podium keeps it off the leaderboards.
      const { rows: [user] } = await client.query(
        `INSERT INTO users (username, password, password_set, needs_username_choice,
                            needs_communities_choice, getting_started_gate, exclude_podium,
                            test_account_created_by, test_account_created_at, test_account_welcome_dm)
         VALUES ($1, $2, TRUE, $3, TRUE, TRUE, TRUE, $4, NOW(), $5)
         RETURNING id, username`,
        [username, hash, !input.username, actorId, input.welcomeDm]
      );
      // Let in the way an invite lets somebody in, never as a release by
      // hand: manualRelease would make it invite generation 0, with skips
      // to hand out. The access triggers run here as for anybody let in —
      // it joins the Homeroom community, and queued community invites apply.
      if (input.platformAccess) await waitlist.grantPlatformAccess(client, user.id);
      await journeyLeftOut.addTestInTransaction(client, {
        userId: user.id, note: input.note || 'Test account (create_test_account)',
      }, { actorId });
      if (input.homeroomBotDm) {
        const homeroomBot = require('./homeroom-bot');
        const dm = await homeroomBot.setDmMember(client, user.username, true, actorId);
        if (!dm.ok) {
          fail(409, dm.error === 'full' ? 'bot_dm_full' : 'bot_dm_unavailable', dm.error === 'full'
            ? `The Homeroom bot's DM list is full (${dm.max} people). Make the account without homeroomBotDm, or free a place first.`
            : 'The Homeroom bot\'s DM list could not be updated. Try again.');
        }
      }
      await client.query(
        `INSERT INTO support_actions (actor_user_id, target_user_id, action, reason, payload)
         VALUES ($1, $2, 'test_account_create', $3, $4::jsonb)`,
        [actorId, user.id, input.note || null, JSON.stringify({
          usernameChosen: !!input.username,
          platformAccess: input.platformAccess,
          homeroomBotDm: input.homeroomBotDm,
          welcomeDm: input.welcomeDm,
        })]
      );
      return user;
    });
  } catch (err) {
    if (err instanceof TestAccountError) throw err;
    if (err && err.code === '23505') fail(409, 'username_taken', 'That username is taken.', { field: 'username' });
    throw err;
  }
  journeyLeftOut.forget(pool);

  // #2568: the included OpenRouter key, as /api/auth/register makes it.
  // Never throws.
  const managedOpenRouter = require('./openrouter-managed-keys');
  await managedOpenRouter.ensureIncludedKey({ pool, userId: created.id, config, reason: 'test_account' });

  log.info('test-accounts', 'Test account created', {
    userId: created.id, by: actorId, usernameChosen: !!input.username,
    platformAccess: input.platformAccess, homeroomBotDm: input.homeroomBotDm, welcomeDm: input.welcomeDm,
  });
  return {
    userId: created.id,
    username: created.username,
    password,
    needsUsernameChoice: !input.username,
    platformAccess: input.platformAccess,
    homeroomBotDm: input.homeroomBotDm,
    welcomeDm: input.welcomeDm,
    note: input.note || null,
  };
}

/**
 * The live test accounts, newest first: who made each, when, when it was
 * last seen (its latest sign-in or day of app use), its note, and the apps it
 * created with their status. Retired (anonymised) ones are not listed.
 */
async function list(pool) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.test_account_created_at AS created_at,
            c.username AS created_by,
            GREATEST(
              (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id),
              (SELECT MAX(aa.date)::timestamptz FROM app_activity aa WHERE aa.user_id = u.id)
            ) AS last_active_at,
            (SELECT sa.reason FROM support_actions sa
              WHERE sa.target_user_id = u.id AND sa.action = 'test_account_create'
              ORDER BY sa.id DESC LIMIT 1) AS note,
            COALESCE((SELECT json_agg(json_build_object('slug', a.slug, 'status', a.status) ORDER BY a.id)
                        FROM apps a WHERE a.created_by = u.id), '[]'::json) AS apps
       FROM users u
       LEFT JOIN users c ON c.id = u.test_account_created_by
      WHERE u.test_account_created_at IS NOT NULL AND u.anonymised_at IS NULL
      ORDER BY u.test_account_created_at DESC, u.id DESC`
  );
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    createdBy: r.created_by || null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    lastActiveAt: r.last_active_at ? new Date(r.last_active_at).toISOString() : null,
    note: r.note || null,
    apps: (Array.isArray(r.apps) ? r.apps : []).map((a) => ({ slug: String(a.slug), status: a.status == null ? null : String(a.status) })),
  }));
}

/**
 * Retire one test account as full admin `actorId`: take down every app it
 * created (the same teardown DELETE /api/apps/:slug runs), then delete the
 * account through the ordinary admin deletion, which anonymises the row,
 * revokes its sessions and native credentials, withdraws its open votes and
 * takes it off the bot's DM list (the username trigger in schema.sql).
 *
 * Refuses any account that is not a test account. If an app cannot be taken
 * down it stops there and reports what it had removed: the account is never
 * deleted with its apps orphaned. Calling it again finishes the job.
 */
async function retire(pool, { userId, confirmation }, { actorId, config = {} } = {}) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail(403, 'forbidden', 'A full administrator is required.');
  if (!Number.isSafeInteger(userId) || userId <= 0) fail(400, 'invalid_request', 'userId must be a test account\'s id.');
  if (confirmation !== RETIRE_CONFIRMATION) {
    fail(400, 'confirmation_required', `Pass confirm: "${RETIRE_CONFIRMATION}" to retire a test account.`);
  }
  const { rows: [user] } = await pool.query(
    'SELECT id, username, test_account_created_at, anonymised_at FROM users WHERE id = $1',
    [userId]
  );
  if (!user || !user.test_account_created_at) {
    fail(404, 'not_test_account', 'That account is not a test account. Only accounts made with create_test_account can be retired here.');
  }
  if (user.anonymised_at) fail(409, 'already_retired', 'That test account has already been retired.');

  const { rows: apps } = await pool.query(
    'SELECT * FROM apps WHERE created_by = $1 ORDER BY id',
    [userId]
  );
  const { teardownApp } = require('./app-teardown');
  const removedApps = [];
  for (const app of apps) {
    try {
      await teardownApp(pool, config, app);
      removedApps.push(app.slug);
    } catch (err) {
      log.error('test-accounts', 'App teardown failed while retiring a test account', {
        userId, slug: app.slug, err: err.message,
      });
      fail(502, 'app_delete_failed', `Could not take down ${app.slug}, so the account was left in place. `
        + 'Nothing else was changed after that app. Retire it again to finish.', {
        removedApps, failedApp: app.slug,
      });
    }
  }

  // Read only to say so in the answer: the deletion's username trigger is
  // what takes the entry off.
  const onBotDm = await isOnBotDmList(pool, user.username);
  const accountDeletion = require('./account-deletion');
  let deletion;
  try {
    deletion = await accountDeletion.deleteAccount(pool, {
      userId, actorId, mode: 'admin', confirmation: 'DELETE',
    });
  } catch (err) {
    if (err instanceof accountDeletion.AccountDeletionError) {
      fail(err.status || 400, err.code || 'delete_failed', err.message, { removedApps });
    }
    throw err;
  }
  await pool.query(
    `INSERT INTO support_actions (actor_user_id, target_user_id, action, payload)
     VALUES ($1, $2, 'test_account_retire', $3::jsonb)`,
    [actorId, userId, JSON.stringify({ username: user.username, apps: removedApps, deletionId: deletion.deletionId })]
  );
  log.info('test-accounts', 'Test account retired', { userId, by: actorId, apps: removedApps.length });
  return {
    userId,
    username: user.username,
    appsDeleted: removedApps,
    homeroomBotDm: onBotDm,
    deletionId: deletion.deletionId,
  };
}

async function isOnBotDmList(pool, username) {
  const { rows } = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'homeroom_bot_dm_users'"
  );
  try {
    const members = JSON.parse(rows[0] ? rows[0].value : '[]');
    return Array.isArray(members) && members.includes(String(username).toLowerCase());
  } catch {
    return false;
  }
}

module.exports = {
  MAX_LIVE,
  NOTE_MAX,
  RETIRE_CONFIRMATION,
  TestAccountError,
  create,
  list,
  retire,
  generatePassword,
};
