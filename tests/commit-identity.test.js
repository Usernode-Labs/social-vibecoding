// test:changed: always (every file under src/ and worker/, for a commit identity written there; scripts/test-changed.js)
'use strict';

// Who the commits Homeroom makes itself are by (src/services/commit-identity.js).
// GitHub suspended usernode-bot on 25 Oct 2026, and its noreply address
// attributes every commit that carries it to that account. Homeroom commits
// under one identity of its own now, from one place, and still recognises the
// old address on the commits made before.
//
// Run with: node --test tests/commit-identity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const identity = require('../src/services/commit-identity');

const root = path.join(__dirname, '..');
const OLD_EMAIL = 'usernode-bot@users.noreply.github.com';

test('Homeroom\'s identity: Homeroom <homeroom@users.noreply.onhomeroom.com>, overridable by the platform\'s environment', () => {
  assert.deepEqual(identity.homeroomAuthor({}), { name: 'Homeroom', email: 'homeroom@users.noreply.onhomeroom.com' });
  assert.deepEqual(identity.homeroomAuthor({ GIT_HOST_COMMIT_NAME: 'Homeroom Staging', GIT_HOST_COMMIT_EMAIL: 'staging@onhomeroom.test' }),
    { name: 'Homeroom Staging', email: 'staging@onhomeroom.test' });
  assert.deepEqual(identity.homeroomAuthor({ GIT_HOST_COMMIT_NAME: '', GIT_HOST_COMMIT_EMAIL: '' }), identity.homeroomAuthor({}),
    'an empty setting is no setting');
  const who = { name: 'Homeroom', email: 'homeroom@users.noreply.onhomeroom.com' };
  assert.deepEqual(identity.gitIdentityEnv(who), {
    GIT_AUTHOR_NAME: 'Homeroom', GIT_AUTHOR_EMAIL: 'homeroom@users.noreply.onhomeroom.com',
    GIT_COMMITTER_NAME: 'Homeroom', GIT_COMMITTER_EMAIL: 'homeroom@users.noreply.onhomeroom.com',
  });
  assert.deepEqual(identity.gitConfigArgs(who),
    ['-c', 'user.name=Homeroom', '-c', 'user.email=homeroom@users.noreply.onhomeroom.com']);
});

