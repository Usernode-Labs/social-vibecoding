// #4065: drag-and-drop attachments in the discussion, chat and improvement
// windows. Every composer already took a dropped file; what this pins is the
// part people could not see or were not told:
//
//   * the drop zone (features/attachments/file-drag.tsx): a depth count that
//     stays lit while the pointer crosses the card's own controls, lights only
//     for a FILE drag and never where a drop would be refused;
//   * each composer drawing it (group chat, dev chat, agent session,
//     "Suggest an improvement", Messages);
//   * one error line for every file a drop left out — the first reason and
//     how many more — in the group chat, the dev chat, the agent session and
//     Messages;
//   * the window guard (lib/file-drop-guard.ts): a file dropped where nothing
//     takes it does not open in place of the app.
//
// Run with: node --test tests/attachments-file-drag.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { composerHtml } = require('./lib/dev-composer-html');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const drag = () => loadTsx('frontend/src/features/attachments/file-drag.tsx');

function dragEvent(types = ['Files'], files = [], type = 'drop') {
  const event = {
    type,
    prevented: 0,
    dataTransfer: { types, files, dropEffect: 'none' },
    preventDefault() { event.prevented += 1; event.defaultPrevented = true; },
    defaultPrevented: false,
  };
  return event;
}

// ── The tracker ───────────────────────────────────────────────────────

test('crossing the card’s own controls keeps the zone lit; leaving it clears it', () => {
  const { createFileDragTracker } = drag();
  const changes = [];
  const t = createFileDragTracker({ onChange: (v) => changes.push(v) });
  t.enter(dragEvent()); // the card
  t.enter(dragEvent()); // the textarea inside it
  t.leave(dragEvent()); // …out of the card's own edge as seen by the card
  assert.deepEqual(changes, [true], 'a leave from a child does not clear it');
  t.leave(dragEvent());
  assert.deepEqual(changes, [true, false]);
  t.dispose();
});

test('only a drag carrying files lights it, and a refused zone never does', () => {
  const { createFileDragTracker, isFileDrag } = drag();
  assert.equal(isFileDrag(dragEvent(['text/plain'])), false);
  assert.equal(isFileDrag(dragEvent(['Files'])), true);
  const changes = [];
  const t = createFileDragTracker({ onChange: (v) => changes.push(v) });
  const text = dragEvent(['text/plain', 'text/uri-list']);
  t.enter(text); t.over(text);
  assert.equal(text.prevented, 0, 'a text drag keeps the browser’s own drop into the field');
  assert.deepEqual(changes, []);

  let off = true;
  const r = createFileDragTracker({ isDisabled: () => off, onChange: (v) => changes.push(v) });
  const file = dragEvent();
  r.enter(file); r.over(file);
  assert.deepEqual(changes, [], 'read-only, archived or busy: no outline');
  assert.equal(file.dataTransfer.dropEffect, 'none');
  off = false;
  const ok = dragEvent();
  r.enter(ok); r.over(ok);
  assert.equal(ok.dataTransfer.dropEffect, 'copy');
  assert.deepEqual(changes, [true]);
  r.reset();
  assert.deepEqual(changes, [true, false], 'a drop clears it outright');
  t.dispose(); r.dispose();
});

test('the summary names the first reason and counts the rest', () => {
  const { refusalSummary } = drag();
  assert.equal(refusalSummary('"a.png" is too big. Images max 4 MB.', 0), '"a.png" is too big. Images max 4 MB.');
  assert.equal(refusalSummary('Up to 4 files per message.', 1), 'Up to 4 files per message. 1 more file wasn’t attached.');
  assert.equal(refusalSummary('Up to 4 files per message.', 3), 'Up to 4 files per message. 3 more files weren’t attached.');
});

