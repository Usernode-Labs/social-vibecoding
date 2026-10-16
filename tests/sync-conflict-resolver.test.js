'use strict';

// worker/run-cc.sh MODE=sync, when the merge of main conflicts and Claude
// resolves it. Run against real git with a stand-in `claude`.
//
// Proposal 8465 (Oct 2026): a "Merge origin/main via Homeroom sync
// (Claude-resolved)" commit kept main's deletions and the branch's export of
// a function whose definition it dropped, so the module threw on load; a
// later one dropped a line from sql-dynamic-baseline.json. The runner could
// only see that no conflict markers were left. Now the resolver is told to
// keep both sides whole, load what it touched and run the suites for the
// conflicted files; it says how it resolved each file in notes the harness
// puts in the merge commit, and it can refuse instead of pushing.
//
// Run with: node --test tests/sync-conflict-resolver.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { RUNNER_TEST_ENV } = require('./lib/runner-env');

const ROOT = path.join(__dirname, '..');
const BRANCH = 'dev/sync-conflict';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The stand-in resolves lib.js, then writes the notes file the prompt names
// (or refuses, or writes nothing), as STUB_MODE says.
const STUB_CLAUDE = `#!/bin/sh
for a; do prompt="$a"; done
printf '%s' "$prompt" > "$STUB_PROMPT_LOG"
notes=$(printf '%s\\n' "$prompt" | sed -n 's/^Then write the notes file \\(.*\\): one line per conflicted file.*/\\1/p')
printf '%s' "$notes" > "$STUB_NOTES_LOG"
printf 'module.exports = { a: 1, b: 2, c: 3 };\\n' > lib.js
case "$STUB_MODE" in
  resolve) printf 'lib.js: main added c, this branch added b; kept both.\\nLoaded lib.js; its suite passed.\\n' > "$notes" ;;
  refuse) printf 'UNRESOLVED: lib.js throws on load after the merge.\\n' > "$notes" ;;
  *) ;;
esac
echo '{"type":"result","result":"ok"}'
exit 0
`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-conflict-'));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  const ws = path.join(dir, 'ws');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, seed);
  fs.writeFileSync(path.join(seed, 'lib.js'), 'module.exports = { a: 1 };\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(seed, 'checkout', '-q', '-b', BRANCH);
  fs.writeFileSync(path.join(seed, 'lib.js'), 'module.exports = { a: 1, b: 2 };\n');
  git(seed, 'commit', '-q', '-am', 'branch adds b');
  git(seed, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  git(seed, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(seed, 'lib.js'), 'module.exports = { a: 1, c: 3 };\n');
  git(seed, 'commit', '-q', '-am', 'main adds c');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(dir, 'clone', '-q', '-b', BRANCH, origin, ws);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), STUB_CLAUDE);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'sync');
  return { dir, ws, bin, prompt, start: git(ws, 'rev-parse', 'HEAD') };
}

function runSync(fx, mode) {
  const promptLog = path.join(fx.dir, 'prompt.log');
  const notesLog = path.join(fx.dir, 'notes.log');
  const ran = spawnSync('sh', [path.join(ROOT, 'worker', 'run-cc.sh')], {
    env: {
      ...GIT_ENV,
      PATH: `${fx.bin}:${process.env.PATH}`,
      HOME: fx.dir,
      ...RUNNER_TEST_ENV,
      PROMPT_FILE: fx.prompt, WORKSPACE_DIR: fx.ws, MODE: 'sync', BRANCH, SESSION_ID: '5002',
      PLATFORM_URL: 'http://127.0.0.1:1', WORKER_JWT: 'test-worker-jwt',
      TMPDIR: fx.dir,
      STUB_MODE: mode, STUB_PROMPT_LOG: promptLog, STUB_NOTES_LOG: notesLog,
    },
    encoding: 'utf8',
  });
  const out = `${ran.stdout}${ran.stderr}`;
  return {
    code: ran.status,
    out,
    result: out.split('\n').find((l) => l.startsWith('__USERNODE_RESULT__')) || '',
    prompt: fs.existsSync(promptLog) ? fs.readFileSync(promptLog, 'utf8') : '',
    notes: fs.existsSync(notesLog) ? fs.readFileSync(notesLog, 'utf8') : '',
  };
}

