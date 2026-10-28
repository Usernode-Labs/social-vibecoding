'use strict';

// A proposal whose code did not come across when Homeroom moved off GitHub:
// "code missing" (src/services/code-missing.js).
//
// The boot migration gave every proposal open at the move a native pull
// request under its old branch name (native_pulls), and most of those
// branches only ever existed on GitHub. Until one is pushed back under the
// same name, its sweeps failed and warned every few minutes ("Cannot compare
// main...<branch>") and its card said nothing. Pinned here, against real git
// (only the mirror's clone is stubbed: every question is git's own answer):
//
//   - detection, derived and never stored: an open pull request on the git
//     host whose head branch is not there, from the pull request's own read
//     (native-pulls `code_missing`) and from a list's one branch read per
//     repository, cached; pushing the branch back clears it by itself, and an
//     unreadable mirror says nothing is missing;
//   - the payloads that carry it (the board's proposals, a proposal's page,
//     the Communities Needs you feed);
//   - the merge gate refusing with the reason before it diffs anything, a
//     merge refused in its own words, the vote's settle asking for no merge,
//     and the review sweep and the explicit-approval re-verify passing over
//     it without a warning.
//
// Run with: node --test tests/proposal-code-missing.test.js

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function stub(rel, exports) {
  const id = require.resolve(path.join(ROOT, rel));
  const prev = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  return () => { if (prev) require.cache[id] = prev; else delete require.cache[id]; };
}

// Every warning any module here writes, so "quietly" is an assertion.
const warned = [];
stub('src/services/logger.js', {
  debug() {}, info() {}, error() {},
  warn: (scope, msg, data) => warned.push({ scope, msg, data }),
});

// The git host: apps on it are addressed https://git.example.test/apps/<slug>.
const priorEnv = { url: process.env.GIT_HOST_URL, org: process.env.GIT_HOST_ORG };
process.env.GIT_HOST_URL = 'https://git.example.test';
process.env.GIT_HOST_ORG = 'apps';
after(() => {
  if (priorEnv.url === undefined) delete process.env.GIT_HOST_URL; else process.env.GIT_HOST_URL = priorEnv.url;
  if (priorEnv.org === undefined) delete process.env.GIT_HOST_ORG; else process.env.GIT_HOST_ORG = priorEnv.org;
});

const HOSTED = 'https://git.example.test/apps/x-1';
const ON_GITHUB = 'https://github.com/Usernode-Labs/social-vibecoding';

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

// The app's repository as the git host has it: main, and one proposal branch
// that came across (dev/kept). dev/gone is the branch that did not.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-missing-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'user.email', 'test@usernode.invalid');
  git(dir, 'config', 'user.name', 'Homeroom Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'main, rebuilt from the running image');
  const main = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'dev/kept');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'a proposal that came across');
  const kept = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  return {
    dir, main, kept,
    // Restoring a proposal: its branch pushed back under the same name.
    pushBack(branch) { git(dir, 'branch', branch, kept); return git(dir, 'rev-parse', branch); },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Only the clone is stubbed: the mirror is the repository above, and every
// plumbing call on it runs for real.
const mirror = require('../src/services/repo-mirror');
const realEnsure = mirror.ensureMirror;
const reads = { dir: null, count: 0, fail: false };
mirror.ensureMirror = async () => {
  reads.count += 1;
  if (reads.fail) throw new Error('the git host did not answer');
  return reads.dir;
};
after(() => { mirror.ensureMirror = realEnsure; });

const codeMissing = require('../src/services/code-missing');

// A pool that answers the pull-request read the list helper makes, from
// `pulls` ({ app_id, number, head_branch, state, merged }), and records the rest.
function pullsPool(pulls, more = () => undefined) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql: String(sql), params });
      if (/FROM native_pulls np/.test(sql)) {
        const [apps, numbers] = params;
        return {
          rows: pulls.filter((p) => p.state === 'open' && !p.merged
            && apps.some((a, i) => a === p.app_id && numbers[i] === p.number)),
        };
      }
      const rows = more(String(sql), params);
      return { rows: rows || [] };
    },
  };
}

const PULLS = [
  { app_id: 7, number: 11, head_branch: 'dev/gone', state: 'open', merged: false },
  { app_id: 7, number: 12, head_branch: 'dev/kept', state: 'open', merged: false },
  { app_id: 7, number: 14, head_branch: 'dev/gone', state: 'closed', merged: true },
  { app_id: 9, number: 13, head_branch: 'dev/gone', state: 'open', merged: false },
];
const SESSIONS = [
  { id: 1, app_id: 7, pr_number: 11, status: 'promoted', repo_url: HOSTED },
  { id: 2, app_id: 7, pr_number: 12, status: 'promoted', repo_url: HOSTED },
  // Merged: its pull request is closed, and its code is main's.
  { id: 4, app_id: 7, pr_number: 14, status: 'merged', repo_url: HOSTED },
  // The platform's own app is on GitHub: never code missing here.
  { id: 3, app_id: 9, pr_number: 13, status: 'promoted', repo_url: ON_GITHUB },
  // Underway, with its pull request: the same rule.
  { id: 5, app_id: 7, pr_number: 11, status: 'paused', repo_url: HOSTED },
  // No pull request at all: nothing to say.
  { id: 6, app_id: 7, pr_number: null, status: 'active', repo_url: HOSTED },
];

