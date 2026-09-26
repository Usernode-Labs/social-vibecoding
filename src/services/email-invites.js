'use strict';

/**
 * Inviting somebody into a project by EMAIL (the create dialog's "Will
 * invite" rows), for a person who may not be on Homeroom yet.
 *
 * Two halves, one table (`app_email_invites`, src/db/schema.sql):
 *
 *   inviteByEmail    at creation. An address already confirmed on an
 *                    account invites that account, exactly as a @username
 *                    would (services/collab-invites.js), and is not stored.
 *                    Any other address is stored against the project and
 *                    mailed a link to the waitlist. The creator is told the
 *                    same thing either way ("Will invite"), so the screen
 *                    never says who has an account.
 *   claimEmailInvites  when an address is confirmed on an account (email
 *                    sign-up, or adding it in Settings). Each waiting invite
 *                    becomes an ordinary pending collaborator invite, with
 *                    its notification, and the row is stamped claimed.
 *
 * Nothing here grants platform access: the invited person joins the waitlist
 * like anyone else, and the invite waits for them. Both halves are
 * best-effort for the caller — a failed mail or claim is logged, never
 * thrown into a create or a sign-up.
 */

const log = require('./logger');
const collabInvites = require('./collab-invites');
const mail = require('./mail');

const normalize = (email) => String(email || '').trim().toLowerCase();

/**
 * Invite each address into `app` ({ id, slug, name }) for `inviter`
 * ({ id, username }). Returns `{ invited, mailed }`: accounts invited
 * directly, and addresses stored and mailed.
 */
async function inviteByEmail(pool, config, { app, emails, inviter }) {
  let invited = 0;
  let mailed = 0;
  for (const raw of emails || []) {
    const email = normalize(raw);
    if (!email) continue;
    try {
      const { rows: owners } = await pool.query(
        `SELECT id, username FROM users
          WHERE lower(email) = $1 AND email_confirmed = TRUE
          LIMIT 1`,
        [email]
      );
      const owner = owners[0];
      if (owner) {
        if (owner.id !== inviter.id) {
          const sent = await collabInvites.sendInvite(pool, { app, target: owner, inviterId: inviter.id });
          if (sent.ok) invited += 1;
        }
        continue;
      }
      const { rows: stored } = await pool.query(
        `INSERT INTO app_email_invites (app_id, email, invited_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (app_id, email) DO NOTHING
         RETURNING id`,
        [app.id, email, inviter.id]
      );
      if (!stored.length) continue;
      await mail.sendProjectInviteMail(config, email, { inviter: inviter.username || null, project: app.name || null });
      mailed += 1;
    } catch (err) {
      log.warn('email-invites', 'Invite by email failed', { appId: app.id, err: err.message });
    }
  }
  return { invited, mailed };
}

/**
 * Turn the invites waiting on `email` into pending collaborator invites for
 * `userId`, now that the address is confirmed on that account. Never throws;
 * returns how many it turned.
 */
async function claimEmailInvites(pool, { userId, email }) {
  const address = normalize(email);
  if (!userId || !address) return 0;
  let claimed = 0;
  try {
    const { rows: waiting } = await pool.query(
      `UPDATE app_email_invites
          SET claimed_at = NOW(), claimed_by = $2
        WHERE email = $1 AND claimed_at IS NULL
        RETURNING app_id, invited_by`,
      [address, userId]
    );
    if (!waiting.length) return 0;
    const { rows: users } = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    const target = users[0];
    if (!target) return 0;
    for (const invite of waiting) {
      try {
        const { rows: apps } = await pool.query('SELECT id, slug, name FROM apps WHERE id = $1', [invite.app_id]);
        if (!apps[0]) continue;
        const sent = await collabInvites.sendInvite(pool, { app: apps[0], target, inviterId: invite.invited_by });
        if (sent.ok) claimed += 1;
      } catch (err) {
        log.warn('email-invites', 'Claiming an invite failed', { appId: invite.app_id, err: err.message });
      }
    }
  } catch (err) {
    log.warn('email-invites', 'Claiming invites failed', { userId, err: err.message });
  }
  return claimed;
}

module.exports = { inviteByEmail, claimEmailInvites };
