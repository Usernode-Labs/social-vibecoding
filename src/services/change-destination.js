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

module.exports = { changeHashPath, changeWebPath };
