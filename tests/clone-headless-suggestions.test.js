// Route test for POST /api/sessions/:id/clone-headless (src/routes/
// sessions.js, #32) — the load-bearing Part B fix. When the source auto
// session ended in a question, the appended follow-up message (which
// becomes the last non-system row) must carry the question turn's
// metadata.suggestions forward so the suggested-answer chips render under
// it. spec/code/spec_code clones have no questions, so their follow-up
// must stay chip-free (metadata = {}).
//
// Harness shape mirrors tests/me-active-sessions.test.js: override getPool
// BEFORE requiring the route module (sessions.js destructures it at
// require time), stub the side-effect modules (events/notifications), mount
// the router on a real express app, and inject req.user. The pool stub is
// programmable per-test and captures the follow-up INSERT so we can assert
// the metadata column directly.
//
// #2779: the browser no longer clones a run into a classic dev chat; the
// hosted connector's submit_platform_build is the one caller left, so the
// requests here carry an external connector client (and no delegated grant).
// The refusal of every other caller has its own test at the bottom.
//
// Run with: node --test tests/clone-headless-suggestions.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let handler = async () => ({ rows: [] });
let captured = [];
const stubPool = {
  query: (sql, params) => {
    captured.push({ sql, params });
    return handler(sql, params);
  },
};
poolMod.getPool = () => stubPool;

// Side effects we don't exercise here — keep them no-ops so the route's
// happy path doesn't fan out into real queries/notifications.
const events = require('../src/services/events');
events.record = () => Promise.resolve();
const notifications = require('../src/services/notifications');
notifications.markReadForAction = async () => 0;
const github = require('../src/services/github');
github.isEnabled = () => false;

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

