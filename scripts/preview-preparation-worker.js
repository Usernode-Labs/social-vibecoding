#!/usr/bin/env node
'use strict';

// Dedicated supervised process; never imported or started by the web server.
const { createExecutionWorker } = require('../src/services/execution/worker');
const { createPreviewWork } = require('../src/services/preview-flow/work');

async function runWorker({
  pool,
  config,
  pollMs = 250,
  censusMs = 60000,
  discoveryOptions = {},
  previewOptions = {},
  onError = () => {},
}) {
  const { createDiscoveryPool } = require('../src/services/execution/discovery-pool');
  const discoveryPool = createDiscoveryPool(config.databaseUrl, discoveryOptions);
  const preview = createPreviewWork(pool, config, previewOptions);
  const discovery = createPreviewWork(discoveryPool, config);
  const worker = createExecutionWorker({ store: preview.store, handlers: preview.handlers, onError });
  let stopping = false;
  const sleeps = new Set();

  function delay(ms) {
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
        onError('preview_worker_poll_deferred');
      }
      await delay(pollMs);
    }
  }

  async function discover() {
    while (!stopping) {
      try {
        await discovery.census();
      } catch {
        onError('preview_worker_discovery_deferred');
      }
      await delay(censusMs);
    }
  }

  // Each loop owns and awaits its operations. Discovery never gates claiming,
  // never overlaps itself, and stop waits for rollback and both loops to end.
  const polling = poll();
  const discovering = discover();
  return {
    async stop() {
      stopping = true;
      for (const wake of sleeps) wake();
      await Promise.all([polling, discovering]);
      await worker.drain();
      await discoveryPool.end();
    },
  };
}

async function main() {
  if (process.env.PREVIEW_PREPARATION_WORKER_ENABLED !== 'true') {
    throw new Error('Set PREVIEW_PREPARATION_WORKER_ENABLED=true only for the contained experiment');
  }
  const config = require('../src/config').load();
  const pool = require('../src/db/pool').getPool(config);
  const running = await runWorker({ pool, config, onError: code => console.error(code) });
  let closing = false;

  async function shutdown() {
    if (closing) return;
    closing = true;
    // A bounded shutdown exits without pretending external creation stopped.
    const deadline = setTimeout(() => process.exit(86), 30000);
    await running.stop();
    await pool.end();
    clearTimeout(deadline);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main().catch(() => {
  console.error('preview_worker_start_failed');
  process.exitCode = 1;
});

module.exports = { runWorker };
