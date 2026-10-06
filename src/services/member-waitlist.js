'use strict';

/**
 * THE WAITLIST, FROM INSIDE. A private member (users.private_member_since in
 * schema.sql) is already in their community's apps; what they wait for is
 * making apps of their own. Their Home's waitlist card joins them to the same
 * waitlist everybody else joins (services/waitlist.js, waitlist_signups), with
 * two differences that come from already having an account:
 *
 *   - the row is LINKED to the account (linked_user_id), so releasing it is
 *     the ordinary release: releaseWaitlistSignup grants the account access,
 *     which ends the private tier by itself;
 *   - the address is confirmed by the account, not the join mail: the
 *     account's own confirmed email joins with one press, and any other
 *     address is confirmed with the waitlist's 6-digit code first.
 *
 * An address that belongs to another Homeroom account is refused, whichever
 * way it arrives: there is no merging two accounts here.
 *
 * The answers to "Want in sooner?" ride the row's own capability token
 * (more_token): the card links to #more/<token>, the page every waitlist
 * signup's mail already links to.
 */

const waitlist = require('./waitlist');
const log = require('./logger');

class MemberWaitlistError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const IN_USE = 'That email is already on another Homeroom account. Use a different one.';

/**
 * Where `userId` stands: `{ state, email, accountEmail, moreToken }`.
 *   state 'none'      not on the waitlist (or only an unconfirmed address);
 *         'listed'    on it, address confirmed;
 *         'admitted'  their row was released.
 * `accountEmail` is the account's own confirmed address, which the join form
 * offers; null when it has none.
 */
async function stateFor(pool, userId) {
  const { rows } = await pool.query(
    `SELECT u.email, u.email_confirmed,
            w.email AS listed_email, w.confirmed_at, w.released_at, w.more_token
       FROM users u
       LEFT JOIN LATERAL (
         SELECT email, confirmed_at, released_at, more_token
           FROM waitlist_signups
          WHERE linked_user_id = u.id
          ORDER BY (confirmed_at IS NULL), submitted_at
          LIMIT 1
       ) w ON TRUE
      WHERE u.id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row) throw new MemberWaitlistError('not_found', 'Account not found.', 404);
  const accountEmail = row.email_confirmed ? waitlist.normalizeEmail(row.email) : null;
  let state = 'none';
  if (row.released_at) state = 'admitted';
  else if (row.confirmed_at) state = 'listed';
  return {
    state,
    email: state === 'none' ? null : row.listed_email,
    accountEmail,
    moreToken: state === 'listed' ? row.more_token || null : null,
  };
}

/** Another account holds `email` (as its address, or its waitlist row's link). */
async function heldByAnother(pool, userId, email) {
  const { rows } = await pool.query(
    `SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2
     UNION ALL
     SELECT 1 FROM waitlist_signups WHERE email = $1 AND linked_user_id IS NOT NULL AND linked_user_id <> $2
     LIMIT 1`,
    [email, userId]
  );
  return rows.length > 0;
}

/** Link the (confirmed) row for `email` to `userId`, the way an account-creation link does. */
async function linkConfirmed(pool, userId, email) {
  await pool.query(
    `UPDATE waitlist_signups
        SET linked_user_id = $1,
            confirmed_at = COALESCE(confirmed_at, NOW())
      WHERE email = $2 AND (linked_user_id IS NULL OR linked_user_id = $1)`,
    [userId, email]
  );
  // A row that was released before it was linked lets them in now
  // (linkUserByEmail's own rule for an account made from a released address).
  await waitlist.linkUserByEmail(pool, { userId, email });
}

/**
 * Join with `rawEmail`. Returns `{ next: 'listed', ...state }` when the
 * address is the account's own confirmed one, or `{ next: 'code', email }`
 * after mailing a code to any other. `send(email, code)` mails it.
 */
async function join(pool, { userId, rawEmail, ip = null, send }) {
  const email = waitlist.normalizeEmail(rawEmail);
  if (!email) throw new MemberWaitlistError('invalid_email', 'Enter a valid email address.');
  if (await heldByAnother(pool, userId, email)) throw new MemberWaitlistError('email_in_use', IN_USE, 409);

  await waitlist.joinWaitlist(pool, { email, ip });
  const { rows } = await pool.query('SELECT email, email_confirmed FROM users WHERE id = $1', [userId]);
  const own = rows[0] && rows[0].email_confirmed && waitlist.normalizeEmail(rows[0].email) === email;
  if (own) {
    await linkConfirmed(pool, userId, email);
    return { next: 'listed', ...(await stateFor(pool, userId)) };
  }

  // Exactly one live code per address (issuing deletes the rest), and none
  // re-minted inside the reuse window: the mail that carried it is out.
  if (!(await waitlist.hasReusableCode(pool, email))) {
    const code = await waitlist.issueVerificationCode(pool, email);
    send(email, code);
  }
  return { next: 'code', email };
}

/** Confirm `rawEmail` with the code mailed to it, and join. */
async function verify(pool, { userId, rawEmail, code }) {
  const email = waitlist.normalizeEmail(rawEmail);
  if (!email) throw new MemberWaitlistError('invalid_email', 'Enter a valid email address.');
  if (await heldByAnother(pool, userId, email)) throw new MemberWaitlistError('email_in_use', IN_USE, 409);
  const signup = await waitlist.confirmSignupByCode(pool, email, typeof code === 'string' ? code.trim() : '');
  if (!signup) throw new MemberWaitlistError('invalid_code', 'That code is not right, or it has expired.');
  await linkConfirmed(pool, userId, email);
  // An account with no address of its own (a phone sign-up) takes this one,
  // so it can sign in with it too. One already set is left alone.
  try {
    await pool.query(
      `UPDATE users
          SET email = $2, email_confirmed = TRUE, email_confirmed_at = COALESCE(email_confirmed_at, NOW())
        WHERE id = $1 AND (email IS NULL OR email = '')`,
      [userId, email]
    );
  } catch (err) {
    log.warn('member-waitlist', 'Could not record the confirmed address on the account', { userId, err: err.message });
  }
  return { next: 'listed', ...(await stateFor(pool, userId)) };
}

module.exports = { MemberWaitlistError, stateFor, join, verify };
