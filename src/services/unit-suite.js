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
// Failure phases. A suite that never reached `npm test` has no verdict to
// give: its Job or input Secret could not be created (the worker
// namespace's quota on 7 Oct 2026, a refusal from the API, an API that
// could not be reached), or its pod stopped while cloning or installing
// (proposal 7022: "BackoffLimitExceeded" with no test output). That row is
// marked `couldNotRun` and names the cause in plain words (notRunOutcome
// below), never records a failure in check history, and, when the suite is
// merge-blocking, makes the run an 'error' (visuals.classifyTests): the
// merge stays blocked and the error lane runs the checks again with
// backoff. A PR that breaks `npm ci` itself (a version nothing satisfies,
// a lockfile out of sync, an install script that fails) is still its own
// failure: npm's error code says so (INSTALL_FAILURES), and the row is a
// failing one, worded the same way and recorded in history. A suite that
// ran and failed tests keeps its 'failing' verdict, exactly as before.

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

// ── A suite split across Jobs ──
//
// On the platform's own app the unit suite is the longest part of a checks
// run: about 190s for ~23,000 tests on 8 CPUs, 131s of it `npm test` itself,
// and since the browser checks were split across pods (services/visuals.js
// CAPTURE_SHARDS) every run ends when it does. So on Kubernetes a repo that
// declares a `test:shard` script (its own test command, taking
// TEST_SHARD=k/n) is run as UNIT_SUITE_SHARDS Jobs at once, each with the
// same setup and 1/n of the files. Their outputs are joined into one, read
// exactly as one Job's would be (joinUnitShardOutputs), so the row, its
// reason, main-watch and the harvest see one suite. UNIT_SUITE_SHARDS=1
// runs one Job, as before; a repo without `test:shard` always does.
//
// Each shard asks the scheduler for UNIT_SUITE_SHARD_CPU_REQUEST (it may
// burst to UNIT_SUITE_CPUS): three shards ask for 4.5 CPUs where one Job
// asked for 4, so the checks queue's four runs still fit the worker
// namespace's 48-CPU quota beside their browser-check shards.
function unitSuiteShardCount(raw = process.env.UNIT_SUITE_SHARDS) {
  if (raw == null || String(raw).trim() === '') return 3;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 8) : 3;
}
const UNIT_SUITE_SHARD_CPU_REQUEST = process.env.UNIT_SUITE_SHARD_CPU_REQUEST || '1500m';
// A shard's memory limit. A whole-suite pod peaked at 1.1-1.9 GiB on 10 Oct
// 2026 (Postgres and seven test processes), and a shard runs the same seven
// at once. Three shards at 3g beside three 6g browser shards keep the queue's
// four runs and main-watch inside the worker namespace's 128Gi of limits,
// where 4g each would not.
const UNIT_SUITE_SHARD_MEMORY = process.env.UNIT_SUITE_SHARD_MEMORY || '3g';

// Does this package.json declare the command a shard runs?
function hasShardScript(rawPkg) {
  try {
    const script = JSON.parse(String(rawPkg || '{}'))?.scripts?.['test:shard'];
    return typeof script === 'string' && script.trim().length > 0;
  } catch {
    return false;
  }
}

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
// Printed as `<sentinel>=<count>` after a red `npm test`, followed by every
// failing top-level test's `not ok` line and its YAML block again, read back
// from a copy of the run's own output. A long run's log can come back
// without its start: on 9 October 2026 a red main counted its failures and
// named none, because every `not ok` line had scrolled out of the log the
// cluster kept. The recap puts them where the log always ends. `count` is
// how many failing tests the run printed in all, so a reader knows whether
// the names it holds are all of them (failuresNamedInFull).
const RECAP_SENTINEL = '__UNIT_SUITE_RECAP__';
// The recap's bounds: this many failing tests, each with this many lines of
// its block. node:test prints `location:` third, so a clipped block still
// says which file the test is in.
const RECAP_MAX_TESTS = 50;
const RECAP_MAX_BLOCK_LINES = 60;

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
//
// The recap (RECAP_SENTINEL) repeats failures the output may already hold.
// A test it names that was seen before it is the same failure and is not
// counted twice; one it alone names is a failure whose line the log lost,
// and it carries no stdout of its own (the recap prints none).
function failingTestsWithExcerpts(lines) {
  const rootLine = lines.find((l) => l.startsWith(`${ROOT_SENTINEL}=`));
  const root = rootLine ? rootLine.slice(ROOT_SENTINEL.length + 1).trim().replace(/\/+$/, '') : null;
  const recapAt = recapIndex(lines);
  const seen = new Map();
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^not ok\b\s*\d*\s*(?:-\s*)?(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (/\s#\s*(SKIP|TODO)\b/i.test(` ${m[1]}`)) continue;
    const inRecap = recapAt !== -1 && i > recapAt;
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
    for (let j = i - 1; !inRecap && j >= 0 && before.length < MAX_EXCERPT_PRECEDING_LINES; j -= 1) {
      const l = lines[j];
      if (!l.trim()) continue;
      if (/^__UNIT_SUITE_[A-Z_]+__(=|$)/.test(l.trim())) break;
      if (TAP_STRUCTURE.test(l)) break;
      before.unshift(l.trim());
    }
    const name = m[1].trim() || '(unnamed test)';
    const key = `${file || ''}\u0000${name}`;
    if (inRecap && seen.get(key) > 0) {
      seen.set(key, seen.get(key) - 1);
      continue;
    }
    if (!inRecap) seen.set(key, (seen.get(key) || 0) + 1);
    out.push({ name, file, blockLines, before });
  }
  return out;
}

// The line the recap opens with, or -1 when the output has none (a green
// run, or an older script).
function recapIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith(`${RECAP_SENTINEL}=`)) return i;
  }
  return -1;
}

