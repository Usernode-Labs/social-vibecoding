// Updating a proposal that is already up for a vote (#1054).
//
// This is the one path on the platform where a user's work is pushed onto a
// BRANCH THEY DO NOT OWN, with the platform's own bot credential, over a head
// the group has already been voting on. Three properties make that safe, and
// they are what these tests are weighted towards:
//
//   1. NO USER GITHUB CREDENTIAL. The fork is read unauthenticated and the app
//      repository is written with the platform's credential, resolved by
//      services/external-agent-head.js. Nothing here holds a user token.
//   2. THE ATTRIBUTION GATE IS NEVER RELAXED. `verifyForkBranch` runs against a
//      FRESHLY READ `githubLink.linkStatus`, and there is no path from a
//      caller's arguments to a push that skips it — the source is asserted for
//      that, not just the behaviour, because a future edit that reorders the
//      calls would still pass a behavioural test that only checks the happy
//      path.
//   3. NOTHING IS CLOBBERED. The push's lease is pinned to the head this call
//      read from GitHub moments earlier, so a proposal somebody else advanced
//      produces `branch_moved` instead of a discarded revision. And a branch
//      that does not build on the reviewed head is refused with
//      `base_mismatch` rather than dropping reviewed commits.
//
// Run with: node --test tests/proposal-update.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../src/services/proposal-update');

const SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/proposal-update.js'), 'utf8'
);

// The same file with its `//` comments stripped. Several assertions below are
// about what the code does NOT do, and this file's header comment names those
// things in order to say it does not do them — asserting against the prose
// would fail on the very comment that documents the rule.
const CODE = SRC.replace(/^\s*\/\/.*$/gm, '');

// ── Fakes ──────────────────────────────────────────────────────────────

// A pool that dispatches on a substring of the SQL, so a test says what it
// expects to be asked rather than in which order.
function fakePool(handlers, queries = []) {
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, rows] of handlers) {
        if (sql.includes(needle)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      throw new Error(`unstubbed query: ${String(sql).slice(0, 90)}`);
    },
  };
}

const NATIVE_HEAD = 'a'.repeat(40);
const FORK_HEAD = 'b'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);

function nativeSession(over) {
  return Object.assign({
    id: 501,
    user_id: 7,
    app_id: 3,
    status: 'promoted',
    source: 'native',
    branch_name: 'dev/evan-1786376366569',
    pr_number: 42,
    pr_url: 'https://github.com/o/r/pull/42',
    app_slug: 'recipe-box',
    repo_url: 'https://github.com/o/r',
    reviewed_head_sha: NATIVE_HEAD,
  }, over);
}

function importedSession(over) {
  return Object.assign({
    id: 601,
    user_id: 7,
    app_id: 3,
    status: 'promoted',
    source: 'imported',
    branch_name: 'usernode/add-a-button',
    pr_number: 91,
    pr_url: 'https://github.com/o/r/pull/91',
    app_slug: 'recipe-box',
    repo_url: 'https://github.com/o/r',
    imported_pr_head_sha: NATIVE_HEAD,
  }, over);
}

const USER = { id: 7, username: 'evan' };

// Every dependency the service takes, stubbed at its happy value. A test
// overrides only the one it is about, so an assertion about `base_mismatch`
// cannot accidentally also be asserting how the fork is read.
function deps(over = {}, log = {}) {
  const session = over.session || nativeSession();
  const pool = over.pool || fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['FROM pr_votes', [{ n: 4 }]],
  ]);
  return {
    pool,
    config: {},
    gh: Object.assign({
      isEnabled: () => true,
      parseGithubUrl: () => ({ owner: 'o', repo: 'r' }),
      getBranchSha: async () => NATIVE_HEAD,
      compareCommitAncestry: async () => ({ status: 'ahead' }),
      getPR: async () => ({
        state: 'open',
        merged: false,
        html_url: 'https://github.com/o/r/pull/91',
        head: { ref: 'usernode/add-a-button', sha: FORK_HEAD, repo: { owner: { login: 'evan-gh' } } },
      }),
    }, over.gh),
    githubLink: Object.assign({
      isEnabled: () => true,
      linkStatus: async () => ({ linked: true, login: 'evan-gh' }),
    }, over.githubLink),
    head: Object.assign({
      validRef: (v) => typeof v === 'string' && v.length > 0 && !v.includes(' '),
      validSegment: (v) => /^[A-Za-z0-9._-]+$/.test(v),
      sameLogin: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
      verifyForkBranch: async (args) => {
        (log.verify = log.verify || []).push(args);
        return { ok: true, headSha: FORK_HEAD, forkRepo: args.forkRepo };
      },
      pushForkBranchToAppBranch: async (args) => {
        (log.push = log.push || []).push(args);
        return { ok: true, headSha: FORK_HEAD, credential: { source: 'bot' } };
      },
    }, over.head),
    votes: Object.assign({
      reconcileNativeReviewedHead: async (args) => {
        (log.reconcile = log.reconcile || []).push(args);
        return { updated: true };
      },
    }, over.votes),
    prImportSync: Object.assign({
      applyHeadChange: async (args) => {
        (log.applied = log.applied || []).push(args);
        return { ok: true };
      },
    }, over.prImportSync),
    githubPublic: over.githubPublic || { marker: 'public-reader' },
    // Both of these are real behaviours elsewhere; here they only have to be
    // observable, so a test can assert the update ran INSIDE them.
    serialize: over.serialize || (async (id, fn) => {
      (log.serialized = log.serialized || []).push(id);
      return fn();
    }),
    busy: over.busy || (() => false),
    beginOperation: over.beginOperation || ((id) => {
      (log.began = log.began || []).push(id);
      return () => { (log.released = log.released || []).push(id); };
    }),
  };
}

