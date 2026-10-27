'use strict';

const MAX_QUEUED = 4;
const QUEUE_TIMEOUT_MS = 10000;

// One active publication per platform process, including export, parsing,
// Git and cleanup. Waiting requests hold no exported bundles. One repository
// branch may occupy only one place, so repeated calls cannot fill the queue.
function createQueue({ maxQueued = MAX_QUEUED, timeoutMs = QUEUE_TIMEOUT_MS } = {}) {
  let active = false;
  const keys = new Set();
  const pending = [];
  const busy = () => Object.assign(new Error('Git publishing is busy. Retry shortly.'), { code: 'push_busy' });
  const releaseFor = key => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      keys.delete(key);
      const next = pending.shift();
      if (!next) { active = false; return; }
      clearTimeout(next.timer);
      next.resolve(releaseFor(next.key));
    };
  };
  const acquire = key => {
    if (keys.has(key) || (active && pending.length >= maxQueued)) return Promise.reject(busy());
    keys.add(key);
    if (!active) { active = true; return Promise.resolve(releaseFor(key)); }
    return new Promise((resolve, reject) => {
      const item = { key, resolve, timer: null };
      item.timer = setTimeout(() => {
        pending.splice(pending.indexOf(item), 1);
        keys.delete(key);
        reject(busy());
      }, timeoutMs);
      pending.push(item);
    });
  };
  return {
    async run(key, fn) {
      const release = await acquire(key);
      try { return await fn(); } finally { release(); }
    },
  };
}

module.exports = { createQueue, MAX_QUEUED, QUEUE_TIMEOUT_MS };
