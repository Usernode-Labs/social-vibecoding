'use strict';

// #4055: a picture from a chat can be downloaded onto the device, whoever
// sent it: Download in the full-screen viewer, a finger held on the picture
// there, and "Download image" in a message's menu.
//
// features/image-viewer/save-image.ts picks the road: the app's own
// `saveImage` bridge method when the build advertises it, the phone's share
// sheet on a touch screen, a browser download otherwise. In the app with
// neither there is no road and nothing is offered.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SAVE = 'frontend/src/features/image-viewer/save-image.ts';
const VIEWER = 'frontend/src/features/image-viewer/image-viewer.tsx';

const ORIGIN = 'https://app.example';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// A browser, as far as save-image.ts looks at one. Restored after each test.
function stage({ native = false, capabilities = [], coarse = false, share = null, status = 200 } = {}) {
  const saved = { window: global.window, document: global.document, fetch: global.fetch };
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const urlCreate = URL.createObjectURL;
  const urlRevoke = URL.revokeObjectURL;
  const log = { toasts: [], fetched: [], bridge: [], shared: [], clicked: [], revoked: [] };
  global.window = {
    location: { href: `${ORIGIN}/#messages/910002`, origin: ORIGIN },
    matchMedia: (q) => ({ matches: coarse && q === '(pointer: coarse)' }),
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
    PlatformUI: { toast: (text) => log.toasts.push(text) },
    usernode: native ? {
      isNative: true,
      getBridgeInfo: async () => ({ capabilities }),
      saveImage: async (args) => { log.bridge.push(args); return true; },
    } : undefined,
  };
  global.document = {
    body: { appendChild() {} },
    createElement: () => {
      const link = { style: {}, click() { log.clicked.push({ href: link.href, download: link.download }); }, remove() {} };
      return link;
    },
  };
  global.fetch = async (url, opts) => {
    log.fetched.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'image/png' },
      blob: async () => new Blob([PNG], { type: 'image/png' }),
    };
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: share ? {
      canShare: ({ files }) => Array.isArray(files) && files.length > 0,
      share: async (data) => { log.shared.push(data); return share(data); },
    } : {},
  });
  URL.createObjectURL = () => 'blob:app.example/1';
  URL.revokeObjectURL = (url) => log.revoked.push(url);
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
    Object.defineProperty(globalThis, 'navigator', navDesc);
    URL.createObjectURL = urlCreate;
    URL.revokeObjectURL = urlRevoke;
  };
  return { log, restore };
}

const shot = { src: '/api/conversations/910002/attachments/abc', name: 'Screenshot 2026-08-13' };

test('the saved file keeps its name, without a path, and with an extension', () => {
  const { fileNameFor } = loadTsx(SAVE);
  assert.equal(fileNameFor('Screenshot 2026-08-13', 'image/png'), 'Screenshot 2026-08-13.png');
  assert.equal(fileNameFor('photo.jpeg', 'image/jpeg'), 'photo.jpeg', 'an extension it has is kept');
  assert.equal(fileNameFor('cat', 'image/jpeg; charset=binary'), 'cat.jpg');
  assert.equal(fileNameFor('', 'image/webp'), 'image.webp');
  assert.equal(fileNameFor('', ''), 'image.png');
  assert.equal(fileNameFor('../../etc/passwd', 'image/png'), 'etc passwd.png', 'nothing that reads as a path');
});

test('a computer downloads the fetched file under its name', async () => {
  const { saveImage, canSaveImage } = loadTsx(SAVE);
  const { log, restore } = stage();
  try {
    assert.equal(canSaveImage(shot.src), true);
    assert.equal(await saveImage(shot), 'downloaded');
    assert.deepEqual(log.fetched.map((f) => [f.url, f.opts.credentials]), [[shot.src, 'same-origin']],
      'fetched with the session: the system browser could not');
    assert.deepEqual(log.clicked, [{ href: 'blob:app.example/1', download: 'Screenshot 2026-08-13.png' }]);
    assert.deepEqual(log.revoked, ['blob:app.example/1']);
    assert.deepEqual(log.toasts, []);
  } finally { restore(); }
});

