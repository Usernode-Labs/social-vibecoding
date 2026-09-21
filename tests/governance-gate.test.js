// Tests for src/services/governance.js (issue #646) — the governed
// merge gate that layers the two per-app approval settings
// (apps.approver_policy / apps.approvals_required) over the dynamic
// time-&-majority machinery in services/active-users.js.
//
// Covers the three-mode matrix:
//   - anyone + default  → bit-for-bit mergeGate over the raw tallies,
//   - invited + default → mergeGate with the electorate swapped to the
//     approver roster and only approver votes counted,
//   - at-least-N        → clock-free approval-count gate,
// plus the empty-roster full-admin fallback and the TTL cache.
//
// Run with: node --test tests/governance-gate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const governance = require('../src/services/governance');
const { mergeGate } = require('../src/services/active-users');
const activeUsers = require('../src/services/active-users');

const DAY = 24 * 60 * 60 * 1000;

// ── Pure gates ────────────────────────────────────────────────────────

// #2494 renamed this: the MERGE clocks are still all off, but the rejection
// clock is not — it was, and that is why a promoted proposal on an
// at-least-N app could never close itself. With no No votes, as here,
// nothing arms, so every assertion below is unchanged.
test('atLeastGate: mergeable exactly at the target, merge clocks off', () => {
  const below = governance.atLeastGate(2, 1);
  assert.equal(below.required, 2);
  assert.equal(below.mergeable, false);
  assert.equal(below.thresholdMet, false);
  assert.equal(below.windowEndsAt, null);
  assert.equal(below.contested, false);
  assert.equal(below.lazyArmed, false);
  assert.equal(below.rejectionArmed, false);
  assert.equal(below.rejectable, false);

  const at = governance.atLeastGate(2, 2);
  assert.equal(at.mergeable, true);
  assert.equal(at.windowElapsed, true);

  const over = governance.atLeastGate(1, 5);
  assert.equal(over.mergeable, true);
});

// ── #2494: opposition closes an at-least-N proposal ────────────────────
//
// The reported symptom: proposal 3704 sat promoted for eighteen days at
// 2 yes / 2 no with failing checks, still being prebuilt, re-checked and
// re-synced with main on every sweep. `server.js` archives on
// `gate.rejectable`, and atLeastGate could not produce a true one — so no
// promoted proposal on such an app could ever auto-close, however voted.

test('atLeastGate arms a rejection clock when No leads, and fires when it elapses', () => {
  const now = Date.now();
  const opened = (days) => new Date(now - days * DAY).toISOString();

  // One Yes short of the bar, three No: armed, and long past its window.
  const old = governance.atLeastGate(2, 1, 3, opened(18), now);
  assert.equal(old.rejectionArmed, true);
  assert.equal(old.rejectable, true, 'eighteen days is past any window');
  assert.ok(old.rejectionWindowMs > 0);
  assert.ok(old.rejectionEndsAt, 'the pill needs an end time to count down to');

  // Same votes, opened moments ago: armed, but NOT yet rejectable.
  const fresh = governance.atLeastGate(2, 1, 3, opened(0), now);
  assert.equal(fresh.rejectionArmed, true);
  assert.equal(fresh.rejectable, false, 'the window is the point');
  assert.equal(fresh.rejectionWindowMs, old.rejectionWindowMs, 'same votes, same window');
});

test('the arming rule and the curve are the default mode\'s, not a second set', () => {
  // The whole reason this is a small change: it reuses one rule. If these
  // ever diverge, one of them gets tuned and the other quietly does not.
  for (const [yes, no] of [[0, 2], [0, 3], [1, 2], [1, 3], [2, 3], [1, 1], [0, 1]]) {
    assert.equal(
      governance.atLeastGate(99, yes, no, new Date(Date.now() - 400 * DAY), Date.now()).rejectionWindowMs,
      activeUsers.oppositionWindowMs(yes, no),
      `at-least-N diverged from the shared curve at ${yes}y/${no}n`,
    );
  }
  // And that shared curve is what the default mode uses once its own
  // keep-alive has passed — a large electorate keeps that from firing.
  for (const [yes, no] of [[0, 2], [1, 3], [2, 3]]) {
    assert.equal(activeUsers.oppositionWindowMs(yes, no),
      activeUsers.rejectionWindowMs(200, yes, no),
      `the default mode diverged at ${yes}y/${no}n`);
  }
});

