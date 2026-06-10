// Tests for src/services/issue-close-watcher.js (#135) — the post-merge
// poll that waits for GitHub's own `Closes #N` auto-close to land, then
// busts the open-issues cache + broadcasts so the group-chat panel drops
// the issue.
//
// Covers the guarantees the merge path depends on:
//   1. Issues GitHub already closed are confirmed on the first poll and
//      trigger exactly one cache bust + broadcast.
//   2. Issues that close a few polls in are retried with backoff and the
//      broadcast fires once the closed state is observed.
//   3. The watcher NEVER writes to GitHub (no closeIssue calls).
//   4. Exhausted retries report stillOpen, no broadcast, never throw.
//   5. PR-shaped references and 404s are dropped from the watch.
//   6. Issue numbers come from the merged PR body's closing keywords
//      unioned with the session's linked_issues (getPR failure falls back
//      to linked_issues alone).
//   7. Transient state-check errors keep the issue in the watch.
//
// Like the other suites we stub collaborators via require.cache so no
// real GitHub calls happen.
//
// Run with: node --test tests/issue-close-watcher.test.js

// Zero all delays before the unit under test loads its tunables.
process.env.ISSUE_CLOSE_WATCH_GRACE_MS = '0';
process.env.ISSUE_CLOSE_WATCH_BACKOFF_MS = '0';
process.env.ISSUE_CLOSE_WATCH_ATTEMPTS = '3';

const test = require('node:test');
const assert = require('node:assert/strict');

// Install module stubs before requiring the unit under test.
// `gh` lets each test script the GitHub surface; `calls` records every
// call for assertions; `ws` records broadcast pushes.
function loadWithStubs({ gh = {}, calls, ws }) {
  const ghPath = require.resolve('../src/services/github');
  const wsPath = require.resolve('../src/services/ws');
  const subjectPath = require.resolve('../src/services/issue-close-watcher');
  const prMetaPath = require.resolve('../src/services/pr-metadata');
  const orig = {
    gh: require.cache[ghPath],
    ws: require.cache[wsPath],
    subject: require.cache[subjectPath],
    prMeta: require.cache[prMetaPath],
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
      // The watcher must never call this — recorded so tests can assert 0.
      closeIssue: async (owner, repo, issueNumber) => {
        calls.push({ type: 'closeIssue', owner, repo, issueNumber });
        return { number: issueNumber, state: 'closed' };
      },
      invalidateIssuesCache: (owner, repo) => {
        calls.push({ type: 'invalidateIssuesCache', owner, repo });
      },
      // #144: known-closed suppression hooks the watcher drives.
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
  // pr-metadata requires ./llm and ./github at load time; with github
  // stubbed above a fresh load is safe and gives us the real
  // parseClosingKeywords/sanitizeIssueNumbers (which we want exercised).
  delete require.cache[prMetaPath];
  delete require.cache[subjectPath];
  const subject = require('../src/services/issue-close-watcher');

  const restore = () => {
    if (orig.gh) require.cache[ghPath] = orig.gh; else delete require.cache[ghPath];
    if (orig.ws) require.cache[wsPath] = orig.ws; else delete require.cache[wsPath];
    delete require.cache[prMetaPath];
    if (orig.prMeta) require.cache[prMetaPath] = orig.prMeta;
    delete require.cache[subjectPath];
    if (orig.subject) require.cache[subjectPath] = orig.subject;
  };
  return { subject, restore };
}

const BASE_ARGS = {
  owner: 'usernode-bot', repo: 'some-app', prNumber: 42,
  appSlug: 'some-app', appId: 7,
};

test('confirms already-closed issues on the first poll and broadcasts once', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { getPR: async () => ({ body: 'Fix things\n\nCloses #3\nfixes #9' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.deepEqual(res.closed, [3, 9]);
    assert.deepEqual(res.stillOpen, []);
    assert.equal(calls.filter((c) => c.type === 'invalidateIssuesCache').length, 1);
    // #144: suppressed optimistically up front, re-suppressed on the
    // observed close, and nothing unsuppressed (everything DID close).
    const noted = calls.filter((c) => c.type === 'noteIssuesClosed');
    assert.deepEqual(noted[0].numbers, [3, 9]);
    assert.deepEqual(noted[noted.length - 1].numbers, [3, 9]);
    assert.equal(calls.filter((c) => c.type === 'unsuppressIssues').length, 0);
    assert.equal(ws.length, 1);
    assert.equal(ws[0].source, 'issue_close_watcher');
    assert.equal(ws[0].appSlug, 'some-app');
    // One poll round was enough — no extra getIssue calls.
    assert.equal(calls.filter((c) => c.type === 'getIssue').length, 2);
  } finally { restore(); }
});

test('keeps polling until GitHub reports closed, then broadcasts', async () => {
  const calls = [], ws = [];
  let polls = 0;
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #4' }),
      getIssue: async (o, r, n) => {
        polls++;
        // GitHub's delayed auto-close lands on the third poll.
        return { number: n, state: polls < 3 ? 'open' : 'closed' };
      },
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.equal(polls, 3);
    assert.deepEqual(res.closed, [4]);
    assert.deepEqual(res.stillOpen, []);
    assert.equal(ws.length, 1);
  } finally { restore(); }
});

test('never writes to GitHub', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #5' }),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.equal(calls.filter((c) => c.type === 'closeIssue').length, 0);
  } finally { restore(); }
});

