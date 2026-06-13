// Tests for the dapp.json `visibility` block (issue #124) — the two
// app visibility statuses (`build` → apps.collab_visibility, `view` →
// apps.view_visibility) parsed leniently by
// src/services/app-manifest.js, plus the deploy-time
// reconcileAppVisibility / applyVisibilityChange pair.
//
// Run with: node --test tests/app-manifest-visibility.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');

function withManifest(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-vis-'));
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

test('valid visibility block passes through', () => {
  withManifest({ secrets: [], visibility: { build: 'private', view: 'public' } }, (m) => {
    assert.deepEqual(m.visibility, { build: 'private', view: 'public' });
  });
  withManifest({ visibility: { build: 'private', view: 'private' } }, (m) => {
    assert.deepEqual(m.visibility, { build: 'private', view: 'private' });
  });
});

test('absent block resolves to null (also: no dapp.json, unparseable dapp.json)', () => {
  withManifest({ secrets: [] }, (m) => assert.equal(m.visibility, null));
  withManifest(null, (m) => assert.equal(m.visibility, null));
  withManifest('{not json', (m) => assert.equal(m.visibility, null));
});

test('partial block: absent axis stays null', () => {
  withManifest({ visibility: { view: 'private' } }, (m) => {
    assert.deepEqual(m.visibility, { build: null, view: 'private' });
  });
  withManifest({ visibility: { build: 'public' } }, (m) => {
    assert.deepEqual(m.visibility, { build: 'public', view: null });
  });
});

test('invalid values drop to null per axis', () => {
  withManifest({ visibility: { build: 'open', view: 'private' } }, (m) => {
    assert.deepEqual(m.visibility, { build: null, view: 'private' });
  });
  for (const bad of [42, true, ['public'], {}, 'PUBLIC']) {
    withManifest({ visibility: { build: bad, view: bad } }, (m) => {
      assert.equal(m.visibility, null, `both-bad ${JSON.stringify(bad)} should resolve to null`);
    });
  }
});

test('non-object block resolves to null', () => {
  withManifest({ visibility: 'private' }, (m) => assert.equal(m.visibility, null));
  withManifest({ visibility: ['private'] }, (m) => assert.equal(m.visibility, null));
  withManifest({ visibility: 7 }, (m) => assert.equal(m.visibility, null));
});

test('describeVisibility matches the platform wording', () => {
  assert.equal(appManifest.describeVisibility('public', 'public'), 'public');
  assert.equal(appManifest.describeVisibility('private', 'public'),
    'invite-only build, public to view');
  assert.equal(appManifest.describeVisibility('private', 'private'),
    'private (collaborators only)');
});

// ── reconcileAppVisibility ────────────────────────────────────────────
//
// Scripted mock pool: answers the fresh app-row SELECT from `appRow`,
// records UPDATEs / invite DELETEs, and returns empty rows for
// everything else (chat insert, event insert, notifications) so the
// best-effort side effects no-op harmlessly.

function mockPool(appRow) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id, slug, self_hosted, collab_visibility, view_visibility FROM apps/.test(sql)) {
        return { rows: appRow ? [appRow] : [] };
      }
      if (/DELETE FROM app_collaborators/.test(sql)) {
        return { rows: [{ user_id: 7 }] };
      }
      return { rows: [] };
    },
  };
}

const updates = (pool) =>
  pool.calls.filter((c) => /UPDATE apps SET collab_visibility/.test(c.sql));

test('reconcile: manifest without visibility is a no-op', async () => {
  const pool = mockPool({ id: 1, slug: 'a', self_hosted: false, collab_visibility: 'public', view_visibility: 'public' });
  assert.equal(await appManifest.reconcileAppVisibility(pool, { id: 1 }, { visibility: null }), false);
  assert.equal(await appManifest.reconcileAppVisibility(pool, { id: 1 }, {}), false);
  assert.equal(await appManifest.reconcileAppVisibility(pool, { id: 1 }, null), false);
  assert.equal(pool.calls.length, 0, 'should not even hit the DB');
});

test('reconcile: equal pair is a no-op', async () => {
  const pool = mockPool({ id: 1, slug: 'a', self_hosted: false, collab_visibility: 'private', view_visibility: 'public' });
  const changed = await appManifest.reconcileAppVisibility(pool, { id: 1 },
    { visibility: { build: 'private', view: 'public' } });
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});

test('reconcile: single-axis change applies, absent axis keeps platform value', async () => {
  const pool = mockPool({ id: 1, slug: 'a', self_hosted: false, collab_visibility: 'private', view_visibility: 'public' });
  const changed = await appManifest.reconcileAppVisibility(pool, { id: 1 },
    { visibility: { build: null, view: 'private' } });
  assert.equal(changed, true);
  const u = updates(pool);
  assert.equal(u.length, 1);
  assert.deepEqual(u[0].params, ['private', 'private', 1]);
});

test('reconcile: full flip to public runs the pending-invite cleanup', async () => {
  const pool = mockPool({ id: 5, slug: 'b', self_hosted: false, collab_visibility: 'private', view_visibility: 'private' });
  const changed = await appManifest.reconcileAppVisibility(pool, { id: 5 },
    { visibility: { build: 'public', view: 'public' } });
  assert.equal(changed, true);
  assert.deepEqual(updates(pool)[0].params, ['public', 'public', 5]);
  const del = pool.calls.find((c) => /DELETE FROM app_collaborators/.test(c.sql));
  assert.ok(del, 'collab private→public must delete pending invites');
  assert.deepEqual(del.params, [5]);
});

test('reconcile: going private does NOT touch invites', async () => {
  const pool = mockPool({ id: 5, slug: 'b', self_hosted: false, collab_visibility: 'public', view_visibility: 'public' });
  const changed = await appManifest.reconcileAppVisibility(pool, { id: 5 },
    { visibility: { build: 'private', view: 'public' } });
  assert.equal(changed, true);
  assert.ok(!pool.calls.some((c) => /DELETE FROM app_collaborators/.test(c.sql)));
});

test('reconcile: invalid resulting combo (build public + view private) is skipped', async () => {
  // Axis-resolved combo: manifest build=public, platform view=private.
  const pool = mockPool({ id: 2, slug: 'c', self_hosted: false, collab_visibility: 'private', view_visibility: 'private' });
  const changed = await appManifest.reconcileAppVisibility(pool, { id: 2 },
    { visibility: { build: 'public', view: null } });
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});

test('reconcile: self-hosted app is skipped', async () => {
  const pool = mockPool({ id: 3, slug: 'platform', self_hosted: true, collab_visibility: 'public', view_visibility: 'public' });
  const changed = await appManifest.reconcileAppVisibility(pool, { id: 3 },
    { visibility: { build: 'private', view: 'private' } });
  assert.equal(changed, false);
  assert.equal(updates(pool).length, 0);
});

test('reconcile: vanished app row is a no-op', async () => {
  const pool = mockPool(null);
  const changed = await appManifest.reconcileAppVisibility(pool, { id: 9 },
    { visibility: { build: 'private', view: 'public' } });
  assert.equal(changed, false);
});
