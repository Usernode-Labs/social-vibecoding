// Dev-session branch names — generation and push-time validation (#1376).
//
// Production regression this pins: session branches were minted as
// `dev/${req.user.username}-${Date.now()}` with the username raw, while
// the platform-side push proxy accepted only `[A-Za-z0-9._/-]`. 194 of
// 303 production usernames are email addresses, so those sessions got a
// branch containing `@`, git accepted it locally, the agent committed —
// and every push failed `bad_branch`, the platform-side heal included.
// The user saw one fixed sentence ending "Retry your request to re-push",
// advice that could only ever fail again, while the real reason existed
// solely in a platform WARN line.
//
// Run with: node --test tests/dev-branch-names.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const branchNames = require('../src/services/branch-names');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── the module itself ───────────────────────────────────────────────────

test('devBranchName accepts an email-address username and stays pushable', () => {
  const name = branchNames.devBranchName('koenigup@gmail.com', 1787444512068);
  assert.equal(name, 'dev/koenigup@gmail.com-1787444512068');
  assert.ok(branchNames.isValidBranchName(name));
});

test('devBranchName accepts a plus-addressed username', () => {
  const name = branchNames.devBranchName('snaitmouloud+937e8d26a9ac', 1787156873908);
  assert.equal(name, 'dev/snaitmouloud+937e8d26a9ac-1787156873908');
  assert.ok(branchNames.isValidBranchName(name));
});

test('the branch shapes stranded in production now validate', () => {
  // Minted before the fix; their commits are still in warm workers, so the
  // widened charset has to accept them for the heal to recover the work.
  for (const legacy of [
    'dev/koenigup@gmail.com-1787444512068',
    'dev/snaitmouloud+937e8d26a9ac-1787156873908',
    'dev/snaitmouloud+937e8d26a9ac-1787154530989',
  ]) {
    assert.ok(branchNames.isValidBranchName(legacy), `${legacy} must be pushable`);
  }
});

test('devBranchName always emits a name isValidBranchName accepts', () => {
  const hostile = [
    '', '   ', null, undefined,
    'evan', 'plain.name', 'UPPER',
    '..', '.hidden', '-flag', 'trailing.', 'x.lock', 'a..b',
    '@', '@{now}', 'a@{0}b',
    'has space', 'wéï ünïcode', 'colon:name', 'tilde~name', 'caret^name',
    'star*name', 'question?name', 'back\\slash', 'brack[et]',
    'slash/inside', 'double//slash',
    'x'.repeat(500),
  ];
  for (const who of hostile) {
    const name = branchNames.devBranchName(who, 1787444512068);
    assert.ok(
      branchNames.isValidBranchName(name),
      `devBranchName(${JSON.stringify(who)}) produced unpushable ${JSON.stringify(name)}`
    );
    assert.ok(name.startsWith('dev/'), `${name} must stay under dev/`);
  }
});

test('sanitizeBranchSegment never returns an empty segment', () => {
  for (const empty of ['', '   ', '...', '---', '@{', null, undefined, 42]) {
    const seg = branchNames.sanitizeBranchSegment(empty);
    assert.ok(seg.length > 0, `${JSON.stringify(empty)} produced an empty segment`);
  }
  assert.equal(branchNames.sanitizeBranchSegment(''), 'user');
});

test('sanitizeBranchSegment bounds runaway usernames', () => {
  const seg = branchNames.sanitizeBranchSegment('a'.repeat(400));
  assert.ok(seg.length <= branchNames.MAX_SEGMENT_LEN);
});

test('isValidBranchName rejects git-illegal and shell-unsafe names', () => {
  const bad = [
    '', null, undefined, 42,
    'dev/a..b-1', 'dev/a@{0}-1', 'dev/.hidden-1', 'dev//x-1',
    '/dev/x', 'dev/x/', 'dev/x.', 'dev/x.lock', '@',
    '-dev/x', 'dev/has space-1', 'dev/semi;rm -rf /',
    'dev/$(whoami)', 'dev/back`tick`', "dev/quote'name",
    'dev/tilde~1', 'dev/caret^1', 'dev/colon:1', 'dev/star*1',
    `dev/${'x'.repeat(400)}`,
  ];
  for (const name of bad) {
    assert.equal(
      branchNames.isValidBranchName(name), false,
      `${JSON.stringify(name)} must be rejected`
    );
  }
});

test('the safe charset contains nothing a shell would expand', () => {
  const dangerous = [
    '`', '$', ';', '&', '|', '<', '>', '(', ')', '"', "'",
    '\n', '\t', ' ', '\\', '!', '*', '?', '[', ']', '{', '}',
    '~', '^', ':',
  ];
  for (const ch of dangerous) {
    assert.equal(
      branchNames.BRANCH_SAFE_CHARS_RE.test(`dev/x${ch}y`), false,
      `${JSON.stringify(ch)} must not be in the branch charset`
    );
  }
});

