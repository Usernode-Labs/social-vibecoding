'use strict';

// Screenshot comparison is optional CPU work. It must never hold the web
// process's health responses or a conductor's lease renewals: one crop
// search stalled both conductors for minutes on 29 Oct 2026. Each comparison
// has a worker and a deadline; a busy process declines more comparisons,
// except a run's own (below), which waits its turn.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const TIMEOUT_MS = 5000;
const MAX_WORKERS = 2;
// A run's own comparison, the screens its card shows (shots.publish, and its
// retry: shots-orchestrator.compareScreens / recompareScreens). It runs in a
// worker thread, so a short deadline protects no event loop; it only threw
// away comparisons of large phone close-ups on busy nodes. On 23 Nov 2026
// PR 7037's shots published with no screens, so its card fell back to the
// older viewer. Such a comparison gets this long, and when the process is at
// MAX_WORKERS it waits for a worker, at most MAX_WAITING of them at once,
// instead of being refused.
const RUN_COMPARE_TIMEOUT_MS = 60_000;
const MAX_WAITING = 8;
// The checks a still gets as it is saved (shots-diff.checkSave) answer the
// agent's save_shot, so they get less time: a check that cannot finish is
// left out, never waited for.
const CHECK_TIMEOUT_MS = 3000;
const failure = (code, message) => Object.assign(new Error(message), { code });

// Owned copy of one PNG for a worker, its storage transferred. Detaching a
// pg Buffer's backing array could detach other files in the same database
// response, so the bytes are always copied first.
function owned(data, transferList) {
  const copy = Uint8Array.from(data);
  transferList.push(copy.buffer);
  return copy;
}
const asBuffer = (data) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

// One task in a worker of its own, at most `maxWorkers` at a time. A task
// asked with `wait` waits for a worker when they are all taken, behind at
// most `maxWaiting` others (its deadline starts with its worker); any other
// is refused at once.
function createRunner({ timeoutMs, maxWorkers, workerFile, busy, maxWaiting = 0 }) {
  let active = 0;
  const waiting = [];
  // A worker given back goes to the next task waiting for one.
  const free = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return function run(data, transferList, { signal, wait = false, timeoutMs: deadlineMs = timeoutMs } = {}) {
    const aborted = () => signal.reason instanceof Error ? signal.reason
      : failure('shots_diff_aborted', 'Screenshot comparison stopped');
    if (signal?.aborted) return Promise.reject(aborted());
    if (active >= maxWorkers) {
      if (!wait || waiting.length >= maxWaiting) return Promise.reject(failure('shots_diff_busy', busy));
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const at = waiting.indexOf(start);
          if (at !== -1) waiting.splice(at, 1);
          reject(aborted());
        };
        function start() {
          signal?.removeEventListener('abort', onAbort);
          active += 1;
          launch(data, transferList, signal, deadlineMs, aborted).then(resolve, reject);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        waiting.push(start);
      });
    }
    active += 1;
    return launch(data, transferList, signal, deadlineMs, aborted);
  };

  function launch(data, transferList, signal, deadlineMs, aborted) {
    return new Promise((resolve, reject) => {
      let worker;
      let timer;
      let done = false;
      const onAbort = () => finish(aborted());
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // Do not give the slot back until the worker has actually stopped,
        // including on a timeout, cancellation, error or a successful result.
        Promise.resolve(worker?.terminate()).then(() => {
          free();
          if (error) reject(error); else resolve(result);
        }, (err) => { free(); reject(error || err); });
      };
      try {
        worker = new Worker(workerFile, {
          workerData: data, transferList,
          // No server/test preloads in this CPU-only worker.
          execArgv: [],
        });
        worker.once('message', (result) => finish(null, result));
        worker.once('error', (error) => finish(error));
        worker.once('exit', (code) => finish(failure('shots_diff_worker_exit', `Screenshot comparison exited without a result (${code})`)));
        timer = setTimeout(() => finish(failure('shots_diff_timeout', 'Screenshot comparison exceeded its time budget')), deadlineMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      } catch (error) { finish(error); }
    });
  }
}

