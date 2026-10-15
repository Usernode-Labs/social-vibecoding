// Tests for the auto-resolve of close_issue governance proposals whose
// target issue was closed by other means:
//   1. resolveSupersededCloseProposals (src/routes/issues.js) — the shared
//      resolver hands each closed number to the governance machine
//      (platform.ts targetsClosed), which supersedes the proposals; what the
//      machine does is pinned by tests/workflow-governance-postgres.test.js.
//   2. The issue-close-watcher hook — observed closes (and gone/skipped
//      numbers) trigger the resolver when a pool is provided; without one
//      the watcher behaves exactly as before.
//   3. The merge-path hook: the merge-followups machine's
//      issues.closeAfterMerge work resolves proposals for the issues a
//      merged PR closes, and a resolver failure fails that work item so the
//      kernel retries it (the merge itself is already recorded).
//
// Run with: node --test tests/close-issue-auto-withdraw.test.js

// Zero the watcher delays before it loads its tunables.
process.env.ISSUE_CLOSE_WATCH_GRACE_MS = '0';
process.env.ISSUE_CLOSE_WATCH_BACKOFF_MS = '0';
process.env.ISSUE_CLOSE_WATCH_ATTEMPTS = '3';

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports, orig) {
  require.cache[id] = {
    id, filename: id, loaded: true, exports, paths: orig ? orig.paths : [],
  };
}

function makePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
    issued(re) { return calls.find((c) => re.test(c.sql)); },
  };
}

// ── Part 1: the shared resolver ───────────────────────────────────────────

// Load routes/issues with the workflow module stubbed: `targetsClosed`
// answers with `answer`, or throws it when it is an Error.
function loadResolver(answer) {
  const ids = { workflow: require.resolve('../src/workflow/platform.ts'), subject: require.resolve('../src/routes/issues') };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const calls = [];
  stub(ids.workflow, {
    async targetsClosed(appId, numbers, cause) {
      calls.push({ appId, numbers, cause });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  }, orig.workflow);
  delete require.cache[ids.subject];
  const subject = require('../src/routes/issues');
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.subject];
  };
  return { subject, calls, restore };
}

test('resolver: hands the valid numbers and the cause to the governance machine', async () => {
  const { subject, calls, restore } = loadResolver([61]);
  try {
    const out = await subject.resolveSupersededCloseProposals(null, {
      appId: 9, numbers: [42, '43', 0, -1, 'x'], cause: { kind: 'pr-merge', prNumber: 7 },
    });
    assert.deepEqual(out, { resolved: [61] });
    assert.deepEqual(calls, [{ appId: 9, numbers: [42, 43], cause: { kind: 'pr-merge', prNumber: 7 } }]);
  } finally { restore(); }
});

test('resolver: a close on GitHub is the default cause; empty inputs reach nothing', async () => {
  const { subject, calls, restore } = loadResolver([]);
  try {
    await subject.resolveSupersededCloseProposals(null, { appId: 9, numbers: [42] });
    assert.deepEqual(calls[0].cause, { kind: 'github-close' });
    for (const args of [{}, { appId: 9, numbers: [] }, { appId: null, numbers: [42] }, { appId: 9, numbers: ['x'] }]) {
      assert.deepEqual(await subject.resolveSupersededCloseProposals(null, args), { resolved: [] });
    }
    assert.equal(calls.length, 1, 'nothing else reached the machine');
  } finally { restore(); }
});

test('resolver: a failure is logged, unless the caller retries on it (strict)', async () => {
  const { subject, restore } = loadResolver(new Error('runtime down'));
  try {
    assert.deepEqual(await subject.resolveSupersededCloseProposals(null, { appId: 9, numbers: [42] }), { resolved: [] });
    await assert.rejects(subject.resolveSupersededCloseProposals(null, { appId: 9, numbers: [42], strict: true }), /runtime down/);
  } finally { restore(); }
});

// ── Part 2: the issue-close-watcher hook ─────────────────────────────────

