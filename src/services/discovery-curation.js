'use strict';

// Where an app stands in Discover. No admin review: an app that runs and has
// an icon is listed, and one that cannot run or has no icon to draw goes under
// Show more. The one editorial state is an admin's flag, which takes an app
// out of Discover and Featured (the signed-in Discover, Home's Discover rail
// and the signed-out landing) until an admin clears it. A flag hides nothing
// else: the app still opens from a link, its members still have it, and its
// own pages still answer.
//
// The flag lives in the columns #1523's directory review used
// (apps.directory_review_status, directory_reviewed_at), so retiring the
// review changed no schema: 'demo' or 'broken' is flagged, anything else is
// not, and directory_reviewed_at is when it was flagged. The flag route
// (routes/admin-featured-apps.js) writes FLAGGED and clears to UNFLAGGED, so
// those are the only two values new writes leave. directory_reviewed_sha is
// no longer read or written.
const FLAGGED_STATES = ['demo', 'broken'];
const FLAGGED = 'broken';
const UNFLAGGED = 'unreviewed';

function timestamp(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function hasIcon(app) {
  return !!(app && [app.icon_image_id, app.icon_url, app.icon_emoji]
    .some((value) => typeof value === 'string' && value.trim()));
}

function isFlagged(app) {
  return FLAGGED_STATES.includes(app?.directory_review_status);
}

// `tier` is where Discover puts the app: 'listed', 'more' (under Show more)
// or 'hidden' (flagged: left out). `label` is the word a row shows for it,
// null for a listed app.
function describe(app) {
  const flagged = isFlagged(app);
  const flaggedAt = flagged ? timestamp(app.directory_reviewed_at) : null;
  let state = 'listed';
  let tier = 'listed';
  let label = null;
  if (flagged) { state = 'flagged'; tier = 'hidden'; label = 'Hidden from Discover'; }
  else if (app?.status !== 'running') { state = 'unavailable'; tier = 'more'; label = 'Not running'; }
  else if (!hasIcon(app)) { state = 'missing_icon'; tier = 'more'; label = 'Needs an icon'; }
  return { state, tier, label, flagged, flaggedAt: flaggedAt === null ? null : new Date(flaggedAt).toISOString() };
}

// What featuring an app needs: an icon for its card, and no flag. Null when
// it can be featured, else the reason, in a sentence an admin can act on.
function featureRefusal(app) {
  if (isFlagged(app)) return 'is flagged, so it is hidden from Discover. Clear the flag before featuring it.';
  if (!hasIcon(app)) return 'has no icon. Add an emoji or image icon in its dapp.json before featuring it.';
  return null;
}

module.exports = { FLAGGED_STATES, FLAGGED, UNFLAGGED, timestamp, hasIcon, isFlagged, describe, featureRefusal };
