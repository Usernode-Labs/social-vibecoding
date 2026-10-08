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
    // The invited members, minted from the same constants for the same
    // reason: the matching non-loginable identities exist only in the paired
    // disposable databases (resetPair inserts them), and the token can only
    // become a session inside a shots clone, where a private member passes
    // the platform-access gate (middleware/auth.js isPrivateMember).
    invited_member: visuals.mintCaptureToken({
      id: fixtures.INVITED_USER_ID,
      username: fixtures.INVITED_USERNAME,
      usernode_pubkey: null,
      locale: 'en',
    }, appId),
    invited_member_listed: visuals.mintCaptureToken({
      id: fixtures.INVITED_LISTED_USER_ID,
      username: fixtures.INVITED_LISTED_USERNAME,
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
async function shotsGuestKind(pool, app, { selfApp = false } = {}) {
  if (selfApp) return 'homeroom';
  const visibility = app?.slug ? await appAccess.getHostVisibility(pool, app.slug) : null;
  if (!visibility || Number(visibility.appId) !== Number(app.id)
      || visibility.viewPrivate || visibility.suspended) {
    return 'private';
  }
  if (!edgeGate.signinEnabled() || !platformJwt.guestPublicKeyPem()) return 'unavailable';
  return 'guest';
}

async function shotsGuestIdentity(pool, app, options = {}) {
  const kind = await shotsGuestKind(pool, app, options);
  if (kind !== 'guest') return { kind, token: null };
  return {
    kind,
    token: platformJwt.signGuestToken({ appId: Number(app.id), ttl: platformJwt.CAPTURE_TTL }),
  };
}

// Words in a claim that describe a visitor who is not signed in.
const SIGNED_OUT_WORDS = /\b(?:signed[- ]out|logged[- ]out|not signed in|not logged in|without an account)\b/i;

// What the author should know, when a change is declared, about whose
// browser the shots agent will use for it. Two declarations kept failing:
// a guest change on an app whose guests are shown nothing of it (the guest
// browser only finds the sign-in wall a signed-out visitor gets outside
// Homeroom), and a claim about signed-out visitors declared for a signed-in
// persona (that browser cannot sign out). These are warnings, never
// refusals: a change to the sign-in wall itself is a real guest change.
async function personaWarnings(pool, app, intent, { selfApp = false } = {}) {
  const stories = Array.isArray(intent?.stories) ? intent.stories : [];
  const warnings = [];
  const guests = stories.filter((story) => story.persona === 'guest').map((story) => story.id);
  if (guests.length) {
    const kind = await shotsGuestKind(pool, app, { selfApp });
    if (kind === 'private' || kind === 'unavailable') {
      warnings.push(`${guests.join(', ')} ${guests.length > 1 ? 'are' : 'is'} declared for guest, but `
        + (kind === 'private' ? 'this app is private, so ' : 'guests are not available for this app, so ')
        + 'a visitor who is not signed in only sees what a signed-out visitor sees outside Homeroom, '
        + 'usually a sign-in page. If the change is for people who are signed in, declare it again with persona member.');
    }
  }
  const signedOut = stories.filter((story) => story.persona !== 'guest' && SIGNED_OUT_WORDS.test(story.claim || ''))
    .map((story) => story.id);
  if (signedOut.length) {
    warnings.push(`${signedOut.join(', ')} describes a visitor who is not signed in, but is declared for a `
      + 'signed-in persona, whose browser cannot sign out. If the change is what signed-out visitors see, '
      + 'declare it again with persona guest.');
  }
  return warnings;
}

module.exports = { mintShotsAuthTokens, shotsGuestKind, shotsGuestIdentity, personaWarnings };
