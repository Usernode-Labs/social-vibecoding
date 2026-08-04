// Tests for src/services/pr-metadata.js — specifically the #26 fix:
// a PR title/body must reflect ALL the updates on the branch, not just
// the latest dev turn.
//
// We stub out the two collaborators pr-metadata.js requires at load time
// (./llm and ./github) via require.cache so no Anthropic/GitHub calls
// happen, then feed applyPrMetadata a mock pool whose chat_session_messages
// contain several user turns + coding-agent summaries and assert that the
// cumulative history reaches llm.generatePrMetadata.
//
// Run with: node --test tests/pr-metadata.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Install module stubs before requiring the unit under test.
function loadWithStubs({ onGenerate, githubCalls, createPR, summary = '', findOpenPrByBranch }) {
  const llmPath = require.resolve('../src/services/llm');
  const ghPath = require.resolve('../src/services/github');
  const subjectPath = require.resolve('../src/services/pr-metadata');
  const orig = {
    llm: require.cache[llmPath],
    gh: require.cache[ghPath],
    subject: require.cache[subjectPath],
  };

  require.cache[llmPath] = {
    exports: {
      isEnabled: () => true,
      estimateCostCents: () => 0,
      generatePrMetadata: async (args) => {
        onGenerate(args);
        return { title: 'Cumulative title', body: 'Cumulative body', summary, usage: undefined, model: 'claude-haiku-4-5' };
      },
    },
    loaded: true, id: llmPath, filename: llmPath, paths: orig.llm ? orig.llm.paths : [],
  };
  require.cache[ghPath] = {
    exports: {
      createPR: createPR || (async (owner, repo, opts) => { githubCalls.push({ type: 'create', owner, repo, opts }); return { number: 42, html_url: 'https://example/pr/42' }; }),
      updatePR: async (owner, repo, num, opts) => { githubCalls.push({ type: 'update', owner, repo, num, opts }); },
      findOpenPrByBranch: findOpenPrByBranch
        || (async (owner, repo, branch) => { githubCalls.push({ type: 'find', owner, repo, branch }); return null; }),
    },
    loaded: true, id: ghPath, filename: ghPath, paths: orig.gh ? orig.gh.paths : [],
  };
  // Force a fresh load so the stubs are picked up.
  delete require.cache[subjectPath];
  const subject = require('../src/services/pr-metadata');

  const restore = () => {
    if (orig.llm) require.cache[llmPath] = orig.llm; else delete require.cache[llmPath];
    if (orig.gh) require.cache[ghPath] = orig.gh; else delete require.cache[ghPath];
    delete require.cache[subjectPath];
    if (orig.subject) require.cache[subjectPath] = orig.subject;
  };
  return { subject, restore };
}

// A mock pool that returns canned rows per table: chat_session_messages
// (turn history), chat_session_specs (saved spec snapshots), and
// chat_sessions (the live spec_md). UPDATEs are no-ops.
function mockPool(rows, {
  specRows = [], liveSpec = '', linkedIssues = [], appliedIssues = [],
  testingMd = null, testingPath = null, appliedTesting = null,
  appliedSummary = null,
} = {}) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM chat_session_specs/i.test(sql)) return { rows: specRows };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return {
          rows: [{
            spec_md: liveSpec, linked_issues: linkedIssues, pr_linked_issues_applied: appliedIssues,
            testing_md: testingMd, testing_path: testingPath, pr_testing_applied: appliedTesting,
            pr_visuals_applied: null, pr_summary_md: appliedSummary,
          }],
        };
      }
      if (/FROM chat_session_messages/i.test(sql)) return { rows };
      return { rows: [] };
    },
  };
}

