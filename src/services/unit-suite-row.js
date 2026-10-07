// The repo unit suite's check row, as the readers of a stored checks run
// recognise it.
//
// Kept apart from services/unit-suite.js, which pulls in docker, kubernetes
// and github to RUN the suite. The code that only READS a stored row — the
// fix turn's prompt (routes/sessions.js summarizeFailingChecks) and the
// connector's get_proposal (services/mcp-tools.js shapeChecks) — needs to
// know which row it is and how long its reason may be, and must not load a
// container runtime to ask.

'use strict';

const UNIT_CHECK_NAME = 'Repo unit suite (npm test) passes';
const UNIT_CHECK_PATH = 'package.json';
// Synthetic-row index namespace: -1 is the missing-advisory rollup, -2 the
// over-ceiling guard (visuals.js). This row is -3.
const UNIT_CHECK_INDEX = -3;

// failureReason rides in test_results inside every proposal payload — keep
// it a diagnostic pointer, not a log dump. It is also the ONLY place a fix
// turn learns which test files failed, so a reader that shows this row must
// show all of it: failureDetail already fitted the file list inside this
// bound, and a shorter cut downstream drops exactly that list.
const FAILURE_DETAIL_MAX = 1600;

// ── Per-test excerpts (request #3978) ───────────────────────────────────
//
// Beside the grouped reason the run now keeps, for each failing top-level
// test, a clipped excerpt of its TAP diagnostic block (error, code,
// expected/actual, failureType, the first stack lines) plus the stdout
// printed just before it. The names alone cannot say whether a failure is
// an assertion, a schema error, a timeout or an environment difference;
// the excerpt can. These bounds are the contract every reader clips
// against, kept here so the readers stay docker-free.
//
// One test's excerpt, in characters. The YAML block of a node:test
// assertion fits comfortably; a pathological stack is cut, not grown.
const MAX_TEST_EXCERPT_CHARS = 2048;
// How many failing tests keep an excerpt, and the byte budget the row's
// failureDetails array as a whole may reach. Both match the connector's
// own MAX_FAILURE_DETAILS shape: a diagnosis, not a log.
const MAX_UNIT_EXCERPTS = 10;
const MAX_UNIT_DETAILS_BYTES = 20 * 1024;
// Lines of stdout printed just before the `not ok` that ride with a test's
// excerpt, and how long each may be.
const MAX_EXCERPT_PRECEDING_LINES = 20;
const MAX_EXCERPT_LINE_CHARS = 300;
// Stack lines kept from a test's YAML block; the rest is folded into a
// "… N more" marker.
const MAX_STACK_LINES = 10;
// What get_proposal's failures[].details previews inline: fewer tests than
// the row keeps and a tighter per-test clip. get_check_output returns the
// whole stored excerpt (MAX_TEST_EXCERPT_CHARS) — this preview only has to
// name the error and point at the tool.
const MAX_INLINE_EXCERPT_TESTS = 3;
const MAX_INLINE_EXCERPT_CHARS = 600;

// Found by the identity shapeOutcome gives the row, so a rename of the check
// cannot silently stop a reader from recognising it.
function isUnitSuiteRow(r) {
  return !!r && typeof r === 'object'
    && (r.index === UNIT_CHECK_INDEX || (r.name === UNIT_CHECK_NAME && r.path === UNIT_CHECK_PATH));
}

// One `file (N): name; name…` group of the reason services/unit-suite.js
// writes. The file is a repo path, or the group a test with no `location:`
// lands in, so a jest or npm line in a tail cannot pass for one.
const REASON_GROUP = /^(\(file not reported\)|\S+) \((\d+)\)(?:: (.+))?$/;

// The failing tests a stored run's unit-suite row records (#4265): how many
// failed and the first `max` of them as `{ file, test }`, or null when the
// row is absent, passed, or names and counts no failing test (setup failed,
// or the run was killed before it reported). A red run the platform runs
// again can still carry these, and running the same code again does not fix
// a test it fails, so a reader about to say "nothing to fix" asks this
// first. The count is the TAP summary's when the row kept one.
function unitSuiteFailures(testResults, { max = 2 } = {}) {
  let rows = testResults;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { return null; }
  }
  if (!Array.isArray(rows)) return null;
  const row = rows.find(isUnitSuiteRow);
  if (!row || row.status === 'pass') return null;
  const details = (Array.isArray(row.failureDetails) ? row.failureDetails : [])
    .filter((d) => d && d.test)
    .map((d) => ({ file: d.file ? String(d.file) : null, test: String(d.test) }));
  const grouped = [];
  let groupedCount = 0;
  for (const part of String(row.failureReason || '').split(' | ')) {
    const m = REASON_GROUP.exec(part.trim());
    if (!m) continue;
    groupedCount += parseInt(m[2], 10);
    const name = m[3] ? m[3].split('; ')[0].replace(/…$/, '').trim() : '';
    if (name) grouped.push({ file: m[1] === '(file not reported)' ? null : m[1], test: name });
  }
  const summaryFail = row.summary && Number.isInteger(row.summary.fail) ? row.summary.fail : 0;
  const count = summaryFail > 0 ? summaryFail : Math.max(groupedCount, details.length);
  if (!count) return null;
  return { count, first: (details.length ? details : grouped).slice(0, max) };
}

module.exports = {
  UNIT_CHECK_NAME,
  UNIT_CHECK_PATH,
  UNIT_CHECK_INDEX,
  FAILURE_DETAIL_MAX,
  MAX_TEST_EXCERPT_CHARS,
  MAX_UNIT_EXCERPTS,
  MAX_UNIT_DETAILS_BYTES,
  MAX_EXCERPT_PRECEDING_LINES,
  MAX_EXCERPT_LINE_CHARS,
  MAX_STACK_LINES,
  MAX_INLINE_EXCERPT_TESTS,
  MAX_INLINE_EXCERPT_CHARS,
  isUnitSuiteRow,
  unitSuiteFailures,
};