test('detection: an open pull request on the git host whose branch is not there, and nothing else', () => {
  assert.equal(codeMissing.fromHeads({ state: 'open', merged: false }, { head: null, base: 'b'.repeat(40) }), true,
    'main resolved, the head did not: the branch is not on the git host');
  assert.equal(codeMissing.fromHeads({ state: 'open', merged: false }, { head: 'a'.repeat(40), base: 'b'.repeat(40) }), false);
  assert.equal(codeMissing.fromHeads({ state: 'open', merged: false }, { head: null, base: null }), false,
    'a read that could not reach the mirror resolves neither, and says nothing');
  assert.equal(codeMissing.fromHeads({ state: 'closed', merged: true }, { head: null, base: 'b'.repeat(40) }), false);
  assert.equal(codeMissing.fromHeads({ state: 'closed', merged: false }, { head: null, base: 'b'.repeat(40) }), false);
  assert.equal(codeMissing.applies({ pr_number: 11, status: 'promoted', repo_url: HOSTED }), true);
  assert.equal(codeMissing.applies({ pr_number: 11, status: 'promoted', repo_url: ON_GITHUB }), false);
  assert.equal(codeMissing.applies({ pr_number: 11, status: 'merged', repo_url: HOSTED }), false);
  assert.equal(codeMissing.applies({ pr_number: null, status: 'active', repo_url: HOSTED }), false);
  assert.equal(codeMissing.isError(codeMissing.error()), true);
  assert.equal(codeMissing.isError(new Error('Cannot compare main...x')), false);
  // No column: the flag is derived on every read, so nothing stores it.
  assert.doesNotMatch(read('src/db/schema.sql'), /code_missing/);
});

test('a list reads one branch list per repository, cached, and a branch pushed back clears the flag by itself', async () => {
  const r = repo();
  reads.dir = r.dir; reads.count = 0; reads.fail = false;
  codeMissing._resetForTests();
  const realNow = Date.now;
  try {
    const pool = pullsPool(PULLS);
    const missing = await codeMissing.missingIds(pool, SESSIONS);
    assert.deepEqual([...missing].sort(), [1, 5], 'the open proposals whose branch did not come across');
    assert.equal(reads.count, 1, 'one read of the repository for the whole list');
    assert.equal(pool.seen.filter((q) => /native_pulls/.test(q.sql)).length, 1, 'and one query for their pull requests');
    assert.deepEqual(pool.seen[0].params, [[7, 7, 7], [11, 12, 11]],
      'only the rows that can be code missing are asked about: not a merged one, one on GitHub or one with no pull request');

    // Read again a moment later: the answer this process already has.
    assert.deepEqual([...await codeMissing.missingIds(pool, SESSIONS)].sort(), [1, 5]);
    assert.equal(reads.count, 1, 'a list drawn again reads nothing new');
    assert.equal(await codeMissing.forSession(pool, SESSIONS[0], { waitMs: 0 }), true, 'the vote\'s read: from what is known');
    assert.equal(await codeMissing.forSession(pool, SESSIONS[1]), false);
    assert.equal(await codeMissing.forSession(pool, SESSIONS[3]), false, 'on GitHub: not asked at all');

    // The branch is pushed back under its name. Once the answer is a minute
    // old the next read starts a new look and a read after it is clear.
    r.pushBack('dev/gone');
    Date.now = () => realNow() + codeMissing.BRANCHES_TTL_MS + 1000;
    let now = await codeMissing.missingIds(pool, SESSIONS);
    for (let i = 0; i < 100 && now.size; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      now = await codeMissing.missingIds(pool, SESSIONS);
    }
    assert.deepEqual([...now], [], 'nothing to undo: the branch is there, so the code is not missing');
    assert.equal(reads.count, 2, 'one more read, for the stale answer');
  } finally {
    Date.now = realNow;
    codeMissing._resetForTests();
    r.cleanup();
  }
});

