// The single definition of "which approvals describe the code under review".
// Every tally in the platform — the /promoted serializer, the merge queue's
// candidate select, the governance gate, the stale sweeper — is built on these
// fragments, so a mismatch here silently hides votes that must count.
//
// #2038 changed the key from a COMMIT to an EPOCH. The reason is the whole
// point of the change: the platform's own "bring it up to date with main"
// changes the commit without changing the work under review, and no property
// of a commit can prove which of those two happened — a merge whose first
// parent is the reviewed sha is trivial to forge. An epoch is not derived from
// the branch at all, so it cannot be forged; it moves when, and only when, the
// platform decides somebody wrote bytes nobody had approved.
//
// #2038 also claimed its migration changed no tally in either direction. That
// was wrong, and #2050 corrects it: the old predicate counted every vote on a
// session with NO reviewed head, this backfill kept only its other half, and
// every rename PR and staging fixture silently fell to a zero tally. The
// backfill in schema.sql now reproduces the old rule whole.

const test = require('node:test');
const assert = require('node:assert/strict');

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

test('a vote counts while its epoch matches the proposal it was cast on', () => {
  assert.equal(currentVotePredicateSql(), '(pv.approval_epoch = cs.approval_epoch)');
  assert.equal(
    currentVotePredicateSql('v', 's'),
    '(v.approval_epoch = s.approval_epoch)'
  );
});

test('a NULL vote epoch never counts — the property, and its cost', () => {
  // Votes that were stale under the old commit rule were backfilled to NULL
  // and votes that were counting were backfilled to 0. SQL's NULL semantics
  // then carry both cases across untouched: NULL = 0 is NULL, not true, so a
  // stale vote stays uncounted without anything having to delete it.
  //
  // The same property has a sharp edge this file once described as a free
  // win, and #2050 is the bill: an equality against a nullable column also
  // means an INSERT that OMITS the column writes a vote that can never count
  // — which thirteen of the fifteen INSERT INTO pr_votes statements did. The
  // read side is not the place to fix it, because weakening this predicate
  // would resurrect genuinely stale votes. schema.sql's
  // pr_votes_stamp_approval_epoch trigger fills the column on the way in, and
  // tests/pr-vote-epoch-postgres.test.js owns that half.
  assert.match(currentVotePredicateSql(), /approval_epoch = /,
    'the predicate must be an equality, so NULL propagates rather than matching');
  assert.doesNotMatch(currentVotePredicateSql(), /IS NOT DISTINCT FROM/,
    'IS NOT DISTINCT FROM would make two NULLs match and resurrect stale votes');
});

test('the predicate no longer depends on the commit, so a sync cannot clear a tally', () => {
  const sql = currentVotePredicateSql();
  assert.doesNotMatch(sql, /head_sha/,
    'a tally that keys on the commit loses every vote each time main is merged in — #2038 F1');
});

test('the reviewed head is still recorded, and still picks the right column', () => {
  // It no longer decides whether a vote counts, but it is what the exact-sha
  // merge pins to and what the head-move classifier compares against.
  const sql = reviewedHeadSql('cs');
  assert.match(sql, /imported_pr_head_sha/);
  assert.match(sql, /reviewed_head_sha/);
});

test('aliases are validated before being interpolated into SQL', () => {
  assert.throws(() => currentVotePredicateSql('pv; DROP TABLE pr_votes --', 'cs'),
    /Invalid SQL alias/);
  assert.throws(() => reviewedHeadSql('cs; SELECT 1'), /Invalid SQL alias/);
});

test('head comparison stays case-insensitive', () => {
  // Every writer lands a lower-case sha, but one upper-case character would
  // make an IDENTICAL commit read as a different revision (#955).
  assert.equal(sameSha('ABCDEF', 'abcdef'), true);
  assert.equal(sameSha('abcdef', 'abcdee'), false);
  assert.equal(sameSha(null, 'abcdef'), false);
});