// How many failing tests the run printed, by the recap's count; null when
// the output carries no recap.
function recapCount(lines) {
  const at = recapIndex(lines);
  if (at === -1) return null;
  const n = parseInt(lines[at].slice(RECAP_SENTINEL.length + 1), 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// Do the names parsed from this output cover EVERY failing test? main-watch
// lets a red pass without pausing merges only when each failing test is a
// known flake, and a list missing one could be missing the real failure.
// Yes when the recap counted no more failures than it could print and all
// of them were read; without a recap (an older script), only when the log
// kept both its start (the workspace line) and its end (the summary).
function failuresNamedInFull(lines, failures) {
  const count = recapCount(lines);
  if (count !== null) return count > 0 && count <= RECAP_MAX_TESTS && failures.length >= count;
  return failures.length > 0
    && lines.some((l) => l.startsWith(`${ROOT_SENTINEL}=`))
    && summaryCounter(lines, 'fail') !== null;
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
// does not name says so ahead of the tail. A run notRunOutcome (below)
// places as never having reached `npm test` takes its reason from there
// instead; what is left here is output it could not place.
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
    const headline = buildErrorLine(lines);
    if (headline && !tail.some((l) => l.includes(headline))) parts.push(headline);
    parts.push(...tail);
  }
  return parts.join(' | ').slice(0, FAILURE_DETAIL_MAX);
}

// The line that says what broke, when no test did. On 8 October 2026 two
// proposals that each added the same icon export merged one after the
// other, and the next `npm test` stopped in its pretest build at
// `icons.tsx:…: ERROR: Multiple exports with the same name …`. The reason
// kept only the last lines of output, a stack and npm's own complaint, so
// the board named no culprit and an admin resumed merges into a main that
// could not build. The first line of the most telling kind leads instead:
// a bundler's ERROR, then a TypeScript error, then a thrown Error. npm's
// lines and stack frames are never it.
const BUILD_ERROR_PATTERNS = [
  /\[ERROR\]\s+\S|(?:^|:\s*)ERROR:\s+\S/,
  /\berror TS\d+:/,
  /^(?:[A-Z][A-Za-z]*)?Error(?:\s*\[[A-Z0-9_]+\])?:\s+\S/,
];
const BUILD_ERROR_LINE_MAX = 300;
function buildErrorLine(lines) {
  const candidates = lines.map((l) => l.trim()).filter((l) => l
    && !/^__UNIT_SUITE_[A-Z_]+__(=|$)/.test(l)
    && !/^npm (?:ERR!|error|warn)\b/i.test(l)
    && !/^at\s/.test(l));
  for (const re of BUILD_ERROR_PATTERNS) {
    const hit = candidates.find((l) => re.test(l));
    if (hit) return plainText(hit, BUILD_ERROR_LINE_MAX) || null;
  }
  return null;
}

function failureDetail(stdout, stderr, { timedOut = false } = {}) {
  const out = `${String(stdout || '')}\n${String(stderr || '')}`;
  return failureDetailFromLines(out.split('\n'), { timedOut });
}

// One parse pass over a failed run's output yields both readers' answers:
// the grouped reason (byte-for-byte what failureDetail always returned) and
// the per-test excerpts beside it (#3978).
//
// `named` is the failing tests themselves, for main-watch: up to
// MAX_NAMED_FAILURES `{ file, test }` and whether they are all of them.
const MAX_NAMED_FAILURES = 50;
function failureOutcomeParts(stdout, stderr, { timedOut = false } = {}) {
  const out = `${String(stdout || '')}\n${String(stderr || '')}`;
  const lines = out.split('\n');
  const failures = failingTests(lines);
  return {
    reason: failureDetailFromLines(lines, { timedOut }),
    ...unitFailureDetails(lines),
    named: {
      tests: failures.slice(0, MAX_NAMED_FAILURES).map((f) => ({ file: f.file, test: clipName(f.name) })),
      complete: !timedOut && failures.length <= MAX_NAMED_FAILURES && failuresNamedInFull(lines, failures),
    },
  };
}

// ── A suite that never ran ─────────────────────────────────────────────
//
// On 7 Oct 2026 the worker namespace hit its quota, and the unit suite's
// Secret or Job create was refused ("exceeded quota: … requested:
// secrets=1", "count/jobs.batch=1"). The refusal carried no output, so the
// row read "Suite setup failed (clone / npm ci), so the tests never ran.",
// the quota message was lost, and a merge-blocking suite made the run
// 'failing': the proposal's fault, never retried, written to its check
// history. Proposal 7022 reached the same row from a pod that ended with
// "BackoffLimitExceeded: Error" and no output at all.
//
// The line between "never ran" and "ran and failed" is drawn on evidence,
// and only one way: anything that says `npm test` started keeps the
// verdict the exit code gave. That is the setup sentinel, one TAP test
// line or a summary counter above zero in the output (#4265), or the same
// seen on the live stream while the run went (`reachedTests`). What counts
// as never ran:
//
//   * the runner never got the suite going: a Job or Secret create the API
//     refused or never answered (kubernetes.runCheckJob marks those
//     `checkJobNotCreated`), any other API failure before the Job ended, or
//     a Docker container whose script never printed its first line;
//   * the pod started and stopped in setup: the output opens with the
//     script's workspace line and never reaches the setup sentinel. The
//     clone, running out of time or memory, and an install npm says the
//     network, registry or disk failed are the platform's; an install
//     that failed on the proposal's own package files is the proposal's
//     (INSTALL_FAILURES below), a failing row worded the same way;
//   * the Job ended and its log held nothing at all.
//
// Output this cannot place, such as a log that lost its start and holds no
// test line, keeps the failing verdict it had before.

const NOT_RUN_LEAD = Object.freeze({
  start: 'The unit suite could not start',
  run: 'The unit suite could not run',
  setup: 'The unit suite stopped before any test ran',
});
// The card caps check_error_detail at 280 characters, and so does this.
const NOT_RUN_DETAIL_MAX = 280;
const NOT_RUN_RAW_MAX = 400;
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const UNREACHABLE_RE = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|socket hang up|fetch failed/i;

// One line of free text as it may be stored: secrets scrubbed the way the
// check logs scrub them, whitespace folded, `|` kept out (the row's reason
// uses ` | ` between its parts), and clipped.
function plainText(value, max) {
  const text = redactString(String(value == null ? '' : value))
    .replace(/([?&](?:token|jwt|auth|key)=)[^&\s]+/gi, '$1****')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  return clipChars(text, max);
}

// The HTTP status a Kubernetes API error carries, or null.
function httpStatusOf(err) {
  const code = err?.code ?? err?.statusCode ?? err?.response?.statusCode ?? err?.response?.status;
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
}

// What the API server said, from its Status body. @kubernetes/client-node
// 1.x throws `HTTP-Code: 403\nMessage: …\nBody: "{…}"\nHeaders: {…}`, with
// the Status JSON encoded once more inside the message, and keeps the body
// on `err.body`.
function apiStatusMessage(err) {
  const candidates = [err?.body];
  const inMessage = /\nBody: ([\s\S]*?)(?:\nHeaders: |$)/.exec(String(err?.message || ''));
  if (inMessage) candidates.push(inMessage[1]);
  for (let c of candidates) {
    for (let i = 0; i < 2 && typeof c === 'string'; i += 1) {
      try { c = JSON.parse(c); } catch { break; }
    }
    if (c && typeof c === 'object' && typeof c.message === 'string' && c.message.trim()) return c.message;
  }
  return null;
}

function unreachable(err) {
  return UNREACHABLE_CODES.has(err?.code) || UNREACHABLE_CODES.has(err?.cause?.code)
    || UNREACHABLE_RE.test(String(err?.message || ''));
}

// The runner's own words: the API's Status message when there is one,
// else the error's first line.
function runnerRaw(err, max = NOT_RUN_RAW_MAX) {
  const status = apiStatusMessage(err);
  if (status) return plainText(status, max);
  const message = typeof err === 'string' ? err : (typeof err?.message === 'string' ? err.message : '');
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  // The client's wrapper with no Status body: its `Message:` line is the
  // part worth keeping.
  const http = /^HTTP-Code: (\d+)$/.exec(lines[0] || '');
  if (http) {
    const said = (lines.find((l) => l.startsWith('Message: ')) || '').slice('Message: '.length);
    return plainText(`HTTP ${http[1]}${said ? `: ${said}` : ''}`, max);
  }
  return plainText(lines[0] || '', max);
}

// Why a runner-level error stopped the suite, in plain words. `creating`:
// the error is a create the API refused or never answered.
function runnerCause(err, { creating = false } = {}) {
  const said = `${apiStatusMessage(err) || ''}\n${String(err?.message || '')}`;
  if (/exceeded quota/i.test(said)) return 'the cluster\'s job quota was full';
  if (unreachable(err)) return 'the cluster could not be reached';
  const status = httpStatusOf(err);
  if (creating && status === 403) return 'the cluster refused to create its job';
  if (creating && status === 409) return 'a job with the same name was already there';
  if (status) return `the cluster answered with an error (HTTP ${status})`;
  const words = runnerRaw(err, 120);
  const failed = creating ? 'its runner failed before the suite began' : 'its runner failed';
  return words ? `${failed} (${words})` : failed;
}

// A `docker run` that failed before the container ran anything: the CLI's
// own exit codes (125 the daemon, 126/127 the command), a missing binary,
// or the daemon's words on stderr.
function dockerNeverStarted(err, stderr) {
  return [125, 126, 127, 'ENOENT'].includes(err?.code)
    || /^docker: |Error response from daemon|Cannot connect to the Docker daemon/m.test(String(stderr || ''));
}

// ── Why an install failed: the proposal's or the platform's ──────────────
//
// A pod that stopped while installing its dependencies stopped for one of
// two kinds of reason, and npm's own output says which. This list is the
// one place that decides; extend it here.
//
//   'proposal'  the change's own package.json or lockfile: a version
//               nothing satisfies, a package that does not exist, a tree
//               that does not resolve, a file that does not parse, an
//               engine it refuses, a lockfile out of sync, an install
//               script that exits non-zero. Running it again fails again,
//               so the run is 'failing' with history, as for any red suite.
//   'platform'  the network, the registry, the disk or the machine.
//               Running it again is the fix: 'error', retried.
//
// The last `npm error code X` line decides when one is listed (`code`);
// otherwise the first entry whose `text` matches the output, in order. A
// lifecycle script's failure prints a numeric code (`npm error code 1`), so
// it is matched by its text. Running out of time or memory and a failed
// clone are the platform's before this list is read (notRunOutcome).
// Output that matches nothing is taken as the platform's, and its last line
// is logged ("Unrecognised install failure") so the list can grow.
const INSTALL_FAILURES = Object.freeze([
  { fault: 'proposal', code: /^(?:ETARGET|E404|ERESOLVE|EJSONPARSE|EBADENGINE|EINTEGRITY|ENOVERSIONS|EUSAGE|ELIFECYCLE)$/ },
  { fault: 'platform', code: /^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ESOCKETTIMEDOUT)$/,
    why: 'the package registry could not be reached' },
  { fault: 'platform', code: /^(?:E429|E5\d\d)$/, why: 'the package registry answered with an error' },
  { fault: 'platform', code: /^ENOSPC$/, why: 'the machine ran out of disk space' },
  { fault: 'platform', code: /^ENOMEM$/, why: 'the machine ran out of memory' },
  { fault: 'proposal', text: /can only install packages when your package\.json and package-lock\.json (?:or npm-shrinkwrap\.json )?are in sync/i,
    why: 'its package.json and package-lock.json are out of sync' },
  { fault: 'proposal', text: /\b404 Not Found - GET\b/, why: 'a package it names does not exist' },
  { fault: 'proposal', text: /^npm (?:error|ERR!) command failed\b/m, why: 'an install script exited with an error' },
  { fault: 'platform', text: /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED)\b|socket hang up/i,
    why: 'the package registry could not be reached' },
  { fault: 'platform', text: /\bENOSPC\b|no space left on device/i, why: 'the machine ran out of disk space' },
  { fault: 'platform', text: /JavaScript heap out of memory|\bENOMEM\b|^Killed$/m, why: 'the machine ran out of memory' },
]);

