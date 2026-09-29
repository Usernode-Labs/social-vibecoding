// #2391: the general Discussion's "Replying to …" strip, reworked.
//
// It shared the sent-quote block's rules — an 11/12px chip, 4px corners,
// capped at 560px — under a 22px-radius composer card, and a reply to a
// platform message (#2390) read "Replying to message". It now follows the
// Messages screen's reply draft, and its label names what it replies to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');
const rule = (sel) => {
  const m = css.match(new RegExp(`\\n${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`));
  assert.ok(m, sel);
  return m[1];
};

test('the strip is the Messages reply draft: full width, accent tint, open rounded edge', () => {
  const strip = rule('.gc-reply-preview-inner');
  assert.match(strip, /border-left: 3px solid var\(--accent\);/);
  assert.match(strip, /border-radius: 0 12px 12px 0;/);
  assert.match(strip, /background: var\(--accent-tint\);/);
  assert.doesNotMatch(strip, /max-width/, 'spans the composer, not capped at 560px');
  assert.match(css, /\.messages-reply-draft \{[^}]*border-radius: 0 12px 12px 0;[^}]*background: var\(--accent-tint\);/,
    'the Messages screen draws its draft the same way');
});

test('its text is at the composer reading size, and its dismiss is a legible glyph', () => {
  assert.match(css, /\n\.gc-reply-preview-label \{ font-size: 13px; font-weight: 700; \}/);
  assert.match(css, /\n\.gc-reply-preview-snippet \{ font-size: 15px; \}/);
  assert.match(rule('.gc-reply-preview-x'), /font-size: 20px;/);
});

test('the sent quote keeps its compact in-transcript form', () => {
  const quoted = rule('.gc-quoted');
  assert.match(quoted, /border-radius: 4px;/);
  assert.match(quoted, /max-width: min\(560px, 100%\);/);
  assert.doesNotMatch(css, /\.gc-quoted,\s*\n\.gc-reply-preview-inner \{/, 'no longer one shared rule');
});

function labelFor(replyDraft) {
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' },
    document: { getElementById: () => null },
    App: { user: { id: 1 } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/group-chat.js'), 'utf8'), sandbox);
  const gc = sandbox.window.GroupChat;
  const published = [];
  gc._publishComposer = (scope, patch) => published.push(patch);
  gc.replyDraft = replyDraft;
  gc._renderQuotePreview();
  return published[0].quote && published[0].quote.label;
}

test('the label names what the reply is to', () => {
  assert.equal(labelFor({ source: 'message', author: 'alice', snippet: 'hi' }), '@alice');
  assert.equal(labelFor({ source: 'pr', prNumber: 12, snippet: 'x' }), 'PR #12');
  assert.equal(labelFor({ source: 'event', author: null, snippet: 'Proposed PR #12' }), 'a platform message');
  assert.equal(labelFor({ source: 'message', author: null, snippet: 'gone' }), 'a message');
});
