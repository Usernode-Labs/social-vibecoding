'use strict';

// The C comment (#4289 follow-up): a pin where the pointer is, a box beside
// it, and Enter posts a request with a screenshot that shows the pin.
// frontend/src/features/comment-pin/; the key itself is
// tests/suggest-shortcut.test.js.
//
// What is pinned, and each is a way it can be quietly wrong:
//
//   1. THE LAYOUT. The box on screen and the bubble drawn into the picture
//      sit beside the pin by one rule, inside the viewport, and the words
//      wrap the same way at any length.
//   2. POSTING. The same two requests the dialog makes; a refusal with a
//      reason stays in the box; offline, a network failure or a server error
//      hands the comment to the dialog, words, picture and destination.
//   3. THE APP'S PICTURE. The bridge draws the app only for the platform's
//      own origin (platform.json, https only), answers that origin alone,
//      draws what is on screen at its scroll position, and puts the app's
//      own `window.snapdom` back.
//   4. THE SEAMS. The dialog takes a handed-over comment; the drawing
//      library is the pinned, recorded copy, byte for byte.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const picture = loadTsx('frontend/src/features/comment-pin/picture.ts');
const post = loadTsx('frontend/src/features/comment-pin/post.ts');
const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const SNAPSHOT = BRIDGE.split('/* __USERNODE_SNAPSHOT_BEGIN__ */')[1].split('/* __USERNODE_SNAPSHOT_END__ */')[0];

// ── 1. The layout ─────────────────────────────────────────────────────

test('the box sits right of the pin and below it, flipping at the edges and staying inside', () => {
  const vp = { width: 1000, height: 700 };
  const size = { width: 300, height: 160 };
  assert.deepEqual(picture.placeBeside({ x: 100, y: 100 }, size, vp), { x: 114, y: 114 });
  assert.deepEqual(picture.placeBeside({ x: 900, y: 100 }, size, vp), { x: 586, y: 114 }, 'flips left at the right edge');
  assert.deepEqual(picture.placeBeside({ x: 100, y: 650 }, size, vp), { x: 114, y: 476 }, 'flips up at the bottom');
  const tiny = picture.placeBeside({ x: 150, y: 80 }, size, { width: 320, height: 200 });
  assert.ok(tiny.x >= 8 && tiny.x + 300 <= 312 && tiny.y >= 8 && tiny.y + 160 <= 192, 'clamped when neither side fits');
});

test('the words wrap to the bubble, keep their line breaks, and end in an ellipsis past six lines', () => {
  const measure = (s) => s.length * 10; // ten pixels a character
  assert.deepEqual(picture.wrapLines('one two three four', 100, measure), ['one two', 'three four']);
  assert.deepEqual(picture.wrapLines('one two three four', 90, measure), ['one two', 'three', 'four']);
  assert.deepEqual(picture.wrapLines('first\nsecond', 200, measure), ['first', 'second']);
  assert.deepEqual(picture.wrapLines('abcdefghijklmnop', 50, measure), ['abcde', 'fghij', 'klmno', 'p'], 'a long word breaks');
  const long = picture.wrapLines(Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '), 60, measure, 3);
  assert.equal(long.length, 3);
  assert.match(long[2], /…$/);
  assert.ok(long.every((l) => measure(l) <= 60), 'no line is wider than the bubble');
  assert.deepEqual(picture.wrapLines('', 100, measure), ['']);
});

test('the picture is the screen\'s own pixels, up to 2x, and never past 3000 on its long side', () => {
  assert.equal(picture.pictureScale(1, { width: 1280, height: 800 }), 1);
  assert.equal(picture.pictureScale(2, { width: 1280, height: 800 }), 2);
  assert.equal(picture.pictureScale(3, { width: 1280, height: 800 }), 2);
  assert.equal(picture.pictureScale(2, { width: 2560, height: 1440 }), 3000 / 2560);
  assert.equal(picture.pictureScale(undefined, { width: 800, height: 600 }), 1);
  assert.equal(picture.inRect({ x: 10, y: 10 }, { x: 0, y: 0, width: 20, height: 20 }), true);
  assert.equal(picture.inRect({ x: 20, y: 10 }, { x: 0, y: 0, width: 20, height: 20 }), false, 'the far edge is outside');
  assert.equal(picture.inRect({ x: 1, y: 1 }, null), false);
});

// ── 2. Posting ────────────────────────────────────────────────────────

test('the request says where the comment was pinned, in words', () => {
  assert.equal(post.whereLine({ inApp: false, screen: '#settings/experimental', at: { tag: 'button', id: 'settings-save', text: 'Save' } }),
    'Pinned with C on Homeroom at #settings/experimental, on button "Save" (#settings-save).');
  assert.equal(post.whereLine({ inApp: true, screen: '/lists/42', at: { tag: 'div', id: '', text: 'Buy milk' } }),
    'Pinned with C in the app at /lists/42, on div "Buy milk".');
  assert.equal(post.whereLine({ inApp: true, screen: '', at: null }), 'Pinned with C in the app at /.');
  assert.equal(post.descriptionFor('  Make it bigger  ', 'Pinned.'), 'Make it bigger\n\nPinned.');
});

function withFetch(responses, fn) {
  const calls = [];
  const prev = globalThis.window;
  globalThis.window = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return { ok: r.status < 400, status: r.status, json: async () => r.body || {} };
    },
  };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.window = prev; });
}