test('a phone hands the picture to its share sheet, and a dismissed sheet says nothing', async () => {
  const { saveImage } = loadTsx(SAVE);
  let { log, restore } = stage({ coarse: true, share: async () => {} });
  try {
    assert.equal(await saveImage(shot), 'shared');
    assert.equal(log.shared.length, 1);
    assert.equal(log.shared[0].files[0].name, 'Screenshot 2026-08-13.png');
    assert.equal(log.shared[0].files[0].type, 'image/png');
    assert.deepEqual(log.clicked, [], 'no download link as well');
  } finally { restore(); }

  ({ log, restore } = stage({ coarse: true, share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } }));
  try {
    assert.equal(await saveImage(shot), 'dismissed');
    assert.deepEqual(log.toasts, []);
  } finally { restore(); }
});

test('a share sheet refused for an expired tap opens on the next tap without fetching again', async () => {
  const { saveImage } = loadTsx(SAVE);
  let refuse = true;
  const { log, restore } = stage({
    coarse: true,
    share: async () => { if (refuse) throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); },
  });
  try {
    assert.equal(await saveImage(shot), 'tap-again');
    refuse = false;
    assert.equal(await saveImage(shot), 'shared');
    assert.equal(log.fetched.length, 1, 'the second tap shares straight away, inside its own gesture');
    assert.equal(log.shared.length, 2);
  } finally { restore(); }
});

test('the app saves the picture itself when its build can, and says so', async () => {
  const { saveImage, canSaveImage, nativeSaveSupported, resetSaveImageProbe } = loadTsx(SAVE);
  resetSaveImageProbe();
  const { log, restore } = stage({ native: true, capabilities: ['saveImage'], coarse: true, share: async () => {} });
  try {
    assert.equal(await nativeSaveSupported(), true);
    assert.equal(canSaveImage(shot.src), true);
    assert.equal(await saveImage(shot), 'saved');
    assert.deepEqual(log.bridge, [{ base64: PNG.toString('base64'), contentType: 'image/png', filename: 'Screenshot 2026-08-13.png' }]);
    assert.deepEqual(log.shared, [], 'the app\'s own save wins over the share sheet');
    assert.deepEqual(log.toasts, ['Image downloaded']);
  } finally { restore(); resetSaveImageProbe(); }
});

test('an app build with no save and no share sheet offers nothing, and never a dead link', async () => {
  const { saveImage, canSaveImage, resetSaveImageProbe } = loadTsx(SAVE);
  resetSaveImageProbe();
  const { log, restore } = stage({ native: true, capabilities: [] });
  try {
    assert.equal(canSaveImage(shot.src), false);
    assert.equal(await saveImage(shot), 'failed');
    assert.deepEqual(log.clicked, [], 'a download link goes nowhere in the webview');
    assert.deepEqual(log.toasts, ['Couldn’t download this image.']);
  } finally { restore(); resetSaveImageProbe(); }
});

test('a picture that will not load (a blocked sender: 404) says it could not be downloaded', async () => {
  const { saveImage } = loadTsx(SAVE);
  const { log, restore } = stage({ status: 404 });
  try {
    assert.equal(await saveImage(shot), 'failed');
    assert.deepEqual(log.clicked, []);
    assert.deepEqual(log.toasts, ['Couldn’t download this image.']);
  } finally { restore(); }
});

test('a picture on another site is not offered: the viewer keeps Open original', () => {
  const { canSaveImage, downloadableImages } = loadTsx(SAVE);
  const { restore } = stage();
  try {
    assert.equal(canSaveImage('https://github.com/user-attachments/assets/1'), false);
    assert.deepEqual(downloadableImages([shot, { src: 'https://github.com/user-attachments/assets/1', name: 'x' }]), [],
      'the menu line never covers only some of a message\'s pictures');
  } finally { restore(); }
});

