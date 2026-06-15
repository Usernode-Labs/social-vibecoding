// Tests for shouldCreateGithubTwin() in src/routes/issues.js (#132).
//
// Env-var change proposals (kind='secret_change') must NOT spawn a
// GitHub issue on the app's repo — they're in-app governance (proposed,
// voted, applied, and audited on the platform), and GitHub issues are
// reserved for real issues. Regular issues keep their GitHub twin.
//
// The skipped twin leaves github_issue_number NULL on the issues row.
// No apply-path test is needed for that: maybeApplySecretChangeProposal
// guards its entire GitHub close/comment block on
// `if (locked.github_issue_number)` (src/routes/issues.js), so a null
// number means no GitHub call is ever attempted — the same path already
// exercised whenever github.isEnabled() is false (local dev) or the app
// has no repo_url.
//
// Run with: node --test tests/issue-github-twin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldCreateGithubTwin } = require('../src/routes/issues');

test('secret_change proposals get no GitHub twin', () => {
  assert.equal(shouldCreateGithubTwin('secret_change'), false);
});

test('general issues keep their GitHub twin', () => {
  assert.equal(shouldCreateGithubTwin('general'), true);
});

test('legacy rename issues are unaffected by the #132 skip', () => {
  // 'rename' is no longer a creatable kind (VALID_KINDS), but in-flight
  // rows from before the cutover still resolve through the same code —
  // the predicate only ever excludes secret_change.
  assert.equal(shouldCreateGithubTwin('rename'), true);
});
