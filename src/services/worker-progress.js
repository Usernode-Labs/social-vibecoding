// Tracks the most recent Claude Code progress line for each in-flight worker,
// so the /status dashboard can show what each worker is currently doing.
// Lives in-memory only; cleared when the worker is destroyed.

const progress = new Map();

function set(sessionId, text, { model } = {}) {
  if (!sessionId) return;
  const prev = progress.get(sessionId);
  progress.set(sessionId, {
    text: (text || '').toString().substring(0, 200),
    at: new Date().toISOString(),
    startedAt: prev?.startedAt || new Date().toISOString(),
    model: model || prev?.model || null,
    estimate: prev?.estimate || null,
  });
}

// Experimental AI progress estimate: latest Haiku guess for this run.
// Stored on the same in-memory entry so the dev-chat polling fallback
// (GET /api/sessions/:id/status) can carry it; ephemeral by design.
// `value` is { text, remainingSeconds } — remainingSeconds is the
// numeric remaining-time guess (seconds) or null when the model declined
// one. A bare string is tolerated for backward compatibility.
//
// `estimatedAt` (epoch ms) is stamped here rather than read from the
// caller: the count-down is anchored ABSOLUTELY client-side
// (estimatedAt + remainingSeconds * 1000), so re-delivering the same
// guess over the 3s /status poll can no longer re-anchor it to "now"
// and freeze the readout at a constant "~X left" (#891).
function normalizeEstimate(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return { text: value.substring(0, 200), remainingSeconds: null, estimatedAt: Date.now() };
  }
  const rs = value.remainingSeconds;
  const at = value.estimatedAt;
  // #892: `displayedRemainingSeconds` is the post-guard, post-floor value —
  // what the countdown actually counts down from. It is ALWAYS a positive
  // number when present (the guard floors at 30s so the readout can never
  // stick at zero). `remainingSeconds` stays the raw model guess beside it;
  // the client prefers the displayed value and falls back to the raw one for
  // a legacy server that doesn't send it. `slipReason` names why an
  // extension was accepted, and is what lets the client's belt-and-braces
  // mirror of the guard tell a legitimate extension from a reordered
  // delivery.
  const ds = value.displayedRemainingSeconds;
  return {
    text: (value.text || '').toString().substring(0, 200),
    remainingSeconds: (typeof rs === 'number' && Number.isFinite(rs)) ? rs : null,
    estimatedAt: (typeof at === 'number' && Number.isFinite(at)) ? at : Date.now(),
    displayedRemainingSeconds:
      (typeof ds === 'number' && Number.isFinite(ds) && ds > 0) ? ds : null,
    slipReason: value.slipReason ? String(value.slipReason).substring(0, 24) : null,
  };
}

function setEstimate(sessionId, value) {
  if (!sessionId) return;
  const estimate = normalizeEstimate(value);
  const prev = progress.get(sessionId);
  if (!prev) {
    progress.set(sessionId, {
      text: '',
      at: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      model: null,
      estimate,
    });
    return;
  }
  prev.estimate = estimate;
}

// Drop just the estimate, keeping the progress entry itself (#891). The
// estimator is torn down at the coding run's TERMINAL marker, well before
// the whole entry is cleared at the end of the turn — without this the
// /status poll keeps serving the last guess through PR creation, the
// staging build and the Mayor wrap-up, and the client keeps re-painting
// "nearly done, just wrapping up" onto an already-finished run.
//
// Deliberately a no-op when there's no entry: setEstimate(id, null) would
// CREATE a junk entry via its `!prev` branch, which would then make
// /status report a bogus in-flight worker.
function clearEstimate(sessionId) {
  if (!sessionId) return;
  const prev = progress.get(sessionId);
  if (!prev) return;
  prev.estimate = null;
}

function get(sessionId) {
  return progress.get(sessionId) || null;
}

function clear(sessionId) {
  progress.delete(sessionId);
}

function all() {
  return Array.from(progress.entries()).map(([sessionId, p]) => ({ sessionId, ...p }));
}

module.exports = { set, setEstimate, clearEstimate, get, clear, all };
