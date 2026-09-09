const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../src/services/application-runtime');

test('Kubernetes health uses the configured namespace and cancels response bodies', async (t) => {
  let cancelled = false;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, 'http://preview.custom-apps.svc:3000/health');
    assert.equal(options.redirect, 'error');
    return { ok: true, body: { cancel: async () => { cancelled = true; } } };
  });
  assert.equal(await runtime.probeHealth({ appRuntime: 'kubernetes', kubernetes: { appNamespace: 'custom-apps' } }, { runtimeName: 'preview' }), true);
  assert.equal(cancelled, true);
});

test('Kubernetes health turns network errors and timed-out probes into unverified results', async (t) => {
  const ref = { runtimeKind: 'kubernetes', runtimeName: 'preview' };
  t.mock.method(global, 'fetch', async () => { throw new Error('connection refused'); });
  assert.equal(await runtime.probeHealth({}, ref), false);
  t.mock.method(global, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  // AbortSignal.timeout is unref'ed; keep the test alive until it fires.
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.equal(await runtime.probeHealth({}, ref, { timeoutMs: 10 }), false); }
  finally { clearTimeout(keepAlive); }
});