test('applyPrMetadata feeds ALL turns (requests + summaries) to the LLM on a PR update', async () => {
  const captured = [];
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: (a) => captured.push(a), githubCalls });
  try {
    const rows = [
      { role: 'user', content: 'Add a login form', metadata: {} },
      { role: 'system', content: 'cc', metadata: { ccOutput: 'Built the login form component' } },
      { role: 'user', content: 'Now add password reset', metadata: {} },
      { role: 'system', content: 'cc', metadata: { ccOutput: 'Added password reset flow' } },
      { role: 'assistant', content: 'CLI handoff: verified the migration path', metadata: { handoffSummary: true } },
      { role: 'user', content: 'Also add remember-me', metadata: {} },
    ];
    const pool = mockPool(rows, {
      // One saved snapshot + a newer live draft; the dupe of the snapshot
      // must be collapsed.
      specRows: [{ content: 'Spec v1: authentication system' }, { content: 'Spec v2: auth + reset' }],
      liveSpec: 'Spec v2: auth + reset',
    });
    const session = { id: 7, branch_name: 'feat/auth', pr_number: 42, pr_url: 'https://example/pr/42', pr_title: 'old title' };

    const res = await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'Also add remember-me',
      ccSummary: 'Wired up the remember-me checkbox',
      username: 'evan',
    });

    assert.equal(captured.length, 1, 'llm.generatePrMetadata called once');
    const { requests, summaries } = captured[0];
    assert.deepEqual(requests, ['Add a login form', 'Now add password reset', 'Also add remember-me'],
      'all user requests passed in order');
    assert.deepEqual(summaries, [
      'Built the login form component',
      'Added password reset flow',
      'CLI handoff: verified the migration path',
      'Wired up the remember-me checkbox',
    ], 'all prior summaries plus the in-flight summary passed in order');

    assert.deepEqual(captured[0].specs, ['Spec v1: authentication system', 'Spec v2: auth + reset'],
      'saved snapshots + live draft passed, exact dupes deduped');

    // Title changed (old title -> Cumulative title) so GitHub gets a PATCH.
    assert.equal(githubCalls.length, 1);
    assert.equal(githubCalls[0].type, 'update');
    assert.equal(githubCalls[0].opts.title, 'Cumulative title');
    assert.equal(res.prTitle, 'Cumulative title');
  } finally {
    restore();
  }
});

test('applyPrMetadata falls back to the single current turn when there is no history', async () => {
  const captured = [];
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: (a) => captured.push(a), githubCalls });
  try {
    // Only the current turn's user row exists (typical first turn / new PR).
    const pool = mockPool([{ role: 'user', content: 'Build a todo app', metadata: {} }]);
    const session = { id: 9, branch_name: 'feat/todo', pr_number: null };

    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'Build a todo app',
      ccSummary: 'Scaffolded the todo app',
      username: 'evan',
    });

    const { requests, summaries } = captured[0];
    assert.deepEqual(requests, ['Build a todo app']);
    assert.deepEqual(summaries, ['Scaffolded the todo app']);
    // New PR path -> createPR.
    assert.equal(githubCalls[0].type, 'create');
  } finally {
    restore();
  }
});

// ---- #75: closing keywords ----

test('no linked issues -> body has no Closes line and is unchanged', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    const pool = mockPool([{ role: 'user', content: 'Build it', metadata: {} }]);
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'Build it', ccSummary: 'Did it', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'create');
    assert.ok(!/Closes #/.test(githubCalls[0].opts.body), 'no closing keyword without linked issues');
    // Body shape is the legacy "<llm body>\n\n---\n_footer_".
    assert.match(githubCalls[0].opts.body, /^Cumulative body\n\n---\n_Dev session by evan via Usernode_$/);
  } finally {
    restore();
  }
});

test('a single linked issue adds one Closes line between body and footer', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    const pool = mockPool([{ role: 'user', content: 'Fix it', metadata: {} }], { linkedIssues: [75] });
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'Fix it', ccSummary: 'Fixed it', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'create');
    assert.equal(
      githubCalls[0].opts.body,
      'Cumulative body\n\nCloses #75\n\n---\n_Dev session by evan via Usernode_'
    );
    // The applied snapshot is persisted on the new-PR write.
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_number/.test(q.sql));
    assert.deepEqual(upd.params[3], [75]);
  } finally {
    restore();
  }
});

test('multiple + malformed linked issues are sanitized, deduped and sorted', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    // Mix of valid, dup, zero, negative, float, and non-numeric inputs.
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }], {
      linkedIssues: [80, 75, 75, 0, -3, 12.5, 'abc', null],
    });
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(
      githubCalls[0].opts.body,
      'Cumulative body\n\nCloses #75\nCloses #80\n\n---\n_Dev session by evan via Usernode_'
    );
  } finally {
    restore();
  }
});

test('regenerating the body is idempotent (no doubled Closes lines)', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    // PR already exists; title will change so an update fires.
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }], {
      linkedIssues: [75], appliedIssues: [75],
    });
    const session = { id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u', pr_title: 'old' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'update');
    const matches = githubCalls[0].opts.body.match(/Closes #75/g) || [];
    assert.equal(matches.length, 1, 'exactly one Closes #75 line');
  } finally {
    restore();
  }
});

