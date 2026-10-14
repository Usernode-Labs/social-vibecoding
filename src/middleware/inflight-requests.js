'use strict';

// The HTTP handlers still answering, for the shutdown drain.
//
// cleanup() (server.js) closes the listener first and then waits for the
// handlers already inside it to finish. Until this existed it had no way to
// tell whether any were: its wait asked about worker containers, so a pod
// whose workers were idle exited the moment SIGTERM arrived, cutting every
// handler halfway through its writes. Mounted ahead of every route, this
// counts each request from arrival until its response finishes or its
// connection closes.
//
// Two kinds of request are left out of the count, because waiting for them
// would only hold every shutdown to its deadline:
//
//   - An event stream (Content-Type: text/event-stream), once its headers
//     are out. A streamed turn, the MCP GET stream and the model proxies'
//     streams stay open for as long as the work behind them, which restart
//     recovery carries on, or for as long as the client likes.
//   - A request its route marks open-ended with `openEnded(res)`: a long
//     poll that answers "nothing yet" when its window runs out
//     (routes/cli-agent.js /turns/next).
//
// WebSocket upgrades never reach Express, so they are not counted either.

const open = new Set();

const EVENT_STREAM = /text\/event-stream/i;

function isEventStream(res) {
  if (!res.headersSent) return false;
  const type = typeof res.getHeader === 'function' ? res.getHeader('content-type') : null;
  if (type && EVENT_STREAM.test(String(type))) return true;
  // writeHead(status, headers) on a response that never had setHeader called
  // keeps its headers only in the block it wrote, not in getHeader's map.
  return typeof res._header === 'string' && /\r\ncontent-type:[^\r\n]*text\/event-stream/i.test(res._header);
}

function counted(entry) {
  return !entry.res.locals?.inflightOpenEnded && !isEventStream(entry.res);
}

/** Express middleware: count the request until its response is done. */
function inflightRequests() {
  return function trackInflightRequest(req, res, next) {
    const entry = { req, res, startedAt: Date.now() };
    open.add(entry);
    const done = () => { open.delete(entry); };
    res.once('finish', done);
    res.once('close', done);
    next();
  };
}

/** Leave this response out of the drain's count: it is held open by design. */
function openEnded(res) {
  if (res && res.locals) res.locals.inflightOpenEnded = true;
  return res;
}

/** How many handlers the drain is waiting for now. */
function pending() {
  let n = 0;
  for (const entry of open) if (counted(entry)) n += 1;
  return n;
}

// The method and the path's first two segments: enough to say which surface
// is slow (`POST /api/sessions`) without writing ids, tokens or a query
// string into the shutdown log.
function surface(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const head = path.split('/').filter(Boolean).slice(0, 2).join('/');
  return `${req.method || 'GET'} /${head}`;
}

/** The handlers the drain is waiting for, oldest first: [{ surface, ageMs }]. */
function snapshot(now = Date.now()) {
  return [...open]
    .filter(counted)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((entry) => ({ surface: surface(entry.req), ageMs: Math.max(0, now - entry.startedAt) }));
}

module.exports = { inflightRequests, openEnded, pending, snapshot, isEventStream };
