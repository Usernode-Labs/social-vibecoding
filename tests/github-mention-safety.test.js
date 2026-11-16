// #723: platform usernames must never reach GitHub as live @mentions —
// GitHub would notify whatever unrelated account owns the matching handle.
// github.js's safeMention (ZWSP after `@`) already guards every github.js
// write helper; these tests pin down the boundaries that used to bypass it
// plus the attribution strings that used to render `@username`:
//
//  1. safeMention itself (the sanitizer's contract),
//  2. (gone) the agent-reported platform-issue confirm path: the session
//     Mayor's draft card that fed it is retired, and the route with it,
//  3. (gone) the platform-target feedback path: since 26 Oct 2026 a request
//     is a row on Homeroom's own board (services/requests.js), not a GitHub
//     issue, so its title and body never reach GitHub's linker and are no
//     longer sanitized,
//  4. pushFiles (services/github.js) — commit messages are sanitized (a
//     user-controlled app name like "@someone" reaches it via rename PRs),
//  5. createRevertPR (routes/votes.js) — the revert PR body writes the
//     deciding voter as `name` (backticks), never @name.
//
// Run with: node --test tests/github-mention-safety.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Stubs installed BEFORE the subject modules load ──────────────────────

const poolMod = require('../src/db/pool');
let poolHandler = async () => ({ rows: [], rowCount: 0 });
poolMod.getPool = () => ({
  query: (sql, params) => poolHandler(String(sql), params),
});

const github = require('../src/services/github');
github.isEnabled = () => true;
// The GitHub App, installed on the platform repository's owner: the only
// GitHub credential (services/github.js "Who Homeroom is on GitHub").
github._setAppForTests({
  eachInstallation: { async *iterator() { yield { installation: { id: 1, account: { login: 'Usernode-Labs' } } }; } },
  octokit: { auth: async () => ({ token: 'test-installation-token' }) },
});

const ZWSP = '​';

// Serve octokit's Git Data endpoints for the pushFiles test; pass
// everything else (the tests' own localhost requests) through to the real
// fetch.
const realFetch = global.fetch;
let gitCommitMessages = [];
global.fetch = async (url, opts = {}) => {
  const u = decodeURIComponent(String(url));
  if (u.includes('api.github.com')) {
    const method = (opts.method || 'GET').toUpperCase();
    // Git Data API surface pushFiles walks: getRef → getCommit →
    // createTree → createCommit → updateRef.
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/git/ref/')) return json({ object: { sha: 'base-sha' } });
    if (u.includes('/git/commits/')) return json({ sha: 'base-sha', tree: { sha: 'base-tree' } });
    if (u.endsWith('/git/trees') && method === 'POST') return json({ sha: 'new-tree' }, 201);
    if (u.endsWith('/git/commits') && method === 'POST') {
      const body = JSON.parse(opts.body);
      gitCommitMessages.push(body.message);
      return json({ sha: 'new-commit', tree: { sha: 'new-tree' } }, 201);
    }
    if (u.includes('/git/refs/')) return json({ object: { sha: 'new-commit' } });
    return json({}, 200);
  }
  return realFetch(url, opts);
};

const votes = require('../src/routes/votes');

// A posted string is "mention-safe" when no `@` is directly followed by a
// word character — exactly what GitHub's linker needs to skip it.
function assertMentionSafe(s, label) {
  assert.ok(!/@[A-Za-z0-9_-]/.test(s), `${label} carries a live @mention: ${JSON.stringify(s)}`);
}

// ── 1. safeMention contract ──────────────────────────────────────────────

test('safeMention neutralizes every @handle with a ZWSP and passes non-strings through', () => {
  assert.equal(github.safeMention('@evan'), `@${ZWSP}evan`);
  assert.equal(github.safeMention('cc @a and @b-c'), `cc @${ZWSP}a and @${ZWSP}b-c`);
  assert.equal(github.safeMention('no handles here'), 'no handles here');
  assert.equal(github.safeMention(''), '');
  assert.equal(github.safeMention(null), null);
  assert.equal(github.safeMention(undefined), undefined);
});

// ── 2. agent-reported platform issue (sessions confirm) ─────────────────
// Removed: it pinned the backticked attribution the confirm route wrote. The
// session Mayor's platform-issue draft card, and that route, are retired.

// ── 3. platform-target feedback ──────────────────────────────────────────
// Removed: it pinned safeMention on the title and body of the GitHub issue
// platform feedback filed. Feedback files a request row now and never
// reaches GitHub (tests/feedback-custom-title.test.js and its neighbours
// cover the filing itself).

// ── 4. pushFiles commit messages ─────────────────────────────────────────

test('pushFiles sanitizes the commit message (user-controlled app names reach it)', async () => {
  gitCommitMessages = [];
  await github.pushFiles('Usernode-Labs', 'social-vibecoding', [{ path: 'dapp.json', content: '{}' }], {
    branch: 'main',
    message: 'Rename to "@someone"',
  });
  assert.equal(gitCommitMessages.length, 1);
  assert.equal(gitCommitMessages[0], `Rename to "@${ZWSP}someone"`);
  assertMentionSafe(gitCommitMessages[0], 'commit message');
});

// ── 5. revert PR body ────────────────────────────────────────────────────

test('createRevertPR writes the deciding voter backticked, never as @username', async () => {
  const docker = require('../src/services/docker');
  const origExec = docker.execFileAsync;
  const origCreatePR = github.createPR;
  let createdPR = null;
  docker.execFileAsync = async () => ({ stdout: '', stderr: '' });
  github.createPR = async (owner, repo, opts) => {
    createdPR = opts;
    return { number: 33, html_url: 'https://github.com/o/r/pull/33' };
  };
  try {
    const out = await votes.createRevertPR({
      session: { id: 5, app_id: 1, branch_name: 'dev/x', pr_number: 12, pr_title: 'Add thing' },
      mergeSha: 'abc1234',
      repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
      deciderUsername: 'evan',
    });
    assert.equal(out.prNumber, 33);
    assert.ok(createdPR, 'createPR was called');
    assert.ok(createdPR.body.includes('deciding vote cast by `evan`'),
      `decider not backtick-wrapped: ${createdPR.body}`);
    assert.ok(!createdPR.body.includes('@evan'), 'revert body still uses @username');
    assertMentionSafe(createdPR.body, 'revert PR body');
  } finally {
    docker.execFileAsync = origExec;
    github.createPR = origCreatePR;
  }
});
