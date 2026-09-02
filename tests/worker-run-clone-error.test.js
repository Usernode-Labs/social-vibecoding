// worker-run.sh is the first of the three layers that used to discard git's
// stderr, and the only one written in shell.
//
// Every failure site here looked like `git clone … 2>&1 || die "clone
// failed"`: the output was merged into stdout, the redirect sent it nowhere,
// and the message was a constant. Whatever git actually said — a DNS
// failure, a rate limit, a repo that had been renamed — arrived at the user
// as the same eleven characters.
//
// These tests run the script's own helper prelude under /bin/sh against a
// genuinely failing git command, so they assert the real behaviour rather
// than the shape of the source. They never execute the body of the script:
// it `cd`s into /home/node/workspace and runs git against whatever is there,
// which in a test process is this repository.
//
// Run with: node --test tests/worker-run-clone-error.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = fs.readFileSync('worker/worker-run.sh', 'utf8');

// Everything above the first required-env guard: `set -u`, `die`, `clip`.
const PRELUDE = SCRIPT.slice(0, SCRIPT.indexOf(': "${CLONE_URL'));

// Run a snippet with the script's own helpers in scope.
function runWithPrelude(snippet) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-worker-run-'));
  const file = path.join(dir, 'harness.sh');
  fs.writeFileSync(file, `${PRELUDE}\n${snippet}\n`);
  try {
    return execFileSync('/bin/sh', [file], {
      encoding: 'utf8', cwd: dir, timeout: 30000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' },
    });
  } catch (err) {
    // `die` exits 1 — the interesting case, so return its stdout.
    if (err.stdout != null) return err.stdout;
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the prelude the harness runs is really the script\'s own', () => {
  assert.match(PRELUDE, /^#!\/bin\/sh/);
  assert.match(PRELUDE, /^die\(\) \{$/m);
  assert.match(PRELUDE, /^clip\(\) \{$/m);
  // Only the helpers, none of the body that would run git against the
  // process's own checkout.
  assert.doesNotMatch(PRELUDE, /^\s*git (clone|checkout|fetch|submodule)/m,
    'no bootstrap body leaked into the harness');
  assert.doesNotMatch(PRELUDE, /^cd \//m);
});

test('a failing clone reports what git said, under the stable marker prefix', () => {
  // A URL nothing can resolve. Offline-safe: this fails at DNS, so it needs
  // no network and cannot reach GitHub even if one is present.
  const out = runWithPrelude(`
    CLONE_URL="https://usernode-invalid.invalid/owner/repo.git"
    mkdir target && cd target || exit 9
    if ! CLONE_OUT="$(git clone --recurse-submodules --shallow-submodules "$CLONE_URL" . 2>&1)"; then
      die "clone failed: $(clip "$CLONE_OUT")"
    fi
    echo "UNEXPECTED SUCCESS"
  `);

  assert.match(out, /^__USERNODE_ERROR__ clone failed: /,
    'the marker prefix stays stable and machine-matchable');
  // The whole point: git's own diagnosis rides after the colon. Which
  // sentence git chooses varies by version, so match the host it failed on
  // rather than the wording around it.
  assert.match(out, /usernode-invalid\.invalid/,
    `git's stderr should be in the marker, got: ${out}`);
  assert.ok(!/UNEXPECTED SUCCESS/.test(out));
  assert.equal(out.trim().split('\n').length, 1,
    'still exactly one line — the host parses these markers line by line');
});

test('clip folds multi-line output onto one line, newest last, bounded', () => {
  const out = runWithPrelude(`
    MANY="$(i=1; while [ $i -le 30 ]; do echo "line$i"; done_unused=; i=$((i+1)); done)"
    clip "$MANY"
  `).trim();

  assert.ok(!out.includes('\n'), 'one line');
  assert.ok(out.startsWith('line21'), `keeps the LAST 10 lines, got: ${out}`);
  assert.ok(out.endsWith('line30'), 'in order, newest last');
  assert.ok(!out.includes('line20'), 'drops everything older');
  assert.equal(out.split(' | ').length, 10);
});

test('clip drops the carriage returns and blank lines git writes progress with', () => {
  const out = runWithPrelude(`clip "$(printf 'Cloning into %s...\\r\\n\\nfatal: nope\\n')"`).trim();
  assert.equal(out, 'Cloning into ... | fatal: nope');
  assert.ok(!out.includes('\r'));
});

test('clip caps the detail so one marker line cannot flood the log tail', () => {
  const out = runWithPrelude(`clip "$(head -c 4000 /dev/zero | tr '\\0' 'x')"`).trim();
  assert.equal(out.length, 1000);
});

// ── The source-level rule: no die site may throw its output away ─────────

test('every bootstrap failure site captures its command output', () => {
  // Guards against a future edit reintroducing `git … 2>&1 || die "fixed
  // string"`, which is precisely the shape this change removed.
  const failureSites = SCRIPT.match(/^\s*(die|echo "__USERNODE_WARN__) .*$/gm) || [];
  const bootstrapSites = failureSites.filter((l) =>
    /(clone|checkout|fetch|submodule) failed/.test(l));
  assert.ok(bootstrapSites.length >= 4, `expected the git failure sites, got ${bootstrapSites.length}`);
  for (const site of bootstrapSites) {
    assert.match(site, /\$\(clip "\$[A-Z_]+"\)/,
      `git failure site throws its output away: ${site.trim()}`);
  }
});

test('the fetch and submodule failures stay warnings, not deaths', () => {
  // Neither is fatal to a bootstrap — a stale fetch or a missing submodule
  // still leaves a usable checkout, and killing the container over one would
  // turn a degraded turn into no turn at all.
  assert.match(SCRIPT, /__USERNODE_WARN__ fetch failed: /);
  assert.match(SCRIPT, /__USERNODE_WARN__ submodule update failed: /);
  assert.doesNotMatch(SCRIPT, /die "fetch failed/);
  assert.doesNotMatch(SCRIPT, /die "submodule/);
});
