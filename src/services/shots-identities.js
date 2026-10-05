'use strict';

// Shots uses non-interactive fixture identities: a normal member, a
// read-only administrator, and a full administrator that exists only in the
// paired disposable databases. Their passwords cannot be used to sign in;
// short-lived app-scoped iframe JWTs are minted only for a controlled run.
// A fourth browser, the guest, is not signed in at all (shotsGuestIdentity).

const appAccess = require('./app-access');
const edgeGate = require('./edge-gate');
const platformJwt = require('./platform-jwt');
const visuals = require('./visuals');
const fixtures = require('./shots-fixtures');

async function mintShotsAuthTokens(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, username, usernode_pubkey, locale, is_admin, admin_readonly
       FROM users
      WHERE username = ANY($1::text[])`,
    [[visuals.CAPTURE_USERNAME, visuals.CAPTURE_ADMIN_USERNAME]]
  );
  const byName = new Map(rows.map((row) => [row.username, row]));
  const member = byName.get(visuals.CAPTURE_USERNAME);
  const admin = byName.get(visuals.CAPTURE_ADMIN_USERNAME);
  if (!member) throw new Error('The shots member fixture identity is unavailable.');
  if (!admin || admin.is_admin !== true || admin.admin_readonly !== true) {
    throw new Error('The shots read-only administrator fixture identity is unavailable or unsafe.');
  }
  return {
    member: visuals.mintCaptureToken(member, appId),
    read_only_admin: visuals.mintCaptureToken(admin, appId),
    // Production has no full-admin service-account row. This token can only
    // become a session inside a shots clone, where resetPair inserts the
    // matching non-loginable identity. Production ignores iframe tokens and
    // ordinary staging clones do not contain the reserved user id.
    full_admin: visuals.mintCaptureToken({
      id: fixtures.FULL_ADMIN_USER_ID,
      username: fixtures.FULL_ADMIN_USERNAME,
      usernode_pubkey: null,
      locale: 'en',
    }, appId),
  };
}

// What the guest browser is to the app it shoots, and the token it carries
// if any. Homeroom's own copies show a browser with no session their
// signed-out pages, so it needs nothing. A child app learns of a visitor
// with no account only from the guest token the production edge adds at a
// view-public app's own address (services/edge-gate.js); the shots copies
// have no edge in front of them, so the shots proxy adds one instead. It is
// minted only where the edge would mint it: the app is view-public by the
// edge's own lookup and not suspended, app-host sign-in is on, and the
// platform can sign guests at all. Anywhere else the guest carries no
// identity, and the app shows it what it shows a signed-out visitor outside
// Homeroom. The kind is one of 'homeroom', 'guest' (a token), 'private'
// (view-private, or suspended, where the edge admits nobody) and
// 'unavailable' (guests are off here, or there is no guest signer).
async function shotsGuestIdentity(pool, app, { selfApp = false } = {}) {
  if (selfApp) return { kind: 'homeroom', token: null };
  const visibility = app?.slug ? await appAccess.getHostVisibility(pool, app.slug) : null;
  if (!visibility || Number(visibility.appId) !== Number(app.id)
      || visibility.viewPrivate || visibility.suspended) {
    return { kind: 'private', token: null };
  }
  if (!edgeGate.signinEnabled() || !platformJwt.guestPublicKeyPem()) {
    return { kind: 'unavailable', token: null };
  }
  return {
    kind: 'guest',
    token: platformJwt.signGuestToken({ appId: Number(app.id), ttl: platformJwt.CAPTURE_TTL }),
  };
}

module.exports = { mintShotsAuthTokens, shotsGuestIdentity };
