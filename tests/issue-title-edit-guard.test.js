// Tests for the #665 repaint guard behind the inline issue-title editor:
// AppView._titleEditBlocksRepaint (public/js/app-view.js), the pure
// predicate _renderTopicHead consults before rewriting #gc-thread-head's
// innerHTML. While the editor is open on the mounted issue topic, the
// WS/poll-driven refresh cycle must NOT repaint the header (it would
// destroy the editor and any typed text); every other combination must
// let the repaint proceed so the header can't freeze.
//
// app-view.js is a browser script with a CommonJS export guard, so
// requiring it in node returns the AppView object and the pure helper
// runs without a DOM — same style as tests/dev-feed-scroll-memory.test.js.
//
// Run with: node --test tests/issue-title-edit-guard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const AppView = require('../public/js/app-view.js');

const blocks = (topic, editing, inDom) =>
  AppView._titleEditBlocksRepaint(topic, editing, inDom);

test('blocks when the mounted issue topic is being edited and the editor is in the DOM', () => {
  assert.equal(blocks({ kind: 'issue', id: 42 }, 42, true), true);
});

test('does not block for non-issue topic kinds', () => {
  for (const kind of ['proposal', 'gov', 'session']) {
    assert.equal(blocks({ kind, id: 42 }, 42, true), false);
  }
});

test('does not block when the editing number does not match the topic id', () => {
  assert.equal(blocks({ kind: 'issue', id: 42 }, 7, true), false);
});

test('does not block when no edit is in progress (flag cleared)', () => {
  assert.equal(blocks({ kind: 'issue', id: 42 }, null, true), false);
  assert.equal(blocks({ kind: 'issue', id: 42 }, undefined, true), false);
});

test('does not block when the editor element is gone from the DOM (self-healing)', () => {
  assert.equal(blocks({ kind: 'issue', id: 42 }, 42, false), false);
});

test('does not block without a mounted topic', () => {
  assert.equal(blocks(null, 42, true), false);
  assert.equal(blocks(undefined, 42, true), false);
});

test('comparison is strict — a string flag never matches a numeric topic id', () => {
  assert.equal(blocks({ kind: 'issue', id: 42 }, '42', true), false);
});

test('flag lifecycle: begin sets, cancel clears and repaints via the guard-free path', () => {
  // The DOM-dependent begin/save paths need a browser; here we assert the
  // flag default and that cancelIssueTitleEdit clears it BEFORE repainting
  // (the repaint itself no-ops in node — no document — via _renderTopicHead's
  // own early returns... which need `document`, so stub the lookup).
  assert.equal(AppView._editingIssueTitle, null);
  AppView._editingIssueTitle = 42;
  global.document = { getElementById: () => null, querySelector: () => null };
  try {
    AppView.cancelIssueTitleEdit();
  } finally {
    delete global.document;
  }
  assert.equal(AppView._editingIssueTitle, null);
});