test('the git host\'s defaultAuthor is the same identity, read from the same place', () => {
  const saved = { name: process.env.GIT_HOST_COMMIT_NAME, email: process.env.GIT_HOST_COMMIT_EMAIL };
  try {
    delete process.env.GIT_HOST_COMMIT_NAME;
    delete process.env.GIT_HOST_COMMIT_EMAIL;
    const gitHost = require('../src/services/git-host');
    assert.deepEqual(gitHost.defaultAuthor(), identity.homeroomAuthor({}));
    process.env.GIT_HOST_COMMIT_EMAIL = 'override@onhomeroom.test';
    assert.equal(gitHost.defaultAuthor().email, 'override@onhomeroom.test');
    assert.deepEqual(identity.gitIdentityEnv().GIT_COMMITTER_EMAIL, 'override@onhomeroom.test');
  } finally {
    for (const [k, v] of [['GIT_HOST_COMMIT_NAME', saved.name], ['GIT_HOST_COMMIT_EMAIL', saved.email]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('a commit made with it carries it as author and committer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-commit-identity-'));
  try {
    const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { env });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    execFileSync('git', ['-C', dir, 'add', '-A'], { env });
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'one'], { env: { ...env, ...identity.gitIdentityEnv(identity.homeroomAuthor({})) } });
    execFileSync('git', ['-C', dir, ...identity.gitConfigArgs(identity.homeroomAuthor({})), 'commit', '-q', '--allow-empty', '-m', 'two'], { env });
    const log = execFileSync('git', ['-C', dir, 'log', '--format=%an|%ae|%cn|%ce'], { env, encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(log, Array(2).fill('Homeroom|homeroom@users.noreply.onhomeroom.com|Homeroom|homeroom@users.noreply.onhomeroom.com'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recognition accepts the identity, its configured address, and the one from before 26 Oct 2026', () => {
  assert.equal(identity.LEGACY_EMAIL, OLD_EMAIL);
  assert.deepEqual(identity.homeroomCommitterEmails({}).sort(), [identity.DEFAULT_EMAIL, OLD_EMAIL].sort());
  assert.deepEqual(identity.homeroomCommitterEmails({ GIT_HOST_COMMIT_EMAIL: ' Ops@Onhomeroom.test ' }).sort(),
    ['ops@onhomeroom.test', identity.DEFAULT_EMAIL, OLD_EMAIL].sort());
});

test('a worker\'s commits are Homeroom\'s: the platform sets the identity on the worker, and the image sets none', () => {
  const worker = fs.readFileSync(path.join(root, 'src/services/worker.js'), 'utf8');
  assert.match(worker, /const commitIdentity = require\('\.\/commit-identity'\);/);
  // The warm container's bootstrap environment, which every per-turn exec
  // inherits (worker/session-branch.sh and run-cc.sh commit with plain
  // `git commit`).
  assert.match(worker, /const safeEnv = \{\n(?:\s*\/\/[^\n]*\n)*\s*\.\.\.commitIdentity\.gitIdentityEnv\(\),\n\s*BRANCH: branchName,/);
  // The image and its scripts write no identity of their own: the guard
  // below covers worker/, the Dockerfile included.
});

// ── The guard ─────────────────────────────────────────────────────────

// The one place the old address may still appear, and why: recognition only.
// Commits made before 26 Oct 2026 keep it forever, and homeroom-commits.js
// still counts a move that adds one as Homeroom's. Add a file here only for
// another list that RECOGNISES the address, with the reason.
const RECOGNITION = Object.freeze({
  'src/services/commit-identity.js': 'LEGACY_EMAIL, the address homeroom-commits.js still recognises',
});

// Ways of writing a commit identity with a literal value, in JavaScript and
// in shell. A value read from somewhere (`${author.name}`, `who.email`,
// "$NAME") is not literal, and is how every caller spells it.
const LITERAL_WRITES = [
  // { GIT_AUTHOR_NAME: 'x' } and GIT_COMMITTER_EMAIL="x" / -e GIT_AUTHOR_EMAIL=x
  /\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)\s*:\s*['"`]/,
  /\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)=(?!["']?\$)["']?[^\s"'`$]/,
  // git config user.name 'x', in argv or a shell line
  /\buser\.(?:name|email)['"`]\s*,\s*['"`]/,
  /\bconfig\s+(?:--\S+\s+)*user\.(?:name|email)\s+(?!["']?\$)["']?[^\s"'`$]/,
  // -c user.email=x
  /\buser\.(?:name|email)=(?!\$)[^\s"'`$]/,
];

function walk(rel, out = []) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(child, out); } else if (entry.isFile()) out.push(child);
  }
  return out;
}

const SOURCES = ['src', 'worker'].flatMap((dir) => walk(dir))
  .map((rel) => ({ rel, buf: fs.readFileSync(path.join(root, rel)) }))
  .filter(({ buf }) => !buf.includes(0))
  .map(({ rel, buf }) => ({ rel, lines: buf.toString('utf8').split('\n') }));

test('usernode-bot\'s address is never written as a commit identity in src/ or worker/', () => {
  assert.ok(SOURCES.length > 500, `read ${SOURCES.length} files`);
  assert.ok(SOURCES.some((s) => s.rel === 'worker/worker-run.sh') && SOURCES.some((s) => s.rel === 'src/services/worker.js'));
  const found = [];
  for (const { rel, lines } of SOURCES) {
    lines.forEach((line, i) => {
      if (/usernode-bot@users\.noreply\.github\.com|\bbot@usernode\b/i.test(line)) found.push({ rel, n: i + 1, line: line.trim() });
    });
  }
  const outside = found.filter((f) => !RECOGNITION[f.rel]);
  assert.deepEqual(outside.map((f) => `${f.rel}:${f.n}: ${f.line}`), [],
    'Commit as Homeroom (src/services/commit-identity.js), never as usernode-bot');
  // Where it is allowed, it is the recognition constant and says so.
  const allowed = found.filter((f) => RECOGNITION[f.rel]);
  assert.equal(allowed.length, 1, allowed.map((f) => `${f.rel}:${f.n}`).join(', '));
  assert.equal(allowed[0].line, `const LEGACY_EMAIL = '${OLD_EMAIL}';`);
  const src = SOURCES.find((s) => s.rel === allowed[0].rel).lines;
  assert.match(src.slice(Math.max(0, allowed[0].n - 5), allowed[0].n - 1).join('\n'), /Recognition only, never written/);
});

test('no file in src/ or worker/ writes a commit identity of its own: they all use commit-identity.js', () => {
  const found = [];
  for (const { rel, lines } of SOURCES) {
    lines.forEach((line, i) => {
      if (LITERAL_WRITES.some((re) => re.test(line))) found.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], 'Use commitIdentity.homeroomAuthor(), gitIdentityEnv() or gitConfigArgs()');
  // The patterns do catch what they are for.
  for (const bad of [
    "  GIT_AUTHOR_NAME: 'usernode-bot',",
    'export GIT_COMMITTER_EMAIL=usernode-bot@users.noreply.github.com',
    "await git(['config', 'user.email', 'usernode-bot@users.noreply.github.com']);",
    'git config --global user.name "usernode-bot"',
    "'-c', 'user.name=Homeroom',",
  ]) assert.ok(LITERAL_WRITES.some((re) => re.test(bad)), bad);
  for (const ok of [
    '    GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email,',
    "'-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`,",
    "await git(['config', 'user.name', author.name]);",
    'GIT_AUTHOR_NAME="$NAME" git commit',
    '`git config user.email` is unset in a fresh worker',
  ]) assert.ok(!LITERAL_WRITES.some((re) => re.test(ok)), ok);
});
