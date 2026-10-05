// Regression coverage for screenshots in the GitHub half of an issue
// discussion. GitHub writes resized uploads as raw <img ...> HTML. The shared
// Markdown renderer escapes arbitrary HTML, so the image-enabled path must
// recognize that one shape and rebuild controlled image markup.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { marked } = require('marked');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/dev-chat/dev-chat.js'), 'utf8'
);

function loadRenderer() {
  let sanitizeOptions = null;
  const sandbox = {
    marked,
    DOMPurify: {
      addHook() {},
      sanitize(html, options) {
        sanitizeOptions = options;
        return html;
      },
    },
    localStorage: { getItem: () => null },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    URL,
    URLSearchParams,
    AbortController,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;globalThis.__DevChat = DevChat;`, sandbox);
  return {
    render: (text, options) => sandbox.__DevChat.renderMarkdown(text, options),
    sanitizeOptions: () => sanitizeOptions,
  };
}

test('image-enabled issue Markdown safely links a raw GitHub screenshot to its full-size asset', () => {
  const renderer = loadRenderer();
  const body = 'See below.\n\n'
    + '<img width="367" height="212" alt="Image" '
    + 'src="https://github.com/user-attachments/assets/example" onerror="alert(1)" />';

  const html = renderer.render(body, { images: true });
  assert.match(html, /<a class="dc-inline-img-link" href="https:\/\/github\.com\/user-attachments\/assets\/example" target="_blank" rel="noopener noreferrer" aria-label="View image full size"><img class="dc-inline-img" src="https:\/\/github\.com\/user-attachments\/assets\/example" alt="Image" loading="lazy"><\/a>/);
  assert.doesNotMatch(html, /onerror|width=|height=/, 'untrusted raw attributes are discarded');
  assert.ok(renderer.sanitizeOptions().ALLOWED_TAGS.includes('img'));
  assert.ok(renderer.sanitizeOptions().ALLOWED_ATTR.includes('src'));
  assert.ok(renderer.sanitizeOptions().ALLOWED_ATTR.includes('aria-label'));
});

test('Markdown screenshots use the same full-size link, including same-origin assets', () => {
  const renderer = loadRenderer();
  const html = renderer.render('![Screenshot](/icons/icon-192.png)', { images: true });
  assert.match(html, /<a class="dc-inline-img-link" href="\/icons\/icon-192\.png"[^>]*aria-label="View image full size"><img class="dc-inline-img" src="\/icons\/icon-192\.png" alt="Screenshot" loading="lazy"><\/a>/);
});

test('an explicitly linked image keeps its authored destination without nested links', () => {
  const renderer = loadRenderer();
  const html = renderer.render(
    '[![Architecture](https://example.com/architecture.png)](https://example.com/design-notes)',
    { images: true }
  );
  assert.equal((html.match(/<a\b/g) || []).length, 1);
  assert.match(html, /<a href="https:\/\/example\.com\/design-notes"[^>]*><img class="dc-inline-img" src="https:\/\/example\.com\/architecture\.png"/);
  assert.doesNotMatch(html, /dc-inline-img-link/);
});

test('raw image HTML stays escaped without opt-in and unsafe sources never render', () => {
  const renderer = loadRenderer();
  const safeTag = '<img alt="Image" src="https://github.com/user-attachments/assets/example">';
  const unsafeTag = '<img alt="Image" src="javascript:alert(1)">';

  assert.match(renderer.render(safeTag), /&lt;img/);
  assert.doesNotMatch(renderer.render(safeTag), /<img class="dc-inline-img"/);
  assert.match(renderer.render(unsafeTag, { images: true }), /&lt;img/);
  assert.doesNotMatch(renderer.render(unsafeTag, { images: true }), /<img class="dc-inline-img"/);
});

// ── The click seam (#3908) ─────────────────────────────────────────────
//
// The rendered anchors carry target="_blank", so before this change a plain
// click left the app for a bare image tab. The delegated listener lives in
// public/js/app-view.js (a classic script), so it is driven in its own vm —
// the same harness as attr-vote-toggle.test.js. The controller it calls is
// the one viewer-host.tsx publishes; the stub here stands in for it and
// records what it is handed.

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function loadAppView() {
  const listeners = { click: [] };
  const doc = {
    addEventListener(type, fn) { if (listeners[type]) listeners[type].push(fn); },
    removeEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    createElement: () => ({
      style: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
    }),
    body: { appendChild() {} },
    activeElement: null,
  };
  const sandbox = {
    console,
    document: doc,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    relTime: () => 'just now',
    App: { user: { id: 1, username: 'viewer' }, currentApp: 'demo' },
    PlatformUI: { toast() {}, alert() {}, confirm() { return true; } },
    addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    innerWidth: 1000,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, sandbox, doc, listeners };
}

// The one controller the host publishes (viewer-host.tsx), stubbed to record.
function openCallsOf(sandbox) {
  const calls = [];
  sandbox.UsernodeReact = { imageViewer: { open: (url, text) => calls.push([url, text]) } };
  return calls;
}

// A minimal click event: the listener reads only button, the modifier keys,
// defaultPrevented and target.closest.
function clickEvent(target, extra) {
  const ev = {
    button: 0,
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    defaultPrevented: false,
    target,
    preventDefault() { ev.defaultPrevented = true; },
    stopPropagation() {},
  };
  return Object.assign(ev, extra || {});
}

// The anchor renderMarkdown emits, and a target inside it.
function screenshotTarget(href, alt) {
  const link = {
    getAttribute: (n) => (n === 'href' ? href : null),
    querySelector: (sel) => (sel === 'img.dc-inline-img'
      ? { getAttribute: (n) => (n === 'alt' ? alt : null) }
      : null),
  };
  return { closest: (sel) => (sel === '.dc-inline-img-link' ? link : null) };
}

test('a plain click on a rendered screenshot opens the viewer with its href and alt', () => {
  const { AppView, sandbox, listeners } = loadAppView();
  AppView._inlineImgInit();
  const opened = openCallsOf(sandbox);

  const ev = clickEvent(screenshotTarget('https://github.com/user-attachments/assets/example', 'Failed merge'));
  listeners.click.forEach((fn) => fn(ev));

  assert.deepEqual(opened, [['https://github.com/user-attachments/assets/example', 'Failed merge']]);
  assert.ok(ev.defaultPrevented, 'the plain click does not follow the target=_blank anchor');
});

test('a screenshot without alt still opens, with an empty label', () => {
  const { AppView, sandbox, listeners } = loadAppView();
  AppView._inlineImgInit();
  const opened = openCallsOf(sandbox);

  const ev = clickEvent(screenshotTarget('/media/shots/after.png', ''));
  listeners.click.forEach((fn) => fn(ev));

  assert.deepEqual(opened, [['/media/shots/after.png', '']]);
  assert.ok(ev.defaultPrevented);
});

test('a modified click keeps the link\'s own new-tab behaviour', () => {
  const modified = [
    { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true },
    { button: 1 },
  ];
  for (const extra of modified) {
    const { AppView, sandbox, listeners } = loadAppView();
    AppView._inlineImgInit();
    const opened = openCallsOf(sandbox);

    const ev = clickEvent(screenshotTarget('https://example.com/shot.png', 'Shot'), extra);
    listeners.click.forEach((fn) => fn(ev));

    assert.deepEqual(opened, [], `${JSON.stringify(extra)} must not open the viewer`);
    assert.ok(!ev.defaultPrevented, `${JSON.stringify(extra)} must not prevent the anchor`);
  }
});

test('a plain click on anything but a rendered screenshot calls nothing', () => {
  const { AppView, sandbox, listeners } = loadAppView();
  AppView._inlineImgInit();
  const opened = openCallsOf(sandbox);

  // A before/after comparison tile, and a plain paragraph — neither is a
  // dc-inline-img-link anchor, so neither may reach the viewer.
  const tile = { closest: () => null };
  const evTile = clickEvent(tile);
  const text = { closest: (sel) => (sel === '.dc-inline-img-link' ? null : null) };
  const evText = clickEvent(text);
  listeners.click.forEach((fn) => { fn(evTile); fn(evText); });

  assert.deepEqual(opened, []);
  assert.ok(!evTile.defaultPrevented && !evText.defaultPrevented);
});

test('the listener installs once, however many times the Dev view renders', () => {
  const { AppView, listeners } = loadAppView();
  AppView._inlineImgInit();
  AppView._inlineImgInit();
  AppView._inlineImgInit();
  assert.equal(listeners.click.length, 1);
});

test('a missing controller leaves the anchor untouched', () => {
  const { AppView, sandbox, listeners } = loadAppView();
  AppView._inlineImgInit();
  // No window.UsernodeReact.imageViewer published — the React bundle failed
  // to load. The click must do nothing the anchor did not already do.
  const ev = clickEvent(screenshotTarget('https://example.com/shot.png', 'Shot'));
  listeners.click.forEach((fn) => fn(ev));
  assert.ok(!ev.defaultPrevented);
});
