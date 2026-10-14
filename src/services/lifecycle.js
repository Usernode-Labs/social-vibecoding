// Tracks process-wide lifecycle state so request handlers can reject new
// heavy work (container spawns, builds, DB clones) once a graceful shutdown
// has started. The main server drains in-flight work before actually exiting.

let shuttingDown = false;
let shutdownBegan = null;
const shutdownBegins = new Promise((resolve) => { shutdownBegan = resolve; });

function isShuttingDown() {
  return shuttingDown;
}

function setShuttingDown() {
  shuttingDown = true;
  shutdownBegan();
}

// Resolves once shutdown has begun. For work that waits on something slow it
// does not own (a rollout, a remote), to stop waiting rather than hold the
// shutdown drain for it: race it against this.
function whenShuttingDown() {
  return shutdownBegins;
}

// The mark of a request this process makes to itself, in-process, as a step
// of work it already holds: the Homeroom bot's build proposing what it built
// (homeroom-bot-live.js promoteAsBot, the only in-process dispatch of a
// drain-guarded route). That is the held work going on, not new work, and a
// process a release replaced finishes its work
// (docs/plans/draining-releases.md).
// 14 Oct 2026: a newcomer's first version (bot run 2027) was built to the
// end by the process a release had just replaced, and its own promote was
// then refused here, "Server is restarting": the process kept alive to
// finish the build refused the build's last step, and the newcomer saw it
// stop. It is a Symbol on the request object, so nothing a client sends can
// set it: Express builds `req` from the socket, and no header, body, query,
// cookie or token becomes a Symbol-keyed property. A request over HTTP,
// loopback included, never carries it.
const OWN_WORK = Symbol('lifecycle-own-work');

function isOwnWork(req) {
  return !!req && req[OWN_WORK] === true;
}

// Express middleware that 503s any request hitting a drain-guarded route
// once shutdown has been initiated, except a step of work this process
// already holds (OWN_WORK).
function drainGuard(req, res, next) {
  if (shuttingDown && !isOwnWork(req)) {
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

// How long the shutdown drain waits for the HTTP handlers still answering
// and the background work registered in services/inflight-work.js.
//
// Under docker-compose that is `shortMs` (server.js DRAIN_TIMEOUT_MS, 5s):
// compose SIGKILLs at stop_grace_period (10s), and
// tests/caddy-deploy-grace.test.js pins the drain, the marks and the pool
// close below it. Under Kubernetes a platform Pod a release replaced keeps
// finishing its work (docs/plans/draining-releases.md) for as long as the
// chart says: PLATFORM_DRAIN_TIMEOUT_MS is platform.drainMinutes, and the
// Pod's terminationGracePeriodSeconds is that plus a minute for the preStop
// sleep and the steps after the drain (tests/server-graceful-shutdown.test.js
// pins both). Without the variable it is KUBERNETES_DRAIN_DEFAULT_MS, which
// fits the 90 seconds the chart gave before it set one; the variable may move
// it within 0..KUBERNETES_DRAIN_MAX_MS, the chart's own ceiling. Under compose
// the variable can only shorten the drain: there is no grace above `shortMs`
// to spend.
//
// The drain returns as soon as nothing is in flight, so these are ceilings,
// not costs: an idle pod still exits at once.
const KUBERNETES_DRAIN_DEFAULT_MS = 60000;
const KUBERNETES_DRAIN_MAX_MS = 240 * 60 * 1000;

function drainDeadlineMs({ kubernetes = false, shortMs = 5000, env = process.env } = {}) {
  const ceiling = kubernetes ? KUBERNETES_DRAIN_MAX_MS : shortMs;
  const fallback = kubernetes ? KUBERNETES_DRAIN_DEFAULT_MS : shortMs;
  const raw = env ? env.PLATFORM_DRAIN_TIMEOUT_MS : undefined;
  if (raw != null && String(raw).trim() !== '' && Number.isFinite(Number(raw))) {
    return Math.min(Math.max(0, Math.floor(Number(raw))), ceiling);
  }
  return fallback;
}

module.exports = {
  isShuttingDown,
  setShuttingDown,
  whenShuttingDown,
  drainGuard,
  OWN_WORK,
  isOwnWork,
  waitFor,
  drainDeadlineMs,
  KUBERNETES_DRAIN_DEFAULT_MS,
  KUBERNETES_DRAIN_MAX_MS,
};
