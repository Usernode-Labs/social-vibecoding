'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const diff = require('../src/services/shots-diff');
const comparison = require('../src/services/shots-diff-worker');

// Real workers exercise termination even while their JavaScript never
// yields, failures before a result, and the release of occupied slots.
function workerFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-diff-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'worker.cjs');
  fs.writeFileSync(file, `
    const { parentPort, workerData } = require('node:worker_threads');
    const { mode, started } = workerData.stories[0] || {};
    if (mode === 'hang') {
      Atomics.store(started, 0, 1);
      Atomics.notify(started, 0);
      while (true) {}
    } else if (mode === 'error') {
      throw new Error('bad image');
    } else if (mode !== 'exit') {
      parentPort.postMessage([]);
    }
  `);
  return file;
}

async function untilStarted(started) {
  await Atomics.waitAsync(started, 0, 0, 2000).value;
  assert.equal(Atomics.load(started, 0), 1, 'the worker entered its non-yielding computation');
}

test('comparison in a worker preserves normal outlines and leaves the caller\'s PNGs intact', async () => {
  const image = (changed) => {
    const png = new PNG({ width: 100, height: 80 });
    png.data.fill(255);
    if (changed) {
      for (let y = 20; y < 40; y += 1) {
        for (let x = 10; x < 60; x += 1) png.data.set([20, 80, 200, 255], (y * 100 + x) * 4);
      }
    }
    return PNG.sync.write(png);
  };
  const stories = [{ id: 'badge', viewports: [{ name: 'desktop', width: 100 }] }];
  const files = ['base', 'head'].map((side) => ({ storyId: 'badge', viewport: 'desktop', side,
    variant: 'context', media: 'png', sha256: side, data: image(side === 'head') }));
  const copies = files.map((f) => Buffer.from(f.data));
  files.push({ media: 'webm', variant: 'animation', get data() { throw new Error('clips must not be copied'); } });
  const expected = await diff.screensFor(stories, files);
  assert.ok(expected[0].regions.length);
  assert.deepEqual(await comparison.screensFor(stories, files), expected);
  assert.deepEqual(files.slice(0, 2).map((f) => f.data), copies, 'transferring worker input never detaches shared pg buffers');
});

test('a non-yielding worker times out while the parent keeps serving timers, and releases its slot', async (t) => {
  const compare = comparison.createComparer({ workerFile: workerFixture(t), timeoutMs: 1000, maxWorkers: 1 });
  const started = new Int32Array(new SharedArrayBuffer(4));
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks += 1; }, 10);
  t.after(() => clearInterval(heartbeat));
  const timedOut = assert.rejects(compare([{ mode: 'hang', started }], []), { code: 'shots_diff_timeout' });
  await untilStarted(started);
  await timedOut;
  assert.ok(ticks >= 3, 'lease renewals and health responses can run while a comparison is stuck');
  assert.deepEqual(await compare([], []), [], 'the timed-out worker was terminated before the slot was reused');
});

test('work at the process limit is declined, and cancellation kills a running comparison', async (t) => {
  const compare = comparison.createComparer({ workerFile: workerFixture(t), maxWorkers: 1 });
  const controller = new AbortController();
  const reason = new Error('work lease lost');
  const started = new Int32Array(new SharedArrayBuffer(4));
  const stopped = assert.rejects(compare([{ mode: 'hang', started }], [], { signal: controller.signal }),
    (error) => error === reason);
  await untilStarted(started);
  await assert.rejects(compare([], []), { code: 'shots_diff_busy' });
  controller.abort(reason);
  await stopped;
  assert.deepEqual(await compare([], []), []);
  await assert.rejects(compare([], [], { signal: controller.signal }), (error) => error === reason);
  assert.deepEqual(await compare([], []), [], 'an already stopped request took no slot');
});

test('worker errors and an exit without a result settle promptly and leave capacity usable', async (t) => {
  const compare = comparison.createComparer({ workerFile: workerFixture(t), maxWorkers: 1 });
  await assert.rejects(compare([{ mode: 'error' }], []), /bad image/);
  assert.deepEqual(await compare([], []), []);
  await assert.rejects(compare([{ mode: 'exit' }], []), { code: 'shots_diff_worker_exit' });
  assert.deepEqual(await compare([], []), []);
  await assert.rejects(comparison.screensFor([], [{ media: 'png', variant: 'context', data: null }]));
  assert.deepEqual(await comparison.screensFor([], []), [], 'failure while preparing worker input releases its slot too');
});

test('publishing falls back once on a comparison timeout and propagates a lost lease', async (t) => {
  const control = require('../src/services/shots-control');
  const orchestrator = require('../src/services/shots-orchestrator');
  const verdict = { stories: [{ id: 'badge', status: 'ready' }] };
  t.mock.method(control, 'read', async () => ({ intent: { stories: [{ id: 'badge', viewports: [] }] } }));
  t.mock.method(control, 'filesFor', async () => []);
  const timeout = Object.assign(new Error('budget exceeded'), { code: 'shots_diff_timeout' });
  const run = t.mock.method(comparison, 'screensFor', async () => { throw timeout; });
  t.mock.method(require('../src/services/logger'), 'warn', () => {});
  assert.equal(await orchestrator.compareScreens(null, { runId: 'run', verdict }), verdict);
  assert.equal(run.mock.callCount(), 1, 'the completed fallback does not retry the comparison');
  const controller = new AbortController();
  controller.abort(new Error('lease lost'));
  await assert.rejects(orchestrator.compareScreens(null, { runId: 'run', verdict, signal: controller.signal }),
    (error) => error === timeout);
  assert.equal(run.mock.calls[1].arguments[2].signal, controller.signal);
});

test('close-up generation falls back to no requests when its comparison cannot finish', async (t) => {
  const control = require('../src/services/shots-control');
  const timeout = Object.assign(new Error('budget exceeded'), { code: 'shots_diff_timeout' });
  t.mock.method(comparison, 'screensFor', async () => { throw timeout; });
  t.mock.method(require('../src/services/logger'), 'warn', () => {});
  const run = { runId: 'run', agent: { deviceDensity: true }, saved: { has: () => true },
    intent: { stories: [{ id: 'badge', viewports: [{ name: 'desktop' }] }] } };
  assert.deepEqual(await control.wantedCloseups({ query: async () => ({ rows: [] }) }, run), []);
});
