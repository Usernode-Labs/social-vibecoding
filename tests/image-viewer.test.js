'use strict';

// #3286: an image in a chat opens in the app's own viewer, which has a way
// out. A picture in a message used to be its file's link with
// target="_blank": a new tab in a browser, and in the installed app a
// full-screen file with nothing on it to get back with.
//
// features/image-viewer/image-viewer.tsx is the viewer; the app's channel
// (group-chat/transcript.tsx) and a conversation (messages/message-row.tsx)
// both open it from their thumbnails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const VIEWER = 'frontend/src/features/image-viewer/image-viewer.tsx';
const SRC = read(VIEWER);

const click = (over = {}) => ({
  button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...over,
});

test('a plain tap opens the viewer; a modified click keeps the link\'s own meaning', () => {
  const { isPlainClick, openInViewer } = loadTsx(VIEWER);
  assert.equal(isPlainClick(click()), true);
  for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
    assert.equal(isPlainClick(click({ [mod]: true })), false, `${mod}: a new tab or a download on purpose`);
  }
  assert.equal(isPlainClick(click({ button: 1 })), false, 'the middle button opens a tab');
  assert.equal(isPlainClick(click({ defaultPrevented: true })), false);

  let opened = 0;
  let prevented = 0;
  openInViewer({ ...click(), preventDefault: () => { prevented += 1; } }, () => { opened += 1; });
  assert.deepEqual([opened, prevented], [1, 1], 'the link is not followed');
  openInViewer({ ...click({ metaKey: true }), preventDefault: () => { prevented += 1; } }, () => { opened += 1; });
  assert.deepEqual([opened, prevented], [1, 1], 'left to the browser');
});

test('every way out works: close, around the image, a swipe down, Back and Escape', () => {
  // ✕, clear of the notch.
  assert.match(SRC, /aria-label=\{t\('core:common\.close'\)\}\n\s*data-image-viewer-close=""\n\s*onClick=\{\(\) => onCloseRef\.current\(\)\}/);
  assert.equal(message('core:common.close'), 'Close');
  assert.match(SRC, /pt-\[calc\(env\(safe-area-inset-top\)\+12px\)\]/);
  // A tap on the dark around the picture, and only there.
  assert.match(SRC, /onClick=\{\(event\) => \{ if \(event\.target === event\.currentTarget\) onCloseRef\.current\(\); \}\}/);
  // A swipe down past the threshold; a shorter one springs back.
  const { SWIPE_CLOSE_PX } = loadTsx(VIEWER);
  assert.equal(SWIPE_CLOSE_PX, 90);
  assert.match(SRC, /if \(travelled >= SWIPE_CLOSE_PX\) onCloseRef\.current\(\);\n\s*else setDrag\(0\);/);
  // Back claims a history record, and hands it back when closed any other
  // way: the next Back then reaches the page, not a viewer that is gone.
  assert.match(SRC, /const release = pushDismissible\(\(\) => \{\n\s*backed = true;\n\s*onCloseRef\.current\(\);\n\s*return true;\n\s*\}\);/);
  assert.match(SRC, /if \(!backed\) release\(\);/);
  assert.match(SRC, /if \(event\.key === 'Escape'\) onCloseRef\.current\(\);/);
  // Focus goes to ✕ and comes back to the thumbnail.
  assert.match(SRC, /closeRef\.current\?\.focus\(\{ preventScroll: true \}\);/);
  assert.match(SRC, /before\?\.focus\?\.\(\{ preventScroll: true \}\);/);
});

test('it covers the screen, above the message sheet, and only exists after a tap', () => {
  assert.match(SRC, /return createPortal\(\n\s*<div\n\s*className="fixed inset-0 z-\[2200\] flex items-center justify-center bg-black\/90"\n\s*role="dialog"\n\s*aria-modal="true"/);
  assert.match(SRC, /document\.body,\n\s*\);/, 'portalled: a transcript\'s transformed ancestors would size a fixed layer to themselves');
  const sheet = read('public/css/app.css').match(/\.msgx-sheet-layer \{[^}]*z-index: (\d+);/);
  assert.ok(sheet && Number(sheet[1]) < 2200, 'above the long-press sheet');
  // #4055: Download saves the file rather than opening it, through the one
  // helper that knows each device's road (tests/image-save.test.js).
  assert.match(SRC, /data-image-viewer-download=""\n\s*onClick=\{download\}/, 'Download saves the file rather than opening it');
});

test('the channel and a conversation both open their thumbnails in it, and keep the file as the link', () => {
  const transcript = read('frontend/src/features/group-chat/transcript.tsx');
  const image = transcript.slice(transcript.indexOf('function AttachmentImage('), transcript.indexOf('function AttachmentChip('));
  assert.match(image, /<a\n\s*href=\{att\.url\}\n\s*target="_blank"\n\s*rel="noopener"\n\s*title=\{att\.unnamed \? t\('chat:group\.attachment\.openFullSizeUnnamed'\) : t\('chat:group\.attachment\.openFullSize', \{ file: att\.name \}\)\}\n\s*data-image-open=""\n\s*onClick=\{\(event\) => openInViewer\(event, \(\) => setViewing\(true\)\)\}/);
  assert.equal(message('chat:group.attachment.openFullSize', { file: 'cat.png' }), 'cat.png: open full size');
  assert.match(image, /\{viewing \? <ImageViewer src=\{att\.url\} alt=\{att\.name\} onClose=\{\(\) => setViewing\(false\)\} \/> : null\}/);

  const row = read('frontend/src/features/messages/message-row.tsx');
  const attachment = row.slice(row.indexOf('function Attachment('), row.indexOf('\n}\n', row.indexOf('function Attachment(')));
  assert.match(attachment, /<a href=\{attachment\.url\} target="_blank" rel="noopener noreferrer" data-image-open="" onClick=\{\(event\) => openInViewer\(event, \(\) => setViewing\(true\)\)\}><img/);
  assert.match(attachment, /\{viewing \? <ImageViewer src=\{attachment\.url\} alt=\{attachment\.name\} onClose=\{\(\) => setViewing\(false\)\} \/> : null\}/);

  const dapp = JSON.parse(read('dapp.json'));
  assert.ok(dapp.tests.some((t) => /\.messages-attachment a\[data-image-open\]\[href\*=/.test(t.expectSelector || '')),
    'a declared check sees the thumbnail wired to the viewer');
});