test('the outline is the Messages one, and lies over the card', () => {
  const { DropOverlay } = drag();
  const html = renderToHtml(createElement(DropOverlay, {}));
  assert.match(html, /class="attach-drop-overlay"/);
  assert.match(html, />Drop files to attach</);
  assert.match(html, /aria-hidden="true"/);
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-drop-overlay,\s*\.attach-drop-overlay \{\s*position: absolute;/, 'one style for both');
  assert.match(css, /\.gc-composer-card,[\s\S]{0,80}\.dc-card,\s*\.agent-session-composer,\s*#feedback-form \{ position: relative; \}/);
});

// ── Each composer draws it ────────────────────────────────────────────

test('the group chat’s card draws the zone while its slot says dragging', () => {
  const api = loadTsx('tests/fixtures/group-composer-api.ts');
  const form = (scope, fill) => renderToHtml(createElement(api.ComposerForm, {
    scope, fill, placeholder: 'Message…', maxLength: 8000,
  }));
  api.composerStore.set(api.EMPTY_COMPOSER);
  assert.doesNotMatch(form('general', true), /attach-drop-overlay/, 'nothing on first render');
  api.composerStore.set((s) => ({ ...s, thread: { ...s.thread, dragging: true } }));
  assert.doesNotMatch(form('general', true), /attach-drop-overlay/, 'the other scope’s drag is not this one’s');
  assert.match(form('thread', true), /<form id="gc-thread-form" class="gc-composer-card[^"]*">[\s\S]*Drop files to attach<\/div><\/form>/);
  assert.match(form('thread', false), /Drop files to attach<\/div><\/form>/, 'the boxed thread composer too');
  api.composerStore.set(api.EMPTY_COMPOSER);
});

test('the dev chat’s card draws the zone from its model', () => {
  const base = JSON.parse(JSON.stringify({
    venueNoteHtml: '', hidden: false, models: null,
    drafts: { rows: [], busy: false }, attachError: null, placeholder: '',
    send: { kind: 'send' },
  }));
  assert.doesNotMatch(composerHtml(base), /attach-drop-overlay/);
  assert.match(composerHtml({ ...base, dragging: true }), /Drop files to attach<\/div><\/form>/);
});

test('the agent session, the improvement form and Messages each wire the shared zone', () => {
  const session = read('frontend/src/features/agent-session/index.tsx');
  assert.match(session, /useFileDrag\(\{ disabled: archived, onFiles:/);
  assert.match(session, /className="platform-safe-bar shrink-0 px-3 pt-1" \{\.\.\.drop\.handlers\}/,
    'the bar, not only the card, so a drop beside the card does not open the file');
  assert.match(session, /\{drop\.dragging \? <DropOverlay \/> : null\}/);

  const feedback = read('frontend/src/features/dialogs/feedback.tsx');
  assert.match(feedback, /<HostDropOverlay host=\{feedbackForm\} label=\{t\('dialogs:feedback\.dropLabel'\)\} isDisabled=\{feedbackLocked\} \/>/);
  assert.equal(message('dialogs:feedback.dropLabel'), 'Drop images or a clip to attach');
  assert.match(read('frontend/src/features/dialogs/feedback-controller.js'),
    /feedbackForm\.addEventListener\('drop'/, 'the controller still does the attaching');

  const messages = read('frontend/src/features/messages/composer.tsx');
  assert.match(messages, /useFileDrag\(\{ onFiles:/);
  assert.match(messages, /<DropOverlay className="messages-drop-overlay" \/>/);
});

// ── One line for every file left out ─────────────────────────────────

function loadGroupChat() {
  const src = read('public/js/group-chat.js');
  const fileDrag = drag();
  const uploads = [];
  const sandbox = {
    // The binding the controller's i18n import gives it (the import line is stripped above).
    t: englishPlatformI18n().t,
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    File: class {},
    TextDecoder,
    document: {
      createElement: () => ({}), getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener() {}, body: { appendChild() {} },
    },
    window: {
      matchMedia: () => ({ matches: false }), getSelection: () => null,
      UsernodeReact: { fileDrag: { createFileDragTracker: fileDrag.createFileDragTracker, refusalSummary: fileDrag.refusalSummary } },
    },
    navigator: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({ id: `id${uploads.push(1)}`, kind: 'image', meta: null }) }),
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nglobalThis.__M = { GroupChat };`, sandbox);
  const GroupChat = sandbox.__M.GroupChat;
  const slot = { general: {}, thread: {} };
  GroupChat._react = () => ({ publishComposer(scope, patch) { Object.assign(slot[scope], patch); } });
  GroupChat._attachSlug = () => 'demo';
  let readOnly = false;
  GroupChat._readOnly = () => readOnly;
  return { GroupChat, slot, uploads, setReadOnly: (v) => { readOnly = v; } };
}

const file = (name, size = 1024) => ({ name, size, type: 'image/png', arrayBuffer: async () => new ArrayBuffer(size) });

test('group chat: six files with one too big attach four and say so once', async () => {
  const { GroupChat, slot, uploads } = loadGroupChat();
  await GroupChat._addFiles([
    file('a.png'), file('huge.png', 5 * 1024 * 1024), file('b.png'), file('c.png'), file('d.png'), file('e.png'),
  ], null);
  assert.equal(uploads.length, 4, 'the four that fit uploaded');
  assert.equal(slot.general.attachError,
    '"huge.png" is too big. Images max 4 MB. 1 more file wasn’t attached.',
    'the first reason, not the last, and the file past the fourth counted');
});

test('group chat: the drag tracker publishes dragging per scope, never when read-only', () => {
  const { GroupChat, slot, setReadOnly } = loadGroupChat();
  const listeners = {};
  const el = { addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); } };
  GroupChat._wireDropZone([el], { type: 'session', ref: 9 });
  const fire = (type, e) => (listeners[type] || []).forEach((fn) => fn(e));
  fire('dragenter', dragEvent());
  assert.equal(slot.thread.dragging, true);
  assert.equal(slot.general.dragging, undefined);
  fire('drop', dragEvent());
  assert.equal(slot.thread.dragging, false);
  setReadOnly(true);
  fire('dragenter', dragEvent());
  assert.equal(slot.thread.dragging, false, 'a read-only thread shows no zone');
});

test('dev chat: the same summary, and the zone only where a drop is taken', async () => {
  const src = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(src, /dragging: DevChat\._dragging && !DevChat\._dropDisabled\(\),/);
  assert.match(src, /_dropDisabled\(\) \{\s*return !DevChat\.currentSession \|\| !!DevChat\.isStreaming/);
  assert.match(src, /refuse\(`Up to \$\{L\.maxPerMessage\} files per message\.`, files\.length - i\);/);
  assert.match(src, /DevChat\._setAttachError\(DevChat\._refusalSummary\(firstRefusal, refused - 1\)\);/);
});

test('agent session: the tray counts every file it refused', () => {
  const att = loadTsx('frontend/src/features/agent-session/attachments.ts');
  const f = (name, size = 10) => ({ name, size });
  const six = att.acceptFiles(0, [f('a.png'), f('huge.png', 5 * 1024 * 1024), f('b.png'), f('c.png'), f('d.png'), f('e.png')]);
  assert.deepEqual(six.accepted.map((x) => x.name), ['a.png', 'b.png', 'c.png', 'd.png']);
  assert.equal(six.error, '"huge.png" is too big. Images max 4 MB.');
  assert.equal(six.refusedCount, 2);
  assert.equal(att.acceptFiles(0, [f('a.png')]).refusedCount, 0);
  assert.match(read('frontend/src/features/agent-session/store.ts'),
    /if \(error\) toast\(refusalSummary\(error, refusedCount - 1\)\);/);
});

test('Messages: files past the room are counted, not dropped without a word', () => {
  const src = read('frontend/src/features/messages/composer.tsx');
  assert.match(src, /const cut = files\.length - selected\.length;/);
  assert.match(src, /refusalSummary\(firstReason, tooLarge\.length \+ cut - 1\)/);
});

// ── The floor under every zone ────────────────────────────────────────

test('a file dropped where nothing takes it does not open in place of the app', () => {
  const guard = loadTsx('frontend/src/lib/file-drop-guard.ts');
  const unclaimed = dragEvent();
  guard.onUnclaimedFileDrag(unclaimed);
  assert.equal(unclaimed.prevented, 1);
  const over = dragEvent(['Files'], [], 'dragover');
  guard.onUnclaimedFileDrag(over);
  assert.equal(over.dataTransfer.dropEffect, 'none', 'the cursor says nothing will happen');

  const text = dragEvent(['text/plain']);
  guard.onUnclaimedFileDrag(text);
  assert.equal(text.prevented, 0, 'a text drag is left alone');

  const claimed = dragEvent();
  claimed.defaultPrevented = true;
  guard.onUnclaimedFileDrag(claimed);
  assert.equal(claimed.prevented, 0, 'a drop a composer took is left alone');
  assert.equal(claimed.dataTransfer.dropEffect, 'none');

  assert.match(read('frontend/src/main.tsx'), /import '\.\/lib\/file-drop-guard';/);
});