function run(over = {}, params = {}, log = {}) {
  const session = over.session || nativeSession();
  return svc.updateProposalFromForkBranch(deps(over, log), Object.assign({
    user: USER,
    session,
    branch: 'fix/failing-check',
    origin: 'https://usernode.test',
  }, params));
}

// ── 1. Branch home ─────────────────────────────────────────────────────

test('branch home is derived from source, and only an imported head is the author\'s to push', () => {
  assert.equal(svc.branchHomeOf(importedSession()), 'user_fork');
  assert.equal(svc.authorCanPush(importedSession()), true);
  // Every other source is a branch only the platform bot can write — which is
  // the whole reason this service exists.
  for (const source of ['native', 'headless', 'cli', 'platform', null, undefined, '']) {
    const session = nativeSession({ source });
    assert.equal(svc.branchHomeOf(session), 'app_repo', `source ${String(source)}`);
    assert.equal(svc.authorCanPush(session), false, `source ${String(source)}`);
  }
  // Not stored anywhere: a second column recording the same thing is a second
  // thing that can be wrong.
  assert.doesNotMatch(SRC, /branch_home/, 'branch home stays derived, never persisted');
});

// ── 2. Ownership and status ────────────────────────────────────────────

test('somebody else\'s proposal is refused before GitHub is touched', async () => {
  const log = {};
  const result = await run({ session: nativeSession({ user_id: 99 }) }, {}, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_your_proposal');
  assert.equal(result.retryable, false);
  assert.equal(log.verify, undefined, 'no fork read');
  assert.equal(log.push, undefined, 'and certainly no push');
});

test('a proposal that is no longer up for a vote cannot take a revision', async () => {
  for (const [status, fragment] of [
    ['merging', /already passed its vote/],
    ['merged', /already passed its vote/],
    ['closed', /cannot take a new revision/],
    ['building', /cannot take a new revision/],
  ]) {
    const log = {};
    const result = await run({ session: nativeSession({ status }) }, {}, log);
    assert.equal(result.ok, false, status);
    assert.equal(result.code, 'proposal_closed', status);
    assert.match(result.message, fragment, status);
    assert.equal(log.push, undefined, `${status} never reaches a push`);
  }
});

test('the ownership gate is applied a SECOND time under the lock, against the re-read row', async () => {
  // The caller's copy was loaded before the queue. This one merged while the
  // update waited — the interesting case, because the first gate passed.
  const log = {};
  const pool = fakePool([
    ['FROM chat_sessions cs JOIN apps a', [nativeSession({ status: 'merged' })]],
    ['FROM pr_votes', [{ n: 4 }]],
  ]);
  const result = await run({ pool }, {}, log);
  assert.equal(result.code, 'proposal_closed');
  assert.equal(log.push, undefined, 'nothing is pushed onto a proposal that merged while we queued');
  assert.deepEqual(log.serialized, [501], 'and it did get that far — the refusal is the re-read one');
});

// ── 3. The bot-owned branch: the happy path ────────────────────────────

test('an app-repo proposal is advanced with a lease pinned to the head just read', async () => {
  const log = {};
  const result = await run({}, {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.branchHome, 'app_repo');
  assert.equal(result.branch, 'dev/evan-1786376366569');
  assert.equal(result.headSha, FORK_HEAD);
  assert.equal(result.previousHeadSha, NATIVE_HEAD);
  assert.equal(result.submittedVia, 'update_branch');
  assert.equal(result.votesCleared, 4, 'counted BEFORE the write, reported after it settled');
  assert.equal(result.checksRerun, true);
  assert.equal(result.previewRebuilding, true);

  // The push: the target is the proposal's own branch and the lease is the
  // live head, never anything the caller supplied.
  assert.equal(log.push.length, 1);
  const pushed = log.push[0];
  assert.equal(pushed.targetBranch, 'dev/evan-1786376366569');
  assert.equal(pushed.expectedRemoteSha, NATIVE_HEAD);
  assert.equal(pushed.owner, 'o');
  assert.equal(pushed.repo, 'r');
  assert.equal(pushed.branch, 'fix/failing-check');
  assert.equal(pushed.sessionId, 501);

  // And the existing machinery — not a reimplementation of it — moved the
  // votes, with a fresh read rather than the stored pin.
  assert.equal(log.reconcile.length, 1);
  assert.equal(log.reconcile[0].fresh, true);
  assert.equal(log.reconcile[0].notify, true);
  assert.equal(log.reconcile[0].session.id, 501);
});

test('the update runs inside the session queue, the lock and a session operation', async () => {
  const log = {};
  await run({}, {}, log);
  assert.deepEqual(log.serialized, [501], 'serialized on the session, as the handoff pipeline is');
  assert.deepEqual(log.began, [501]);
  assert.deepEqual(log.released, [501], 'and released — a leaked operation marks the session busy forever');
});

test('the session operation is released even when the push fails', async () => {
  const log = {};
  const result = await run({
    head: { pushForkBranchToAppBranch: async () => ({ ok: false, code: 'platform_unavailable', message: 'boom', retryable: true }) },
  }, {}, log);
  assert.equal(result.ok, false);
  assert.deepEqual(log.released, [501]);
});

// ── 4. The attribution gate ────────────────────────────────────────────

test('the fork owner comes from the freshly-read link, never from the caller', async () => {
  const log = {};
  const reads = [];
  await run({
    githubLink: {
      isEnabled: () => true,
      linkStatus: async (pool, userId) => { reads.push(userId); return { linked: true, login: 'evan-gh' }; },
    },
  }, {
    // A caller trying to name somebody else's fork owner: there is no such
    // parameter, and `forkRepo` is only ever the repository's NAME.
    forkRepo: 'recipe-box-fork',
  }, log);
  assert.deepEqual(reads, [7], 'the link is read for THIS user, at update time');
  assert.equal(log.verify[0].forkOwner, 'evan-gh');
  assert.equal(log.verify[0].expectedLogin, 'evan-gh');
  assert.equal(log.verify[0].forkRepo, 'recipe-box-fork', 'only the name is the caller\'s to choose');
  assert.equal(log.push[0].forkOwner, 'evan-gh');
  assert.equal(log.push[0].expectedLogin, 'evan-gh');
});

test('a branch that is not in the author\'s own fork is refused, and nothing is pushed', async () => {
  const log = {};
  const result = await run({
    head: { verifyForkBranch: async () => ({ ok: false, code: 'fork_mismatch', message: 'internal wording' }) },
  }, {}, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_your_fork', 'renamed for what the CALLER did, not for the mirror path');
  assert.match(result.message, /owned by the GitHub account linked to your Usernode profile/);
  assert.equal(log.push, undefined);
});

test('a fork branch that does not exist yet says so, retryably', async () => {
  const result = await run({
    head: { verifyForkBranch: async () => ({ ok: false, code: 'branch_not_found', message: 'internal wording' }) },
  });
  assert.equal(result.code, 'fork_branch_not_found');
  assert.equal(result.retryable, true, 'they can push and try again — this is not a dead end');
  assert.match(result.message, /Push it first/);
});

test('the gate runs before the push in the source, and the push re-runs it itself', () => {
  // Behavioural tests cover the refusals; this covers the ORDER, which is the
  // property a reviewer is asked to confirm: there is no path from submit_work
  // to a push where verifyForkBranch did not run against a freshly-read
  // linkStatus.
  const linkRead = SRC.indexOf('githubLink.linkStatus(');
  const verify = SRC.indexOf('head.verifyForkBranch(');
  const push = SRC.indexOf('head.pushForkBranchToAppBranch(');
  assert.ok(linkRead > 0 && verify > linkRead, 'the link is read before the fork is verified');
  assert.ok(push > verify, 'and the fork is verified before anything is pushed');
  // Both fork-shaped arguments come from the verified link, textually.
  assert.match(SRC, /forkOwner: link\.login/);
  assert.match(SRC, /expectedLogin: link\.login/);
  // And the second, load-bearing run lives inside the head service.
  const HEAD_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/external-agent-head.js'), 'utf8'
  );
  const fn = HEAD_SRC.slice(HEAD_SRC.indexOf('async function pushForkBranchToAppBranch'));
  const body = fn.slice(0, fn.indexOf('\nmodule.exports'));
  assert.ok(body.indexOf('verifyForkBranch(') > 0, 'the push verifies the fork itself');
  assert.ok(
    body.indexOf('verifyForkBranch(') < body.indexOf('force-with-lease'),
    'and does so BEFORE it pushes'
  );
});

// ── 5. Nothing is clobbered ────────────────────────────────────────────

test('a proposal that moved since the caller read it is refused, with where it is now', async () => {
  const log = {};
  const result = await run({}, { expectedHeadSha: OTHER_HEAD }, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'branch_moved');
  assert.equal(result.headSha, NATIVE_HEAD, 'the caller is told the head it must rebase onto');
  assert.match(result.message, /rebase onto its current head/);
  assert.equal(log.push, undefined);
});

test('expectedHeadSha is OPTIONAL — a second update in a row is not refused for having moved', async () => {
  // The trap this avoids: pinning the expectation to the task's recorded base
  // would refuse every update after the first, because the proposal moved
  // for the author's OWN previous update. The lease still prevents a clobber.
  const log = {};
  const result = await run({}, { expectedHeadSha: undefined }, log);
  assert.equal(result.ok, true);
  assert.equal(log.push[0].expectedRemoteSha, NATIVE_HEAD, 'the lease is the live head either way');
});

test('a branch that does not build on the reviewed head is refused with the commit to rebase onto', async () => {
  const log = {};
  const result = await run({
    gh: { compareCommitAncestry: async () => ({ status: 'diverged' }) },
  }, {}, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'base_mismatch');
  assert.equal(result.expectedBase, NATIVE_HEAD);
  assert.match(result.message, /would drop commits that are already under review/);
  assert.equal(log.push, undefined, 'reviewed commits are never overwritten by a divergent branch');
});

test('an ancestry comparison the platform cannot make is a refusal, not a pass', async () => {
  for (const cmp of [
    async () => { throw new Error('502 from GitHub'); },
    async () => null,
    async () => ({}),
  ]) {
    const log = {};
    const result = await run({ gh: { compareCommitAncestry: cmp } }, {}, log);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'platform_unavailable');
    assert.equal(result.retryable, true);
    assert.equal(log.push, undefined);
  }
});

test('a lease the remote refused is reported as branch_moved, not as a platform fault', async () => {
  const result = await run({
    head: {
      pushForkBranchToAppBranch: async () => ({
        ok: false, code: 'branch_moved', message: 'somebody advanced it', retryable: false,
      }),
    },
  });
  assert.equal(result.code, 'branch_moved');
  assert.equal(result.retryable, undefined, 'a moved branch is not fixed by retrying the same push');
});

test('an unreadable proposal head refuses rather than pushing without a lease', async () => {
  const log = {};
  for (const getBranchSha of [
    async () => { throw new Error('404'); },
    async () => null,
    async () => 'not-a-sha',
  ]) {
    const result = await run({ gh: { getBranchSha } }, {}, log);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'platform_unavailable');
    assert.equal(log.push, undefined);
  }
});

