// Tests for src/services/issue-close-watcher.js (#135): what a merge does
// about the requests it closes, one look at a time, for the merge-followups
// machine's issues.closeAfterMerge work.
//
// Covers the guarantees the merge path depends on:
//   1. Issues GitHub already closed are seen on the first look, one read
//      each, and nothing waits.
//   2. At the first look a LINKED request still open is left to GitHub:
//      nothing is closed by the platform, and the look answers `waiting`,
//      so the machine asks for a second look (its timing is the machine's:
//      tests/workflow-merge-followups-postgres.test.js).
//   3. At the second look the linked requests GitHub left open are closed
//      here, only for a PR merged into its repo's default branch; a number
//      only the PR body names is never closed, at either look.
//   4. PR-shaped references and 404s are skipped.
//   5. Issue numbers come from the merged PR body's closing keywords
//      unioned with the session's linked_issues (getPR failure falls back
//      to linked_issues alone).
//   6. A transient state-check error counts as still open.
//   7. Every close seen or made closes the request's twin row and asks for
//      the Homeroom bot's proposals on it to be withdrawn, strictly: a
//      failure fails the look, for the work to retry.
//   8. `targets` names the open close proposals for the numbers closed or
//      gone, and only those: a close proposal for a request still open is
//      not named until a look sees it closed.
//   9. A look holds nothing between looks and broadcasts nothing itself:
//      the transition that applies its result pushes to every process.
//
// closeIncluded, the requests of a change that went live inside another,
// is pinned at the end.
//
// Like the other suites we stub collaborators via require.cache so no
// real GitHub calls happen.
//
// Run with: node --test tests/issue-close-watcher.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Install module stubs before requiring the unit under test.
// `gh` lets each test script the GitHub surface; `calls` records every
// call for assertions; `ws` records broadcast pushes.
function loadWithStubs({ gh = {}, calls, ws, closedRequests = null }) {
  const ghPath = require.resolve('../src/services/github');
  const wsPath = require.resolve('../src/services/ws');
  const closedPath = require.resolve('../src/services/homeroom-bot-closed-requests');
  const subjectPath = require.resolve('../src/services/issue-close-watcher');
  const prMetaPath = require.resolve('../src/services/pr-metadata');
  const orig = {
    gh: require.cache[ghPath],
    ws: require.cache[wsPath],
    subject: require.cache[subjectPath],
    prMeta: require.cache[prMetaPath],
    closed: require.cache[closedPath],
  };

  require.cache[ghPath] = {
    exports: {
      isEnabled: () => true,
      getPR: async (owner, repo, prNumber) => {
        calls.push({ type: 'getPR', owner, repo, prNumber });
        if (gh.getPR) return gh.getPR(owner, repo, prNumber);
        return { body: '' };
      },
      getIssue: async (owner, repo, issueNumber) => {
        calls.push({ type: 'getIssue', owner, repo, issueNumber });
        if (gh.getIssue) return gh.getIssue(owner, repo, issueNumber);
        return { number: issueNumber, state: 'closed' };
      },
      // Recorded so tests can assert exactly which numbers get closed.
      closeIssue: async (owner, repo, issueNumber) => {
        calls.push({ type: 'closeIssue', owner, repo, issueNumber });
        if (gh.closeIssue) return gh.closeIssue(owner, repo, issueNumber);
        return { number: issueNumber, state: 'closed' };
      },
      invalidateIssuesCache: (owner, repo) => {
        calls.push({ type: 'invalidateIssuesCache', owner, repo });
      },
      noteIssuesClosed: (owner, repo, numbers) => {
        calls.push({ type: 'noteIssuesClosed', owner, repo, numbers: [...numbers] });
        return numbers.length;
      },
      unsuppressIssues: (owner, repo, numbers) => {
        calls.push({ type: 'unsuppressIssues', owner, repo, numbers: [...numbers] });
        return numbers.length;
      },
      ...gh.overrides,
    },
    loaded: true, id: ghPath, filename: ghPath, paths: orig.gh ? orig.gh.paths : [],
  };
  require.cache[wsPath] = {
    exports: {
      pushIssueUpdate: (payload) => { ws.push(payload); },
    },
    loaded: true, id: wsPath, filename: wsPath, paths: orig.ws ? orig.ws.paths : [],
  };
  // The Homeroom bot's proposals for the closed requests.
  require.cache[closedPath] = {
    exports: closedRequests || recordingClosed(),
    loaded: true, id: closedPath, filename: closedPath, paths: orig.closed ? orig.closed.paths : [],
  };
  // pr-metadata requires ./llm and ./github at load time; with github
  // stubbed above a fresh load is safe and gives us the real
  // parseClosingKeywords/sanitizeIssueNumbers (which we want exercised).
  delete require.cache[prMetaPath];
  delete require.cache[subjectPath];
  const subject = require('../src/services/issue-close-watcher');

  const restore = () => {
    if (orig.gh) require.cache[ghPath] = orig.gh; else delete require.cache[ghPath];
    if (orig.ws) require.cache[wsPath] = orig.ws; else delete require.cache[wsPath];
    if (orig.closed) require.cache[closedPath] = orig.closed; else delete require.cache[closedPath];
    delete require.cache[prMetaPath];
    if (orig.prMeta) require.cache[prMetaPath] = orig.prMeta;
    delete require.cache[subjectPath];
    if (orig.subject) require.cache[subjectPath] = orig.subject;
  };
  return { subject, restore };
}

