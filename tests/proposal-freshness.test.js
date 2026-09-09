// #1442: unit tests for services/proposal-freshness.js.
//
// Proposal 3590 presented itself as "behind main by 0, 412/412 checks
// passing, no conflict" while being eight commits behind and conflicting in
// seven files. The three properties that fix has to keep are the three this
// file pins:
//
//   1. the read is pure and total — it answers on a row that predates the
//      columns, and it never calls GitHub;
//   2. the refresh never throws, whatever GitHub does, and a failure leaves
//      the previous numbers alone rather than resetting them to "clean";
//   3. 'unknown' is a real answer and never collapses into 'clean' — which
//      is the specific way the old code read healthy.
//
// github.js is injected, so nothing here touches the network.
//
// Run with: node --test tests/proposal-freshness.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/proposal-freshness.js');

// ── Test doubles ───────────────────────────────────────────────────────

function fakePool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
    // The last UPDATE's params, keyed by the $n they were bound to.
    last() { return queries[queries.length - 1] || null; },
  };
}

function fakeGh(overrides = {}) {
  const calls = [];
  const gh = {
    calls,
    parseGithubUrl(url) {
      const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(url || ''));
      return m ? { owner: m[1], repo: m[2] } : null;
    },
    async getRepoHead(owner, repo) {
      calls.push(['getRepoHead', owner, repo]);
      return { defaultBranch: 'main', headSha: 'a'.repeat(40), headCommittedAt: null };
    },
    async compareCommitAncestry(owner, repo, base, head) {
      calls.push(['compareCommitAncestry', base, head]);
      return { status: 'diverged', aheadBy: 8, behindBy: 8, mergeBaseSha: 'b'.repeat(40) };
    },
    async getPR(owner, repo, n) {
      calls.push(['getPR', n]);
      return { mergeable: true };
    },
    async compareRefs(owner, repo, basehead) {
      calls.push(['compareRefs', basehead]);
      return { mergeBaseSha: 'b'.repeat(40), files: [], filesComplete: true };
    },
  };
  return Object.assign(gh, overrides);
}

// A promoted proposal with everything the refresh needs.
function session(extra = {}) {
  return {
    id: 3590,
    app_slug: 'social-vibecoding',
    repo_url: 'https://github.com/usernodelabs/social-vibecoding',
    pr_number: 1431,
    source: 'session',
    reviewed_head_sha: 'c'.repeat(40),
    status: 'promoted',
    ...extra,
  };
}

// ── readFreshness: pure, total, and calls nothing ──────────────────────

test('readFreshness answers on a row that predates every column', () => {
  const f = svc.readFreshness({ id: 1 });
  assert.equal(f.checkedAt, null);
  assert.equal(f.mainSha, null);
  assert.equal(f.behindBy, null);
  assert.equal(f.mergeability, null);
  assert.deepEqual(f.mergeabilityFiles, []);
  // Not `false`: nothing has measured whether the list is complete.
  assert.equal(f.mergeabilityFilesComplete, null);
  assert.equal(f.checksBaseVerdict, null);
  assert.equal(f.error, null);
});

test('readFreshness tolerates null/undefined and string numerics', () => {
  assert.equal(svc.readFreshness(null).behindBy, null);
  assert.equal(svc.readFreshness(undefined).mergeability, null);
  // pg returns bigint-ish columns as strings on some drivers.
  const f = svc.readFreshness({ freshness_behind_by: '8', checks_base_behind_by: '12' });
  assert.equal(f.behindBy, 8);
  assert.equal(f.checksBaseBehindBy, 12);
});

test('readFreshness normalizes shas and rejects junk', () => {
  const f = svc.readFreshness({
    freshness_main_sha: 'DAECE615DAECE615DAECE615DAECE615DAECE615',
    freshness_merge_base_sha: 'not-a-sha',
  });
  assert.equal(f.mainSha, 'daece615daece615daece615daece615daece615');
  assert.equal(f.mergeBaseSha, null);
});

