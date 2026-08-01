// #723: platform usernames must never reach GitHub as live @mentions —
// GitHub would notify whatever unrelated account owns the matching handle.
// github.js's safeMention (ZWSP after `@`) already guards every github.js
// write helper; these tests pin down the boundaries that used to bypass it
// plus the attribution strings that used to render `@username`:
//
//  1. safeMention itself (the sanitizer's contract),
//  2. the agent-reported platform-issue confirm path (routes/sessions.js) —
//     a hand-rolled fetch to api.github.com: attribution is now
//     backtick-wrapped and title/body pass through safeMention,
//  3. the platform-target feedback path (routes/feedback.js) — the same
//     hand-rolled fetch shape: user-typed title/description are sanitized,
//  4. pushFiles (services/github.js) — commit messages are sanitized (a
//     user-controlled app name like "@someone" reaches it via rename PRs),
//  5. createRevertPR (routes/votes.js) — the revert PR body writes the
//     deciding voter as `name` (backticks), never @name.
//
// Run with: node --test tests/github-mention-safety.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.GITHUB_BOT_TOKEN = 'test-pat';

// ── Stubs installed BEFORE the subject modules load ──────────────────────

const poolMod = require('../src/db/pool');
let poolHandler = async () => ({ rows: [], rowCount: 0 });
poolMod.getPool = () => ({
  query: (sql, params) => poolHandler(String(sql), params),
});

// announceIssueCreated runs after an issue is filed (cache overlay + ws
// broadcast) — irrelevant here, stub it out for both routes.
const iaPath = require.resolve('../src/services/issue-announce');
require.cache[iaPath] = {
  id: iaPath, filename: iaPath, loaded: true,
  exports: { announceIssueCreated: async () => {} },
};

// Pass-through collab guard so the sessions router reaches the handler.
const appAccess = require('../src/services/app-access');
appAccess.sessionCollabGuard = () => (req, res, next) => next();

const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};

const ZWSP = '​';

// Capture every POST that would create an issue on api.github.com; serve
// octokit's Git Data endpoints for the pushFiles test; pass everything
// else (the tests' own localhost requests) through to the real fetch.
const realFetch = global.fetch;
let ghIssueCreates = [];
let gitCommitMessages = [];
global.fetch = async (url, opts = {}) => {
  const u = decodeURIComponent(String(url));
  if (u.includes('api.github.com')) {
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/issues') && method === 'POST') {
      ghIssueCreates.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ number: 91, html_url: 'https://github.com/plat/repo/issues/91' }),
        { status: 201, headers: { 'content-type': 'application/json' } });
    }
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

const { sessionRoutes } = require('../src/routes/sessions');
const { feedbackRoutes } = require('../src/routes/feedback');
const votes = require('../src/routes/votes');
const express = require('express');

function startServer(mount) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7, username: 'evan' }; next(); });
  app.use(mount);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function post(server, path, body) {
  const port = server.address().port;
  return realFetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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

test('platform-issue confirm posts backticked attribution and a fully sanitized title/body', async () => {
  ghIssueCreates = [];
  const draft = {
    status: 'pending',
    title: 'Worker breaks when @ghstranger is in the diff',
    body: 'Repro: mention @ghstranger anywhere in a commit.',
  };
  poolHandler = async (sql) => {
    if (/FROM chat_session_messages m/.test(sql)) {
      return {
        rows: [{
          id: 42,
          metadata: { platformIssueDraft: draft },
          app_id: 1, app_slug: 'demo', app_name: 'Demo App',
        }],
      };
    }
    if (/'"filed"'/.test(sql)) return { rowCount: 1, rows: [] };
    return { rows: [], rowCount: 0 };
  };

  const server = await startServer(
    sessionRoutes({ platformRepoUrl: 'https://github.com/plat/repo' })
  );
  try {
    const res = await post(server, '/api/sessions/512/platform-issue/42/confirm', {});
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.status, 'filed');

    assert.equal(ghIssueCreates.length, 1);
    const posted = ghIssueCreates[0];

    // Attribution is backtick-wrapped — no `@` before the username at all.
    assert.ok(posted.body.includes('confirmed by `evan`'),
      `attribution not backtick-wrapped: ${posted.body}`);
    assert.ok(!posted.body.includes('@evan'), 'attribution still uses @username');

    // The model-drafted title/body crossed the raw-fetch boundary through
    // safeMention: the typed @handle survives visually but can't ping.
    assert.ok(posted.title.includes(`@${ZWSP}ghstranger`), 'title not sanitized');
    assert.ok(posted.body.includes(`@${ZWSP}ghstranger`), 'draft body not sanitized');
    assertMentionSafe(posted.title, 'issue title');
    assertMentionSafe(posted.body, 'issue body');
  } finally {
    server.close();
  }
});

// ── 3. platform-target feedback ──────────────────────────────────────────

test('platform feedback sanitizes user-typed title and description before the raw fetch', async () => {
  ghIssueCreates = [];
  poolHandler = async () => ({ rows: [], rowCount: 0 });

  const server = await startServer(
    feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' })
  );
  try {
    const res = await post(server, '/api/feedback', {
      title: 'Ping storm from @ghstranger',
      description: 'Typing @ghstranger in feedback notified them.',
    });
    assert.equal(res.status, 200);

    assert.equal(ghIssueCreates.length, 1);
    const posted = ghIssueCreates[0];
    assert.ok(posted.title.includes(`@${ZWSP}ghstranger`), 'title not sanitized');
    assert.ok(posted.body.includes(`@${ZWSP}ghstranger`), 'description not sanitized');
    // The Source line itself never used `@` — make sure that held.
    assert.match(posted.body, /\*\*Source:\*\* usernode user \(evan\)/);
    assertMentionSafe(posted.title, 'feedback title');
    assertMentionSafe(posted.body, 'feedback body');
  } finally {
    server.close();
  }
});

// ── 4. pushFiles commit messages ─────────────────────────────────────────

test('pushFiles sanitizes the commit message (user-controlled app names reach it)', async () => {
  gitCommitMessages = [];
  await github.pushFiles('o', 'r', [{ path: 'dapp.json', content: '{}' }], {
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
      repoOwner: 'o', repoName: 'r',
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
