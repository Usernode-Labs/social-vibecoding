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

function fakeDeps({ diff = 'diff --git a/src/app.js b/src/app.js\n+const title = "Hello";\n', truncated = false, files, filesComplete, review, diffError, reviewError, enabled = true } = {}) {
  const calls = { diff: 0, review: 0, system: null, basehead: null, input: null };
  return {
    calls,
    deps: {
      github: {
        async getProposalDiff(owner, repo, basehead) {
          calls.diff += 1; calls.basehead = basehead;
          if (diffError) throw diffError;
          const out = { diff, truncated, fileCount: Array.isArray(files) ? files.length : 1 };
          if (Array.isArray(files)) out.files = files;
          if (filesComplete !== undefined) out.filesComplete = filesComplete;
          return out;
        },
      },
      llm: {
        isEnabled: () => enabled,
        async reviewContentRules({ system, diff: input }) {
          calls.review += 1; calls.system = system; calls.input = input;
          if (reviewError) throw reviewError;
          return review || { verdict: 'pass', category: '', file: '', reason: '' };
        },
      },
      prompts: require('../src/services/prompts'),
    },
  };
}

const filesOf = (...paths) => paths.map((p) => ({ filename: p, previous: null }));

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

test('the review holds a change to the data rules too, read from their section (#5117)', async () => {
  const prompts = require('../src/services/prompts');
  const data = prompts.getConventionSection(contentReview.DATA_RULES_SLUG);
  assert.ok(data && data.content, 'the data rules resolve by their slug');
  const { deps, calls } = fakeDeps();
  await run({ deps });
  assert.ok(calls.system.includes(data.content), 'the data rules are read from the conventions, never copied');
  assert.match(calls.system, /content rules and data rules/);
  for (const term of [/trackers/, /special-category data/, /children/, /passwords or payment card data/, /login, signup or outside sign-in/]) {
    assert.match(calls.system, term);
  }
  // Without the section the review still runs on the content rules alone.
  const plain = contentReview.buildSystemPrompt('RULES');
  assert.match(plain, /against the platform's content rules below/);
  assert.doesNotMatch(plain, /data rules/);
});

test('a data-rule break is flagged like a content-rule one, naming the rule', async () => {
  const diff = 'diff --git a/public/index.html b/public/index.html\n+<script src="https://cdn.example/track.js"></script>\n';
  const { deps } = fakeDeps({ diff, files: filesOf('public/index.html'), review: { verdict: 'flag', category: 'Third-party trackers or external scripts', file: 'public/index.html', reason: 'It loads an analytics script from another origin.' } });
  const out = await run({ deps });
  assert.equal(out.row.status, 'fail');
  assert.equal(out.row.advisory, true);
  assert.match(out.row.failureReason, /^Flagged: Third-party trackers or external scripts in public\/index\.html\./);
});

test('a flag is advisory by default and names the category and file', async () => {
  const diff = 'diff --git a/src/pages/dares.js b/src/pages/dares.js\n+export const dares = ["kiss", "truth"];\n';
  const { deps } = fakeDeps({ diff, files: filesOf('src/pages/dares.js'), review: { verdict: 'flag', category: 'Sexual content or nudity', file: 'src/pages/dares.js', reason: 'The dares are sexual.' } });
  const out = await run({ deps });
  assert.equal(out.row.status, 'fail');
  assert.equal(out.row.advisory, true);
  assert.match(out.row.failureReason, /^Flagged: Sexual content or nudity in src\/pages\/dares\.js\. The dares are sexual\./);
  assert.equal(classifyTests(LOADS, 1, { extraRows: [out.row] }).state, 'passing', 'advisory never closes the gate');
});

test('in blocking mode a flag fails the checks', async () => {
  const diff = 'diff --git a/game.js b/game.js\n+const gun = drawGun();\n';
  const { deps } = fakeDeps({ diff, files: filesOf('game.js'), review: { verdict: 'flag', category: 'Violence', file: 'game.js', reason: 'A gun.' } });
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

// #6037: the report's change — 17 files, no arcade view anywhere.
const REPORT_FILES = [
  'scripts/security-gate.js', '.github/workflows/release.yml',
  'src/services/release-watch.js', 'src/services/votes.js',
  'public/js/app-view.js', 'tests/release-blocked.test.js',
  'tests/release-watch.test.js', 'tests/votes.test.js',
  'tests/content-review.test.js', 'frontend/locales/en/common.json',
  'frontend/src/features/release/release-blocked.tsx',
  'src/services/github.js', 'src/services/mcp-tools.js',
  'docs/release.md', 'src/routes/sessions.js', 'src/db/migrate.js', 'README.md',
];
const REPORT_DIFF = 'diff --git a/scripts/security-gate.js b/scripts/security-gate.js\n+const gate = true;\n'
  + 'diff --git a/.github/workflows/release.yml b/.github/workflows/release.yml\n+name: release\n'
  + 'diff --git a/src/services/release-watch.js b/src/services/release-watch.js\n+watch();\n'
  + 'diff --git a/src/services/votes.js b/src/services/votes.js\n+count();\n';

test('a flag on a file outside the change is not a flag: it was not reviewed (#6037)', async () => {
  const { deps } = fakeDeps({
    files: filesOf(...REPORT_FILES), filesComplete: true, truncated: true, diff: REPORT_DIFF,
    review: {
      verdict: 'flag', category: 'Gambling', file: 'app/views/arcade/show.html.erb',
      reason: 'The diff is truncated and I cannot see the full set of changed files.',
    },
  });
  const out = await run({ deps }, { mode: 'blocking' });
  assert.equal(out.row.status, 'pass', 'a fabricated file never fails the check, even in blocking mode');
  assert.equal(out.row.advisory, true);
  assert.equal(out.row.failureReason, '');
  assert.match(out.row.summary, /not reviewed: the review named a file outside the change/);
  assert.equal(classifyTests(LOADS, 1, { extraRows: [out.row] }).state, 'passing');
});

test('a flag on a changed file whose text the reviewer was not given is not a flag (#6037)', async () => {
  const { deps } = fakeDeps({
    files: filesOf(...REPORT_FILES), filesComplete: true, truncated: true, diff: REPORT_DIFF,
    review: {
      verdict: 'flag', category: 'Gambling', file: 'frontend/locales/en/common.json',
      reason: 'It names a casino.',
    },
  });
  const out = await run({ deps });
  assert.equal(out.row.status, 'pass');
  assert.match(out.row.summary, /not reviewed: the review named a file in the part of the diff it did not read/);
  assert.equal(out.row.failureReason, '');
});

test('a truncated diff with nothing forbidden in the part read passes, and says it was partial (#6037)', async () => {
  const { deps } = fakeDeps({ files: filesOf(...REPORT_FILES), filesComplete: true, truncated: true, diff: REPORT_DIFF });
  const out = await run({ deps });
  assert.equal(out.row.status, 'pass');
  assert.equal(out.row.summary, 'Passes (Only the first part of a large diff was reviewed.)');
});

test('a truncated diff, a flag on a file in the part read: still flagged, with the partial tail', async () => {
  const { deps } = fakeDeps({
    files: filesOf(...REPORT_FILES), filesComplete: true, truncated: true, diff: REPORT_DIFF,
    review: { verdict: 'flag', category: 'Gambling', file: 'src/services/votes.js', reason: 'It bets votes.' },
  });
  const out = await run({ deps });
  assert.equal(out.row.status, 'fail');
  assert.match(out.row.failureReason, /^Flagged: Gambling in src\/services\/votes\.js\./);
  assert.match(out.row.failureReason, /first part of a large diff/);
});

test('a flag naming no file is not reviewed, and a path form is normalised (#6037)', async () => {
  const empty = await run({ deps: fakeDeps({ files: filesOf('src/app.js'), review: { verdict: 'flag', category: 'Gambling', file: '', reason: 'Slots.' } }).deps });
  assert.equal(empty.row.status, 'pass');
  assert.match(empty.row.summary, /not reviewed: the review named a file outside the change/);

  for (const file of ['b/src/app.js', './src/app.js:12']) {
    const out = await run({ deps: fakeDeps({ files: filesOf('src/app.js'), review: { verdict: 'flag', category: 'Violence', file, reason: 'A gun.' } }).deps });
    assert.equal(out.row.status, 'fail', `${file} normalises to a file in the change`);
    assert.match(out.row.failureReason, / in src\/app\.js\./);
  }

  // A rename: the previous path counts as being in the change, and as read
  // when the diff header names the file under its new path.
  const renamed = await run({
    deps: fakeDeps({
      files: [{ filename: 'src/app.js', previous: 'old/app.js' }],
      review: { verdict: 'flag', category: 'Violence', file: 'old/app.js', reason: 'A gun.' },
    }).deps,
  });
  assert.equal(renamed.row.status, 'fail');
  assert.match(renamed.row.failureReason, / in old\/app\.js\./);
});

test('the reviewer is given the full changed-file list and the unread-remainder rule (#6037)', async () => {
  const { deps, calls } = fakeDeps({
    files: filesOf(...REPORT_FILES), filesComplete: true, truncated: true, diff: REPORT_DIFF,
  });
  await run({ deps });
  assert.ok(calls.input.startsWith('CHANGED FILES (17 in total)\n'), calls.input.slice(0, 60));
  for (const path of REPORT_FILES) assert.ok(calls.input.includes(`${path}\n`), `${path} is listed`);
  assert.match(calls.system, /the part you were not given is never a reason to flag/i);
  assert.match(calls.system, /quotes the words or code you found there/i);
  assert.equal(contentReview.normaliseFile('`b/src/app.js:3:2`'), 'src/app.js');
  assert.match(contentReview.buildReviewInput({ files: ['a.js'], complete: false, diff: 'x' }), /this list may be incomplete/);
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
