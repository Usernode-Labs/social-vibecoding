'use strict';

// A media transaction deliberately holds registry/owner locks during S3 I/O.
// Keep it active while waiting, but bound that wait and cancel its HTTP work.
// A checked-out pg Client emits connection errors itself (the Pool's idle
// error handler does not own it); those must fail the work, not the process.
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const HEARTBEAT_MS = 10000;
const TIMEOUT_MS = 120000;

function transport(protocol) {
  const base = require(protocol === 'https:' ? 'node:https' : 'node:http');
  return {
    request(options, callback) {
      const signal = context.getStore();
      return base.request(signal ? { ...options, signal } : options, callback);
    },
  };
}

async function run(tx, operation, { heartbeatMs = HEARTBEAT_MS, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let connectionLost = false;
  let connectionError;
  let heartbeat = null;
  let stopped = false;
  const lost = (err) => {
    if (!connectionLost) tx.once?.('end', () => tx.removeListener('error', lost));
    connectionLost = true;
    connectionError ||= err;
    controller.abort(err);
  };
  const failed = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  tx.on?.('error', lost);
  const interval = setInterval(() => {
    if (stopped || heartbeat || controller.signal.aborted) return;
    // One query at a time; finish an in-flight heartbeat before the caller
    // can COMMIT/ROLLBACK or return the client to its pool.
    heartbeat = Promise.resolve().then(() => tx.query({ text: 'SELECT 1', query_timeout: 5000 }))
      .catch(lost).finally(() => { heartbeat = null; });
  }, heartbeatMs);
  interval.unref?.();
  const deadline = setTimeout(() => controller.abort(Object.assign(
    new Error('Media storage operation timed out'), { code: 'media_storage_timeout' })), timeoutMs);
  deadline.unref?.();
  try {
    const work = Promise.resolve().then(() => context.run(controller.signal, () => operation(controller.signal)));
    return await Promise.race([work, failed]);
  } finally {
    stopped = true;
    clearInterval(interval);
    clearTimeout(deadline);
    // Also stop any SDK retry/request left behind by an ordinary failure.
    controller.abort();
    if (heartbeat) await heartbeat;
    // pg can emit the FATAL and then the socket-end error. The lost handler
    // removes its listener at end; a healthy pooled client loses it now.
    if (!connectionLost || !tx.once) {
      tx.removeListener?.('error', lost);
    }
    if (connectionError) throw connectionError;
  }
}

module.exports = { run, transport };
