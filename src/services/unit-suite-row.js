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
};
