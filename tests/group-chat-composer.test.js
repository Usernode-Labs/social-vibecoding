// The group chat composer, after #1191 made both of them one component.
//
// ── Why this file is new ──────────────────────────────────────────────
//
// There were TWO composers — the general chat's, built by an `innerHTML`
// template in public/js/app-view.js's `renderGroupChatTab`, and the topic
// thread's, in features/group-chat/thread-shell.tsx — and they had to look
// identical. Nothing checked that they did. The three rows above the form
// (the staged reply, the attach error, the pending uploads) really were one
// renderer, but only because each began with a
// `thread ? 'gc-thread-…' : 'gc-…'` ternary; the form itself was written out
// twice, and one copy was on the primitive-adoption allow-list purely because
// the other could not follow it.
//
// They are one component with a `scope` now, so the pair is structural rather
// than maintained. What this file pins is what that costs nothing to keep
// right and everything to lose:
//
//   1. Every id both modules read back — `setupAttachments` finds the
//      paperclip and the file input, `mountThread` and `renderGroupChatTab`
//      bind the form and the textarea, and a scope that stopped emitting one
//      would break silently.
//   2. The class strings, byte for byte against what the hand-written
//      composer shipped. Routing through <Button> / <Textarea> meant widening
//      the cva tables, and a widening in the wrong ORDER moves the rendered
//      attribute.
//   3. `hidden` follows the DATA now — the module publishes one thing where
//      it used to write text and toggle a class.
//   4. A filename reaches the DOM as text. `_escAttr` existed because
//      `escapeHtml` leaves `"` alone and a filename is fully user-controlled;
//      it is gone, and this is the property it was protecting.
//
// Run with: node --test tests/group-chat-composer.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { renderComponent } = require('./lib/render-tsx');

const COMPOSER = 'frontend/src/features/group-chat/composer.tsx';
const gcJs = read('public/js/group-chat.js');
const appView = read('public/js/app-view.js');
const stripped = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const EMPTY = { quote: null, attachError: null, attachments: [], status: '' };
const slots = (scope, slot) => renderComponent(COMPOSER, 'ComposerSlotsView', {
  scope,
  slot: { ...EMPTY, ...slot },
});
const form = (scope, fill = true) => renderComponent(COMPOSER, 'ComposerForm', {
  scope,
  fill,
  placeholder: 'Type a message...',
  maxLength: 8000,
});

// ── The pair ──────────────────────────────────────────────────────────

test('both scopes render the same control under their own ids', () => {
  const general = slots('general', {}) + form('general');
  const thread = slots('thread', {}) + form('thread');
  // The ids each module reads back, in the two spellings the ternary had.
  for (const [g, t] of [
    ['gc-reply-preview', 'gc-thread-reply-preview'],
    ['gc-attach-error', 'gc-thread-attach-error'],
    ['gc-attachments', 'gc-thread-attachments'],
    ['gc-form', 'gc-thread-form'],
    ['gc-attach-btn', 'gc-thread-attach-btn'],
    ['gc-file-input', 'gc-thread-file-input'],
    ['gc-input', 'gc-thread-input'],
  ]) {
    assert.match(general, new RegExp(`id="${g}"`), `general has #${g}`);
    assert.match(thread, new RegExp(`id="${t}"`), `thread has #${t}`);
    assert.ok(!general.includes(`id="${t}"`), `general does not carry #${t}`);
  }
  // …and apart from the ids they are the same string.
  assert.equal(general.replace(/id="gc-/g, 'id="X-'), thread.replace(/id="gc-thread-/g, 'id="X-'));
});

test('the modules still read those ids back', () => {
  const code = stripped(gcJs);
  assert.match(code, /getElementById\(t \? 'gc-thread-attach-btn' : 'gc-attach-btn'\)/);
  assert.match(code, /getElementById\(t \? 'gc-thread-file-input' : 'gc-file-input'\)/);
  assert.match(code, /getElementById\(t \? 'gc-thread-input' : 'gc-input'\)/);
  assert.match(code, /container\.querySelector\('#gc-thread-form'\)/);
  assert.match(code, /getElementById\(t \? 'gc-thread-form' : 'gc-form'\)/);
  assert.match(stripped(appView), /getElementById\('gc-form'\)/);
  assert.match(stripped(appView), /getElementById\('gc-input'\)/);
});

test('the class strings did not move when they went through the primitives', () => {
  // Byte for byte against what the hand-written composers shipped. Widening a
  // cva table in the wrong order is a silent restyle, so the check is the
  // whole attribute, not a substring.
  const html = form('general');
  const textarea = html.match(/<textarea[^>]*class="([^"]*)"/);
  assert.ok(textarea, 'found the field');
  assert.equal(
    textarea[1],
    'gc-composer-input flex-1 min-w-0 resize-none overflow-y-auto rounded-lg bg-zinc-100'
      + ' dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm'
      + ' text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500'
      + ' focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent',
  );
  const send = html.match(/<button type="submit" class="([^"]*)"/);
  assert.ok(send, 'found the Send button');
  assert.equal(
    send[1],
    'rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium'
      + ' text-black transition-colors shrink-0',
  );

  // The boxed thread layout is the same string one size down.
  const tight = form('thread', false);
  assert.match(tight, /px-3 py-1\.5 text-sm text-zinc-900/);
  assert.match(tight, /<button type="submit" class="rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1\.5 text-sm font-medium text-black transition-colors shrink-0"/);
});

