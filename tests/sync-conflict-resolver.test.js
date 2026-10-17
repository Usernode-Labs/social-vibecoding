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
const { decodeSyncReason, decodeConflictFiles } = require('../src/services/worker');

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

function runSync(fx, mode, extraEnv = {}) {
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
      ...extraEnv,
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

// The conflicted files, as the worker reads them off the result line.
function filesOf(result) {
  const m = result.match(/ conflict_files_b64=(\S*)/);
  return m ? decodeConflictFiles(m[1]) : null;
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
  assert.match(ran.prompt, /check the result with the repository's own tools\. Bound every command you run \(for example: timeout 600 npm test\); that limit is per command, and the whole resolution, checks included, is stopped after 1800 seconds and then abandoned\./);
  assert.match(ran.prompt, /npm run test:changed -- --files <the conflicted files, comma-separated>/);
  assert.match(ran.prompt, /the repository's own agent instructions \(AGENTS\.md, CLAUDE\.md\)/);
  // Review of 8758: loading every touched module ran app startup and
  // rejected valid browser code. Only a side-effect-free library is loaded.
  assert.match(ran.prompt, /Never start the app, a server or a startup script to check a merge; test and lint commands are what to run\./);
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
  assert.match(ran.result, /mode=sync sync_result=resolved conflict_files_b64=\S+$/);
  assert.deepEqual(filesOf(ran.result), ['lib.js']);
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
  assert.match(ran.result, /push_ok=0 mode=sync sync_result=conflict conflict_files_b64=\S+ sync_reason=\S+$/);
  assert.ok(filesOf(ran.result).includes('lib.js'));
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

// ── Review round 2 of proposal 8758 (Codex) ─────────────────────────────
// Submodules, paths git quotes for display, the cap on a multibyte message,
// and the refusal reason as HTML in the transcript.

// Run one more command in the stand-in, before its STUB_MODE step.
function inject(fx, commands) {
  fs.writeFileSync(path.join(fx.bin, 'claude'),
    STUB_CLAUDE.replace('case "$STUB_MODE" in', `${commands}\ncase "$STUB_MODE" in`));
}

// fixture() with hooks to add files on the base, the branch and main.
function customFixture(hooks = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-conflict-'));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  const ws = path.join(dir, 'ws');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, seed);
  fs.writeFileSync(path.join(seed, 'lib.js'), 'module.exports = { a: 1 };\n');
  fs.writeFileSync(path.join(seed, 'other.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n');
  if (hooks.base) hooks.base(seed);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(seed, 'checkout', '-qb', BRANCH);
  fs.writeFileSync(path.join(seed, 'lib.js'), 'module.exports = { a: 1, b: 2 };\n');
  if (hooks.branch) hooks.branch(seed);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'branch');
  git(seed, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  git(seed, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(seed, 'lib.js'), 'module.exports = { a: 1, c: 3 };\n');
  fs.writeFileSync(path.join(seed, 'other.js'), 'module.exports = 2;\n');
  if (hooks.main) hooks.main(seed);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'main');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(dir, 'clone', '-q', '-b', BRANCH, origin, ws);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), STUB_CLAUDE);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const prompt = path.join(dir, 'prompt.txt');
  fs.writeFileSync(prompt, 'sync');
  return { dir, origin, seed, ws, bin, prompt, start: git(ws, 'rev-parse', 'HEAD') };
}

// An initialised submodule `sub` at `first`; with mainMoves, main moves it
// to `second` (a clean change: the branch never touches it).
function subFixture(mainMoves = false) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-sub-'));
  const src = path.join(d, 'source');
  git(d, 'init', '-q', '-b', 'main', src);
  fs.writeFileSync(path.join(src, 'v.txt'), 'first\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'first');
  const first = git(src, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(src, 'v.txt'), 'second\n');
  git(src, 'commit', '-qam', 'second');
  const second = git(src, 'rev-parse', 'HEAD');
  const fx = customFixture({
    base(seed) {
      git(seed, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'sub');
      git(path.join(seed, 'sub'), 'checkout', '-q', first);
    },
    main(seed) { if (mainMoves) git(path.join(seed, 'sub'), 'checkout', '-q', second); },
  });
  git(fx.ws, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--quiet');
  return { ...fx, first, second };
}

test('main moving a submodule cleanly is git\'s change, not the resolver\'s: the merge keeps main\'s pointer', () => {
  const fx = subFixture(true);
  assert.equal(git(path.join(fx.ws, 'sub'), 'rev-parse', 'HEAD'), fx.first);
  const ran = runSync(fx, 'resolve');
  assert.match(ran.result, /sync_result=resolved/, ran.out);
  assert.equal(git(fx.ws, 'rev-parse', 'HEAD:sub'), fx.second);
});

test('a resolver that moves a submodule checkout is refused', () => {
  const fx = subFixture();
  inject(fx, `git -C sub checkout -q ${fx.second}`);
  const ran = runSync(fx, 'resolve');
  assertAbandoned(fx, ran);
  assert.equal(reasonOf(ran.result), 'The resolution changed 1 file(s) outside the conflicts (sub), so it was not pushed.');
});

test('a submodule change hidden by diff.ignoreSubmodules never enters the merge', () => {
  // Staging everything (git add -A) would commit the moved pointer here.
  const fx = subFixture();
  git(fx.ws, 'config', 'diff.ignoreSubmodules', 'all');
  inject(fx, `git -C sub checkout -q ${fx.second}`);
  const ran = runSync(fx, 'resolve');
  assert.match(ran.result, /sync_result=resolved/, ran.out);
  assert.equal(git(fx.ws, 'rev-parse', 'HEAD:sub'), fx.first);
});

test('paths git quotes for display are staged as the files they are', () => {
  // ':(top)odd.txt' reads as pathspec magic unless staged literally.
  for (const name of ['café.txt', 'with space.txt', 'tab\there.txt', 'quote"d.txt', ':(top)odd.txt']) {
    const fx = customFixture({
      base(s) { fs.writeFileSync(path.join(s, name), 'base\n'); },
      branch(s) { fs.writeFileSync(path.join(s, name), 'branch\n'); },
      main(s) { fs.writeFileSync(path.join(s, name), 'main\n'); },
    });
    inject(fx, `printf 'merged\\n' > '${name.replace(/'/g, "'\\''")}'`);
    const ran = runSync(fx, 'resolve');
    assert.match(ran.result, /sync_result=resolved/, `${JSON.stringify(name)}: ${ran.out}`);
    assert.equal(execFileSync('git', ['--literal-pathspecs', 'show', `HEAD:${name}`], { cwd: fx.ws, encoding: 'utf8' }), 'merged\n');
    if (!/[\t"]/.test(name)) assert.match(ran.prompt, new RegExp(`^Conflicted files: .*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'), 'the prompt names the file as it is');
    if (name === 'café.txt') {
      assert.match(git(fx.ws, '-c', 'core.quotePath=false', 'log', '-1', '--format=%B'), /^- café\.txt$/m, 'the commit lists it unquoted');
    }
  }
});

test('a multibyte message is cut on a character boundary, under 8,000 bytes', () => {
  // One ASCII byte more or less moves the cut into the middle of an é in one
  // of the two runs, whichever way the header's length falls.
  for (const pad of ['', 'x']) {
    const fx = fixture();
    inject(fx, `printf '%s' '${pad}${'é'.repeat(5000)}' > "$notes"`);
    const ran = runSync(fx, 'silent');
    assert.match(ran.result, /sync_result=resolved/);
    assert.doesNotMatch(ran.out, /invalid|not UTF-8/i);
    const raw = execFileSync('git', ['cat-file', 'commit', 'HEAD'], { cwd: fx.ws });
    const body = raw.subarray(raw.indexOf(Buffer.from('\n\n')) + 2);
    assert.ok(body.length <= 8000, `message is ${body.length} bytes`);
    assert.equal(Buffer.from(body.toString('utf8'), 'utf8').equals(body), true, `valid UTF-8 (pad ${JSON.stringify(pad)})`);
    // git stores a split character's stray byte re-read as Latin-1 ("Ã"), so
    // the notes must end on a whole é, with nothing else after them.
    const notes = body.toString('utf8').trimEnd().split('\n').at(-1);
    assert.match(notes, new RegExp(`^${pad}é+$`), `the notes end on a whole character (pad ${JSON.stringify(pad)})`);
  }
});

test('a resolver that runs past its limit is stopped and the merge abandoned', () => {
  const fx = fixture();
  inject(fx, 'sleep 5');
  const ran = runSync(fx, 'resolve', { SYNC_RESOLVE_TIMEOUT: '1' });
  assertAbandoned(fx, ran);
  assert.equal(reasonOf(ran.result), 'The resolver ran past its 1 second limit.');
});

test('a resolver that commits the merge itself is refused, and the branch put back', () => {
  const fx = fixture();
  inject(fx, `printf 'module.exports = { a: 1, b: 2, c: 3 };\\n' > lib.js; git add lib.js; git -c user.name=x -c user.email=x@x commit -qm self`);
  const ran = runSync(fx, 'resolve');
  assertAbandoned(fx, ran);
  assert.equal(reasonOf(ran.result), 'The resolver ran git itself, so the merge was not pushed.');
});

// P1: a reason is data. A file name a check left behind (no resolver note
// needed) reached the transcript, which renders a status row as HTML.
test('a reason stays text from the worker\'s result line to the dev chat transcript', async () => {
  const fx = fixture();
  const payload = '<img src=x onerror=globalThis.__review8758=1>';
  inject(fx, `printf 'output' > '${payload}'`);
  const ran = runSync(fx, 'resolve');
  assertAbandoned(fx, ran);
  const workerMod = require('../src/services/worker');
  const state = {};
  workerMod.parseLine(ran.result, () => {}, state);
  assert.ok(state.syncReason.includes(payload), 'the reason names the file');

  const Module = require('node:module');
  const load = (file, source, exportsLine) => {
    const m = new Module(file);
    m.filename = file;
    m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(`${source}\n${exportsLine}`, file);
    return m.exports;
  };
  const sp = fs.readFileSync(path.join(__dirname, 'sync-progress.test.js'), 'utf8');
  const helpersAt = sp.indexOf('function makePool(');
  const helpersEnd = sp.indexOf('// ── runSyncMain coalescing');
  const activityAt = sp.indexOf('function ownerRow(');
  const activityEnd = sp.indexOf("test('activity: a clean merge");
  assert.ok(helpersAt > 0 && helpersEnd > helpersAt && activityAt > 0 && activityEnd > activityAt, 'sync-progress helpers found');
  const h = load(path.join(__dirname, 'sync-reason-render.cjs'),
    `const assert = require('node:assert/strict');\n${sp.slice(helpersAt, helpersEnd)}\n${sp.slice(activityAt, activityEnd)}`,
    'module.exports = { loadSyncMain, activityPool, ownerRow };');
  const { subject, updates, restore } = h.loadSyncMain({ execImpl: async () => ({ ...state, exitCode: 0 }) });
  const pool = h.activityPool();
  let row;
  let result;
  try {
    result = await subject.runSyncMain({}, pool, 7, { sessionRow: h.ownerRow() });
    row = pool.calls.filter((c) => /INSERT INTO chat_session_messages/.test(c.sql)).at(-1);
  } finally {
    restore();
  }
  // One plain sentence everywhere; each renderer escapes it once.
  assert.ok(result.message.includes(payload));
  assert.ok(updates.at(-1).message.includes(payload));
  assert.equal(row.params[1], result.message, 'the row stores the plain sentence');
  assert.equal(JSON.parse(row.params[2]).plainText, true, 'marked as text for the dev chat');

  const html = renderOwner(row.params[1], JSON.parse(row.params[2]));
  assert.doesNotMatch(html, /<img src=x onerror/, 'no live element');
  assert.match(html, /&lt;img src=x onerror=globalThis\.__review8758=1&gt;/, 'shown as text, escaped once');
  assert.doesNotMatch(html, /&amp;lt;img/, 'not escaped twice');
});

// ── Review round 3 of proposal 8758 (Codex) ─────────────────────────────
// File names on the result line, and one escape per renderer.

// Compile a slice of another suite's harness as a module of its own.
function compileSlice(file, source, exportsLine) {
  const Module = require('node:module');
  const m = new Module(file);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(`${source}\n${exportsLine}`, file);
  return m.exports;
}

// runSyncMain with the worker's result stubbed (tests/sync-progress.test.js).
function syncHarness(execImpl) {
  const sp = fs.readFileSync(path.join(__dirname, 'sync-progress.test.js'), 'utf8');
  const helpers = sp.slice(sp.indexOf('function makePool('), sp.indexOf('// ── runSyncMain coalescing'));
  const activity = sp.slice(sp.indexOf('function ownerRow('), sp.indexOf("test('activity: a clean merge"));
  const h = compileSlice(path.join(__dirname, 'sync-round3-harness.cjs'),
    `const assert = require('node:assert/strict');\n${helpers}\n${activity}`,
    'module.exports = { loadSyncMain, activityPool, ownerRow };');
  return { ...h, ...h.loadSyncMain({ execImpl }) };
}

async function runSyncMainWith(execImpl) {
  const h = syncHarness(execImpl);
  const pool = h.activityPool();
  try {
    const result = await h.subject.runSyncMain({}, pool, 7, { sessionRow: h.ownerRow() });
    const row = pool.calls.filter((c) => /INSERT INTO chat_session_messages/.test(c.sql)).at(-1);
    // The terminal status event as it went out live.
    const live = h.globals.filter((g) => g.event === 'status').at(-1);
    return { result, content: row.params[1], metadata: JSON.parse(row.params[2]), updates: h.updates, live };
  } finally {
    h.restore();
  }
}

function devChatHarness(name) {
  const ts = fs.readFileSync(path.join(__dirname, 'dev-chat-transcript.test.js'), 'utf8');
  return compileSlice(path.join(__dirname, name), ts.slice(0, ts.indexOf('// ── 1.')), 'module.exports = { makeDevChat };').makeDevChat;
}

// A dev chat as it was before the plainText marker: the one new piece of
// client code, DevChat._asPlainText, does nothing. (The base commit's own
// renderer is checked too, where its history is in the checkout.)
const OLD_CLIENT = { _asPlainText: (row) => row };

// A stored row as GET /api/sessions/:id sends it, read the way the dev
// chat's load path reads it (the metadata's markers lifted onto the row).
function ownerHistoryMessage(content, metadata, { old = false } = {}) {
  const wire = require('../src/services/plain-text-rows').forOwnerHistory({
    role: 'system', id: 42, content, metadata, created_at: '2026-10-17T00:00:00Z',
  });
  return old ? wire : { ...wire, plainText: metadata.plainText === true };
}

// The owner's transcript (the dev chat), through its real renderer, from the
// owner-history wire form.
function renderOwner(content, metadata, { old = false } = {}) {
  const makeDevChat = devChatHarness('sync-round3-transcript.cjs');
  return makeDevChat(old ? OLD_CLIENT : {}).render([ownerHistoryMessage(content, metadata, { old })]);
}

// The three live status handlers (two in dev-chat.js, the WebSocket one in
// app.js), run on a status event's payload as their source writes them.
const LIVE_SYSTEM_PUSH = "DevChat.messages.push({ role: 'system', content: data.text,";
function liveStatusMessages(data) {
  const lines = [];
  for (const file of ['frontend/src/features/dev-chat/dev-chat.js', 'public/js/app.js']) {
    for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
      if (line.includes(LIVE_SYSTEM_PUSH) && !line.includes('billingSwitch: true')) lines.push(line.trim());
    }
  }
  assert.equal(lines.length, 3, 'three live status handlers');
  return lines.map((line) => {
    const DevChat = { messages: [] };
    // eslint-disable-next-line no-new-func
    new Function('DevChat', 'data', line)(DevChat, data);
    return DevChat.messages;
  });
}

// The shared read-only transcript: the share sanitiser, then its renderer.
function renderShared(content, metadata) {
  const row = require('../src/services/transcript-share').sanitizeTranscriptMessage({
    role: 'system', id: 42, content, metadata, created_at: '2026-10-17T00:00:00Z',
  });
  const vm = require('node:vm');
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/session-transcript.js'), 'utf8'), sandbox);
  return sandbox.SessionTranscript.renderHtml({ session: { id: 7, username: 'fixture' }, messages: [row] });
}

test('a file named like a result field stays data: the sync stays a failure and its reason stays text', async () => {
  const name = 'z sync_result=other';
  const fx = customFixture({
    base(s) { fs.writeFileSync(path.join(s, name), 'base\n'); },
    branch(s) { fs.writeFileSync(path.join(s, name), 'branch\n'); },
    main(s) { fs.writeFileSync(path.join(s, name), 'main\n'); },
  });
  const payload = '<img src=x onerror=globalThis.__review8758=1>';
  inject(fx, `printf 'resolved\\n' > '${name}'\nprintf 'output' > '${payload}'`);
  const ran = runSync(fx, 'resolve');
  assertAbandoned(fx, ran);
  assert.doesNotMatch(ran.result, /sync_result=other/, 'no file name is written raw on the line');
  assert.deepEqual(filesOf(ran.result).sort(), ['lib.js', name].sort());
  const state = {};
  require('../src/services/worker').parseLine(ran.result, () => {}, state);
  assert.equal(state.syncResult, 'conflict');
  const out = await runSyncMainWith(async () => ({ ...state, exitCode: 0 }));
  assert.equal(out.result.ok, false, 'an abandoned merge is never ok');
  assert.equal(out.result.syncResult, 'conflict');
  const html = renderOwner(out.content, out.metadata);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x onerror=globalThis\.__review8758=1&gt;/);
});

test('the worker keeps the first of a repeated result field, and reads an unknown sync result as the failure', async () => {
  const w = require('../src/services/worker');
  const forged = {};
  w.parseLine('__USERNODE_RESULT__ cc_exit=0 ahead=0 behind=1 sha=abc push_ok=0 mode=sync sync_result=conflict conflict_files=lib.js,z sync_result=resolved push_ok=1', () => {}, forged);
  assert.equal(forged.syncResult, 'conflict', 'the raw form from older images cannot be overwritten either');
  assert.equal(forged.pushOk, false);
  const odd = {};
  w.parseLine('__USERNODE_RESULT__ cc_exit=0 ahead=0 behind=1 sha=abc push_ok=0 mode=sync sync_result=other', () => {}, odd);
  assert.equal(odd.syncResult, 'conflict');
  // Fields on later lines still replace earlier ones: the guard is per line.
  w.parseLine('__USERNODE_RESULT__ cc_exit=0 ahead=1 behind=0 sha=def push_ok=1 mode=sync sync_result=resolved', () => {}, odd);
  assert.equal(odd.syncResult, 'resolved');
  const enc = Buffer.from(['a b.js', 'sync_result=x', 'new\nline'].join('\u0000')).toString('base64url');
  assert.deepEqual(w.decodeConflictFiles(enc), ['a b.js', 'sync_result=x', 'new\nline']);
  assert.deepEqual(w.decodeConflictFiles('not base64!'), []);
  assert.equal(w.decodeConflictFiles(Buffer.from(Array.from({ length: 300 }, (_, i) => `f${i}`).join('\u0000')).toString('base64url')).length, 200);
  // sync-main itself never reports an unknown outcome as done.
  const out = await runSyncMainWith(async () => ({ syncResult: 'other', behind: 1, pushOk: false, exitCode: 0 }));
  assert.equal(out.result.ok, false);
  assert.equal(out.result.syncResult, 'conflict');
});

test('a reason is escaped exactly once in each place it is shown', async () => {
  const reason = 'Keep &lt;img&gt; literal, A&B.js, "quoted" and \'apostrophe\'.';
  const out = await runSyncMainWith(async () => ({ syncResult: 'conflict', syncReason: reason, behind: 1, pushOk: false, exitCode: 0 }));
  // Stored, sent, and answered as the plain sentence.
  assert.ok(out.result.message.includes(reason));
  assert.equal(out.content, out.result.message);
  assert.equal(out.metadata.syncMain.reason, reason);
  assert.ok(out.updates.at(-1).message.includes(reason), 'the banner gets text');
  // The owner's transcript.
  const owner = renderOwner(out.content, out.metadata);
  assert.ok(owner.includes('Keep &amp;lt;img&amp;gt; literal, A&amp;B.js, &quot;quoted&quot; and &#x27;apostrophe&#x27;.'), owner);
  // The shared read-only transcript (its sanitiser drops the metadata).
  const shared = renderShared(out.content, out.metadata);
  assert.match(shared, /A&amp;B\.js/);
  assert.doesNotMatch(shared, /A&amp;amp;B\.js/, 'not escaped twice');
  assert.doesNotMatch(shared, /<img/);
});

test('the dev chat draws a plainText row as text, and an unmarked system row as before', () => {
  const marked = renderOwner('<b>bold</b>', { plainText: true });
  assert.match(marked, /&lt;b&gt;bold&lt;\/b&gt;/);
  // A row that still carries the marker only in its metadata (any path
  // that did not lift it) is drawn as text too.
  const tf = path.join(__dirname, 'dev-chat-transcript.test.js');
  const ts = fs.readFileSync(tf, 'utf8');
  const { makeDevChat } = compileSlice(path.join(__dirname, 'sync-round3-metadata.cjs'),
    ts.slice(0, ts.indexOf('// ── 1.')), 'module.exports = { makeDevChat };');
  const viaMetadata = makeDevChat().render([{
    role: 'system', id: 43, content: '<b>bold</b>', metadata: { plainText: true }, created_at: '2026-10-17T00:00:00Z',
  }]);
  assert.match(viaMetadata, /&lt;b&gt;bold&lt;\/b&gt;/);
  const unmarked = renderOwner('<b>bold</b>', {});
  assert.match(unmarked, /<b>bold<\/b>/, 'other system rows keep their markup');
  const src = fs.readFileSync(path.join(ROOT, 'frontend/src/features/dev-chat/dev-chat.js'), 'utf8');
  assert.match(src, /if \(m\.metadata\.plainText === true\) m\.plainText = true;/, 'the load path lifts the marker');
  assert.equal((src.match(/content: data\.text, turnError: data\.turnError,[^\n]*_active: true, plainText: data\.plainText === true, plainContent: data\.plainContent \}\);/g) || []).length, 2, 'both live status paths carry it');
  assert.match(src, /rows\.push\(DevChat\._asPlainText\(DevChat\._withRunningLabel\(\{/, 'the generic row honours it');
  const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.match(app, /content: data\.text, ccOutput: data\.ccOutput,[^\n]*_active: true, plainText: data\.plainText === true, plainContent: data\.plainContent \}\);/, 'and the WebSocket path');
});

test('a file name with a newline is staged whole', () => {
  const name = 'multi\nline.txt';
  const fx = customFixture({
    base(s) { fs.writeFileSync(path.join(s, name), 'base\n'); },
    branch(s) { fs.writeFileSync(path.join(s, name), 'branch\n'); },
    main(s) { fs.writeFileSync(path.join(s, name), 'main\n'); },
  });
  inject(fx, `printf 'merged\\n' > '${name}'`);
  const ran = runSync(fx, 'resolve');
  assert.match(ran.result, /sync_result=resolved/, ran.out);
  assert.equal(execFileSync('git', ['--literal-pathspecs', 'show', `HEAD:${name}`], { cwd: fx.ws, encoding: 'utf8' }), 'merged\n');
  assert.ok(filesOf(ran.result).includes(name));
});

test('a resolver that aborts the merge or resets the branch itself is refused, and the head put back', () => {
  for (const command of ['git merge --abort', 'git reset --hard origin/main']) {
    const fx = fixture();
    inject(fx, command);
    const ran = runSync(fx, 'resolve');
    assertAbandoned(fx, ran);
    assert.equal(reasonOf(ran.result), 'The resolver ran git itself, so the merge was not pushed.', command);
  }
});

// ── Review round 4 of proposal 8758 (Codex) ─────────────────────────────
// A tab opened before this shipped keeps its HTML renderer across a deploy:
// the owner's transports carry the row escaped for it, and the sentence
// plain beside it for a current tab (services/plain-text-rows.js).

const ARTIFACT = '<img src=x onerror=globalThis.__review8758=1>';
const ARTIFACT_TEXT = '&lt;img src=x onerror=globalThis.__review8758=1&gt;';

async function refusedWithArtifact() {
  const fx = fixture();
  inject(fx, `printf 'output' > '${ARTIFACT}'`);
  const ran = runSync(fx, 'resolve');
  assertAbandoned(fx, ran);
  const state = {};
  require('../src/services/worker').parseLine(ran.result, () => {}, state);
  return runSyncMainWith(async () => ({ ...state, exitCode: 0 }));
}

test('the owner\'s history and live status carry the row escaped, with the sentence beside it; storage stays plain', async () => {
  const out = await refusedWithArtifact();
  assert.equal(out.result.ok, false);
  assert.ok(out.content.includes(ARTIFACT), 'stored plain');
  const wire = ownerHistoryMessage(out.content, out.metadata, { old: true });
  assert.ok(wire.content.includes(ARTIFACT_TEXT) && !wire.content.includes(ARTIFACT), 'history content escaped');
  assert.equal(wire.plainContent, out.content, 'history plainContent is the sentence');
  assert.ok(out.live.text.includes(ARTIFACT_TEXT) && !out.live.text.includes(ARTIFACT), 'live text escaped');
  assert.equal(out.live.plainContent, out.content, 'live plainContent is the sentence');
  assert.equal(out.live.plainText, true);
  // Rows without the marker are untouched on both transports.
  const plain = require('../src/services/plain-text-rows');
  const other = { role: 'system', content: '<b>ok</b>', metadata: {} };
  assert.equal(plain.forOwnerHistory(other), other);
  assert.deepEqual(plain.statusEvent('<b>ok</b>', { x: 1 }), { text: '<b>ok</b>', x: 1 });
  // GET /api/sessions/:id sends its messages through it.
  const routes = fs.readFileSync(path.join(ROOT, 'src/routes/sessions.js'), 'utf8');
  const mapped = routes.indexOf('const messages = storedMessages.map(plainTextRows.forOwnerHistory);');
  assert.ok(mapped > 0, 'the history route maps its rows');
  assert.ok(routes.indexOf('res.json({ session, messages, drafts });', mapped) > mapped, 'and answers with the mapped rows');
});

test('a tab from before the marker shows the refusal as text, from history and from every live handler', async () => {
  const out = await refusedWithArtifact();
  const makeOld = devChatHarness('sync-round4-old.cjs');
  const fromHistory = renderOwner(out.content, out.metadata, { old: true });
  const fromLive = liveStatusMessages(out.live).map((msgs) => makeOld(OLD_CLIENT).render(msgs));
  for (const html of [fromHistory, ...fromLive]) {
    assert.doesNotMatch(html, /<img src=x onerror/, 'no live element in an old tab');
    assert.ok(html.includes(ARTIFACT_TEXT), 'shown once as text');
    assert.doesNotMatch(html, /&amp;lt;img/, 'not escaped twice');
  }
});

test('a current tab shows it once as text, from history and from every live handler', async () => {
  const out = await refusedWithArtifact();
  const makeNew = devChatHarness('sync-round4-new.cjs');
  const fromHistory = renderOwner(out.content, out.metadata);
  const fromLive = liveStatusMessages(out.live).map((msgs) => makeNew().render(msgs));
  for (const html of [fromHistory, ...fromLive]) {
    assert.doesNotMatch(html, /<img src=x onerror/);
    assert.ok(html.includes(ARTIFACT_TEXT), 'shown once as text');
    assert.doesNotMatch(html, /&amp;lt;img/, 'the escaped transport form is not escaped again');
  }
});

test('the base commit\'s own dev chat shows the refusal as text (where its history is checked out)', async (t) => {
  const base = '74bb8c74337a07801db7078a6530b65f0a5ce92f';
  let oldSrc;
  try {
    oldSrc = execFileSync('git', ['show', `${base}:frontend/src/features/dev-chat/dev-chat.js`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    t.skip('the base commit is not in this checkout (a shallow clone); the OLD_CLIENT model above stands in');
    return;
  }
  const out = await refusedWithArtifact();
  const ts = fs.readFileSync(path.join(__dirname, 'dev-chat-transcript.test.js'), 'utf8');
  const assignment = "const DEV_CHAT_SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');";
  const prefix = ts.slice(0, ts.indexOf('// ── 1.'));
  assert.ok(prefix.includes(assignment));
  const { makeDevChat } = compileSlice(path.join(__dirname, 'sync-round4-base.cjs'),
    prefix.replace(assignment, `const DEV_CHAT_SRC = ${JSON.stringify(oldSrc)};`), 'module.exports = { makeDevChat };');
  const history = makeDevChat().render([ownerHistoryMessage(out.content, out.metadata, { old: true })]);
  const lines = [];
  for (const file of ['frontend/src/features/dev-chat/dev-chat.js', 'public/js/app.js']) {
    const src = execFileSync('git', ['show', `${base}:${file}`], { cwd: ROOT, encoding: 'utf8' });
    for (const line of src.split('\n')) if (line.includes(LIVE_SYSTEM_PUSH) && !line.includes('billingSwitch: true')) lines.push(line.trim());
  }
  assert.equal(lines.length, 3);
  const live = lines.map((line) => {
    const DevChat = { messages: [] };
    // eslint-disable-next-line no-new-func
    new Function('DevChat', 'data', line)(DevChat, out.live);
    return makeDevChat().render(DevChat.messages);
  });
  for (const html of [history, ...live]) {
    assert.doesNotMatch(html, /<img src=x onerror/);
    assert.ok(html.includes(ARTIFACT_TEXT));
    assert.doesNotMatch(html, /&amp;lt;img/);
  }
});
