// Tests for src/services/github.js's request reads: the board
// (fetchPublicIssues, refreshPublicIssues), one request (fetchPublicIssue),
// its comments (fetchIssueComments), and the clipping helpers the agent
// surfaces use (truncateIssueBodies, clipIssueComments).
//
// Until 26 Oct 2026 requests were GitHub issues, and this file pinned the
// in-memory cache in front of GitHub's issue API: the 5-minute list cache,
// the #125 seeding and #192 overlay of a just-created issue, the #144
// suppression of a just-closed one, the #2261 stale fallback and back-off,
// the ETag revalidation, the single-issue cache, and the Link-header paging
// of comment threads. GitHub suspended the account that filed every request;
// requests are rows now (services/requests.js), github.js's helpers are a
// facade over them, and a board is a query. None of that machinery exists,
// so its cases are gone; what each pinned is stated below as what holds now.
// services/requests.js itself (shapes, ordering, notes, numbering) is pinned
// against PostgreSQL in tests/requests-postgres.test.js.
//
// Run with: node --test tests/github-issues-cache.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const github = require('../src/services/github');
const requests = require('../src/services/requests');
const { installFakeRequests } = require('./helpers/fake-requests');

/** Swap one of services/requests.js's functions for the length of `t`. */
function stubRequests(t, name, fn) {
  const real = requests[name];
  requests[name] = fn;
  t.after(() => { requests[name] = real; });
}

/** Nothing here may reach GitHub: requests are not there any more. */
function refuseGithub(t) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); throw new Error(`unexpected fetch ${url}`); };
  t.after(() => { global.fetch = real; });
  return calls;
}

// ── A filed request is on the board at once ─────────────────────────────
// Was: noteIssueCreated seeded the cached list (#125) and kept an overlay
// (#192) so a just-created issue showed before GitHub's list had it, keyed
// case-insensitively, deduped by number, surviving the stale fallbacks and
// expiring after a TTL. Now the board is read from the rows each time.

test('a request filed through createIssue is on the next board read and single read, nothing recorded', async (t) => {
  installFakeRequests(t, { 'o/r': [{ number: 1, title: 'older', updatedAt: '2026-06-09T00:00:00Z' }] });
  const calls = refuseGithub(t);
  const created = await github.createIssue('o', 'r', { title: 'just filed', body: 'what it says', labels: ['usernode'] });
  assert.strictEqual(created.number, 2);

  const board = await github.fetchPublicIssues('o', 'r');
  assert.deepStrictEqual(board.issues.map((i) => i.number), [2, 1], 'newest first, at once');
  const one = await github.fetchPublicIssue('o', 'r', 2);
  assert.strictEqual(one.issue.title, 'just filed');
  assert.deepStrictEqual(calls, [], 'without asking GitHub');
});

// ── A closed request leaves the board at once ───────────────────────────
// Was: noteIssuesClosed suppressed a just-closed issue from cached AND
// fresh lists (#144), until unsuppressIssues or a TTL brought it back. Now
// closing the row is what takes it off, and reopening it puts it back.

test('a request closed through closeIssue is off the next board read; reopened, it is back', async (t) => {
  installFakeRequests(t, { 'o/r': [{ number: 1, title: 'one' }, { number: 2, title: 'two' }] });
  refuseGithub(t);
  await github.closeIssue('o', 'r', 2);
  assert.deepStrictEqual((await github.fetchPublicIssues('o', 'r')).issues.map((i) => i.number), [1]);
  const closed = await github.fetchPublicIssue('o', 'r', 2);
  assert.strictEqual(closed.issue.state, 'closed', 'still readable by its address');
  await github.reopenIssue('o', 'r', 2);
  assert.deepStrictEqual((await github.fetchPublicIssues('o', 'r')).issues.map((i) => i.number).sort(), [1, 2]);
});

// ── The board read ──────────────────────────────────────────────────────

