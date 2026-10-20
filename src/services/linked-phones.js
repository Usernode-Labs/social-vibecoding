'use strict';

// Settings › Linked phones (#4938): the phones signed in to your account
// through the Homeroom app, and a way to unlink one.
//
// A linked phone is one native installation holding a still-valid native
// session credential of this account (native_session_credentials, with its
// mobile bearer in mobile_auth_tokens). An installation that signed in more
// than once is still one phone. What the list can say about it is what the
// platform keeps: its kind (from its push registration, when it has one),
// when it was linked, and when the app last used it. The id a row carries is
// the installation's own reference, which is no authority by itself: the
// route only ever acts on the signed-in account's own rows.

const { revokeInstallationNativeSessionCredentials } = require('./native-session-revocation');

const PHONE_ID = /^nsi_[A-Za-z0-9_-]{43}$/;

function isPhoneId(value) {
  return typeof value === 'string' && PHONE_ID.test(value);
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// `currentCredential` is the credential the caller's own web session was
// restored from, when it was (sessions.native_session_credential_reference):
// that phone is the one in your hand, and the list says so.
async function listLinkedPhones(db, userId, { currentCredential = null } = {}) {
  const { rows } = await db.query(
    `SELECT c.installation_id AS id,
            MIN(c.created_at) AS linked_at,
            MAX(COALESCE(t.last_used_at, c.created_at)) AS last_used_at,
            (ARRAY_AGG(p.platform ORDER BY p.last_seen_at DESC)
               FILTER (WHERE p.platform IS NOT NULL))[1] AS platform,
            BOOL_OR(c.credential_reference = $2) AS current
       FROM native_session_credentials c
       JOIN mobile_auth_tokens t
         ON t.id = c.mobile_auth_token_id AND t.user_id = c.user_id
       LEFT JOIN mobile_push_registrations p
         ON p.native_session_credential_reference = c.credential_reference
        AND p.user_id = c.user_id
      WHERE c.user_id = $1 AND c.state = 'valid' AND c.expires_at > NOW()
      GROUP BY c.installation_id
      ORDER BY BOOL_OR(c.credential_reference = $2) DESC,
               MAX(COALESCE(t.last_used_at, c.created_at)) DESC,
               c.installation_id`,
    [userId, currentCredential]
  );
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform === 'android' || row.platform === 'ios' ? row.platform : null,
    linkedAt: toIso(row.linked_at),
    lastUsedAt: toIso(row.last_used_at),
    current: row.current === true,
  }));
}

// Unlink one of the account's own phones. Answers false when the account
// has no valid credential on that installation, which the route says as a
// 404: another account's phone and a phone already unlinked look the same.
async function unlinkPhone(client, userId, phoneId) {
  if (!isPhoneId(phoneId)) return false;
  const { credentialsRevoked } = await revokeInstallationNativeSessionCredentials(client, {
    userId,
    installationId: phoneId,
  });
  return credentialsRevoked > 0;
}

module.exports = { isPhoneId, listLinkedPhones, unlinkPhone };