test('a mirror that cannot be read says nothing is missing, and asks again only after a wait', async () => {
  const r = repo();
  reads.dir = r.dir; reads.count = 0; reads.fail = true;
  codeMissing._resetForTests();
  warned.length = 0;
  try {
    const pool = pullsPool(PULLS);
    assert.deepEqual([...await codeMissing.missingIds(pool, SESSIONS)], [], 'unknown is not missing');
    assert.deepEqual([...await codeMissing.missingIds(pool, SESSIONS)], []);
    assert.equal(reads.count, 1, 'a failed read is not repeated on every list read');
    assert.deepEqual(warned, [], 'and is not a warning');
    // A list read never fails because of this.
    const broken = { query: async () => { throw new Error('pool gone'); } };
    reads.fail = false;
    codeMissing._resetForTests();
    assert.deepEqual([...await codeMissing.missingIds(broken, SESSIONS)], []);
  } finally {
    reads.fail = false;
    codeMissing._resetForTests();
    r.cleanup();
  }
});

// ── Changes underway ──────────────────────────────────────────────────
//
// Most changes underway at the move had no pull request: their own branch
// is what did not come across. Labelled from the same cached list, and read
// live (branchGone) before a turn, a sync, a promote or a copy runs on one.

// A pool that also says which changes predate their app's move.
function underwayPool(preMove) {
  return pullsPool(PULLS, (sql, params) => (/FROM chat_sessions cs\s+JOIN git_host_moves m/.test(sql)
    ? params[0].filter((id) => preMove.includes(id)).map((id) => ({ id }))
    : undefined));
}

test('a change underway is labelled by its own branch, and only when it predates its app\'s move', async () => {
  const r = repo();
  reads.dir = r.dir; reads.count = 0; reads.fail = false;
  codeMissing._resetForTests();
  try {
    const underway = [
      { id: 21, app_id: 7, pr_number: null, status: 'active', branch_name: 'dev/gone', repo_url: HOSTED },
      { id: 22, app_id: 7, pr_number: null, status: 'paused', branch_name: 'dev/gone', repo_url: HOSTED },
      { id: 23, app_id: 7, pr_number: null, status: 'active', branch_name: 'dev/kept', repo_url: HOSTED },
      // Made after the move: its branch is made at its first turn.
      { id: 24, app_id: 7, pr_number: null, status: 'active', branch_name: 'dev/gone', repo_url: HOSTED },
      // Its pull request is closed: its own branch is read instead.
      { id: 25, app_id: 7, pr_number: 14, status: 'active', branch_name: 'dev/gone', repo_url: HOSTED },
      // On GitHub, or without a branch yet: never.
      { id: 26, app_id: 9, pr_number: null, status: 'active', branch_name: 'dev/gone', repo_url: ON_GITHUB },
      { id: 27, app_id: 7, pr_number: null, status: 'active', branch_name: null, repo_url: HOSTED },
    ];
    assert.equal(codeMissing.applies(underway[0]), true);
    assert.equal(codeMissing.applies(underway[5]), false);
    assert.equal(codeMissing.applies(underway[6]), false);
    assert.equal(codeMissing.applies({ ...underway[0], status: 'promoted' }), false, 'a proposal is read by its pull request');
    const pool = underwayPool([21, 22, 23, 25]);
    const missing = await codeMissing.missingIds(pool, [...SESSIONS, ...underway]);
    assert.deepEqual([...missing].sort((a, b) => a - b), [1, 5, 21, 22, 25]);
    const asked = pool.seen.filter((q) => /JOIN git_host_moves/.test(q.sql));
    assert.equal(asked.length, 1, 'one query for the whole list');
    assert.deepEqual(asked[0].params, [[21, 22, 23, 24, 25]], 'only the changes underway with no open pull request');
    assert.equal(reads.count, 1, 'still one branch read for the repository');
    assert.equal(await codeMissing.forSession(pool, underway[0]), true);
    assert.equal(await codeMissing.forSession(pool, underway[3]), false, 'made after the move');
  } finally {
    codeMissing._resetForTests();
    r.cleanup();
  }
});

