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

// #7159: one row per device. The platform keeps no name or hardware id for a
// phone: an installation is one install of the app, and a reinstall is a new
// one, so a person who reinstalled saw the same phone many times. The only
// thing two installs of one phone share on the server is their kind, so a
// device is every install of one kind: 'ios', 'android', or 'phone' when the
// kind is unknown (the install never registered for notifications). Two
// different iPhones are therefore one row too, which the page's note says.
const PHONE_DEVICE_KEYS = new Set(['ios', 'android', 'phone']);

function isPhoneDeviceKey(value) {
  return typeof value === 'string' && PHONE_DEVICE_KEYS.has(value);
}

function phoneDeviceKey(phone) {
  return phone && (phone.platform === 'ios' || phone.platform === 'android') ? phone.platform : 'phone';
}

function newest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

// The devices of a listLinkedPhones result: `count` is how many installs the
// device holds, the dates are the newest among them, and `current` is true
// when any of them is the phone in hand. The device in hand first, then by
// last use, then by key.
function groupLinkedPhones(phones) {
  const byKey = new Map();
  for (const phone of phones || []) {
    const key = phoneDeviceKey(phone);
    const device = byKey.get(key);
    if (!device) {
      byKey.set(key, {
        key,
        platform: key === 'phone' ? null : key,
        count: 1,
        linkedAt: phone.linkedAt || null,
        lastUsedAt: phone.lastUsedAt || null,
        current: phone.current === true,
      });
    } else {
      device.count += 1;
      device.linkedAt = newest(device.linkedAt, phone.linkedAt);
      device.lastUsedAt = newest(device.lastUsedAt, phone.lastUsedAt);
      device.current = device.current || phone.current === true;
    }
  }
  return [...byKey.values()].sort((a, b) => (
    Number(b.current) - Number(a.current)
    || (Date.parse(b.lastUsedAt) || 0) - (Date.parse(a.lastUsedAt) || 0)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  ));
}

// Unlink every install of one device of the account. The installs are read
// inside the caller's transaction and each is revoked as unlinkPhone revokes
// one, so an install made after the page loaded goes too. Answers how many
// installs went (0 for an unknown key or a device with none, the route's
// 404) and whether the phone in hand was one of them.
async function unlinkPhoneDevice(client, userId, key, { currentCredential = null } = {}) {
  if (!isPhoneDeviceKey(key)) return { unlinked: 0, current: false };
  const phones = (await listLinkedPhones(client, userId, { currentCredential }))
    .filter((phone) => phoneDeviceKey(phone) === key);
  let unlinked = 0;
  for (const phone of phones) {
    const { credentialsRevoked } = await revokeInstallationNativeSessionCredentials(client, {
      userId,
      installationId: phone.id,
    });
    if (credentialsRevoked > 0) unlinked += 1;
  }
  return { unlinked, current: unlinked > 0 && phones.some((phone) => phone.current) };
}

module.exports = {
  isPhoneId,
  listLinkedPhones,
  unlinkPhone,
  isPhoneDeviceKey,
  phoneDeviceKey,
  groupLinkedPhones,
  unlinkPhoneDevice,
};