test('a tie never arms, so this does NOT close the proposal that was reported', () => {
  // 3704 is 2 yes / 2 no. A tie is a stalemate in both modes — `no <= yes`
  // never arms — and deciding what to do about a proposal nobody rejects
  // and nobody approves is an AGE policy, which is the group's call and is
  // deliberately not made here.
  const tie = governance.atLeastGate(1, 2, 2, new Date(Date.now() - 18 * DAY), Date.now());
  assert.equal(tie.rejectionArmed, false);
  assert.equal(tie.rejectable, false);
  // A lone No cannot close anything either — the min-No floor, shared.
  const lone = governance.atLeastGate(2, 0, 1, new Date(Date.now() - 400 * DAY), Date.now());
  assert.equal(lone.rejectionArmed, false);
});

test('a proposal that already has its approvals is never auto-rejected', () => {
  // The keep-alive, and the one thing that genuinely differs between the
  // modes: the default mode protects a Yes share of ACTIVE users, which
  // at-least-N has no denominator for. Its measure of support is the
  // threshold, and something mergeable must not be closed under it.
  const met = governance.atLeastGate(1, 1, 5, new Date(Date.now() - 400 * DAY), Date.now());
  assert.equal(met.mergeable, true);
  assert.equal(met.rejectionArmed, false, 'it has its approvals; No cannot take them away');
  assert.equal(met.rejectionWindowMs, null);
});

test('an unknown open time stays armed rather than quietly disarming', () => {
  // Failing closed on purpose: reading an absent openedAt as NaN would make
  // `now - opened >= window` false forever, which is the exact shape of the
  // bug this change exists to fix.
  const g = governance.atLeastGate(2, 0, 3, null, Date.now());
  assert.equal(g.rejectionArmed, true);
  assert.equal(g.rejectable, false);
  assert.equal(g.rejectionEndsAt, null, 'and it cannot invent a deadline it does not know');
});

test('a null `now` means now, not the epoch', () => {
  // routes/votes.js calls computeGate with an explicit `null` here to reach
  // the options argument. A default parameter only covers `undefined`, and
  // `new Date(null).getTime()` is 0 — which would date every clock from
  // 1970 and report `rejectable: false` for ever, the same shape as the bug
  // this whole change exists to fix.
  const opened = new Date(Date.now() - 400 * DAY).toISOString();
  const explicitNull = governance.atLeastGate(2, 1, 3, opened, null);
  assert.equal(explicitNull.rejectable, true, 'null must behave as Date.now()');
  assert.deepEqual(
    explicitNull.rejectable,
    governance.atLeastGate(2, 1, 3, opened, Date.now()).rejectable,
  );

  // And through the real entry point, with the argument shape votes.js uses.
  const gov = { approverPolicy: 'invited', approvalsRequired: 2 };
  const viaCompute = governance.computeGate(gov, 9, 1, 3, opened, null, {});
  assert.equal(viaCompute.rejectable, true);
});

test('computeGate carries the votes and the clock through in at_least mode', () => {
  // The gate the sweeper actually reads. Before #2494 this could not
  // report a true `rejectable` at all.
  const gov = { approverPolicy: 'invited', approvalsRequired: 2 };
  const now = Date.now();
  const gate = governance.computeGate(gov, 10, 1, 3, new Date(now - 30 * DAY), now);
  assert.equal(gate.mode, 'at_least');
  assert.equal(gate.rejectable, true);
  assert.equal(gate.qualifiedNo, 3, 'the No count has to reach the gate to matter');
});

test('computeGate: default mode delegates to mergeGate verbatim', () => {
  const gov = { approverPolicy: 'anyone', approvalsRequired: null };
  const now = Date.now();
  const opened = now - 1 * DAY;
  const got = governance.computeGate(gov, 8, 2, 1, opened, now);
  const want = mergeGate(8, 2, 1, opened, now);
  for (const k of Object.keys(want)) {
    assert.deepEqual(got[k], want[k], `field ${k} must match mergeGate`);
  }
  assert.equal(got.mode, 'default');
  assert.equal(got.policy, 'anyone');
  assert.equal(got.qualifiedYes, 2);
  assert.equal(got.qualifiedNo, 1);
  assert.equal(got.activeCount, 8);
});

