'use strict';

// One change keeps the chat_session id through every lifecycle state. The
// proposal route is therefore the stable human-facing address even while the
// row is still active/paused; the page resolves the live row and chooses the
// underway or voting controls from its status. `/dev/sessions/:id` is reserved
// for controls that explicitly promise the owner coding workspace.
function changeHashPath(appSlug, sessionId) {
  return `/#app/${appSlug}/dev/proposals/${sessionId}`;
}

// A page of an app as an address someone is GIVEN (the connector's answers,
// a work order): the clean path the shell routes from its pathname
// (public/js/app.js _appRouteFromPath), `/app/<slug>/<rest>`, rather than
// the `#app/` fragment the shell navigates by inside itself. The same page,
// and one that reads as an address.
function appWebPath(origin, appSlug, rest = '') {
  const tail = String(rest || '').replace(/^\/+/, '');
  return `${origin}/app/${appSlug}${tail ? `/${tail}` : ''}`;
}

// A change by its proposal id. The id stays the last number, because the
// connector tells agents that is where to read it; the page redirects a
// change with a pull request to its `dev/changes/<N>` form.
function changeWebPath(origin, appSlug, sessionId) {
  return appWebPath(origin, appSlug, `dev/proposals/${sessionId}`);
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

// The link to give a PERSON for a change: changeHref's page, as an address,
// so it carries the number they know it by. Never the pull request on the
// git host, which is transport; the platform's page is where it is read and
// voted on.
function changeLink(origin, appSlug, sessionId, prNumber) {
  const pr = Number(prNumber);
  return Number.isInteger(pr) && pr > 0
    ? appWebPath(origin, appSlug, `dev/changes/${pr}`)
    : changeWebPath(origin, appSlug, Number(sessionId));
}

module.exports = { changeHashPath, appWebPath, changeWebPath, changeHref, changeLink };
