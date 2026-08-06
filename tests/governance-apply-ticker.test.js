// #1010: decision tests for the fast governance-apply ticker
// (startGovernanceApplyTicker in server.js).
//
// A governance proposal can become mergeable purely through the passage of
// time — the threshold is met and the visibility window runs out with no
// further vote to drive the apply. Before this ticker the only thing that
// noticed was the HOURLY stale-PR sweeper's Pass 0b, so a close proposal whose
// countdown reached zero sat visibly decided-but-open for up to an hour. That
// dead air is issue #1010, and it is also what would make the client's derived
// "Closing issue…" spinner a promise nothing keeps.
//
// The ticker's wiring in server.js is a thin branch over the pure gate: for
// each open governance row it computes governedGate(...) and dispatches the
// matching apply helper only when `gate.mergeable`. These tests lock that
// decision predicate — the part carrying all the policy — over a matrix of
// vote splits, ages and kinds, using the REAL gate math. No DB, no server
// spin-up, same approach as tests/rejection-sweeper.test.js.
//
// The one asymmetry worth pinning: the ticker is gate-first for EVERY kind,
// including close_issue. The hourly Pass 0b deliberately dispatches
// close_issue rows UNCONDITIONALLY so maybeApplyCloseIssueProposal's
// superseded guard doubles as the catch-all for issues closed by hand on
// GitHub — but that guard costs a fetchPublicIssues per app, which at 60s
// cadence would be a GitHub fetch per app per minute. So the superseded sweep
// stays hourly and the ticker only touches rows the gate already clears.
//
// Run with: node --test tests/governance-apply-ticker.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGate } = require('../src/services/active-users');
const { computeGate } = require('../src/services/governance');
const config = require('../src/config');
const { setPlatformKeys } = require('./platform-keys');

const MIN = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const opened = '2026-06-01T00:00:00.000Z';
const openedMs = Date.parse(opened);

// Mirror of the ticker's per-row branch (server.js
// startGovernanceApplyTicker): gate-first for every kind, and which apply
// helper a dispatched row reaches.
function tickAction(gate, kind) {
  if (!gate.mergeable) return 'skip';
  if (kind === 'close_issue') return 'maybeApplyCloseIssueProposal';
  if (kind === 'rename') return 'maybeApplyRenameProposal';
  if (kind === 'maintenance_campaign') return 'maybeApplyMaintenanceCampaignProposal';
  return 'maybeApplySecretChangeProposal';
}

// Mirror of the HOURLY sweeper's Pass 0b branch, for the contrast below:
// close_issue rows go through unconditionally so their superseded guard runs.
function hourlySweepAction(gate, kind) {
  if (kind === 'close_issue') return 'maybeApplyCloseIssueProposal';
  return gate.mergeable ? 'apply' : 'skip';
}

const GOV_DEFAULT = { approverPolicy: 'anyone', approvalsRequired: null };

test('a close proposal whose window has elapsed with the threshold met is dispatched', () => {
  // active=2 → majority 2. Two Yes votes, and enough time for the visibility
  // window to have elapsed: exactly the state a proposal is in when its
  // countdown hits zero and nothing else nudges it.
  const gate = mergeGate(2, 2, 0, opened, openedMs + 30 * DAY);
  assert.equal(gate.mergeable, true);
  assert.equal(tickAction(gate, 'close_issue'), 'maybeApplyCloseIssueProposal');
});

test('the same proposal is NOT dispatched while its visibility window is still running', () => {
  // active=20, 6 Yes: the EASED threshold (6) is met but that is short of a
  // clear majority, so the minimum visibility window is still running. The
  // client renders this as a "Merging in ~X" countdown, not a spinner.
  const gate = mergeGate(20, 6, 0, opened, openedMs + MIN);
  assert.equal(gate.thresholdMet, true);
  assert.equal(gate.windowElapsed, false);
  assert.equal(gate.mergeable, false);
  assert.equal(tickAction(gate, 'close_issue'), 'skip',
    'the ticker must not pre-empt the visibility window');
});

test('an under-threshold proposal is never dispatched, however old', () => {
  const gate = mergeGate(20, 0, 0, opened, openedMs + 60 * DAY);
  assert.equal(gate.mergeable, false);
  assert.equal(tickAction(gate, 'close_issue'), 'skip');
  assert.equal(tickAction(gate, 'secret_change'), 'skip');
});

test('a contested proposal is not dispatched (the gate withholds it)', () => {
  // Heavy No against a slim Yes → contested, so no lazy-consensus merge.
  const gate = mergeGate(20, 2, 8, opened, openedMs + 60 * DAY);
  assert.equal(gate.contested, true);
  assert.equal(gate.mergeable, false);
  assert.equal(tickAction(gate, 'close_issue'), 'skip');
});

test('every governance kind routes to its own apply helper once mergeable', () => {
  const gate = mergeGate(2, 2, 0, opened, openedMs + 30 * DAY);
  assert.equal(tickAction(gate, 'close_issue'), 'maybeApplyCloseIssueProposal');
  assert.equal(tickAction(gate, 'rename'), 'maybeApplyRenameProposal');
  assert.equal(tickAction(gate, 'maintenance_campaign'), 'maybeApplyMaintenanceCampaignProposal');
  assert.equal(tickAction(gate, 'secret_change'), 'maybeApplySecretChangeProposal');
});