test('readFreshness only ever reports the three known mergeability values', () => {
  assert.equal(svc.readFreshness({ mergeability: 'clean' }).mergeability, 'clean');
  assert.equal(svc.readFreshness({ mergeability: 'conflict' }).mergeability, 'conflict');
  assert.equal(svc.readFreshness({ mergeability: 'unknown' }).mergeability, 'unknown');
  // Anything else is "nothing has measured this", NOT a fourth state and
  // certainly not clean.
  assert.equal(svc.readFreshness({ mergeability: 'mergeable' }).mergeability, null);
  assert.equal(svc.readFreshness({ mergeability: '' }).mergeability, null);
});

test('readFreshness caps the predicted-conflict file list', () => {
  const many = Array.from({ length: 120 }, (_, i) => `src/file-${i}.js`);
  const f = svc.readFreshness({ mergeability: 'conflict', mergeability_files: many });
  assert.equal(f.mergeabilityFiles.length, 50);
  // Non-array junk degrades to empty rather than throwing.
  assert.deepEqual(svc.readFreshness({ mergeability_files: 'oops' }).mergeabilityFiles, []);
});

// ── isFresh: the TTL that gates the on-demand refresh ──────────────────

test('isFresh is false with no measurement, true inside the TTL', () => {
  assert.equal(svc.isFresh({}), false);
  assert.equal(svc.isFresh({ freshness_checked_at: 'nonsense' }), false);
  assert.equal(svc.isFresh({ freshness_checked_at: new Date() }), true);
  const old = new Date(Date.now() - svc.FRESHNESS_TTL_MS - 1000);
  assert.equal(svc.isFresh({ freshness_checked_at: old }), false);
});

// ── refreshFreshness: the happy path writes everything through ─────────

test('refresh measures, writes one row, and writes behind_main through', async () => {
  const pool = fakePool();
  const gh = fakeGh();
  const out = await svc.refreshFreshness({ gh, pool }, session(), { force: true });

  assert.equal(out.behindBy, 8);
  assert.equal(out.aheadBy, 8);
  assert.equal(out.mergeability, 'clean');
  assert.equal(out.mainSha, 'a'.repeat(40));
  assert.equal(out.error, null);
  assert.ok(out.checkedAt, 'stamps checkedAt');

  // Exactly one write, and it carries behind_main so the merge gate — which
  // reads that column and nothing in this service — stops being stale.
  assert.equal(pool.queries.length, 1);
  const w = pool.last();
  assert.match(w.sql, /UPDATE chat_sessions/);
  assert.match(w.sql, /behind_main = COALESCE\(\$4, behind_main\)/);
  assert.equal(w.params[3], 8);
  assert.match(w.sql, /freshness_error = NULL/);
});

test('a clean prediction spends no file compares', async () => {
  const pool = fakePool();
  const gh = fakeGh();
  await svc.refreshFreshness({ gh, pool }, session(), { force: true });
  assert.equal(gh.calls.filter((c) => c[0] === 'compareRefs').length, 0);
});

test('the TTL skips the work unless forced', async () => {
  const pool = fakePool();
  const gh = fakeGh();
  const s = session({ freshness_checked_at: new Date(), freshness_behind_by: 3 });
  const out = await svc.refreshFreshness({ gh, pool }, s);
  assert.equal(out.skipped, 'fresh');
  assert.equal(out.behindBy, 3, 'returns the cached answer');
  assert.equal(gh.calls.length, 0);
  assert.equal(pool.queries.length, 0);
});

test('an incomplete session is skipped rather than guessed at', async () => {
  const pool = fakePool();
  const gh = fakeGh();
  for (const bad of [
    session({ repo_url: null }),
    session({ reviewed_head_sha: null, imported_pr_head_sha: null }),
    session({ repo_url: 'https://example.com/not-github' }),
  ]) {
    const out = await svc.refreshFreshness({ gh, pool }, bad, { force: true });
    assert.equal(out.skipped, 'incomplete_session');
  }
  assert.equal(gh.calls.length, 0);
  assert.equal(pool.queries.length, 0);
});

