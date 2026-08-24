// The pending-upload strip above a composer — the chips and thumbnails for
// files staged but not yet sent.
//
// ── Why this file is new ──────────────────────────────────────────────
//
// It was drawn in TWO places and always had been: the dev chat's composer and
// the group chat's. The group chat's own comment said so — "reuses the
// dev-chat dc-attach-* styles" — and the two renderers were the same markup
// written out twice, in modules that could not import each other. Neither had
// a test, so nothing would have noticed if they drifted, and the second copy
// is exactly how a fix reaches one composer and not the other.
//
// #1191 made them one component. What this pins is the part that is now
// shared, and the two things the two chats genuinely differ on:
//
//   * WHICH badge a kind gets. The dev chat has `zip` with an entry count;
//     the group chat has `markdown` and `html`. Each module computes the
//     label and hands it over, so the chip does not know the difference.
//   * HOW a row is removed. Each module holds the pending list — with the
//     File and the object URL it has to revoke — so the row reports an INDEX.
//
// Run with: node --test tests/attachments-pending-strip.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const STRIP = 'frontend/src/features/attachments/pending-strip.tsx';
const item = (over) => ({
  key: 'p1', name: 'notes.md', kind: 'markdown', badge: 'MD', size: '2 KB',
  thumbUrl: null, uploading: false, ...over,
});
const rows = (items) => renderComponent(STRIP, 'PendingStripRows', { items, onRemove: () => {} });

test('a chip carries its badge, name, size and a remove control', () => {
  const html = rows([item()]);
  assert.equal(
    html,
    '<div class="dc-attach-item dc-attach-chip" title="notes.md">'
      + '<span class="dc-attach-kind">MD</span>'
      + '<span class="dc-attach-name">notes.md</span>'
      + '<span class="dc-attach-size">2 KB</span>'
      + '<button type="button" class="dc-attach-remove" title="Remove" aria-label="Remove notes.md">×</button>'
      + '</div>',
  );
  // A kind with no tag draws no empty span.
  assert.ok(!rows([item({ kind: 'text', badge: null })]).includes('dc-attach-kind'));
});

test('an image with a local preview is a thumbnail, not a chip', () => {
  const html = rows([item({ kind: 'image', badge: null, thumbUrl: 'blob:x', name: 'shot.png' })]);
  assert.match(html, /<div class="dc-attach-item"><img class="dc-attach-thumb" src="blob:x" alt="shot.png" title="shot.png"\/>/);
  assert.ok(!html.includes('dc-attach-chip'));
  // …and an image whose preview has not been made yet falls back to the chip,
  // rather than rendering an <img> with no source.
  assert.match(rows([item({ kind: 'image', badge: null, thumbUrl: null })]), /dc-attach-chip/);
});

test('an upload in flight offers no remove control', () => {
  // Cancelling mid-PUT would leave a half-written row for the 24h orphan
  // sweep to find anyway, and a control that sometimes works is worse than an
  // honest "…". Both chats behave this way, and now they do so once.
  const html = rows([item({ uploading: true })]);
  assert.match(html, /<span class="dc-attach-uploading">…<\/span>/);
  assert.ok(!html.includes('dc-attach-remove'));
});

test('a filename reaches the DOM as text, in all three slots it appears in', () => {
  // `title`, `alt` and `aria-label` all carry one, and a filename is fully
  // user-controlled. This is the property `escapeHtml` / `_escAttr` used to
  // give by hand in each module.
  const hostile = 'x" onmouseover="alert(1)"><img src=y>.png';
  const html = rows([
    item({ key: 'a', name: hostile }),
    item({ key: 'b', name: hostile, kind: 'image', badge: null, thumbUrl: 'blob:z' }),
  ]);
  assert.ok(!html.includes('<img src=y>'), 'the tag never lands as markup');
  assert.ok(!/" onmouseover="/.test(html), 'the quote cannot close an attribute');
  assert.match(html, /&quot; onmouseover=/);
});

test('removal reports an index, and each module resolves it', () => {
  const { PendingStripRows } = loadTsx(STRIP);
  const removed = [];
  const element = PendingStripRows({
    items: [item({ key: 'a' }), item({ key: 'b' }), item({ key: 'c', uploading: true })],
    onRemove: (i) => removed.push(i),
  });
  const list = element.props.children;
  assert.equal(list.length, 3);
  // Each row's own position, not the key and not the filename — the live
  // entry (File, object URL) never leaves the module.
  list[0].props.onRemove(list[0].props.index);
  list[1].props.onRemove(list[1].props.index);
  assert.deepEqual(removed, [0, 1]);

  // Both callers wire that back to their own list.
  assert.match(read('frontend/src/features/group-chat/composer.tsx'),
    /onRemove=\{\(index\) => controller\(\)\?\._removeAttachmentAt\?\.\(index, scope\)\}/);
  assert.match(read('frontend/src/features/dev-chat/attach-strip.tsx'),
    /onRemove=\{\(index\) => controller\(\)\?\._removeAttachment\?\.\(index\)\}/);
});

test('the group chat owns its strip element; the dev chat rents one', () => {
  // The group chat's strip is part of a React tree, so it takes the element
  // and its `dc-attach-strip-active` class from the shared file. The dev
  // chat's is written by `renderChatView`'s template and portalled into, so
  // the element stays that module's — host is mine, children are React's.
  const withElement = renderComponent(STRIP, 'PendingStrip', {
    id: 'gc-attachments', items: [item()], onRemove: () => {},
  });
  assert.match(withElement, /^<div id="gc-attachments" class="dc-attach-strip dc-attach-strip-active">/);
  assert.match(
    renderComponent(STRIP, 'PendingStrip', { id: 'gc-attachments', items: [], onRemove: () => {} }),
    /^<div id="gc-attachments" class="dc-attach-strip"><\/div>$/,
  );
  // …and the rows-only export emits no wrapper at all, which is what keeps
  // the dev chat from nesting a second #dc-attachments inside its own.
  assert.ok(!rows([item()]).includes('dc-attach-strip'));

  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(devChat, /strip\.classList\.toggle\('dc-attach-strip-active', DevChat\.pendingAttachments\.length > 0\)/);
});

test('dev-chat.js stays import-free, because a dozen tests load it as a script', () => {
  // A top-level `import` is a syntax error inside `vm.runInContext(SRC)`, and
  // the first attempt at this conversion added two — 194 tests went red at
  // once. The seam is a bridge (features/dev-chat/mount.ts) reached by name,
  // exactly as the classic scripts in public/js/** do it.
  const src = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.doesNotMatch(src, /^import /m, 'no top-level import survives in dev-chat.js');
  assert.match(src, /window\.UsernodeReact\s*\)\s*\n?\s*\? window\.UsernodeReact\.devChat : null/);
  const mount = read('frontend/src/features/dev-chat/mount.ts');
  assert.match(mount, /bridge\.devChat = devChatBridge;/);
  assert.match(mount, /if \(typeof window !== 'undefined'\) \{/, 'guarded for the prerender pass');
  assert.match(read('frontend/src/main.tsx'), /import '\.\/features\/dev-chat\/mount';/);
});
