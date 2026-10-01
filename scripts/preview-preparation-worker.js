#!/usr/bin/env node
'use strict';

// Dedicated supervised process; never imported or started by the web server.
const { createExecutionWorker } = require('../src/services/execution/worker');
const { createPreviewWork } = require('../src/services/preview-flow/work');

async function runWorker({ pool, config, pollMs = 250, censusMs = 60000, onError = () => {} }) {
  const preview = createPreviewWork(pool, config);
  const worker = createExecutionWorker({ store: preview.store, handlers: preview.handlers, onError });
  let stopping = false;
  let nextCensus = 0;

  const loop = (async () => {
    while (!stopping) {
      try {
        await worker.tick();
        if (Date.now() >= nextCensus) {
          nextCensus = Date.now() + censusMs;
          await preview.census();
        }
      } catch {
        onError('preview_worker_poll_deferred');
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  })();

  return {
    async stop() {
      stopping = true;
      await loop;
      await worker.drain();
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
