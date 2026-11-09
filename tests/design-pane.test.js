'use strict';

// #6071: a design thread's pane and the frame it draws a version in
// (frontend/src/features/messages/design-pane.tsx, frontend/src/features/
// design/frame.ts), and the way in. 1 Nov 2026 (C1): the screen picker
// retired; the bot draws a screen from words in any private thread
// (tests/design-anywhere.test.js pins the drawing and the preview column).
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
//      opened_design line, or (1 Nov 2026) one the bot said a version in.

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
  const { isDesignThread } = loadTsx('frontend/src/features/messages/design-pane.tsx', {
    stubs: { './api': api, './store': { loadReplyThread: () => Promise.resolve(), useMessagesSnapshot: () => ({ thread: null }) } },
  });
  const plus = { sender: { bot: true }, metadata: { homeroomBot: { kind: 'opened_thread' } } };
  assert.equal(isDesignThread(plus, []), false, 'a "+" thread with no version said in it');
  assert.equal(isDesignThread(plus, [{ sender: { bot: true }, metadata: { homeroomBot: { kind: 'design_version', designVersion: 1 } } }]), true, 'any thread the bot said a version in');
  assert.equal(isDesignThread(plus, [{ sender: { bot: false }, metadata: { homeroomBot: { designVersion: 1 } } }]), false, 'only the bot says one');
});

// #6143 (2 Nov 2026): a phone-width drawing sat against the pane's left edge,
// and the version picker was cut at 16rem with the header's room to spare.
test('a drawing narrower than the pane is centred, and the version picker takes the header\'s width', () => {
  const pane = read('frontend/src/features/messages/design-pane.tsx');
  const classesOf = (re, what) => {
    const found = pane.match(re);
    assert.ok(found, what);
    return found[1].split(/\s+/);
  };
  const frameBox = classesOf(/style=\{\{ width: Math\.round\(design\.width \* scale\), height: Math\.round\(design\.height \* scale\) \}\} className="([^"]+)"/,
    'the frame\'s wrapper, sized to the scaled drawing');
  assert.ok(frameBox.includes('mx-auto'), 'centred in the stage; one scaled to fit fills it anyway');
  assert.ok(frameBox.includes('relative'));
  const picker = classesOf(/<select\s+className="([^"]+)"[\s\S]*?data-design-version=""/, 'the version picker');
  assert.ok(!picker.includes('max-w-[16rem]'), 'no fixed cap');
  assert.ok(picker.includes('max-w-full'), 'as wide as the header lets it be');
  assert.ok(picker.includes('min-w-0') && picker.includes('truncate'), 'and cut short only when the header runs out of room');
});

// #6350: the Request card's box starts with what the bot said about the
// version being filed, so filing never begins blank; the capture's own note
// marks the starting screen, so it is not a description of a change.
test('the Request card starts its notes from the version being filed, never the capture', () => {
  const api = new Proxy({}, { get: (_t, name) => () => { throw new Error(`the first render reads nothing (${String(name)})`); } });
  const { ProposeCard } = loadTsx('frontend/src/features/messages/design-pane.tsx', {
    stubs: {
      './api': api,
      './store': { loadReplyThread: () => Promise.resolve(), useMessagesSnapshot: () => ({ thread: null }) },
    },
  });
  const design = {
    rootId: 9,
    title: 'Plots',
    latest: 3,
    versions: [
      { version: 1, author: 'capture', note: 'As it is now' },
      { version: 2, author: 'bot', note: 'Both lists drawn in full' },
      { version: 3, author: 'bot', note: null },
    ],
  };
  const notesOf = (version) => {
    const html = renderToHtml(createElement(ProposeCard, { design, version, onClose: () => {}, onDone: () => {} }));
    const box = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
    assert.ok(box, 'the What changes, and why box is drawn');
    return box[1];
  };
  assert.equal(notesOf(2), 'Both lists drawn in full', 'the version filed has a note');
  assert.equal(notesOf(3), 'Both lists drawn in full', 'a version with no note falls back to the newest earlier one');
  assert.equal(notesOf(1), '', 'the capture is skipped: it is the screen as it is now, not a change');
});

