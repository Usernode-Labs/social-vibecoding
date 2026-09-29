'use strict';

const log = require('../services/logger');

// #2508: the platform had NO express error-handling middleware at all, so an
// error thrown out of any route fell through to EXPRESS'S OWN default
// handler. That handler's behaviour depends entirely on `NODE_ENV`, and the
// production image never set it:
//
//   - `Dockerfile` declared only `ENV GIT_SHA`, so every container ran with
//     `NODE_ENV` unset;
//   - unset is not 'production', so express's default handler puts
//     `err.stack` IN THE RESPONSE BODY.
//
// Those two facts together mean a stack trace — absolute source paths, the
// internal module layout, the failing query's shape — was one unhandled
// throw away from any client, in production.
//
// Both halves are fixed, and they are fixed INDEPENDENTLY on purpose, so
// neither is the other's only guard:
//
//   1. `Dockerfile` now sets `NODE_ENV=production` in the runtime stage.
//   2. This handler answers every error itself and never consults
//      `NODE_ENV`, so the body is the same terse JSON wherever it runs.
//
// The point of (2) is that (1) is a single line in a build file that a
// future edit can drop silently. A handler whose safety depended on the env
// var would be right back here.

// Some errors are the CLIENT's, and answering them with a 500 is both wrong
// and noisy. Express's body parsers throw these with a `status`/`statusCode`
// already set, and `express.json` in particular throws a 400 on malformed
// JSON and a 413 over its size limit — both of which the caller caused and
// should see as such.
function clientStatusFor(err) {
  const status = Number(err?.status ?? err?.statusCode);
  if (!Number.isInteger(status)) return null;
  return status >= 400 && status < 500 ? status : null;
}

// NO ERROR MESSAGE IS EVER PASSED THROUGH, 4xx included.
//
// The first version of this handler forwarded 4xx messages on the reasoning
// that a body parser's complaint describes the REQUEST rather than the
// server. Codex challenged that, and it was wrong: Node 22's JSON parser
// quotes the offending input back in its message. A malformed body carrying
// a credential produces
//
//   Unexpected token 's', "{"tok":sk-live-ab"... is not valid JSON
//
// which is the caller's own secret reflected into the response AND into the
// operator-visible log ring. Any dependency that throws with a 4xx `status`
// gets the same treatment, and there is no way to know in advance what those
// messages hold.
//
// So the status is preserved — that is the part the caller genuinely needs,
// and it is what distinguishes "your JSON is broken" from "we fell over" —
// while the text is a fixed phrase per family. Nothing diagnostic is lost to
// operators: the full error, stack included, still goes to the log for 5xx,
// and for 4xx the log records the error's TYPE and status rather than a
// message that may be made of request bytes.
const CLIENT_MESSAGES = {
  400: 'Malformed request',
  413: 'Request body too large',
  415: 'Unsupported content type',
};
function clientMessageFor(status) {
  return CLIENT_MESSAGES[status] || 'Bad request';
}
function errorHandler(err, req, res, _next) {
  // Headers already sent means a response was streaming when it failed —
  // there is no body left to write, and express's default handler would
  // destroy the socket. Delegate that one case rather than corrupting it.
  if (res.headersSent) {
    log.error('server', 'Error after response started', {
      method: req.method, path: req.path, err: err?.message,
    });
    return res.destroy();
  }

  const clientStatus = clientStatusFor(err);
  const status = clientStatus || 500;

  // The stack goes to the LOG, which is the place that was always meant to
  // have it. Nothing about this fix makes the platform harder to debug; it
  // moves the trace from the attacker's screen to the operator's.
  const level = status >= 500 ? 'error' : 'warn';
  log[level]('server', 'Unhandled route error', {
    method: req.method,
    path: req.path,
    status,
    userId: req.user?.id,
    // A 4xx message can be made of the request's own bytes (see above), and
    // this log is operator-visible, so only the 5xx family gets its text.
    err: clientStatus ? undefined : err?.message,
    errType: err?.type || err?.name || undefined,
    stack: status >= 500 ? err?.stack : undefined,
  });

  res.status(status).json({
    error: clientStatus ? clientMessageFor(status) : 'Internal server error',
  });
}

module.exports = { errorHandler, clientStatusFor, clientMessageFor };
