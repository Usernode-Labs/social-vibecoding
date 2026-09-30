'use strict';

// #2722: the merge-time Content rules row. The rules themselves live in the
// conventions' "Content rules" section; this pins the row the checks
// pipeline receives: pass, flag, advisory vs blocking, the skip rule,
// fail-open, the truncation note, and one model call per head.

const test = require('node:test');
const assert = require('node:assert/strict');

const contentReview = require('../src/services/content-review');
const { classifyTests } = require('../src/services/visuals');

const SHA = 'a'.repeat(40);
const LOADS = [{ name: 'loads with no console errors', path: '/', status: 'pass' }];

function fakeDeps({ diff = 'diff --git a/src/app.js b/src/app.js\n+const title = "Hello";\n', truncated = false, review, diffError, reviewError, enabled = true } = {}) {
  const calls = { diff: 0, review: 0, system: null, basehead: null };
  return {
    calls,
    deps: {
      github: {
        async getProposalDiff(owner, repo, basehead) {
          calls.diff += 1; calls.basehead = basehead;
          if (diffError) throw diffError;
          return { diff, truncated, fileCount: 1 };
        },
      },
      llm: {
        isEnabled: () => enabled,
        async reviewContentRules({ system }) {
          calls.review += 1; calls.system = system;
          if (reviewError) throw reviewError;
          return review || { verdict: 'pass', category: '', file: '', reason: '' };
        },
      },
      prompts: require('../src/services/prompts'),
    },
  };
}

function run(opts, env = {}) {
  const prev = process.env.CONTENT_REVIEW_MODE;
  if ('mode' in env) process.env.CONTENT_REVIEW_MODE = env.mode; else delete process.env.CONTENT_REVIEW_MODE;
  contentReview._resetCache();
  return contentReview.maybeRunContentReview({
    pool: null, sessionId: 1, repoOwner: 'o', repoName: 'r', commitHash: SHA, ...opts,
  }).finally(() => {
    if (prev === undefined) delete process.env.CONTENT_REVIEW_MODE; else process.env.CONTENT_REVIEW_MODE = prev;
  });
}

test('a clean diff passes, reviewed against the conventions section itself', async () => {
  const { deps, calls } = fakeDeps();
  const out = await run({ deps });
  assert.equal(out.row.name, 'Content rules');
  assert.equal(out.row.status, 'pass');
  assert.equal(out.row.summary, 'Passes');
  assert.equal(calls.basehead, `main...${SHA}`);
  const section = require('../src/services/prompts').getConventionSection(contentReview.RULES_SLUG);
  assert.ok(calls.system.includes(section.content), 'the rules are read from the conventions, never copied');
});

test('a flag is advisory by default and names the category and file', async () => {
  const { deps } = fakeDeps({ review: { verdict: 'flag', category: 'Sexual content or nudity', file: 'src/pages/dares.js', reason: 'The dares are sexual.' } });
  const out = await run({ deps });
  assert.equal(out.row.status, 'fail');
  assert.equal(out.row.advisory, true);
  assert.match(out.row.failureReason, /^Flagged: Sexual content or nudity in src\/pages\/dares\.js\. The dares are sexual\./);
  assert.equal(classifyTests(LOADS, 1, { extraRows: [out.row] }).state, 'passing', 'advisory never closes the gate');
});

test('in blocking mode a flag fails the checks', async () => {
  const { deps } = fakeDeps({ review: { verdict: 'flag', category: 'Violence', file: 'game.js', reason: 'A gun.' } });
  const out = await run({ deps }, { mode: 'blocking' });
  assert.equal(out.row.advisory, false);
  assert.equal(classifyTests(LOADS, 1, { extraRows: [out.row] }).state, 'failing');
});

test('off means no row at all', async () => {
  const { deps, calls } = fakeDeps();
  assert.equal(await run({ deps }, { mode: 'off' }), null);
  assert.equal(calls.diff, 0);
});

test('a diff of only lockfiles and binaries passes without calling the model', async () => {
  const { deps, calls } = fakeDeps({ diff: 'diff --git a/package-lock.json b/package-lock.json\n+x\ndiff --git a/logo.png b/logo.png\n(no textual diff)\n' });
  const out = await run({ deps });
  assert.equal(out.row.status, 'pass');
  assert.equal(calls.review, 0);
});

test('fails open: a GitHub or model error is an advisory pass that says it was not reviewed', async () => {
  for (const opts of [{ diffError: new Error('502') }, { reviewError: new Error('overloaded') }, { enabled: false }]) {
    const { deps } = fakeDeps(opts);
    const out = await run({ deps }, { mode: 'blocking' });
    assert.equal(out.row.status, 'pass');
    assert.equal(out.row.advisory, true);
    assert.match(out.row.summary, /not reviewed/);
  }
});

test('a truncated diff says only part of it was reviewed', async () => {
  const { deps } = fakeDeps({ truncated: true, review: { verdict: 'flag', category: 'Gambling', file: 'casino.js', reason: 'Slots.' } });
  const out = await run({ deps });
  assert.match(out.row.failureReason, /first part of a large diff/);
});

test('one model call per head', async () => {
  const { deps, calls } = fakeDeps();
  contentReview._resetCache();
  delete process.env.CONTENT_REVIEW_MODE;
  const args = { pool: null, sessionId: 7, repoOwner: 'o', repoName: 'r', commitHash: SHA, deps };
  await contentReview.maybeRunContentReview(args);
  await contentReview.maybeRunContentReview(args);
  assert.equal(calls.review, 1);
});

test('a verdict stored on this head is reused, with the current mode applied', async () => {
  const { deps, calls } = fakeDeps();
  const stored = contentReview.shapeRow({
    review: { verdict: 'flag', category: 'Violence', file: 'a.js', reason: 'x' },
    reviewMode: 'advisory', reviewedSha: SHA,
  });
  const pool = { query: async () => ({ rows: [{ test_results: [stored] }] }) };
  const out = await run({ deps, pool }, { mode: 'blocking' });
  assert.equal(calls.review, 0);
  assert.equal(out.row.advisory, false);
});
