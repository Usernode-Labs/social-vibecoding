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

// #3978. Beside that reason the row keeps `failureDetails`: per failing test,
// `{ file, test, excerpt }`, where the excerpt is the error the runner
// printed (message, code, expected/actual, the first stack frames, and the
// output just before it). The reason says WHICH tests failed; this says
// why, which is what tells an assertion on the change apart from a schema
// error, a timeout or an environment difference. It rides in every list
// payload that carries a failing row, so it is bounded three ways: how many
// tests, how long one excerpt, and how long all of them together.
const FAILURE_EXCERPT_TESTS_MAX = 10;
const FAILURE_EXCERPT_MAX = 1500;
const FAILURE_EXCERPTS_TOTAL_MAX = 8000;

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
  FAILURE_EXCERPT_TESTS_MAX,
  FAILURE_EXCERPT_MAX,
  FAILURE_EXCERPTS_TOTAL_MAX,
  isUnitSuiteRow,
};
