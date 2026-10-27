'use strict';

// What a native change's head move was, read from the commits it added
// (src/services/homeroom-commits.js, src/services/repo-mirror.js
// commitsBetween). Run four (13 Oct 2026): a fix round of the bot's was said
// as a push "on GitHub" and marked the change's description stale. The
// reconciler's side is pinned in tests/native-reviewed-sha.test.js; this is
// the rule and the git read under it, against a real repository.
//
// Run with: node --test tests/homeroom-commits.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const commits = require('../src/services/homeroom-commits');
const mirror = require('../src/services/repo-mirror');

const identity = require('../src/services/commit-identity');

const BOT = identity.DEFAULT_EMAIL;
// Recognition only: what Homeroom's commits carried before 26 Oct 2026.
const OLD_BOT = identity.LEGACY_EMAIL;
const c = (subject, committer = BOT) => ({ committer, subject });

test('Homeroom made a move when it committed every commit; a fix round when each is a fix round\'s', () => {
  const { classify, FIX_COMMIT_MESSAGES: m } = commits;
  assert.deepEqual(classify([c(m.checks(12))]), { madeByHomeroom: true, fixOnly: true });
  assert.deepEqual(classify([c(m.broken(12)), c(m.shots(12)), c(m.review(2))]), { madeByHomeroom: true, fixOnly: true });
  assert.deepEqual(classify([c('Changes via Homeroom')]), { madeByHomeroom: true, fixOnly: false }, 'a coding turn of anybody\'s');
  assert.deepEqual(classify([c('Add the poll page', 'cli@usernodelabs.org')]), { madeByHomeroom: true, fixOnly: false }, 'an upload from someone\'s own agent');
  assert.deepEqual(classify([c(m.checks(12)), c('Homeroom bot: follow-up on #12')]), { madeByHomeroom: true, fixOnly: false });
  assert.deepEqual(classify([c(m.checks(12)), c('Tweak', 'ada@example.com')]), { madeByHomeroom: false, fixOnly: false });
  assert.deepEqual(classify([c(m.checks(12), 'noreply@github.com')]), { madeByHomeroom: false, fixOnly: false }, 'the words alone are not enough');
  assert.deepEqual(classify([c(`${m.checks(12)} and more`)]), { madeByHomeroom: true, fixOnly: false });
  for (const none of [null, undefined, []]) assert.deepEqual(classify(none), { madeByHomeroom: false, fixOnly: false });
  assert.deepEqual(classify([c(m.checks(12), ' HOMEROOM@users.noreply.onhomeroom.com ')]), { madeByHomeroom: true, fixOnly: true });
});

test('a commit Homeroom made before 26 Oct 2026, under usernode-bot\'s address, is still Homeroom\'s', () => {
  const { classify, FIX_COMMIT_MESSAGES: m } = commits;
  assert.equal(OLD_BOT, 'usernode-bot@users.noreply.github.com');
  assert.deepEqual(classify([c(m.checks(12), OLD_BOT)]), { madeByHomeroom: true, fixOnly: true });
  assert.deepEqual(classify([c(m.checks(12), ' USERNODE-BOT@users.noreply.github.com ')]), { madeByHomeroom: true, fixOnly: true });
  assert.deepEqual(classify([c(m.checks(12), OLD_BOT), c('Changes via Homeroom')]), { madeByHomeroom: true, fixOnly: false },
    'one move may carry commits from before and after');
  assert.ok(commits.HOMEROOM_COMMITTERS.includes(BOT) && commits.HOMEROOM_COMMITTERS.includes(OLD_BOT));
});

test('a commit under a configured identity (GIT_HOST_COMMIT_EMAIL) is Homeroom\'s, and the defaults still are', () => {
  const env = { GIT_HOST_COMMIT_EMAIL: 'Commits@Homeroom.example' };
  assert.equal(commits.isHomeroomCommitter('commits@homeroom.example', env), true);
  assert.equal(commits.isHomeroomCommitter(BOT, env), true);
  assert.equal(commits.isHomeroomCommitter(OLD_BOT, env), true);
  assert.equal(commits.isHomeroomCommitter('commits@homeroom.example', {}), false, 'only while it is configured');
  for (const nobody of ['', null, undefined, 'ada@example.com', 'noreply@github.com']) {
    assert.equal(commits.isHomeroomCommitter(nobody, env), false, String(nobody));
  }
});

test('the bot\'s fix rounds commit with these messages', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.match(read('src/services/homeroom-bot.js'),
    /commitMsg: FIX_COMMIT_MESSAGES\[failing\.length \? 'checks' : broken\.length \? 'broken' : 'shots'\]\(issueNumber\),/);
  assert.match(read('src/services/homeroom-bot-live.js'), /commitMsg: FIX_COMMIT_MESSAGES\.review\(round\),/);
  for (const message of Object.values(commits.FIX_COMMIT_MESSAGES).map((f) => f(7))) {
    assert.match(message, commits.FIX_SUBJECT, message);
  }
});

function git(dir, args, env = {}) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

test('the commits a move added: its own line, merges and main left out, newest first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-commits-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git(dir, ['config', 'user.email', 'ada@example.com']);
    git(dir, ['config', 'user.name', 'Ada']);
    const commit = (file, message, env) => {
      fs.writeFileSync(path.join(dir, file), `${message}\n`);
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', message], env);
      return git(dir, ['rev-parse', 'HEAD']);
    };
    commit('a.txt', 'base');
    git(dir, ['checkout', '-qb', 'feature']);
    const old = commit('b.txt', 'the change');
    git(dir, ['checkout', '-q', 'main']);
    commit('c.txt', 'main moves');
    git(dir, ['checkout', '-q', 'feature']);
    git(dir, ['merge', '-q', '--no-edit', 'main'], { GIT_COMMITTER_EMAIL: BOT });
    const head = commit('b.txt', 'Homeroom bot: fix the failing checks on #3', { GIT_COMMITTER_EMAIL: BOT });
    const got = await mirror.commitsBetween(dir, old, head);
    assert.deepEqual(got, [{ committer: BOT, subject: 'Homeroom bot: fix the failing checks on #3' }],
      'the merge of main and main\'s own commit are not the move\'s');
    assert.deepEqual(commits.classify(got), { madeByHomeroom: true, fixOnly: true });
    assert.deepEqual(await mirror.commitsBetween(dir, head, head), []);
    // More than it reads: no answer, rather than an answer about some.
    assert.equal(await mirror.commitsBetween(dir, old, head, { limit: 0 }), null);
    assert.equal(await mirror.commitsBetween(dir, 'f'.repeat(40), head), null, 'a commit the mirror does not have');
    await assert.rejects(mirror.commitsBetween(dir, 'main', head), /Not a usable commit/, 'a ref name is never passed to git');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
