// #2038: the sweep that measures every promoted proposal against main
// (server.js measurePromotedProposals, once the session sweeper's "Pass 9"),
// which replaced #1442's freshness pass.
//
// The old pass was bounded in ways that were forced on it rather than
// chosen: ten rows a tick, a five-minute per-row cooldown, leader-only. Every
// one of those existed because a single row cost two to six GitHub reads
// against a shared rate limit. The consequence was that a proposal nobody had
// opened could carry numbers that were hours old while the merge gate read
// them — and a drifted proposal below the vote threshold was measured by
// nothing at all, which is #2038's F2.
//
// A measurement is local plumbing against the app's own mirror now, so the
// cap and the cooldown are gone on purpose. The properties still worth
// pinning are the ones that keep it correct rather than the ones that kept it
// cheap:
//
//   * EVERY promoted proposal is measured, with no per-tick cap and no
//     per-row cooldown — the regression this whole change exists to prevent;
//   * a session mid-turn is skipped, because its head is about to move and
//     the answer would be wrong before it was written;
//   * rows are grouped by app, and one `git fetch` serves every open
//     proposal on that app (it was one per proposal until 19 Oct 2026);
//   * it runs only on the leader, so a multi-instance deploy does not
//     double-fetch.
//
// The structural claims are asserted against server.js's source, as the
// freshness sweeper's were.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The measurement pass, isolated so a match in another pass cannot pass a
// test about this one. It has its own timer now, beside the session sweeper.
function pass9() {
  const start = SERVER.indexOf('async function measurePromotedProposals(');
  assert.notEqual(start, -1, 'the measurement sweep exists in server.js');
  const end = SERVER.indexOf('function startSessionAutoPauseSweeper(', start);
  assert.notEqual(end, -1, 'and is defined before the sweeper that starts it');
  return SERVER.slice(start, end);
}
// Its timer, which catches what a pass throws.
function timer() {
  const start = SERVER.indexOf("proposalMeasureHandle = setInterval(singleFlight('proposal-measure'");
  assert.notEqual(start, -1, 'the measurement has its own single-flight timer');
  return SERVER.slice(start, SERVER.indexOf('}), config.sessionSweepIntervalMs)', start));
}

test('every promoted proposal is measured — no per-tick cap, no per-row cooldown', () => {
  const block = pass9();
  assert.doesNotMatch(block, /MAX_[A-Z_]*PER_SWEEP/,
    'a per-tick cap is what let a proposal go hours without being measured');
  assert.doesNotMatch(block, /COOLDOWN_MS/,
    'a per-row cooldown is the other half of the same failure');
  assert.doesNotMatch(block, /LIMIT \d+/,
    'the candidate query must not silently measure only the first N rows');
  assert.match(block, /status = 'promoted'/,
    'the candidate set is every promoted proposal');
});

test('a session mid-turn is skipped', () => {
  // Its head is about to move; an answer written now describes a commit that
  // will not exist by the time anybody reads it.
  // Mid-turn on any process: a web process runs the turns its routes start
  // (docs/plans/web-and-conductor.md).
  assert.match(pass9(), /sessions\.filter\(\(session\) => !\(worker\.isInFlight\(session\.id\) \|\| activeWorkersSvc\.isSessionBusy\(session\.id\)\)\)/);
});

test('candidates are grouped by app so one fetch serves them all', () => {
  const block = pass9();
  assert.match(block, /ORDER BY cs\.app_id/,
    'measuring app-by-app is what makes a single mirror fetch cover every '
    + 'open proposal on it');
  assert.match(block, /for \(const sessions of byApp\.values\(\)\)/);
  assert.match(block, /integrationSvc\.fetchAppMirror\(ready\)/, 'one fetch for the app');
  assert.match(block, /\.\.\.\(mirrorDir \? \{ mirrorDir \} : \{\}\)/, 'which every measurement of it reads');
});

test('the sweep degrades rather than throwing, and says so', () => {
  const block = pass9();
  assert.match(block, /fetchAppMirror\(ready\)\.catch\(\(err\) => \{\s+log\.warn\(/,
    'an app whose fetch fails is recorded, and its proposals still measured');
  assert.match(timer(), /catch \(err\) \{\s+log\.warn\('server', 'Proposal measurement sweep failed'/,
    'a pass that throws is recorded rather than swallowed silently, and the next tick runs');
});

test('it runs on the leader only', () => {
  // The sweep body lives in the session sweeper, and the session sweeper is
  // started from the leader-duties block — so a follower instance never
  // fetches a mirror, let alone every mirror.
  const leaderStart = SERVER.indexOf('Running leader duties');
  assert.notEqual(leaderStart, -1, 'the leader-duties block exists');
  const startCall = SERVER.indexOf('startSessionAutoPauseSweeper(config)', leaderStart);
  assert.notEqual(startCall, -1,
    'the session sweeper, which starts the measurement timer, is started under leader duties');
  const sweeper = SERVER.slice(SERVER.indexOf('function startSessionAutoPauseSweeper('), SERVER.indexOf('// Revisions refreshed + reversible-archive hard GC.'));
  assert.match(sweeper, /proposalMeasureHandle = setInterval\(singleFlight\('proposal-measure'/);
  // Bounded rather than exact: the point is that the call sits inside that
  // block, not that it sits at a particular offset within it.
  const nextTopLevel = SERVER.indexOf('\nasync function ', leaderStart);
  assert.ok(nextTopLevel === -1 || startCall < nextTopLevel,
    'the sweeper start must be inside leader duties, not after them');
});

test('the sweep writes through services/integration, not its own SQL', () => {
  const block = pass9();
  assert.match(block, /integrationSvc\.measure\(/,
    'one writer owns the record — a second one here is how six columns with '
    + 'five writers happened in the first place');
  assert.doesNotMatch(block, /UPDATE chat_sessions/,
    'the sweep must not write the record behind the service that owns it');
});
