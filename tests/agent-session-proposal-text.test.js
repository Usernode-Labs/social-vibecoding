'use strict';

// What the group reads about a change an agent session built (#2779
// follow-up): its title and description are written from that change alone,
// on every build and again when it is put up for the vote.
//
//   1. THE REQUEST IS THE CHANGE'S NAME. A conversation carries several
//      changes, and a message is filed under whichever was active when it was
//      sent, so the chat rows under a change are the go-ahead ("Build the
//      spec") and the next change's opening line. The name the Mayor gave it
//      at start_change is what it was for.
//   2. A TITLE A PERSON SET WINS; the Mayor's name does not pin it.
//   3. SUBMISSION REFRESHES IT, best-effort, without blocking the vote.
//   4. A MODEL'S "**DESCRIPTION**" IS STILL THE DESCRIPTION, and its
//      "**TESTING ===**" still the testing block, without turning ordinary
//      headings into either.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

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

// A change's rows, its live row and the conversation's change_started event.
function changePool({ rows, live = {}, eventTitle = null }) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/agentSessionEvent' = 'change_started'/.test(sql)) {
        return { rows: eventTitle ? [{ title: eventTitle }] : [] };
      }
      if (/FROM chat_session_specs/i.test(sql)) return { rows: [] };
      if (/FROM chat_sessions\b/i.test(sql)) {
        return {
          rows: [{
            spec_md: live.spec_md || '', linked_issues: [], pr_linked_issues_applied: [],
            testing_md: null, testing_path: null, pr_testing_applied: null,
            pr_visuals_applied: null, pr_summary_md: null,
            agent_session_id: live.agent_session_id ?? null,
            session_title: live.session_title ?? null,
            proposed_pr_title: live.proposed_pr_title ?? null,
          }],
        };
      }
      if (/FROM chat_session_messages/i.test(sql)) return { rows };
      return { rows: [] };
    },
  };
}

const NAME = 'Open app button in agent chat headers';
const CHAT_ROWS = [
  { role: 'user', content: 'Build the spec', metadata: {} },
  {
    role: 'system', content: 'cc',
    metadata: { ccOutput: 'Committed as e1d33fa.', proposalDescription: 'An agent chat about an app now has an Open app button that opens the app with the chat beside it.' },
  },
  { role: 'user', content: 'Also, can we add a dark mode toggle next?', metadata: {} },
];

// ── 1. The request is the change's name ────────────────────────────────

test('a Codex change from an agent chat is titled by its name, not "Build the spec", and described by its agent', async () => {
  const githubCalls = [];
  let generated = 0;
  const { subject, restore } = loadWithStubs({ onGenerate: () => { generated += 1; }, githubCalls });
  try {
    const pool = changePool({
      rows: CHAT_ROWS,
      // session_title follows the PR title (#249): it is not the name.
      live: { agent_session_id: 5, session_title: 'Build the spec', proposed_pr_title: null },
      eventTitle: NAME,
    });
    const session = { id: 42, branch_name: 'dev/x', pr_number: null, agent_backend: 'codex_openrouter' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'Build the spec', ccSummary: '', username: 'evan',
    });
    assert.equal(generated, 0, 'still no hidden model call for a Codex change');
    assert.equal(githubCalls[0].opts.title, NAME);
    assert.match(githubCalls[0].opts.body, /^An agent chat about an app now has an Open app button/);
    assert.doesNotMatch(githubCalls[0].opts.body, /dark mode|Build the spec/, 'nothing from the chat rows filed under it');

    const lookup = pool.queries.find((q) => /change_started/.test(q.sql));
    assert.match(lookup.sql, /agent_session_id = \$1 AND session_id IS NULL AND role = 'system'/);
    assert.match(lookup.sql, /metadata->>'changeId' = \$2::text/);
    assert.deepEqual(lookup.params, [5, '42']);
  } finally {
    restore();
  }
});

test('a Claude change from an agent chat is generated from its name, spec and builds, never its chat rows', async () => {
  const githubCalls = [];
  const calls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: (args) => calls.push(args), githubCalls });
  try {
    const pool = changePool({
      rows: CHAT_ROWS,
      live: { agent_session_id: 5, session_title: 'Build the spec', spec_md: '# Open app\nA pill in the bar.' },
      eventTitle: NAME,
    });
    const session = { id: 42, branch_name: 'dev/x', pr_number: null, agent_backend: 'claude_code' };
    await subject.applyPrMetadata({
      pool, session, repoOwner: 'acme', repoName: 'app',
      userMessage: 'Build the spec', ccSummary: '', username: 'evan', apiKey: 'k',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userRequest, NAME, 'the name stands in for the message that triggered the build');
    assert.deepEqual(calls[0].requests, [NAME], 'and is the only request');
    assert.deepEqual(calls[0].specs, ['# Open app\nA pill in the bar.']);
    assert.deepEqual(calls[0].summaries, ['Committed as e1d33fa.'], 'what its builds did');
    assert.equal(githubCalls[0].opts.title, 'Generated from the change', 'generated, not pinned to the name');
  } finally {
    restore();
  }
});

