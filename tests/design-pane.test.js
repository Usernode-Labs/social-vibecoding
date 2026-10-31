'use strict';

// #6071: a design thread's pane and the frame it draws a version in
// (frontend/src/features/messages/design-pane.tsx, frontend/src/features/
// design/frame.ts), and the way in from the Homeroom mark's menu.
//
// What this pins:
//   1. A version is drawn under a policy that loads nothing from anywhere but
//      this site and lets nothing out (no fetch, frame, form or <base>), in
//      a frame of its own origin that may run scripts and nothing else; the
//      pin helper goes first in its head, before any of the design's own.
//   2. A Homeroom page is drawn with today's stylesheets, not the build's it
//      was captured on.
//   3. The pane's first render reads nothing (the design loads in an
//      effect), and its words come from the catalog.
//   4. A design thread is a thread whose first message is the bot's
//      opened_design line, and the Messages screen draws the pane for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const frame = loadTsx('frontend/src/features/design/frame.ts');

test('a version is drawn under a policy that keeps it to this site, with the pin helper first', () => {
  const csp = frame.designCsp('https://homeroom.test');
  assert.equal(csp, [
    "default-src 'none'",
    "style-src 'unsafe-inline' https://homeroom.test",
    'img-src data: https://homeroom.test',
    'font-src data: https://homeroom.test',
    "script-src 'unsafe-inline'",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; '));
  assert.equal(frame.DESIGN_SANDBOX, 'allow-scripts', 'its own origin: never allow-same-origin, forms, popups or top navigation');
  const doc = frame.designFrameDoc('<!doctype html><html><head><base href="https://elsewhere.test/"><script>mine()</script></head><body>Hi</body></html>', { origin: 'https://homeroom.test' });
  assert.doesNotMatch(doc, /<base\b/i);
  const head = doc.indexOf('<head>') + '<head>'.length;
  assert.equal(doc.indexOf('<meta http-equiv="Content-Security-Policy"'), head, 'the policy is the head\'s first child');
  assert.ok(doc.indexOf("__design==='mode'") < doc.indexOf('mine()'), 'the helper runs before the design\'s own script');
  // A body with no document around it gets one.
  assert.match(frame.designFrameDoc('<p>Bare</p>', { origin: 'https://h.test' }), /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"[\s\S]*<body><p>Bare<\/p><\/body><\/html>$/);
});

test('a Homeroom page is drawn with today\'s stylesheets', () => {
  const captured = '<html><head><link rel="stylesheet" href="https://h.test/b/aaaa/css/app.css"><link rel="stylesheet" href="https://h.test/b/aaaa/css/tailwind.css"><link rel="icon" href="/favicon.ico"></head><body></body></html>';
  const now = ['https://h.test/b/bbbb/usernode-native/v1/native.css', 'https://h.test/b/bbbb/css/app.css', 'https://h.test/b/bbbb/css/tailwind.css'];
  const doc = frame.designFrameDoc(captured, { origin: 'https://h.test', sheets: now });
  assert.match(doc, /href="https:\/\/h\.test\/b\/bbbb\/css\/app\.css"/);
  assert.match(doc, /href="https:\/\/h\.test\/b\/bbbb\/css\/tailwind\.css"/);
  assert.match(doc, /<link rel="icon" href="\/favicon\.ico">/, 'a link that is no stylesheet is left as it was');
});

test('the pane reads nothing in its first render, and says it is drawing', () => {
  const calls = [];
  const api = new Proxy({}, { get: (_t, name) => (...args) => { calls.push(name); return new Promise(() => {}); } });
  const { DesignPane, isDesignRoot } = loadTsx('frontend/src/features/messages/design-pane.tsx', {
    stubs: {
      './api': api,
      './store': { loadReplyThread: () => Promise.resolve(), useMessagesSnapshot: () => ({ thread: null }) },
    },
  });
  const html = renderToHtml(createElement(DesignPane, { conversationId: 4, rootId: 9, view: 'preview', onView: () => {} }));
  assert.deepEqual(calls, [], 'no request in the first render');
  assert.match(html, /<section class="messages-design-pane" data-design-pane="9" data-design-view="preview" aria-label="Design preview">/);
  assert.match(html, new RegExp(message('messages:design.pane.loading').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(html, /<iframe/, 'the frame waits for the design');
  assert.equal(isDesignRoot({ sender: { bot: true }, metadata: { homeroomBot: { kind: 'opened_design' } } }), true);
  assert.equal(isDesignRoot({ sender: { bot: false }, metadata: { homeroomBot: { kind: 'opened_design' } } }), false);
  assert.equal(isDesignRoot({ sender: { bot: true }, metadata: { homeroomBot: { kind: 'opened_draft' } } }), false);
});

test('Messages draws the pane for a design thread, and the mark\'s menu opens one', () => {
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /const designOpen = !!designRootId && isDesignRoot\(designRoot\);/);
  assert.match(index, /<DesignPane conversationId=\{snap\.route\.conversationId\} rootId=\{designRootId\} view=\{designView\} onView=\{setDesignView\} \/>/);
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-layout\.messages-has-design > \.messages-thread-pane \{ display: none; \}/);
  // A row of the mark's menu, run once the menu has gone, so the capture is
  // of the screen and not of the menu over it.
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.match(sheet, /id="improve-row-design"[\s\S]*?void AppContext\.dismissForNav\(\)\.then\(\(\) => designThisScreen\(\)\);/);
  assert.doesNotMatch(read('frontend/src/features/improve/actions.tsx'), /improve-row-design/, 'never beside the one filled action');
  assert.equal(message('agent:menu.designScreen'), 'Design this screen');
});

test('the bridge answers a capture only to Homeroom, and its mirror is the same file', () => {
  const bridge = read('public/usernode-bridge/v1/bridge.js');
  const block = bridge.slice(bridge.indexOf('/* __USERNODE_CAPTURE_BEGIN__ */'), bridge.indexOf('/* __USERNODE_CAPTURE_END__ */'));
  assert.ok(block.length > 0);
  assert.match(block, /if \(e\.source !== window\.parent\) return;/);
  assert.match(block, /if \(!allowed \|\| from !== allowed\) return;/);
  assert.match(block, /window\.parent\.postMessage\(fields, allowed\)/, 'the reply goes to the platform origin alone');
  assert.match(block, /type === "password"/, 'a password never leaves');
  assert.match(block, /location\.pathname/, 'the address without its query');
  assert.doesNotMatch(block, /location\.search|location\.href/);
  assert.equal(read('public/usernode-bridge.js'), bridge);
});

test('the design routes are the owner\'s taps: same-origin and limited, and a pin rides only when it checks out', () => {
  const routes = read('src/routes/conversations.js');
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/designs', conversationActionLimiter, sameOriginBrowserOnly,/);
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/designs\/:rootId\/propose', conversationActionLimiter, sameOriginBrowserOnly,/);
  assert.match(routes, /if \(!pin\) return res\.status\(400\)/);
  assert.match(routes, /delete input\.design_pin;/, 'nothing else of the pin reaches the message');
  assert.match(read('server.js'), /req\.path === '\/api\/conversations\/homeroom-bot\/designs'\) \{\n\s+return express\.json\(\{ limit: '1mb' \}\)/);
});
