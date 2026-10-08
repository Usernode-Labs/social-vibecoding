'use strict';
// The workflow worker: a process of its own (the chart's `-workflow`
// Deployment, same image as the platform) that runs the workflow runtime's
// loops, meaning its work items (deploys, GitHub calls, retirements) and its
// timers, and nothing else. The web Pods keep appending events and deciding
// them in their pipeline slots, with the post-commit pushes beside the
// process state those use; they leave the loops to this process
// (WF_LOOPS=worker). docs/workflows.md, "Running it", has the whole picture.
//
// It serves no page. What it broadcasts goes over the WebSocket bus for the
// web Pods to deliver (ws.startPublisher), and its only listener is /health
// on port 8081, for the kubelet's probes.

const http = require('node:http');
const { load: loadConfig } = require('./src/config');
const log = require('./src/services/logger');

const config = loadConfig();
log.setLevel(config.logLevel);

const bootstrap = require('./src/services/process-bootstrap');
const ws = require('./src/services/ws');
const wsBus = require('./src/services/ws-bus');
const mobilePush = require('./src/services/mobile-push');
const { getPool } = require('./src/db/pool');
const platform = require('./src/workflow/platform.ts');

const PORT = 8081;
// At SIGTERM the runtime stops claiming and signals its running work to
// abort, then waits for it. A handler that honours the signal ends at once;
// several (a production deploy, the main check, closing requests, a preview
// teardown) run on to the end of their current step. Whatever is still
// running when this runs out is reclaimed after its lease and resumed from its
// checkpoint. Inside the chart's 90-second grace period.
const STOP_TIMEOUT_MS = 80000;

let state = 'starting';
let healthServer = null;

// 200 once the runtime runs (or there is nothing to run: no workflow flag
// is on, and none has work left), 503 while it starts or stops.
function health(req, res) {
  if (req.url !== '/health') {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(state === 'running' ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ state, runtime: platform.workflowRunning() }));
}

async function start() {
  healthServer = http.createServer(health);
  await new Promise((resolve) => healthServer.listen(PORT, resolve));
  await bootstrap.initServices(config);
  bootstrap.registerHooks(config);
  ws.startPublisher(config);
  await platform.startWorkflow(config, { loops: true, worker: true });
  state = 'running';
  log.info('workflow-worker', 'Workflow worker started', { port: PORT, runtime: platform.workflowRunning() });
}

let stopping = null;
function stop(signal) {
  if (stopping) return stopping;
  state = 'stopping';
  log.info('workflow-worker', 'Stopping', { signal });
  const timer = setTimeout(() => {
    log.warn('workflow-worker', 'Stop timed out; exiting');
    process.exit(1);
  }, STOP_TIMEOUT_MS);
  timer.unref();
  stopping = (async () => {
    await platform.stopWorkflow().catch((err) => log.warn('workflow-worker', 'Stopping the workflow runtime failed', { err: err.message }));
    await mobilePush.stop({ timeoutMs: 5000 }).catch(() => {});
    // Rows of work it was doing (a deploy), so they do not read as running.
    await require('./src/services/in-flight-record').releaseAll().catch(() => {});
    await wsBus.stop().catch(() => {});
    await getPool(config).end().catch(() => {});
    healthServer?.close();
    process.exit(0);
  })();
  return stopping;
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

start().catch((err) => {
  log.error('workflow-worker', 'Workflow worker failed to start', { err: err.message });
  process.exit(1);
});