test('a change underway is read live before anything runs on it: gone, pushed back, made after the move, unknown', async () => {
  const MAIN = 'b'.repeat(40);
  const refs = new Map([['main', MAIN]]);
  const readCalls = [];
  const readRef = async (repoUrl, ref) => { readCalls.push([repoUrl, ref]); return refs.get(ref) || null; };
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push(String(sql));
      assert.match(String(sql), /cs\.created_at < m\.applied_at/);
      return { rows: Number(params[0]) === 41 ? [{ branch_name: 'dev/old', repo_url: HOSTED }] : [] };
    },
  };
  const change = { id: 41, branch_name: 'dev/old', repo_url: HOSTED };
  assert.equal(await codeMissing.branchGone(pool, change, { readRef }), true, 'main is there and the branch is not');
  assert.deepEqual(readCalls, [[HOSTED, 'dev/old'], [HOSTED, 'main']]);

  // Pushed back under its name: there at the next read, no minute to wait.
  refs.set('dev/old', 'c'.repeat(40));
  assert.equal(await codeMissing.branchGone(pool, change, { readRef }), false);

  // Made after its app moved: no row, and nothing is read on the git host.
  readCalls.length = 0;
  assert.equal(await codeMissing.branchGone(pool, { id: 42, branch_name: 'dev/new', repo_url: HOSTED }, { readRef }), false);
  assert.deepEqual(readCalls, []);

  // No branch yet, or on GitHub: not even a query.
  queries.length = 0;
  assert.equal(await codeMissing.branchGone(pool, { id: 41, branch_name: null, repo_url: HOSTED }, { readRef }), false);
  assert.equal(await codeMissing.branchGone(pool, { id: 41, branch_name: 'dev/old', repo_url: ON_GITHUB }, { readRef }), false);
  assert.deepEqual(queries, []);

  // A read that cannot tell goes on: unknown, never gone.
  refs.delete('dev/old');
  warned.length = 0;
  assert.equal(await codeMissing.branchGone(pool, change, { readRef: async () => { throw new Error('git host down'); } }), null);
  assert.equal(await codeMissing.branchGone(pool, change, { readRef: async () => null }), null, 'no main either: nothing to compare with');
  assert.equal(await codeMissing.branchGone(pool, change, {
    readRef: () => new Promise((resolve) => setTimeout(resolve, 200, null)), waitMs: 20,
  }), null, 'too slow');
  assert.equal(await codeMissing.branchGone({ query: async () => { throw new Error('pool gone'); } }, change, { readRef }), null);
  assert.ok(warned.length >= 2, 'a failed read is logged');

  // What the Mayor is told, and what the change says.
  assert.match(codeMissing.dispatchRefusal(41), /^code_missing: change 41's code didn't come across/);
  assert.match(codeMissing.dispatchRefusal(41), /Do not suggest retrying\. Offer to start a new change from the current version/);
  assert.equal(codeMissing.BRANCH_GONE, "This change's code didn't come across when Homeroom moved off GitHub, so it can't be continued here. "
    + 'Nothing was changed. Start a new change from the current version (its plan comes with it), '
    + "or wait: Homeroom restores the code when GitHub's copy arrives.");
  assert.doesNotMatch(codeMissing.BRANCH_GONE + codeMissing.dispatchRefusal(41), /—/);
});

// native-pulls / native-merge with their database stubbed: the app lookup
// and the pull request's row. The mirror is the real repository above.
function loadNative(row) {
  const restores = [
    stub('src/services/requests.js', { appFor: async () => ({ id: 7, slug: 'x-1' }) }),
    stub('src/services/app-numbers.js', {
      getPool: () => ({
        // The row read (get, squashMerge) and the row written (update's
        // RETURNING) are the same row.
        async query(sql) {
          if (/native_pulls/.test(sql)) return { rows: row ? [{ ...row }] : [] };
          return { rows: [] };
        },
      }),
      next: async () => 1,
    }),
  ];
  for (const rel of ['src/services/native-pulls.js', 'src/services/native-merge.js']) delete require.cache[require.resolve(path.join(ROOT, rel))];
  const pulls = require('../src/services/native-pulls');
  const merge = require('../src/services/native-merge');
  return {
    pulls, merge,
    restore() {
      restores.reverse().forEach((f) => f());
      for (const rel of ['src/services/native-pulls.js', 'src/services/native-merge.js']) delete require.cache[require.resolve(path.join(ROOT, rel))];
    },
  };
}

const pullRow = (head) => ({
  number: 11, title: 'Add two', body: '', head_branch: head, base_branch: 'main', draft: false, state: 'open',
  merged: false, merged_at: null, merge_commit_sha: null, merged_head_sha: null,
  created_at: new Date('2026-10-20T10:00:00Z'), updated_at: new Date('2026-10-20T10:00:00Z'), closed_at: null,
});

