'use strict';

// Count every /api/ response as it finishes, for the server-error counts
// (services/server-error-counts.js): its method, the route TEMPLATE Express
// matched and its status, and for a 5xx the error handler answered what it
// caught (middleware/error-handler.js leaves { errType, frame, message } on
// res.locals.serverError). A route that answers its own 500 from a catch
// block is counted all the same, with no type or frame.
//
// Mounted early in server.js, ahead of every route, so each one passes
// through it. It changes nothing a route answers: it only listens for the
// response's `finish`, and a response whose connection closed first (the
// client went away) is not counted.

const serverErrorCounts = require('../services/server-error-counts');

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

/** Express middleware. `counts` is the counter to record into (tests pass their own). */
function requestCounts({ counts = serverErrorCounts } = {}) {
  return function countRequest(req, res, next) {
    const url = String(req.originalUrl || req.url || '');
    if (!url.startsWith('/api/')) return next();
    keepRouteBase(req);
    res.once('finish', () => {
      try {
        counts.record({
          method: req.method,
          route: serverErrorCounts.routeTemplate(req),
          status: res.statusCode,
          error: res.locals ? res.locals.serverError : null,
        });
      } catch { /* counting never fails a request */ }
    });
    next();
  };
}

module.exports = { requestCounts, keepRouteBase };
