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
function loadWithStubs({ onGenerate, githubCalls }) {
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
        return { title: 'Cumulative title', body: 'Cumulative body', usage: undefined, model: 'claude-haiku-4-5' };
      },
    },
    loaded: true, id: llmPath, filename: llmPath, paths: orig.llm ? orig.llm.paths : [],
  };
  require.cache[ghPath] = {
    exports: {
      createPR: async (owner, repo, opts) => { githubCalls.push({ type: 'create', owner, repo, opts }); return { number: 42, html_url: 'https://example/pr/42' }; },
      updatePR: async (owner, repo, num, opts) => { githubCalls.push({ type: 'update', owner, repo, num, opts }); },
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
function mockPool(rows, { specRows = [], liveSpec = '', linkedIssues = [], appliedIssues = [] } = {}) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM chat_session_specs/i.test(sql)) return { rows: specRows };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return { rows: [{ spec_md: liveSpec, linked_issues: linkedIssues, pr_linked_issues_applied: appliedIssues }] };
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