// ── the push proxy's guard ──────────────────────────────────────────────

test('execPushFromWorker refuses an invalid branch permanently, with a reason', async () => {
  const prev = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'ghp_test_token';
  try {
    const worker = require('../src/services/worker');
    await assert.rejects(
      // Reaches the branch guard before any docker/kubernetes call.
      () => worker.execPushFromWorker(1, 'dev/bad branch name'),
      (err) => {
        assert.equal(err.code, 'bad_branch');
        assert.equal(err.permanent, true);
        assert.match(err.userMessage, /never succeed/i);
        assert.match(err.userMessage, /Start a new session/i);
        return true;
      }
    );
  } finally {
    if (prev === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = prev;
  }
});

test('execPushFromWorker reports a missing bot token as permanent', async () => {
  const prev = process.env.GITHUB_BOT_TOKEN;
  delete process.env.GITHUB_BOT_TOKEN;
  try {
    const worker = require('../src/services/worker');
    await assert.rejects(
      () => worker.execPushFromWorker(1, 'dev/evan-1'),
      (err) => {
        assert.equal(err.code, 'no_token');
        assert.equal(err.permanent, true);
        assert.match(err.userMessage, /admin/i);
        return true;
      }
    );
  } finally {
    if (prev !== undefined) process.env.GITHUB_BOT_TOKEN = prev;
  }
});

// ── the user-facing description ─────────────────────────────────────────

test('describePushFailure surfaces a permanent reason and drops the retry advice', () => {
  const worker = require('../src/services/worker');
  const err = new Error('Invalid branch name: dev/koenigup@gmail.com-1');
  err.code = 'bad_branch';
  err.permanent = true;
  err.userMessage = "This session's branch name isn't a valid git branch, "
    + 'so the push can never succeed.';

  const out = worker.describePushFailure(err);
  assert.equal(out.permanent, true);
  assert.equal(out.code, 'bad_branch');
  assert.ok(out.text.includes('can never succeed'));
  assert.equal(/retry/i.test(out.text), false, 'permanent failures must not suggest retrying');
});

test('describePushFailure keeps retry advice for a transient failure, plus the reason', () => {
  const worker = require('../src/services/worker');
  const err = new Error('push proxy failed: remote end hung up unexpectedly');
  err.code = 'push_failed';

  const out = worker.describePushFailure(err);
  assert.equal(out.permanent, false);
  assert.match(out.text, /Retry your request/);
  assert.ok(out.text.includes('remote end hung up'), 'the real git error must reach chat');
});

test('describePushFailure tolerates a missing error object', () => {
  const worker = require('../src/services/worker');
  const out = worker.describePushFailure(null);
  assert.equal(out.permanent, false);
  assert.equal(out.code, 'push_failed');
  assert.ok(out.text.length > 0);
});

// ── the call sites ──────────────────────────────────────────────────────

test('no route interpolates a raw username into a branch name', () => {
  for (const rel of [
    'src/routes/sessions.js',
    'src/routes/proposal-handoff.js',
    // #1350 moved the dev-session mint out of the creation route and into
    // ensureSessionBranch, so the sanitizer has to be checked where the
    // name is actually built now.
    'src/services/session-lifecycle.js',
  ]) {
    const src = read(rel);
    assert.equal(
      /`dev\/\$\{[^}]*username[^}]*\}/.test(src), false,
      `${rel} must mint branch names through branchNames.devBranchName`
    );
  }
});

test('every dev-branch mint goes through the branch-names module', () => {
  // #1350 redistributed these. The interactive session route no longer
  // mints at all — its branch is created on the first turn — so the count
  // dropped from four to the three headless creation paths that have no
  // "first message" to defer to (auto-issue, clone, fork), plus the one in
  // session-lifecycle.js that the deferred path uses. #2779 retired the
  // fork with classic sessions, which left two.
  //
  // The assertion that matters is unchanged and is the second one: a mint
  // anywhere in these files must route through the sanitizer. The counts
  // are here so that DELETING a mint is a deliberate act rather than a way
  // to make this test pass.
  const expected = {
    'src/routes/sessions.js': 2,
    'src/services/session-lifecycle.js': 1,
  };
  for (const [rel, count] of Object.entries(expected)) {
    const src = read(rel);
    const mints = src.match(/const branchName = [^;]+;/g) || [];
    assert.equal(mints.length, count, `${rel}: expected ${count} branch mints`);
    for (const mint of mints) {
      assert.match(
        mint, /branchNames\.devBranchName(FromTitle)?\(/,
        `unrouted branch mint: ${mint}`
      );
    }
  }
});

// ── #3229: the title-aware mint ─────────────────────────────────────────

test('devBranchNameFromTitle names the branch after the title', () => {
  const name = branchNames.devBranchNameFromTitle('Fix the login redirect', 'evan', 1782044362714);
  assert.equal(name, 'dev/fix-the-login-redirect-1782044362714');
  assert.ok(branchNames.isValidBranchName(name));
});

test('devBranchNameFromTitle strips the headless-title prefix', () => {
  // Clones inherit the "#N · issue title" display shape (headlessTitle);
  // the leading number must not become a meaningless branch segment.
  const name = branchNames.devBranchNameFromTitle('#42 · Fix imports from foo.js', 'evan', 1782044362714);
  assert.equal(name, 'dev/fix-imports-from-foo.js-1782044362714');
  assert.ok(branchNames.isValidBranchName(name));
});

test('devBranchNameFromTitle falls back to the username shape for empty and unusable titles', () => {
  const ts = 1782044362714;
  for (const title of ['', '   ', null, undefined, '🎉🚀✨', '🤷‍♀️!!', '中文标题只有汉字']) {
    const name = branchNames.devBranchNameFromTitle(title, 'evan', ts);
    assert.equal(
      name, branchNames.devBranchName('evan', ts),
      `title ${JSON.stringify(title)} must fall back to the username shape`
    );
    assert.ok(branchNames.isValidBranchName(name));
  }
});

test('devBranchNameFromTitle truncates a long title to a valid ref', () => {
  const long = 'Fix the login redirect. It sends people to the dashboard instead of back to the page they came from';
  const name = branchNames.devBranchNameFromTitle(long, 'evan', 1782044362714);
  assert.ok(branchNames.isValidBranchName(name), `${name} must be pushable`);
  // The 64-char segment cut lands at a word boundary the sanitizer's
  // own edge-trim chose; it keeps the `.` from "redirect." (legal mid-
  // segment) and ends on a word, not on `-` or `.`.
  assert.match(name, /^dev\/fix-the-login-redirect\.?-it-sends-people-to-the-dashboard-instead-\d+$/);
});

test('devBranchNameFromTitle always emits a name isValidBranchName accepts', () => {
  const hostile = [
    '', '   ', null, undefined,
    'Fix the login redirect', 'UPPER CASE TITLE', 'punctuation! everywhere?',
    'emoji 🎉 only', '中文标题', 'a.'.repeat(60), '-leading-dash', 'trailing-dot.',
    'x'.repeat(500),
  ];
  for (const title of hostile) {
    const name = branchNames.devBranchNameFromTitle(title, 'koenigup@gmail.com', 1782044362714);
    assert.ok(
      branchNames.isValidBranchName(name),
      `devBranchNameFromTitle(${JSON.stringify(title)}) produced unpushable ${JSON.stringify(name)}`
    );
    assert.ok(name.startsWith('dev/'), `${name} must stay under dev/`);
  }
});

test('the mints route through devBranchNameFromTitle and the auto-issue site stays put', () => {
  // ensureSessionBranch (the deferred first-turn mint) and the clone
  // route both name the branch after the work now. The auto-issue mint
  // keeps its own meaningful name — it is not derived from a title.
  const lifecycle = read('src/services/session-lifecycle.js');
  assert.match(
    lifecycle, /branchNames\.devBranchNameFromTitle\(\s*titleSource/,
    'ensureSessionBranch must mint through devBranchNameFromTitle'
  );

  const sessions = read('src/routes/sessions.js');
  const mints = sessions.match(/const branchName = branchNames\.[^;]+;/g) || [];
  assert.equal(
    mints.filter((m) => /devBranchNameFromTitle/.test(m)).length, 1,
    'only the clone route mints title-derived names in sessions.js'
  );
  assert.equal(
    mints.filter((m) => /devBranchName\(`auto-issue-/.test(m)).length, 1,
    'the auto-issue mint keeps its meaningful devBranchName'
  );
});

test('the push proxy validates through the shared module, not a local regex', () => {
  const src = read('src/services/worker.js');
  assert.match(src, /branchNames\.isValidBranchName\(branchName\)/);
  assert.equal(
    /const BRANCH_NAME_RE\s*=/.test(src), false,
    'the local charset regex must be gone — it drifted from the generator once already'
  );
});

test('both push-failure tails describe the failure instead of a fixed sentence', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /worker\.describePushFailure\(/);
  assert.equal(
    sessions.includes("Retry your request to re-push and open the PR.'"), false,
    'sessions.js must not hardcode the retry sentence'
  );

  const server = read('server.js');
  assert.match(server, /worker\.describePushFailure\(err\)/);
  assert.equal(
    server.includes('send your request again to re-push and open the PR.'), false,
    'server.js must not hardcode the retry sentence'
  );
});

test('the internal push route returns the operator-readable detail', () => {
  const src = read('src/routes/internal.js');
  assert.match(src, /detail: err\.userMessage \|\| null/);
  assert.match(src, /permanent: err\.permanent === true/);
});