test('Messages draws the pane for a design thread, and the bot\'s new thread opens one', () => {
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /const designOpen = !!designRootId && isDesignRoot\(designRoot\);/);
  assert.match(index, /<DesignPane conversationId=\{snap\.route\.conversationId\} rootId=\{designRootId\} view=\{designView\} onView=\{setDesignView\} \/>/);
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-layout\.messages-has-design > \.messages-thread-pane \{ display: none; \}/);
  // Not the mark's menu any more, and (1 Nov 2026) no screen picker either:
  // the bot draws a screen from words, so nothing goes to a screen to pick.
  const sheet = read('frontend/src/features/app-context/app-context-sheet.tsx');
  assert.doesNotMatch(sheet, /improve-row-design|designThisScreen|agent:menu\.designScreen/);
  assert.doesNotMatch(read('frontend/src/features/improve/actions.tsx'), /improve-row-design/);
  assert.throws(() => message('agent:menu.designScreen'));
  for (const gone of ['frontend/src/features/design/pick.tsx', 'frontend/src/features/design/start.ts']) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `${gone} retired`);
  }
  assert.throws(() => message('messages:design.pick.use'));
  assert.doesNotMatch(read('frontend/src/features/messages/new-thread.tsx'), /startScreenPick|data-bot-new-thread-pick/);
  assert.doesNotMatch(read('frontend/src/features/messages/bot-question.tsx'), /action\.type === 'design'|startScreenPick/);
  // No 'design': an old Pick the screen button is no longer drawn ('make' is
  // Make the project's sheet, bot-make.tsx).
  assert.match(read('frontend/src/features/messages/api.ts'), /const BOT_ACTION_TYPES = new Set\(\['server', 'open', 'prompt', 'preview', 'vote', 'reply', 'invite', 'make'\]\);/,
    'an old Pick the screen button is no longer drawn');
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

// #6261: a comment's picture leaves every frame out, so a design's frame was
// a blank box. The frame draws its own body, with the vendored SnapDOM source
// sent in and run as an inline script (the policy allows inline scripts),
// and answers the shell.
test('a design frame draws its own picture when the shell asks', () => {
  const doc = frame.designFrameDoc('<p>Hi</p>', { origin: 'https://h.test' });
  assert.equal(frame.DESIGN_FRAME_ATTR, 'data-design-frame');
  // The helper answers a picture request, and only from the parent.
  assert.match(doc, /d\.__design==='picture'/, 'the helper handles a picture request');
  assert.match(doc, /typeof d\.lib!=='string'/, 'the library text comes in the request');
  assert.match(doc, /s\.textContent=d\.lib/, 'the vendored library arrives as an inline script');
  assert.match(doc, /exclude:\['\[data-design-pins\]'\]/, 'the pins layer is left out of the design\'s own picture');
  assert.match(doc, /parent\.postMessage\(\{__design:'picture'/, 'the picture goes back to the shell');
  assert.match(doc, /e\.source!==parent/, 'only the parent is believed');
  assert.match(doc, /\},'\*'\);/, 'the frame\'s origin is opaque, so the reply is not origin-scoped');
  // The safety limits are unchanged.
  assert.ok(doc.includes(`content="${frame.designCsp('https://h.test')}"`), 'the same policy as before');
  assert.equal(frame.DESIGN_SANDBOX, 'allow-scripts');
  // Both design frames are marked for the shell to find.
  assert.match(read('frontend/src/features/messages/design-pane.tsx'), /data-design-frame=""/);
  assert.match(read('frontend/src/features/messages/design-card.tsx'), /data-design-frame=""/);
});

test('the design routes are the owner\'s taps: same-origin and limited, and a pin rides only when it checks out', () => {
  const routes = read('src/routes/conversations.js');
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/designs', conversationActionLimiter, sameOriginBrowserOnly,/);
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/designs\/:rootId\/propose', conversationActionLimiter, sameOriginBrowserOnly,/);
  assert.match(routes, /if \(!pin\) return res\.status\(400\)/);
  assert.match(routes, /delete input\.design_pin;/, 'nothing else of the pin reaches the message');
  assert.match(read('server.js'), /req\.path === '\/api\/conversations\/homeroom-bot\/designs'\) \{\n\s+return express\.json\(\{ limit: '1mb' \}\)/);
});
