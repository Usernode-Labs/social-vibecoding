'use strict';

// Evidence uses the platform's non-interactive fixture identities: a normal
// member and a read-only administrator. Their discarded passwords cannot be
// used to sign in; short-lived app-scoped iframe JWTs are minted only for the
// duration of a controlled run.

const visuals = require('./visuals');

async function mintEvidenceAuthTokens(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, username, usernode_pubkey, locale, is_admin, admin_readonly
       FROM users
      WHERE username = ANY($1::text[])`,
    [[visuals.CAPTURE_USERNAME, visuals.CAPTURE_ADMIN_USERNAME]]
  );
  const byName = new Map(rows.map((row) => [row.username, row]));
  const member = byName.get(visuals.CAPTURE_USERNAME);
  const admin = byName.get(visuals.CAPTURE_ADMIN_USERNAME);
  if (!member) throw new Error('The visual-evidence member fixture identity is unavailable.');
  if (!admin || admin.is_admin !== true || admin.admin_readonly !== true) {
    throw new Error('The visual-evidence read-only administrator fixture identity is unavailable or unsafe.');
  }
  return {
    member: visuals.mintCaptureToken(member, appId),
    read_only_admin: visuals.mintCaptureToken(admin, appId),
  };
}

module.exports = { mintEvidenceAuthTokens };