test('the pull request\'s own read says it: head.sha null while main is there is `code_missing`', async () => {
  const r = repo();
  reads.dir = r.dir; reads.fail = false;
  const gone = loadNative(pullRow('dev/gone'));
  try {
    const pr = await gone.pulls.get('apps', 'x-1', 11);
    assert.equal(pr.head.ref, 'dev/gone');
    assert.equal(pr.head.sha, null);
    assert.equal(pr.base.sha, r.main);
    assert.equal(pr.code_missing, true);
    assert.equal(codeMissing.fromPull(pr), true);
    assert.equal(pr.state, 'open', 'still an open pull request: nothing about it was changed');
    // A read that does not look at the mirror says nothing.
    const retitled = await gone.pulls.update('apps', 'x-1', 11, { title: 'x' });
    assert.equal(retitled.number, 11);
    assert.equal(retitled.code_missing, false, 'no look, no claim');

    // Merged by Homeroom: refused in its own words, with its code, never
    // worded as "not mergeable" (which the merge path reads as a conflict).
    await assert.rejects(gone.merge.squashMerge({ owner: 'apps', repo: 'x-1', number: 11, pinnedSha: 'a'.repeat(40) }), (err) => {
      assert.equal(codeMissing.isError(err), true);
      assert.equal(err.status, 405);
      assert.equal(err.message, codeMissing.MERGE_REFUSAL);
      assert.doesNotMatch(err.message, /not mergeable|conflict/i);
      return true;
    });
    assert.equal(git(r.dir, 'rev-parse', 'main'), r.main, 'main untouched');
    // And were it to reach the merge path's classifier, it is not a conflict.
    const votes = require('../src/routes/votes');
    assert.notEqual(votes.refusalKind(codeMissing.error(codeMissing.MERGE_REFUSAL), { mergeable: null }), 'conflict');
  } finally { gone.restore(); }

  const kept = loadNative(pullRow('dev/kept'));
  try {
    const pr = await kept.pulls.get('apps', 'x-1', 11);
    assert.equal(pr.head.sha, r.kept);
    assert.equal(pr.code_missing, false);
    reads.fail = true;
    const unread = await kept.pulls.get('apps', 'x-1', 11);
    assert.equal(unread.code_missing, false, 'an unreadable mirror is not code missing');
  } finally {
    reads.fail = false;
    kept.restore();
    r.cleanup();
  }
});

test('a compare of a head that is not on the git host is coded, so a sweep can pass over it', async () => {
  const r = repo();
  reads.dir = r.dir; reads.fail = false;
  const hostedGit = require('../src/services/hosted-git');
  try {
    await assert.rejects(hostedGit.compareRefs('apps', 'x-1', 'main...dev/gone'), (err) => {
      assert.equal(codeMissing.isError(err), true);
      assert.equal(err.status, 404, 'still a 404 for every caller that reads one');
      assert.match(err.message, /^Cannot compare main\.\.\.dev\/gone/);
      return true;
    });
    await assert.rejects(hostedGit.compareRefs('apps', 'x-1', 'nope...dev/gone'), (err) => {
      assert.equal(err.status, 404);
      assert.equal(codeMissing.isError(err), false, 'no main to compare against is a different thing');
      return true;
    });
    const ok = await hostedGit.compareRefs('apps', 'x-1', 'main...dev/kept');
    assert.deepEqual(ok.files, ['a.txt']);
  } finally { r.cleanup(); }
});

// routes/votes.js with only what the merge path reaches outside git stubbed:
// GitHub (isEnabled, and a compare that must never be called), the ws
// broadcasts, the proposal machine and the preview machine.
function loadVotes() {
  const calls = { compare: 0, moves: [], wantMerge: [], previews: [] };
  const restores = [
    stub('src/services/github.js', {
      isEnabled: () => true,
      compareRefs: async () => { calls.compare += 1; throw codeMissing.error('Cannot compare main...dev/gone: dev/gone is not on the git host', { status: 404 }); },
      getFileContent: async () => null,
    }),
    stub('src/services/ws.js', { pushVoteUpdate() {}, pushSessionUpdate() {}, async sendSystemMessage() {}, pushNotificationToUser() {} }),
    stub('src/workflow/platform.ts', {
      async moveReviewHead(p) { calls.moves.push(p); return { status: 'accepted', reply: { epoch: 4 } }; },
      async wantMerge(p) { calls.wantMerge.push(p); return { status: 'accepted' }; },
    }),
    stub('src/services/preview-workflow.js', { async revision(p) { calls.previews.push(p); return { status: 'accepted' }; } }),
    stub('src/services/active-workers.js', { isSessionBusyAnywhere: async () => false, busySessionsAnywhere: async () => new Set() }),
  ];
  const fresh = ['src/routes/votes.js', 'src/services/proposal-scans.js', 'src/services/app-admins.js'];
  for (const rel of fresh) delete require.cache[require.resolve(path.join(ROOT, rel))];
  const votes = require('../src/routes/votes');
  return {
    votes, calls,
    restore() {
      restores.reverse().forEach((f) => f());
      for (const rel of fresh) delete require.cache[require.resolve(path.join(ROOT, rel))];
    },
  };
}

const session = (patch = {}) => ({
  id: 42, app_id: 7, app_slug: 'x-1', source: null, status: 'promoted', repo_url: HOSTED,
  branch_name: 'dev/gone', pr_number: 11, pr_title: 'Add two', user_id: 5,
  reviewed_head_sha: 'a'.repeat(40), checks_commit_sha: 'a'.repeat(40), check_state: 'passing',
  approval_epoch: 3, requires_explicit_approval: null, is_headless: false,
  ...patch,
});

