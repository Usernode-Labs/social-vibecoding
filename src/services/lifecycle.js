// Tracks process-wide lifecycle state so request handlers can reject new
// heavy work (container spawns, builds, DB clones) once a graceful shutdown
// has started. The main server drains in-flight work before actually exiting.

let shuttingDown = false;

function isShuttingDown() {
  return shuttingDown;
}

function setShuttingDown() {
  shuttingDown = true;
}

// Express middleware that 503s any request hitting a drain-guarded route
// once shutdown has been initiated.
function drainGuard(_req, res, next) {
  if (shuttingDown) {
    return res.status(503).json({ error: 'Server is restarting, try again in a few seconds' });
  }
  next();
}

// Poll `check()` until it returns true, or the timeout fires. Used by the
// main server to wait for in-flight workers before tearing them down.
async function waitFor(check, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

module.exports = { isShuttingDown, setShuttingDown, drainGuard, waitFor };
