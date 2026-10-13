'use strict';

/**
 * A staging-only invite link, so the signed-out invite page
 * (frontend/src/features/auth/invite-card.tsx) can be opened, and shot
 * before and after a change, with no setup: /invite/stagingdemoinvite00001.
 *
 * It has no row in community_invites. routes/community-invites.js answers
 * its preview from here, and only when USERNODE_ENV is 'staging'; anywhere
 * else the token is one more unknown link (preview() finds no row). It is
 * never redeemable, on staging either: the page sets no invite cookie for
 * it, so a sign-in from it follows nothing, and the signed-in reads answer
 * it as a link that does not work. Joining it grants nothing.
 */

// The real token shape (community-invites.js TOKEN_RE: 22 of [A-Za-z0-9_-]).
const DEMO_INVITE_TOKEN = 'stagingdemoinvite00001';

function isStaging(env = process.env.USERNODE_ENV) {
  return env === 'staging';
}

/** Whether this token is the demo link AND this server is staging. */
function isDemoInvite(token, env = process.env.USERNODE_ENV) {
  return isStaging(env) && token === DEMO_INVITE_TOKEN;
}

/** The preview the signed-out page draws: an obviously pretend project. */
function demoInvitePreview() {
  return {
    live: true,
    reason: null,
    project: {
      name: 'Staging demo community',
      iconEmoji: '🧪',
      iconUrl: null,
      description: 'A pretend project for screenshots on staging. Joining it does nothing.',
      picture: null,
      public: false,
    },
    inviter: 'demo_inviter',
    inviterName: 'Dana Demo',
    inviterMadeIt: true,
    building: false,
    note: 'Come and see what we are building.',
    memberCount: 26,
    expiresAt: null,
    demo: true,
  };
}

/** What the signed-in reads say of it: a link that does not work. */
function demoInviteDead() {
  return { live: false, reason: 'unknown', demo: true, mine: null, slug: null };
}

module.exports = {
  DEMO_INVITE_TOKEN,
  isDemoInvite,
  demoInvitePreview,
  demoInviteDead,
};
