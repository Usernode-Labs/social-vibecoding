'use strict';

// One change keeps the chat_session id through every lifecycle state. The
// proposal route is therefore the stable human-facing address even while the
// row is still active/paused; the page resolves the live row and chooses the
// underway or voting controls from its status. `/dev/sessions/:id` is reserved
// for controls that explicitly promise the owner coding workspace.
function changeHashPath(appSlug, sessionId) {
  return `/#app/${appSlug}/dev/proposals/${sessionId}`;
}

function changeWebPath(origin, appSlug, sessionId) {
  return `${origin}${changeHashPath(appSlug, sessionId)}`;
}

// #4367: the in-app link to a change. One with a pull request is addressed by
// its number (`dev/changes/<N>`, its "Change #N"); one without — a draft, a
// plan — by its session id. The page redirects an old session-id link of a
// change with a pull request to the same form.
function changeHref(appSlug, sessionId, prNumber) {
  const slug = encodeURIComponent(String(appSlug || ''));
  const pr = Number(prNumber);
  return Number.isInteger(pr) && pr > 0
    ? `#app/${slug}/dev/changes/${pr}`
    : `#app/${slug}/dev/proposals/${Number(sessionId)}`;
}

module.exports = { changeHashPath, changeWebPath, changeHref };
