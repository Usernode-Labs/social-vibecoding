'use strict';

// Artifacts, stage 1 (docs/plans/artifacts.md): THE frame every page the bot
// writes is drawn in (frontend/src/features/artifact/frame.tsx), the
// document it draws (frame-doc.ts) and the rule about who sees a page
// running. Each surface that moved onto it is rendered here with the data
// the server stores for it; tests/artifact-frames-browser.test.js draws the
// same surfaces in a real browser.
//
//   1. The frame's document: the policy first in its head, the helper before
//      any of the page's own, no <base>, today's stylesheets for a captured
//      Homeroom page; static, with everything of the page's that would run
//      taken out.
//   2. The viewer rule: a page runs for its author; anyone else gets the
//      static version unless they choose, and no caller can hand a prebuilt
//      document to a running frame.
//   3. Each surface: a design's version (pane, card, comparison), a plan's
//      screen, a laid-out answer, a first look's drawn screen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const policy = require('../src/services/artifact-policy');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*$/gm, '');

const docs = loadTsx('frontend/src/features/artifact/frame-doc.ts');
const { ArtifactFrame, frameModeFor } = loadTsx('frontend/src/features/artifact/frame.tsx');

const SITE = 'https://homeroom.test';
const unescape = (value) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
const frameOf = (html) => {
  const tag = /<iframe\b[^>]*>/.exec(html);
  assert.ok(tag, 'a frame is drawn');
  const attr = (name) => {
    const found = new RegExp(`\\s${name}="([^"]*)"`).exec(tag[0]);
    return found ? unescape(found[1]) : null;
  };
  return { tag: tag[0], attr };
};

// A design's version as design-bot.js saves it (a whole document, a project
// stylesheet written in, a script for an interactive state).
const VERSION = '<!doctype html><html><head><base href="https://elsewhere.test/"><meta charset="utf-8">'
  + '<style data-design-sheet="public/styles.css">.row{padding:12px}</style></head>'
  + '<body class="app" onload="boot()"><button id="more" class="row" onclick="openMenu()">More</button>'
  + '<a href="javascript:openMenu()">Open</a><ul id="menu" hidden><li>Water</li></ul>'
  + '<script>function openMenu(){document.getElementById("menu").hidden=false}</script></body></html>';

test('a running page: the policy is the head\'s first child, the helper runs before the page\'s own script, no <base>', () => {
  const doc = docs.artifactFrameDoc(VERSION, { mode: 'run', origin: SITE });
  assert.doesNotMatch(doc, /<base\b/i);
  const head = doc.indexOf('<head>') + '<head>'.length;
  assert.equal(doc.indexOf(`<meta http-equiv="Content-Security-Policy" content="${policy.cspFor('run', { site: SITE })}">`), head);
  assert.ok(doc.indexOf("k==='mode'") > 0 && doc.indexOf("k==='mode'") < doc.indexOf('function openMenu'), 'the helper is first');
  assert.match(doc, /onclick="openMenu\(\)"/, 'the page\'s own handlers are left: it is running');
  // A page that draws with none of this site's stylesheets names no origin.
  assert.ok(docs.artifactFrameDoc('<p>Hi</p>', { mode: 'run', origin: SITE, site: false }).includes(`content="${policy.cspFor('run')}"`));
  // A body with no document around it gets one.
  assert.match(docs.artifactFrameDoc('<p>Bare</p>', { mode: 'run', origin: SITE }),
    /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"[\s\S]*<body><p>Bare<\/p><\/body><\/html>$/);
  // A running page keeps its own clicks; a static one's links are the shell's to open.
  assert.match(doc, /\}\)\(0\);<\/script>/);
});