test('before the event carried the name, the change title is the fallback', async () => {
  const githubCalls = [];
  const { subject, restore } = loadWithStubs({ githubCalls });
  try {
    const pool = changePool({ rows: CHAT_ROWS, live: { agent_session_id: 5, session_title: NAME } });
    const session = { id: 42, branch_name: 'dev/x', pr_number: null, agent_backend: 'codex_openrouter' };
    await subject.applyPrMetadata({ pool, session, repoOwner: 'acme', repoName: 'app', userMessage: 'Build the spec', ccSummary: '', username: 'evan' });
    assert.equal(githubCalls[0].opts.title, NAME);
  } finally {
    restore();
  }
});

test('a dev-chat change keeps its own requests', async () => {
  const calls = [];
  const { subject, restore } = loadWithStubs({ onGenerate: (args) => calls.push(args), githubCalls: [] });
  try {
    const pool = changePool({ rows: CHAT_ROWS, live: { agent_session_id: null, session_title: 'x' } });
    const session = { id: 42, branch_name: 'dev/x', pr_number: null, agent_backend: 'claude_code' };
    await subject.applyPrMetadata({ pool, session, repoOwner: 'acme', repoName: 'app', userMessage: 'Build the spec', ccSummary: '', username: 'evan', apiKey: 'k' });
    assert.deepEqual(calls[0].requests, ['Build the spec', 'Also, can we add a dark mode toggle next?']);
    assert.ok(!pool.queries.some((q) => /change_started/.test(q.sql)), 'and no lookup');
  } finally {
    restore();
  }
});

// ── 2. A title a person set wins ───────────────────────────────────────

test('a title a person set wins; the Mayor\'s own name in proposed_pr_title does not pin it', async () => {
  for (const [proposed, expected] of [
    ['My own name for it', 'My own name for it'],
    [NAME, 'Generated from the change'],
  ]) {
    const githubCalls = [];
    const { subject, restore } = loadWithStubs({ githubCalls });
    try {
      const pool = changePool({ rows: CHAT_ROWS, live: { agent_session_id: 5, proposed_pr_title: proposed }, eventTitle: NAME });
      const session = { id: 42, branch_name: 'dev/x', pr_number: null, agent_backend: 'claude_code' };
      await subject.applyPrMetadata({ pool, session, repoOwner: 'acme', repoName: 'app', userMessage: 'go', ccSummary: '', username: 'evan', apiKey: 'k' });
      assert.equal(githubCalls[0].opts.title, expected, proposed);
    } finally {
      restore();
    }
  }
  const create = read('src/routes/sessions.js');
  const insert = create.slice(create.indexOf('INSERT INTO chat_sessions (app_id, user_id, branch_name, status, created_from_issue_number'));
  assert.doesNotMatch(insert.slice(0, insert.indexOf('RETURNING')), /proposed_pr_title/, 'start_change names the change without pinning its title');
});

test('the change_started event carries the name the change started with', async () => {
  const agentSessions = require('../src/services/agent-sessions');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/UPDATE chat_sessions SET agent_session_id/.test(sql)) return { rows: [{ id: 42, app_id: 3 }] };
      return { rows: [], rowCount: 1 };
    },
  };
  assert.equal(await agentSessions.linkChange(pool, {
    agentSessionId: 5, userId: 7, change: { id: 42, session_title: NAME, app_name: 'Homeroom' },
  }), true);
  const event = calls.find((c) => /INSERT INTO chat_session_messages/.test(c.sql));
  assert.deepEqual(JSON.parse(event.params[2]), { changeId: 42, title: NAME, agentSessionEvent: 'change_started' });
});

// ── 3. Submission refreshes it ─────────────────────────────────────────

test('putting an agent-chat change up for the vote writes its title and description again, best-effort', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /const refreshAtSubmission = session\.agent_session_id != null && !!session\.pr_number;/);
  assert.match(votes, /if \(!session\.pr_number \|\| !session\.pr_title \|\| refreshAtSubmission\) \{/);
  const block = votes.slice(votes.indexOf('const refreshAtSubmission'));
  assert.match(block, /const isBackfill = !!session\.pr_number;/, 'an existing PR: a failure never blocks the promotion');
  assert.match(block, /preferredTitle: session\.proposed_pr_title \|\| null/, 'and a person\'s title is kept');
});

// ── 4. The markers a model actually writes ─────────────────────────────

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