// ── 6. Nothing to do ───────────────────────────────────────────────────

test('a fork branch that is already the proposal\'s head is a no-op, not a failure', async () => {
  const log = {};
  const result = await run({
    gh: { getBranchSha: async () => FORK_HEAD },
  }, {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.updated, false);
  assert.equal(result.unchanged, true);
  assert.equal(result.votesCleared, 0, 'no votes are cleared for a head that did not move');
  assert.equal(log.push, undefined);
  assert.equal(log.reconcile, undefined);
});

// ── 7. The imported pull request ───────────────────────────────────────

test('an imported proposal advances the head the platform TRACKS, and pushes nothing', async () => {
  const log = {};
  const session = importedSession();
  const result = await run(
    { session, pool: fakePool([
      ['FROM chat_sessions cs JOIN apps a', [session]],
      ['FROM pr_votes', [{ n: 2 }]],
    ]) },
    { branch: 'usernode/add-a-button' },
    log
  );
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.branchHome, 'user_fork');
  assert.equal(result.submittedVia, 'update_fork_head');
  assert.equal(result.headSha, FORK_HEAD);
  assert.equal(result.previousHeadSha, NATIVE_HEAD);
  assert.equal(result.votesCleared, 2);
  assert.equal(log.push, undefined, 'the author owns this branch — there is nothing for the bot to push');
  assert.equal(log.applied.length, 1, 'the existing imported-head machinery does the work');
  assert.equal(log.applied[0].newHead, FORK_HEAD);
  assert.equal(log.applied[0].oldHead, NATIVE_HEAD);
});

