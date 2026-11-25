'use strict';

// One place that answers "where is this person's picture?" (#7135).
//
// Every API that hands a client a person's picture used to build
// `avatar_id ? '/avatars/<id>' : null` by hand, and every screen then had to
// choose a fallback for null. A person without a photo now has a generated
// picture of their own, so the helper returns its address instead: the
// screens need no per-screen decision, and the picture is the same one
// everywhere. Null is reserved for "no account is known" (a deleted sender,
// a row with no user id), where an initial in a circle is still right.

const { generatedAvatarToken } = require('./generated-avatar');

/** The generated picture's address for an account, or null with no account. */
function generatedAvatarUrl(userId) {
  if (!userId) return null;
  return `/avatars/g/${generatedAvatarToken(userId)}.svg`;
}

/** The uploaded photo when there is one, else the account's generated picture. */
function avatarUrlFor(avatarId, userId) {
  if (avatarId) return `/avatars/${avatarId}`;
  return generatedAvatarUrl(userId);
}

module.exports = { generatedAvatarUrl, avatarUrlFor };