// Whose fault a failed install was, from its output: `{ fault, code, why }`,
// or `{ fault: 'platform', unrecognised: true }` when nothing listed matches.
function installFault(text) {
  const out = String(text || '');
  let code = null;
  for (const m of out.matchAll(/^\s*npm (?:error|ERR!) code (\S+)\s*$/gm)) code = m[1];
  const byCode = code && INSTALL_FAILURES.find((f) => f.code && f.code.test(code));
  if (byCode) return { fault: byCode.fault, code, why: byCode.why || null };
  const byText = INSTALL_FAILURES.find((f) => f.text && f.text.test(out));
  if (byText) return { fault: byText.fault, code: null, why: byText.why };
  return { fault: 'platform', code: null, why: null, unrecognised: true };
}

// The cause clause for a failed install.
function installCause({ fault, code, why }) {
  const said = code ? `npm error code ${code}` : '';
  if (fault === 'proposal') return `installing its dependencies failed (${said || why})`;
  if (why) return `installing its dependencies failed: ${why}${said ? ` (${said})` : ''}`;
  return 'installing its dependencies failed';
}

// The output lines worth showing, newest last: the script's own markers
// and blank lines dropped.
function outputLines(text) {
  return String(text || '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/^__UNIT_SUITE_[A-Z_]+__(=|$)/.test(l));
}

// The sentence for check_error_detail: the lead, the cause and, when the
// run printed something, its last line, within NOT_RUN_DETAIL_MAX.
function notRunSentence(lead, cause, lastLine = '') {
  const base = `${lead}: ${cause}.`;
  if (!lastLine) return clipChars(base, NOT_RUN_DETAIL_MAX);
  const room = NOT_RUN_DETAIL_MAX - base.length - ' Last output: '.length;
  return room > 20 ? `${base} Last output: ${clipChars(lastLine, room)}` : clipChars(base, NOT_RUN_DETAIL_MAX);
}

// Did this run never reach `npm test`? Returns `{ detail, reason }` when it
// did not (detail: the plain sentence for check_error_detail; reason: the
// row's failureReason, the sentence and then the runner's or the output's
// own words), or null when the run's verdict stands. One case in between:
// an install that failed on the proposal's own package files
// (INSTALL_FAILURES) also never reached `npm test`, but it is the
// proposal's failure, so it comes back with `ownFailure: true`, for a
// failing row worded the same way. `unrecognised` carries an install
// failure's last line when INSTALL_FAILURES did not know it, for the log.
// `error` is what the runner threw (null on the harvest path, which reads a
// finished Job); `exitCode` the container's own, when known;
// `runtime` is 'kubernetes' or 'docker'. On Kubernetes `stdout` is the pod
// log (both streams) and `stderr` the Job's own failure reason; on Docker
// they are the container's two streams.
function notRunOutcome({
  stdout = '', stderr = '', error = null, timedOut = false, runtime = 'kubernetes', reachedTests = false,
  exitCode = error?.code,
} = {}) {
  if (reachedTests) return null;
  const out = String(stdout || '');
  const errText = String(stderr || '');
  const all = `${out}\n${errText}`;
  if (all.includes(SETUP_DONE_SENTINEL) || testsReported(all.split('\n'))) return null;

  const docker = runtime === 'docker';
  const shown = outputLines(docker ? `${out}\n${errText}` : out);
  const jobReason = docker ? '' : plainText(errText, NOT_RUN_RAW_MAX);
  const raw = (parts) => parts.filter(Boolean).join(' | ');
  const build = (lead, cause, rawText, lastLine = '') => {
    const detail = notRunSentence(lead, cause, lastLine ? plainText(lastLine, NOT_RUN_DETAIL_MAX) : '');
    // The runner's own words follow the sentence, unless the sentence
    // already quotes them whole.
    const extra = rawText && !detail.includes(rawText) ? ` | ${rawText}` : '';
    return { detail, reason: clipChars(`${detail}${extra}`, FAILURE_DETAIL_MAX) };
  };

  // The runner never got the suite going (a refused or unanswered create),
  // or failed before the Job ended (a configuration it refused, an API it
  // lost). Neither is a verdict on the code.
  if (error && !docker && !error.captureJobTerminated && !error.killed) {
    const creating = error.checkJobNotCreated === true;
    return build(creating ? NOT_RUN_LEAD.start : NOT_RUN_LEAD.run,
      runnerCause(error, { creating }), runnerRaw(error));
  }
  if (docker && !out.trim() && (!error || dockerNeverStarted(error, errText) || !errText.trim())) {
    const said = outputLines(errText).slice(-MAX_TAIL_LINES).map((l) => plainText(l, NOT_RUN_RAW_MAX));
    return build(NOT_RUN_LEAD.start, 'Docker could not run its container',
      raw(said.length ? said : [error ? runnerRaw(error) : '']));
  }

  // Killed for memory: Kubernetes says OOMKilled; Docker and a bare exit
  // say 137 (SIGKILL).
  const oom = /OOMKilled/.test(errText) || exitCode === 137;
  const outLines = out.split('\n').map((l) => l.trim());
  // The pod or container ran the script and stopped in setup.
  if (outLines.some((l) => l.startsWith(`${ROOT_SENTINEL}=`))) {
    const cloned = outLines.includes(CLONED_SENTINEL);
    const step = cloned ? 'installing its dependencies' : 'cloning the repository';
    const tail = shown.slice(-MAX_TAIL_LINES).map((l) => plainText(l, NOT_RUN_RAW_MAX));
    const lastLine = shown[shown.length - 1] || '';
    // Time, memory and the clone are the platform's; a failed install is
    // whoever npm's output says it is.
    if (oom || timedOut || !cloned) {
      const cause = oom ? `it ran out of memory while ${step}`
        : timedOut ? `${step} did not finish in ${Math.round(UNIT_SUITE_TIMEOUT_MS / 1000)}s`
          : 'the repository could not be cloned';
      return build(NOT_RUN_LEAD.setup, cause, raw([...tail, jobReason]), lastLine);
    }
    const fault = installFault(shown.join('\n'));
    const outcome = build(NOT_RUN_LEAD.setup, installCause(fault), raw([...tail, jobReason]), lastLine);
    if (fault.fault === 'proposal') return { ...outcome, ownFailure: true };
    return fault.unrecognised ? { ...outcome, unrecognised: plainText(lastLine, NOT_RUN_RAW_MAX) } : outcome;
  }
  // The Job ended and its log held nothing at all.
  if (!docker && !out.trim()) {
    const cause = oom ? 'its job ran out of memory without printing anything'
      : timedOut ? 'its job ran out of time without printing anything'
        : 'its job ended without printing anything';
    return build(NOT_RUN_LEAD.setup, cause, raw([jobReason, error ? runnerRaw(error) : '']));
  }
  return null;
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
  # A suite split across Jobs (TEST_SHARD=k/n) validates the SQL once, in
  # its first shard; every shard keeps the server for its own tests.
  if [ -z "\${TEST_SHARD:-}" ] || [ "\${TEST_SHARD%%/*}" = "1" ]; then
    npm run lint:sql
  fi
fi
# One shard of a split suite runs the repo's own \`test:shard\` script, after
# the pretest \`npm test\` would have run. A repo without one runs its whole
# suite in every Job it is given, which is still correct.
TEST_CMD="npm test"
if [ -n "\${TEST_SHARD:-}" ] && node -e "process.exit(require('./package.json').scripts?.['test:shard']?0:1)"; then
  npm run pretest --if-present
  TEST_CMD="npm run test:shard"
fi
# A copy of the run's own output, so a red run can print its failures again
# at the end (${RECAP_SENTINEL}): the log the cluster keeps of a long run
# can lose its start. The exit code stays npm test's.
TEST_LOG="$WS/.unit-suite-test.log"
set +e
$TEST_CMD | tee "$TEST_LOG"
TEST_STATUS=\${PIPESTATUS[0]}
set -e
if [ "$TEST_STATUS" -ne 0 ]; then
  echo "${ROOT_SENTINEL}=$(pwd -P)"
  awk -v max=${RECAP_MAX_TESTS} -v block=${RECAP_MAX_BLOCK_LINES} '
    /^not ok / {
      inblk = 0
      if (toupper($0) ~ /[ \\t]#[ \\t]*(SKIP|TODO)/) next
      n++; keep = (n <= max); inblk = 1; blk = 0
      if (keep) out[++k] = $0
      next
    }
    inblk && /^[ \\t]/ { if (keep && blk < block) { out[++k] = $0; blk++ } next }
    { inblk = 0 }
    END { print "${RECAP_SENTINEL}=" n + 0; for (i = 1; i <= k; i++) print out[i] }
  ' "$TEST_LOG" || true
fi
exit "$TEST_STATUS"
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
// The TAP summary counters a run ends with. `duration_ms` is the longest
// shard's, the rest add up.
const SUMMARY_LINE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)\s*$/;

/**
 * Join the outputs of one suite's shards into the output one Job would have
 * printed: each shard's lines with its workspace path rewritten to the
 * first shard's (so a test's file reads the same whichever shard ran it),
 * one summary block that adds the shards' counters up, and, when any shard
 * failed, one recap of every shard's failures with their total count.
 * `parts` are `{ stdout, stderr }`, in shard order.
 */
function joinUnitShardOutputs(parts) {
  let root = null;
  const bodies = [];
  const recapEntries = [];
  let recapTotal = 0;
  let anyRecap = false;
  const totals = new Map();
  for (const part of parts || []) {
    let lines = String((part && part.stdout) || '').split('\n');
    const rootLine = lines.find((l) => l.startsWith(`${ROOT_SENTINEL}=`));
    const shardRoot = rootLine ? rootLine.slice(ROOT_SENTINEL.length + 1).trim().replace(/\/+$/, '') : null;
    if (root === null && shardRoot) root = shardRoot;
    if (shardRoot && root && shardRoot !== root) {
      lines = lines.map((l) => (l.startsWith(`${ROOT_SENTINEL}=`) ? `${ROOT_SENTINEL}=${root}` : l.split(`${shardRoot}/`).join(`${root}/`)));
    }
    const at = recapIndex(lines);
    const count = recapCount(lines);
    if (at !== -1) {
      anyRecap = true;
      recapTotal += count || 0;
      recapEntries.push(...lines.slice(at + 1).filter((l) => l !== ''));
    }
    for (const l of at === -1 ? lines : lines.slice(0, at)) {
      const m = SUMMARY_LINE.exec(l);
      if (!m) { bodies.push(l); continue; }
      const value = Number(m[2]);
      const prev = totals.get(m[1]);
      totals.set(m[1], m[1] === 'duration_ms' ? Math.max(prev || 0, value) : (prev || 0) + value);
    }
  }
  const out = bodies.filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''));
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
    if (totals.has(key)) out.push(`# ${key} ${totals.get(key)}`);
  }
  if (anyRecap) {
    if (root) out.push(`${ROOT_SENTINEL}=${root}`);
    out.push(`${RECAP_SENTINEL}=${recapTotal}`, ...recapEntries);
  }
  return {
    stdout: out.join('\n'),
    stderr: (parts || []).map((p) => String((p && p.stderr) || '')).filter(Boolean).join('\n'),
  };
}