// A pool that records every statement. `fail` makes the twin UPDATE reject;
// `proposals` maps a request number to the id of its open close proposal,
// answered to the targets read.
function recordingPool({ fail = false, proposals = new Map() } = {}) {
  const queries = [];
  return {
    queries,
    twinCloses: () => queries.filter((q) => /UPDATE issues SET status = 'closed'/.test(q.sql)),
    targetReads: () => queries.filter((q) => /kind = 'close_issue'/.test(q.sql)),
    async query(sql, params) {
      queries.push({ sql, params });
      if (fail && /UPDATE issues/.test(sql)) throw new Error('db down');
      if (/kind = 'close_issue'/.test(sql)) {
        const rows = [...proposals].filter(([n]) => params[1].includes(n)).map(([number, id]) => ({ id, number }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function recordingClosed({ fail = false } = {}) {
  const asked = [];
  return {
    asked,
    async noteRequestsClosed(pool, args) {
      asked.push({ appId: args.appId, closed: args.closed, strict: args.strict, tellStrict: args.tellStrict });
      if (fail && args.strict) throw new Error('db down');
      return { withdrawn: [] };
    },
  };
}

const BASE_ARGS = {
  owner: 'usernode-bot', repo: 'some-app', prNumber: 42, appId: 7,
};
const look = (subject, args = {}) => subject.closeAfterMerge({ ...BASE_ARGS, pool: recordingPool(), ...args });

// A PR as GitHub returns it once merged into the app repo's default branch.
function mergedPr(body, over = {}) {
  return {
    body,
    merged: true,
    base: { ref: 'main', repo: { full_name: 'usernode-bot/some-app', default_branch: 'main' } },
    ...over,
  };
}

test('sees already-closed issues at the first look, one read each, and waits for nothing', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { getPR: async () => ({ body: 'Fix things\n\nCloses #3\nfixes #9' }) },
  });
  try {
    const res = await look(subject, { look: 1 });
    assert.deepEqual(res, { closed: [3, 9], skipped: [], stillOpen: [], waiting: false, targets: [] });
    assert.equal(calls.filter((c) => c.type === 'getIssue').length, 2);
    // Nothing kept or broadcast here: the transition that applies the
    // result tells every process (merge-followups machine.ts issuesClosed).
    assert.deepEqual(calls.filter((c) => ['noteIssuesClosed', 'unsuppressIssues', 'invalidateIssuesCache'].includes(c.type)), []);
    assert.equal(ws.length, 0);
  } finally { restore(); }
});

test('look 1: a linked request still open waits for GitHub; the platform closes nothing', async () => {
  const calls = [], ws = [];
  const closed = recordingClosed();
  const { subject, restore } = loadWithStubs({
    calls, ws, closedRequests: closed,
    gh: {
      getPR: async () => mergedPr('Closes #4\nCloses #5'),
      getIssue: async (o, r, n) => ({ number: n, state: n === 5 ? 'closed' : 'open' }),
    },
  });
  try {
    const pool = recordingPool({ proposals: new Map([[4, 61], [5, 62]]) });
    const res = await subject.closeAfterMerge({ ...BASE_ARGS, linkedIssues: [4, 5], pool, look: 1 });
    assert.equal(res.waiting, true, 'a second look is asked for');
    assert.deepEqual(res.closed, [5]);
    assert.deepEqual(res.stillOpen, [4]);
    assert.equal(calls.filter((c) => c.type === 'closeIssue').length, 0, 'GitHub is given its time');
    // Only what is closed is recorded closed, and named for the governance machine.
    assert.deepEqual(pool.twinCloses().map((q) => q.params[1]), [[5]]);
    assert.deepEqual(closed.asked.map((a) => a.closed), [[5]]);
    assert.deepEqual(res.targets, [{ issueId: 62, number: 5 }], 'the close proposal for #4 waits for #4 to close');
  } finally { restore(); }
});

test('look 1 is the default; an open number only the PR body names is not waited for', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => mergedPr('Closes #5'),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    const linkedOpen = await look(subject, { linkedIssues: [5] });
    assert.equal(linkedOpen.waiting, true);
    assert.equal(calls.filter((c) => c.type === 'closeIssue').length, 0);
    const bodyOnly = await look(subject, { look: 1 });
    assert.deepEqual([bodyOnly.waiting, bodyOnly.stillOpen], [false, [5]], 'never closed here, so not waited for');
  } finally { restore(); }
});

test('look 2: closes the linked issues GitHub left open, skips closed and unlinked ones', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      // #20 is only in the body; #10 and #11 are linked.
      getPR: async () => mergedPr('Closes #10\nCloses #11\nfixes #20'),
      getIssue: async (o, r, n) => ({ number: n, state: n === 11 ? 'closed' : 'open' }),
    },
  });
  try {
    const pool = recordingPool({ proposals: new Map([[10, 70], [20, 71]]) });
    const res = await subject.closeAfterMerge({ ...BASE_ARGS, linkedIssues: [10, 11], pool, look: 2 });
    const closes = calls.filter((c) => c.type === 'closeIssue');
    assert.deepEqual(closes.map((c) => c.issueNumber), [10], 'only the still-open linked issue');
    assert.equal(closes[0].owner, 'usernode-bot');
    assert.equal(closes[0].repo, 'some-app');
    // One read of each number, then the close: no polling.
    const firstClose = calls.findIndex((c) => c.type === 'closeIssue');
    assert.equal(calls.slice(0, firstClose).filter((c) => c.type === 'getIssue').length, 3);
    assert.deepEqual([...res.closed].sort((a, b) => a - b), [10, 11]);
    assert.deepEqual(res.stillOpen, [20]);
    assert.equal(res.waiting, false, 'the second look is the last');
    assert.deepEqual(res.targets, [{ issueId: 70, number: 10 }], 'a request still open names no close proposal');
  } finally { restore(); }
});

