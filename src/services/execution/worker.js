'use strict';

const { randomUUID } = require('node:crypto');
const { z } = require('zod');

function retryDelay(attemptCount, minimum, maximum) {
  return Math.min(maximum, minimum * 2 ** Math.min(20, Math.max(0, attemptCount - 1)));
}

function createExecutionWorker({
  store,
  handlers,
  workerId = randomUUID(),
  concurrency = 4,
  retryMinimumMs = 1000,
  retryMaximumMs = 60000,
  attemptTimeoutMs = 1200000,
  onUnresponsive = () => process.exit(86),
  onError = () => {},
}) {
  z.number().int().min(1).max(32).parse(concurrency);
  z.number().int().min(100).max(3600000).parse(retryMinimumMs);
  z.number().int().min(retryMinimumMs).max(3600000).parse(retryMaximumMs);
  z.number().int().min(100).max(3600000).parse(attemptTimeoutMs);
  z.string().uuid().parse(workerId);
  if (!Object.keys(handlers).length) throw new Error('Execution handlers are required');
  const active = new Set();
  let stopping = false;
  let claiming = null;

  async function execute(attempt) {
    const handler = handlers[attempt.workflow];
    const controller = new AbortController();
    let renewalPending = false;
    const heartbeat = setInterval(async () => {
      if (renewalPending) return;
      renewalPending = true;
      try {
        if (!await store.renew(attempt)) controller.abort(new Error('Execution claim lost'));
      } catch {
        controller.abort(new Error('Execution lease renewal failed'));
      } finally {
        renewalPending = false;
      }
    }, Math.max(25, Math.floor(store.leaseMs / 3)));

    // Do not Promise.race and release a resource lock while its callback lives.
    // A supervised process exit contains unresponsive I/O; durable intent and
    // reconciliation remain necessary for externally accepted work afterward.
    const timeout = setTimeout(() => {
      controller.abort(new Error('Execution attempt exceeded its duration bound'));
      onUnresponsive(attempt);
    }, attemptTimeoutMs);

    try {
      if (attempt.contract_version !== handler.version) {
        return await store.settle(attempt, { outcome: 'blocked', code: 'unsupported_contract' });
      }
      const proposed = await handler.run({
        attempt,
        signal: controller.signal,
        checkpoint: value => store.checkpoint(attempt, value),
      });
      if (controller.signal.aborted) return { lostClaim: true };
      return await store.settle(attempt, proposed, handler.commit);
    } catch (error) {
      if (controller.signal.aborted) return { lostClaim: true };
      // Raw adapter errors may contain credentials or commands. Persist a fixed
      // class code; domain handlers supply their own bounded, safe diagnostics.
      return store.settle(attempt, {
        outcome: error.permanent ? 'blocked' : 'retry',
        checkpoint: (await store.read(attempt.id))?.checkpoint || {},
        code: error.permanent ? 'adapter_contract_blocked' : 'execution_retry',
        delayMs: retryDelay(attempt.attempt_count, retryMinimumMs, retryMaximumMs),
      });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  }

  async function tick() {
    if (claiming) return claiming;
    if (stopping || active.size >= concurrency) return;
    claiming = claimAvailable();
    try {
      await claiming;
    } finally {
      claiming = null;
    }
  }

  async function claimAvailable() {
    const attempts = await store.claim(workerId, Object.keys(handlers), concurrency - active.size);
    for (const attempt of attempts) {
      const running = execute(attempt);
      active.add(running);
      running.then(() => active.delete(running), () => {
        active.delete(running);
        onError('execution_settlement_deferred');
      });
    }
  }

  async function drain() {
    stopping = true;
    await claiming?.catch(() => {});
    await Promise.allSettled([...active]);
  }

  return { tick, drain, activeCount: () => active.size, workerId };
}

module.exports = { createExecutionWorker, retryDelay };
