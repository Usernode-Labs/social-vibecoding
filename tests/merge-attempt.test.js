'use strict';

// GitHub's half of a merge (routes/votes.js attemptMerge, the proposal
// machine's merge.attempt work): GitHub is asked to merge the pull request at
// exactly the head the claim was for, and what it answered is one named
// outcome (merged, head_moved, unverified, reopened, closed, refused by kind),
// never "a conflict" for every refusal (merge trace bug 2). It never asks
// twice: once it has asked, a retry reads the pull request first, so a lost
// answer is observed rather than misread (bug 1). An error that is no answer
// from GitHub is thrown, for the work to be tried again.
//
// Collaborators are stubbed through the require cache; nothing real spins
// up. The machine's side (what each outcome moves) is
// tests/workflow-merge-postgres.test.js.
//
// Run with: node --test tests/merge-attempt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.USERNODE_ENV = 'production';

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({}) };
  return _origLoad.call(this, request, ...rest);
};

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const HEAD = 'b'.repeat(40);
const { HeadMovedError } = require('../src/services/github');
const status = (code, message) => Object.assign(new Error(message), { status: code });

// `github`: scripted per test (mergePR, getPR, reopenPR, markPrReadyForReview).
function load({ session, github: gh = {}, reconcileImported = null }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    prImportSync: require.resolve('../src/services/pr-import-sync'),
    github: require.resolve('../src/services/github'),
    platform: require.resolve('../src/workflow/platform.ts'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const calls = { merge: [], get: 0, reopen: 0, ready: 0, reconcile: [] };
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.prImportSync, {
    async reconcileImportedHead(args) {
      calls.reconcile.push(['imported', args]);
      return reconcileImported ? reconcileImported(args) : { reconciled: false, reason: 'fork_head' };
    },
  });
  stub(ids.github, {
    isEnabled: () => true,
    // Homeroom can act on the repository's owner through the App.
    canActOn: () => true,
    HeadMovedError,
    async mergePR(owner, repo, n, sha) { calls.merge.push(sha); return gh.mergePR ? gh.mergePR(sha, calls.merge.length) : { sha: 'squash' }; },
    async getPR() { calls.get++; if (gh.getPR) return gh.getPR(calls.get); return { state: 'open', merged: false }; },
    async reopenPR() { calls.reopen++; if (gh.reopenPR) return gh.reopenPR(); return {}; },
    async markPrReadyForReview() { calls.ready++; return {}; },
  });
  stub(ids.platform, {});
  stub(ids.ws, { sendSystemMessage: async () => {}, pushVoteUpdate() {}, pushSessionUpdate() {} });
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const pool = {
    async query(sql) {
      if (/FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id WHERE cs\.id = \$1/.test(String(sql))) return { rows: session ? [session] : [] };
      return { rows: [] };
    },
  };
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, pool, calls, restore };
}

const native = {
  id: 11, app_id: 5, app_slug: 'demo', repo_url: 'https://github.com/acme/demo', pr_number: 30,
  pr_title: 'Native change', user_id: 3, source: 'native', reviewed_head_sha: HEAD,
};
const imported = {
  id: 12, app_id: 5, app_slug: 'demo', repo_url: 'https://github.com/acme/demo', pr_number: 31,
  pr_title: 'Imported change', user_id: 4, source: 'imported', imported_pr_head_sha: HEAD,
};

async function attempt(ctx, extra = {}) {
  const checkpoints = [];
  const out = await ctx.subject.attemptMerge({}, ctx.pool, ctx.session?.id ?? 11, {
    head: HEAD, checkpoint: async (v) => { checkpoints.push(v); }, ...extra,
  });
  return { out, checkpoints };
}

test('it asks GitHub once, at exactly the head the claim was for, and says it asked first', async () => {
  const c = load({ session: native, github: { mergePR: () => ({ sha: 'squashsha' }) } });
  c.session = native;
  try {
    const { out, checkpoints } = await attempt(c);
    assert.deepEqual(out, { outcome: 'merged', sha: 'squashsha' });
    assert.deepEqual(c.calls.merge, [HEAD], 'pinned');
    assert.deepEqual(checkpoints, [{ asked: true }], 'recorded before GitHub was asked');
  } finally { c.restore(); }
});

