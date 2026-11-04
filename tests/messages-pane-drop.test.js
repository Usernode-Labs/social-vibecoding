// #6254: the link between a thread pane and the message box that owns its
// upload. The pane is the drop zone; the composer is where the files land.
//
// Run with: node --test tests/messages-pane-drop.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const pane = () => loadTsx('frontend/src/features/messages/pane-drop.ts');

const file = (name) => ({ name, size: 10, type: 'image/png' });

test('a drop on a scope with a composer calls it, and reports it took the files', () => {
  const { registerComposerDrop, dropOnComposer } = pane();
  const seen = [];
  const off = registerComposerDrop(7, (files) => seen.push(files));
  const files = [file('a.png')];
  assert.equal(dropOnComposer(7, files), true);
  assert.deepEqual(seen, [files]);
  off();
});

test('a drop with no composer for that scope is refused', () => {
  const { dropOnComposer } = pane();
  assert.equal(dropOnComposer(99, [file('a.png')]), false);
});

test('a reply thread is its own zone, apart from the conversation beside it', () => {
  const { registerComposerDrop, dropOnComposer } = pane();
  const seen = [];
  registerComposerDrop(7, () => seen.push('chat'));
  registerComposerDrop('7:t42', () => seen.push('thread'));
  assert.equal(dropOnComposer('7:t42', []), true);
  assert.deepEqual(seen, ['thread'], 'the thread beside the chat takes it, not the chat');
});

test('a stale unregister leaves the newer composer in place', () => {
  const { registerComposerDrop, dropOnComposer } = pane();
  const seen = [];
  const off = registerComposerDrop(7, () => seen.push('old'));
  registerComposerDrop(7, () => seen.push('new'));
  off();
  assert.equal(dropOnComposer(7, []), true);
  assert.deepEqual(seen, ['new'], 'the newer registration survives the older one cleaning up');
});

test('readiness follows the registration', () => {
  const { registerComposerDrop, composerDropReady } = pane();
  assert.equal(composerDropReady(7), false, 'no box drawn yet: the pane shows no outline');
  const off = registerComposerDrop(7, () => {});
  assert.equal(composerDropReady(7), true);
  off();
  assert.equal(composerDropReady(7), false);
});