// #158: the web route / "Create PR" seeding needs the whole text; the agent
// surfaces clip via truncateIssueBodies instead.
test('fetchPublicIssues keeps the full issue body untruncated (#158)', async (t) => {
  const longBody = 'x'.repeat(5000);
  installFakeRequests(t, { 'FullOwner/full-repo': [{ number: 20, title: 'verbose', body: longBody }] });
  const res = await github.fetchPublicIssues('FullOwner', 'full-repo');
  assert.strictEqual(res.issues[0].body, longBody);
});

test('fetchPublicIssues hands back the store\'s answer for owner and repo as given', async (t) => {
  const asked = [];
  stubRequests(t, 'listOpen', async (owner, repo) => {
    asked.push([owner, repo]);
    return { issues: [{ number: 3 }], truncatedList: true };
  });
  assert.deepStrictEqual(await github.fetchPublicIssues('Some', 'Repo.git'), { issues: [{ number: 3 }], truncatedList: true });
  assert.deepStrictEqual(asked, [['Some', 'Repo.git']]);
});

// Was #2261: a refused refetch served the last list flagged `stale`, and
// later reads backed off (5xx, network errors, secondary and primary rate
// limits, invalidation, closed issues hidden from the fallback). There is
// no last list now: every read is the store's, and a failed one is an
// empty list with a note, never thrown, and never remembered.
test('a failed board read is an empty list with a note, never stale, and the next read asks again', async (t) => {
  let fail = true;
  let reads = 0;
  stubRequests(t, 'listOpen', async () => {
    reads += 1;
    if (fail) throw new Error('connection refused');
    return { issues: [{ number: 1 }], truncatedList: false };
  });
  assert.deepStrictEqual(await github.fetchPublicIssues('o', 'r'), { issues: [], truncatedList: false, note: 'fetch failed' });
  fail = false;
  assert.deepStrictEqual(await github.fetchPublicIssues('o', 'r'), { issues: [{ number: 1 }], truncatedList: false });
  assert.strictEqual(reads, 2, 'no back-off: the second read was asked for');
});

// Was: refreshPublicIssues bypassed the TTL, then a 60-second cooldown
// served the cache with a retry hint. A read is always current now.
test('refreshPublicIssues is a fresh read every time, with no cooldown', async (t) => {
  installFakeRequests(t, { 'RefOwner/ref-repo': [{ number: 1, title: 'v1' }] });
  const first = await github.refreshPublicIssues('RefOwner', 'ref-repo');
  assert.strictEqual(first.refreshed, true);
  assert.strictEqual(first.retryInMs, 0);
  await github.createIssue('RefOwner', 'ref-repo', { title: 'created since' });
  const second = await github.refreshPublicIssues('RefOwner', 'ref-repo');
  assert.strictEqual(second.refreshed, true, 'never throttled');
  assert.strictEqual(second.retryInMs, 0);
  assert.deepStrictEqual(second.issues.map((i) => i.number), [2, 1]);
});

// The ETag cases (a one-page list kept its ETag, a 304 was free, several
// pages kept none, If-None-Match on the installation and bot-token reads,
// invalidation and seeding dropped it) went with the GitHub list read:
// the board is read from PostgreSQL.

test('truncateIssueBodies clips long bodies at 500 chars with an explicit marker, leaving short ones alone', () => {
  const longBody = 'y'.repeat(5000);
  const input = {
    issues: [
      { number: 1, title: 'long', body: longBody },
      { number: 2, title: 'short', body: 'short body' },
    ],
    truncatedList: false,
  };
  const out = github.truncateIssueBodies(input);
  // Default marker names the Mayor's get_github_issue tool with the
  // issue's own number, so the agent knows the cut happened and how to
  // get the rest.
  assert.strictEqual(
    out.issues[0].body,
    `${'y'.repeat(500)}… [truncated — use get_github_issue(1) for full text]`
  );
  assert.strictEqual(out.issues[1].body, 'short body');
  assert.strictEqual(out.truncatedList, false);
  // Must not mutate the input — it may be the shared cache entry.
  assert.strictEqual(input.issues[0].body, longBody);
});

