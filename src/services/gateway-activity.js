'use strict';

// Aggregate operational activity, without identities, paths or request bodies.
// A separate cluster-only listener exposes it to the sleep controller.
const HEALTH_PATHS = new Set(['/health', '/healthz', '/readyz', '/livez', '/__gate_health']);
function isHealth(uri, { method, userAgent, upgrade = false } = {}) {
  if (upgrade) return false;
  return HEALTH_PATHS.has(String(uri || '').split('?')[0])
    // The app directory checks homepages, rather than a dedicated health path.
    || ((method === 'GET' || method === 'HEAD') && userAgent === 'usernode-dapp-homepage-healthcheck/1');
}
function createActivity({ now = Date.now, maxEntries = 4096 } = {}) {
  const entries = new Map();
  const startedAt = now();
  let overflow = false;
  function begin(name, uri, request) {
    if (isHealth(uri, request)) return () => {};
    let row = entries.get(name);
    if (!row) {
      if (entries.size >= maxEntries) { overflow = true; return () => {}; }
      row = { active: 0, lastRequestAt: now() };
      entries.set(name, row);
    }
    row.active += 1;
    row.lastRequestAt = now();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      row.active -= 1;
      // Idle starts when the last streaming response/connection ends.
      row.lastRequestAt = now();
    };
  }
  return { begin, snapshot: () => ({ version: 1, startedAt, now: now(), overflow,
    upstreams: Object.fromEntries([...entries].map(([name, row]) => [name, { ...row }])) }) };
}
module.exports = { isHealth, createActivity };