test('the merge gate refuses with the reason before it diffs anything, forced or not; a branch pushed back merges as before', async () => {
  const r = repo();
  reads.dir = r.dir; reads.fail = false;
  const { votes, calls, restore } = loadVotes();
  warned.length = 0;
  try {
    const pool = pullsPool([]);
    const revision = await votes.reconcileNativeReviewedHead({ config: {}, pool, session: session() });
    assert.equal(revision.codeMissing, true);
    assert.equal(revision.unchanged, true, 'not a head move: the approvals stand');
    assert.equal(revision.epoch, 3);
    assert.deepEqual(calls.moves, [], 'nothing asks the proposal machine to move the head over an absence');

    for (const options of [{}, { force: true }]) {
      const out = await votes.evaluateMergeGate({}, pool, session(), options);
      assert.deepEqual(out, {
        merged: false, codeMissing: true, blockReason: 'code_missing', error: codeMissing.MERGE_REFUSAL,
      }, `refused with the reason${options.force ? ' (forced too)' : ''}`);
    }
    assert.equal(calls.compare, 0, 'the explicit-approval re-verify never diffs a head that is not there');
    assert.deepEqual(pool.seen, [], 'nor does the gate read votes or write a recording');
    assert.deepEqual(warned, [], 'and nothing is logged as news');
    assert.match(codeMissing.MERGE_REFUSAL, /code didn't come across when Homeroom moved off GitHub/);

    // On GitHub (the platform's own app) a missing branch is the old case.
    const onGithub = await votes.reconcileNativeReviewedHead({ config: {}, pool, session: session({ repo_url: ON_GITHUB }) });
    assert.equal(onGithub.codeMissing, undefined);
    assert.equal(onGithub.measurementUnavailable, true);

    // A vote on it is recorded (the route's own business), and its settle
    // asks for no merge.
    const settled = await votes.settleVoteInBackground({ config: {}, pool, session: session(), revision: { deferred: true } });
    assert.deepEqual(settled, { merged: false, codeMissing: true });
    assert.deepEqual(calls.wantMerge, [], 'no merge is asked for a proposal with nothing to merge');

    // Pushed back under the same name, at the reviewed commit: the gate goes
    // on to the protected-settings check as it always did.
    const head = r.pushBack('dev/gone');
    const back = await votes.reconcileNativeReviewedHead({ config: {}, pool, session: session({ reviewed_head_sha: head }) });
    assert.equal(back.codeMissing, undefined);
    assert.equal(back.headSha, head);
    await votes.evaluateMergeGate({}, pool, session({ reviewed_head_sha: head })).catch(() => null);
    assert.equal(calls.compare, 1, 'the restored proposal is diffed again');
  } finally {
    restore();
    r.cleanup();
  }
});

test('the review sweep and the explicit-approval re-verify pass over it without a warning', async () => {
  const r = repo();
  reads.dir = r.dir; reads.fail = false;
  const { calls, restore } = loadVotes();
  warned.length = 0;
  try {
    const row = { ...session(), app_name: 'X', app_self_hosted: false };
    const pool = pullsPool([], (sql) => (/WHERE cs\.id = \$1/.test(sql) ? [row] : undefined));
    const scans = require('../src/services/proposal-scans');
    assert.deepEqual(await scans.refreshRevision({}, pool, 42), { skipped: 'code_missing' });
    assert.equal(calls.compare, 0, 'no "Cannot compare main...dev/gone" on every pass');

    // Reached anyway (a sweep from before this one, a stamp on promote): the
    // stored flag stands and nothing warns. Any other failure still does.
    const appAdmins = require('../src/services/app-admins');
    assert.equal(await appAdmins.sweepExplicitApproval(pool, { ...row, requires_explicit_approval: true }), true);
    assert.equal(await appAdmins.refreshExplicitApproval(pool, row, row), null);
    assert.equal(calls.compare, 2);
    assert.deepEqual(warned, [], 'quiet, pass after pass');
    const github = require('../src/services/github');
    github.compareRefs = async () => { throw new Error('socket hang up'); };
    assert.equal(await appAdmins.sweepExplicitApproval(pool, { ...row, requires_explicit_approval: true }), true);
    assert.equal(warned.length, 1, 'a real failure is still said');
  } finally {
    restore();
    r.cleanup();
  }
});

test('the lists carry it: the board\'s proposals, a proposal\'s page and the Communities Needs you', async () => {
  const r = repo();
  reads.dir = r.dir; reads.fail = false;
  codeMissing._resetForTests();
  try {
    // The Needs you feed: marked from the same helper, carried only when set.
    const overview = require('../src/routes/workshop-overview');
    const app = { slug: 'x-1', name: 'X', icon_image_id: null, icon_emoji: null };
    const rows = [
      { kind: 'proposal', id: 1, app_id: 7, number: 11, status: 'promoted', repo_url: HOSTED, title: 'Gone', ...app },
      { kind: 'proposal', id: 2, app_id: 7, number: 12, status: 'promoted', repo_url: HOSTED, title: 'Kept', ...app },
      { kind: 'governance', id: 3, app_id: 7, number: null, status: null, repo_url: HOSTED, title: 'Rename', ...app },
    ];
    await overview.withCodeMissing(pullsPool(PULLS), rows);
    const items = overview.shapeNeedsFeed(rows);
    assert.equal(items[0].codeMissing, true);
    assert.equal('codeMissing' in items[1], false, 'an unmarked row carries no flag at all');
    assert.equal('codeMissing' in items[2], false);
    const feed = read('src/routes/workshop-overview.js');
    assert.match(feed, /await withCodeMissing\(pool, rows\);\s*await withPictures\(/, 'marked before "What it touches" is read');
    assert.match(feed, /head: r\.code_missing \? null : visualHeadForSession\(r\),/, 'and no read is started for a head that is not there');
  } finally {
    codeMissing._resetForTests();
    r.cleanup();
  }

  // The board's proposals and a proposal's own page: derived on every read,
  // one query and one branch list for the whole panel.
  const src = read('src/routes/votes.js');
  const promoted = src.slice(src.indexOf("router.get('/api/apps/:slug/promoted'"), src.indexOf("router.get('/api/apps/:slug/merged'"));
  assert.match(promoted, /const missing = await codeMissing\.missingIds\(pool, rows\.map\(\(row\) => \(\{\s*id: row\.id, app_id: gatedApp\.id, pr_number: row\.pr_number, status: row\.status, repo_url: gatedApp\.repo_url,/);
  assert.match(promoted, /for \(const row of rows\) row\.code_missing = missing\.has\(Number\(row\.id\)\);/);
  assert.match(promoted, /head: row\.code_missing \? null : visualHeadForSession\(row\),/);
  const byId = src.slice(src.indexOf("router.get('/api/apps/:slug/proposals/:id'"), src.indexOf("router.post('/api/sessions/:id/undo'"));
  assert.match(byId, /'view', `\$\{appAccess\.ACCESS_COLUMNS\}, repo_url`/);
  assert.match(byId, /proposal\.code_missing = await codeMissing\.forSession\(pool, \{\s*\.\.\.proposal, app_id: gatedApp\.id, repo_url: gatedApp\.repo_url,/);
  // A vote is recorded and says it cannot go live, from what is known (no
  // git read in front of the answer); an admin's force merge is refused.
  const vote = src.slice(src.indexOf("router.post('/api/sessions/:id/vote'"), src.indexOf("router.delete('/api/sessions/:id/vote'"));
  assert.match(vote, /const codeMissingNote = await codeMissing\.forSession\(pool, session, \{ waitMs: 0 \}\)\s*\? \{ codeMissing: true, message: codeMissing\.VOTE_NOTE \} : \{\};\s*const readyCard = \{ \.\.\.\(goesLive \? \{ goesLive \} : \{\}\), \.\.\.codeMissingNote \};/,
    'every answer to a recorded vote carries it (they all spread readyCard)');
  assert.ok(vote.indexOf('codeMissing.forSession') > vote.indexOf('const recorded = await recordVote('), 'after the vote is recorded');
  const force = src.slice(src.indexOf("router.post('/api/sessions/:id/admin-merge'"));
  assert.match(force, /if \(await codeMissing\.forSession\(pool, session\)\) \{\s*return res\.status\(409\)\.json\(\{ error: codeMissing\.MERGE_REFUSAL, code: codeMissing\.CODE \}\);/);
  assert.ok(force.indexOf('codeMissing.forSession') < force.indexOf('forceMerge('), 'before the merge is queued');
  // The merge path's own refusal, for a branch gone after the gate.
  assert.match(src, /if \(codeMissing\.isError\(err\)\) \{\s*return \{ outcome: 'refused', kind: 'blocked', codeMissing: true,/);
});

// ── The other doors into a change underway, and the way on ─────────────

test('a promote of a change whose branch did not come across says so, before any pull request or title is made', async () => {
  const { proposalServices } = require('../src/workflow/proposal/services.ts');
  const { WORK } = require('../src/workflow/proposal/machine.ts');
  const realGone = codeMissing.branchGone;
  const row = {
    id: 61, app_id: 7, user_id: 3, status: 'active', source: null, branch_name: 'dev/gone', repo_url: HOSTED,
    pr_number: null, pr_title: null, linked_issues: [], issue_link_seeded: true,
  };
  const asked = [];
  const pool = {
    async query(sql) {
      asked.push(String(sql));
      if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) return { rows: [{ ...row }] };
      return { rows: [] };
    },
  };
  try {
    codeMissing.branchGone = async (p, s) => (Number(s.id) === 61 ? true : realGone(p, s));
    const err = await proposalServices({ config: {}, pool })[WORK.open].run({ input: { sessionId: 61, n: 1, userId: 3 } })
      .then(() => null, (e) => e);
    assert.ok(err, 'refused');
    assert.equal(err.code, 'code_missing');
    assert.equal(err.message, codeMissing.BRANCH_GONE);
    assert.equal(err.permanent, true, 'not retried: it is the same every time');
    assert.doesNotMatch(err.message, /no committed code|Re-run your request/);
    assert.equal(asked.filter((s) => !/FROM chat_sessions cs JOIN apps a/.test(s)).length, 0,
      'nothing else read or written: no title generated, no request linked');
  } finally {
    codeMissing.branchGone = realGone;
  }
  // Answered as a refusal with its code, not as "GitHub unavailable".
  const platform = read('src/workflow/platform.ts');
  assert.match(platform, /if \(a\.code === 'code_missing'\) return \{ status: 409, body: \{ error: a\.message, code: 'code_missing' \} \};/);
  assert.match(platform, /\['session_state_changed', 409\], \['code_missing', 409\],/);
});

test('a copy of an auto run, a CLI hand-off upload and a local agent\'s upload refuse with code_missing, not a fallback or a 503', () => {
  const sessions = read('src/routes/sessions.js');
  const clone = sessions.slice(sessions.indexOf("router.post('/api/sessions/:id/clone-headless'"));
  const refusedAt = clone.indexOf('if (await codeMissing.branchGone(pool, src) === true) {');
  assert.ok(refusedAt > 0, 'the copy reads the run\'s branch live');
  for (const later of ['sessionLifecycle.freeUserSlot(', 'sessionLifecycle.claimGlobalSlot(', "op: 'branch.ensure'"]) {
    assert.ok(refusedAt < clone.indexOf(later), `before ${later}: no slot, no branch off main`);
  }
  assert.match(clone.slice(refusedAt, refusedAt + 200), /return res\.status\(409\)\.json\(\{ error: codeMissing\.BRANCH_GONE, code: codeMissing\.CODE \}\);/);

  for (const rel of ['src/routes/proposal-handoff.js', 'src/routes/cli-agent.js']) {
    const src = read(rel);
    const upload = src.slice(src.indexOf('github.createProposalCommit('));
    const gone = upload.indexOf('if (err.status === 404 && await codeMissing.branchGone(pool, session) === true) {');
    assert.ok(gone > 0, `${rel}: a 404 is read for what it is`);
    assert.ok(gone < upload.indexOf('githubBudget.githubUnavailableBody(err)'), `${rel}: before the 503`);
    assert.match(upload.slice(gone, gone + 220), /return res\.status\(409\)\.json\(\{ error: codeMissing\.CODE, message: codeMissing\.BRANCH_GONE \}\);/);
  }
});

test('the way on: start_change carries a change\'s plan to a new change with its own branch, never the old one', () => {
  const tools = read('src/services/mcp-tools.js');
  const start = tools.slice(tools.indexOf("server.registerTool('start_change'"), tools.indexOf("server.registerTool('promote_change'"));
  assert.match(start, /fromChangeId: z\.number\(\)\.int\(\)\.positive\(\)\.max\(2147483647\)\.optional\(\)/);
  assert.match(start, /\.\.\.\(fromChangeId \? \{ fromChangeId \} : \{\}\),/);
  // A refusal's code beside its sentence reaches the Mayor as that code.
  assert.match(tools, /const besideCode = !coded && typeof body\.code === 'string' && \/\^\[a-z_\]\+\$\/\.test\(body\.code\) \? body\.code : null;/);

  const sessions = read('src/routes/sessions.js');
  const route = sessions.slice(sessions.indexOf("router.post('/api/apps/:slug/sessions'"),
    sessions.indexOf("router.post('/api/apps/:slug/issues/:number/headless-session'"));
  const fromAt = route.indexOf('SELECT id, spec_md, spec_html FROM chat_sessions');
  assert.ok(fromAt > 0 && fromAt < route.indexOf('agentSessions.prepareChangeStart('),
    'read, and refused when it is not theirs, before the active change is parked');
  assert.match(route, /WHERE id = \$1 AND app_id = \$2 AND user_id = \$3 AND is_headless = FALSE/, 'one of theirs, on this app');
  assert.match(route, /VALUES \(\$1, \$2, NULL, 'active',/, 'a branch of its own, made from the current version at its first turn');
  assert.match(route, /UPDATE chat_sessions SET spec_md = \$2, spec_html = \$3 WHERE id = \$1/);
  assert.match(route, /INSERT INTO chat_session_specs \(session_id, version, content, content_html\)\s+SELECT \$1, version, content, content_html FROM chat_session_specs WHERE session_id = \$2/);
});