test('truncateIssueBodies accepts a surface-specific full-text hint (worker CLI form)', () => {
  const out = github.truncateIssueBodies(
    { issues: [{ number: 42, title: 'long', body: 'z'.repeat(501) }], truncatedList: false },
    (n) => `usernode-issues ${n}`
  );
  assert.strictEqual(
    out.issues[0].body,
    `${'z'.repeat(500)}… [truncated — use usernode-issues 42 for full text]`
  );
});

test('truncateIssueBodies passes through degenerate inputs', () => {
  assert.strictEqual(github.truncateIssueBodies(null), null);
  const noIssues = { truncatedList: false, note: 'no repo' };
  assert.strictEqual(github.truncateIssueBodies(noIssues), noIssues);
});

// ── One request ─────────────────────────────────────────────────────────
// #158/#2365: fetchPublicIssue backs the Mayor's get_github_issue tool,
// `usernode-issues <number>` and the single-issue route, open or closed.
// Was: it served an open issue from the list cache, kept a single-issue
// cache (and a minute-long memory of a failed read, forgotten on a merge),
// shared one GitHub read between two callers at once, asked GitHub with
// { fresh: true }, and mapped GitHub's 404 / pull-request / rate-limit
// answers. Each read is the store's now; its notes ('not found', 'not an
// issue (pull request)', 'bad issue number') and the row's shape are
// requests.getOne's, pinned in tests/requests-postgres.test.js.

test('fetchPublicIssue reads one request, open or closed, full body intact, from the store each time', async (t) => {
  const longBody = 'w'.repeat(3000);
  const fake = installFakeRequests(t, { 'OneOwner/one-repo': [
    { number: 30, title: 'open one', body: longBody },
    { number: 31, title: 'closed one', state: 'closed', closedAt: '2026-06-09T00:00:00Z' },
  ] });
  refuseGithub(t);
  const res = await github.fetchPublicIssue('OneOwner', 'one-repo', 30);
  assert.strictEqual(res.issue.number, 30);
  assert.strictEqual(res.issue.body, longBody);
  assert.strictEqual(res.note, undefined);
  const closed = await github.fetchPublicIssue('OneOwner', 'one-repo', 31);
  assert.strictEqual(closed.issue.state, 'closed');
  assert.strictEqual(closed.issue.closedAt, '2026-06-09T00:00:00Z');
  await github.fetchPublicIssue('OneOwner', 'one-repo', 30);
  assert.strictEqual(fake.reads.filter((r) => r.fn === 'getOne').length, 3, 'nothing is remembered between reads');
});

