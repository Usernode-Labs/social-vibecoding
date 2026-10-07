// Unit-suite check: run the proposal repo's own `npm test` as ONE synthetic
// row in the proposal checks run.
//
// Why this exists. The dapp.json checks are browser acceptance tests driven
// against the staged deployment; a repo's node unit suite was invisible to
// the merge gate. Born-failing unit tests merged freely and rotted until
// someone ran `npm test` locally — 12 accumulated failures were dug out in
// Aug 2026 (three stale card suites, a moved-file router test, and five
// failures masked as TAP "cancelled"). One aggregate check closes that hole
// without spending any of the MAX_DECLARED_TESTS ceiling.
//
// How it runs. Its own one-shot container (the worker image: node + git),
// which clones the proposal's pinned ref, `npm ci`, `npm test`, judged by
// EXIT CODE — never by parsing `# fail` counts. TAP counts cancelled tests
// separately from failed ones: a suite whose event loop dies mid-file
// reports `# fail 0` while whole files never finished (exactly the masking
// that hid five failures for weeks). The process exit code covers both.
//
// Wall-clock. captureForSession launches this BEFORE the capture container
// and awaits it after, so the two run concurrently: the unit suite adds
// ~zero latency to the checks run unless it outlasts the entire
// browser-check pass.
//
// Gating. The row participates in #1019 earned gating through
// check-history under its own checkKey: ADVISORY until this app has been
// observed passing it once, merge-BLOCKING from then on (no demotion).
// Turning the feature on fleet-wide therefore never blocks an app on a
// suite that was already broken before the feature existed.
//
// Failure phases. A clone/install failure is reported with a "suite setup
// failed" prefix but still fails the row — a PR that breaks `npm ci` (bad
// package.json, broken lockfile) must not merge just because the suite
// never got to run. Operators can re-run checks from the proposal card if
// the cause was a transient registry hiccup.

'use strict';

const docker = require('./docker');
const kubernetes = require('./kubernetes');
const github = require('./github');
const checkHistory = require('./check-history');
const appManifest = require('./app-manifest');
const log = require('./logger');
const {
  UNIT_CHECK_NAME, UNIT_CHECK_PATH, UNIT_CHECK_INDEX, FAILURE_DETAIL_MAX, isUnitSuiteRow,
  MAX_TEST_EXCERPT_CHARS, MAX_UNIT_EXCERPTS, MAX_UNIT_DETAILS_BYTES,
  MAX_EXCERPT_PRECEDING_LINES, MAX_EXCERPT_LINE_CHARS, MAX_STACK_LINES,
} = require('./unit-suite-row');
// The same scrubbing the check logs and the logger use: an excerpt is
// persisted in test_results and read back by agents, so a credential a test
// printed (a DSN with a password, a token in a URL) must not survive.
const { redactString } = require('./log-redaction');

// The worker image ships node 22 + git + a local PostgreSQL 17 and is rebuilt
// daily, so reusing it means no separate CI image to build or deploy. Repos
// that declare the direct SQL checker use that server before their tests run.
// Override for self-hosters whose worker image is named differently.
const UNIT_SUITE_IMAGE = process.env.UNIT_SUITE_IMAGE || 'usernode-worker:latest';
const UNIT_SUITE_TIMEOUT_MS = parseInt(process.env.UNIT_SUITE_TIMEOUT_MS, 10) || 600 * 1000;
// 4 → 8 CPUs, 2g → 4g. `node --test` fans out one process per file at
// (available cores − 1), and node 22 reads the container's cgroup quota
// for that, so the quota IS the concurrency: at 4 CPUs this repo's ~870
// test files run three at a time and take 140-195s in the check pod. Three
// processes kept only ~1.9 cores busy locally (86s; the rest is I/O waits
// and timers), and seven took the same suite to 48s — the speed-up is
// close to linear because the files are startup-bound, not compute-bound.
// Memory follows the process count — every test process is a whole node
// with the app's modules loaded, and an OOM-kill fails the row for a
// reason that has nothing to do with the tests. 8 is the worker
// LimitRange's per-container CPU ceiling.
const UNIT_SUITE_CPUS = process.env.UNIT_SUITE_CPUS || '8';
const UNIT_SUITE_MEMORY = process.env.UNIT_SUITE_MEMORY || '4g';
const UNIT_SUITE_MAX_BUFFER = 32 * 1024 * 1024;