test('a retry after it asked reads the pull request first: a lost answer is observed, never asked again (bug 1)', async () => {
  const c = load({ session: native, github: { getPR: () => ({ merged: true, merge_commit_sha: 'lostsha', merged_at: '2026-10-16T00:00:00Z' }) } });
  c.session = native;
  try {
    const { out } = await attempt(c, { resumeFrom: { asked: true } });
    assert.deepEqual(out, { outcome: 'merged', sha: 'lostsha', mergedAt: '2026-10-16T00:00:00Z', observed: true });
    assert.deepEqual(c.calls.merge, [], 'never asked twice');
  } finally { c.restore(); }
  const n = load({ session: native });
  n.session = native;
  try {
    const { out } = await attempt(n, { resumeFrom: { asked: true } });
    assert.equal(out.outcome, 'merged', 'not merged on GitHub: asking again is safe');
    assert.deepEqual(n.calls.merge, [HEAD]);
  } finally { n.restore(); }
});

test('no answer from GitHub (the network, a 5xx, its limit) is thrown, for the work to be tried again', async () => {
  for (const err of [new Error('socket hang up'), status(502, 'Bad gateway'), status(429, 'rate limited')]) {
    const c = load({ session: native, github: { mergePR: () => { throw err; } } });
    c.session = native;
    try {
      await assert.rejects(attempt(c), (e) => e === err);
    } finally { c.restore(); }
  }
});

test('GitHub\'s hourly or secondary limit is not a refusal of the head: it is said as such, and a reopen it stops is not "closed for good" (PR review)', async () => {
  const limit = (code) => Object.assign(status(code, 'API rate limit exceeded for installation'), {
    response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } },
  });
  // GitHub's secondary limit: requests left in the hour, Retry-After said
  // (or only its wording, when the headers are gone).
  const secondary = (code) => Object.assign(status(code, 'You have exceeded a secondary rate limit. Please wait a few minutes.'), {
    response: { headers: { 'x-ratelimit-remaining': '4321', 'retry-after': '60' } },
  });
  const worded = () => status(403, 'You have exceeded a secondary rate limit and have been temporarily blocked.');
  for (const err of [limit(403), limit(429), secondary(403), secondary(429), worded()]) {
    const c = load({ session: native, github: { mergePR: () => { throw err; } } });
    c.session = native;
    try {
      const { out } = await attempt(c);
      assert.equal(out.outcome, 'rate_limited', err.message);
      assert.deepEqual(c.calls.merge, [HEAD], 'asked once');
    } finally { c.restore(); }
  }
  // A closed pull request whose reopen GitHub did not answer is asked again,
  // never taken off the vote.
  for (const [err, expect] of [[limit(403), 'rate_limited'], [secondary(403), 'rate_limited'], [status(502, 'Bad gateway'), 'thrown']]) {
    const c = load({ session: native, github: {
      mergePR: () => { throw status(405, 'Pull Request is not mergeable'); },
      getPR: () => ({ state: 'closed', merged: false, head: { sha: HEAD } }),
      reopenPR: () => { throw err; },
    } });
    c.session = native;
    try {
      if (expect === 'thrown') await assert.rejects(attempt(c), (e) => e === err);
      else assert.equal((await attempt(c)).out.outcome, expect);
    } finally { c.restore(); }
  }
});

