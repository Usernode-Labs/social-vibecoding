'use strict';

// What the group reads about a change: its title and description are
// written from the change itself.
//
//   1. A CHANGE'S REQUESTS ARE ITS OWN MESSAGES: the user rows filed under
//      it are what the description is generated from.
//   2. PUTTING IT UP FOR THE VOTE KEEPS ITS TEXT when its pull request and
//      title already exist.
//   3. A MODEL'S "**DESCRIPTION**" IS STILL THE DESCRIPTION, and its
//      "**TESTING ===**" still the testing block, without turning ordinary
//      headings into either.

const test = require('node:test');
const assert = require('node:assert/strict');

function loadWithStubs({ onGenerate = () => {}, githubCalls }) {
  const llmPath = require.resolve('../src/services/llm');
  const ghPath = require.resolve('../src/services/github');
  const subjectPath = require.resolve('../src/services/pr-metadata');
  const orig = { llm: require.cache[llmPath], gh: require.cache[ghPath], subject: require.cache[subjectPath] };
  require.cache[llmPath] = {
    exports: {
      isEnabled: () => true,
      estimateCostCents: () => 0,
      generatePrMetadata: async (args) => {
        onGenerate(args);
        return { title: 'Generated from the change', body: 'Generated body', summary: 'Generated summary.' };
      },
    },
    loaded: true, id: llmPath, filename: llmPath, paths: [],
  };
  require.cache[ghPath] = {
    exports: {
      createPR: async (owner, repo, opts) => { githubCalls.push({ type: 'create', opts }); return { number: 42, html_url: 'https://example/pr/42' }; },
      updatePR: async (owner, repo, num, opts) => { githubCalls.push({ type: 'update', num, opts }); },
      findOpenPrByBranch: async () => null,
    },
    loaded: true, id: ghPath, filename: ghPath, paths: [],
  };
  delete require.cache[subjectPath];
  const subject = require('../src/services/pr-metadata');
  const restore = () => {
    for (const [p, entry] of [[llmPath, orig.llm], [ghPath, orig.gh], [subjectPath, orig.subject]]) {
      if (entry) require.cache[p] = entry; else delete require.cache[p];
    }
  };
  return { subject, restore };
}

// A change's rows and its live row.
function changePool({ rows, live = {} }) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/FROM chat_session_specs/i.test(sql)) return { rows: [] };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return {
          rows: [{
            spec_md: live.spec_md || '', linked_issues: [], pr_linked_issues_applied: [],
            testing_md: null, testing_path: null, pr_testing_applied: null,
            pr_visuals_applied: null, pr_summary_md: null,
          }],
        };
      }
      if (/FROM chat_session_messages/i.test(sql)) return { rows };
      return { rows: [] };
    },
  };
}

const CHAT_ROWS = [
  { role: 'user', content: 'Build the spec', metadata: {} },
  {
    role: 'system', content: 'cc',
    metadata: { ccOutput: 'Committed as e1d33fa.', proposalDescription: 'An agent chat about an app now has an Open app button that opens the app with the chat beside it.' },
  },
  { role: 'user', content: 'Also, can we add a dark mode toggle next?', metadata: {} },
];

// ── 1. A change's requests are its own messages ───────────────────────

test('a change\'s requests are the user messages filed under it', async () => {
  const calls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: (args) => calls.push(args), githubCalls: [] });
  try {
    const pool = changePool({ rows: CHAT_ROWS });
    const session = { id: 42, branch_name: 'dev/x', pr_number: null, agent_backend: 'claude_code' };
    await subject.applyPrMetadata({ pool, session, repoOwner: 'acme', repoName: 'app', userMessage: 'Build the spec', ccSummary: '', username: 'evan', apiKey: 'k' });
    assert.deepEqual(calls[0].requests, ['Build the spec', 'Also, can we add a dark mode toggle next?']);
  } finally {
    restore();
  }
});

// ── 2. Submission keeps its text ───────────────────────────────────────

