// Tests for src/services/issue-autoclose.js (#135) — the post-merge
// deterministic close of `Closes #N`-referenced issues.
//
// Covers the guarantees the merge path depends on:
//   1. Issues GitHub already closed natively are skipped (no double close).
//   2. Still-open issues are closed explicitly via the API.
//   3. Transient close failures retry with backoff and eventually succeed.
//   4. Exhausted retries are reported as failed, never thrown.
//   5. PR-shaped references and 404s are skipped.
//   6. Issue numbers come from the merged PR body's closing keywords
//      unioned with the session's linked_issues.
//   7. A successful self-close busts the issues cache + broadcasts.
//
// Like the other suites we stub collaborators via require.cache so no
// real GitHub calls happen.
//
// Run with: node --test tests/issue-autoclose.test.js

// Zero all delays before the unit under test loads its tunables.
process.env.ISSUE_AUTOCLOSE_GRACE_MS = '0';
process.env.ISSUE_AUTOCLOSE_BACKOFF_MS = '0';
process.env.ISSUE_AUTOCLOSE_ATTEMPTS = '3';

const test = require('node:test');
const assert = require('node:assert/strict');

// Install module stubs before requiring the unit under test.
// `gh` lets each test script the GitHub surface; `calls` records every
// call for assertions; `ws` records broadcast pushes.
function loadWithStubs({ gh = {}, calls, ws }) {
  const ghPath = require.resolve('../src/services/github');
  const wsPath = require.resolve('../src/services/ws');
  const subjectPath = require.resolve('../src/services/issue-autoclose');
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
        return { number: issueNumber, state: 'open' };
      },
      closeIssue: async (owner, repo, issueNumber) => {
        calls.push({ type: 'closeIssue', owner, repo, issueNumber });
        if (gh.closeIssue) return gh.closeIssue(owner, repo, issueNumber);
        return { number: issueNumber, state: 'closed' };
      },
      invalidateIssuesCache: (owner, repo) => {
        calls.push({ type: 'invalidateIssuesCache', owner, repo });
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
  const subject = require('../src/services/issue-autoclose');

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

test('skips issues GitHub already closed natively', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Fix things\n\nCloses #5' }),
      getIssue: async (o, r, n) => ({ number: n, state: 'closed' }),
    },
  });
  try {
    const res = await subject.autoCloseIssuesForMergedPR({ ...BASE_ARGS });
    assert.deepEqual(res.alreadyClosed, [5]);
    assert.deepEqual(res.closed, []);
    assert.equal(calls.filter((c) => c.type === 'closeIssue').length, 0);
    // Nothing self-closed → no extra cache bust / broadcast.
    assert.equal(ws.length, 0);
  } finally { restore(); }
});

test('closes still-open issues and busts the cache + broadcasts', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { getPR: async () => ({ body: 'Closes #3\nfixes #9' }) },
  });
  try {
    const res = await subject.autoCloseIssuesForMergedPR({ ...BASE_ARGS });
    assert.deepEqual(res.closed, [3, 9]);
    assert.deepEqual(
      calls.filter((c) => c.type === 'closeIssue').map((c) => c.issueNumber),
      [3, 9]
    );
    assert.equal(calls.filter((c) => c.type === 'invalidateIssuesCache').length, 1);
    assert.equal(ws.length, 1);
    assert.equal(ws[0].source, 'issue_autoclose');
    assert.equal(ws[0].appSlug, 'some-app');
  } finally { restore(); }
});

test('retries transient failures with backoff and succeeds', async () => {
  const calls = [], ws = [];
  let attempts = 0;
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #4' }),
      closeIssue: async () => {
        attempts++;
        if (attempts < 3) { const e = new Error('boom'); e.status = 502; throw e; }
        return { state: 'closed' };
      },
    },
  });
  try {
    const res = await subject.autoCloseIssuesForMergedPR({ ...BASE_ARGS });
    assert.equal(attempts, 3);
    assert.deepEqual(res.closed, [4]);
    assert.deepEqual(res.failed, []);
  } finally { restore(); }
});

test('reports failed after exhausting attempts, never throws', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: {
      getPR: async () => ({ body: 'Closes #8' }),
      closeIssue: async () => { const e = new Error('still down'); e.status = 500; throw e; },
    },
  });
  try {
    const res = await subject.autoCloseIssuesForMergedPR({ ...BASE_ARGS });
    assert.deepEqual(res.failed, [8]);
    assert.deepEqual(res.closed, []);
    assert.equal(calls.filter((c) => c.type === 'closeIssue').length, 3);
    assert.equal(ws.length, 0);
  } finally { restore(); }
});

test('skips PR-shaped references and 404s', async () => {
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
    const res = await subject.autoCloseIssuesForMergedPR({ ...BASE_ARGS });
    assert.deepEqual(res.skipped.sort(), [2, 6]);
    assert.equal(calls.filter((c) => c.type === 'closeIssue').length, 0);
  } finally { restore(); }
});

test('unions PR-body keywords with linked_issues; falls back when getPR fails', async () => {
  const calls = [], ws = [];
  const { subject, restore } = loadWithStubs({
    calls, ws,
    gh: { getPR: async () => ({ body: 'Resolves #10' }) },
  });
  try {
    const res = await subject.autoCloseIssuesForMergedPR({
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
    const res = await subject2.autoCloseIssuesForMergedPR({
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
    const res = await subject.autoCloseIssuesForMergedPR({ ...BASE_ARGS });
    assert.deepEqual(res, { closed: [], alreadyClosed: [], skipped: [], failed: [] });
    assert.equal(calls.length, 0);
  } finally { restore(); }

  const calls2 = [], ws2 = [];
  const { subject: subject2, restore: restore2 } = loadWithStubs({
    calls: calls2, ws: ws2,
    gh: { getPR: async () => ({ body: 'No keywords here' }) },
  });
  try {
    const res = await subject2.autoCloseIssuesForMergedPR({ ...BASE_ARGS, linkedIssues: [] });
    assert.deepEqual(res.closed, []);
    assert.equal(calls2.filter((c) => c.type === 'getIssue').length, 0);
  } finally { restore2(); }
});