test('the viewer\'s Download is a button that saves, held still on the picture saves too, and a swipe still closes', () => {
  const src = read(VIEWER);
  assert.match(src, /<button\n\s*type="button"\n\s*className=\{`\$\{pill\} disabled:opacity-70`\}\n\s*disabled=\{busy\}[\s\S]*?data-image-viewer-download=""\n\s*onClick=\{download\}/);
  assert.match(src, /\{busy \? t\('messages:imageViewer\.downloading'\) : tapAgain \? t\('messages:imageViewer\.tapToSave'\) : t\('messages:imageViewer\.download'\)\}/);
  assert.equal(message('messages:imageViewer.downloading'), 'Downloading…');
  assert.equal(message('messages:imageViewer.tapToSave'), 'Tap to save');
  assert.equal(message('messages:imageViewer.download'), 'Download');
  assert.match(src, /void saveImage\(\{ src, name: alt \}\)/);
  assert.match(src, /\) : canSave \? \(/, 'drawn only where there is a road');
  // The hold: still for HOLD_SAVE_MS, cancelled by movement, and the share
  // sheet waits for the finger to lift (the tap a browser requires).
  const { HOLD_SAVE_MS } = loadTsx(VIEWER);
  assert.equal(HOLD_SAVE_MS, 500);
  assert.match(src, /if \(nativeSaveKnown\(\)\) download\(\);\n\s*else held\.current = true;/);
  assert.match(src, /> 8 \|\| Math\.abs\(event\.clientY - start\.current\.y\) > 8\) \{\n\s*stopHold\(\);\n\s*held\.current = false;/);
  assert.match(src, /if \(held\.current\) \{\n\s*held\.current = false;\n\s*setDrag\(0\);\n\s*download\(\);\n\s*\} else if \(travelled >= SWIPE_CLOSE_PX\) onCloseRef\.current\(\);/);
  assert.match(src, /\[-webkit-touch-callout:none\]/, 'the phone\'s own picture menu stays off');
  assert.match(src, /onContextMenu=\{\(event\) => \{ if \(touching\.current\) event\.preventDefault\(\); \}\}/);
});

// The app channel's ⋯ menu and long-press sheet share `messageMenuItems`.
function transcriptMessage(over = {}) {
  return {
    id: 7, kind: 'message', mine: false, senderId: 2, username: 'maya', text: 'here it is',
    canAskBot: false, canThread: false, showEdit: false, attachments: [], ...over,
  };
}
const image = (id) => ({ id, kind: 'image', name: `shot-${id}.png`, url: `/api/apps/demo/chat-attachments/${id}`, size: '2 KB', badge: null });

test('a channel message with pictures offers Download image to everyone, after Copy text', () => {
  const { messageMenuItems } = loadTsx('frontend/src/features/group-chat/transcript.tsx');
  const { restore } = stage();
  try {
    const items = (msg) => messageMenuItems(transcriptMessage(msg), 'main', () => {});
    const theirs = items({ attachments: [image('a')] });
    const keys = theirs.map((i) => i.key);
    assert.equal(keys.indexOf('download'), keys.indexOf('copy') + 1);
    assert.equal(theirs.find((i) => i.key === 'download').label, 'Download image');
    assert.ok(items({ mine: true, attachments: [image('a')] }).some((i) => i.key === 'download'), 'and on your own');
    assert.equal(items({ attachments: [image('a'), image('b')] }).find((i) => i.key === 'download').label, 'Download 2 images');
    assert.ok(!items({ attachments: [{ ...image('c'), kind: 'binary' }] }).some((i) => i.key === 'download'), 'not for a file');
    assert.ok(!items({}).some((i) => i.key === 'download'), 'not for words alone');
  } finally { restore(); }
});

test('a conversation message builds the same line from its picture attachments', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /const images = \(message\.attachments \|\| \[\]\)\.filter\(\(att\) => att\.contentType\.startsWith\('image\/'\)\);/);
  assert.match(row, /useCanSaveImage\(images\[0\]\?\.url \|\| ''\);/);
  assert.match(row, /const pictures = downloadableImages\(images\.map\(\(att\) => \(\{ src: att\.url, name: att\.name \}\)\)\);\n\s*if \(pictures\.length\) items\.push\(\{ key: 'download', label: downloadLabel\(pictures\.length\), icon: DownloadIcon, onSelect: \(\) => \{ void saveImages\(pictures\); \} \}\);/);
  assert.equal(message('messages:row.menu.copyText'), 'Copy text');
  const copyAt = row.indexOf("key: 'copy', label: t('messages:row.menu.copyText')");
  assert.ok(copyAt > 0 && row.indexOf("key: 'download'") > copyAt, 'right after Copy text');
});