test('look 2: a failed GitHub close leaves the issue still open', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => mergedPr('Closes #10\nCloses #12'),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
      closeIssue: async (o, r, n) => {
        if (n === 12) { const e = new Error('Forbidden'); e.status = 403; throw e; }
        return { number: n, state: 'closed' };
      },
    },
  });
  try {
    const res = await look(subject, { linkedIssues: [10, 12], look: 2 });
    assert.deepEqual(res.closed, [10]);
    assert.deepEqual(res.stillOpen, [12]);
    assert.equal(res.waiting, false);
  } finally { restore(); }
});

test('look 2 closes nothing unless the PR reads as merged into its own default branch', async () => {
  const cases = [
    ['PR fetch failed', async () => { throw new Error('rate limited'); }],
    ['not merged', async () => mergedPr('Closes #10', { merged: false })],
    ['other base branch', async () => mergedPr('Closes #10', {
      base: { ref: 'staging', repo: { full_name: 'usernode-bot/some-app', default_branch: 'main' } },
    })],
    ['other repository', async () => mergedPr('Closes #10', {
      base: { ref: 'main', repo: { full_name: 'someone/else', default_branch: 'main' } },
    })],
  ];
  for (const [label, getPR] of cases) {
    const calls = [], ws = [];
    const { subject, restore } = loadWithStubs({
      calls, ws,
      gh: { getPR, getIssue: async (o, r, n) => ({ number: n, state: 'open' }) },
    });
    try {
      const res = await look(subject, { linkedIssues: [10], look: 2 });
      assert.equal(calls.filter((c) => c.type === 'closeIssue').length, 0, label);
      assert.deepEqual(res.stillOpen, [10], label);
      assert.deepEqual(res.targets, [], label);
    } finally { restore(); }
  }
});

