// #1442: the sweeper trigger for proposal freshness (server.js "Pass 9").
//
// The read-path refresh in services/proposal-freshness.js only covers
// proposals somebody has open. The sweeper is what keeps the rest true — and
// its whole job is bounded, ordered, non-duplicating work against a paid API,
// so the properties worth pinning are the ones that stop it becoming a GitHub
// hammer or a leader-follower double-run:
//
//   * it runs only on the leader (started from becomeLeader);
//   * candidates are ordered "main has moved under this row" first, then
//     never-measured, then oldest;
//   * a session mid-turn is skipped, because its head is about to move;
//   * the attempt is stamped BEFORE the work, so a tick landing during a slow
//     GitHub round trip cannot start a second pass on the same row;
//   * the whole pass is bounded per tick and by a cooldown with a floor.
//
// The per-row decision is mirrored here (as tests/rejection-sweeper.test.js
// mirrors the takedown branch) rather than spinning up the sweeper, and the
// structural claims are asserted against server.js's source.
//
// Run with: node --test tests/proposal-freshness-sweeper.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The Pass 9 block, isolated so a match in some other pass cannot pass a
// test here by accident.
const PASS9 = (() => {
  const start = SERVER.indexOf('// Pass 9: proposal freshness (#1442)');
  assert.ok(start > 0, 'Pass 9 exists in server.js');
  const end = SERVER.indexOf('// Pass 7: stale-env preview teardown', start);
  assert.ok(end > start, 'Pass 9 is followed by the next pass');
  return SERVER.slice(start, end);
})();

// ── Mirror of the per-row branch ───────────────────────────────────────

const MAX_PER_SWEEP = 10;

// Returns the ids the sweeper would actually refresh for one tick.
function sweepPlan(rows, {
  attempts = new Map(), inFlight = new Set(), now = 0, cooldownMs = 5 * 60 * 1000,
} = {}) {
  const picked = [];
  for (const row of rows) {
    if (picked.length >= MAX_PER_SWEEP) break;
    if (inFlight.has(row.id)) continue;
    const last = attempts.get(row.id) || 0;
    if (now - last < cooldownMs) continue;
    attempts.set(row.id, now); // stamp before the work
    picked.push(row.id);
  }
  return picked;
}

test('the pass is bounded per tick however many candidates it is handed', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
  const picked = sweepPlan(rows, { now: 1_000_000 });
  assert.equal(picked.length, MAX_PER_SWEEP);
  assert.deepEqual(picked, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    'it takes them in candidate order, so the ORDER BY decides who gets measured');
});

test('a session mid-turn is skipped, and does not consume the budget', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const picked = sweepPlan(rows, { inFlight: new Set([2]), now: 1_000_000 });
  assert.deepEqual(picked, [1, 3]);
});

test('an in-flight session is not stamped, so it is eligible next tick', () => {
  const attempts = new Map();
  const rows = [{ id: 7 }];
  const t0 = 1_000_000;
  assert.deepEqual(sweepPlan(rows, { attempts, inFlight: new Set([7]), now: t0 }), []);
  assert.equal(attempts.has(7), false, 'skipping is not an attempt');
  assert.deepEqual(sweepPlan(rows, { attempts, now: t0 + 1000 }), [7]);
});

test('the cooldown holds a row back until it elapses', () => {
  const attempts = new Map();
  const rows = [{ id: 1 }];
  const cooldownMs = 5 * 60 * 1000;
  const t0 = 1_000_000;
  assert.deepEqual(sweepPlan(rows, { attempts, now: t0, cooldownMs }), [1]);
  assert.deepEqual(sweepPlan(rows, { attempts, now: t0 + 60 * 1000, cooldownMs }), [],
    'a tick a minute later does not re-measure');
  assert.deepEqual(sweepPlan(rows, { attempts, now: t0 + cooldownMs, cooldownMs }), [1]);
});