// ── The three rows ────────────────────────────────────────────────────

test('the staged reply draws its label and snippet, and hides when there is none', () => {
  assert.match(slots('general', {}), /<div id="gc-reply-preview" class="hidden"><\/div>/);

  const html = slots('general', { quote: { label: '@alice', snippet: 'the original line' } });
  assert.match(html, /<div id="gc-reply-preview" class=""/);
  assert.match(html, /<span class="gc-reply-preview-label">↩ Replying to @alice<\/span>/);
  assert.match(html, /<span class="gc-reply-preview-snippet">the original line<\/span>/);
  assert.match(html, /aria-label="Cancel reply"/);
  // `#gc-reply-cancel` was the general composer's, and stays only there — the
  // thread's ✕ never had an id and nothing looks for one.
  assert.match(html, /id="gc-reply-cancel"/);
  assert.ok(!slots('thread', { quote: { label: '@a', snippet: 'b' } }).includes('gc-reply-cancel'));
});

test('the module publishes the staged reply to both scopes, and no longer paints', () => {
  const code = stripped(gcJs);
  const fn = code.match(/_renderQuotePreview\(\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_renderQuotePreview() found');
  assert.doesNotMatch(fn[1], /innerHTML|classList|getElementById/);
  assert.match(fn[1], /_publishComposer\('general', \{ quote: view \}\)/);
  assert.match(fn[1], /_publishComposer\('thread', \{ quote: view \}\)/);
  // The label the two sources produce: a PR number, an @author, or the word.
  assert.match(fn[1], /`PR #\$\{q\.prNumber \|\| ''\}`\.trim\(\)/);
  assert.match(fn[1], /q\.author \? `@\$\{q\.author\}` : 'message'/);
});

test('the attach error line hides itself when there is nothing to say', () => {
  assert.match(slots('general', {}), /<div id="gc-attach-error" class="dc-attach-error hidden"><\/div>/);
  const html = slots('general', { attachError: 'Up to 5 files per message.' });
  assert.match(html, /<div id="gc-attach-error" class="dc-attach-error">Up to 5 files per message\.<\/div>/);
  // One publish, not a textContent write plus a class toggle.
  const fn = stripped(gcJs).match(/_setAttachError\(msg, thread\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_setAttachError() found');
  assert.match(fn[1], /attachError: msg \|\| null/);
  assert.doesNotMatch(fn[1], /classList|textContent/);
});

test('the pending-upload strip earns its active class from having rows', () => {
  assert.match(slots('general', {}), /<div id="gc-attachments" class="dc-attach-strip"><\/div>/);

  const html = slots('general', {
    attachments: [
      { key: 'p1', name: 'notes.md', kind: 'markdown', badge: 'MD', size: '2 KB', thumbUrl: null, uploading: false },
      { key: 'p2', name: 'shot.png', kind: 'image', badge: null, size: '10 KB', thumbUrl: 'blob:x', uploading: false },
      { key: 'p3', name: 'big.bin', kind: 'binary', badge: 'BIN', size: '3.0 MB', thumbUrl: null, uploading: true },
    ],
  });
  assert.match(html, /id="gc-attachments" class="dc-attach-strip dc-attach-strip-active"/);
  // A chip: badge, name, size, remove.
  assert.match(html, /<div class="dc-attach-item dc-attach-chip" title="notes.md"><span class="dc-attach-kind">MD<\/span><span class="dc-attach-name">notes.md<\/span><span class="dc-attach-size">2 KB<\/span>/);
  // An image with a local preview: the thumbnail, not a chip.
  assert.match(html, /<img class="dc-attach-thumb" src="blob:x" alt="shot.png" title="shot.png"\/>/);
  // In flight: the ellipsis, and NO remove control — cancelling mid-PUT would
  // leave a half-written row behind.
  assert.match(html, /<span class="dc-attach-uploading">…<\/span>/);
  assert.equal((html.match(/dc-attach-remove/g) || []).length, 2);
  assert.match(html, /aria-label="Remove notes.md"/);
});

test('a filename reaches the DOM as text, in every slot it appears in', () => {
  // `_escAttr` is gone. It existed because escapeHtml (the div trick) mirrors
  // TEXT-node escaping and leaves `"` alone, which a crafted filename could
  // break out of inside a double-quoted attribute — `title`, `alt` and
  // `aria-label` all carry one here.
  const hostile = 'x" onmouseover="alert(1)"><img src=x>.png';
  const html = slots('general', {
    attachments: [
      { key: 'p1', name: hostile, kind: 'image', badge: null, size: '1 B', thumbUrl: 'blob:y', uploading: false },
      { key: 'p2', name: hostile, kind: 'text', badge: null, size: '1 B', thumbUrl: null, uploading: false },
    ],
  });
  assert.ok(!html.includes('<img src=x>'), 'the tag never lands as markup');
  assert.ok(!/" onmouseover="/.test(html), 'the quote cannot close an attribute');
  assert.match(html, /&quot; onmouseover=/);
  assert.doesNotMatch(stripped(gcJs), /_escAttr/, 'and the escape it needed is gone with it');

  // The staged reply's two lines are text children for the same reason.
  const quoted = slots('general', { quote: { label: '<b>alice</b>', snippet: '<script>x</script>' } });
  assert.ok(!quoted.includes('<b>') && !quoted.includes('<script'));
});

test('the status line is one slot with two owners, and both publish', () => {
  const html = renderComponent(COMPOSER, 'StatusLineView', {
    scope: 'general', className: 'px-3 h-5', status: 'bob is typing...',
  });
  assert.equal(html, '<div id="gc-typing" class="px-3 h-5">bob is typing...</div>');
  assert.match(
    renderComponent(COMPOSER, 'StatusLineView', { scope: 'thread', className: 'x', status: '' }),
    /<div id="gc-thread-typing" class="x"><\/div>/,
  );

  const code = stripped(gcJs);
  const fn = code.match(/_renderStatusLine\(\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_renderStatusLine() found');
  assert.doesNotMatch(fn[1], /getElementById|textContent/);
  // Connection state still WINS over typing when the socket is down: it is
  // the actionable one, and a typing notice from a stale state misleads.
  assert.match(fn[1], /Reconnecting… \(\$\{queued\} queued\)/);
  assert.match(fn[1], /_publishComposer\('general'/);
  assert.match(code, /_publishComposer\('thread', \{ status: `\$\{username\} is typing\.\.\.` \}\)/);
});

test('removing an upload goes back through the module, by index', () => {
  // The live entry holds a File and an object URL, so it never leaves
  // group-chat.js; the view model carries a position instead.
  assert.match(read(COMPOSER), /_removeAttachmentAt\?\.\(index, scope\)/);
  const fn = stripped(gcJs).match(/_removeAttachmentAt\(index, scope\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_removeAttachmentAt() found');
  assert.match(fn[1], /_pendingFor\(thread\)\[index\]/);
  assert.match(fn[1], /scope === 'thread' \? GroupChat\.activeThread : null/);
  // …and the object URL is still revoked where the entry is dropped.
  assert.match(stripped(gcJs), /revokeObjectURL\(entry\.objectUrl\)/);
});

test('the general chat pane is mounted, not assigned', () => {
  const code = stripped(appView);
  const fn = code.match(/renderGroupChatTab\(\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, 'renderGroupChatTab() found');
  assert.doesNotMatch(fn[1], /innerHTML/, 'the tab builds no markup');
  assert.match(fn[1], /mountGeneralChat\(content, \{/);
  // Rule 1: the transcript's portal points INTO #gc-messages, so it goes
  // before the shell re-renders — the read-only branch does not emit that
  // element at all.
  assert.match(fn[1], /unmountTranscript\(previousList\)/);
  assert.ok(fn[1].indexOf('unmountTranscript') < fn[1].indexOf('mountGeneralChat'));
  // The banner's localStorage write stays in the module: a component that
  // stamped it would fire again on every re-render.
  assert.match(fn[1], /localStorage\.setItem\('usernode_seen_gc_intro', '1'\)/);
});