test('never closes a number only the PR body names, at either look', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => mergedPr('Closes #5'),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    await look(subject, { look: 1 });
    const res = await look(subject, { look: 2 });
    assert.equal(calls.filter((c) => c.type === 'closeIssue').length, 0);
    assert.deepEqual(res.stillOpen, [5]);
  } finally { restore(); }
});

test('skips PR-shaped references and 404s, and names their close proposals', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #2, fixes #6' }),
      getIssue: async (o, r, n) => {
        if (n === 2) return { number: 2, state: 'open', pull_request: { url: 'x' } };
        const e = new Error('Not Found'); e.status = 404; throw e;
      },
    },
  });
  try {
    const pool = recordingPool({ proposals: new Map([[6, 80]]) });
    const res = await subject.closeAfterMerge({ ...BASE_ARGS, pool, look: 1 });
    assert.deepEqual([...res.skipped].sort(), [2, 6]);
    assert.deepEqual(res.stillOpen, []);
    assert.equal(res.waiting, false);
    assert.equal(calls.filter((c) => c.type === 'getIssue').length, 2);
    // A request that is gone never closes later.
    assert.deepEqual(res.targets, [{ issueId: 80, number: 6 }]);
    assert.equal(pool.twinCloses().length, 0, 'nothing was seen closed');
  } finally { restore(); }
});

test('a transient state-check error counts as still open, for the next look', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => mergedPr('Closes #7'),
      getIssue: async () => { const e = new Error('boom'); e.status = 502; throw e; },
    },
  });
  try {
    const first = await look(subject, { linkedIssues: [7], look: 1 });
    assert.deepEqual([first.waiting, first.stillOpen, first.closed], [true, [7], []]);
    const second = await look(subject, { linkedIssues: [7], look: 2 });
    assert.deepEqual(second.closed, [7], 'a linked one is closed at the second look');
  } finally { restore(); }
});

test('unions PR-body keywords with linked_issues; falls back when getPR fails', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { getPR: async () => ({ body: 'Resolves #10' }) },
  });
  try {
    const res = await look(subject, { linkedIssues: [10, 12, 'junk', -3] });
    assert.deepEqual(res.closed, [10, 12]);
  } finally { restore(); }

  const calls2 = [], ws2 = [];
  const { subject: subject2, restore: restore2 } = loadWithStubs({
    calls: calls2, ws: ws2,
    gh: { getPR: async () => { throw new Error('rate limited'); } },
  });
  try {
    const res = await look(subject2, { linkedIssues: [15] });
    assert.deepEqual(res.closed, [15]);
  } finally { restore2(); }
});

