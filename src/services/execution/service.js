'use strict';

const { z } = require('zod');
const { createExecutionWorker } = require('./worker');

function createExecutionService({
  store,
  handlers,
  discover,
  pollMs = 250,
  discoveryMs = 60000,
  onError = () => {},
}) {
  z.number().int().min(1).max(60000).parse(pollMs);
  z.number().int().min(1).max(3600000).parse(discoveryMs);
  const worker = createExecutionWorker({ store, handlers, onError });
  const sleeps = new Set();
  let stopping = false;

  function delay(ms) {
    if (stopping) return Promise.resolve();
    return new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer);
        sleeps.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      sleeps.add(wake);
    });
  }

  async function poll() {
    while (!stopping) {
      try {
        await worker.tick();
      } catch {
        onError('execution_poll_deferred');
      }
      await delay(pollMs);
    }
  }

  async function discoverWork() {
    while (!stopping) {
      try {
        await discover();
      } catch {
        onError('execution_discovery_deferred');
      }
      await delay(discoveryMs);
    }
  }

  // Discovery is independent and never overlaps itself. Stop joins active
  // operations; waking a delay does not detach or pretend to cancel SQL.
  const polling = poll();
  const discovering = discover ? discoverWork() : Promise.resolve();
  return {
    async stop() {
      stopping = true;
      for (const wake of sleeps) wake();
      await Promise.all([polling, discovering]);
      await worker.drain();
    },
  };
}

module.exports = { createExecutionService };
