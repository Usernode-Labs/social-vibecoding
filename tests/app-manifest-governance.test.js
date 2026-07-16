// Tests for the dapp.json `governance` block (issue #646) — the two
// proposal-approval settings (`approvers` → apps.approver_policy,
// `approvals` → apps.approvals_required) parsed leniently by
// src/services/app-manifest.js, plus the deploy-time
// reconcileAppGovernance / applyGovernanceChange pair. Mirrors
// tests/app-manifest-visibility.test.js.
//
// Run with: node --test tests/app-manifest-governance.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-gov-'));
  try {
    if (content != null) {
      fs.writeFileSync(path.join(dir, 'dapp.json'),
        typeof content === 'string' ? content : JSON.stringify(content));
    }
    return fn(appManifest.read(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Parsing matrix ────────────────────────────────────────────────────

test('valid governance block passes through', () => {
  withManifest({ secrets: [], governance: { approvers: 'invited', approvals: { atLeast: 1 } } }, (m) => {
    assert.deepEqual(m.governance, { approvers: 'invited', approvals: 1 });
  });
  withManifest({ governance: { approvers: 'anyone', approvals: 'default' } }, (m) => {
    assert.deepEqual(m.governance, { approvers: 'anyone', approvals: 'default' });
  });
});

test('absent block resolves to null (also: no dapp.json, unparseable dapp.json)', () => {
  withManifest({ secrets: [] }, (m) => assert.equal(m.governance, null));
  withManifest(null, (m) => assert.equal(m.governance, null));
  withManifest('{not json', (m) => assert.equal(m.governance, null));
});

test('partial block: absent axis stays null', () => {
  withManifest({ governance: { approvers: 'invited' } }, (m) => {
    assert.deepEqual(m.governance, { approvers: 'invited', approvals: null });
  });
  withManifest({ governance: { approvals: { atLeast: 3 } } }, (m) => {
    assert.deepEqual(m.governance, { approvers: null, approvals: 3 });
  });
});

test('invalid values drop to null per axis', () => {
  withManifest({ governance: { approvers: 'everyone', approvals: { atLeast: 2 } } }, (m) => {
    assert.deepEqual(m.governance, { approvers: null, approvals: 2 });
  });
  // atLeast out of bounds / non-integer / wrong shape drops the axis.
  for (const bad of [0, -1, 51, 1.5, '2', { atMost: 2 }, [2], true]) {
    withManifest({ governance: { approvers: 'invited', approvals: typeof bad === 'object' && !Array.isArray(bad) ? bad : { atLeast: bad } } }, (m) => {
      assert.deepEqual(m.governance, { approvers: 'invited', approvals: null },
        `bad approvals ${JSON.stringify(bad)} should drop`);
    });
  }
  withManifest({ governance: { approvers: 42, approvals: 'weekly' } }, (m) => {
    assert.equal(m.governance, null, 'both-bad resolves to null');
  });
});

test('non-object block resolves to null', () => {
  withManifest({ governance: 'invited' }, (m) => assert.equal(m.governance, null));
  withManifest({ governance: ['invited'] }, (m) => assert.equal(m.governance, null));
  withManifest({ governance: 7 }, (m) => assert.equal(m.governance, null));
});

test('describeGovernance matches the platform wording', () => {
  assert.equal(appManifest.describeGovernance('anyone', null),
    'approvals by any user, requiring the default time-&-majority vote');
  assert.equal(appManifest.describeGovernance('invited', 1),
    'approvals by invited approvers, requiring at least 1 approval');
  assert.equal(appManifest.describeGovernance('invited', 3),
    'approvals by invited approvers, requiring at least 3 approvals');
});

// ── reconcileAppGovernance ────────────────────────────────────────────
//
// Scripted mock pool: answers the fresh app-row SELECT from `appRow`,
// records UPDATEs / approver-invite DELETEs / creator auto-seed
// INSERTs, and returns empty rows for everything else (chat insert,
// event insert, notifications) so best-effort side effects no-op.

function mockPool(appRow, { members = [], createdBy = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id, slug, approver_policy, approvals_required FROM apps/.test(sql)) {
        return { rows: appRow ? [appRow] : [] };
      }
      if (/DELETE FROM app_approvers WHERE app_id = \$1 AND status = 'invited'/.test(sql)) {
        return { rows: [{ user_id: 7 }] };
      }
      if (/SELECT 1 FROM app_approvers WHERE app_id = \$1 AND status = 'member'/.test(sql)) {
        return { rows: members };
      }
      if (/SELECT created_by FROM apps/.test(sql)) {
        return { rows: [{ created_by: createdBy }] };
      }
      return { rows: [] };
    },
  };
}

const updates = (pool) =>
  pool.calls.filter((c) => /UPDATE apps SET approver_policy/.test(c.sql));

test('reconcile: manifest without governance is a no-op', async () => {
  const pool = mockPool({ id: 1, slug: 'a', approver_policy: 'anyone', approvals_required: null });
  assert.equal(await appManifest.reconcileAppGovernance(pool, { id: 1 }, { governance: null }), false);
  assert.equal(await appManifest.reconcileAppGovernance(pool, { id: 1 }, {}), false);
  assert.equal(await appManifest.reconcileAppGovernance(pool, { id: 1 }, null), false);
  assert.equal(pool.calls.length, 0, 'should not even hit the DB');
});

test('reconcile: equal settings are a no-op', async () => {
  const pool = mockPool({ id: 1, slug: 'a', approver_policy: 'invited', approvals_required: 1 });
  const changed = await appManifest.reconcileAppGovernance(pool, { id: 1 },
    { governance: { approvers: 'invited', approvals: 1 } });
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});

test('reconcile: single-axis change applies, absent axis keeps platform value', async () => {
  const pool = mockPool({ id: 1, slug: 'a', approver_policy: 'anyone', approvals_required: 2 },
    { members: [{ 1: 1 }] });
  const changed = await appManifest.reconcileAppGovernance(pool, { id: 1 },
    { governance: { approvers: 'invited', approvals: null } });
  assert.equal(changed, true);
  const u = updates(pool);
  assert.equal(u.length, 1);
  assert.deepEqual(u[0].params, ['invited', 2, 1]);
});

test('reconcile: approvals "default" clears the at-least column', async () => {
  const pool = mockPool({ id: 4, slug: 'd', approver_policy: 'anyone', approvals_required: 3 });
  const changed = await appManifest.reconcileAppGovernance(pool, { id: 4 },
    { governance: { approvers: null, approvals: 'default' } });
  assert.equal(changed, true);
  assert.deepEqual(updates(pool)[0].params, ['anyone', null, 4]);
});

test('reconcile: invited → anyone deletes pending approver invites only', async () => {
  const pool = mockPool({ id: 5, slug: 'b', approver_policy: 'invited', approvals_required: 1 });
  const changed = await appManifest.reconcileAppGovernance(pool, { id: 5 },
    { governance: { approvers: 'anyone', approvals: 'default' } });
  assert.equal(changed, true);
  const del = pool.calls.find((c) => /DELETE FROM app_approvers/.test(c.sql));
  assert.ok(del, 'invited→anyone must delete pending approver invites');
  assert.deepEqual(del.params, [5]);
});

test('reconcile: → invited with an empty roster auto-seeds the creator', async () => {
  const pool = mockPool({ id: 6, slug: 'c', approver_policy: 'anyone', approvals_required: null },
    { members: [], createdBy: 42 });
  const changed = await appManifest.reconcileAppGovernance(pool, { id: 6 },
    { governance: { approvers: 'invited', approvals: null } });
  assert.equal(changed, true);
  const seed = pool.calls.find((c) => /INSERT INTO app_approvers/.test(c.sql));
  assert.ok(seed, 'empty roster must seed the creator');
  assert.equal(seed.params[0], 6);
  assert.equal(seed.params[1], 42);
});

test('reconcile: → invited with no creator (self-app) seeds nothing', async () => {
  const pool = mockPool({ id: 7, slug: 'platform', approver_policy: 'anyone', approvals_required: null },
    { members: [], createdBy: null });
  const changed = await appManifest.reconcileAppGovernance(pool, { id: 7 },
    { governance: { approvers: 'invited', approvals: 1 } });
  assert.equal(changed, true);
  assert.ok(!pool.calls.some((c) => /INSERT INTO app_approvers/.test(c.sql)));
});

test('reconcile: self-hosted apps are NOT skipped (unlike visibility)', async () => {
  // The row SELECT deliberately omits self_hosted — the reconcile
  // applies to every app, the platform's own row included.
  const pool = mockPool({ id: 10, slug: 'platform', approver_policy: 'anyone', approvals_required: null },
    { members: [{ 1: 1 }] });
  const changed = await appManifest.reconcileAppGovernance(pool, { id: 10 },
    { governance: { approvers: 'invited', approvals: 1 } });
  assert.equal(changed, true);
  assert.deepEqual(updates(pool)[0].params, ['invited', 1, 10]);
});

test('reconcile: vanished app row is a no-op', async () => {
  const pool = mockPool(null);
  const changed = await appManifest.reconcileAppGovernance(pool, { id: 9 },
    { governance: { approvers: 'invited', approvals: 1 } });
  assert.equal(changed, false);
});