test('no-ops cleanly when GitHub is disabled or nothing is referenced', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { overrides: { isEnabled: () => false } },
  });
  try {
    const pool = recordingPool();
    const res = await subject.closeAfterMerge({ ...BASE_ARGS, linkedIssues: [3], pool, look: 2 });
    assert.deepEqual(res, { closed: [], skipped: [], stillOpen: [], waiting: false, targets: [] });
    assert.equal(calls.length, 0);
    assert.equal(pool.queries.length, 0);
  } finally { restore(); }

  const calls2 = [], ws2 = [];
  const { subject: subject2, restore: restore2 } = loadWithStubs({
    calls: calls2, ws: ws2,
    gh: { getPR: async () => ({ body: 'No keywords here' }) },
  });
  try {
    const res = await look(subject2, { linkedIssues: [] });
    assert.deepEqual(res.closed, []);
    assert.equal(calls2.filter((c) => c.type === 'getIssue').length, 0);
  } finally { restore2(); }
});

test('mergedIntoDefaultBranch tolerates a .git suffix and case', () => {
  const { subject, restore } = loadWithStubs({ calls: [], ws: [] });
  try {
    assert.equal(subject.mergedIntoDefaultBranch(mergedPr(''), 'Usernode-Bot', 'some-app.git'), true);
    assert.equal(subject.mergedIntoDefaultBranch(null, 'usernode-bot', 'some-app'), false);
    assert.equal(subject.mergedIntoDefaultBranch({ merged: true }, 'usernode-bot', 'some-app'), false);
  } finally { restore(); }
});

// ── The close proposals the governance machine is told about ────────────

test('targets: the app\'s open close proposals for the closed and gone numbers', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #3\nfixes #9\nfixes #11' }),
      getIssue: async (o, r, n) => {
        if (n === 11) { const e = new Error('Gone'); e.status = 410; throw e; }
        return { number: n, state: 'closed' };
      },
    },
  });
  try {
    const pool = recordingPool({ proposals: new Map([[3, 90], [11, 91]]) });
    const res = await subject.closeAfterMerge({ ...BASE_ARGS, pool });
    const [read] = pool.targetReads();
    assert.match(read.sql, /app_id = \$1/);
    assert.match(read.sql, /status = 'open'/);
    assert.deepEqual(read.params, [7, [3, 9, 11]]);
    assert.deepEqual(res.targets, [{ issueId: 90, number: 3 }, { issueId: 91, number: 11 }]);
  } finally { restore(); }
});

// ── The request's own twin row ──────────────────────────────────────────
//
// A platform-filed request keeps a `general` row in `issues` beside its
// GitHub issue (services/governance-kinds.js). Before this, only an applied
// close-issue vote closed it, so a request a merged proposal closed kept an
// open twin for good: Plant Pal's #1 still read open after PR #2 closed it.

test('an observed close closes the open general twins of those numbers on that app', async () => {
  const calls = [], ws = [];
  const pool = recordingPool();
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { getPR: async () => ({ body: 'Closes #3\nfixes #9' }) },
  });
  try {
    const res = await subject.closeAfterMerge({ ...BASE_ARGS, pool });
    assert.deepEqual(res.closed, [3, 9]);
    const updates = pool.twinCloses();
    assert.equal(updates.length, 1);
    // Only the request's own twin, only while it still reads open, only on this app.
    assert.match(updates[0].sql, /kind = 'general'/);
    assert.match(updates[0].sql, /status = 'open'/);
    assert.match(updates[0].sql, /app_id = \$1/);
    assert.deepEqual(updates[0].params, [7, [3, 9]]);
  } finally { restore(); }
});

test('a linked issue closed at the second look closes its twin; one still open does not', async () => {
  const calls = [], ws = [];
  const pool = recordingPool();
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      // #20 is only in the body, so it is looked at but never closed here.
      getPR: async () => mergedPr('Closes #10\nfixes #20'),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    const res = await subject.closeAfterMerge({ ...BASE_ARGS, linkedIssues: [10], pool, look: 2 });
    assert.deepEqual(res.closed, [10]);
    assert.deepEqual(res.stillOpen, [20]);
    const closedNumbers = pool.twinCloses().flatMap((q) => q.params[1]);
    assert.deepEqual(closedNumbers, [10], 'a number GitHub still reports open keeps its twin open');
  } finally { restore(); }
});