test('an imported proposal is only advanced from ITS OWN branch', async () => {
  const session = importedSession();
  const result = await run({ session }, { branch: 'some-other-branch' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_request');
  assert.match(result.message, /an open pull request cannot be repointed/);
});

test('an imported proposal whose pull request comes from another account is refused', async () => {
  const session = importedSession();
  const result = await run({
    session,
    gh: {
      getPR: async () => ({
        state: 'open',
        head: { ref: 'usernode/add-a-button', sha: FORK_HEAD, repo: { owner: { login: 'someone-else' } } },
      }),
    },
  }, { branch: 'usernode/add-a-button' });
  assert.equal(result.code, 'not_your_fork');
});

test('a pull request that GitHub says is closed cannot take a revision', async () => {
  const session = importedSession();
  for (const pr of [
    { state: 'closed', head: { ref: 'usernode/add-a-button', sha: FORK_HEAD, repo: { owner: { login: 'evan-gh' } } } },
    { state: 'open', merged: true, head: { ref: 'usernode/add-a-button', sha: FORK_HEAD, repo: { owner: { login: 'evan-gh' } } } },
  ]) {
    const result = await run({ session, gh: { getPR: async () => pr } }, { branch: 'usernode/add-a-button' });
    assert.equal(result.code, 'proposal_closed');
  }
});

test('GitHub\'s two views of the fork branch disagreeing writes nothing', async () => {
  const log = {};
  const session = importedSession();
  const result = await run({
    session,
    gh: {
      getPR: async () => ({
        state: 'open',
        head: { ref: 'usernode/add-a-button', sha: OTHER_HEAD, repo: { owner: { login: 'evan-gh' } } },
      }),
    },
  }, { branch: 'usernode/add-a-button' }, log);
  assert.equal(result.code, 'platform_unavailable');
  assert.equal(result.retryable, true);
  assert.equal(log.applied, undefined);
});

// ── 8. Busy, and the arguments ─────────────────────────────────────────

test('a proposal mid-build is told to retry rather than pushed onto', async () => {
  const log = {};
  const result = await run({ busy: () => true }, {}, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session_busy');
  assert.equal(result.retryable, true);
  assert.equal(log.push, undefined);
  assert.equal(log.began, undefined, 'refused before an operation is even opened');
});

test('the busy check asks the same four questions the commit-upload route asks', () => {
  const block = SRC.slice(SRC.indexOf('function defaultBusyCheck'));
  for (const needle of [
    'isSessionBusy', 'hasInFlightHandoffPipeline', 'hasInFlightBuild', 'hasInFlightCapture',
  ]) {
    assert.ok(block.includes(needle), `${needle} is one of the four`);
  }
});

test('the branch, the fork name and the expected head are all validated first', async () => {
  const log = {};
  for (const params of [
    { branch: undefined },
    { branch: '' },
    { branch: 'has a space' },
    { branch: 'ok', forkRepo: 'not/a/name' },
    { branch: 'ok', expectedHeadSha: 'zzzz' },
    { branch: 'ok', expectedHeadSha: 'abc123' },
  ]) {
    const result = await run({}, params, log);
    assert.equal(result.ok, false, JSON.stringify(params));
    assert.equal(result.code, 'invalid_request', JSON.stringify(params));
  }
  assert.equal(log.verify, undefined, 'a bad argument never reaches GitHub');
});

test('a deployment that cannot verify GitHub identity refuses, and says whose problem it is', async () => {
  const unconfigured = await run({ githubLink: { isEnabled: () => false } });
  assert.equal(unconfigured.code, 'github_link_unavailable');
  assert.match(unconfigured.message, /Ask an admin/, 'an operator\'s missing value is not the user\'s missing click');

  const unlinked = await run({
    githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: false }) },
  });
  assert.equal(unlinked.code, 'github_not_linked');
  assert.equal(unlinked.settingsUrl, 'https://usernode.test/#settings/connectors');

  const noGithub = await run({ gh: { isEnabled: () => false } });
  assert.equal(noGithub.code, 'platform_unavailable');
  assert.equal(noGithub.retryable, true);

  const noRepo = await run({ gh: { parseGithubUrl: () => null } });
  assert.equal(noRepo.code, 'no_repository');
});