const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
const base = { text: 'Make it bigger', target: 'app', appSlug: 'demo', picture: blob, where: 'Pinned with C in the app at /.' };

test('a comment is the dialog\'s two requests: the picture, then the request naming it', () => withFetch([
  { status: 200, body: { id: 'a'.repeat(32) } },
  { status: 200, body: { url: 'u', homeroomBot: { botWillBuild: true } } },
], async (calls) => {
  const out = await post.postComment(base);
  assert.deepEqual(out, { ok: true, botWillBuild: true });
  assert.equal(calls[0].url, '/api/feedback/screenshot');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[0].init.body, blob);
  assert.equal(calls[1].url, '/api/feedback');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    description: 'Make it bigger\n\nPinned with C in the app at /.',
    target: 'app', appSlug: 'demo', screenshotIds: ['a'.repeat(32)],
  });
}));

test('Homeroom gets no app slug, and a comment without a picture makes one request', () => withFetch([
  { status: 200, body: {} },
], async (calls) => {
  await post.postComment({ ...base, target: 'platform', picture: null });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { description: 'Make it bigger\n\nPinned with C in the app at /.', target: 'platform' });
}));

test('a picture the server will not take does not cost the words', () => withFetch([
  { status: 400, body: { error: 'Not a PNG or JPEG' } },
  { status: 200, body: {} },
], async (calls) => {
  assert.deepEqual(await post.postComment(base), { ok: true, botWillBuild: false });
  assert.equal(JSON.parse(calls[1].init.body).screenshotIds, undefined);
}));

test('a refusal with a reason stays in the box; failures hand the comment to the dialog', async () => {
  await withFetch([{ status: 200, body: { id: 'x' } }, { status: 400, body: { error: 'Too long.' } }], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: false, error: 'Too long.' });
  });
  await withFetch([{ status: 200, body: { id: 'x' } }, { status: 503 }], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: true });
  });
  await withFetch([new TypeError('Failed to fetch')], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: true });
  });
  await withFetch([{ status: 502 }], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: true }, 'the picture upload failing too');
  });
});

test('handing over opens the dialog with the words, the picture and the chosen destination', () => {
  const prev = globalThis.window;
  let got = null;
  globalThis.window = { App: { openFeedbackModal: (opts) => { got = opts; } } };
  try {
    post.handOver({ ...base, target: 'platform' });
  } finally {
    globalThis.window = prev;
  }
  assert.deepEqual(got, { target: 'platform', description: 'Make it bigger\n\nPinned with C in the app at /.', screenshotBlob: blob });

  const fc = read('frontend/src/features/dialogs/feedback-controller.js');
  assert.match(fc, /if \(opts\.target === 'platform'\) setFeedbackTarget\('platform'\);/);
  assert.match(fc, /feedbackText\.value = typed \? `\$\{typed\}\\n\\n\$\{opts\.description\}` : opts\.description;/,
    'added after anything already typed, never over it');
  assert.match(fc, /opts\.screenshotBlob instanceof Blob\s*\n\s*&& screenshots\.length < MAX_SCREENSHOTS\) \{\s*void attachScreenshotBlob\(opts\.screenshotBlob\);/);
});

