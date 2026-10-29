'use strict';

// Screenshot comparison is optional CPU work. It must never hold the web
// process's health responses or a conductor's lease renewals: one crop
// search stalled both conductors for minutes on 29 Oct 2026. Each comparison
// has a worker and a deadline; a busy process declines more comparisons.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const TIMEOUT_MS = 5000;
const MAX_WORKERS = 2;
const failure = (code, message) => Object.assign(new Error(message), { code });

function createComparer({ timeoutMs = TIMEOUT_MS, maxWorkers = MAX_WORKERS, workerFile = __filename } = {}) {
  let active = 0;
  return function screensFor(stories, files, { signal } = {}) {
    const aborted = () => signal.reason instanceof Error ? signal.reason
      : failure('shots_diff_aborted', 'Screenshot comparison stopped');
    if (signal?.aborted) return Promise.reject(aborted());
    if (active >= maxWorkers) {
      return Promise.reject(failure('shots_diff_busy', 'Screenshot comparisons are at this process\'s limit'));
    }
    active += 1;
    return new Promise((resolve, reject) => {
      let worker;
      let timer;
      let done = false;
      const onAbort = () => finish(aborted());
      const finish = (error, screens) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // Do not give the slot back until the worker has actually stopped,
        // including on a timeout, cancellation, error or a successful result.
        Promise.resolve(worker?.terminate()).then(() => {
          active -= 1;
          if (error) reject(error); else resolve(screens);
        }, (err) => { active -= 1; reject(error || err); });
      };
      try {
        const transferList = [];
        const images = files.filter((f) => f.media === 'png' && ['context', 'focus'].includes(f.variant)).map((f) => {
          // Only the PNGs the matcher reads, never clips or dense originals.
          // Own the transferred storage: detaching a pg Buffer's backing
          // array could detach other files in the same database response.
          const data = Uint8Array.from(f.data);
          transferList.push(data.buffer);
          const { storyId, viewport, side, variant, media, sha256 } = f;
          return { storyId, viewport, side, variant, media, sha256, data };
        });
        worker = new Worker(workerFile, {
          workerData: { shotsComparison: true, stories, files: images }, transferList,
          // No server/test preloads in this CPU-only worker.
          execArgv: [],
        });
        worker.once('message', (screens) => finish(null, screens));
        worker.once('error', (error) => finish(error));
        worker.once('exit', (code) => finish(failure('shots_diff_worker_exit', `Screenshot comparison exited without a result (${code})`)));
        timer = setTimeout(() => finish(failure('shots_diff_timeout', 'Screenshot comparison exceeded its time budget')), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      } catch (error) { finish(error); }
    });
  };
}

if (!isMainThread && workerData?.shotsComparison) {
  const files = workerData.files.map((f) => ({ ...f,
    data: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength) }));
  require('./shots-diff').screensFor(workerData.stories, files).then((screens) => parentPort.postMessage(screens));
}

module.exports = {
  TIMEOUT_MS,
  MAX_WORKERS,
  createComparer,
  screensFor: createComparer(),
  unchangedStories: require('./shots-diff').unchangedStories,
};
