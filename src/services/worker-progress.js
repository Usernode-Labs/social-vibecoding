// Tracks the most recent Claude Code progress line for each in-flight worker,
// so the /status dashboard can show what each worker is currently doing.
// Lives in-memory only; cleared when the worker is destroyed.

const progress = new Map();

function set(sessionId, text, { model, backend, provider } = {}) {
  if (!sessionId) return;
  const prev = progress.get(sessionId);
  progress.set(sessionId, {
    text: (text || '').toString().substring(0, 200),
    at: new Date().toISOString(),
    startedAt: prev?.startedAt || new Date().toISOString(),
    model: model || prev?.model || null,
    // Backend-neutral metadata (plan.md PR1): which coding agent is
    // running. Null for claude_code today; populated for codex_openrouter
    // in PR5. Keeps /status and the progress card backend-agnostic.
    backend: backend || prev?.backend || null,
    provider: provider || prev?.provider || null,
    spend: prev?.spend || null,
  });
}

// Same lifetime as the coding progress: retained for reloads, removed by
// the existing turn cleanup. Contains numbers only, never streamed content.
function setSpend(sessionId, spend) {
  if (!sessionId) return;
  if (!progress.has(sessionId)) {
    if (!spend) return;
    set(sessionId, '');
  }
  progress.get(sessionId).spend = spend;
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

module.exports = { setSpend, set, get, clear, all };