// ── 3. The app's picture ──────────────────────────────────────────────

const PLATFORM = 'https://app.onhomeroom.com';

function snapshotHarness({ config = { platform_origin: PLATFORM }, top = false, appSnapdom } = {}) {
  const posted = [];
  const injected = [];
  const captures = [];
  let onMessage = null;
  const canvas = { toBlob(cb, type) { cb({ fake: 'blob', type }); } };
  const window = {
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 700,
    addEventListener(type, fn) { if (type === 'message') onMessage = fn; },
    fetch: async (url) => ({ ok: !!config, json: async () => config, url }),
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 251, 230)' }),
  };
  if (appSnapdom !== undefined) window.snapdom = appSnapdom;
  const parent = { postMessage(message, origin) { posted.push({ message, origin }); } };
  window.parent = top ? window : parent;
  const document = {
    head: { appendChild(s) { injected.push(s); s.parentNode = this; } },
    documentElement: {},
    body: { tag: 'body' },
    createElement: () => ({ remove() {} }),
    elementFromPoint: (x, y) => ({ tagName: 'DIV', id: 'row-19', textContent: `Row at ${x},${y}`, getAttribute: () => null }),
  };
  document.head.removeChild = () => {};
  const location = { pathname: '/lists/7', search: '?token=secret' };
  vm.runInNewContext(SNAPSHOT, { window, document, location, Promise, URL, String, Math, Number, Object, isFinite });
  const fakeLib = async (el, opts) => {
    captures.push({ el, opts });
    return { toCanvas: async () => canvas };
  };
  return {
    installed: () => !!onMessage,
    ask(data, origin = PLATFORM, source = parent) { onMessage({ source, origin, data }); },
    loadLibrary() {
      const s = injected.at(-1);
      window.snapdom = fakeLib;
      s.onload();
    },
    flush: () => new Promise((r) => setTimeout(r, 0)),
    posted, injected, captures, window,
  };
}

test('only the platform\'s own origin gets the app\'s picture, and the reply goes to it alone', async () => {
  const h = snapshotHarness();
  h.ask({ __usernode_snapshot: 'render', id: 'p1', scale: 2, x: 40, y: 30 });
  await h.flush(); await h.flush();
  assert.equal(h.injected.length, 1);
  assert.equal(h.injected[0].src, '/usernode-bridge/v1/snapdom.js', 'the hosted copy, from this origin');
  h.loadLibrary();
  for (let i = 0; i < 5; i++) await h.flush();
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].el.tag, 'body');
  assert.deepEqual({ ...h.captures[0].opts.clip }, { x: 0, y: 700, width: 800, height: 600 }, 'what is on screen, at its scroll');
  assert.equal(h.captures[0].opts.scale, 2);
  assert.equal(h.captures[0].opts.dpr, 1, 'the scale is not multiplied by the pixel ratio twice');
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].origin, PLATFORM, 'posted to the platform, never "*"');
  const m = h.posted[0].message;
  assert.equal(m.__usernode_snapshot, 'picture');
  assert.equal(m.id, 'p1');
  assert.equal(m.blob.type, 'image/png');
  assert.equal(m.path, '/lists/7', 'the path, never the query that carries the token');
  assert.equal(m.at.id, 'row-19');
  assert.equal(m.at.text, 'Row at 40,30');
  assert.equal(h.window.snapdom, undefined, 'the library\'s global is gone again');
});