// ── 9. The lock ────────────────────────────────────────────────────────

test('the advisory lock is taken on the session and released in finally', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; },
    release: () => calls.push({ sql: 'RELEASE' }),
  };
  const out = await svc.withProposalLock({ connect: async () => client }, 501, async () => 'body ran');
  assert.equal(out, 'body ran');
  assert.match(calls[0].sql, /pg_advisory_lock/);
  assert.equal(calls[0].params[1], 501, 'keyed on the session id');
  assert.match(calls[1].sql, /pg_advisory_unlock/);
  assert.equal(calls[2].sql, 'RELEASE');

  // Released even when the body throws — a held session lock would wedge
  // every later update of this proposal.
  calls.length = 0;
  await assert.rejects(
    svc.withProposalLock({ connect: async () => client }, 501, async () => { throw new Error('nope'); }),
    /nope/
  );
  assert.match(calls[1].sql, /pg_advisory_unlock/);
});

test('a pool that cannot lock still runs the update', async () => {
  // Degrading to unlocked is right: the lease is what prevents a clobber, and
  // a database that cannot hand out a client is not a reason to refuse
  // finished work.
  assert.equal(await svc.withProposalLock({}, 501, async () => 'ran'), 'ran');
  assert.equal(await svc.withProposalLock(null, 501, async () => 'ran'), 'ran');
  assert.equal(
    await svc.withProposalLock({ connect: async () => { throw new Error('pool exhausted'); } }, 501, async () => 'ran'),
    'ran'
  );
  // A nonsense session id is not lockable either — and must not be silently
  // locked on 0, which would serialize unrelated updates against each other.
  assert.equal(await svc.withProposalLock({ connect: async () => ({}) }, 0, async () => 'ran'), 'ran');
});