test('a captured Homeroom page is drawn with today\'s stylesheets', () => {
  const captured = '<html><head><link rel="stylesheet" href="https://h.test/b/aaaa/css/app.css"><link rel="stylesheet" href="https://h.test/b/aaaa/css/tailwind.css"><link rel="icon" href="/favicon.ico"></head><body></body></html>';
  const now = ['https://h.test/b/bbbb/usernode-native/v1/native.css', 'https://h.test/b/bbbb/css/app.css', 'https://h.test/b/bbbb/css/tailwind.css'];
  const doc = docs.artifactFrameDoc(captured, { mode: 'run', origin: 'https://h.test', sheets: now });
  assert.match(doc, /href="https:\/\/h\.test\/b\/bbbb\/css\/app\.css"/);
  assert.match(doc, /href="https:\/\/h\.test\/b\/bbbb\/css\/tailwind\.css"/);
  assert.match(doc, /<link rel="icon" href="\/favicon\.ico">/, 'a link that is no stylesheet is left as it was');
});

test('a static page: everything of its own that would run is taken out, and no helper goes in without a nonce', () => {
  const still = docs.staticMarkup(VERSION);
  assert.doesNotMatch(still, /<script|onload=|onclick=|javascript:/i);
  assert.match(still, /<button id="more" class="row">More<\/button>/, 'the markup and its classes stay');
  assert.match(still, /<a href="#">Open<\/a>/);
  assert.match(still, /<style data-design-sheet="public\/styles\.css">\.row\{padding:12px\}<\/style>/, 'and its styles');
  // Text that only looks like a handler is not markup.
  assert.equal(docs.staticMarkup('<p>Set onclick="x" on the button</p>'), '<p>Set onclick="x" on the button</p>');
  assert.equal(docs.staticMarkup('<script>a()</script><p>x</p><script src="y">'), '<p>x</p>');

  const doc = docs.artifactFrameDoc(VERSION, { mode: 'static', origin: SITE });
  assert.ok(doc.includes(`content="${policy.cspFor('static', { site: SITE })}"`));
  assert.doesNotMatch(doc, /<script/i, 'nothing runs: not the page\'s, not the helper');
  assert.doesNotMatch(docs.artifactFrameDoc(VERSION, { mode: 'static', origin: SITE, nonce: 'f00d' }), /<script/i, 'a static page never takes the helper, nonce or not');
  // The helper mode: the page cleaned as a static one, and Homeroom's helper alone, by its nonce.
  assert.doesNotMatch(docs.artifactFrameDoc(VERSION, { mode: 'helper', origin: SITE }), /<script/i, 'a helper with no nonce is no helper');
  const helped = docs.artifactFrameDoc(VERSION, { mode: 'helper', origin: SITE, site: false, nonce: 'f00d' });
  assert.ok(helped.includes(`content="${policy.cspFor('helper', { nonce: 'f00d' })}"`));
  assert.equal((helped.match(/<script\b/g) || []).length, 1);
  assert.match(helped, /<script nonce="f00d">\(function\(F\)\{[\s\S]*\}\)\(1\);<\/script>/);
  assert.doesNotMatch(helped, /onload=|onclick=|javascript:|function openMenu/, 'nothing of the page\'s own');
  assert.match(docs.frameNonce(), /^[0-9a-f]{32}$/);
  assert.notEqual(docs.frameNonce(), docs.frameNonce(), 'new for every frame');
});

test('the helper: pins, the frame\'s own picture, its size and its links, believed only from the frame\'s parent', () => {
  const doc = docs.artifactFrameDoc('<p>Hi</p>', { mode: 'run', origin: SITE });
  assert.match(doc, /e\.source!==parent/, 'only the parent is believed');
  assert.match(doc, /__artifact:'pin',x:/, 'a click in comment mode is answered with its point');
  assert.match(doc, /setAttribute\('data-artifact-pins',''\)/, 'the pins are drawn on the page');
  // #6261: a frame draws its own picture when the shell asks.
  assert.match(doc, /k==='picture'/);
  assert.match(doc, /typeof d\.lib!=='string'/, 'the library text comes in the request');
  assert.match(doc, /s\.textContent=d\.lib/, 'the vendored library arrives as an inline script');
  assert.match(doc, /exclude:\['\[data-artifact-pins\]'\]/, 'the pins layer is left out of the page\'s own picture');
  assert.match(doc, /say\(\{__artifact:'picture',id:id,blob:blob,error:error\}\)/);
  assert.match(doc, /parent\.postMessage\(m,'\*'\)/, 'the frame\'s origin is opaque, so the reply is not origin-scoped');
  // Its size, with the boxes of its links, once asked.
  assert.match(doc, /k==='measure'/);
  assert.match(doc, /__artifact:'size',height:/);
  assert.equal(docs.ARTIFACT_FRAME_ATTR, 'data-artifact-frame');
  assert.equal(docs.ARTIFACT_PICTURED_ATTR, 'data-artifact-pictured');
  // Nothing in the helper, or in the frame, is a design's.
  assert.doesNotMatch(code('frontend/src/features/artifact/frame-doc.ts'), /__design|data-design/);
  assert.equal(fs.existsSync(path.join(ROOT, 'frontend/src/features/design/frame.ts')), false, 'the design pane\'s own frame is gone');
});