// ── The false-clean case, which is the bug ─────────────────────────────

test('mergeable:false records a conflict and its predicted files', async () => {
  const pool = fakePool();
  const gh = fakeGh({
    async getPR() { return { mergeable: false }; },
    async compareRefs(owner, repo, basehead) {
      // ours: what the proposal changed; theirs: what main changed.
      const ours = basehead.endsWith('c'.repeat(40));
      return {
        mergeBaseSha: 'b'.repeat(40),
        files: ours
          ? ['dapp.json', 'src/routes/votes.js', 'only-mine.js']
          : ['dapp.json', 'src/routes/votes.js', 'only-theirs.js'],
        filesComplete: true,
      };
    },
  });
  const out = await svc.refreshFreshness({ gh, pool }, session(), { force: true });
  assert.equal(out.mergeability, 'conflict');
  // The intersection, and nothing either side touched alone.
  assert.deepEqual(out.mergeabilityFiles, ['dapp.json', 'src/routes/votes.js']);
  assert.equal(out.mergeabilityFilesComplete, true);
});

test('a capped compare reports the file list as incomplete', async () => {
  const pool = fakePool();
  const gh = fakeGh({
    async getPR() { return { mergeable: false }; },
    async compareRefs() {
      return { mergeBaseSha: 'b'.repeat(40), files: ['dapp.json'], filesComplete: false };
    },
  });
  const out = await svc.refreshFreshness({ gh, pool }, session(), { force: true });
  assert.equal(out.mergeability, 'conflict');
  // The list is an upper bound AND a sample; the UI says so only because
  // this flag says so.
  assert.equal(out.mergeabilityFilesComplete, false);
});

test('a failed file prediction still records the conflict', async () => {
  const pool = fakePool();
  const gh = fakeGh({
    async getPR() { return { mergeable: false }; },
    async compareRefs() { throw new Error('502 from GitHub'); },
  });
  const out = await svc.refreshFreshness({ gh, pool }, session(), { force: true });
  assert.equal(out.mergeability, 'conflict', 'knowing WHICH files is optional');
  assert.deepEqual(out.mergeabilityFiles, []);
  assert.equal(out.mergeabilityFilesComplete, null);
});

// ── 'unknown' is never 'clean' ─────────────────────────────────────────

test('mergeable:null reads unknown, and never clears a known conflict', async () => {
  const pool = fakePool();
  const gh = fakeGh({ async getPR() { return { mergeable: null }; } });

  const first = await svc.refreshFreshness({ gh, pool }, session(), { force: true });
  assert.equal(first.mergeability, 'unknown', 'lazily-computed is not clean');

  const known = session({ mergeability: 'conflict' });
  const second = await svc.refreshFreshness({ gh, pool }, known, { force: true });
  assert.equal(second.mergeability, 'conflict',
    'a null answer must not revert a proposal to looking mergeable');
});

test('a getPR failure holds a known conflict and otherwise says unknown', async () => {
  const pool = fakePool();
  const gh = fakeGh({ async getPR() { throw new Error('403 rate limited'); } });
  const a = await svc.refreshFreshness({ gh, pool }, session(), { force: true });
  assert.equal(a.mergeability, 'unknown');
  const b = await svc.refreshFreshness({ gh, pool }, session({ mergeability: 'conflict' }), { force: true });
  assert.equal(b.mergeability, 'conflict');
});

test('a proposal with no PR number is unknown, not clean', async () => {
  const pool = fakePool();
  const gh = fakeGh();
  const out = await svc.refreshFreshness({ gh, pool }, session({ pr_number: null }), { force: true });
  assert.equal(out.mergeability, 'unknown');
  assert.equal(gh.calls.filter((c) => c[0] === 'getPR').length, 0);
});

// ── The second staleness axis: the base the checks ran on ──────────────