test('the lock is the one reserved for this path, not a borrowed key', () => {
  const { PROPOSAL_UPDATE_LOCK, ADMIN_MUTATION_LOCK, EXTERNAL_TASK_SUBMIT_LOCK } =
    require('../src/services/advisory-locks');
  assert.equal(typeof PROPOSAL_UPDATE_LOCK, 'number');
  assert.notEqual(PROPOSAL_UPDATE_LOCK, ADMIN_MUTATION_LOCK);
  assert.notEqual(PROPOSAL_UPDATE_LOCK, EXTERNAL_TASK_SUBMIT_LOCK);
  assert.match(SRC, /PROPOSAL_UPDATE_LOCK/);
});

// ── 10. What this path must never do ───────────────────────────────────

test('no user GitHub credential is used, held or forwarded', async () => {
  // The service asks for no token, and the only credential in the push is the
  // platform's own, resolved inside services/external-agent-head.js.
  assert.doesNotMatch(CODE, /access_token|accessToken|authorization|Bearer/i);
  assert.doesNotMatch(CODE, /github_tokens|user_token|userToken|\.token\b/);
  assert.doesNotMatch(CODE, /resolveWriteCredential|GITHUB_BOT_TOKEN|getInstallationToken/,
    'credential resolution stays where it already was, reused unchanged');
  // The fork is read through the PUBLIC reader, which is what makes the read
  // credential-free rather than merely un-credentialled today.
  const log = {};
  await run({}, {}, log);
  assert.deepEqual(log.verify[0].githubPublic, { marker: 'public-reader' });
  assert.deepEqual(log.push[0].githubPublic, { marker: 'public-reader' });
});

test('recordPlatformPush is never called, so the head classifies as the author\'s', () => {
  // If this path recorded a platform push, classifyNativeHeadMove would carry
  // every existing approval onto code nobody in the group has read. The
  // comment says so; this makes it true.
  assert.doesNotMatch(CODE, /recordPlatformPush/);
  assert.doesNotMatch(CODE, /sync-main/);
  // And the header comment says WHY, so the next person does not add it back.
  assert.match(SRC, /recordPlatformPush/, 'the omission is documented, not accidental');
});

test('the vote-clearing and check-rerunning machinery is reused, not reimplemented', () => {
  // Two calls out, both to code that already existed. Anything that deleted
  // from pr_votes or kicked a build in here would be a second implementation
  // of the platform's most consequential rule.
  assert.match(SRC, /votes\.reconcileNativeReviewedHead/);
  assert.match(SRC, /prImportSync\.applyHeadChange/);
  assert.doesNotMatch(SRC, /DELETE\s+FROM\s+pr_votes/i);
  assert.doesNotMatch(SRC, /kickNativeRevisionChecks|rerunChecksForNewHead|startStagingBuild/);
  // pr_votes is read, and only read.
  const votesReads = SRC.match(/FROM pr_votes/g) || [];
  assert.equal(votesReads.length, 1);
});

test('a reconciliation that fails after a successful push still reports the update', async () => {
  // The push landed. Telling the author it did not would send them to push
  // again over their own work.
  const log = {};
  const result = await run({
    votes: { reconcileNativeReviewedHead: async () => { throw new Error('notify failed'); } },
  }, {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.votesCleared, 0, 'honest: the votes are only reported cleared when the clearing ran');
  assert.equal(result.checksRerun, false);
  assert.equal(log.push.length, 1);
});

// ── 8. Continuing a session nobody has voted on (#1071) ────────────────
//
// The same push, onto a session that is still being built rather than a
// proposal up for a vote. The mechanics are identical — same bot-owned branch,
// same lease, same attribution gate — and everything AFTERWARDS is different:
// there are no votes to clear, no re-review note to post, and what the session
// needs instead is its checks re-pointed at the new commit.

// The three modules the session tails reach for, as observable stubs. The real
// ones start a container, tear one down and fan out over a websocket; a test
// about which tail ran must not do any of that.
function sessionParts(log, over = {}) {
  return Object.assign({
    visuals: {
      setChecksPending: async (...args) => {
        (log.pending = log.pending || []).push(args);
        return true;
      },
      notifyChecksPending: (...args) => { (log.notified = log.notified || []).push(args); },
    },
    pipeline: {
      OWNED_SOURCE_SQL: "source = 'native'",
      beginHandoffPipeline: (id) => {
        (log.pipelineBegan = log.pipelineBegan || []).push(id);
        return () => { (log.pipelineReleased = log.pipelineReleased || []).push(id); };
      },
      startHandoffPipeline: (config, pool, session, app, headSha) => {
        (log.started = log.started || []).push({ sessionId: session.id, headSha, app });
      },
    },
    lifecycle: {
      teardownStagingForSession: async (args) => {
        (log.tornDown = log.tornDown || []).push(args);
        return { ok: true };
      },
    },
    pushSessionUpdate: (payload) => { (log.pushed = log.pushed || []).push(payload); },
  }, over);
}

// A session (not a proposal) whose row answers the tail's guarded UPDATE.
function sessionRow(status, over) {
  return nativeSession(Object.assign({
    status,
    pr_number: null,
    pr_url: null,
    checks_commit_sha: OTHER_HEAD,
  }, over));
}

function runSession(status, over = {}, log = {}, params = {}) {
  const session = over.session || sessionRow(status);
  const pool = over.pool || fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['UPDATE chat_sessions', () => (over.adopted === false ? [] : [{ id: session.id }])],
    ['FROM pr_votes', [{ n: 4 }]],
  ]);
  // rowCount, which the tails branch on, is not what fakePool reports — wrap
  // it so an UPDATE answers with the count the service actually reads.
  const counting = {
    queries: pool.queries,
    async query(sql, params2) {
      const res = await pool.query(sql, params2);
      return Object.assign({}, res, { rowCount: res.rows.length });
    },
  };
  log.queries = pool.queries;
  return svc.updateProposalFromForkBranch(
    Object.assign(deps({ ...over, session, pool: counting }, log), over.parts || sessionParts(log)),
    Object.assign({
      user: USER, session, branch: 'fix/failing-check', origin: 'https://usernode.test',
    }, params)
  );
}