test('fetchPublicIssue passes the store\'s notes through, and a failed read is a note, never a throw', async (t) => {
  let answer = { issue: null, note: 'not an issue (pull request)' };
  stubRequests(t, 'getOne', async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  assert.deepStrictEqual(await github.fetchPublicIssue('o', 'r', 7), { issue: null, note: 'not an issue (pull request)' });
  answer = new Error('connection refused');
  assert.deepStrictEqual(await github.fetchPublicIssue('o', 'r', 7), { issue: null, note: 'fetch failed' });
});

// ── #396: comment threads ───────────────────────────────────────────────
// Was: fetchIssueComments followed GitHub's Link pages oldest-first up to
// ISSUE_COMMENTS_MAX_PAGES and mapped rate limits and 404s to notes. Now a
// thread is the request's rows (request_comments), read in one query with
// the same `max` and `since`; clipIssueComments keeps the most-recent N and
// clips long bodies.

test('fetchIssueComments asks the store for the thread, with its ceiling and since', async (t) => {
  const asked = [];
  stubRequests(t, 'comments', async (owner, repo, n, opts) => {
    asked.push({ owner, repo, n, opts });
    return { comments: [{ author: 'a', body: 'b', createdAt: '2026-06-02T00:00:00Z', id: 1 }], truncated: true };
  });
  const res = await github.fetchIssueComments('O', 'r', 9, { since: '2026-10-07T09:50:00.000Z' });
  assert.deepStrictEqual(res, { comments: [{ author: 'a', body: 'b', createdAt: '2026-06-02T00:00:00Z', id: 1 }], truncated: true });
  assert.strictEqual(asked[0].n, 9);
  assert.strictEqual(asked[0].opts.since, '2026-10-07T09:50:00.000Z');
  assert.ok(asked[0].opts.max >= 300, 'the same page ceiling as before');
  await github.fetchIssueComments('O', 'r', 9);
  assert.strictEqual(asked[1].opts.since, null, 'no since unless given one');
});

test('fetchIssueComments returns a short thread without truncation', async (t) => {
  const fake = installFakeRequests(t, { 'O/r': [{ number: 8, title: 'x' }] });
  fake.setComments('O', 'r', 8, [1, 2, 3].map((k) => ({ author: `commenter-${k}`, body: `comment ${k}`, createdAt: `2026-06-0${k}T00:00:00Z` })));
  const res = await github.fetchIssueComments('O', 'r', 8);
  assert.strictEqual(res.comments.length, 3);
  assert.strictEqual(res.comments[0].author, 'commenter-1', 'oldest first');
  assert.strictEqual(res.truncated, false);
});

test('#3693: fetchIssueComments carries the comment id, and clipIssueComments does not', async (t) => {
  // The id is what the Homeroom bot recorded for each comment it posted
  // (homeroom_bot_posts.github_comment_id), so the request page can leave
  // out the ones its Homeroom thread already shows. The clipped thread the
  // UI and the models read keeps its three fields.
  const fake = installFakeRequests(t, { 'O/r': [{ number: 9, title: 'x' }] });
  fake.setComments('O', 'r', 9, [
    { id: 2950123456, author: 'commenter-1', body: 'comment 1', createdAt: '2026-06-02T00:00:00Z' },
    { id: 2950123457, author: 'commenter-2', body: 'comment 2', createdAt: '2026-06-03T00:00:00Z' },
  ]);
  const res = await github.fetchIssueComments('O', 'r', 9);
  assert.deepStrictEqual(res.comments[0], {
    author: 'commenter-1', body: 'comment 1', createdAt: '2026-06-02T00:00:00Z', id: 2950123456,
  });
  const clipped = github.clipIssueComments(res.comments);
  assert.deepStrictEqual(Object.keys(clipped.comments[0]).sort(), ['author', 'body', 'createdAt']);
});

test('fetchIssueComments maps a failed read to an empty thread with a note, never a throw', async (t) => {
  stubRequests(t, 'comments', async () => { throw new Error('connection refused'); });
  assert.deepStrictEqual(
    await github.fetchIssueComments('O', 'r', 1),
    { comments: [], truncated: false, note: 'fetch failed' }
  );
});

test('clipIssueComments keeps the most-recent max, clips long bodies, and flags truncation', () => {
  const comments = Array.from({ length: 40 }, (_, k) => ({
    author: `u${k}`, body: 'x'.repeat(k === 39 ? 5000 : 10), createdAt: `2026-06-01T00:00:0${k % 10}Z`,
  }));
  const { comments: kept, truncated } = github.clipIssueComments(comments, { max: 30, bodyMax: 2000 });
  assert.strictEqual(kept.length, 30, 'keeps at most max');
  assert.strictEqual(kept[0].author, 'u10', 'keeps the TAIL (most recent)');
  assert.strictEqual(truncated, true, 'older comments were dropped');
  // The long last body is clipped with the marker.
  const last = kept[kept.length - 1];
  assert.ok(last.body.endsWith('… [truncated]'));
  assert.ok(last.body.length <= 2000 + '… [truncated]'.length);
});

test('clipIssueComments carries through upstream truncation even under the keep cap', () => {
  const { truncated } = github.clipIssueComments(
    [{ author: 'a', body: 'short', createdAt: '' }],
    { max: 30, wasTruncated: true }
  );
  assert.strictEqual(truncated, true);
});

test('clipIssueComments on an empty/absent thread is a clean no-op', () => {
  assert.deepStrictEqual(github.clipIssueComments([]), { comments: [], truncated: false });
  assert.deepStrictEqual(github.clipIssueComments(undefined), { comments: [], truncated: false });
});
