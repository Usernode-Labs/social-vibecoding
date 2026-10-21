'use strict';

// Who can reach you, and who can find you (#5104).
//
// Two per-account settings, both safe by default and both loosened only by
// their owner in Settings › Privacy:
//
//   users.contact_policy        'shared' (default) | 'anyone'
//   users.profile_discoverable  FALSE (default) | TRUE
//
// The rules themselves are SQL functions in src/db/schema.sql
// (users_connected, user_contactable_by, user_discoverable_by), so a search
// can filter by them in the same statement and every write path asks the
// same question. This module is the JavaScript side: reading and saving the
// two settings, and the one refusal every write path answers with.

const POLICIES = Object.freeze(['shared', 'anyone']);

// The refusal a sender gets when the person they named only takes new
// conversations and invitations from people they are connected to. It says
// what to do instead and nothing about the person: not whether they blocked
// you, not which projects they are in. A screen shows its own words for the
// code (frontend catalogs `contactRestricted`); this sentence is for any
// other caller.
const CONTACT_RESTRICTED_CODE = 'contact_restricted';
const CONTACT_RESTRICTED_MESSAGE = 'This person only takes new messages and invitations from people in projects with them. '
  + 'Send them an invite link instead.';
const CONTACT_RESTRICTED = Object.freeze({
  error: CONTACT_RESTRICTED_MESSAGE,
  code: CONTACT_RESTRICTED_CODE,
});

class ContactRestrictedError extends Error {
  constructor() {
    super(CONTACT_RESTRICTED_MESSAGE);
    this.name = 'ContactRestrictedError';
    this.code = CONTACT_RESTRICTED_CODE;
    this.status = 403;
  }
}

function shape(row) {
  return {
    whoCanContact: row && row.contact_policy === 'anyone' ? 'anyone' : 'shared',
    discoverable: !!(row && row.profile_discoverable),
  };
}

async function readSettings(db, userId) {
  const { rows } = await db.query(
    'SELECT contact_policy, profile_discoverable FROM users WHERE id = $1',
    [userId]
  );
  return rows.length ? shape(rows[0]) : null;
}

// Validates a partial update: `whoCanContact` and `discoverable` are each
// optional, at least one is required. Returns { ok, value } or { ok: false, error }.
function parseUpdate(body) {
  const input = body && typeof body === 'object' ? body : {};
  const value = {};
  if (input.whoCanContact !== undefined) {
    if (!POLICIES.includes(input.whoCanContact)) {
      return { ok: false, error: `whoCanContact must be one of ${POLICIES.join(', ')}` };
    }
    value.whoCanContact = input.whoCanContact;
  }
  if (input.discoverable !== undefined) {
    if (typeof input.discoverable !== 'boolean') return { ok: false, error: 'discoverable must be a boolean' };
    value.discoverable = input.discoverable;
  }
  if (!Object.keys(value).length) return { ok: false, error: 'Nothing to change' };
  return { ok: true, value };
}

async function saveSettings(db, userId, value) {
  const { rows } = await db.query(
    `UPDATE users
        SET contact_policy = COALESCE($2::varchar, contact_policy),
            profile_discoverable = COALESCE($3::boolean, profile_discoverable)
      WHERE id = $1
      RETURNING contact_policy, profile_discoverable`,
    [userId, value.whoCanContact ?? null, value.discoverable ?? null]
  );
  return rows.length ? shape(rows[0]) : null;
}

// Whether `senderId` may start something new with `targetId`.
async function mayContact(db, senderId, targetId) {
  const { rows } = await db.query(
    'SELECT user_contactable_by($1, $2) AS ok',
    [targetId, senderId]
  );
  return !!(rows[0] && rows[0].ok);
}

// The ids in `targetIds` that `senderId` may NOT start something with.
async function restrictedAmong(db, senderId, targetIds) {
  if (!targetIds || !targetIds.length) return [];
  const { rows } = await db.query(
    `SELECT t.id FROM unnest($2::int[]) AS t(id)
      WHERE NOT user_contactable_by(t.id, $1)`,
    [senderId, targetIds]
  );
  return rows.map((row) => row.id);
}

module.exports = {
  POLICIES,
  CONTACT_RESTRICTED,
  CONTACT_RESTRICTED_CODE,
  CONTACT_RESTRICTED_MESSAGE,
  ContactRestrictedError,
  readSettings,
  parseUpdate,
  saveSettings,
  mayContact,
  restrictedAmong,
};
