'use strict';

// #6354: capture/capture.js's second mode. PAGE_CAPTURE opens one URL at one
// size and emits the design serializer's answer, and runs no shots and no
// checks.

const test = require('node:test');
const assert = require('node:assert/strict');

const capture = require('../capture/capture');

function stubBrowser(result) {
  const calls = { viewport: null, url: null };
  const page = {
    async setViewport(viewport) { calls.viewport = viewport; },
    async goto(url) { calls.url = url; },
    async waitForFunction() {},
    async evaluate() {
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const browser = { async newPage() { return page; }, async close() {} };
  return { browser, calls };
}

function collect() {
  const out = [];
  capture.setFrameSink((line) => out.push(line));
  return out;
}

test('PAGE_CAPTURE is parsed, and a malformed or non-http spec is refused', () => {
  assert.deepEqual(capture.parsePageCapture({ PAGE_CAPTURE: JSON.stringify({ url: 'https://x/y', viewport: { width: 390, height: 844 } }) }), {
    url: 'https://x/y', viewport: { width: 390, height: 844 },
  });
  assert.deepEqual(capture.parsePageCapture({ PAGE_CAPTURE: JSON.stringify({ url: 'https://x/y' }) }).viewport, { width: 1280, height: 800 });
  assert.equal(capture.parsePageCapture({ PAGE_CAPTURE: '{' }), null);
  assert.equal(capture.parsePageCapture({ PAGE_CAPTURE: JSON.stringify({ url: 'file:///etc/passwd' }) }), null);
  assert.equal(capture.parsePageCapture({}), null);
});

test('one page is emitted, as one frame, and nothing else is', async () => {
  const out = collect();
  const { browser, calls } = stubBrowser({ html: '<html>hi</html>' });
  const result = await capture.runPageCapture(
    { url: 'https://copy/?demo=1#homeroom-bot', viewport: { width: 390, height: 844 } },
    { launch: async () => browser, delayMs: 0 },
  );
  const text = out.join('');
  assert.equal(result.html, '<html>hi</html>');
  assert.equal(calls.url, 'https://copy/?demo=1#homeroom-bot');
  assert.deepEqual(calls.viewport, { width: 390, height: 844, deviceScaleFactor: 1 });
  assert.match(text, /__USERNODE_PAGE__ bytes=15\n/);
  assert.match(text, /^[A-Za-z0-9+/=]+$/m, 'the HTML is one base64 line');
  assert.match(text, /__USERNODE_PAGE_END__\n/);
  assert.doesNotMatch(text, /__USERNODE_SHOT__|__USERNODE_TEST__|__USERNODE_CONSOLE__/);
});

test('no serializer in the page, or a throw, gives a FAIL frame', async () => {
  const out = collect();
  const missing = stubBrowser(null);
  await capture.runPageCapture({ url: 'https://x/', viewport: { width: 1280, height: 800 } }, {
    launch: async () => missing.browser, delayMs: 0,
  });
  assert.match(out.join(''), /__USERNODE_PAGE_FAIL__ reason=no_page/);

  out.length = 0;
  const broken = stubBrowser(new Error('evaluate failed'));
  await capture.runPageCapture({ url: 'https://x/', viewport: { width: 1280, height: 800 } }, {
    launch: async () => broken.browser, delayMs: 0,
  });
  assert.match(out.join(''), /__USERNODE_PAGE_FAIL__ reason=evaluate%20failed/);
});