// `wait`: a run's own comparison (RUN_COMPARE_TIMEOUT_MS above), which waits
// for a worker and has the longer deadline. Without it (the close-ups an
// agent's tool asks for while it works) a busy process refuses, and the
// deadline is the short one.
function createComparer({
  timeoutMs = TIMEOUT_MS, runTimeoutMs = RUN_COMPARE_TIMEOUT_MS, maxWorkers = MAX_WORKERS, maxWaiting = MAX_WAITING,
  workerFile = __filename,
} = {}) {
  const run = createRunner({ timeoutMs, maxWorkers, maxWaiting, workerFile, busy: 'Screenshot comparisons are at this process\'s limit' });
  return function screensFor(stories, files, { signal, wait = false } = {}) {
    let transferList;
    let images;
    try {
      transferList = [];
      // Only the PNGs the matcher reads, never clips or dense originals,
      // with an element shot's recorded place (its frame, shots-diff).
      images = files.filter((f) => f.media === 'png' && ['context', 'focus'].includes(f.variant)).map((f) => {
        const { storyId, viewport, side, variant, media, sha256 } = f;
        const focusRect = variant === 'focus' && f.focusRect && typeof f.focusRect === 'object'
          ? { x: f.focusRect.x, y: f.focusRect.y, w: f.focusRect.w, h: f.focusRect.h } : null;
        return { storyId, viewport, side, variant, media, sha256, ...(focusRect ? { focusRect } : {}), data: owned(f.data, transferList) };
      });
    } catch (error) { return Promise.reject(error); }
    return run({ shotsComparison: true, stories, files: images }, transferList,
      { signal, wait, timeoutMs: wait ? runTimeoutMs : timeoutMs });
  };
}

// shots-diff.checkSave in a worker: a dark screen against its light one, or
// an element shot against its screen shot. `job` names its PNGs (`light` and
// `dark`, or `screen` and `element`) with their densities.
function createChecker({ timeoutMs = CHECK_TIMEOUT_MS, maxWorkers = MAX_WORKERS, workerFile = __filename } = {}) {
  const run = createRunner({ timeoutMs, maxWorkers, workerFile, busy: 'Screenshot checks are at this process\'s limit' });
  return function checkSave(job, { signal } = {}) {
    const transferList = [];
    const copy = { ...job };
    try {
      for (const key of ['light', 'dark', 'screen', 'element']) {
        if (job[key] != null) copy[key] = owned(job[key], transferList);
      }
    } catch (error) { return Promise.reject(error); }
    return run({ shotsCheck: true, job: copy }, transferList, { signal });
  };
}

if (!isMainThread && workerData?.shotsComparison) {
  const files = workerData.files.map((f) => ({ ...f, data: asBuffer(f.data) }));
  require('./shots-diff').screensFor(workerData.stories, files).then((screens) => parentPort.postMessage(screens));
}
if (!isMainThread && workerData?.shotsCheck) {
  const job = { ...workerData.job };
  for (const key of ['light', 'dark', 'screen', 'element']) if (job[key] != null) job[key] = asBuffer(job[key]);
  parentPort.postMessage(require('./shots-diff').checkSave(job));
}

module.exports = {
  TIMEOUT_MS,
  RUN_COMPARE_TIMEOUT_MS,
  MAX_WAITING,
  CHECK_TIMEOUT_MS,
  MAX_WORKERS,
  createComparer,
  createChecker,
  screensFor: createComparer(),
  checkSave: createChecker(),
  unchangedStories: require('./shots-diff').unchangedStories,
  elsewhereNotices: require('./shots-diff').elsewhereNotices,
  fallbackScreens: require('./shots-diff').fallbackScreens,
};