test('every refusal is named: a conflict, a draft, a branch rule, a base that moved (bug 2)', async () => {
  const cases = [
    [{ state: 'open', merged: false, mergeable: false, mergeable_state: 'dirty' }, status(405, 'Pull Request is not mergeable'), 'conflict', /hit a conflict with main/],
    [{ state: 'open', merged: false, mergeable: true, mergeable_state: 'blocked' }, status(405, 'At least 1 approving review is required'), 'blocked', /GitHub refused it \(At least 1 approving review is required\)/],
    [{ state: 'open', merged: false, mergeable: true, mergeable_state: 'clean' }, status(409, 'Base branch was modified. Review and try the merge again.'), 'base_moved', /main moved while GitHub was merging it/],
  ];
  for (const [pr, err, kind, said] of cases) {
    const c = load({ session: native, github: { mergePR: () => { throw err; }, getPR: () => pr } });
    c.session = native;
    try {
      const { out } = await attempt(c);
      assert.equal(out.outcome, 'refused');
      assert.equal(out.kind, kind, err.message);
      assert.match(out.message, said);
    } finally { c.restore(); }
  }
  // A draft of an imported pull request is its author's to mark ready.
  const d = load({ session: imported, github: { mergePR: () => { throw status(405, 'Pull Request is still a draft'); }, getPR: () => ({ state: 'open', draft: true }) } });
  d.session = imported;
  try {
    const { out } = await attempt(d);
    assert.equal(out.kind, 'draft');
    assert.equal(d.calls.ready, 0);
    assert.match(out.message, /draft on GitHub/);
  } finally { d.restore(); }
});

test('a draft of ours is marked ready for review again and merged once more', async () => {
  const c = load({
    session: native,
    github: {
      mergePR: (sha, n) => { if (n === 1) throw status(405, 'Pull Request is still a draft'); return { sha: 'aftersha' }; },
      getPR: () => ({ state: 'open', draft: true }),
    },
  });
  c.session = native;
  try {
    const { out } = await attempt(c);
    assert.deepEqual(out, { outcome: 'merged', sha: 'aftersha' });
    assert.equal(c.calls.ready, 1);
    assert.equal(c.calls.merge.length, 2);
  } finally { c.restore(); }
});

