// The pending-upload strip above a composer — the chips and thumbnails for
// files staged but not yet sent (frontend/src/features/attachments/
// pending-strip.tsx).
//
// It used to be drawn in two places, the dev chat's composer and the group
// chat's, as the same markup written out twice. #1191 made them one
// component; the group chat's composer is the one that draws it now. What
// this pins:
//
//   * WHICH badge a kind gets. The composer computes the label and hands it
//     over, so the chip does not know one kind from another.
//   * HOW a row is removed. The composer holds the pending list — with the
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

test('removal reports an index, and the composer resolves it', () => {
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

  // The group chat wires that back to its own list.
  assert.match(read('frontend/src/features/group-chat/composer.tsx'),
    /onRemove=\{\(index\) => controller\(\)\?\._removeAttachmentAt\?\.\(index, scope\)\}/);
});

test('the composer owns its strip element, and the class comes with it', () => {
  // The element and its `dc-attach-strip-active` class come from the shared
  // file, which means ONE answer to "are there attachments" instead of a
  // rendered list and a hand-toggled class that could disagree.
  const id = 'gc-attachments';
  const withElement = renderComponent(STRIP, 'PendingStrip', {
    id, items: [item()], onRemove: () => {},
  });
  assert.match(withElement, new RegExp(`^<div id="${id}" class="dc-attach-strip dc-attach-strip-active">`));
  assert.match(
    renderComponent(STRIP, 'PendingStrip', { id, items: [], onRemove: () => {} }),
    new RegExp(`^<div id="${id}" class="dc-attach-strip"></div>$`),
  );
  // …and the rows-only export still emits no wrapper at all, which is what
  // keeps a caller that already has a host from nesting a second one.
  assert.ok(!rows([item()]).includes('dc-attach-strip'));
});
