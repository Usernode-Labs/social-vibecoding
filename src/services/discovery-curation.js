'use strict';

// Editorial review is not deployment health: a running container can still
// serve a demo or a broken main flow. Only an admin's review of the currently
// deployed version can qualify an app for the curated discovery lanes.
const REVIEW_STATES = new Set(['unreviewed', 'working', 'demo', 'broken']);

function timestamp(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function hasIcon(app) {
  return !!(app && [app.icon_image_id, app.icon_url, app.icon_emoji]
    .some((value) => typeof value === 'string' && value.trim()));
}

function describe(app) {
  const review = REVIEW_STATES.has(app?.directory_review_status)
    ? app.directory_review_status : 'unreviewed';
  const reviewedAt = timestamp(app?.directory_reviewed_at);
  const deployedAt = timestamp(app?.last_deploy_at);
  let state = review;
  let tier = 'more';
  let label;
  if (review === 'demo') label = 'Demo';
  else if (review === 'broken') label = 'Needs fixes';
  else if (app?.status !== 'running') { state = 'unavailable'; label = 'Not running'; }
  else if (!hasIcon(app)) { state = 'missing_icon'; label = 'Needs an icon'; }
  else if (review === 'working' && reviewedAt !== null && app.main_sha
    && app.main_sha === app.directory_reviewed_sha
    && (app.last_deploy_at == null || (deployedAt !== null && deployedAt <= reviewedAt))) {
    tier = app.self_hosted ? 'unreviewed' : 'ready';
    label = 'Reviewed working';
  } else {
    state = review === 'working' ? 'outdated' : 'unreviewed';
    tier = 'unreviewed';
    label = state === 'outdated' ? 'Needs re-review' : 'Not yet reviewed';
  }
  return { state, tier, label, reviewedAt: reviewedAt === null ? null : new Date(reviewedAt).toISOString() };
}

module.exports = { REVIEW_STATES, timestamp, hasIcon, describe };
