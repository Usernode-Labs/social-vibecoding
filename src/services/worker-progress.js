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
  });
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

module.exports = { set, get, clear, all };
