// Source guards for #233: the spec viewer is one global state slot
// (DevChat.specViewer), so switching dev sessions must reset it or the
// previous session's spec leaks into the new session's panel.
//
// Two guards, mirroring the fix's two layers:
//   1. openSession() resets the slot (via _resetSpecViewer) when the
//      session id changes, BEFORE the _readSpecViewerOpen restore
//      branch — ordering is what makes the restore start from a clean
//      slate instead of stale content.
//   2. _renderSpecViewer() fails closed on a session mismatch: if
//      specViewer.sessionId doesn't match currentSession.id, it renders
//      nothing rather than another session's spec.
//
// Same coarse source-guard style as tests/spec-sections.test.js layer 2:
// dev-chat.js is a plain browser script (no module.exports), so we
// assert on stable tokens in the source instead of executing it.
//
// Run with: node --test tests/spec-viewer-session-reset.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const devChatSrc = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

// Slice out a top-level method body by name. Coarse but stable: starts
// at the method's `name(` declaration and ends at the next method
// declaration sharing the object-literal indentation. Enough precision
// for token-presence + ordering assertions.
function methodSource(name) {
  const startRe = new RegExp(`\\n  (?:async )?${name}\\(`);
  const startMatch = devChatSrc.match(startRe);
  assert.ok(startMatch, `method ${name} not found in dev-chat.js`);
  const start = startMatch.index;
  const rest = devChatSrc.slice(start + startMatch[0].length);
  const endMatch = rest.match(/\n  (?:async )?[_A-Za-z][\w]*\((?:[^)]*)\)\s*\{/);
  const end = endMatch ? start + startMatch[0].length + endMatch.index : devChatSrc.length;
  return devChatSrc.slice(start, end);
}

test('openSession resets the spec viewer on session change', () => {
  const src = methodSource('openSession');
  assert.ok(src.includes('_resetSpecViewer()'),
    'openSession must call _resetSpecViewer when the session id changes (#233)');
  // Number-compare both sides: openSession gets a string id from DOM
  // datasets while openSpecViewer stores currentSession.id (a number).
  assert.ok(/Number\(DevChat\.specViewer\.sessionId\)\s*!==\s*Number\(sessionId\)/.test(src),
    'session-change check must Number-compare specViewer.sessionId against the new sessionId');
});

test('openSession resets BEFORE the localStorage restore branch', () => {
  const src = methodSource('openSession');
  const resetIdx = src.indexOf('_resetSpecViewer()');
  const restoreIdx = src.indexOf('_readSpecViewerOpen(');
  assert.ok(resetIdx !== -1, 'reset call missing from openSession');
  assert.ok(restoreIdx !== -1, 'restore branch missing from openSession');
  assert.ok(resetIdx < restoreIdx,
    'the session-change reset must run before the _readSpecViewerOpen restore branch');
});

test('_renderSpecViewer fails closed on a session mismatch', () => {
  const src = methodSource('_renderSpecViewer');
  assert.ok(/specViewer\.sessionId[\s\S]{0,200}currentSession\.id/.test(src),
    '_renderSpecViewer must compare specViewer.sessionId against currentSession.id and bail on mismatch');
});