// The proposal machine's review.open (src/workflow/proposal/services.ts) is
// what a promote runs on GitHub now; it is driven here with GitHub and the
// legacy modules it reaches (through src/workflow/legacy.ts, the shared
// require cache) stubbed.
async function openForReview(row, applyPrMetadata) {
  const stubbed = ['../src/services/github', '../src/services/limits', '../src/services/pr-metadata', '../src/services/app-admins'];
  const ids = stubbed.map((p) => require.resolve(p));
  const orig = ids.map((id) => require.cache[id]);
  const put = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] }; };
  const calls = [];
  put(ids[0], { isEnabled: () => false });
  put(ids[1], { resolveBillingPath: async () => ({ error: 'no key' }) });
  put(ids[2], { applyPrMetadata: async (args) => { calls.push(args); return applyPrMetadata(args); } });
  put(ids[3], { refreshExplicitApproval: async () => {} });
  const pool = {
    async query(sql) {
      const q = String(sql);
      if (/FROM chat_sessions cs JOIN apps a/.test(q)) return { rows: [{ ...row }] };
      if (/FROM chat_session_messages/.test(q)) return { rows: [{ content: 'make it nicer' }] };
      if (/FROM users/.test(q)) return { rows: [{ username: 'ana' }] };
      return { rows: [] };
    },
  };
  try {
    const { proposalServices } = require('../src/workflow/proposal/services.ts');
    const { WORK } = require('../src/workflow/proposal/machine.ts');
    let result = null;
    let error = null;
    try {
      result = await proposalServices({ config: {}, pool })[WORK.open].run({ input: { sessionId: row.id, n: 1, userId: 7 } });
    } catch (err) { error = err; }
    return { calls, result, error };
  } finally {
    ids.forEach((id, i) => { if (orig[i]) require.cache[id] = orig[i]; else delete require.cache[id]; });
  }
}

test('putting a change up for the vote keeps the text it has when its pull request and title exist', async () => {
  const change = {
    id: 42, user_id: 7, pr_number: 77, pr_title: 'Old title', pr_url: 'https://github.com/acme/x/pull/77',
    proposed_pr_title: 'The title Ana chose', repo_url: 'https://github.com/acme/x', source: null, reviewed_head_sha: 'a'.repeat(40),
  };
  const { calls, result, error } = await openForReview(change, async () => ({}));
  assert.equal(calls.length, 0, 'no rewrite of a pull request that already has its title');
  assert.equal(error, null);
  assert.equal(result.prNumber, 77);
});

// ── 3. The markers a model actually writes ─────────────────────────────

test('"**DESCRIPTION**" and "**TESTING ===**" are the blocks; ordinary headings are not', () => {
  const description = require('../src/services/proposal-description');
  const testing = require('../src/services/testing-notes');
  // PR #3031's final message, as the coding agent wrote it.
  const reply = 'The change is committed. Here is the summary.\n\n**DESCRIPTION**\n\n'
    + 'An agent session now carries an "Open app" pill.\n\n**TESTING ===**\npath: /#messages/agent/990803\n\n1. Open the first path.';
  const t = testing.extract(reply);
  assert.equal(t.testingPath, '/#messages/agent/990803');
  assert.equal(t.testingMd, '1. Open the first path.');
  const d = description.extract(t.cleanedText);
  assert.equal(d.description, 'An agent session now carries an "Open app" pill.');
  assert.equal(d.cleanedText, 'The change is committed. Here is the summary.', 'the preamble is not the description');

  for (const marker of ['==== DESCRIPTION ====', '**==== DESCRIPTION ====**', '__DESCRIPTION__', '=== DESCRIPTION']) {
    assert.equal(description.extract(`${marker}\nbody`).description, 'body', marker);
  }
  for (const heading of ['## DESCRIPTION', 'Description', '**Description**', 'DESCRIPTION']) {
    assert.equal(description.extract(`${heading}\nbody`).description, null, heading);
  }
  for (const heading of ['## TESTING', 'Testing:', '**Testing**', 'TESTING']) {
    assert.equal(testing.extract(`${heading}\npath: /x\n1. go`).testingPath, null, `${heading} over a test log is not how-to-test`);
  }
  assert.equal(testing.extract('**END TESTING**').cleanedText, '**END TESTING**', 'a closer alone opens nothing');
});