// FAILURE_DETAIL_MAX (services/unit-suite-row.js) bounds the whole reason.
const MAX_TAIL_LINES = 8;
// One test's name, inside the reason. Long enough for this repo's
// sentence-length names; a pathological one cannot eat the whole budget.
const MAX_TEST_NAME = 200;
// The group for a failing test whose TAP carried no `location:` line.
const NO_FILE = '(file not reported)';

// Printed by the container script between dependency install and `npm
// test`. Output that never reached it failed in setup, not in the suite.
const SETUP_DONE_SENTINEL = '__UNIT_SUITE_SETUP_DONE__';
// Printed once the checkout is in place, before `npm ci`. Only the live
// phase reads it ("cloning" vs "installing"); the verdict never does.
const CLONED_SENTINEL = '__UNIT_SUITE_CLONED__';
// Printed as `<sentinel>=<workspace>` before anything else. node:test's
// `location:` is an absolute path inside a mktemp workspace; failureDetail
// strips this prefix so the reason names `tests/foo.test.js`, the path a fix
// turn can hand straight back to `node --test`.
const ROOT_SENTINEL = '__UNIT_SUITE_ROOT__';

function isEnabled() {
  const v = String(process.env.UNIT_SUITE_CHECK_ENABLED ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

// Does this package.json declare a test script worth running? The npm
// scaffold's placeholder (`echo "Error: no test specified" && exit 1`)
// would fail every app that never wrote tests — that is "no suite", not
// "failing suite".
function hasRunnableTestScript(rawPackageJson) {
  if (!rawPackageJson || typeof rawPackageJson !== 'string') return false;
  let parsed;
  try { parsed = JSON.parse(rawPackageJson); } catch { return false; }
  const script = parsed && parsed.scripts && parsed.scripts.test;
  if (typeof script !== 'string' || !script.trim()) return false;
  if (/no test specified/i.test(script)) return false;
  return true;
}

// A `location:` value as a repo-relative file: the `:line:col` dropped and
// the workspace prefix stripped. Absolute when the output never said where
// the workspace was — still the right file, just longer.
function relativeFile(location, root) {
  let p = String(location || '').trim()
    .replace(/^file:\/\//, '')
    .replace(/:\d+(?::\d+)?$/, '');
  if (root && p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  return p || null;
}

// TAP structure a backward walk stops at: another test line, the end of a
// YAML block, a comment or a plan — everything after it that is not indented
// is the suite's own stdout, which is what the excerpt wants to keep.
const TAP_STRUCTURE = /^\s*(?:not ok\b|ok\b|\.\.\.|#\s|1\.\.\d+)/;

// Every failing TOP-LEVEL test in TAP output, in order: `{ name, file }`.
//
// node:test prints the test's name on its `not ok` line and its file only
// in the YAML block under it (`  location: '/…/tests/foo.test.js:347:1'`).
// Nested subtests are indented and printed BEFORE their parent's line, so
// the first two-space `location:` inside the block after a column-0
// `not ok` is that test's own. A `# TODO` / `# SKIP` directive is not a
// failure — the exit code ignores it, so the reason must not send a fix
// turn to it. `file` is null when the block has no `location:` (other TAP
// producers; a runner that died mid-block).
//
// The block's own lines and the stdout just before the `not ok` ride along
// (`blockLines`, `before`) for the per-test excerpts (#3978); the grouped
// reason below reads only name and file, so its shape never moves.
function failingTestsWithExcerpts(lines) {
  const rootLine = lines.find((l) => l.startsWith(`${ROOT_SENTINEL}=`));
  const root = rootLine ? rootLine.slice(ROOT_SENTINEL.length + 1).trim().replace(/\/+$/, '') : null;
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^not ok\b\s*\d*\s*(?:-\s*)?(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (/\s#\s*(SKIP|TODO)\b/i.test(` ${m[1]}`)) continue;
    let file = null;
    const blockLines = [];
    if (i + 1 < lines.length && lines[i + 1].trim() === '---') {
      for (let j = i + 2; j < lines.length && /^\s/.test(lines[j]); j += 1) {
        if (lines[j].trim() === '...') break;
        blockLines.push(lines[j]);
        const loc = /^ {2}location:\s*['"]?(.*?)['"]?\s*$/.exec(lines[j]);
        if (loc && file === null) file = relativeFile(loc[1], root);
      }
    }
    // Up to MAX_EXCERPT_PRECEDING_LINES lines of the suite's own stdout
    // printed just before the failure, oldest first. Empty lines are
    // skipped, TAP structure and the container script's markers end the
    // walk — they are the runner's, not the test's.
    const before = [];
    for (let j = i - 1; j >= 0 && before.length < MAX_EXCERPT_PRECEDING_LINES; j -= 1) {
      const l = lines[j];
      if (!l.trim()) continue;
      if (/^__UNIT_SUITE_[A-Z_]+__(=|$)/.test(l.trim())) break;
      if (TAP_STRUCTURE.test(l)) break;
      before.unshift(l.trim());
    }
    out.push({ name: m[1].trim() || '(unnamed test)', file, blockLines, before });
  }
  return out;
}

function failingTests(lines) {
  return failingTestsWithExcerpts(lines).map(({ name, file }) => ({ name, file }));
}

function clipName(name) {
  return name.length > MAX_TEST_NAME ? `${name.slice(0, MAX_TEST_NAME - 1)}…` : name;
}

// The failing tests grouped by file, fitted into `budget` characters:
//
//   tests/a.test.js (8): <name>; <name>… | tests/b.test.js (1): <name>
//
// Every file and its count come first and are never traded for a name:
// the file list is what lets a fix turn run just those files instead of
// the whole suite. Names then fill what is left, dealt one per file per
// round, so a file with many failures cannot crowd the others out of their
// first name. `…` marks a file whose names did not all fit. Only when the
// file list ALONE overflows (dozens of files — a shared module broken) does
// it end early, and then it says how many files it left out.
function groupedFailures(failures, budget) {
  const byFile = new Map();
  for (const f of failures) {
    const key = f.file || NO_FILE;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(clipName(f.name));
  }
  const SEP = ' | '.length;
  let groups = [...byFile].map(([file, names]) => ({ head: `${file} (${names.length})`, names, shown: 0 }));

  // A group's rendered length with its first `k` names shown.
  const width = (g, k) => g.head.length + (k === 0 ? 0
    : 2 + g.names.slice(0, k).reduce((n, s) => n + s.length, 0) + 2 * (k - 1) + (k < g.names.length ? 1 : 0));
  const total = (gs, extra = 0) => gs.reduce((n, g) => n + width(g, g.shown), 0)
    + SEP * Math.max(0, gs.length - 1) + extra;

  // The note that stands in for every group from index `from` on.
  const omission = (from) => {
    const dropped = groups.slice(from);
    return dropped.length
      ? `(+${dropped.length} more files, ${dropped.reduce((n, g) => n + g.names.length, 0)} failing tests)`
      : null;
  };
  let omitted = null;
  if (total(groups) > budget) {
    let keep = 0;
    while (keep < groups.length) {
      const note = omission(keep + 1);
      if (total(groups.slice(0, keep + 1), note ? SEP + note.length : 0) > budget) break;
      keep += 1;
    }
    omitted = omission(keep);
    groups = groups.slice(0, keep);
  }

  let used = total(groups, omitted ? SEP + omitted.length : 0);
  const open = new Set(groups);
  while (open.size) {
    for (const g of [...open]) {
      if (g.shown >= g.names.length) { open.delete(g); continue; }
      const step = width(g, g.shown + 1) - width(g, g.shown);
      if (used + step > budget) { open.delete(g); continue; }
      g.shown += 1;
      used += step;
    }
  }

  const parts = groups.map((g) => (g.shown
    ? `${g.head}: ${g.names.slice(0, g.shown).join('; ')}${g.shown < g.names.length ? '…' : ''}`
    : g.head));
  if (omitted) parts.push(omitted);
  return parts;
}

// A test's YAML diagnostic block, with the stack folded to its first lines:
// `error`, `code`, `expected`/`actual` and `failureType` are the diagnosis;
// the rest of a stack is volume. Everything else in the block passes through.
function diagnosticsFromBlock(blockLines) {
  const out = [];
  for (let i = 0; i < blockLines.length; i += 1) {
    const line = blockLines[i];
    out.push(line);
    if (!/^\s*stack:\s*(\||\S|$)/.test(line)) continue;
    const keyIndent = line.length - line.trimStart().length;
    let j = i + 1;
    let kept = 0;
    for (; j < blockLines.length; j += 1) {
      const l = blockLines[j];
      if (l.length - l.trimStart().length <= keyIndent) break;
      if (kept < MAX_STACK_LINES) { out.push(l); kept += 1; }
    }
    if (j - (i + 1) > kept) out.push(`  … ${j - (i + 1) - kept} more stack lines`);
    i = j - 1;
  }
  return out;
}

const clipChars = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// One failing test's excerpt: its YAML diagnostics, then the stdout printed
// just before it. Redacted like the check logs (the same scrubbing plus
// token-like query parameters — an excerpt is persisted and read back by
// agents), clipped to MAX_TEST_EXCERPT_CHARS. Empty when the block and the
// preceding stdout are both empty: the test's name is already in the reason.
function excerptOfTest({ blockLines, before }) {
  const diagnostics = diagnosticsFromBlock(blockLines)
    .map((l) => l.replace(/\t/g, '  ').trimEnd())
    .filter((l) => l.trim());
  const stdout = before.map((l) => clipChars(l, MAX_EXCERPT_LINE_CHARS));
  if (!diagnostics.length && !stdout.length) return '';
  let text = diagnostics.join('\n');
  if (stdout.length) {
    const head = text ? `${text}\n— stdout just before the failure —\n` : '';
    text = `${head}${stdout.join('\n')}`;
  }
  return clipChars(
    redactString(text).replace(/([?&](?:token|jwt|auth|key)=)[^&\s]+/gi, '$1****'),
    MAX_TEST_EXCERPT_CHARS
  );
}

// The per-test excerpts of a failed run, capped: MAX_UNIT_EXCERPTS tests,
// each MAX_TEST_EXCERPT_CHARS, and the whole array within
// MAX_UNIT_DETAILS_BYTES (trailing tests give way first). `truncated` says
// when anything was left out, so a reader can point at the rest.
function unitFailureDetails(lines) {
  const failures = failingTestsWithExcerpts(lines);
  const details = [];
  for (const f of failures) {
    const excerpt = excerptOfTest(f);
    if (!excerpt) continue;
    details.push({ file: f.file, test: clipName(f.name), excerpt });
    if (details.length >= MAX_UNIT_EXCERPTS) break;
  }
  let truncated = details.length < failures.length;
  const bytes = () => details.reduce((n, d) => n + Buffer.byteLength(JSON.stringify(d), 'utf8'), 0);
  while (details.length && bytes() > MAX_UNIT_DETAILS_BYTES) {
    details.pop();
    truncated = true;
  }
  return { details, truncated };
}

// A TAP summary counter's last value (`# fail 18` is 18), or null when the
// output printed none.
function summaryCounter(lines, key) {
  const re = new RegExp(`^# ${key} (\\d+)\\s*$`);
  let value = null;
  for (const l of lines) {
    const m = re.exec(l);
    if (m) value = parseInt(m[1], 10);
  }
  return value;
}

// Did `npm test` report any test at all? One TAP test line, or a summary
// counter above zero, says it ran, whatever else went wrong. The setup
// sentinel alone cannot answer that: a long run's log can come back without
// its start. PR #4217's did (#4265): its summary counted 21,713 passing and
// 18 failing tests, the sentinel and every `not ok` line were gone, and the
// row read "the tests never ran".
function testsReported(lines) {
  return lines.some((l) => /^\s*(?:not )?ok \d+\b/.test(l))
    || ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']
      .some((key) => summaryCounter(lines, key) > 0);
}

// Distill a failed run's output into a bounded failureReason. When the
// output is TAP (node:test, tap): the failing tests grouped by the file each
// one is in, then the summary counters. Otherwise the last few non-empty
// lines of output (jest & friends, npm/git errors). A timeout or a setup
// failure leads, in words main-watch.js matches on. Setup failure is said
// only when no test reported (#4265): a red suite whose log lost the
// sentinel is a red suite, and a summary that counts failures the output
// does not name says so ahead of the tail.
function failureDetailFromLines(lines, { timedOut = false } = {}) {
  const parts = [];
  if (timedOut) {
    parts.push(`Suite run exceeded ${Math.round(UNIT_SUITE_TIMEOUT_MS / 1000)}s and was killed.`);
  }
  if (!lines.join('\n').includes(SETUP_DONE_SENTINEL) && !timedOut && !testsReported(lines)) {
    parts.push('Suite setup failed (clone / npm ci), so the tests never ran.');
  }
  const failures = failingTests(lines);
  if (failures.length) {
    const counters = lines.filter((l) => /^# (tests|pass|fail|cancelled) /.test(l)).map((l) => l.trim());
    const fixed = [...parts, ...counters].reduce((n, p) => n + p.length + ' | '.length, 0);
    const grouped = groupedFailures(failures, FAILURE_DETAIL_MAX - fixed);
    parts.push(...grouped, ...counters);
  } else {
    const failed = summaryCounter(lines, 'fail');
    if (failed > 0) {
      parts.push(`${failed} test${failed === 1 ? '' : 's'} failed, but the saved output does not name `
        + `${failed === 1 ? 'it' : 'them'}.`);
    }
    const tail = lines.map((l) => l.trim())
      .filter((l) => l && !/^__UNIT_SUITE_[A-Z_]+__(=|$)/.test(l))
      .slice(-MAX_TAIL_LINES);
    parts.push(...tail);
  }
  return parts.join(' | ').slice(0, FAILURE_DETAIL_MAX);
}

function failureDetail(stdout, stderr, { timedOut = false } = {}) {
  const out = `${String(stdout || '')}\n${String(stderr || '')}`;
  return failureDetailFromLines(out.split('\n'), { timedOut });
}

// One parse pass over a failed run's output yields both readers' answers:
// the grouped reason (byte-for-byte what failureDetail always returned) and
// the per-test excerpts beside it (#3978).
function failureOutcomeParts(stdout, stderr, { timedOut = false } = {}) {
  const out = `${String(stdout || '')}\n${String(stderr || '')}`;
  const lines = out.split('\n');
  return {
    reason: failureDetailFromLines(lines, { timedOut }),
    ...unitFailureDetails(lines),
  };
}

// The container script. Fetches the exact ref the rest of the checks run
// judges (branch name for native proposals, head SHA for imported /
// cli-handoff ones — see visuals.sessionGitRef). A fork-headed SHA that the
// base repo can't serve directly is reachable through GitHub's pull/N/head
// mirror, same fallback staging's clone uses.
const RUN_SCRIPT = `
set -eu
# The worker image runs as USER node — work somewhere it can write.
WS="$(mktemp -d)"
cd "$WS"
echo "${ROOT_SENTINEL}=$(pwd -P)"
git init -q .
git remote add origin "$REPO_URL"
if git fetch -q --depth 1 origin "$GIT_REF"; then
  git checkout -q --detach FETCH_HEAD
elif [ -n "\${PR_NUMBER:-}" ] && git fetch -q --depth 1 origin "pull/\${PR_NUMBER}/head"; then
  git checkout -q --detach "$GIT_REF" 2>/dev/null || git checkout -q --detach FETCH_HEAD
else
  echo "unit-suite: could not fetch $GIT_REF" >&2
  exit 90
fi
git submodule update --init --recursive --depth 1 >/dev/null 2>&1 || true
echo "${CLONED_SENTINEL}"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund --loglevel=error
else
  npm install --no-audit --no-fund --loglevel=error
fi
echo "${SETUP_DONE_SENTINEL}"
# The SQL checker needs a real catalog and permission to create its throwaway
# shadow database. Its script path is the explicit opt-in; ordinary app suites
# remain byte-for-byte unchanged.
if node -e "const p=require('./package.json');process.exit(p.scripts?.['lint:sql']?.includes('scripts/check-sql.js')?0:1)"; then
  if ! command -v pg_ctl >/dev/null 2>&1 || [ ! -d /home/node/pgdata ]; then
    echo "unit-suite: SQL validation is configured but PostgreSQL 17 is unavailable" >&2
    exit 91
  fi
  # The repository's own PostgreSQL suites run against this server too, and
  # each loads the whole schema in one transaction: about 2,830 locks on
  # 5 October 2026. The default lock table (max_locks_per_transaction 64 for
  # 100 connections: 6,400) held two such loads at once, so a third running
  # in parallel failed with "out of shared memory" (53200), and six bot
  # suites failed together on otherwise healthy changes. 1024 holds about
  # thirty-six, for some 43 MB more shared memory.
  #
  # Nothing here waits for the disk. Each of those suites ends by dropping
  # its database, DROP DATABASE forces a checkpoint, and with fsync on a
  # checkpoint returns only once everything is on disk, so the drops queued
  # behind one another: the 108 database suites took 115 s, and 36 s without
  # the wait (7 at a time, 7 October 2026). The three settings give up only
  # what survives a crash, and this server has nothing to keep: its data
  # directory is created empty with the image and discarded with the
  # container. They belong to this server alone, never to a database that
  # outlives its job.
  pg_ctl -D /home/node/pgdata -w -o "-c max_locks_per_transaction=1024 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" -l /tmp/unit-suite-postgres.log start >/dev/null
  trap 'pg_ctl -D /home/node/pgdata -m fast stop >/dev/null 2>&1 || true' EXIT
  export SQL_CHECK_CONNECTION_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
  npm run lint:sql
fi
npm test
`;

// Live progress of a run, read off the container's stdout as it streams
// (docker.runOneShot's onStdoutLine). node:test, tap and most TAP-emitting
// runners print one `ok N` / `not ok N` line per test, nested ones indented,
// and a `# tests / # pass / # fail / # skipped / # cancelled` block at the
// end; jest prints neither, and then the phase is all this can say. The
// running counts are an approximation on purpose — a parent test's own
// `not ok` repeats a child's failure, and a describe() suite gets an `ok`
// of its own — so the summary block, when it arrives, REPLACES them. None
// of it touches the verdict, which stays the exit code.
function makeUnitSuiteTracker(expected = null) {
  let phase = 'cloning';
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let summary = null;
  const total = Number.isInteger(expected) && expected > 0 ? expected : null;
  return {
    // Returns true when the line changed the state.
    feed(line) {
      const l = String(line || '');
      if (l === CLONED_SENTINEL) { phase = 'installing'; return true; }
      if (l === SETUP_DONE_SENTINEL) { phase = 'running'; return true; }
      const m = /^\s*(not ok|ok)\b(.*)$/.exec(l);
      if (m) {
        if (phase !== 'running') phase = 'running';
        if (/#\s*(SKIP|TODO)\b/i.test(m[2])) skipped += 1;
        else if (m[1] === 'ok') passed += 1;
        else failed += 1;
        return true;
      }
      const sm = /^# (tests|pass|fail|skipped|cancelled|todo) (\d+)\s*$/.exec(l);
      if (sm) {
        summary = summary || {};
        summary[sm[1]] = parseInt(sm[2], 10);
        return true;
      }
      return false;
    },
    finish(exitOk) { phase = 'done'; this.exitOk = !!exitOk; return this.snapshot(); },
    snapshot() {
      const s = summary;
      // The summary's `pass` excludes skipped/todo, and `tests` counts both
      // plus cancelled, so `ran` is `tests` once it is known.
      const p = s && Number.isInteger(s.pass) ? s.pass : passed;
      const f = s && Number.isInteger(s.fail) ? s.fail + (Number.isInteger(s.cancelled) ? s.cancelled : 0) : failed;
      const k = s && Number.isInteger(s.skipped) ? s.skipped + (Number.isInteger(s.todo) ? s.todo : 0) : skipped;
      const ran = s && Number.isInteger(s.tests) ? s.tests : p + f + k;
      return {
        phase,
        ran, passed: p, failed: f, skipped: k,
        expected: s && Number.isInteger(s.tests) ? s.tests : total,
        done: phase === 'done',
        ...(phase === 'done' ? { exitOk: !!this.exitOk } : {}),
        ...(s ? { summary: { ...s } } : {}),
        updatedAt: new Date().toISOString(),
      };
    },
  };
}

// The suite's size is not knowable before it runs (node's TAP prints no
// plan until the end), so the bar's denominator is the LAST completed run's
// `# tests` for this app, kept on the apps row. Best-effort both ways: a
// missing figure means "N tests so far" with no bar, never a wrong bar.
async function loadExpectedTests(pool, appId) {
  if (!pool || !appId) return null;
  try {
    const { rows } = await pool.query(
      'SELECT unit_suite_last_tests FROM apps WHERE id = $1', [appId]
    );
    const n = rows[0] && rows[0].unit_suite_last_tests;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (err) {
    log.warn('unit-suite', 'Expected-tests lookup failed', { appId, err: err.message });
    return null;
  }
}

async function storeExpectedTests(pool, appId, total) {
  if (!pool || !appId || !Number.isInteger(total) || total <= 0) return false;
  try {
    await pool.query('UPDATE apps SET unit_suite_last_tests = $2 WHERE id = $1', [appId, total]);
    return true;
  } catch (err) {
    log.warn('unit-suite', 'Expected-tests store failed', { appId, err: err.message });
    return false;
  }
}

// Run the proposal repo's unit suite and shape the outcome as one
// extraRows entry plus its check-history record. Returns null when there
// is nothing to run (feature off, GitHub off, no runnable test script) —
// the checks run then proceeds exactly as before this feature existed.
// `onProgress(snapshot)` is called with the tracker's snapshot each time a
// stdout line changes it, and once more with phase 'done' when the run
// ends; the caller owns any throttling. Normal failures become check rows;
// explicit cancellation propagates to the preview lifecycle owner.
async function maybeRunUnitSuite({ config, pool, appId, sessionId, repoOwner, repoName, ref, prNumber, onProgress = null, signal = null, previewRunId = null }) {
  if (!isEnabled() || !github.isEnabled() || !repoOwner || !repoName || !ref) return null;

  let rawPkg = null;
  try {
    rawPkg = await github.getFileContent(repoOwner, repoName, UNIT_CHECK_PATH, ref);
  } catch (err) {
    log.warn('unit-suite', 'package.json fetch failed — skipping unit suite', {
      sessionId, repo: `${repoOwner}/${repoName}`, ref, err: err.message,
    });
    return null;
  }
  if (!hasRunnableTestScript(rawPkg)) return null;

  const checkKey = appManifest.checkKey(UNIT_CHECK_NAME, UNIT_CHECK_PATH);
  // Ungraduated on any doubt: the safe default is advisory, so a history
  // hiccup can only under-block, never wrongly block.
  let graduated = false;
  try {
    graduated = (await checkHistory.loadGraduated(pool, appId)).has(checkKey);
  } catch (err) {
    log.warn('unit-suite', 'Graduation lookup failed — treating as advisory', {
      sessionId, appId, err: err.message,
    });
  }

  const tracker = makeUnitSuiteTracker(await loadExpectedTests(pool, appId));
  const report = (snap) => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(snap); } catch { /* an observer cannot fail the run */ }
  };
  const observe = (line) => { if (tracker.feed(line)) report(tracker.snapshot()); };

  // Final logs cover fast jobs that finish before a progress stream attaches.
  // Replay only summary counters, avoiding double-counting streamed TAP lines.
  const readSummary = (stdout) => {
    for (const line of String(stdout || '').split('\n')) {
      if (/^# (tests|pass|fail|skipped|cancelled|todo) /.test(line)) tracker.feed(line);
    }
  };
  const startedAt = Date.now();
  let passed = false;
  let reason = '';
  let unitDetails = null;
  try {
    const cloneUrl = await github.getCloneUrl(repoOwner, repoName);
    const options = {
      onStdoutLine: observe,
      signal, previewRunId,
      image: UNIT_SUITE_IMAGE,
      cmd: ['bash', '-c', RUN_SCRIPT],
      env: {
        REPO_URL: cloneUrl,
        GIT_REF: ref,
        PR_NUMBER: prNumber ? String(prNumber) : '',
        CI: 'true',
        NODE_ENV: 'test',
        npm_config_update_notifier: 'false',
      },
      memory: UNIT_SUITE_MEMORY,
      cpus: UNIT_SUITE_CPUS,
      timeoutMs: UNIT_SUITE_TIMEOUT_MS,
      maxBuffer: UNIT_SUITE_MAX_BUFFER,
    };
    const result = config?.workerRuntime === 'kubernetes'
      ? await kubernetes.runUnitSuiteJob(config, { sessionId, ...options })
      : await docker.runOneShot(`usernode-unit-suite-${sessionId}`, options);
    readSummary(result?.stdout);
    passed = true;
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    readSummary(err.stdout);
    const timedOut = err.killed === true || err.signal === 'SIGTERM' || err.signal === 'SIGKILL';
    const parts = failureOutcomeParts(err.stdout, err.stderr, { timedOut });
    reason = parts.reason;
    unitDetails = parts;
    if (!reason) reason = String(err.message || 'npm test failed').slice(0, FAILURE_DETAIL_MAX);
  }
  const finalSnap = tracker.finish(passed);
  report(finalSnap);
  const summary = finalSnap.summary || null;
  if (summary && Number.isInteger(summary.tests)) await storeExpectedTests(pool, appId, summary.tests);
  log.info('unit-suite', 'Unit suite finished', {
    sessionId, repo: `${repoOwner}/${repoName}`, ref, passed, graduated,
    durationMs: Date.now() - startedAt, tests: summary ? summary.tests : undefined,
  });

  return shapeOutcome({ passed, reason, graduated, summary, unitDetails });
}

// Did a proposal's stored checks (chat_sessions.test_results) include a
// PASSING run of this suite? The row is found by the identity shapeOutcome
// gives it, so a rename of the check cannot silently turn this false. Used
// by the main_healthy gate's level-and-green pass-through: a head whose
// own run of the same suite passed on the exact tree a merge would land
// is not what a red main could be hiding (services/main-watch.js).
function passedIn(testResults) {
  let rows = testResults;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { return false; }
  }
  if (!Array.isArray(rows)) return false;
  const row = rows.find(isUnitSuiteRow);
  return !!row && row.status === 'pass';
}

// The unit-suite check as the checks pipeline consumes it: one extraRows
// entry plus its check-history record. Shared by the live run above and the
// harvest path below so the two can never drift in shape.
function shapeOutcome({ passed, reason, graduated, summary, unitDetails = null }) {
  const checkKey = appManifest.checkKey(UNIT_CHECK_NAME, UNIT_CHECK_PATH);
  const details = unitDetails && Array.isArray(unitDetails.details) ? unitDetails.details : [];
  return {
    row: {
      index: UNIT_CHECK_INDEX,
      name: UNIT_CHECK_NAME,
      path: UNIT_CHECK_PATH,
      status: passed ? 'pass' : 'fail',
      advisory: passed ? false : !graduated,
      consoleErrors: [],
      failureReason: passed ? '' : reason,
      // The TAP summary block, when the runner printed one: the size of the
      // suite for the record. Absent for runners that print no TAP.
      ...(summary ? { summary } : {}),
      // The failing tests' own excerpts (#3978), beside the grouped reason
      // above. Only when the run failed AND something was captured: a run
      // whose TAP carried no diagnostics keeps the names-only reason.
      ...(details.length ? { failureDetails: details } : {}),
      ...(details.length && unitDetails.truncated ? { failureDetailsTruncated: true } : {}),
    },
    history: { checkKey, name: UNIT_CHECK_NAME, path: UNIT_CHECK_PATH, passed },
  };
}

// Harvest path (services/check-harvest.js): the suite's Job ran to an end
// without the process that launched it, and this shapes the same outcome
// from the Job's final output. `succeeded` is the Job's own verdict (exit
// code 0), `graduated` the flag the launching run recorded in its manifest —
// the history has not moved since. A caller that streamed the log while the
// Job was still running passes its `tracker`; the summary counters are
// re-fed regardless, which is idempotent (they replace, never add).
async function outcomeFromLog({
  pool, appId, sessionId, succeeded, stdout, stderr = '', timedOut = false,
  graduated = false, tracker = null,
}) {
  const t = tracker || makeUnitSuiteTracker(await loadExpectedTests(pool, appId));
  for (const line of String(stdout || '').split('\n')) {
    if (/^# (tests|pass|fail|skipped|cancelled|todo) /.test(line)) t.feed(line);
  }
  const passed = !!succeeded;
  let reason = '';
  let unitDetails = null;
  if (!passed) {
    const parts = failureOutcomeParts(stdout, stderr, { timedOut });
    reason = parts.reason;
    unitDetails = parts;
    if (!reason) reason = timedOut ? 'npm test timed out' : 'npm test failed';
  }
  const finalSnap = t.finish(passed);
  const summary = finalSnap.summary || null;
  if (summary && Number.isInteger(summary.tests)) await storeExpectedTests(pool, appId, summary.tests);
  log.info('unit-suite', 'Unit suite outcome read from its finished Job', {
    sessionId, appId, passed, graduated, tests: summary ? summary.tests : undefined,
  });
  return shapeOutcome({ passed, reason, graduated, summary, unitDetails });
}

module.exports = {
  maybeRunUnitSuite,
  outcomeFromLog,
  passedIn,
  makeUnitSuiteTracker,
  loadExpectedTests,
  storeExpectedTests,
  UNIT_SUITE_TIMEOUT_MS,
  UNIT_SUITE_MAX_BUFFER,
  // Exported for tests.
  hasRunnableTestScript,
  failureDetail,
  failureDetailFromLines,
  failureOutcomeParts,
  unitFailureDetails,
  excerptOfTest,
  diagnosticsFromBlock,
  isEnabled,
  UNIT_CHECK_NAME,
  UNIT_CHECK_PATH,
  UNIT_CHECK_INDEX,
  SETUP_DONE_SENTINEL,
  CLONED_SENTINEL,
  ROOT_SENTINEL,
  FAILURE_DETAIL_MAX,
};