test('anyone else framing the app gets nothing back, not even a refusal', async () => {
  const other = snapshotHarness();
  other.ask({ __usernode_snapshot: 'render', id: 'e1' }, 'https://evil.example');
  for (let i = 0; i < 5; i++) await other.flush();
  assert.equal(other.injected.length, 0, 'nothing is even loaded');
  assert.equal(other.posted.length, 0);

  const notParent = snapshotHarness();
  notParent.ask({ __usernode_snapshot: 'render', id: 'e2' }, PLATFORM, { some: 'other window' });
  for (let i = 0; i < 5; i++) await notParent.flush();
  assert.equal(notParent.posted.length + notParent.injected.length, 0);

  for (const config of [{ platform_origin: 'http://app.onhomeroom.com' }, { platform_origin: 'https://u:p@app.onhomeroom.com' }, null, {}]) {
    const h = snapshotHarness({ config });
    h.ask({ __usernode_snapshot: 'render', id: 'c1' }, config && config.platform_origin ? new URL(config.platform_origin).origin : PLATFORM);
    for (let i = 0; i < 5; i++) await h.flush();
    assert.equal(h.posted.length + h.injected.length, 0, `refused: ${JSON.stringify(config)}`);
  }

  assert.equal(snapshotHarness({ top: true }).installed(), false, 'a top-level page installs nothing');
});

test('an app\'s own window.snapdom is put back as it was', async () => {
  const mine = function appOwn() {};
  const h = snapshotHarness({ appSnapdom: mine });
  h.ask({ __usernode_snapshot: 'render', id: 'k1', scale: 1 });
  for (let i = 0; i < 3; i++) await h.flush();
  h.loadLibrary();
  for (let i = 0; i < 5; i++) await h.flush();
  assert.equal(h.captures.length, 1, 'the bridge drew with the library it loaded');
  assert.equal(h.window.snapdom, mine);
});

test('a library that will not load is answered with an error, to the platform', async () => {
  const h = snapshotHarness();
  h.ask({ __usernode_snapshot: 'render', id: 'f1' });
  for (let i = 0; i < 3; i++) await h.flush();
  h.injected[0].onerror();
  for (let i = 0; i < 5; i++) await h.flush();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].origin, PLATFORM);
  assert.match(h.posted[0].message.error, /did not load/);
});

// ── 4. The seams ──────────────────────────────────────────────────────

test('the drawing library is the pinned copy, recorded in the vendor README, served to apps', () => {
  const bytes = fs.readFileSync(path.join(ROOT, 'public/usernode-bridge/v1/snapdom.js'));
  const digest = crypto.createHash('sha384').update(bytes).digest('base64');
  assert.equal(digest, 'X1VJfUghgBqHQ1Y6iba5l0ab1AuLfNDhnTt/tiVjeokfy/D/UGmvEiAOQ6fcj1AS');
  assert.ok(read('scripts/vendor-assets.js').includes(digest), 'pinned in the vendoring script');
  assert.ok(read('public/vendor/README.md').includes(digest), 'recorded in the README');
  assert.match(bytes.toString('utf8', 0, 80), /SnapDOM\s*\n\* v3\.1\.1/);
  assert.equal(read('frontend/src/features/comment-pin/picture.ts').match(/LIB_SRC = '([^']+)'/)[1], '/usernode-bridge/v1/snapdom.js');
  assert.match(SNAPSHOT, /var LIB_SRC = "\/usernode-bridge\/v1\/snapdom\.js";/);
});

test('the comment opens on demand into a host of its own, and stands in the way of a second C', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /mountLegacyPortal\(host, createElement\(CommentPin,/);
  assert.match(src, /role="dialog"\s+aria-modal="true"/, 'the shortcut\'s "a dialog is up" rule keeps C from stacking a second one');
  assert.match(src, /if \(open \|\| typeof document === 'undefined'\) return;/);
  // The dialog's rule for when a request can go to the app, read the same way.
  assert.match(src, /!\/github\\\.com\\\/\[\^\/\]\+\\\/\[\^\/\]\+\/\.test\(data\.repo_url \|\| ''\) \|\| data\.self_hosted/);
  assert.match(read('frontend/src/features/dialogs/feedback-controller.js'), /const hasRepo = \/github\\\.com\\\/\[\^\/\]\+\\\/\[\^\/\]\+\/\.test\(repoUrl\);/);
});
