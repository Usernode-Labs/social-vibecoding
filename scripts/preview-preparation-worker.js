#!/usr/bin/env node
'use strict';

// Dedicated supervised process; never imported or started by the web server.
const { createExecutionService } = require('../src/services/execution/service');
const { createReviewWork } = require('../src/services/proposal-review/work');
const { createPreviewWork } = require('../src/services/preview-flow/work');
const { createCliHandoffWork } = require('../src/services/cli-preview-handoff/work');

async function runWorker({
  pool,
  config,
  pollMs = 250,
  censusMs = 60000,
  discoveryOptions = {},
  previewOptions = {},
  onError = () => {},
}) {
  await require('../src/services/preview-flow/experimental-support').assertSupportedExperimentalStore(pool);

  // This process does not pass through server.js startup. Initialize SDK
  // dependencies before any execution can invoke an adapter or gate policy.
  // Failure leaves durable work unclaimed for a later process to recover.
  await require('../src/services/github').init(config);
  await require('../src/services/llm').init(config);

  const { createDiscoveryPool } = require('../src/services/execution/discovery-pool');
  const discoveryPool = createDiscoveryPool(config.databaseUrl, discoveryOptions);
  const handoff = createCliHandoffWork(pool, config, { previewOptions });
  const preview = handoff.preview;
  const discovery = createPreviewWork(discoveryPool, config);
  const review = createReviewWork(pool, config, { store: preview.store });
  const execution = createExecutionService({
    store: preview.store,
    handlers: { ...handoff.handlers, ...review.handlers },
    discover: () => discovery.census(),
    pollMs,
    discoveryMs: censusMs,
    onError,
  });
  return {
    async stop() {
      await execution.stop();
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