test('checksBaseVerdict answers for free when the base IS main', async () => {
  const gh = fakeGh({
    async compareCommitAncestry() { throw new Error('should not be called'); },
  });
  const main = 'a'.repeat(40);
  const v = await svc._checksBaseVerdict(gh, 'o', 'r', main, main, 'b'.repeat(40));
  assert.deepEqual(v, { verdict: 'current', behindBy: 0 });
});

test('checksBaseVerdict: contained base is current, dropped base is superseded', async () => {
  const ahead = fakeGh({
    async compareCommitAncestry() { return { status: 'ahead', aheadBy: 12, behindBy: 0, mergeBaseSha: null }; },
  });
  const v1 = await svc._checksBaseVerdict(ahead, 'o', 'r', 'd'.repeat(40), 'a'.repeat(40), null);
  assert.equal(v1.verdict, 'current', 'main moved on, but still contains that base');
  assert.equal(v1.behindBy, 12);

  const diverged = fakeGh({
    async compareCommitAncestry() { return { status: 'diverged', aheadBy: 12, behindBy: 3, mergeBaseSha: null }; },
  });
  const v2 = await svc._checksBaseVerdict(diverged, 'o', 'r', 'd'.repeat(40), 'a'.repeat(40), null);
  assert.equal(v2.verdict, 'superseded');
  assert.equal(v2.behindBy, 12);
});

test('no recorded base means unknown, which is not current', async () => {
  const gh = fakeGh();
  const v = await svc._checksBaseVerdict(gh, 'o', 'r', null, 'a'.repeat(40), null);
  assert.deepEqual(v, { verdict: 'unknown', behindBy: null });
});

test('refresh carries the base verdict onto the written row', async () => {
  const pool = fakePool();
  const gh = fakeGh({
    async compareCommitAncestry(owner, repo, base, head) {
      // The checks-base compare is the one whose base is the recorded sha.
      if (base === 'd'.repeat(40)) {
        return { status: 'diverged', aheadBy: 12, behindBy: 1, mergeBaseSha: null };
      }
      return { status: 'diverged', aheadBy: 8, behindBy: 8, mergeBaseSha: 'b'.repeat(40) };
    },
  });
  const out = await svc.refreshFreshness(
    { gh, pool }, session({ checks_base_sha: 'd'.repeat(40) }), { force: true }
  );
  assert.equal(out.checksBaseVerdict, 'superseded');
  assert.equal(out.checksBaseBehindBy, 12);
  assert.equal(out.checksRanOnBase, 'd'.repeat(40));
});

test('a failed checks-base compare degrades to unknown, not current', async () => {
  const pool = fakePool();
  let n = 0;
  const gh = fakeGh({
    async compareCommitAncestry() {
      n += 1;
      if (n === 1) return { status: 'diverged', aheadBy: 8, behindBy: 8, mergeBaseSha: 'b'.repeat(40) };
      throw new Error('502');
    },
  });
  const out = await svc.refreshFreshness(
    { gh, pool }, session({ checks_base_sha: 'd'.repeat(40) }), { force: true }
  );
  assert.equal(out.checksBaseVerdict, 'unknown');
  assert.equal(out.checksBaseBehindBy, null);
  assert.equal(out.behindBy, 8, 'the rest of the measurement survives');
});

// ── Never throws, and a failure keeps the previous numbers ─────────────

test('GitHub unreachable: records the reason, keeps the old numbers', async () => {
  const pool = fakePool();
  const gh = fakeGh({ async getRepoHead() { throw new Error('getaddrinfo ENOTFOUND api.github.com'); } });
  const s = session({
    mergeability: 'conflict', freshness_behind_by: 8,
    mergeability_files: ['dapp.json'],
  });
  const out = await svc.refreshFreshness({ gh, pool }, s, { force: true });

  assert.match(out.error, /ENOTFOUND/);
  assert.equal(out.mergeability, 'conflict', 'a failure must not look like good news');
  assert.equal(out.behindBy, 8);
  assert.deepEqual(out.mergeabilityFiles, ['dapp.json']);

  // It stamps checked_at so the sweeper does not spin on this row, and
  // touches nothing else.
  const w = pool.last();
  assert.match(w.sql, /freshness_checked_at = NOW\(\), freshness_error = \$2/);
  assert.equal(w.params[0], 3590);
});