test('reports stillOpen after exhausting attempts, no broadcast, never throws', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #8' }),
      getIssue: async (o, r, n) => ({ number: n, state: 'open' }),
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.deepEqual(res.stillOpen, [8]);
    assert.deepEqual(res.closed, []);
    // ISSUE_CLOSE_WATCH_ATTEMPTS=3 poll rounds, one issue each.
    assert.equal(calls.filter((c) => c.type === 'getIssue').length, 3);
    assert.equal(ws.length, 0);
    assert.equal(calls.filter((c) => c.type === 'invalidateIssuesCache').length, 0);
    // #144: the optimistic suppression is lifted for a genuinely-open
    // issue so it isn't hidden from the panel for the suppression TTL.
    const unsup = calls.filter((c) => c.type === 'unsuppressIssues');
    assert.equal(unsup.length, 1);
    assert.deepEqual(unsup[0].numbers, [8]);
  } finally { restore(); }
});

test('drops PR-shaped references and 404s from the watch', async () => {
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
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.deepEqual(res.skipped.sort(), [2, 6]);
    assert.deepEqual(res.stillOpen, []);
    assert.equal(ws.length, 0);
    // Both dropped in round one — no further polling.
    assert.equal(calls.filter((c) => c.type === 'getIssue').length, 2);
  } finally { restore(); }
});

test('transient state-check errors keep the issue in the watch', async () => {
  const calls = [], ws = [];
  let polls = 0;
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #7' }),
      getIssue: async (o, r, n) => {
        polls++;
        if (polls === 1) { const e = new Error('boom'); e.status = 502; throw e; }
        return { number: n, state: 'closed' };
      },
    },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.equal(polls, 2);
    assert.deepEqual(res.closed, [7]);
    assert.equal(ws.length, 1);
  } finally { restore(); }
});

test('unions PR-body keywords with linked_issues; falls back when getPR fails', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { getPR: async () => ({ body: 'Resolves #10' }) },
  });
  try {
    const res = await subject.watchIssuesClosedAfterMerge({
      ...BASE_ARGS, linkedIssues: [10, 12, 'junk', -3],
    });
    assert.deepEqual(res.closed, [10, 12]);
  } finally { restore(); }

  const calls2 = [], ws2 = [];
  const { subject: subject2, restore: restore2 } = loadWithStubs({
    calls: calls2, ws: ws2,
    gh: { getPR: async () => { throw new Error('rate limited'); } },
  });
  try {
    const res = await subject2.watchIssuesClosedAfterMerge({
      ...BASE_ARGS, linkedIssues: [15],
    });
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
    const res = await subject.watchIssuesClosedAfterMerge({ ...BASE_ARGS });
    assert.deepEqual(res, { closed: [], skipped: [], stillOpen: [] });
    assert.equal(calls.length, 0);
  } finally { restore(); }

  const calls2 = [], ws2 = [];
  const { subject: subject2, restore: restore2 } = loadWithStubs({
    calls: calls2, ws: ws2,
    gh: { getPR: async () => ({ body: 'No keywords here' }) },
  });
  try {
    const res = await subject2.watchIssuesClosedAfterMerge({ ...BASE_ARGS, linkedIssues: [] });
    assert.deepEqual(res.closed, []);
    assert.equal(calls2.filter((c) => c.type === 'getIssue').length, 0);
    assert.equal(ws2.length, 0);
  } finally { restore2(); }
});
