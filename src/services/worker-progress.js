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
function setEstimate(sessionId, text) {
  if (!sessionId) return;
  const prev = progress.get(sessionId);
  if (!prev) {
    progress.set(sessionId, {
      text: '',
      at: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      model: null,
      estimate: (text || '').toString().substring(0, 200),
    });
    return;
  }
  prev.estimate = (text || '').toString().substring(0, 200);
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

module.exports = { set, setEstimate, get, clear, all };