// The queries a run actually issued — used both ways round: to assert an
// UPDATE's shape, and to assert that pr_votes was never read.
const sqlsOf = (log) => (log.queries || []).map((q) => String(q.sql));
const queryOf = (log, needle) => (log.queries || []).find((q) => String(q.sql).includes(needle));

test('active and paused are continuable; archived and merged are not', () => {
  // ONE predicate, shared with describeTargetProposal — the options menu's
  // label and this gate cannot disagree, which is the whole point of it being
  // exported rather than copied.
  assert.equal(svc.isContinuableStatus('promoted'), 'proposal');
  assert.equal(svc.isContinuableStatus('active'), 'session');
  assert.equal(svc.isContinuableStatus('paused'), 'session');
  for (const status of ['archived', 'merging', 'merged', 'closed', 'building', '', null, undefined]) {
    assert.equal(svc.isContinuableStatus(status), null, `${String(status)} is not continuable`);
  }
  // And the gate is written in terms of it, not in terms of a second list.
  assert.match(CODE, /if \(!isContinuableStatus\(session\.status\)\)/);
});

test('an archived session is refused before anything is pushed', async () => {
  const log = {};
  const result = await runSession('archived', {}, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'proposal_closed');
  assert.equal(log.push, undefined, 'an explicit put-away is not silently reopened');
});