// Same stub shape as issue-close-watcher.test.js, plus a routes/issues stub
// whose resolveSupersededCloseProposals is a spy (the watcher lazy-requires
// it only when a pool is provided).
function loadWatcher({ gh = {}, resolverCalls, resolverImpl }) {
  const ids = {
    github: require.resolve('../src/services/github'),
    ws: require.resolve('../src/services/ws'),
    issues: require.resolve('../src/routes/issues'),
    prMeta: require.resolve('../src/services/pr-metadata'),
    subject: require.resolve('../src/services/issue-close-watcher'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  stub(ids.github, {
    isEnabled: () => true,
    getPR: async (...a) => (gh.getPR ? gh.getPR(...a) : { body: '' }),
    getIssue: async (...a) => (gh.getIssue ? gh.getIssue(...a) : { number: a[2], state: 'closed' }),
    noteIssuesClosed: () => {},
    unsuppressIssues: () => {},
    invalidateIssuesCache: () => {},
  }, orig.github);
  stub(ids.ws, { pushIssueUpdate: () => {} }, orig.ws);
  stub(ids.issues, {
    resolveSupersededCloseProposals: async (pool, args) => {
      resolverCalls.push({ pool, args });
      if (resolverImpl) return resolverImpl(pool, args);
      return { resolved: [] };
    },
  }, orig.issues);

  delete require.cache[ids.prMeta];
  delete require.cache[ids.subject];
  const subject = require('../src/services/issue-close-watcher');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.prMeta];
    delete require.cache[ids.subject];
  };
  return { subject, restore };
}

const WATCH_ARGS = {
  owner: 'usernode-bot', repo: 'some-app', prNumber: 42,
  appSlug: 'some-app', appId: 7,
};

// Watcher hook calls are fired-and-forgotten; let the microtask queue drain.
const settle = () => new Promise((r) => setImmediate(r));