test('computeGate: at-least mode wins regardless of policy', () => {
  const now = Date.now();
  for (const policy of ['anyone', 'invited']) {
    const gov = { approverPolicy: policy, approvalsRequired: 1 };
    const got = governance.computeGate(gov, 50, 1, 40, now - 10, now);
    assert.equal(got.mode, 'at_least');
    assert.equal(got.required, 1);
    assert.equal(got.mergeable, true, 'one approval merges even with heavy No opposition');
    assert.equal(got.rejectionArmed, false, 'no auto-takedown in at-least mode');
  }
});

// ── governedGate with a scripted pool ─────────────────────────────────
//
// Answers the queries governedGate issues: the governance-columns
// SELECT, the approver-roster SELECT, the full-admin fallback SELECT,
// the qualified-counts FILTER query, and getActiveUserStats's pair
// (getAppMeta + the activity COUNT).

function mockPool({ policy, atLeast, members, admins, votes, activeCount }) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) {
        return { rows: [{ approver_policy: policy, approvals_required: atLeast }] };
      }
      if (/SELECT user_id FROM app_approvers/.test(sql)) {
        return { rows: (members || []).map((id) => ({ user_id: id })) };
      }
      if (/SELECT id FROM users WHERE is_admin = TRUE/.test(sql)) {
        return { rows: (admins || []).map((id) => ({ id })) };
      }
      if (/FILTER \(WHERE vote = /.test(sql)) {
        // Restricted electorate: params = [id, approverIds].
        const allowed = params[1];
        const counted = (votes || []).filter((v) => allowed.includes(v.userId));
        return {
          rows: [{
            yes: String(counted.filter((v) => v.vote === 'yes' || v.vote === 'up').length),
            no: String(counted.filter((v) => v.vote === 'no' || v.vote === 'down').length),
          }],
        };
      }
      if (/SELECT COUNT\(\*\) as cnt FROM (pr_votes|issue_votes)/.test(sql)) {
        // Unrestricted electorate: the legacy per-side COUNT shape.
        const side = /vote = '(yes|up)'/.test(sql) ? ['yes', 'up'] : ['no', 'down'];
        const counted = (votes || []).filter((v) => side.includes(v.vote));
        return { rows: [{ cnt: String(counted.length) }] };
      }
      if (/SELECT self_hosted, collab_visibility FROM apps/.test(sql)) {
        return { rows: [{ self_hosted: false, collab_visibility: 'public' }] };
      }
      if (/COUNT\(DISTINCT a\.user_id\) AS cnt/.test(sql)) {
        return { rows: [{ cnt: String(activeCount || 0) }] };
      }
      return { rows: [] };
    },
  };
}

// Distinct app ids per test: getGovernance caches per appId for 10s.
let nextAppId = 1000;

test('governedGate: anyone + default uses active users and all votes', async () => {
  const appId = nextAppId++;
  const pool = mockPool({
    policy: 'anyone', atLeast: null, activeCount: 4,
    votes: [
      { userId: 1, vote: 'yes' }, { userId: 2, vote: 'yes' },
      { userId: 3, vote: 'yes' }, { userId: 4, vote: 'no' },
    ],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 77, openedAt: Date.now() - 8 * DAY,
  });
  assert.equal(gate.policy, 'anyone');
  assert.equal(gate.mode, 'default');
  assert.equal(gate.activeCount, 4);
  assert.equal(gate.qualifiedYes, 3);
  assert.equal(gate.qualifiedNo, 1);
  // active=4 → majority 3, yes=3 → threshold met, window 0 → mergeable.
  assert.equal(gate.mergeable, true);
});

test('governedGate: invited + default counts only approver votes over the roster', async () => {
  const appId = nextAppId++;
  const pool = mockPool({
    policy: 'invited', atLeast: null, activeCount: 50,
    members: [10, 11],
    votes: [
      // Two community yes votes that must NOT count…
      { userId: 1, vote: 'yes' }, { userId: 2, vote: 'yes' },
      // …and both approvers voting yes: 2/2 = electorate majority.
      { userId: 10, vote: 'yes' }, { userId: 11, vote: 'yes' },
    ],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 78, openedAt: Date.now() - 1000,
  });
  assert.equal(gate.activeCount, 2, 'electorate is the approver roster, not active users');
  assert.equal(gate.qualifiedYes, 2);
  // yes(2) >= majority of 2 (floor(2/2)+1 = 2) → window collapses → mergeable.
  assert.equal(gate.mergeable, true);
});

