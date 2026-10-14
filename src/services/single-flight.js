'use strict';

// A timer callback that runs one pass at a time. setInterval fires on its own
// clock whatever the last pass is doing, so a pass that outlasts the interval
// had the next one start beside it: the session sweeper's passes run minutes
// when a staging heal rebuilds a preview, and on 14 Oct 2026 several ran at
// once, pausing, healing and measuring the same rows. A tick that finds the
// last pass still running is skipped (and says so); the next tick after the
// pass ends runs as usual.

const log = require('./logger');

function singleFlight(name, fn) {
  let running = null;
  let startedAt = 0;
  const tick = (...args) => {
    if (running) {
      log.info('single-flight', 'Last pass still running; this tick skipped', { name, runningMs: Date.now() - startedAt });
      return running;
    }
    startedAt = Date.now();
    running = Promise.resolve()
      .then(() => fn(...args))
      .finally(() => { running = null; });
    return running;
  };
  tick.isRunning = () => running !== null;
  return tick;
}

module.exports = { singleFlight };