test('nothing closes a twin while every referenced issue is still open', async () => {
  const calls = [], ws = [];
  const pool = recordingPool();
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #5' }),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    const res = await subject.closeAfterMerge({ ...BASE_ARGS, linkedIssues: [5], pool, look: 1 });
    assert.deepEqual(res.stillOpen, [5]);
    assert.equal(pool.twinCloses().length, 0);
    assert.equal(pool.targetReads().length, 0, 'no close proposal is named either');
  } finally { restore(); }
});

// The merge-followups machine runs the look as durable work: a close it
// could not record must fail the work, which is then retried, instead of
// settling while the twin stays open.
test('a failing twin close fails the look, for the work to retry', async () => {
  const calls = [], ws = [];
  const pool = recordingPool({ fail: true });
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { getPR: async () => ({ body: 'Closes #3' }) },
  });
  try {
    await assert.rejects(subject.closeAfterMerge({ ...BASE_ARGS, pool }), /db down/);
    assert.equal(pool.twinCloses().length, 1);
  } finally { restore(); }
});

// ── The Homeroom bot's proposals for the closed requests ────────────────
// A request a person's change shipped kept the bot's proposal for it up for
// a vote, and one of the bot's five slots on the project with it, for good
// (#4817, shipped by #4822 while the bot's #4819 stayed up). Every close a
// look sees, or makes, asks for them to be withdrawn.

test('an observed close asks, strictly, for the bot\'s proposals on those requests to be withdrawn', async () => {
  const calls = [], ws = [];
  const closed = recordingClosed();
  const { subject, restore } = loadWithStubs({
    calls, ws, closedRequests: closed,
    gh: { getPR: async () => ({ body: 'Closes #3\nfixes #9' }) },
  });
  try {
    const res = await look(subject);
    assert.deepEqual(res.closed, [3, 9]);
    assert.deepEqual(closed.asked, [{ appId: 7, closed: [3, 9], strict: true, tellStrict: false }]);
  } finally { restore(); }
});