// One progress snapshot for a suite's shards, each read by its own tracker:
// counts add up, the phase is the furthest-behind shard's, and it is done
// when every shard is.
const PHASE_ORDER = ['cloning', 'installing', 'running', 'done'];
function combineUnitSnapshots(snaps, expected = null) {
  const list = (snaps || []).filter(Boolean);
  const phase = list.reduce((p, s) => (PHASE_ORDER.indexOf(s.phase) < PHASE_ORDER.indexOf(p) ? s.phase : p), 'done');
  const sum = (key) => list.reduce((n, s) => n + (Number(s[key]) || 0), 0);
  return {
    phase,
    ran: sum('ran'), passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped'),
    expected: Number.isInteger(expected) && expected > 0 ? expected : null,
    done: phase === 'done',
    shards: list.length,
    updatedAt: new Date().toISOString(),
  };
}

function makeUnitSuiteTracker(expected = null) {
  let phase = 'cloning';
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let summary = null;
  let recap = false;
  const total = Number.isInteger(expected) && expected > 0 ? expected : null;
  return {
    // Returns true when the line changed the state.
    feed(line) {
      const l = String(line || '');
      if (l === CLONED_SENTINEL) { phase = 'installing'; return true; }
      if (l === SETUP_DONE_SENTINEL) { phase = 'running'; return true; }
      // The recap repeats failures already counted.
      if (l.startsWith(`${RECAP_SENTINEL}=`)) { recap = true; return false; }
      if (recap) return false;
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
    // `notRun`: the suite never reached `npm test` (notRunOutcome), so the
    // card can say it could not run rather than that it finished red.
    finish(exitOk, { notRun = false } = {}) {
      phase = 'done';
      this.exitOk = !!exitOk;
      this.notRun = !exitOk && !!notRun;
      return this.snapshot();
    },
    // Has the run reached `npm test`? The setup sentinel or a test line
    // seen on the stream says so even when the final log comes back without
    // either.
    reachedTests() { return phase === 'running'; },
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
        ...(phase === 'done' && this.notRun ? { notRun: true } : {}),
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

// A failed run, read once for both paths (the live run below and the
// harvest's outcomeFromLog): a suite that never ran (`notRun`, an 'error'
// when it is merge-blocking), an install that failed on the proposal's own
// package files (`setupFailed`: a red suite, worded as notRunOutcome words
// it), or a suite that ran and failed (the grouped reason and the per-test
// excerpts). An install failure INSTALL_FAILURES does not know is logged
// with its last line, so the list can grow.
function readFailure({
  sessionId = null, stdout, stderr, error = null, timedOut = false, runtime, reachedTests = false,
  exitCode = undefined, fallback,
}) {
  const setup = notRunOutcome({ stdout, stderr, error, timedOut, runtime, reachedTests, exitCode });
  if (setup?.unrecognised) {
    log.warn('unit-suite', 'Unrecognised install failure, read as the platform\'s', {
      sessionId, lastLine: setup.unrecognised,
    });
  }
  if (setup?.ownFailure) return { reason: setup.reason, unitDetails: null, notRun: null, setupFailed: true };
  if (setup) return { reason: setup.reason, unitDetails: null, notRun: setup, setupFailed: false };
  const parts = failureOutcomeParts(stdout, stderr, { timedOut });
  return { reason: parts.reason || fallback, unitDetails: parts, notRun: null, setupFailed: false };
}

// Run the proposal repo's unit suite and shape the outcome as one
// extraRows entry plus its check-history record. Returns null when there
// is nothing to run (feature off, GitHub off, no runnable test script) —
// the checks run then proceeds exactly as before this feature existed.
// `onProgress(snapshot)` is called with the tracker's snapshot each time a
// stdout line changes it, and once more with phase 'done' when the run
// ends; the caller owns any throttling. Normal failures become check rows;
// explicit cancellation propagates to the preview lifecycle owner.
//
// `jobNamePrefix` names the Job outside a preview run's own check Jobs: an
// early unit suite started with the preview build (services/early-unit-suite.js).
async function maybeRunUnitSuite({ config, pool, appId, sessionId, repoOwner, repoName, ref, prNumber, onProgress = null, signal = null, previewRunId = null, jobNamePrefix = null }) {
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
    graduated = (await checkHistory.loadGraduated(pool, appId, { sessionId })).has(checkKey);
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
  const runtime = config?.workerRuntime === 'kubernetes' ? 'kubernetes' : 'docker';
  let passed = false;
  let reason = '';
  let unitDetails = null;
  let notRun = null;
  let setupFailed = false;
  try {
    const cloneUrl = await github.getCloneUrl(repoOwner, repoName);
    const options = {
      onStdoutLine: observe,
      signal, previewRunId,
      ...(jobNamePrefix ? { namePrefix: jobNamePrefix } : {}),
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
    const shards = runtime === 'kubernetes' && hasShardScript(rawPkg) ? unitSuiteShardCount() : 1;
    const result = shards > 1
      ? await runUnitSuiteShards(config, {
        sessionId, options, shards, tracker, expected: tracker.snapshot().expected, report, signal,
      })
      : runtime === 'kubernetes'
        ? await kubernetes.runUnitSuiteJob(config, { sessionId, ...options })
        : await docker.runOneShot(`usernode-unit-suite-${sessionId}`, options);
    readSummary(result?.stdout);
    passed = true;
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    readSummary(err.stdout);
    const timedOut = err.killed === true || err.signal === 'SIGTERM' || err.signal === 'SIGKILL';
    ({ reason, unitDetails, notRun, setupFailed } = readFailure({
      sessionId, stdout: err.stdout, stderr: err.stderr, error: err, timedOut, runtime,
      reachedTests: err.shardNotRun ? false : tracker.reachedTests(),
      fallback: String(err.message || 'npm test failed').slice(0, FAILURE_DETAIL_MAX),
    }));
  }
  const finalSnap = tracker.finish(passed, { notRun: !!(notRun || setupFailed) });
  report(finalSnap);
  const summary = finalSnap.summary || null;
  if (summary && Number.isInteger(summary.tests)) await storeExpectedTests(pool, appId, summary.tests);
  log.info('unit-suite', notRun ? 'Unit suite could not run' : 'Unit suite finished', {
    sessionId, repo: `${repoOwner}/${repoName}`, ref, passed, graduated,
    durationMs: Date.now() - startedAt, tests: summary ? summary.tests : undefined,
    ...(notRun ? { reason: notRun.reason } : {}),
  });

  return shapeOutcome({ passed, reason, graduated, summary, unitDetails, notRun, setupFailed });
}

// The suite as `shards` Jobs at once (see UNIT_SUITE_SHARDS above), each
// with TEST_SHARD=k/n. Resolves `{ stdout, stderr }` joined as one Job's
// would be when every shard passed; otherwise throws as one failed Job
// would, carrying the joined output: a shard that could not run makes the
// whole suite one that could not run, and a shard that failed makes it a
// failed suite. Progress is each shard's tracker, combined. The run's own
// `tracker` hears the joined output, so its final snapshot is the suite's.
async function runUnitSuiteShards(config, {
  sessionId, options, shards, tracker, expected = null, report = () => {}, signal = null,
  runJob = (opts) => kubernetes.runUnitSuiteJob(config, opts),
}) {
  const trackers = Array.from({ length: shards }, () => makeUnitSuiteTracker(null));
  const publish = () => report(combineUnitSnapshots(trackers.map((t) => t.snapshot()), expected));
  const settled = await Promise.allSettled(trackers.map((shardTracker, i) => runJob({
    sessionId, ...options,
    onStdoutLine: (line) => {
      if (shardTracker.feed(line)) publish();
      // Setup and test lines reach the run's tracker too, so it can say the
      // suite reached its tests; the summary is fed from the joined output.
      if (!/^# (tests|pass|fail|skipped|cancelled|todo) /.test(line)) tracker.feed(line);
    },
    env: { ...options.env, TEST_SHARD: `${i + 1}/${shards}` },
    nameSuffix: i === 0 ? null : `u${i + 1}`, unitShard: `${i + 1}-of-${shards}`,
    cpuRequest: UNIT_SUITE_SHARD_CPU_REQUEST, memory: UNIT_SUITE_SHARD_MEMORY,
  })));
  if (signal?.aborted) throw signal.reason;
  const parts = settled.map((r) => (r.status === 'fulfilled' ? (r.value || {}) : (r.reason || {})));
  const failed = settled.filter((r) => r.status === 'rejected').map((r) => r.reason || new Error('unit-suite shard failed'));
  if (!failed.length) return joinUnitShardOutputs(parts);
  // A shard that never reached its tests (its Job refused, its setup gone):
  // the suite did not run, whatever the others say.
  for (const err of failed) {
    const setup = notRunOutcome({
      stdout: err.stdout, stderr: err.stderr, error: err,
      timedOut: err.killed === true, runtime: 'kubernetes', reachedTests: false, exitCode: err.code,
    });
    // The other shards' lines reached the run's tracker, so say outright
    // that this suite did not get going.
    if (setup) throw Object.assign(err, { shardNotRun: true });
  }
  const joined = joinUnitShardOutputs(parts);
  const first = failed[0];
  const err = Object.assign(new Error(first.message || 'npm test failed'), {
    stdout: joined.stdout, stderr: joined.stderr, code: first.code,
    killed: failed.some((e) => e.killed === true), signal: first.signal,
  });
  throw err;
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
//
// A suite that never ran (`notRun`, from notRunOutcome) keeps the row, so
// the card and the connector can say why, but marks it `couldNotRun` and
// records no history: it observed nothing about the code, so it neither
// graduates the check nor stamps a failure on it. `notRun` rides on the
// outcome as the plain sentence the run's check_error_detail takes when
// this suite is merge-blocking (visuals.classifyTests makes that run an
// 'error').
//
// An install that failed on the proposal's own package files
// (`setupFailed`) is a red suite like any other: failing, recorded in
// history. Its row is marked `setupFailed` so main-watch, which never paused
// merges for a suite that could not get going, still reads it as 'error'.
function shapeOutcome({ passed, reason, graduated, summary, unitDetails = null, notRun = null, setupFailed = false }) {
  const checkKey = appManifest.checkKey(UNIT_CHECK_NAME, UNIT_CHECK_PATH);
  const neverRan = !passed && !!notRun;
  const ownSetup = !passed && !neverRan && !!setupFailed;
  const details = !neverRan && unitDetails && Array.isArray(unitDetails.details) ? unitDetails.details : [];
  return {
    row: {
      index: UNIT_CHECK_INDEX,
      name: UNIT_CHECK_NAME,
      path: UNIT_CHECK_PATH,
      status: passed ? 'pass' : 'fail',
      advisory: passed ? false : !graduated,
      ...(neverRan ? { couldNotRun: true } : {}),
      ...(ownSetup ? { setupFailed: true } : {}),
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
    history: neverRan ? null : { checkKey, name: UNIT_CHECK_NAME, path: UNIT_CHECK_PATH, passed },
    ...(neverRan ? { notRun: notRun.detail } : {}),
    // The failing tests by name, beside the row rather than in it: only
    // main-watch reads them (its known-flake rule), and the row is what
    // every proposal's checks store.
    ...(!passed && !neverRan && unitDetails && unitDetails.named ? { failingTests: unitDetails.named } : {}),
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
  pool, appId, sessionId, succeeded, stdout, stderr = '', timedOut = false, exitCode = undefined,
  graduated = false, tracker = null,
}) {
  const t = tracker || makeUnitSuiteTracker(await loadExpectedTests(pool, appId));
  for (const line of String(stdout || '').split('\n')) {
    if (/^# (tests|pass|fail|skipped|cancelled|todo) /.test(line)) t.feed(line);
  }
  const passed = !!succeeded;
  // A Job that ended in setup, or with nothing in its log, never ran the
  // suite: the same reading the live path takes (readFailure).
  const { reason = '', unitDetails = null, notRun = null, setupFailed = false } = passed ? {} : readFailure({
    sessionId, stdout, stderr, timedOut, runtime: 'kubernetes', exitCode,
    reachedTests: typeof t.reachedTests === 'function' && t.reachedTests(),
    fallback: timedOut ? 'npm test timed out' : 'npm test failed',
  });
  const finalSnap = t.finish(passed, { notRun: !!(notRun || setupFailed) });
  const summary = finalSnap.summary || null;
  if (summary && Number.isInteger(summary.tests)) await storeExpectedTests(pool, appId, summary.tests);
  log.info('unit-suite', 'Unit suite outcome read from its finished Job', {
    sessionId, appId, passed, graduated, tests: summary ? summary.tests : undefined,
    ...(notRun ? { notRun: notRun.reason } : {}),
  });
  return shapeOutcome({ passed, reason, graduated, summary, unitDetails, notRun, setupFailed });
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
  notRunOutcome,
  installFault,
  INSTALL_FAILURES,
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
  joinUnitShardOutputs,
  combineUnitSnapshots,
  runUnitSuiteShards,
  unitSuiteShardCount,
  hasShardScript,
  RECAP_SENTINEL,
  RECAP_MAX_TESTS,
  FAILURE_DETAIL_MAX,
  RUN_SCRIPT,
};