test('the viewer rule: a page runs for its author; anyone else gets the static version unless they choose', () => {
  assert.equal(frameModeFor({ mode: 'run', viewer: 'author' }), 'run');
  assert.equal(frameModeFor({ mode: 'run', viewer: 'other' }), 'static');
  assert.equal(frameModeFor({ mode: 'run' }), 'static', 'a caller that does not say who is looking gets the safe side');
  assert.equal(frameModeFor({ mode: 'run', viewer: 'other', chose: true }), 'run', 'their own choice');
  assert.equal(frameModeFor({ mode: 'static', viewer: 'author', chose: true }), 'static', 'a static page never runs');
  // The helper mode runs nothing of the page's, for anyone: Homeroom's helper alone.
  for (const viewer of ['author', 'other']) assert.equal(frameModeFor({ mode: 'helper', viewer }), 'helper', viewer);

  const author = frameOf(renderToHtml(createElement(ArtifactFrame, { mode: 'run', viewer: 'author', html: VERSION, title: 'Version 2', origin: SITE })));
  assert.equal(author.attr('sandbox'), 'allow-scripts');
  assert.equal(author.attr('data-artifact-frame'), 'run');
  assert.match(author.attr('srcDoc'), /function openMenu/);

  const other = renderToHtml(createElement(ArtifactFrame, { mode: 'run', html: VERSION, title: 'Version 2', origin: SITE, author: 'ada' }));
  const shown = frameOf(other);
  assert.equal(shown.attr('sandbox'), '', 'scripts off');
  assert.equal(shown.attr('data-artifact-frame'), 'static');
  assert.doesNotMatch(shown.attr('srcDoc'), /<script|onclick=|onload=|javascript:/i, 'and nothing of the page\'s own left to run');
  assert.match(shown.attr('srcDoc'), /<button id="more" class="row">More<\/button>/, 'the same page, still');
  assert.match(other, /^<div data-artifact-viewer="static"/);
  assert.match(other, new RegExp(`<button type="button" class="[^"]*" data-artifact-run="">${message('core:artifact.viewer.run')}</button>`));
  assert.ok(other.includes(message('core:artifact.viewer.staticNote')));
  assert.equal(message('core:artifact.viewer.run'), 'Run it');
  assert.equal(message('core:artifact.viewer.runningNoteBy', { author: 'ada' }),
    'ada made this page in a chat with Homeroom bot. It is not part of Homeroom. Never type a password into it.');
  // A running page somebody else chose is drawn in a plain box: its note and
  // the frame, with none of the shell's classes on or in it.
  const src = code('frontend/src/features/artifact/frame.tsx');
  const running = src.slice(src.indexOf('data-artifact-viewer="running"'));
  assert.doesNotMatch(running, /className=/, 'no chrome of Homeroom\'s around a running page');

  // No caller can hand a prebuilt document, or a served one, to a running frame.
  for (const props of [{ doc: '<p>x</p><script>go()</script>' }, { src: '/api/x' }]) {
    const made = frameOf(renderToHtml(createElement(ArtifactFrame, { mode: 'run', viewer: 'author', title: 'x', ...props })));
    assert.equal(made.attr('sandbox'), '', JSON.stringify(props));
    assert.equal(made.attr('data-artifact-frame'), 'static');
  }
  // And every sandbox the component can write comes from the one policy.
  assert.doesNotMatch(src, /allow-scripts|allow-same-origin|allow-forms|allow-popups/);
});