test('existing PR updates when the linked-issue set changed even if the title did not', async () => {
  const githubCalls = [];
  // LLM returns 'Cumulative title'; make that the current pr_title so the
  // title-only gate would otherwise skip the GitHub call.
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }], {
      linkedIssues: [75], appliedIssues: [],
    });
    const session = { id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u', pr_title: 'Cumulative title' };
    const res = await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls.length, 1, 'GitHub update fired despite unchanged title');
    assert.equal(githubCalls[0].type, 'update');
    assert.match(githubCalls[0].opts.body, /Closes #75/);
    // The applied snapshot is advanced so the next unchanged turn is a no-op.
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_title/.test(q.sql));
    assert.deepEqual(upd.params[1], [75]);
    assert.equal(res.prNumber, 42);
  } finally {
    restore();
  }
});

test('existing PR makes no GitHub call when title and issue set are both unchanged', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }], {
      linkedIssues: [75], appliedIssues: [75],
    });
    const session = { id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u', pr_title: 'Cumulative title' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls.length, 0, 'no GitHub call when nothing changed');
  } finally {
    restore();
  }
});

test('closing keywords survive safeMention (the GitHub-boundary sanitizer)', async () => {
  const github = require('../src/services/github');
  assert.equal(github.safeMention('Closes #75\nCloses #80'), 'Closes #75\nCloses #80');
});

test('sanitizeIssueNumbers / buildClosingBlock helpers behave', async () => {
  const { sanitizeIssueNumbers, buildClosingBlock } = require('../src/services/pr-metadata');
  assert.deepEqual(sanitizeIssueNumbers([3, 1, 1, 0, -2, 2.5, 'x', null, undefined]), [1, 3]);
  assert.deepEqual(sanitizeIssueNumbers(null), []);
  assert.equal(buildClosingBlock([]), '');
  assert.equal(buildClosingBlock([2, 1]), 'Closes #1\nCloses #2');
});

// ---- #127: How to test ----

test('buildTestingBlock helper behaves', async () => {
  const { buildTestingBlock } = require('../src/services/pr-metadata');
  assert.equal(buildTestingBlock(null, null), '');
  assert.equal(buildTestingBlock('', '  '), '');
  assert.equal(buildTestingBlock('1. Click it.', null), '## How to test\n\n1. Click it.');
  assert.equal(buildTestingBlock(null, '/board'), '## How to test\n\nDeep link: `/board`');
  assert.equal(
    buildTestingBlock('1. Click it.', '/board?d=1'),
    '## How to test\n\n1. Click it.\n\nDeep link: `/board?d=1`'
  );
});

test('testing guidance lands in the body between LLM body and Closes block', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }], {
      linkedIssues: [75], testingMd: '1. Open the board.', testingPath: '/board',
    });
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'create');
    assert.equal(
      githubCalls[0].opts.body,
      'Cumulative body\n\n## How to test\n\n1. Open the board.\n\nDeep link: `/board`\n\nCloses #75\n\n---\n_Dev session by evan via Usernode_'
    );
    // The applied snapshot is persisted on the new-PR write (param after
    // the linked-issues snapshot).
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_number/.test(q.sql));
    assert.equal(upd.params[4], '## How to test\n\n1. Open the board.\n\nDeep link: `/board`');
  } finally {
    restore();
  }
});

test('existing PR updates when testing guidance changed even if title and issues did not', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }], {
      linkedIssues: [75], appliedIssues: [75],
      testingMd: 'New steps.', appliedTesting: '## How to test\n\nOld steps.',
    });
    const session = { id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u', pr_title: 'Cumulative title' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls.length, 1, 'GitHub update fired despite unchanged title + issues');
    assert.equal(githubCalls[0].type, 'update');
    assert.match(githubCalls[0].opts.body, /## How to test\n\nNew steps\./);
    // The applied snapshot is advanced so the next unchanged turn is a no-op.
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_title/.test(q.sql));
    assert.equal(upd.params[2], '## How to test\n\nNew steps.');
  } finally {
    restore();
  }
});

test('existing PR makes no GitHub call when title, issues and testing are all unchanged', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    const applied = '## How to test\n\nSteps.';
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }], {
      linkedIssues: [75], appliedIssues: [75],
      testingMd: 'Steps.', appliedTesting: applied,
    });
    const session = { id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u', pr_title: 'Cumulative title' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls.length, 0, 'no GitHub call when nothing changed');
  } finally {
    restore();
  }
});

// ---- #295 / chat 510: honest error when the branch has no pushed commits ----

