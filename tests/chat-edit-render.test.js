// Client rendering tests for multi-line messages + the "edited" marker,
// plus a source-level check that the history route SELECTs edited_at.
//
// public/js/group-chat.js is a browser script (no module.exports). We load
// it into a vm sandbox with just enough globals stubbed to evaluate it, then
// exercise the pure render helpers (renderMessageHtml, renderWithMentions).
//
// Run with: node --test tests/chat-edit-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadGroupChat() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'group-chat.js'),
    'utf8'
  );

  // Minimal DOM: escapeHtml round-trips text through a div's textContent →
  // innerHTML, which HTML-escapes &, <, > (and leaves newlines intact).
  const makeDocument = () => ({
    createElement() {
      let _text = '';
      return {
        set textContent(v) { _text = String(v); },
        get textContent() { return _text; },
        get innerHTML() {
          return _text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        },
        set innerHTML(_v) { /* unused by the read path under test */ },
      };
    },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: { appendChild() {} },
  });

  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document: makeDocument(),
    window: { matchMedia: () => ({ matches: false }) },
    navigator: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    src + '\nglobalThis.__M = { GroupChat, renderWithMentions, escapeHtml };',
    sandbox
  );
  return sandbox.__M;
}

const { GroupChat, renderWithMentions } = loadGroupChat();

const baseMsg = (over) => Object.assign({
  id: 1,
  username: 'alice',
  content: 'hello',
  msgType: 'message',
  userId: 2, // not self (App.user.id === 1) — keeps the edit button out of the way
  createdAt: '2026-06-16T18:00:00.000Z',
}, over);

test('renderMessageHtml emits the "edited" marker when edited_at is set', () => {
  const html = GroupChat.renderMessageHtml(baseMsg({ edited_at: '2026-06-16T18:41:00.000Z' }));
  assert.match(html, /gc-msg-edited/, 'marker span present');
  assert.match(html, /title="[^"]*edited[^"]*"/, 'marker carries a full-timestamp tooltip');
});

test('renderMessageHtml accepts the camelCase editedAt too', () => {
  const html = GroupChat.renderMessageHtml(baseMsg({ editedAt: '2026-06-16T18:41:00.000Z' }));
  assert.match(html, /gc-msg-edited/);
});

test('renderMessageHtml omits the marker for an unedited message', () => {
  const html = GroupChat.renderMessageHtml(baseMsg({}));
  assert.doesNotMatch(html, /gc-msg-edited/);
});

test('own ordinary message gets an Edit affordance; others do not', () => {
  const own = GroupChat.renderMessageHtml(baseMsg({ userId: 1 })); // App.user.id
  assert.match(own, /gc-msg-edit/, 'edit button on own message');
  const other = GroupChat.renderMessageHtml(baseMsg({ userId: 2 }));
  assert.doesNotMatch(other, /gc-msg-edit/, 'no edit button on someone else’s message');
});

test('multi-line content survives renderWithMentions with newlines intact', () => {
  const out = renderWithMentions('first line\nsecond line\n\nlast paragraph');
  assert.ok(out.includes('\n'), 'newlines preserved (white-space: pre-wrap renders them)');
  assert.match(out, /first line\nsecond line/, 'consecutive lines kept');
});

test('mentions and ref-chips still match across line breaks', () => {
  // @alice at the start, #12 right after a newline, PR#34 mid-line.
  const out = renderWithMentions('@alice\n#12 and PR#34 ship it');
  assert.match(out, /gc-mention/, '@mention chipped at start of message');
  assert.match(out, /gc-ref-issue/, '#12 chipped even though it follows a newline');
  assert.match(out, /gc-ref-pr/, 'PR#34 chipped');
  assert.ok(out.includes('\n'), 'newline between mention and ref preserved');
});

test('_collapseSnippet flattens newlines to single spaces for quote chips', () => {
  assert.equal(GroupChat._collapseSnippet('a\nb\n\n  c'), 'a b c');
});

test('history route SELECTs edited_at so loaded messages render the marker', () => {
  const routeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'chat.js'),
    'utf8'
  );
  assert.match(routeSrc, /m\.edited_at/, 'chat.js history SELECT includes m.edited_at');
});
