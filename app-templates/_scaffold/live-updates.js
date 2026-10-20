'use strict';

// Live updates: every screen of this app that is open hears when something
// changed and fetches what it shows again at once, so what one person does
// shows on everyone else's screen within a moment, not at its next look.
//
//   GET /api/changes   an event stream (server-sent events) for the page's
//                      half, public/live-updates.js. It is behind the
//                      sign-in check like every /api route: anyone who may
//                      read the app, a guest included, may listen.
//
// WHAT AN EVENT SAYS: only that something changed (`event: change`), never
// what or who. The screen fetches again through its own read, which applies
// its own rules, so nothing reaches anybody that the read would not show
// them.
//
// WHEN ONE IS SENT: after every write to /api/* that succeeds (a POST, PUT,
// PATCH or DELETE answered 2xx), by itself, so a route added later is
// covered with nothing to remember. A change made any other way (a timer, a
// job, a route outside /api/) calls notify():
//
//   require('./live-updates').notify();
//
// Writes close together go out as one event (BATCH_MS), and nothing is sent
// while nobody is listening.
//
// THE CONNECTION: a comment line every HEARTBEAT_MS, so the proxies in front
// of the app never see it idle (Homeroom's close an idle connection at 60
// seconds), and `no-transform`, so nothing that compresses holds an event
// back. The app runs as one container, so who is listening is a set in this
// process. On SIGTERM server.js calls close(), which ends every stream; each
// page connects again by itself, to whichever container answers next.

const PATH = '/api/changes';
const HEARTBEAT_MS = 15000;
const BATCH_MS = 100;
// How long a page waits before it reconnects a stream that dropped.
const RETRY_MS = 3000;
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const listeners = new Set();
let heartbeat = null;
let batch = null;
let closed = false;

function write(res, chunk) {
  try {
    res.write(chunk);
  } catch {
    listeners.delete(res);
  }
}

function broadcast(chunk) {
  for (const res of listeners) write(res, chunk);
}

/** Tell every open screen that something changed. */
function notify() {
  if (closed || batch || !listeners.size) return;
  batch = setTimeout(() => {
    batch = null;
    broadcast('event: change\ndata: {}\n\n');
  }, BATCH_MS);
  batch.unref?.();
}

/**
 * The stream and the write hook, on `app`. server.js mounts it after the
 * sign-in check and before api.js, so the hook sees every write api.js
 * answers.
 */
function mount(app) {
  app.get(PATH, (req, res) => {
    if (closed) return res.status(503).end();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    write(res, `retry: ${RETRY_MS}\n:ok\n\n`);
    listeners.add(res);
    if (!heartbeat) {
      heartbeat = setInterval(() => broadcast(':heartbeat\n\n'), HEARTBEAT_MS);
      heartbeat.unref?.();
    }
    const done = () => {
      listeners.delete(res);
      if (!listeners.size && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };
    res.on('close', done);
    res.on('error', done);
    return undefined;
  });

  app.use((req, res, next) => {
    if (WRITES.has(req.method) && req.path.startsWith('/api/')) {
      res.on('finish', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) notify();
      });
    }
    next();
  });
  return module.exports;
}

/** Ends every stream and takes no more: the container is stopping. */
function close() {
  closed = true;
  clearTimeout(batch);
  batch = null;
  clearInterval(heartbeat);
  heartbeat = null;
  for (const res of listeners) {
    try {
      res.end();
    } catch {
      // already gone
    }
  }
  listeners.clear();
}

/** How many screens are listening now. */
function count() {
  return listeners.size;
}

module.exports = { PATH, HEARTBEAT_MS, BATCH_MS, mount, notify, close, count };