test('applyPrMetadata re-throws createPR "no_commits" so the caller can be honest', async () => {
  const githubCalls = [];
  const noCommits = async () => {
    const e = new Error('No commits between main and feat/x — the branch has no pushed commits.');
    e.code = 'no_commits';
    throw e;
  };
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls, createPR: noCommits });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }]);
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    await assert.rejects(
      () => subject.applyPrMetadata({
        pool, session, repoOwner: 'acme', repoName: 'app',
        userMessage: 'x', ccSummary: 'y', username: 'evan',
      }),
      (err) => err && err.code === 'no_commits',
      'the typed no_commits error propagates to the caller'
    );
  } finally {
    restore();
  }
});

// ---- session 2262 (2026-07-14): adopt the PR that already exists ----
//
// The restart race: the old process created the PR on GitHub and died
// before persisting pr_number, so every later createPR 422s "A pull
// request already exists". applyPrMetadata must adopt the existing PR
// (persist number/url, then run the normal update path) instead of
// returning null forever.

const prExists = async () => {
  const e = new Error('A pull request already exists for acme:feat/x.');
  e.code = 'pr_exists';
  throw e;
};

test('createPR pr_exists → the existing open PR is adopted and brought up to date', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({
    onGenerate: () => {}, githubCalls,
    createPR: prExists,
    findOpenPrByBranch: async (owner, repo, branch) => {
      githubCalls.push({ type: 'find', owner, repo, branch });
      return { number: 77, html_url: 'https://example/pr/77', title: 'Old GitHub title' };
    },
  });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }]);
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    const res = await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });

    // The lookup used the session's branch.
    const find = githubCalls.find((c) => c.type === 'find');
    assert.deepEqual(find, { type: 'find', owner: 'acme', repo: 'app', branch: 'feat/x' });

    // Adoption persisted pr_number/pr_url/pr_title BEFORE any update, so a
    // later failure can't lose the link again.
    const adopt = pool.queries.find((q) => /UPDATE chat_sessions SET pr_number = \$1, pr_url = \$2, pr_title = \$3, session_title = COALESCE/.test(q.sql));
    assert.ok(adopt, 'adoption UPDATE persisted');
    assert.deepEqual(adopt.params, [77, 'https://example/pr/77', 'Old GitHub title', 1]);

    // The generated title differs from the adopted one, so the normal
    // existing-PR update path fired against the adopted number.
    const update = githubCalls.find((c) => c.type === 'update');
    assert.ok(update, 'existing-PR update fired after adoption');
    assert.equal(update.num, 77);
    assert.equal(update.opts.title, 'Cumulative title');

    assert.deepEqual(res, { prNumber: 77, prUrl: 'https://example/pr/77', prTitle: 'Cumulative title' });
    assert.equal(session.pr_number, 77);
  } finally {
    restore();
  }
});

test('createPR pr_exists but the lookup finds nothing → best-effort null (no wedge, no throw)', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({
    onGenerate: () => {}, githubCalls,
    createPR: prExists,
    findOpenPrByBranch: async () => null,
  });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }]);
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    const res = await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(res, null);
    assert.equal(session.pr_number, null, 'session not mutated when nothing was adopted');
    assert.ok(!githubCalls.some((c) => c.type === 'update'), 'no blind update without a PR number');
  } finally {
    restore();
  }
});

test('pr_exists adoption during an LLM outage keeps the real GitHub title (no fallback downgrade)', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({
    // A throwing LLM drives the local generatePrMetadata wrapper onto its
    // fallback-template path ("evan's changes", fallback: true).
    onGenerate: () => { throw new Error('LLM unavailable'); }, githubCalls,
    createPR: prExists,
    findOpenPrByBranch: async () => ({ number: 77, html_url: 'https://example/pr/77', title: 'Real generated title' }),
  });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }]);
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    const res = await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    // Adopted, but the fallback title never overwrites the real one.
    assert.equal(res.prNumber, 77);
    assert.equal(res.prTitle, 'Real generated title');
    assert.ok(!githubCalls.some((c) => c.type === 'update'), 'no GitHub update with a fallback title');
  } finally {
    restore();
  }
});

test('applyPrMetadata stays best-effort (returns null) on other createPR failures', async () => {
  const githubCalls = [];
  const boom = async () => { throw new Error('GitHub 500 — transient'); };
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls, createPR: boom });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }]);
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    const res = await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(res, null, 'non-no_commits failures are swallowed as before');
  } finally {
    restore();
  }
});

test('no testing guidance -> body has no How to test section (legacy bytes)', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }]);
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.ok(!/How to test/.test(githubCalls[0].opts.body));
    assert.match(githubCalls[0].opts.body, /^Cumulative body\n\n---\n_Dev session by evan via Usernode_$/);
  } finally {
    restore();
  }
});

// ---- plain-language summary (user-facing) ----

