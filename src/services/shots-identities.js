'use strict';

// Shots uses non-interactive fixture identities: a normal member, a
// read-only administrator, and a full administrator that exists only in the
// paired disposable databases. Their passwords cannot be used to sign in;
// short-lived app-scoped iframe JWTs are minted only for a controlled run.
// A fourth browser, the guest, is not signed in at all (shotsGuestIdentity).
// To an app built on Homeroom the three are ordinary signed-in people: its
// token says who is signed in, never a role in the app, so none of them is
// the app's creator or one of its admins, and no real person's identity is
// ever lent to one (personaWarnings, and the brief's appRoles).

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

// Words in a change's claim, path or focus that put it on a screen kept for
// the app's creator, owner or admins ("Creator Studio", "/#/admin").
const ROLE_WORDS = /\b(?:creators?|owners?|admins?|administrators?)\b/i;
const ADMIN_PERSONAS = new Set(['read_only_admin', 'full_admin']);

// What follows either role warning: what the shots can and cannot do.
const ROLE_ADVICE = 'A screen the app keeps for particular accounts (its creator, a list of usernames or ids) '
  + 'cannot be shot, and the shots agent will skip it. If a signed-in person can get the role through the app '
  + 'itself, say how in hints.setup; otherwise declare what a member sees and say in the claim what the shots '
  + 'leave out.';

function roleText(story) {
  const intent = story.intent || {};
  return [story.claim, intent.startPath, intent.focus, intent.checkpoint].filter(Boolean).join(' ');
}

// What the author should know, when a change is declared, about whose
// browser the shots agent will use for it. Three declarations kept failing:
// a guest change on an app whose guests are shown nothing of it (the guest
// browser only finds the sign-in wall a signed-out visitor gets outside
// Homeroom), a claim about signed-out visitors declared for a signed-in
// persona (that browser cannot sign out), and, on an app built on Homeroom,
// a screen kept for the app's own creator or admins. Homeroom tells such an
// app who is signed in, never their role in it (platform-jwt.js
// signAppIdentityToken), so no shots browser is its creator or one of its
// admins: the two administrator personas are Homeroom's, which the app is
// never told. Three runs on one app's Creator Studio (QuestVerse's PRs 7 to
// 9) were refused for every persona that way. These are warnings, never
// refusals: a change to the sign-in wall itself is a real guest change, and
// a role the app grants in its own UI is reachable through hints.setup.
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
  if (!selfApp) {
    const signedIn = stories.filter((story) => story.persona !== 'guest');
    const admins = signedIn.filter((story) => ADMIN_PERSONAS.has(story.persona)).map((story) => story.id);
    if (admins.length) {
      warnings.push(`${admins.join(', ')} ${admins.length > 1 ? 'are' : 'is'} declared for an administrator `
        + 'persona, but read_only_admin and full_admin are Homeroom administrators, which this app is not told: '
        + 'it sees an ordinary signed-in person, as with member, and no shots browser is its creator or one of '
        + `its admins. ${ROLE_ADVICE}`);
    }
    const roles = signedIn.filter((story) => !ADMIN_PERSONAS.has(story.persona)
      && !story.intent?.hints?.setup && ROLE_WORDS.test(roleText(story))).map((story) => story.id);
    if (roles.length) {
      warnings.push(`${roles.join(', ')} ${roles.length > 1 ? 'describe' : 'describes'} a screen for this app's `
        + 'creator, owner or admins, but no shots browser holds a role in this app: Homeroom tells an app who '
        + `is signed in, never their role in it. ${ROLE_ADVICE}`);
    }
  }
  return warnings;
}

module.exports = { mintShotsAuthTokens, shotsGuestKind, shotsGuestIdentity, personaWarnings };