test('a linked issue closed at the second look is asked about too; one still open is not', async () => {
  const calls = [], ws = [];
  const closed = recordingClosed();
  const { subject, restore } = loadWithStubs({
    calls, ws, closedRequests: closed,
    gh: {
      getPR: async () => mergedPr('Closes #10\nfixes #20'),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    const res = await look(subject, { linkedIssues: [10], look: 2 });
    assert.deepEqual(res.stillOpen, [20]);
    assert.deepEqual(closed.asked, [{ appId: 7, closed: [10], strict: true, tellStrict: false }]);
  } finally { restore(); }
});

test('nothing is withdrawn while every referenced issue is still open', async () => {
  const calls = [], ws = [];
  const closed = recordingClosed();
  const { subject, restore } = loadWithStubs({
    calls, ws, closedRequests: closed,
    gh: {
      getPR: async () => ({ body: 'Closes #5' }),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    await look(subject, { linkedIssues: [5], look: 1 });
    await look(subject, { look: 2 });
    assert.deepEqual(closed.asked, []);
  } finally { restore(); }
});

test('a failing withdrawal fails the look', async () => {
  const calls = [], ws = [];
  const closed = recordingClosed({ fail: true });
  const { subject, restore } = loadWithStubs({
    calls, ws, closedRequests: closed,
    gh: { getPR: async () => ({ body: 'Closes #3' }) },
  });
  try {
    await assert.rejects(look(subject), /db down/);
    assert.deepEqual(closed.asked.map((a) => a.strict), [true]);
  } finally { restore(); }
});

// ── A change that went live inside another one ──────────────────────────
// Its own pull request never merges, so nothing closes its requests but
// closeIncluded (the merge-followups machine's issues work, closeOnly).

test('closeIncluded closes every linked request, records the closes, and names their close proposals', async () => {
  const calls = [], ws = [];
  const closed = recordingClosed();
  const { subject, restore } = loadWithStubs({
    calls, ws, closedRequests: closed,
    gh: {
      closeIssue: async (o, r, n) => {
        if (n === 4) { const e = new Error('Service Unavailable'); e.status = 503; throw e; }
        if (n === 5) throw new Error('socket hang up');
        return { number: n, state: 'closed' };
      },
    },
  });
  try {
    const pool = recordingPool({ proposals: new Map([[3, 95], [4, 96]]) });
    const res = await subject.closeIncluded({ ...BASE_ARGS, prNumber: 9, linkedIssues: [3, 4, 5, 'x'], pool });
    assert.deepEqual(calls.filter((c) => c.type === 'closeIssue').map((c) => c.issueNumber), [3, 4, 5]);
    assert.deepEqual(calls.filter((c) => c.type === 'getPR' || c.type === 'getIssue'), [], 'it closes what it was linked to, without a look');
    assert.deepEqual(res.closed, [3]);
    assert.deepEqual(res.failed, [{ number: 4, status: 503 }, { number: 5, status: null }]);
    assert.deepEqual(res.targets, [{ issueId: 95, number: 3 }], 'only a request it closed');
    assert.deepEqual(pool.twinCloses().map((q) => q.params), [[7, [3]]]);
    assert.deepEqual(closed.asked, [{ appId: 7, closed: [3], strict: true, tellStrict: false }]);
  } finally { restore(); }
});

// A request that is gone never closes later: its close proposal is
// superseded as a closed one's is (review, 2026-10-17).
test('closeIncluded: a gone request names its close proposals too', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws, closedRequests: recordingClosed(),
    gh: { closeIssue: async (o, r, n) => { if (n === 4) { const e = new Error('Not Found'); e.status = 404; throw e; } return { number: n }; } },
  });
  try {
    const pool = recordingPool({ proposals: new Map([[3, 95], [4, 96]]) });
    const res = await subject.closeIncluded({ ...BASE_ARGS, prNumber: 9, linkedIssues: [3, 4], pool });
    assert.deepEqual(res.targets, [{ issueId: 95, number: 3 }, { issueId: 96, number: 4 }]);
  } finally { restore(); }
});

test('closeIncluded: nothing linked or GitHub off closes nothing; a failed record fails it', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({ calls, ws });
  try {
    const pool = recordingPool();
    assert.deepEqual(await subject.closeIncluded({ ...BASE_ARGS, linkedIssues: [], pool }), { closed: [], failed: [], targets: [] });
    assert.equal(calls.length + pool.queries.length, 0);
    await assert.rejects(subject.closeIncluded({ ...BASE_ARGS, linkedIssues: [3], pool: recordingPool({ fail: true }) }), /db down/);
  } finally { restore(); }

  const calls2 = [], ws2 = [];
  const { subject: subject2, restore: restore2 } = loadWithStubs({
    calls: calls2, ws: ws2, gh: { overrides: { isEnabled: () => false } },
  });
  try {
    assert.deepEqual(await subject2.closeIncluded({ ...BASE_ARGS, linkedIssues: [3], pool: recordingPool() }),
      { closed: [], failed: [], targets: [] });
    assert.equal(calls2.length, 0);
  } finally { restore2(); }
});

test('the watcher keeps no poll and no deleted entry point', () => {
  const { subject, restore } = loadWithStubs({ calls: [], ws: [] });
  try {
    assert.deepEqual(Object.keys(subject).sort(),
      ['bustAndBroadcast', 'closeAfterMerge', 'closeIncluded', 'closeTwinRows', 'mergedIntoDefaultBranch', 'resolveIssueNumbers']);
    const src = require('node:fs').readFileSync(require.resolve('../src/services/issue-close-watcher'), 'utf8');
    assert.doesNotMatch(src, /setTimeout|ISSUE_CLOSE_WATCH_/, 'a look is one pass: the machine times the second');
  } finally { restore(); }
});
