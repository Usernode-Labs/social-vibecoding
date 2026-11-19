'use strict';

// RFC 7240's `Prefer: wait=<seconds>`: how long the client is willing to
// wait for a route that otherwise waits for its work to finish. A route that
// honours it answers what it knows when that time is up (202, still running)
// instead of holding the request past the client's own deadline. The CLI
// sends it on every request (src/cli/http.js), a few seconds under the
// deadline it aborts at; a browser sends none and keeps the route's own wait.

const MAX_WAIT_SECONDS = 25 * 60;

/** Milliseconds the client asked to wait, or null when it did not ask. */
function preferredWaitMs(header) {
  if (typeof header !== 'string' || !header) return null;
  for (const part of header.split(',')) {
    const m = /^\s*wait\s*=\s*"?(\d{1,7})"?\s*(?:;.*)?$/i.exec(part);
    if (m) return Math.min(Number(m[1]), MAX_WAIT_SECONDS) * 1000;
  }
  return null;
}

/** Says the preference was applied (RFC 7240 `Preference-Applied`). */
function applied(res, waitMs) {
  if (waitMs != null) res.set('Preference-Applied', `wait=${Math.round(waitMs / 1000)}`);
}

module.exports = { preferredWaitMs, applied, MAX_WAIT_SECONDS };