test('the ticker is gate-first for close_issue where the hourly sweep is not', () => {
  // The whole cost argument for this ticker: an un-mergeable close proposal
  // must NOT reach the apply helper every minute, because its superseded
  // guard makes a GitHub fetch. The hourly pass still sweeps it.
  const notMergeable = mergeGate(20, 0, 0, opened, openedMs + 60 * DAY);
  assert.equal(notMergeable.mergeable, false);
  assert.equal(tickAction(notMergeable, 'close_issue'), 'skip',
    'no per-minute GitHub fetch for rows the gate has not cleared');
  assert.equal(hourlySweepAction(notMergeable, 'close_issue'), 'maybeApplyCloseIssueProposal',
    'the hourly catch-all keeps ownership of the superseded sweep');
});

test('lazy consensus still reaches the ticker once its clock expires', () => {
  // Below threshold but Yes leads with no contest: silence is consent, and
  // the gate arms a lazy window. That path must be dispatched too — it is
  // another way a proposal becomes due with no vote to drive it.
  const armed = mergeGate(20, 1, 0, opened, openedMs + MIN);
  assert.equal(armed.lazyArmed, true);
  assert.equal(armed.mergeable, false, 'not before the lazy window ends');
  assert.equal(tickAction(armed, 'close_issue'), 'skip');

  const expired = mergeGate(20, 1, 0, opened, openedMs + 60 * DAY);
  assert.equal(expired.mergeable, true);
  assert.equal(tickAction(expired, 'close_issue'), 'maybeApplyCloseIssueProposal');
});

test('at-least-N mode: the clock-free gate dispatches on the Nth qualifying Yes', () => {
  // approvals_required short-circuits every clock, so the row is due the
  // instant the count lands — the ticker is what applies it when that count
  // was reached by a vote the apply path already declined (e.g. a crash).
  const short = computeGate({ ...GOV_DEFAULT, approvalsRequired: 2 }, 20, 1, 0, opened);
  assert.equal(short.mergeable, false);
  assert.equal(tickAction(short, 'secret_change'), 'skip');

  const met = computeGate({ ...GOV_DEFAULT, approvalsRequired: 2 }, 20, 2, 0, opened);
  assert.equal(met.mergeable, true);
  assert.equal(met.windowEndsAt, null, 'no countdown exists in this mode');
  assert.equal(tickAction(met, 'secret_change'), 'maybeApplySecretChangeProposal');
});

test('invited-approver mode: only qualifying votes can make a row due', () => {
  const gov = { approverPolicy: 'invited', approvalsRequired: null };
  // One approver in the electorate, zero qualifying Yes — advisory votes from
  // everyone else cannot get this dispatched.
  const advisoryOnly = computeGate(gov, 1, 0, 0, opened, openedMs + 60 * DAY);
  assert.equal(advisoryOnly.mergeable, false);
  assert.equal(tickAction(advisoryOnly, 'close_issue'), 'skip');

  const qualified = computeGate(gov, 1, 1, 0, opened, openedMs + 60 * DAY);
  assert.equal(qualified.mergeable, true);
  assert.equal(tickAction(qualified, 'close_issue'), 'maybeApplyCloseIssueProposal');
});

// config.load() exits the process on a missing required env var, so stand up
// dummy values for REQUIRED + REQUIRED_PROD first — same shim as
// tests/max-apps-cap.test.js, whose comment explains the shape.
function loadConfigWith(tickEnv) {
  const prev = process.env.GOVERNANCE_APPLY_TICK_MS;
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  process.env.JWT_SECRET = 'test-jwt-secret';
  setPlatformKeys();
  if (tickEnv === undefined) delete process.env.GOVERNANCE_APPLY_TICK_MS;
  else process.env.GOVERNANCE_APPLY_TICK_MS = tickEnv;

  const realLog = console.log;
  console.log = () => {};
  try {
    return config.load();
  } finally {
    console.log = realLog;
    if (prev === undefined) delete process.env.GOVERNANCE_APPLY_TICK_MS;
    else process.env.GOVERNANCE_APPLY_TICK_MS = prev;
  }
}

test('config: the ticker has its own interval knob, defaulting to 60s', () => {
  // It must not share the stale-PR sweeper's switch — that sweeper disables
  // itself entirely when both PR_STALE_NOTIFY_MS and ARCHIVED_RETENTION_MS
  // are zero, which would silently take governance applies down with it.
  assert.equal(loadConfigWith(undefined).governanceApplyTickMs, 60000);
  assert.equal(loadConfigWith('15000').governanceApplyTickMs, 15000);
  // 0 disables the ticker (the hourly catch-all still applies proposals).
  assert.equal(loadConfigWith('0').governanceApplyTickMs, 0);
});

test('dapp.json declares GOVERNANCE_APPLY_TICK_MS with a matching default', () => {
  // Platform convention: a new process.env read must be declared in
  // platform_env in the same commit, or nobody can set it from the UI.
  const manifest = require('../dapp.json');
  const entry = (manifest.platform_env || []).find((e) => e.key === 'GOVERNANCE_APPLY_TICK_MS');
  assert.ok(entry, 'GOVERNANCE_APPLY_TICK_MS is declared in platform_env');
  assert.equal(entry.default, '60000', 'manifest default matches the code default');
  assert.ok(!entry.required, 'a tunable with a sane default must not block merges');
  assert.ok(entry.description && entry.description.length > 20, 'has a usable description');
});
