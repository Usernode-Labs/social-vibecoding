'use strict';

// An app's approver roster can be another app's (apps.approvers_from_app_id,
// docs/plans/versions.md): the ready-made originals use the platform's, so
// changing who approves Homeroom changes who approves them. What pins it,
// without a database:
//
//   1. The electorate (rules/electorate.ts getApproverSet) counts the roster
//      the app names, and that roster's full-admin fallback when it is
//      empty; an app that names none keeps its own.
//   2. The approver's No that arms the takedown clock
//      (rules/pr-gate.ts approverNoAtSql) reads the same roster.
//   3. The hub's rule line names that roster's approvers (routes/apps.js).
//   4. A linked app's governance reconcile seeds no approver of its own
//      (tests/app-manifest-governance.test.js runs it); the approvers panel
//      is read only there (tests/approvers-route.test.js).
//
// Run with: node --test tests/approver-roster-link.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getApproverSet, rosterAppId } = require('../src/workflow/rules/electorate.ts');
const { approverNoAtSql } = require('../src/workflow/rules/pr-gate.ts');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// A database with three apps: 1 the platform (its own roster), 8 an original
// that uses the platform's, 9 a project of someone's with a roster of its own.
function db({ platformRoster = [5, 6], admins = [70] } = {}) {
  const rosters = { 1: platformRoster, 8: [], 9: [42] };
  const link = { 1: null, 8: 1, 9: null };
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT approvers_from_app_id FROM apps WHERE id = \$1/.test(sql)) {
        return { rows: params[0] in link ? [{ approvers_from_app_id: link[params[0]] }] : [] };
      }
      if (/SELECT user_id FROM app_approvers WHERE app_id = \$1 AND status = 'member'/.test(sql)) {
        return { rows: (rosters[params[0]] || []).map((id) => ({ user_id: id })) };
      }
      if (/FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE/.test(sql)) {
        return { rows: admins.map((id) => ({ id })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('an app that uses another\'s roster is approved by that roster', async () => {
  assert.deepEqual(await getApproverSet(db(), 8), { ids: [5, 6], adminFallback: false });
  assert.equal(await rosterAppId(db(), 8), 1);
  // Its own roster, empty, is never read in place of it.
  const d = db();
  await getApproverSet(d, 8);
  assert.ok(!d.calls.some((c) => /FROM app_approvers/.test(c.sql) && c.params[0] === 8));
});

test('an empty platform roster falls back to the full admins for its originals too', async () => {
  assert.deepEqual(await getApproverSet(db({ platformRoster: [] }), 8), { ids: [70], adminFallback: true });
});

test('an app that names no roster keeps its own', async () => {
  assert.deepEqual(await getApproverSet(db(), 9), { ids: [42], adminFallback: false });
  assert.deepEqual(await getApproverSet(db(), 1), { ids: [5, 6], adminFallback: false });
  // A row with nothing usable, or no row at all, is the app's own roster.
  assert.equal(await rosterAppId({ query: async () => ({ rows: [] }) }, 77), 77);
  assert.equal(await rosterAppId({ query: async () => ({ rows: [{ approvers_from_app_id: 'x' }] }) }, 77), 77);
});

test('an approver\'s No reads the roster the app uses', () => {
  const sql = approverNoAtSql('cs');
  const rosterReads = sql.match(/ar\.app_id = [^ ]+/g);
  assert.deepEqual(rosterReads, ['ar.app_id = COALESCE(ap.approvers_from_app_id,', 'ar.app_id = COALESCE(ap.approvers_from_app_id,']);
  assert.doesNotMatch(sql, /ar\.app_id = cs\.app_id/);
});

test('the hub\'s rule line names the approvers of the roster the app uses', () => {
  const route = read('src/routes/apps.js');
  assert.match(route, /FROM app_approvers ap\s+JOIN users u ON u\.id = ap\.user_id\s+WHERE ap\.app_id = COALESCE\(\(SELECT a\.approvers_from_app_id FROM apps a WHERE a\.id = \$1\), \$1\)\s+AND ap\.status = 'member'/);
  // The governance reconcile reads the link before it seeds a creator.
  assert.match(read('src/services/app-manifest.js'), /'SELECT created_by, approvers_from_app_id FROM apps WHERE id = \$1'/);
});