test('governedGate: invited + default is NOT mergeable on community votes alone', async () => {
  const appId = nextAppId++;
  const pool = mockPool({
    policy: 'invited', atLeast: null, activeCount: 50,
    members: [10, 11],
    votes: [{ userId: 1, vote: 'yes' }, { userId: 2, vote: 'yes' }],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 79, openedAt: Date.now() - 30 * DAY,
  });
  assert.equal(gate.qualifiedYes, 0);
  assert.equal(gate.mergeable, false, 'advisory votes never satisfy the gate');
});

test('governedGate: at-least-1 + invited merges on a single approver vote', async () => {
  const appId = nextAppId++;
  const pool = mockPool({
    policy: 'invited', atLeast: 1, activeCount: 50,
    members: [10, 11],
    votes: [{ userId: 10, vote: 'yes' }, { userId: 3, vote: 'no' }],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 80, openedAt: Date.now(),
  });
  assert.equal(gate.mode, 'at_least');
  assert.equal(gate.required, 1);
  assert.equal(gate.qualifiedYes, 1);
  assert.equal(gate.mergeable, true, 'merges immediately — no window in at-least mode');
  assert.equal(gate.windowEndsAt, null);
});

test('governedGate: empty roster falls back to full admins as the approver set', async () => {
  const appId = nextAppId++;
  const pool = mockPool({
    policy: 'invited', atLeast: 1, activeCount: 50,
    members: [],
    admins: [1],
    votes: [{ userId: 1, vote: 'yes' }, { userId: 2, vote: 'yes' }],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 81, openedAt: Date.now(),
  });
  assert.equal(gate.qualifiedYes, 1, 'only the admin-fallback approver counts');
  assert.equal(gate.mergeable, true);
});

test('governedGate: issue kind counts up/down votes', async () => {
  const appId = nextAppId++;
  const pool = mockPool({
    policy: 'invited', atLeast: 2, activeCount: 50,
    members: [10, 11, 12],
    votes: [
      { userId: 10, vote: 'up' }, { userId: 11, vote: 'up' },
      { userId: 12, vote: 'down' }, { userId: 4, vote: 'up' },
    ],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'issue', id: 900, openedAt: Date.now(),
  });
  assert.equal(gate.qualifiedYes, 2);
  assert.equal(gate.qualifiedNo, 1);
  assert.equal(gate.mergeable, true);
});

test('getGovernance: cached until invalidateGovernance', async () => {
  const appId = nextAppId++;
  let policy = 'anyone';
  const pool = {
    query: async (sql) => {
      if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) {
        return { rows: [{ approver_policy: policy, approvals_required: null }] };
      }
      return { rows: [] };
    },
  };
  const first = await governance.getGovernance(pool, appId);
  assert.equal(first.approverPolicy, 'anyone');
  policy = 'invited';
  const cached = await governance.getGovernance(pool, appId);
  assert.equal(cached.approverPolicy, 'anyone', 'served from cache');
  governance.invalidateGovernance(appId);
  const fresh = await governance.getGovernance(pool, appId);
  assert.equal(fresh.approverPolicy, 'invited', 'invalidate forces a re-read');
});

test('qualifiedCountsBatch: per-id counts restricted to the electorate', async () => {
  const rows = [
    { id: 1, yes: '2', no: '0' },
    { id: 3, yes: '0', no: '1' },
  ];
  const pool = {
    query: async (sql, params) => {
      assert.match(sql, /GROUP BY pv\.session_id/);
      assert.match(sql, /JOIN chat_sessions cs/,
        'PR batch counts resolve each proposal\'s current approval epoch');
      assert.match(sql, /pv\.approval_epoch = cs\.approval_epoch/,
        'superseded approver votes are excluded from batch tallies (#2038)');
      assert.doesNotMatch(sql, /head_sha/,
        'keying a batch tally on the commit loses every vote a rebase touched');
      assert.deepEqual(params[0], [1, 2, 3]);
      assert.deepEqual(params[1], [10, 11]);
      return { rows };
    },
  };
  const map = await governance.qualifiedCountsBatch(pool, 'pr', [1, 2, 3], [10, 11]);
  assert.deepEqual(map.get(1), { yes: 2, no: 0 });
  assert.equal(map.get(2), undefined, 'ids with no electorate votes are absent');
  assert.deepEqual(map.get(3), { yes: 0, no: 1 });
});