test('a pull request closed on GitHub is reopened (and merged next time), or, when it cannot be, the proposal leaves the vote', async () => {
  const reopened = load({ session: native, github: { mergePR: () => { throw status(405, 'not mergeable'); }, getPR: () => ({ state: 'closed', merged: false }) } });
  reopened.session = native;
  try {
    assert.deepEqual((await attempt(reopened)).out, { outcome: 'reopened' });
  } finally { reopened.restore(); }
  const closed = load({
    session: native,
    github: { mergePR: () => { throw status(405, 'not mergeable'); }, getPR: () => ({ state: 'closed', merged: false }), reopenPR: () => { throw status(422, 'branch deleted'); } },
  });
  closed.session = native;
  try {
    const { out } = await attempt(closed);
    assert.equal(out.outcome, 'closed');
    assert.match(out.message, /couldn't be reopened: branch deleted/);
  } finally { closed.restore(); }
  // Closed because it merged: merged.
  const merged = load({ session: native, github: { mergePR: () => { throw status(405, 'not mergeable'); }, getPR: () => ({ state: 'closed', merged: true, merge_commit_sha: 'm1' }) } });
  merged.session = native;
  try {
    assert.equal((await attempt(merged)).out.outcome, 'merged');
  } finally { merged.restore(); }
});

test('a 409 on an imported proposal: the mirror says whether its head moved (votes kept or not) or GitHub would not merge it', async () => {
  const SYNCED = 'c'.repeat(40);
  const kept = load({
    session: imported,
    github: { mergePR: () => { throw new HeadMovedError(); } },
    reconcileImported: () => ({ reconciled: true, changed: true, headSha: SYNCED, kind: 'mechanical', votesKept: true }),
  });
  kept.session = imported;
  try {
    const { out } = await attempt(kept);
    assert.equal(out.outcome, 'head_moved');
    assert.equal(out.votesKept, true);
    assert.match(out.message, /Existing votes were kept and the merge retries automatically/);
    assert.equal(kept.calls.reconcile[0][1].checks, 'defer');
  } finally { kept.restore(); }
  // A head on the author's fork: the poller re-pins it.
  const fork = load({ session: imported, github: { mergePR: () => { throw new HeadMovedError(); } } });
  fork.session = imported;
  try {
    const { out } = await attempt(fork);
    assert.equal(out.outcome, 'head_moved');
    assert.equal(out.votesKept, false);
    assert.match(out.message, /updated on GitHub since the vote/);
  } finally { fork.restore(); }
  // The mirror contradicts it: the branch still sits on the pinned commit.
  const plain = load({
    session: imported,
    github: { mergePR: () => { throw new HeadMovedError(); }, getPR: () => ({ state: 'open', merged: false, mergeable: false }) },
    reconcileImported: () => ({ reconciled: true, changed: false, headSha: HEAD }),
  });
  plain.session = imported;
  try {
    const { out } = await attempt(plain);
    assert.equal(out.outcome, 'refused', 'not a head move');
    assert.equal(out.kind, 'conflict');
  } finally { plain.restore(); }
});

test('no GitHub, or no pull request (a local stack): nothing to ask', async () => {
  const c = load({ session: { ...native, pr_number: null } });
  c.session = { ...native, pr_number: null };
  try {
    const { out } = await attempt(c);
    assert.deepEqual(out, { outcome: 'merged', sha: null, noGithub: true });
    assert.deepEqual(c.calls.merge, []);
  } finally { c.restore(); }
});

test('a repository address with a trailing slash is still asked about; one it cannot read is refused, never merged unasked (review: attempt 7)', async () => {
  const slash = { ...native, repo_url: 'https://github.com/acme/demo/' };
  const c = load({ session: slash, github: { mergePR: () => ({ sha: 'squashsha' }) } });
  c.session = slash;
  try {
    const { out } = await attempt(c);
    assert.deepEqual(out, { outcome: 'merged', sha: 'squashsha' });
    assert.deepEqual(c.calls.merge, [HEAD], 'GitHub was asked');
  } finally { c.restore(); }
  const odd = { ...native, repo_url: 'https://gitlab.example/acme/demo' };
  const d = load({ session: odd, github: { mergePR: () => ({ sha: 'squashsha' }) } });
  d.session = odd;
  try {
    const { out } = await attempt(d);
    assert.equal(out.outcome, 'refused');
    assert.deepEqual(d.calls.merge, []);
  } finally { d.restore(); }
});

test('refusalKind names a refusal from GitHub\'s answer and the pull request as it stands', () => {
  const { refusalKind } = require('../src/routes/votes');
  assert.equal(refusalKind(status(405, 'x'), { draft: true }), 'draft');
  assert.equal(refusalKind(status(409, 'Base branch was modified'), {}), 'base_moved');
  assert.equal(refusalKind(status(405, 'x'), { mergeable: false }), 'conflict');
  assert.equal(refusalKind(status(405, 'x'), { mergeable_state: 'blocked', mergeable: true }), 'blocked');
  assert.equal(refusalKind(status(405, 'Pull Request is not mergeable'), null), 'conflict', 'GitHub unread: its words');
  assert.equal(refusalKind(status(403, 'Resource not accessible'), { mergeable: true }), 'blocked');
});

test('an imported pull request on a staging preview is merged by the mock client, never the real one', async () => {
  const githubMock = require('../src/services/github-mock');
  githubMock._resetForTests();
  const PR = 9401;
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    const head = githubMock.currentHead(PR);
    const s = { ...imported, pr_number: PR, imported_pr_head_sha: head };
    const c = load({ session: s });
    c.session = s;
    try {
      const out = await c.subject.attemptMerge({}, c.pool, s.id, { head, checkpoint: async () => {} });
      assert.equal(out.outcome, 'merged');
      assert.ok(out.sha, 'with the mock merge commit');
      assert.deepEqual(c.calls.merge, [], 'the real client was never asked');
      // A stale head: the mock refuses it as GitHub would.
      const stale = await c.subject.attemptMerge({}, c.pool, s.id, { head: 'f'.repeat(40), checkpoint: async () => {} });
      assert.equal(stale.outcome, 'head_moved');
    } finally { c.restore(); }
  } finally {
    if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev;
  }
});
