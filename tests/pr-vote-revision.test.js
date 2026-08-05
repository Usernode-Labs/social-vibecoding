// The single definition of "which approvals describe the code under review".
// Every tally in the platform — the /promoted serializer, the conflict-resolver
// drain, the governance gate, the stale sweeper — is built on these fragments,
// so a mismatch here silently hides votes that must count.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  reviewedHeadForSession,
  reviewedHeadSql,
  currentVotePredicateSql,
  sameSha,
} = require('../src/services/pr-vote-revision');

test('imported proposals keep their import head; native ones use the reviewed head', () => {
  assert.equal(
    reviewedHeadForSession({ source: 'imported', imported_pr_head_sha: 'a', reviewed_head_sha: 'b' }),
    'a'
  );
  assert.equal(reviewedHeadForSession({ source: null, reviewed_head_sha: 'b' }), 'b');
  assert.equal(reviewedHeadForSession(null), null);
});

test('an unpinned row keeps its historical unscoped tally', () => {
  assert.match(currentVotePredicateSql(), /IS NULL OR/,
    'legacy rows with no pin must not lose their votes to the predicate');
});

// #955: every writer lands a lower-case SHA today (GitHub reads, git
// rev-parse, the handoff normalizer) — but a single upper-case character
// anywhere would make an IDENTICAL commit read as a different revision and
// hide a live vote. Compare case-insensitively so "same SHA" is exact.
test('vote stamps are matched to the reviewed head case-insensitively', () => {
  const predicate = currentVotePredicateSql();
  assert.match(predicate, /LOWER\(pv\.head_sha\) = LOWER\(/);
  assert.ok(!/[^(]pv\.head_sha = /.test(predicate),
    'no raw case-sensitive comparison survives');
});

test('the SQL and JS comparisons agree on case', () => {
  assert.equal(sameSha('AbC', 'abc'), true);
  assert.equal(sameSha('abc', 'abd'), false);
  assert.equal(sameSha(null, 'abc'), false);
  assert.equal(sameSha('abc', undefined), false);
  assert.equal(sameSha(null, null), false, 'two unknown revisions are not "the same commit"');
});

test('aliases are validated before being interpolated into SQL', () => {
  assert.throws(() => reviewedHeadSql('cs; DROP TABLE pr_votes'), /Invalid SQL alias/);
  assert.throws(() => currentVotePredicateSql('pv)', 'cs'), /Invalid SQL alias/);
  assert.match(currentVotePredicateSql('v', 's'), /s\.reviewed_head_sha/);
});

test('schema carries the platform-push provenance ledger', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS session_platform_pushes/);
  assert.match(schema, /UNIQUE\(session_id, sha\)/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_session_platform_pushes_session/);
  assert.match(schema, /session_id\s+INTEGER REFERENCES chat_sessions\(id\) ON DELETE CASCADE/);
  assert.ok(!/COMMENT ON TABLE session_platform_pushes/.test(schema),
    'the ledger holds no user content and no credential, so it is not tagged '
    + 'staging:private; it still empties in a clone as an FK child of the '
    + 'private chat_sessions, exactly like pr_votes');
});