test('the stamp lands before the work, so an overlapping tick cannot duplicate', () => {
  // Simulate a tick that stamps and then hands off to a slow GitHub call,
  // with a second tick arriving before the first has written anything.
  const attempts = new Map();
  const rows = [{ id: 42 }];
  const t0 = 1_000_000;
  const first = sweepPlan(rows, { attempts, now: t0 });
  assert.deepEqual(first, [42]);
  const second = sweepPlan(rows, { attempts, now: t0 + 30 * 1000 });
  assert.deepEqual(second, [], 'the in-progress row is already stamped');
});

// ── Structural claims about the pass as written ────────────────────────

test('the sweeper is leader-only', () => {
  const leaderAt = SERVER.indexOf('Running leader duties');
  const startAt = SERVER.indexOf('startSessionAutoPauseSweeper(config);');
  const defAt = SERVER.indexOf('function startSessionAutoPauseSweeper(config)');
  assert.ok(leaderAt > 0 && startAt > leaderAt && startAt < defAt,
    'the sweeper that owns Pass 9 is started from becomeLeader, not at boot');
});

test('candidates put a moved main ahead of a merely aged row', () => {
  assert.match(PASS9, /ORDER BY \(a\.main_sha IS NOT NULL AND a\.main_sha IS DISTINCT FROM cs\.freshness_main_sha\) DESC/);
  assert.match(PASS9, /cs\.freshness_checked_at ASC NULLS FIRST/);
  assert.match(PASS9, /LIMIT 50/);
});

test('candidates are promoted proposals that could actually be measured', () => {
  assert.match(PASS9, /cs\.status = 'promoted'/);
  assert.match(PASS9, /a\.repo_url IS NOT NULL/);
  assert.match(PASS9, /cs\.pr_number IS NOT NULL/);
});

test('the pass skips in-flight sessions and stamps before awaiting', () => {
  const skipAt = PASS9.indexOf('worker.isInFlight(session.id)');
  const stampAt = PASS9.indexOf('freshnessRefreshAttempts.set(session.id, Date.now())');
  const workAt = PASS9.indexOf('await freshness.refreshFreshness');
  assert.ok(skipAt > 0 && stampAt > skipAt && workAt > stampAt,
    'skip → stamp → work, in that order');
});

test('the pass forces the refresh, since the TTL is the read path\'s knob', () => {
  assert.match(PASS9, /refreshFreshness\(\{ gh, pool \}, session, \{ force: true \}\)/);
});

test('a failing pass cannot abort the tick', () => {
  assert.match(PASS9, /catch \(err\)[\s\S]*Proposal-freshness sweep failed/);
});

test('the cooldown is env-tunable with a floor that survives a bad value', () => {
  const decl = SERVER.slice(
    SERVER.indexOf('const FRESHNESS_REFRESH_COOLDOWN_MS'),
    SERVER.indexOf('function startSessionAutoPauseSweeper')
  );
  assert.match(decl, /PROPOSAL_FRESHNESS_REFRESH_MS/);
  assert.match(decl, /60 \* 1000/, 'a one-minute floor');

  // Mirror the expression: whatever the env says, the floor holds.
  const resolve = (env) => Math.max(
    parseInt(env || String(5 * 60 * 1000), 10) || (5 * 60 * 1000),
    60 * 1000
  );
  assert.equal(resolve(undefined), 5 * 60 * 1000);
  // 0 and junk both mean "no opinion", so they land on the default rather
  // than on the floor. The floor is what catches a deliberate small value.
  assert.equal(resolve('0'), 5 * 60 * 1000, 'zero cannot turn it into a hammer');
  assert.equal(resolve('nonsense'), 5 * 60 * 1000);
  assert.equal(resolve('1000'), 60 * 1000, 'a one-second setting is floored');
  assert.equal(resolve('-1'), 60 * 1000);
  assert.equal(resolve('900000'), 900000);
});

test('the per-sweep cap is a literal in the pass, not an env knob', () => {
  assert.match(PASS9, /const MAX_FRESHNESS_REFRESH_PER_SWEEP = 10;/);
});