test('the resolver is told to keep both sides whole, prove the result loads and passes, and say how', () => {
  const fx = fixture();
  const ran = runSync(fx, 'resolve');
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.prompt, /^Conflicted files: lib\.js $/m);
  assert.match(ran.prompt, /Never keep half of a change\./);
  assert.match(ran.prompt, /an export, a call, a test or a baseline entry you keep needs the definition it names/);
  assert.match(ran.prompt, /Load every module you touched \(for JavaScript, node -e "require\('\.\/path\/to\/file'\)"/);
  assert.match(ran.prompt, /npm run test:changed -- --files <the conflicted files, comma-separated>/);
  assert.match(ran.prompt, /the repository's own agent instructions \(AGENTS\.md, CLAUDE\.md\)/);
  assert.match(ran.prompt, /make the first line of that file UNRESOLVED: followed by why/);
  // integration.classifyHeadMove: a file outside the conflicts makes the
  // resolution the author's, so the resolver stays inside them.
  assert.match(ran.prompt, /Change only the conflicted files/);
  assert.match(ran.prompt, /Delete anything your checks wrote into the working tree\./);
  assert.match(ran.prompt, /tests that cannot run here \(no dependencies installed, no database\) are not a reason to refuse/);
  assert.match(ran.prompt, /Do not run git commands\./);
  // The notes file lives outside the repository.
  assert.ok(ran.notes && !ran.notes.startsWith(fx.ws), `notes file outside the workspace: ${ran.notes}`);
  assert.equal(fs.existsSync(ran.notes), false, 'the harness removes the notes file');
});

test('a resolved merge commit lists each conflicted file and how it was resolved', () => {
  const fx = fixture();
  const ran = runSync(fx, 'resolve');
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.result, /mode=sync sync_result=resolved conflict_files=lib\.js$/);
  const message = git(fx.ws, 'log', '-1', '--format=%B');
  assert.equal(message, [
    'Merge origin/main via Homeroom sync (Claude-resolved)',
    '',
    'Conflicted files:',
    '- lib.js',
    '',
    'How they were resolved:',
    'lib.js: main added c, this branch added b; kept both.',
    'Loaded lib.js; its suite passed.',
  ].join('\n'));
  assert.equal(git(fx.ws, 'log', '-1', '--format=%P').split(' ').length, 2, 'a merge commit with both parents');
  assert.equal(fs.readFileSync(path.join(fx.ws, 'lib.js'), 'utf8'), 'module.exports = { a: 1, b: 2, c: 3 };\n');
  assert.deepEqual(git(fx.ws, 'ls-files').split('\n'), ['lib.js'], 'the notes never enter the tree');
});

test('a resolver that leaves no notes still gets the conflicted files in the commit, and says so', () => {
  const fx = fixture();
  const ran = runSync(fx, 'silent');
  assert.match(ran.result, /sync_result=resolved/);
  const message = git(fx.ws, 'log', '-1', '--format=%B');
  assert.match(message, /^Merge origin\/main via Homeroom sync \(Claude-resolved\)\n\nConflicted files:\n- lib\.js\n\nThe resolver left no notes/);
});

test('a resolver that refuses (UNRESOLVED) abandons the merge instead of pushing it', () => {
  const fx = fixture();
  const ran = runSync(fx, 'refuse');
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.out, /__USERNODE_WARN__ resolver refused: UNRESOLVED: lib\.js throws on load after the merge\./);
  assert.match(ran.result, /push_ok=0 mode=sync sync_result=conflict conflict_files=lib\.js$/);
  assert.equal(git(fx.ws, 'rev-parse', 'HEAD'), fx.start, 'the branch is where it was');
  assert.equal(git(fx.ws, 'status', '--porcelain'), '', 'no merge left in progress');
  assert.doesNotMatch(ran.out, /__USERNODE_PHASE__ sync_push/);
});
