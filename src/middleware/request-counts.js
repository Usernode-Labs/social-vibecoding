'use strict';

// Count every /api/ response as it finishes, for the server-error counts
// (services/server-error-counts.js): its method, the route TEMPLATE Express
// matched and its status, and for a 5xx the error handler answered what it
// caught (middleware/error-handler.js leaves { errType, frame, message } on
// res.locals.serverError). A route that answers its own 500 from a catch
// block is counted all the same, with no type or frame.
//
// Every response, /api/ or not, also says what it cost: how long it took
// from arrival until it finished, and the bytes its socket was handed for it
// (headers included, after compression: what went on the wire). That is the
// route costs' (server_route_minutes) and, for a slow one, what a stall's
// warning names (services/process-health.js). A response is given its
// socket when it is the connection's turn to answer (a pipelined one waits
// for the one before), so the socket's count from then on is its own. A
// response held open by design (an event stream, a long poll marked
// open-ended) counts as held, its time left out: it costs nothing while it
// waits. A request whose connection closed before its response finished
// (the client gave up, often because the process was slow) still costs what
// it took, counted as aborted.
//
// Mounted early in server.js, ahead of every route, so each one passes
// through it. It changes nothing a route answers: it only listens for the
// response's `finish` and `close`. The /api/ totals and errors count only a
// response that finished, as before.

const serverErrorCounts = require('../services/server-error-counts');
const processHealth = require('../services/process-health');
const { isEventStream } = require('./inflight-requests');

// Express sets req.route on the request when a route matches, and restores
// req.baseUrl as an error leaves a mounted router, so by the time a thrown
// error's response finishes the base no longer names the route's prefix.
// Keep the base the route matched under as Express assigns it.
function keepRouteBase(req) {
  let route = req.route;
  try {
    Object.defineProperty(req, 'route', {
      configurable: true,
      enumerable: true,
      get() { return route; },
      set(value) {
        route = value;
        if (value) req[serverErrorCounts.ROUTE_BASE] = req.baseUrl || '';
      },
    });
  } catch { /* the template falls back to req.baseUrl at finish */ }
}

/** Express middleware. `counts` and `health` are what to record into (tests pass their own). */
function requestCounts({ counts = serverErrorCounts, health = processHealth } = {}) {
  return function countRequest(req, res, next) {
    const url = String(req.originalUrl || req.url || '');
    const api = url.startsWith('/api/');
    const startedAt = Date.now();
    const started = process.hrtime.bigint();
    // The socket is detached from the response before `finish` reaches this
    // listener, so it is kept from when the response is given it.
    let socket = res.socket || null;
    let bytesBefore = socket ? socket.bytesWritten : 0;
    if (!socket) {
      res.once('socket', (s) => { socket = s; bytesBefore = s.bytesWritten; });
    }
    keepRouteBase(req);
    let counted = false;
    const count = (aborted) => {
      if (counted) return;
      counted = true;
      try {
        const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
        const route = serverErrorCounts.routeTemplate(req);
        const held = isEventStream(res) || !!(res.locals && res.locals.inflightOpenEnded);
        counts.record({
          method: req.method,
          route,
          status: res.statusCode,
          error: res.locals ? res.locals.serverError : null,
          api,
          durationMs,
          bytes: socket ? socket.bytesWritten - bytesBefore : null,
          stream: held,
          aborted,
        });
        if (!held) health.noteFinished({ method: req.method, route, status: res.statusCode, startedAt, durationMs, aborted });
      } catch { /* counting never fails a request */ }
    };
    res.once('finish', () => count(false));
    res.once('close', () => { if (!res.writableFinished) count(true); });
    next();
  };
}

module.exports = { requestCounts, keepRouteBase };