function startServer({ connectorClientId = 'hosted-connector', mcpDelegation = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = VIEWER;
    req.connectorClientId = connectorClientId;
    req.mcpDelegation = mcpDelegation;
    next();
  });
  app.use(sessionRoutes({ maxUserSessions: 5, maxGlobalSessions: 100 }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const SUGGESTIONS = [
  { question: 'Which header?', answers: ['The top bar', 'The app view header'] },
  { question: 'What does "nicer" mean?', answers: ['Tidier spacing', 'A bolder refresh'] },
];

// A programmable pool stub that walks the clone-headless query sequence.
// `outcome` sets src.headless_outcome; `suggestionsRow` is what the
// "most recent assistant message with suggestions" lookup returns.
function makeHandler({ outcome, suggestionsRow, repoUrl = null, ccSessionId = null, specMd = '' }) {
  return async (sql, params) => {
    if (/FROM chat_sessions cs\s+JOIN apps a/.test(sql)) {
      return {
        rows: [{
          id: 1,
          app_id: 11,
          app_slug: 'demo',
          app_name: 'Demo App',
          repo_url: repoUrl, // absent in the quick-reply-only fixtures
          // appAccess.sessionCollabGuard selects both visibility columns
          // alongside the session; checkAppAccess THROWS without them.
          collab_visibility: 'public',
          view_visibility: 'public',
          is_headless: true,
          headless_status: 'ready',
          headless_outcome: outcome,
          headless_issue_number: 42,
          branch_name: 'auto/issue-42',
          spec_md: specMd,
          linked_issues: [],
          testing_md: null,
          testing_path: null,
          testing_paths: null,
          cc_session_id: ccSessionId,
          session_title: '#42 · Make the header nicer',
        }],
      };
    }
    if (/COUNT\(\*\) as cnt FROM chat_sessions/.test(sql)) {
      return { rows: [{ cnt: '0' }] };
    }
    if (/INSERT INTO chat_sessions/.test(sql)) {
      return { rows: [{ id: 99, app_id: 11, app_slug: 'demo', user_id: 7, cc_session_id: null, session_title: params[9] }] };
    }
    if (/INSERT INTO chat_session_messages[\s\S]*SELECT/.test(sql)) {
      return { rows: [] }; // convo copy
    }
    if (/INSERT INTO chat_session_specs/.test(sql)) {
      return { rows: [] };
    }
    // The forwarded-suggestions lookup (only issued on the question path).
    if (/SELECT metadata FROM chat_session_messages/.test(sql)) {
      return { rows: suggestionsRow ? [suggestionsRow] : [] };
    }
    // The follow-up INSERT — the row under test.
    if (/INSERT INTO chat_session_messages \(session_id, role, content, metadata\)/.test(sql)) {
      return { rows: [] };
    }
    return { rows: [] };
  };
}

async function clone(server) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/1/clone-headless`, {
    method: 'POST',
  });
  return { res, body: await res.json() };
}

function followUpInsert() {
  return captured.find((c) =>
    /INSERT INTO chat_session_messages \(session_id, role, content, metadata\)/.test(c.sql));
}

test('a source with agent memory hands off chat and specs without copying that memory', async () => {
  const worker = require('../src/services/worker');
  const kubernetes = require('../src/services/kubernetes');
  const oldCopy = worker.cloneCcVolume;
  const copies = [];
  // Trap the retired entry point: even a best-effort call whose error is
  // swallowed must fail this test, without touching a real worker volume.
  worker.cloneCcVolume = async (...args) => { copies.push(args); };
  captured = [];
  handler = makeHandler({
    outcome: 'spec_code',
    ccSessionId: '11111111-1111-4111-8111-111111111111',
    specMd: '# Inherited plan',
  });
  const server = await startServer();
  try {
    const { res, body } = await clone(server);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(body.session.cc_session_id, null, 'no inherited agent conversation');
    assert.deepStrictEqual(copies, [], 'no worker memory copy was attempted');
    const session = captured.find((c) => /INSERT INTO chat_sessions/.test(c.sql));
    assert.strictEqual(session.params[3], '# Inherited plan');
    assert.strictEqual(session.params[8], 1, 'source session is still recorded');
    assert.doesNotMatch(session.sql, /cc_session_id/);
    assert.ok(!captured.some((c) => /UPDATE chat_sessions SET cc_session_id/.test(c.sql)));
    for (const table of ['chat_session_messages', 'chat_session_specs']) {
      const copy = captured.find((c) => c.sql.includes(`INSERT INTO ${table}`) && /SELECT/.test(c.sql));
      assert.ok(copy, `${table} history is still copied`);
      assert.deepStrictEqual(copy.params, [99, 1]);
    }
  } finally {
    server.close();
    if (oldCopy === undefined) delete worker.cloneCcVolume;
    else worker.cloneCcVolume = oldCopy;
  }
  assert.strictEqual(oldCopy, undefined, 'Docker memory-copy helper is removed');
  assert.strictEqual(kubernetes.cloneWorkerVolume, undefined, 'Kubernetes memory-copy helper is removed');
});

test("question clone forwards the question turn's suggestions onto the follow-up", async () => {
  captured = [];
  handler = makeHandler({
    outcome: 'question',
    suggestionsRow: { metadata: { suggestions: SUGGESTIONS } },
  });
  const server = await startServer();
  try {
    const { res } = await clone(server);
    assert.strictEqual(res.status, 201);

    const ins = followUpInsert();
    assert.ok(ins, 'follow-up INSERT was issued');
    const meta = JSON.parse(ins.params[2]);
    assert.deepStrictEqual(meta.suggestions, SUGGESTIONS);

    // The lookup query must be scoped to non-empty suggestions arrays.
    const lookup = captured.find((c) => /SELECT metadata FROM chat_session_messages/.test(c.sql));
    assert.ok(lookup, 'suggestions lookup was issued on the question path');
    assert.match(lookup.sql, /jsonb_array_length/);
    assert.match(lookup.sql, /ORDER BY id DESC/);
  } finally {
    server.close();
  }
});

test('question clone with no source suggestions writes an empty-metadata follow-up', async () => {
  captured = [];
  handler = makeHandler({ outcome: 'question', suggestionsRow: null });
  const server = await startServer();
  try {
    const { res } = await clone(server);
    assert.strictEqual(res.status, 201);
    const ins = followUpInsert();
    assert.ok(ins);
    assert.deepStrictEqual(JSON.parse(ins.params[2]), {});
  } finally {
    server.close();
  }
});

// #330: spec/code/spec_code clones must carry NO chips (they have no
// questions) but DO carry outcome-appropriate next-step quick-reply pills,
// so the cloned follow-up never lands with an empty pill bar.
const EXPECTED_PILLS = {
  spec: ['Build the plan', 'Revise the plan', 'What will this change?'],
  code: ['Propose it to the group', 'Make a tweak', 'What did it change?'],
  spec_code: ['Propose it to the group', 'Revise the plan', 'Make a tweak'],
};

for (const outcome of ['spec', 'code', 'spec_code']) {
  test(`${outcome} clone carries next-step pills, no chips, and skips the lookup`, async () => {
    captured = [];
    handler = makeHandler({
      outcome,
      // Even if a suggestions row existed, the non-question path must not
      // query for or forward it.
      suggestionsRow: { metadata: { suggestions: SUGGESTIONS } },
    });
    const server = await startServer();
    try {
      const { res } = await clone(server);
      assert.strictEqual(res.status, 201);

      const ins = followUpInsert();
      assert.ok(ins, 'follow-up INSERT was issued');
      const meta = JSON.parse(ins.params[2]);
      assert.deepStrictEqual(meta.quickReplies, EXPECTED_PILLS[outcome]);
      assert.strictEqual(meta.suggestions, undefined, 'no answer chips off the question path');
      // Pills must respect the shared sanitizeQuickReplies envelope.
      assert.ok(meta.quickReplies.length <= 3, '≤3 pills');
      for (const p of meta.quickReplies) assert.ok(p.length <= 80, '≤80 chars per pill');

      const lookup = captured.find((c) => /SELECT metadata FROM chat_session_messages/.test(c.sql));
      assert.strictEqual(lookup, undefined, 'suggestions lookup must be skipped off the question path');
    } finally {
      server.close();
    }
  });
}

test('cloning pushed code opens a draft PR on the human branch; a spec clone stays PR-free', async () => {
  const prMetadata = require('../src/services/pr-metadata');
  const oldEnabled = github.isEnabled;
  const oldGetBranchSha = github.getBranchSha;
  const oldEnsure = github.ensureBranchAtSha;
  const oldFetchIssue = github.fetchPublicIssue;
  const oldApply = prMetadata.applyPrMetadata;
  const oldFindOpen = github.findOpenPrByBranch;
  const branches = [];
  const prs = [];
  github.isEnabled = () => true;
  // The clone's branch is a conductor's platform operation
  // (services/branch-operation.js): run here as the conductor would, off the
  // source run's own branch as it reads it.
  github.getBranchSha = async (_owner, _repo, branch) => `sha-of-${branch}`;
  github.ensureBranchAtSha = async (_owner, _repo, branch, sha) => { branches.push({ branch, from: sha.replace(/^sha-of-/, '') }); };
  const operations = require('../src/services/platform-operations');
  const branchOperation = require('../src/services/branch-operation');
  const conductorPool = {
    query: async (sql, params) => (/SELECT \* FROM apps WHERE id = \$1/.test(sql)
      ? { rows: [{ id: 11, slug: 'demo', repo_url: 'https://github.com/acme/demo' }] }
      : /SELECT app_id, branch_name FROM chat_sessions WHERE id = \$1/.test(sql)
        ? { rows: [{ app_id: 11, branch_name: 'auto/issue-42' }] } : { rows: [] }),
  };
  const priorTransport = operations._setTransportForTests(async (p) => ({
    status: 'done', requestId: 'r',
    result: { ok: true, ...(await branchOperation.run({ pool: conductorPool }, p, VIEWER, require('../src/services/durable-steps').none())) },
  }));
  github.fetchPublicIssue = async () => ({ issue: { title: 'Make the header nicer' } });
  // Opened once: one already open for the branch would be adopted instead.
  github.findOpenPrByBranch = async () => null;
  prMetadata.applyPrMetadata = async (args) => {
    prs.push(args);
    args.session.pr_number = 78;
    args.session.pr_url = 'https://github.com/acme/demo/pull/78';
  };
  try {
    for (const outcome of ['code', 'spec_code', 'spec']) {
      handler = makeHandler({ outcome, repoUrl: 'https://github.com/acme/demo' });
      const server = await startServer();
      try {
        const { res, body } = await clone(server);
        assert.equal(res.status, 201);
        assert.equal(body.session.pr_number, outcome === 'spec' ? undefined : 78);
      } finally { server.close(); }
    }
    assert.equal(prs.length, 2);
    assert.ok(prs.every((call) => call.session.status === undefined || call.session.status === 'active'));
    assert.ok(prs.every((call) => call.username === 'tester' && call.allowModelGeneration === false
      && call.preferredTitle === '#42 · Make the header nicer'), 'the deterministic draft, under the new owner\'s and the run\'s names');
    assert.ok(branches.length > 0 && branches.every((item) => item.from === 'auto/issue-42'));
  } finally {
    github.findOpenPrByBranch = oldFindOpen;
    github.isEnabled = oldEnabled;
    github.getBranchSha = oldGetBranchSha;
    github.ensureBranchAtSha = oldEnsure;
    operations._setTransportForTests(priorTransport);
    github.fetchPublicIssue = oldFetchIssue;
    prMetadata.applyPrMetadata = oldApply;
  }
});

test('on the platform repository the clone\'s draft PR is recorded for a conductor, which opens it', async () => {
  // GitHub's credential is a conductor's (services/pr-sync-operation.js):
  // the route answers with the clone, and the PR follows (or the promote
  // that comes next opens it).
  const prMetadata = require('../src/services/pr-metadata');
  const operations = require('../src/services/platform-operations');
  const platformRepo = require('../src/services/repo-ref').platformRepoUrl();
  const oldEnabled = github.isEnabled;
  const oldApply = prMetadata.applyPrMetadata;
  const appended = [];
  let opened = 0;
  github.isEnabled = () => true;
  prMetadata.applyPrMetadata = async () => { opened += 1; };
  const priorTransport = operations._setTransportForTests(async () => ({
    status: 'done', requestId: 'r', result: { ok: true, branch: 'dev/x', inheritedCodeBranch: true },
  }));
  const priorAppend = operations._setAppendForTests(async (_db, p) => { appended.push(p); return 'r2'; });
  try {
    handler = makeHandler({ outcome: 'code', repoUrl: platformRepo });
    const server = await startServer();
    try {
      const { res, body } = await clone(server);
      assert.equal(res.status, 201);
      assert.equal(body.session.pr_number, undefined, 'not opened by the web process');
    } finally { server.close(); }
    assert.equal(opened, 0);
    assert.deepEqual(appended, [{ op: 'pr.sync', appId: 11, userId: 7, input: { sessionId: 99, write: 'create', from: 'clone' } }]);
  } finally {
    github.isEnabled = oldEnabled;
    prMetadata.applyPrMetadata = oldApply;
    operations._setTransportForTests(priorTransport);
    operations._setAppendForTests(priorAppend);
  }
});

test('question clone carries chips but no pills', async () => {
  captured = [];
  handler = makeHandler({
    outcome: 'question',
    suggestionsRow: { metadata: { suggestions: SUGGESTIONS } },
  });
  const server = await startServer();
  try {
    const { res } = await clone(server);
    assert.strictEqual(res.status, 201);
    const ins = followUpInsert();
    const meta = JSON.parse(ins.params[2]);
    assert.deepStrictEqual(meta.suggestions, SUGGESTIONS);
    assert.strictEqual(meta.quickReplies, undefined, 'pills suppressed on the question path');
  } finally {
    server.close();
  }
});

// #647: every row the clone copies is stamped with metadata.inheritedFrom
// (the auto session's id) so the dev-chat renderer can collapse the
// inherited Claude Code disclosures by default. The appended follow-up row
// must NOT carry it — that message belongs to the human session.
test('the conversation copy stamps inheritedFrom on every copied row', async () => {
  captured = [];
  handler = makeHandler({ outcome: 'code', suggestionsRow: null });
  const server = await startServer();
  try {
    const { res } = await clone(server);
    assert.strictEqual(res.status, 201);

    const copy = captured.find((c) =>
      /INSERT INTO chat_session_messages[\s\S]*SELECT/.test(c.sql));
    assert.ok(copy, 'the conversation copy was issued');
    assert.match(copy.sql, /jsonb_build_object\('inheritedFrom', \$2::int\)/,
      'the source session id is stamped onto each copied row');
    // Pre-existing metadata must survive the stamp (the copied rows carry
    // progressLog / ccOutput / suggestions the renderer still needs), and a
    // NULL metadata column must not swallow the whole object.
    assert.match(copy.sql, /COALESCE\(metadata, '\{\}'::jsonb\) \|\|/,
      'existing metadata is preserved and NULL is coalesced');
    // $2 is the source session id in this query (session_id = $2).
    assert.strictEqual(copy.params[1], 1, 'stamped with the source session id');

    const ins = followUpInsert();
    assert.ok(ins, 'follow-up INSERT was issued');
    assert.strictEqual(JSON.parse(ins.params[2]).inheritedFrom, undefined,
      'the appended follow-up is not marked as inherited');
  } finally {
    server.close();
  }
});

test('#2779: only the hosted connector clones a run; a browser or a delegated grant is refused', async () => {
  for (const [who, opts] of [
    ['a browser', { connectorClientId: null }],
    ['the Mayor\'s delegated grant', { mcpDelegation: { kind: 'agent_mayor', agentSessionId: 5 } }],
  ]) {
    captured = [];
    handler = makeHandler({ outcome: 'code', suggestionsRow: null });
    const server = await startServer(opts);
    try {
      const { res, body } = await clone(server);
      assert.strictEqual(res.status, 403, who);
      assert.strictEqual(body.code, 'agent_sessions_only', who);
      assert.ok(!captured.some((c) => /INSERT|UPDATE/.test(String(c.sql))), `${who}: nothing is written`);
      assert.ok(!captured.some((c) => /is_headless = TRUE/.test(String(c.sql))), `${who}: the run is not even looked up`);
    } finally {
      server.close();
    }
  }
});