test('an ACTIVE session gets the commit, pending checks and a staging rebuild', async () => {
  const log = {};
  const result = await runSession('active', {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.targetKind, 'session');
  assert.equal(result.submittedVia, 'update_branch');
  assert.equal(result.votesCleared, 0, 'nobody has voted, so nothing is cleared');
  assert.equal(result.checksRerun, true);
  assert.equal(result.previewRebuilding, true);
  assert.equal(result.resumeRequired, undefined, 'the build is running now, not on reopen');

  // The commit landed on the session's own branch, with the lease pinned to
  // the head read under the lock.
  assert.equal(log.push.length, 1);
  assert.equal(log.push[0].targetBranch, 'dev/evan-1786376366569');
  assert.equal(log.push[0].expectedRemoteSha, NATIVE_HEAD);

  // And the platform's ordinary post-commit machinery ran, rather than a
  // second implementation of it.
  assert.deepEqual(log.pending[0].slice(1), [501, FORK_HEAD]);
  assert.equal(log.notified.length, 1);
  assert.deepEqual(log.pipelineBegan, [501]);
  assert.equal(log.started.length, 1);
  assert.equal(log.started[0].headSha, FORK_HEAD);
  assert.equal(log.started[0].sessionId, 501);

  // Nothing about votes: no count, no reconciliation.
  assert.equal(log.reconcile, undefined);
  assert.ok(!sqlsOf(log).some((s) => /FROM pr_votes/.test(s)),
    'a session with no votes is not asked how many it has');
});

test('the checks UPDATE is guarded on the status and the commit it replaces', async () => {
  const log = {};
  await runSession('active', {}, log);
  const update = queryOf(log, 'UPDATE chat_sessions');
  assert.match(update.sql, /status = 'active'/, 'a pause between the lock and here wins');
  assert.match(update.sql, /checks_commit_sha IS NOT DISTINCT FROM \$3/,
    'a newer head that took the session is not regressed to an older pending state');
  assert.match(update.sql, /check_state = 'pending'/);
  assert.deepEqual(update.params, [FORK_HEAD, 501, OTHER_HEAD]);
});

test('an active session that stopped being active falls back to the paused tail', async () => {
  // The guarded UPDATE matched nothing: something paused or archived the
  // session between the lock and the write. The commit is already on the
  // branch, so the answer is "it landed, reopen to rebuild" — never a failure.
  const log = {};
  const result = await runSession('active', { adopted: false }, log);
  assert.equal(result.ok, true);
  assert.equal(result.checksRerun, false);
  assert.equal(result.previewRebuilding, false);
  assert.equal(result.resumeRequired, true);
  assert.equal(log.started, undefined, 'no build is started for a session that is not active');
  assert.equal(log.tornDown.length, 1, 'and the stale preview is reclaimed');
});

test('a PAUSED session takes the commit and defers the build to its reopen', async () => {
  const log = {};
  const result = await runSession('paused', {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.targetKind, 'session');
  assert.equal(result.votesCleared, 0);
  assert.equal(result.checksRerun, false);
  assert.equal(result.previewRebuilding, false);
  assert.equal(result.resumeRequired, true);

  // The push happened; the pipeline deliberately did not. handoff-pipeline's
  // persistence UPDATE only matches an active row, so a build started here
  // would run for minutes and discard its own result.
  assert.equal(log.push.length, 1);
  assert.equal(log.started, undefined);
  assert.equal(log.pipelineBegan, undefined);

  // The stale verdict is cleared and the stale preview torn down.
  const cleared = queryOf(log, 'UPDATE chat_sessions');
  assert.match(cleared.sql, /status = 'paused'/);
  assert.match(cleared.sql, /check_state = NULL/,
    "a 'pending' no pipeline will resolve is a spinner forever");
  assert.doesNotMatch(cleared.sql, /checks_commit_sha =/,
    'the commit the last verdict described is what the resume path compares against');
  assert.deepEqual(log.tornDown[0].sessionId, 501);
  assert.equal(log.tornDown[0].reason, 'external_update');

  // And the page the session is open in hears about it.
  assert.equal(log.pushed.length, 1);
  assert.equal(log.pushed[0].action, 'session_update');
  assert.equal(log.pushed[0].sessionId, 501);
});

test('a teardown that throws does not turn a landed commit into a failed update', async () => {
  const log = {};
  const result = await runSession('paused', {
    parts: sessionParts(log, {
      lifecycle: {
        teardownStagingForSession: async () => { throw new Error('docker is down'); },
      },
    }),
  }, log);
  assert.equal(result.ok, true, 'the commit is on the branch either way');
  assert.equal(result.resumeRequired, true);
  // Same for the websocket fan-out.
  const log2 = {};
  const result2 = await runSession('paused', {
    parts: sessionParts(log2, {
      pushSessionUpdate: () => { throw new Error('no sockets'); },
    }),
  }, log2);
  assert.equal(result2.ok, true);
});

test('the tail is chosen by the status read UNDER THE LOCK, not the caller\'s copy', async () => {
  // The caller's snapshot says active; the row read under the lock says
  // promoted — it was promoted while the agent worked. The push must take the
  // PROPOSAL tail, votes and all, because that is what it is landing on now.
  const log = {};
  const locked = nativeSession({ status: 'promoted' });
  const pool = fakePool([
    ['FROM chat_sessions cs JOIN apps a', [locked]],
    ['FROM pr_votes', [{ n: 4 }]],
  ]);
  const result = await svc.updateProposalFromForkBranch(
    Object.assign(deps({ pool, session: locked }, log), sessionParts(log)),
    {
      user: USER,
      session: sessionRow('active'),
      branch: 'fix/failing-check',
      origin: 'https://usernode.test',
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.targetKind, 'proposal');
  assert.equal(result.votesCleared, 4, 'it IS up for a vote now, so the votes are cleared');
  assert.equal(log.reconcile.length, 1);
  assert.equal(log.started, undefined, 'and the session tails did not run');

  // And the reverse: a caller who thinks it is promoted, against a row that
  // was paused back. No votes are counted for a session that has none.
  const log2 = {};
  const paused = sessionRow('paused');
  const pool2 = fakePool([
    ['FROM chat_sessions cs JOIN apps a', [paused]],
    ['UPDATE chat_sessions', [{ id: 501 }]],
  ]);
  const result2 = await svc.updateProposalFromForkBranch(
    Object.assign(deps({ pool: pool2, session: paused }, log2), sessionParts(log2)),
    {
      user: USER,
      session: nativeSession({ status: 'promoted' }),
      branch: 'fix/failing-check',
      origin: 'https://usernode.test',
    }
  );
  assert.equal(result2.ok, true);
  assert.equal(result2.targetKind, 'session');
  assert.equal(result2.resumeRequired, true);
  assert.equal(log2.reconcile, undefined);
});

test('a fork-owned proposal is refused unless it is up for a vote', () => {
  // advanceForkHead only ever meant "the author pushed to their own PR
  // branch", which exists only for an imported, promoted proposal — a native
  // session is always app_repo. The guard is there so a future caller cannot
  // reach it with a session and quietly skip the whole session tail.
  assert.match(CODE, /async function advanceForkHead/);
  const fork = CODE.slice(CODE.indexOf('async function advanceForkHead'));
  assert.match(fork.slice(0, 900), /proposal_closed/,
    'the fork path states the one status it accepts');
});
