'use strict';

// worker/run-cc.sh MODE=sync, when the merge of main conflicts and Claude
// resolves it. Run against real git with a stand-in `claude`.
//
// Proposal 8465 (Oct 2026): a "Merge origin/main via Homeroom sync
// (Claude-resolved)" commit kept main's deletions and the branch's export of
// a function whose definition it dropped, so the module threw on load; a
// later one dropped a line from sql-dynamic-baseline.json. The runner could
// only see that no conflict markers were left. Now the resolver is told to
// keep both sides whole and check the result with the repository's own
// bounded tools; it says how it resolved each file in notes the harness puts
// in the merge commit, and it can refuse instead of pushing. The harness
// stages only the conflicted files and abandons the merge when anything else
// changed (integration.classifyHeadMove would call that the author's change),
// and the reason for an abandoned merge rides on the result line.
//
// Run with: node --test tests/sync-conflict-resolver.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { RUNNER_TEST_ENV } = require('./lib/runner-env');
const { decodeSyncReason } = require('../src/services/worker');

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

// The stand-in resolves lib.js, then does what STUB_MODE says: writes the
// notes file the prompt names, refuses, leaves an artifact, edits a file git
// merged cleanly, or stages one.
const STUB_CLAUDE = `#!/bin/sh
for a; do prompt="$a"; done
printf '%s' "$prompt" > "$STUB_PROMPT_LOG"
notes=$(printf '%s\\n' "$prompt" | sed -n 's/^Then write the notes file \\(.*\\): one line per conflicted file.*/\\1/p')
printf '%s' "$notes" > "$STUB_NOTES_LOG"
printf 'module.exports = { a: 1, b: 2, c: 3 };\\n' > lib.js
ok() { printf 'lib.js: main added c, this branch added b; kept both.\\nRan its suite; it passed.\\n' > "$notes"; }
case "$STUB_MODE" in
  resolve) ok ;;
  long) head -c 9000 /dev/zero | tr -c 'x' 'n' > "$notes" ;;
  refuse) printf 'UNRESOLVED: The merge also needs a change to consumer.js, which did not conflict.\\n' > "$notes" ;;
  artifact) ok; printf 'raw output\\n' > verification-output.txt ;;
  editclean) ok; printf '// touched\\n' >> other.js ;;
  stageclean) ok; printf '// staged\\n' >> other.js; git add other.js ;;
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
  fs.writeFileSync(path.join(seed, 'other.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(seed, 'checkout', '-q', '-b', BRANCH);
  fs.writeFileSync(path.join(seed, 'lib.js'), 'module.exports = { a: 1, b: 2 };\n');
  git(seed, 'commit', '-q', '-am', 'branch adds b');
  git(seed, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  git(seed, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(seed, 'lib.js'), 'module.exports = { a: 1, c: 3 };\n');
  fs.writeFileSync(path.join(seed, 'other.js'), 'module.exports = 2;\n');
  git(seed, 'commit', '-q', '-am', 'main adds c and changes other.js');
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

function reasonOf(result) {
  const m = result.match(/ sync_reason=(\S*)/);
  return m ? decodeSyncReason(m[1]) : null;
}

test('the resolver is told to keep both sides whole, check with bounded repository tools, and say how', () => {
  const fx = fixture();
  const ran = runSync(fx, 'resolve');
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.prompt, /^Conflicted files: lib\.js $/m);
  assert.match(ran.prompt, /Never keep half of a change\./);
  assert.match(ran.prompt, /an export, a call, a test or a baseline entry you keep needs the definition it names/);
  assert.match(ran.prompt, /check the result with the repository's own tools\. Bound every command you run \(for example: timeout 600 npm test\)/);
  assert.match(ran.prompt, /npm run test:changed -- --files <the conflicted files, comma-separated>/);
  assert.match(ran.prompt, /the repository's own agent instructions \(AGENTS\.md, CLAUDE\.md\)/);
  // Review of 8758: loading every touched module ran app startup and
  // rejected valid browser code. Only a side-effect-free library is loaded.
  assert.match(ran.prompt, /Never start the app, a server or a script to check a merge\./);
  assert.match(ran.prompt, /only when it is a plain library module that does nothing when it loads: not an entry point, a server, a script, or browser code such as a \.tsx or \.jsx file/);
  assert.match(ran.prompt, /Do not change code that is valid where it runs \(browser code, for example\) because Node cannot load it\./);
  assert.doesNotMatch(ran.prompt, /Load every module you touched/);
  assert.doesNotMatch(ran.prompt, /experimental-strip-types/);
  assert.match(ran.prompt, /a check that cannot run here \(no dependencies installed, no database, a command that timed out\), are not reasons to refuse/);
  assert.match(ran.prompt, /Change only the conflicted files\./);
  assert.match(ran.prompt, /never credentials, tokens, environment values, user data or raw command output/);
  assert.match(ran.prompt, /make the first line of that file UNRESOLVED: followed by why, in one sentence the project's owner will read/);
  assert.match(ran.prompt, /Do not run git commands\./);
  // The notes file lives outside the repository and is removed.
  assert.ok(ran.notes && !ran.notes.startsWith(fx.ws), `notes file outside the workspace: ${ran.notes}`);
  assert.equal(fs.existsSync(ran.notes), false, 'the harness removes the notes file');
  assert.deepEqual(fs.readdirSync(fx.dir).filter((f) => f.startsWith('usernode-sync-')), [], 'no harness temp file is left');
});

test('a resolved merge commit lists each conflicted file and how it was resolved, and keeps git\'s clean merges', () => {
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
    'Ran its suite; it passed.',
  ].join('\n'));
  assert.equal(git(fx.ws, 'log', '-1', '--format=%P').split(' ').length, 2, 'a merge commit with both parents');
  assert.equal(git(fx.ws, 'show', 'HEAD:lib.js'), 'module.exports = { a: 1, b: 2, c: 3 };');
  assert.equal(git(fx.ws, 'show', 'HEAD:other.js'), 'module.exports = 2;', 'main\'s clean change is in the merge');
  assert.deepEqual(git(fx.ws, 'ls-files').split('\n'), ['.gitignore', 'lib.js', 'other.js'], 'the notes never enter the tree');
  assert.equal(git(fx.ws, 'status', '--porcelain'), '');
});

test('the whole merge message is capped at 8,000 bytes', () => {
  const fx = fixture();
  const ran = runSync(fx, 'long');
  assert.match(ran.result, /sync_result=resolved/);
  const raw = execFileSync('git', ['cat-file', 'commit', 'HEAD'], { cwd: fx.ws, encoding: 'utf8' });
  const body = raw.slice(raw.indexOf('\n\n') + 2);
  assert.ok(Buffer.byteLength(body) <= 8001, `message is ${Buffer.byteLength(body)} bytes`);
  assert.match(body, /^Merge origin\/main via Homeroom sync \(Claude-resolved\)\n\nConflicted files:\n- lib\.js\n\nHow they were resolved:\nn+/);
});

test('a resolver that leaves no notes still gets the conflicted files in the commit, and says so', () => {
  const fx = fixture();
  const ran = runSync(fx, 'silent');
  assert.match(ran.result, /sync_result=resolved/);
  const message = git(fx.ws, 'log', '-1', '--format=%B');
  assert.match(message, /^Merge origin\/main via Homeroom sync \(Claude-resolved\)\n\nConflicted files:\n- lib\.js\n\nThe resolver left no notes/);
});

function assertAbandoned(fx, ran) {
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.result, /push_ok=0 mode=sync sync_result=conflict conflict_files=lib\.js sync_reason=\S+$/);
  assert.equal(git(fx.ws, 'rev-parse', 'HEAD'), fx.start, 'the branch is where it was');
  assert.doesNotMatch(ran.out, /__USERNODE_PHASE__ sync_push/);
  assert.equal(fs.existsSync(path.join(fx.ws, '.git', 'MERGE_HEAD')), false, 'no merge left in progress');
}

test('a resolver that refuses (UNRESOLVED) abandons the merge, and its reason reaches the result', () => {
  const fx = fixture();
  const ran = runSync(fx, 'refuse');
  assertAbandoned(fx, ran);
  assert.match(ran.out, /__USERNODE_WARN__ resolver refused: The merge also needs a change to consumer\.js, which did not conflict\./);
  assert.equal(reasonOf(ran.result), 'The merge also needs a change to consumer.js, which did not conflict.');
  assert.equal(git(fx.ws, 'status', '--porcelain'), '');
});

test('an artifact the checks left behind is never committed: the merge is abandoned and says why', () => {
  const fx = fixture();
  const ran = runSync(fx, 'artifact');
  assertAbandoned(fx, ran);
  assert.equal(reasonOf(ran.result),
    'The resolution changed 1 file(s) outside the conflicts (verification-output.txt), so it was not pushed.');
  assert.match(ran.out, /__USERNODE_WARN__ resolver changed files outside the conflicts: verification-output\.txt/);
  assert.equal(git(fx.ws, 'ls-tree', '-r', '--name-only', 'HEAD').includes('verification-output.txt'), false);
});

test('an edit to a file git had already merged cleanly is refused, in the tree or in the index', () => {
  for (const mode of ['editclean', 'stageclean']) {
    const fx = fixture();
    const ran = runSync(fx, mode);
    assertAbandoned(fx, ran);
    assert.equal(reasonOf(ran.result),
      'The resolution changed 1 file(s) outside the conflicts (other.js), so it was not pushed.', mode);
  }
});

test('ignored files (dependencies a check installed) are not outside the boundary', () => {
  const fx = fixture();
  fs.mkdirSync(path.join(fx.ws, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(fx.ws, 'node_modules', 'x', 'index.js'), '');
  const ran = runSync(fx, 'resolve');
  assert.match(ran.result, /sync_result=resolved/);
});
