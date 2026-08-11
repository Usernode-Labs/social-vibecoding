// Frontend tests for sync-with-main timeline rendering (issue: make
// sync emit session-native activity).
//
// renderMessages() in public/js/dev-chat.js attaches a "Claude Code
// progress" row to the nearest preceding status line ONLY when that
// line matches ACTIVE_CC_STATUS_RE — otherwise the progress log renders
// as an orphan grey box. For a sync turn to read like a normal coding
// action, the opening "Syncing with main…" status must match that
// regex so its progressLog renders as the attached collapsible.
//
// We extract the REAL regex from the shipped source (so the test can't
// drift from what renders) and exercise the pairing logic against
// fixtures shaped exactly like the rows the service now emits.
//
// Run with: node --test tests/sync-activity-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

// Pull the literal ACTIVE_CC_STATUS_RE out of the source and rebuild it,
// so we test the exact pattern that ships.
function extractActiveStatusRe() {
  const m = SRC.match(/ACTIVE_CC_STATUS_RE\s*=\s*(\/.+?\/[a-z]*)\s*;/s);
  assert.ok(m, 'ACTIVE_CC_STATUS_RE literal found in dev-chat.js');
  // m[1] is e.g. "/^(...)/i"
  const lastSlash = m[1].lastIndexOf('/');
  const body = m[1].slice(1, lastSlash);
  const flags = m[1].slice(lastSlash + 1);
  return new RegExp(body, flags);
}

const ACTIVE_CC_STATUS_RE = extractActiveStatusRe();

// Mirror of renderMessages' pairing: for each progressLog row, walk
// backward to the nearest pairable system status line. A row that
// already carries its own artefact, or matches no regex, is skipped.
function pairProgressRows(messages) {
  const isPairableStatus = (s) => {
    if (s.role !== 'system') return null;
    if (s.progressLog) return false;
    if (s.ccLog || s.ccOutput || s.stagingUrl || s.specPreview) return false;
    return ACTIVE_CC_STATUS_RE.test(String(s.content || ''));
  };
  const pairs = new Map(); // progress index -> status index
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'system' || !messages[i].progressLog) continue;
    for (let j = i - 1; j >= 0; j--) {
      const verdict = isPairableStatus(messages[j]);
      if (verdict === null) break; // hit a non-system row
      if (verdict === true) { pairs.set(i, j); break; }
    }
  }
  return pairs;
}

test('ACTIVE_CC_STATUS_RE matches the sync opening status (and keeps build/scout)', () => {
  assert.match('Syncing with main…', ACTIVE_CC_STATUS_RE);
  assert.match('Claude Code is running...', ACTIVE_CC_STATUS_RE);
  assert.match('Codex is running...', ACTIVE_CC_STATUS_RE);
  assert.match('Scout reading the codebase', ACTIVE_CC_STATUS_RE);
  // The terminal outcome line must NOT be treated as an active CC status,
  // or the progress log would attach to the wrong (later) row.
  assert.doesNotMatch('Merged main cleanly. Pushed abc1234.', ACTIVE_CC_STATUS_RE);
  assert.doesNotMatch('Already up to date with main — nothing to merge.', ACTIVE_CC_STATUS_RE);
});

test('a sync activity reload pairs the progress log with its opening status, not the terminal', () => {
  // Rows exactly as the service persists them on a clean sync.
  const messages = [
    { role: 'user', content: 'do work' },
    { role: 'system', content: 'Syncing with main…', metadata: {} },
    { role: 'system', content: 'Claude Code progress',
      progressLog: ['Fetching main…', 'Merging origin/main…', 'Pushing…'] },
    { role: 'system', content: 'Merged main cleanly. Pushed abc1234.',
      syncMain: { syncResult: 'clean', behind: 2, sha: 'abc1234', pushOk: true } },
  ];

  const pairs = pairProgressRows(messages);
  assert.equal(pairs.size, 1, 'the progress row is paired, not orphaned');
  assert.equal(pairs.get(2), 1, 'progress row [2] attaches to the opening "Syncing with main…" row [1]');
});