test('a default branch with no commits is an error, not a measurement', async () => {
  const pool = fakePool();
  const gh = fakeGh({ async getRepoHead() { return { defaultBranch: 'main', headSha: null }; } });
  const out = await svc.refreshFreshness({ gh, pool }, session(), { force: true });
  assert.match(out.error, /no commits/);
});

test('a failing write is reported, never thrown', async () => {
  const gh = fakeGh();
  const pool = {
    async query() { throw new Error('deadlock detected'); },
  };
  const out = await svc.refreshFreshness({ gh, pool }, session(), { force: true });
  assert.match(out.error, /deadlock/);
});

test('every plausible GitHub explosion comes back as a value', async () => {
  const pool = fakePool();
  const boom = () => { throw new Error('boom'); };
  const shapes = [
    { getRepoHead: boom },
    { compareCommitAncestry: boom },
    { getPR: boom },
    { compareRefs: boom },
    { getRepoHead: async () => null },
    { compareCommitAncestry: async () => ({}) },
    { getPR: async () => null },
  ];
  for (const shape of shapes) {
    const out = await svc.refreshFreshness({ gh: fakeGh(shape), pool }, session(), { force: true });
    assert.equal(typeof out, 'object', 'resolved rather than rejected');
  }
});

test('missing deps do not throw', async () => {
  assert.equal((await svc.refreshFreshness(null, session())).skipped, 'incomplete_session');
  assert.equal((await svc.refreshFreshness({}, null)).skipped, 'incomplete_session');
});

// ── Dedup: concurrent readers share one refresh ────────────────────────

test('concurrent refreshes on one session collapse to a single pass', async () => {
  const pool = fakePool();
  let heads = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const gh = fakeGh({
    async getRepoHead(owner, repo) {
      heads += 1;
      await gate;
      return { defaultBranch: 'main', headSha: 'a'.repeat(40) };
    },
  });
  const s = session();
  const a = svc.refreshFreshnessDeduped({ gh, pool }, s, { force: true });
  const b = svc.refreshFreshnessDeduped({ gh, pool }, s, { force: true });
  assert.equal(a, b, 'the second caller waits on the first');
  release();
  await Promise.all([a, b]);
  assert.equal(heads, 1);
  assert.equal(pool.queries.length, 1);
  assert.equal(svc._inFlight.size, 0, 'the entry is cleared when it settles');
});

test('a later refresh is not blocked by the earlier one having finished', async () => {
  const pool = fakePool();
  const gh = fakeGh();
  const s = session();
  await svc.refreshFreshnessDeduped({ gh, pool }, s, { force: true });
  await svc.refreshFreshnessDeduped({ gh, pool }, s, { force: true });
  assert.equal(pool.queries.length, 2);
});

test('a session with no id still refreshes', async () => {
  const pool = fakePool();
  const gh = fakeGh();
  const out = await svc.refreshFreshnessDeduped({ gh, pool }, session({ id: undefined }), { force: true });
  assert.equal(out.mergeability, 'clean');
});

// ── The head a measurement is about ───────────────────────────────────

test('an imported PR is authoritative about its own head', () => {
  assert.equal(
    svc._headShaOf({ source: 'imported', imported_pr_head_sha: 'A'.repeat(40), reviewed_head_sha: 'b'.repeat(40) }),
    'a'.repeat(40)
  );
  assert.equal(
    svc._headShaOf({ source: 'session', reviewed_head_sha: 'c'.repeat(40) }),
    'c'.repeat(40)
  );
  assert.equal(svc._headShaOf({}), null);
  assert.equal(svc._headShaOf(null), null);
});
