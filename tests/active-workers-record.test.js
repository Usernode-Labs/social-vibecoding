'use strict';

// services/active-workers.js: a turn or an operation on a session is this
// process's hold (services/processes.js), which another process reads. With
// the preview machine on, the work goes on only once that hold is written,
// so a decision elsewhere (the preview machine's retirement guard, the
// carry search for a merge) cannot miss work that has already begun. Off,
// as [main]: nothing waits.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const flag = { on: true };
stub('../src/workflow/platform.ts', { previewsEnabled: () => flag.on });
// A hold whose row is written only when the test says so.
let write = null;
stub('../src/services/processes', {
  hold() {
    let done;
    const release = () => {};
    release.written = new Promise((r) => { done = r; });
    write = done;
    return release;
  },
  heldElsewhere: () => false,
});

const { activeWorkers, beginSessionOperation } = require('../src/services/active-workers');
const settled = async (p) => {
  let out = false;
  p.then(() => { out = true; });
  await new Promise((r) => setImmediate(r));
  return out;
};

test('with the preview machine on, an operation goes on only once its hold is written', async () => {
  flag.on = true;
  const release = beginSessionOperation(42);
  assert.equal(await settled(release.recorded), false, 'waiting for the write');
  write();
  assert.equal(await settled(release.recorded), true);
  release();
});

test('with the preview machine on, a turn goes on only once its hold is written', async () => {
  flag.on = true;
  const entered = activeWorkers.enter(41);
  assert.equal(await settled(entered), false, 'waiting for the write');
  write();
  assert.equal(await settled(entered), true);
  activeWorkers.delete(41);
});

test('with it off, nothing waits for the write, as on [main]', async () => {
  flag.on = false;
  const release = beginSessionOperation(43);
  assert.equal(await settled(release.recorded), true);
  release();
  assert.equal(await settled(activeWorkers.enter(44)), true);
  activeWorkers.delete(44);
  flag.on = true;
});