test('artifacts have no status words of their own: the frame\'s only words are the viewer rule\'s', () => {
  const catalog = JSON.parse(read('frontend/locales/en/core.json'));
  const keys = Object.keys(catalog).filter((key) => key.startsWith('artifact.'));
  assert.deepEqual(keys.sort(), ['artifact.viewer.run', 'artifact.viewer.runningNote', 'artifact.viewer.runningNoteBy', 'artifact.viewer.staticNote']);
  for (const key of keys) assert.doesNotMatch(catalog[key].text, /—|\b(draft|published|ready|pending|live|archived)\b/i, key);
});

// ── The surfaces ─────────────────────────────────────────────────────────

test('the design pane, the version card and the comparison draw a version in the one frame, running for its author', () => {
  for (const [file, extra] of [
    ['frontend/src/features/messages/design-pane.tsx', /\bpictured\b/],
    ['frontend/src/features/messages/design-card.tsx', /\binert\b/],
    ['frontend/src/features/messages/bot-cards/compare.tsx', /\binert\b/],
  ]) {
    const src = code(file);
    assert.doesNotMatch(src, /<iframe|sandbox=|srcDoc=|designFrameDoc|DESIGN_SANDBOX/, `${file} draws no frame of its own`);
    const used = /<ArtifactFrame\b[\s\S]*?\/>/.exec(src);
    assert.ok(used, `${file} draws the one frame`);
    assert.match(used[0], /mode="run"/);
    assert.match(used[0], /viewer="author"/, 'a design is read only from its author\'s own thread');
    assert.match(used[0], extra);
  }
  // The frame as the card draws it: a picture of the version, not something to use.
  const card = frameOf(renderToHtml(createElement(ArtifactFrame, {
    mode: 'run', viewer: 'author', html: VERSION, sheets: [], pictured: true, inert: true, title: 'Version 2 of the design', origin: SITE,
    style: { width: 390, height: 844, transform: 'scale(0.4615)', transformOrigin: '0 0', border: 0, background: '#fff' },
  })));
  assert.equal(card.attr('sandbox'), 'allow-scripts');
  assert.equal(card.attr('tabindex'), '-1');
  assert.equal(card.attr('aria-hidden'), 'true');
  assert.match(card.attr('style'), /pointer-events:none$/);
  assert.equal(card.attr('data-artifact-pictured'), '', 'a comment\'s picture asks it to draw itself');
  assert.equal(card.attr('referrerPolicy'), 'no-referrer');
});

