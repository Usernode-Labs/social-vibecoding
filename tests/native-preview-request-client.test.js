'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const MOD = 'frontend/src/lib/preview-request.ts';

function storage(t) {
  const values = new Map();
  const old = global.sessionStorage;
  global.sessionStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  t.after(() => {
    if (old === undefined) delete global.sessionStorage;
    else global.sessionStorage = old;
  });
  return values;
}

for (const failure of ['network', 'server', 'unreadable']) {
  test(`manual client retains intent through ${failure}, reload and completed reply`, async t => {
    const values = storage(t);
    const identities = [];
    let lost = true;
    const send = async (_url, options) => {
      identities.push(options.headers['Idempotency-Key']);
      if (lost) {
        if (failure === 'network') throw new Error('Lost reply');
        if (failure === 'server') return new Response('{}', { status: 500 });
        return new Response('');
      }
      return new Response(JSON.stringify({ status: 'complete', workId: 'retained' }));
    };
    const original = loadTsx(MOD);
    if (failure === 'network') await assert.rejects(original.postPreviewRequest(91, 'recheck', send), /Lost/);
    else await original.postPreviewRequest(91, 'recheck', send);
    assert.equal(values.size, 1);
    lost = false;
    const restarted = loadTsx(MOD);
    const reply = await restarted.postPreviewRequest(91, 'recheck', send);
    assert.deepEqual(await reply.json(), { status: 'complete', workId: 'retained' });
    assert.equal(identities[0], identities[1]);
    assert.equal(values.size, 0);
    await restarted.postPreviewRequest(91, 'recheck', send);
    assert.notEqual(identities[2], identities[1], 'A new intentional rerun gets a new identity');
  });
}

test('manual client coalesces concurrent intent identity and keeps session/kind independent', async t => {
  storage(t);
  const mod = loadTsx(MOD);
  const calls = [];
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const send = async (_url, options) => {
    calls.push(options.headers['Idempotency-Key']);
    await wait;
    return new Response('{}');
  };
  const first = mod.postPreviewRequest(92, 'ensure-staging', send);
  const repeated = mod.postPreviewRequest(92, 'ensure-staging', send);
  const otherKind = mod.postPreviewRequest(92, 'recheck', send);
  const otherSession = mod.postPreviewRequest(93, 'ensure-staging', send);
  assert.equal(calls[0], calls[1]);
  assert.equal(new Set(calls).size, 3);
  release();
  await Promise.all([first, repeated, otherKind, otherSession]);
});

test('an older overlapping reply cannot erase a newer unknown intent', async t => {
  const values = storage(t);
  const mod = loadTsx(MOD);
  let releaseOlder;
  let calls = 0;
  const send = async () => {
    const call = ++calls;
    if (call === 2) await new Promise(resolve => { releaseOlder = resolve; });
    if (call === 3) throw new Error('New intent reply lost');
    return new Response('{}');
  };
  const first = mod.postPreviewRequest(94, 'recheck', send);
  const older = mod.postPreviewRequest(94, 'recheck', send);
  await first;
  await assert.rejects(mod.postPreviewRequest(94, 'recheck', send), /New intent/);
  const identity = values.get('native-preview-intent:94:recheck');
  releaseOlder();
  await older;
  assert.equal(values.get('native-preview-intent:94:recheck'), identity);
});
