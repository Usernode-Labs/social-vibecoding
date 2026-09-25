// Regression test for issue #2938: tapping Send in a chat composer while an
// attachment is still uploading shows "Still uploading, one moment…" above
// the composer — and nothing ever took it down. The upload finished, the
// message went out with its image, and the red line stayed.
//
// public/js/group-chat.js is a browser script (no module.exports), so it is
// loaded into a vm sandbox like group-chat-edit-quote-guard.test.js, with the
// React bridge replaced by a spy that records what each composer scope's
// error line is told to say.
//
// Run with: node --test tests/group-chat-upload-wait-notice.test.js

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
  const document = {
    createElement: () => ({}),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  // Each upload's fetch resolves only when the test says so.
  const uploads = [];
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    File: class {},
    TextDecoder,
    document,
    window: { matchMedia: () => ({ matches: false }), getSelection: () => null },
    navigator: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    fetch: () => new Promise((resolve) => {
      uploads.push((id) => resolve({
        ok: true,
        json: async () => ({ id, kind: 'image', meta: null }),
      }));
    }),
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\nglobalThis.__M = { GroupChat };', sandbox);
  const GroupChat = sandbox.__M.GroupChat;

  // The composer's error line, per scope, as the React bridge would draw it.
  const line = { general: null, thread: null };
  GroupChat._react = () => ({
    publishComposer(scope, patch) {
      if ('attachError' in patch) line[scope] = patch.attachError;
    },
  });
  GroupChat._attachSlug = () => 'demo';
  GroupChat._readOnly = () => false;
  GroupChat.ws = { readyState: 1, send() {} };
  return { GroupChat, uploads, line };
}

const image = () => ({ name: 'shot.png', size: 1024, type: 'image/png' });
const flush = () => new Promise((r) => setImmediate(r));
const THREAD = { type: 'issue', ref: 7 };

test('the wait notice comes down when the upload it was waiting on lands', async () => {
  const { GroupChat, uploads, line } = loadGroupChat();
  const adding = GroupChat._addFiles([image()], THREAD);
  await flush();
  assert.equal(GroupChat.attachmentsUploading(THREAD), true);

  // Send tapped mid-upload: the thread composer's own guard.
  GroupChat._setAttachError(GroupChat.UPLOAD_WAIT_NOTICE, THREAD);
  assert.equal(line.thread, 'Still uploading, one moment…');

  uploads[0]('a'.repeat(32));
  await adding;
  assert.equal(GroupChat.attachmentsUploading(THREAD), false);
  assert.equal(line.thread, null, 'notice cleared once nothing is uploading');
});

test('sending clears the error line of the composer it emptied', async () => {
  const { GroupChat, uploads, line } = loadGroupChat();
  const adding = GroupChat._addFiles([image()], THREAD);
  await flush();
  uploads[0]('b'.repeat(32));
  await adding;

  GroupChat._setAttachError('Still uploading, one moment…', THREAD);
  assert.equal(line.thread, 'Still uploading, one moment…');
  GroupChat.send('', THREAD);
  assert.equal(line.thread, null, 'notice cleared by the send');
  assert.equal(GroupChat.hasPendingAttachments(THREAD), false);
});

test('an upload landing does not erase a real error', async () => {
  const { GroupChat, uploads, line } = loadGroupChat();
  const adding = GroupChat._addFiles([image()], THREAD);
  await flush();
  GroupChat._setAttachError('Up to 5 files per message.', THREAD);
  uploads[0]('c'.repeat(32));
  await adding;
  assert.equal(line.thread, 'Up to 5 files per message.');
});

test('the notice waits for the LAST in-flight upload, not the first', async () => {
  const { GroupChat, uploads, line } = loadGroupChat();
  // _addFiles uploads a batch one after another; two separate picks overlap.
  const first = GroupChat._addFiles([image()], null);
  await flush();
  const second = GroupChat._addFiles([image()], null);
  await flush();
  GroupChat._setAttachError(GroupChat.UPLOAD_WAIT_NOTICE, null);

  uploads[0]('d'.repeat(32));
  await first;
  assert.equal(line.general, 'Still uploading, one moment…', 'still one in flight');
  uploads[1]('e'.repeat(32));
  await second;
  assert.equal(line.general, null);
});

test('both composers show the same shared notice', () => {
  const root = path.join(__dirname, '..', 'public', 'js');
  for (const file of ['group-chat.js', 'app-view.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(src, /_setAttachError\(GroupChat\.UPLOAD_WAIT_NOTICE,/, file);
  }
});
