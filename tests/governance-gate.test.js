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

const DAY = 24 * 60 * 60 * 1000;

// ── Pure gates ────────────────────────────────────────────────────────

test('atLeastGate: mergeable exactly at the target, all clocks off', () => {
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
      assert.match(sql, /GROUP BY session_id/);
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
