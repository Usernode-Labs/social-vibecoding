// Turn-end PR-creation failure handling (2026-07-24 outage hardening).
//
// The dev-turn wrap-up in routes/sessions.js calls applyPrMetadata after
// the commit+push has landed. applyPrMetadata now throws typed errors
// ('github_unavailable'), and an escaped throw there would abort the whole
// turn — killing the staging build for a PR that isn't needed yet. The
// call must therefore be wrapped in try/catch that (a) never rethrows,
// (b) tells the user via sendStatus, and (c) informs the Mayor via
// summaryParts so it doesn't "fix" a GitHub outage with no-op commits.
//
// The wrap-up lives deep inside the chat route's closure (not separately
// invocable), so this is a source-contract test in the style of the
// repo's other readFileSync-based tests: it pins the structural
// properties of that exact region so a refactor can't silently drop the
// protection.
//
// Run with: node --test tests/turn-end-pr-failure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
  'utf8'
);

// Isolate the turn-end region: from the wasNewPR marker to the
// "PR #N created" success branch that follows it.
function turnEndRegion() {
  const start = SRC.indexOf('const wasNewPR = !session.pr_number;');
  assert.ok(start !== -1, 'turn-end wasNewPR marker exists');
  const end = SRC.indexOf('if (prResult && wasNewPR)', start);
  assert.ok(end !== -1, 'success branch follows the call');
  return SRC.slice(start, end);
}

test('turn-end applyPrMetadata is wrapped in try/catch', () => {
  const region = turnEndRegion();
  const tryIdx = region.indexOf('try {');
  const callIdx = region.indexOf('await prMetadata.applyPrMetadata(');
  const catchIdx = region.indexOf('} catch (prErr)');
  assert.ok(tryIdx !== -1 && callIdx !== -1 && catchIdx !== -1, 'try / call / catch all present');
  assert.ok(tryIdx < callIdx && callIdx < catchIdx, 'the call sits inside the try block');
});

test('the catch never rethrows — the turn (and staging build) continues', () => {
  const region = turnEndRegion();
  const catchBody = region.slice(region.indexOf('} catch (prErr)'));
  assert.ok(!/throw\s/.test(catchBody), 'no throw inside the turn-end catch');
});

test('github_unavailable surfaces to the user (sendStatus) and the Mayor (summaryParts)', () => {
  const region = turnEndRegion();
  const catchBody = region.slice(region.indexOf('} catch (prErr)'));
  assert.match(catchBody, /github_unavailable/);
  assert.match(catchBody, /sendStatus\('GitHub is having trouble creating the pull request/);
  assert.match(catchBody, /summaryParts\.push\('NOTE: GitHub/);
  assert.match(catchBody, /Do NOT retry by dispatching extra commits/);
});

test('the failure is logged via describeGithubError, not a possibly-empty err.message', () => {
  const region = turnEndRegion();
  const catchBody = region.slice(region.indexOf('} catch (prErr)'));
  assert.match(catchBody, /github\.describeGithubError\(prErr\)/);
});
