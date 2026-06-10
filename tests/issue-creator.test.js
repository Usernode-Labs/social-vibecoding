// Tests for creatorFromSourceLine() in src/routes/issues.js (#136).
//
// Platform-filed GitHub issues are authored by the bot account
// ("usernode-bot"); the real creator lives in the body's first
// "**Source:**" line written by routes/feedback.js. The helper must
// recognize both forms that route writes:
//   - "**Source:** usernode user (name)"  -> "name"
//   - "**Source:** usernode admin"        -> "admin"
// and return null for anything else so callers can fall back to the
// GitHub login (for issues opened directly on GitHub).
//
// Run with: node --test tests/issue-creator.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { creatorFromSourceLine } = require('../src/routes/issues');

test('parses the "usernode user (name)" form', () => {
  assert.equal(
    creatorFromSourceLine('**Source:** usernode user (banditiaeja)\n\nPlease add a thing.'),
    'banditiaeja'
  );
});

test('parses usernames containing spaces and dots', () => {
  assert.equal(
    creatorFromSourceLine('**Source:** usernode user (iqiyi.)\n\nbody'),
    'iqiyi.'
  );
});

test('parses the "usernode admin" form as "admin"', () => {
  assert.equal(
    creatorFromSourceLine('**Source:** usernode admin\n\nuse name of creator of issue'),
    'admin'
  );
});

test('handles the app-feedback body shape (App line after Source)', () => {
  assert.equal(
    creatorFromSourceLine('**Source:** usernode user (Evan2)\n**App:** My App (my-app)\n\ndetails'),
    'Evan2'
  );
});

test('returns null when there is no Source line', () => {
  assert.equal(creatorFromSourceLine('Just a plain GitHub-filed issue body.'), null);
});

test('returns null for an unrecognized Source value', () => {
  assert.equal(creatorFromSourceLine('**Source:** github\n\nbody'), null);
});

test('returns null for non-string bodies', () => {
  assert.equal(creatorFromSourceLine(null), null);
  assert.equal(creatorFromSourceLine(undefined), null);
  assert.equal(creatorFromSourceLine(123), null);
});

test('does not treat "usernode administrator" as admin', () => {
  // \b after "admin" — "administrator" is a different word, not the
  // admin marker feedback.js writes.
  assert.equal(creatorFromSourceLine('**Source:** usernode administrator\n\nbody'), null);
});