test('summary is prepended as the first paragraph of the PR body, before bullets/testing/closing/footer', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({
    onGenerate: () => {}, githubCalls,
    summary: 'Adds a dark-mode toggle so people can switch to a dark colour scheme.',
  });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }], {
      linkedIssues: [75], testingMd: '1. Open the board.', testingPath: '/board',
    });
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls[0].type, 'create');
    // Summary leads, then the model body, then testing, then closing, then footer.
    assert.equal(
      githubCalls[0].opts.body,
      'Adds a dark-mode toggle so people can switch to a dark colour scheme.\n\n'
      + 'Cumulative body\n\n## How to test\n\n1. Open the board.\n\nDeep link: `/board`\n\n'
      + 'Closes #75\n\n---\n_Dev session by evan via Usernode_'
    );
    // The summary is persisted to pr_summary_md on the new-PR write.
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_number/.test(q.sql));
    assert.equal(upd.params[6], 'Adds a dark-mode toggle so people can switch to a dark colour scheme.');
  } finally {
    restore();
  }
});

test('empty summary leaves the body byte-identical to the legacy output', async () => {
  const githubCalls = [];
  // summary defaults to '' — the no-summary path.
  const { subject, restore } = loadWithStubs({ onGenerate: () => {}, githubCalls });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }]);
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.match(githubCalls[0].opts.body, /^Cumulative body\n\n---\n_Dev session by evan via Usernode_$/);
    // pr_summary_md persisted as null when no summary was generated.
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_number/.test(q.sql));
    assert.equal(upd.params[6], null);
  } finally {
    restore();
  }
});

test('existing PR updates when only the summary changed (title/issues/testing unchanged)', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({
    onGenerate: () => {}, githubCalls,
    summary: 'A fresh, revised plain-language summary.',
  });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }], {
      linkedIssues: [75], appliedIssues: [75],
      appliedSummary: 'The stale, previously-applied summary.',
    });
    const session = { id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u', pr_title: 'Cumulative title' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls.length, 1, 'GitHub update fired on a summary-only change');
    assert.equal(githubCalls[0].type, 'update');
    assert.match(githubCalls[0].opts.body, /^A fresh, revised plain-language summary\./);
    // The applied snapshot (pr_summary_md) is advanced for the next turn.
    const upd = pool.queries.find((q) => /UPDATE chat_sessions SET pr_title/.test(q.sql));
    assert.equal(upd.params[4], 'A fresh, revised plain-language summary.');
  } finally {
    restore();
  }
});

test('existing PR makes no GitHub call when summary (and everything else) is unchanged', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({
    onGenerate: () => {}, githubCalls,
    summary: 'Steady summary.',
  });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }], {
      linkedIssues: [75], appliedIssues: [75],
      appliedSummary: 'Steady summary.',
    });
    const session = { id: 1, branch_name: 'feat/x', pr_number: 42, pr_url: 'u', pr_title: 'Cumulative title' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'x', ccSummary: 'y', username: 'evan',
    });
    assert.equal(githubCalls.length, 0, 'no GitHub call when the summary is unchanged too');
  } finally {
    restore();
  }
});

// ---- 2026-07-24 outage: GitHub-side create-PR failures are typed ----
//
// createPR (after its internal retries) throws code 'github_unavailable'
// when GitHub itself is failing. applyPrMetadata must re-throw it — like
// no_commits — so the promote route / turn-end path can tell the user the
// truth ("GitHub-side, wait a few minutes") instead of the generic
// "re-run your request", while every other failure stays best-effort.

test('applyPrMetadata re-throws createPR "github_unavailable" for honest caller handling', async () => {
  const githubCalls = [];
  const unavailable = async () => {
    const e = new Error('GitHub failed to create the PR for acme:feat/x after 3 attempts (HTTP 500, request id AB36:1).');
    e.code = 'github_unavailable';
    e.status = 500;
    e.requestId = 'AB36:1';
    throw e;
  };
  const { subject, restore } = loadWithStubs({
    onGenerate: () => {}, githubCalls, createPR: unavailable,
  });
  try {
    const pool = mockPool([{ role: 'user', content: 'x', metadata: {} }]);
    const session = { id: 1, branch_name: 'feat/x', pr_number: null };
    await assert.rejects(
      subject.applyPrMetadata({
        pool, session, repoOwner: 'acme', repoName: 'app',
        userMessage: 'x', ccSummary: 'y', username: 'evan',
      }),
      (err) => err && err.code === 'github_unavailable' && err.status === 500,
      'the typed github_unavailable error propagates to the caller'
    );
    assert.equal(session.pr_number, null, 'no PR was persisted');
  } finally {
    restore();
  }
});