test('a plan\'s screens are drawn in the one frame, static, wherever a plan is shown', () => {
  for (const file of ['frontend/src/features/messages/bot-track.tsx', 'frontend/src/features/messages/plan-crops.tsx']) {
    const src = code(file);
    assert.doesNotMatch(src, /<iframe|sandbox=/, `${file} draws no frame of its own`);
    assert.match(src, /<ArtifactFrame\s+mode="static"\s+inert\s+title=\{label\}\s+doc=\{side === 'before' \? screen\.before : screen\.after\}/);
  }
  // The viewer a plan's page draws builds its markup as a string: the same frame, as markup.
  const tag = docs.staticFrameHtml({ doc: '<!doctype html><html data-side="after"><body><main>Plant list</main></body></html>', title: 'After (planned): a More menu', lazy: true });
  assert.match(tag, /^<iframe sandbox="" referrerpolicy="no-referrer" tabindex="-1" aria-hidden="true" title="After \(planned\): a More menu" data-srcdoc="/);
  assert.match(docs.staticFrameHtml({ doc: '<p>x</p>', title: 'x' }), / srcdoc="&lt;p&gt;x&lt;\/p&gt;"><\/iframe>$/);
  // A plan's screen as a React surface draws it.
  const side = frameOf(renderToHtml(createElement(ArtifactFrame, {
    mode: 'static', inert: true, title: 'After', doc: '<!doctype html><html data-side="after"><body><main>Plant list</main></body></html>',
  })));
  assert.equal(side.attr('sandbox'), '');
  assert.equal(side.attr('data-artifact-frame'), 'static');
  assert.match(side.attr('srcDoc'), /<main>Plant list<\/main>/);
});

test('a laid-out answer is drawn in the one frame, in the helper mode, with no origin', () => {
  const src = code('frontend/src/features/messages/bot-html.tsx');
  assert.match(src, /<ArtifactFrame\s+frameRef=\{frame\}\s+mode="helper"\s+html=\{doc\}\s+site=\{false\}/);
  const reply = loadTsx('frontend/src/features/messages/bot-html.tsx');
  const look = { vars: Object.fromEntries(reply.REPLY_TOKENS.map(([name, , fallback]) => [name, fallback])), dark: false, font: 'system-ui, sans-serif', size: '17px' };
  // A stored reply's fragment, cleaned (a page with DOMPurify does that), then framed.
  const page = reply.replyFrameDoc('<h3>Two ways</h3><ol><li>Keep it</li><li>Group it</li></ol><p><a href="https://example.com/rooms" target="_blank" rel="noopener noreferrer">Rooms</a></p>', look);
  const frame = frameOf(renderToHtml(createElement(ArtifactFrame, { mode: 'helper', html: page, site: false, nonce: 'abc123', title: 'Homeroom bot\'s answer, laid out', origin: SITE })));
  assert.equal(frame.attr('sandbox'), policy.sandboxFor('helper'), 'scripts on for Homeroom\'s helper alone');
  assert.equal(frame.attr('data-artifact-frame'), 'helper', 'its own mode, never called static');
  const doc = frame.attr('srcDoc');
  assert.ok(doc.includes(`content="${policy.cspFor('helper', { nonce: 'abc123' })}"`));
  // Made here, new for the frame, when the caller gives none.
  const own = frameOf(renderToHtml(createElement(ArtifactFrame, { mode: 'helper', html: page, site: false, title: 'x', origin: SITE })));
  assert.match(own.attr('srcDoc'), /script-src 'nonce-[0-9a-f]{32}'/);
  // A static frame stays static: sandbox "", no script at all.
  const plain = frameOf(renderToHtml(createElement(ArtifactFrame, { mode: 'static', html: page, site: false, nonce: 'abc123', title: 'x', origin: SITE })));
  assert.equal(plain.attr('sandbox'), '');
  assert.doesNotMatch(plain.attr('srcDoc'), /<script/);
  assert.doesNotMatch(doc.replace(/<script nonce="abc123">[\s\S]*?<\/script>/, ''), /<script|https:\/\/homeroom\.test/, 'no other script, and no origin named');
  assert.match(doc, /<div class="reply" dir="auto"><h3>Two ways<\/h3>/);
  // What the helper says is read defensively, and a press is looked up in it.
  const hits = reply.replyHits([{ x: 10, y: 20, w: 80, h: 18, href: 'https://example.com/rooms' }, { x: 0, y: 60, w: 300, h: 20, href: null }, { x: 'a' }, null, { x: 1, y: 1, w: 0, h: 5 }]);
  assert.deepEqual(hits, [{ x: 10, y: 20, w: 80, h: 18, href: 'https://example.com/rooms' }, { x: 0, y: 60, w: 300, h: 20, href: null }]);
  assert.equal(reply.hitAt(hits, 50, 30).href, 'https://example.com/rooms');
  assert.equal(reply.hitAt(hits, 50, 70).href, null, 'a summary');
  assert.equal(reply.hitAt(hits, 200, 30), null, 'anywhere else is the row\'s');
  assert.equal(reply.replyHits('nope').length, 0);
});

test('a first look\'s drawn screen is drawn in the one frame, static, from its route', () => {
  const { DrawnLook } = loadTsx('frontend/src/features/first-session/drawn-look.tsx');
  const frame = frameOf(renderToHtml(createElement(DrawnLook, { src: '/api/apps/club-votes/first-version/first-look/drawn?v=3', label: 'The first look at Club Votes', width: 50 })));
  assert.equal(frame.attr('sandbox'), '');
  assert.equal(frame.attr('data-artifact-frame'), 'static');
  assert.equal(frame.attr('src'), '/api/apps/club-votes/first-version/first-look/drawn?v=3');
  assert.equal(frame.attr('srcDoc'), null);
  assert.equal(frame.attr('loading'), 'lazy');
  // Its route answers under the same policy, as a header.
  assert.equal(require('../src/services/first-version-screens').DRAWN_CSP, policy.cspFor('static', { header: true }));
});

// 20 Nov 2026: the last two surfaces onto the one frame.

test('a comparison the bot laid out is drawn under its reply, static: nothing in it runs', () => {
  const { ThreadComparison } = loadTsx('frontend/src/features/messages/bot-cards/thread-comparison.tsx');
  const page = '<html><head><style>.row{padding:8px}</style></head><body onload="go()"><h3>Before and after</h3>'
    + '<p onclick="go()">Today</p><a href="javascript:go()">Open</a><script>function go(){fetch("https://evil.test")}<\/script></body></html>';
  const html = renderToHtml(createElement(ThreadComparison, { comparison: { title: 'Before and after', html: page } }));
  const frame = frameOf(html);
  assert.equal(frame.attr('sandbox'), '', 'scripts off: the same for everyone who reads the thread');
  assert.equal(frame.attr('data-artifact-frame'), 'static');
  const doc = frame.attr('srcDoc');
  assert.ok(doc.includes(`content="${policy.cspFor('static')}"`), 'its policy is the one file\'s, naming no origin');
  assert.doesNotMatch(doc, /<script|onload=|onclick=|javascript:|https:\/\/evil\.test/i, 'nothing of the comparison\'s own runs or loads');
  assert.match(doc, /<h3>Before and after<\/h3>/, 'the comparison itself is still drawn');
  // The card: its title over it, and the note under it.
  assert.match(html, /data-bot-comparison=""/);
  assert.match(html, /Before and after<\/span>/);
  assert.ok(html.includes(message('messages:botCards.comparison.note')));
  assert.equal(message('messages:botCards.comparison.note'), 'Laid out by Homeroom bot. Nothing in it runs.');
  assert.equal(message('messages:botCards.comparison.frameTitle', { title: 'Before and after' }), 'Comparison: Before and after');
  assert.match(html, /<iframe[^>]*class="block h-\[420px\] w-full[^"]*"/, 'a fixed box that scrolls inside');
});

test('an opened email is measured by the frame\'s helper, with no same-origin and no script of the email\'s', () => {
  const { EmailViewerPanel } = loadTsx('frontend/src/features/messages/bot-cards/gallery.tsx');
  const body = {
    kind: 'email', side: 'after', subject: 'Your invite is waiting', preheader: '',
    html: '<html><head><style>p{color:#111}</style></head><body><p>Hello</p><script>steal()</script></body></html>', text: 'Hello',
  };
  const html = renderToHtml(createElement(EmailViewerPanel, { body, caption: 'An email', onClose() {} }));
  const frame = frameOf(html);
  assert.equal(frame.attr('sandbox'), policy.sandboxFor('helper'));
  assert.equal(frame.attr('sandbox'), 'allow-scripts', 'Homeroom\'s helper alone may run');
  assert.equal(frame.attr('data-artifact-frame'), 'helper');
  const doc = frame.attr('srcDoc');
  assert.match(doc, /script-src 'nonce-[0-9a-f]{32}'/, 'one script, by a nonce made new for this frame');
  assert.equal((doc.match(/<script\b/g) || []).length, 1, 'the helper, and nothing of the email\'s');
  assert.doesNotMatch(doc, /steal\(\)|<script>steal/, 'the email\'s own script is gone');
  assert.match(doc, /<p>Hello<\/p>/, 'the email itself is still drawn');
  assert.doesNotMatch(html, /allow-same-origin/, 'no frame here is same-origin with Homeroom');
  assert.match(html, /role="dialog"/);
  assert.match(html, /data-bot-email-size="phone"/, 'the Phone / Desktop switch is kept');
  assert.match(html, /data-bot-email-size="desktop"/);
});
