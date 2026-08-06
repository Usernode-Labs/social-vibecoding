// #998: the declared-tests budget in the checks pipeline.
//
//   - overCeilingCheckRow fails the proposal that grows dapp.json's tests
//     array past MAX_DECLARED_TESTS (entries there never run), and leaves
//     inheritors of an already-over manifest alone.
//   - captureForSession treats rotated tail checks as advisory: their
//     failures are annotated and kept visible but only head failures flip
//     the suite verdict.
//
// Run with: node --test tests/checks-budget.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const visuals = require('../src/services/visuals');
const appManifest = require('../src/services/app-manifest');

const VISUALS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8'
);

test('under the ceiling there is no synthetic row', async () => {
  const row = await visuals.overCeilingCheckRow('o', 'r', appManifest.MAX_DECLARED_TESTS);
  assert.equal(row, null);
});

test('over the ceiling produces a failing row when the base cannot excuse it', async () => {
  // GitHub is disabled in unit tests, so resolveDeclaredTests reports the
  // base as rawCount 0 — the head unambiguously grew the list. The row
  // must be a well-formed result entry (the UI renders it verbatim).
  const over = appManifest.MAX_DECLARED_TESTS + 3;
  const row = await visuals.overCeilingCheckRow('o', 'r', over);
  assert.ok(row, 'a synthetic row is produced');
  assert.equal(row.status, 'fail');
  assert.equal(row.path, appManifest.MANIFEST_FILENAME);
  assert.match(row.name, new RegExp(`${over} checks`));
  assert.match(row.failureReason, /Remove or consolidate/);
  assert.deepEqual(row.consoleErrors, []);
});

test('the orchestrator injects the row and downgrades rotated failures, in that order', () => {
  // The advisory pass and the over-ceiling injection are inline in
  // captureForSession — pin their load-bearing properties textually:
  //   1. rotated failures never set gatingFail, head failures do;
  //   2. a purely-advisory failure set flips the verdict back to passing;
  //   3. the over-ceiling row is skipped on 'error' verdicts (fail-closed
  //      crash semantics stay untouched).
  const advisory = VISUALS_SRC.indexOf("r.name = `(advisory) ${r.name}`");
  assert.ok(advisory > -1, 'rotated failures are annotated as advisory');
  const downgrade = VISUALS_SRC.indexOf("if (!gatingFail) checksResult.state = 'passing'");
  assert.ok(downgrade > advisory, 'an all-advisory failure set does not block the merge');
  assert.match(VISUALS_SRC, /if \(checksResult\.state !== 'error'\) \{\s*\n\s*const overRow = await overCeilingCheckRow/,
    "the over-ceiling row is injected only on real verdicts, never on 'error'");
  assert.match(VISUALS_SRC, /selectTestsForRun\(declaredTests, commitHash \|\| gitRef \|\| ''\)/,
    'per-run selection is seeded by the commit SHA so re-runs reproduce failures');
});