test('watcher: observed closes trigger the resolver with the pool and pr-merge cause', async () => {
  const resolverCalls = [];
  const pool = { async query() { return { rows: [] }; } };
  const { subject, restore } = loadWatcher({
    resolverCalls,
    gh: { getPR: async () => ({ body: 'Closes #3, fixes #9' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...WATCH_ARGS, pool });
    await settle();
    assert.deepEqual(res.closed, [3, 9]);
    assert.equal(resolverCalls.length, 1);
    assert.equal(resolverCalls[0].pool, pool, 'the provided pool is forwarded');
    assert.equal(resolverCalls[0].args.appId, 7);
    assert.equal(resolverCalls[0].args.appSlug, 'some-app');
    assert.deepEqual(resolverCalls[0].args.numbers.sort(), [3, 9]);
    assert.deepEqual(resolverCalls[0].args.cause, { kind: 'pr-merge', prNumber: 42 });
  } finally { restore(); }
});

test('watcher: gone (404-skipped) numbers are resolved too', async () => {
  const resolverCalls = [];
  const pool = { async query() { return { rows: [] }; } };
  const { subject, restore } = loadWatcher({
    resolverCalls,
    gh: {
      getPR: async () => ({ body: 'Closes #6' }),
      getIssue: async () => { const e = new Error('Not Found'); e.status = 404; throw e; },
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...WATCH_ARGS, pool });
    await settle();
    assert.deepEqual(res.skipped, [6]);
    assert.equal(resolverCalls.length, 1);
    assert.deepEqual(resolverCalls[0].args.numbers, [6]);
  } finally { restore(); }
});

test('watcher: without a pool the resolver is never required/called and nothing throws', async () => {
  const resolverCalls = [];
  const { subject, restore } = loadWatcher({
    resolverCalls,
    gh: { getPR: async () => ({ body: 'Closes #3' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...WATCH_ARGS });
    await settle();
    assert.deepEqual(res.closed, [3]);
    assert.equal(resolverCalls.length, 0);
  } finally { restore(); }
});

test('watcher: a rejecting resolver never breaks the poll loop', async () => {
  const resolverCalls = [];
  const pool = { async query() { return { rows: [] }; } };
  const { subject, restore } = loadWatcher({
    resolverCalls,
    resolverImpl: async () => { throw new Error('resolver boom'); },
    gh: { getPR: async () => ({ body: 'Closes #3' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...WATCH_ARGS, pool });
    await settle();
    assert.deepEqual(res.closed, [3], 'watch completed normally');
    assert.equal(resolverCalls.length, 1);
  } finally { restore(); }
});

// ── Part 3: the merge-path hook (the merge-followups machine) ───────────
//
// A merge's requests close in the machine's issues.closeAfterMerge work
// (src/workflow/merge-followups/services.ts): it resolves the superseded
// close proposals at once, then watches GitHub close them. The merge is
// already recorded by then, so a resolver failure fails the work item, which
// the kernel retries, rather than being swallowed.

function loadMergeWork({ resolverCalls, resolverImpl }) {
  const ids = {
    github: require.resolve('../src/services/github'),
    issues: require.resolve('../src/routes/issues'),
    watcher: require.resolve('../src/services/issue-close-watcher'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  stub(ids.github, { isEnabled: () => true }, orig.github);
  stub(ids.issues, {
    resolveSupersededCloseProposals: async (pool, args) => {
      resolverCalls.push({ pool, args });
      if (resolverImpl) return resolverImpl(pool, args);
      return { resolved: [] };
    },
  }, orig.issues);
  stub(ids.watcher, {
    async watchIssuesClosedAfterMerge({ linkedIssues }) { return { closed: linkedIssues, skipped: [], stillOpen: [] }; },
  }, orig.watcher);
  const { mergeFollowupsServices } = require('../src/workflow/merge-followups/services.ts');
  const { WORK } = require('../src/workflow/merge-followups/machine.ts');
  const pool = { async query() { return { rows: [] }; } };
  const handler = mergeFollowupsServices({ config: {}, pool })[WORK.issues];
  const run = (input) => handler.run({ input, key: 'issues', attempt: 1, resumeFrom: null, checkpoint: async () => {} });
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { run, pool, restore };
}

const MERGE_INPUT = {
  sessionId: 7, appId: 5, appSlug: 'widget', prNumber: 12, owner: 'acme', repo: 'widget',
  linkedIssues: [42, 43], closeOnly: false,
};

test('merge hook: the machine resolves close proposals for the linked issues the merge closes', async () => {
  const resolverCalls = [];
  const { run, pool, restore } = loadMergeWork({ resolverCalls });
  try {
    await run({ ...MERGE_INPUT });
    assert.equal(resolverCalls.length, 1);
    assert.equal(resolverCalls[0].pool, pool, 'the machine\'s pool forwarded');
    assert.equal(resolverCalls[0].args.appId, 5);
    assert.equal(resolverCalls[0].args.appSlug, 'widget');
    assert.deepEqual(resolverCalls[0].args.numbers, [42, 43]);
    assert.deepEqual(resolverCalls[0].args.cause, { kind: 'pr-merge', prNumber: 12 });
    assert.equal(resolverCalls[0].args.strict, true, 'a failure is reported, not logged away');
  } finally { restore(); }
});

test('merge hook: a rejecting resolver fails the work item, so it is retried', async () => {
  const resolverCalls = [];
  const { run, restore } = loadMergeWork({
    resolverCalls,
    resolverImpl: async () => { throw new Error('resolver boom'); },
  });
  try {
    await assert.rejects(run({ ...MERGE_INPUT }), /resolver boom/);
    assert.equal(resolverCalls.length, 1);
  } finally { restore(); }
});

test('merge hook: no linked issues → resolver never invoked', async () => {
  const resolverCalls = [];
  const { run, restore } = loadMergeWork({ resolverCalls });
  try {
    await run({ ...MERGE_INPUT, linkedIssues: [] });
    assert.equal(resolverCalls.length, 0);
  } finally { restore(); }
});
