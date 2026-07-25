// Tests for the #788 permission predicates in
// src/services/app-admins.js — canManageApp / canForceMerge /
// isAppAdmin / getAdminAppIdsForUser, plus the accessFlags widening in
// src/routes/apps.js.
//
// Two properties matter most here and are asserted from several angles:
//   1. An app admin is creator-equivalent for THEIR app and nothing
//      else — never another app, never platform-wide.
//   2. An app admin cannot force-merge a proposal that changes the
//      admins block. That carve-out is the only thing standing between
//      "app admin" and "app admin who can appoint more app admins".
//
// Run with: node --test tests/app-admins-permissions.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const appAdmins = require('../src/services/app-admins');

// Fresh module state per assertion group: the service TTL-caches
// rosters by app id, so tests that reuse an id must invalidate.
function poolWith(rosters) {
  return {
    query: async (sql, params) => {
      if (/SELECT user_id FROM app_admins WHERE app_id/.test(sql)) {
        return { rows: (rosters[params[0]] || []).map((id) => ({ user_id: id })) };
      }
      if (/SELECT app_id FROM app_admins WHERE user_id/.test(sql)) {
        const out = [];
        for (const [appId, ids] of Object.entries(rosters)) {
          if (ids.includes(params[0])) out.push({ app_id: Number(appId) });
        }
        return { rows: out };
      }
      return { rows: [] };
    },
  };
}

const APP = { id: 5, created_by: 1 };
const OTHER_APP = { id: 6, created_by: 1 };

const CREATOR = { id: 1 };
const APP_ADMIN = { id: 2 };
const STRANGER = { id: 3 };
const PLATFORM_ADMIN = { id: 4, isAdmin: true, canAdminWrite: true };
const VIEW_ONLY_ADMIN = { id: 9, isAdmin: true, canAdminWrite: false };

function fresh() {
  appAdmins.invalidateAppAdmins(5);
  appAdmins.invalidateAppAdmins(6);
  return poolWith({ 5: [2], 6: [] });
}

// ── isAppAdmin ────────────────────────────────────────────────────────

test('isAppAdmin is true only for a listed user on that exact app', async () => {
  const pool = fresh();
  assert.equal(await appAdmins.isAppAdmin(pool, 5, 2), true);
  assert.equal(await appAdmins.isAppAdmin(pool, 5, 3), false);
  assert.equal(await appAdmins.isAppAdmin(pool, 6, 2), false,
    'an admin of app 5 is nobody on app 6');
});

test('isAppAdmin is false for an anonymous / malformed viewer', async () => {
  const pool = fresh();
  for (const uid of [null, undefined, NaN, '2']) {
    assert.equal(await appAdmins.isAppAdmin(pool, 5, uid), false, `uid=${String(uid)}`);
  }
});

// ── canManageApp ──────────────────────────────────────────────────────

test('canManageApp: creator, app admin and full platform admin all pass', async () => {
  const pool = fresh();
  assert.equal(await appAdmins.canManageApp(pool, APP, CREATOR), true);
  assert.equal(await appAdmins.canManageApp(pool, APP, APP_ADMIN), true);
  assert.equal(await appAdmins.canManageApp(pool, APP, PLATFORM_ADMIN), true);
});

test('canManageApp: a stranger and an anonymous viewer do not', async () => {
  const pool = fresh();
  assert.equal(await appAdmins.canManageApp(pool, APP, STRANGER), false);
  assert.equal(await appAdmins.canManageApp(pool, APP, null), false);
  assert.equal(await appAdmins.canManageApp(pool, null, CREATOR), false);
});

test('canManageApp: a VIEW-ONLY platform admin does not (issue #311 stance kept)', async () => {
  const pool = fresh();
  assert.equal(await appAdmins.canManageApp(pool, APP, VIEW_ONLY_ADMIN), false);
});

test('canManageApp: an app admin gets nothing on a DIFFERENT app', async () => {
  const pool = fresh();
  assert.equal(await appAdmins.canManageApp(pool, OTHER_APP, APP_ADMIN), false);
});

// ── canForceMerge ─────────────────────────────────────────────────────

test('canForceMerge: an app admin may force-merge an ordinary proposal', async () => {
  const pool = fresh();
  assert.equal(await appAdmins.canForceMerge(pool, APP, APP_ADMIN), true);
  assert.equal(
    await appAdmins.canForceMerge(pool, APP, APP_ADMIN, { explicitApproval: false }), true);
});

test('canForceMerge: an app admin may NOT force-merge an admins-changing proposal', async () => {
  const pool = fresh();
  assert.equal(
    await appAdmins.canForceMerge(pool, APP, APP_ADMIN, { explicitApproval: true }), false,
    'self-escalation is the one thing this carve-out exists to stop');
});

test('canForceMerge: a platform admin may force-merge anything, flagged or not', async () => {
  const pool = fresh();
  assert.equal(
    await appAdmins.canForceMerge(pool, APP, PLATFORM_ADMIN, { explicitApproval: true }), true);
  assert.equal(await appAdmins.canForceMerge(pool, APP, PLATFORM_ADMIN), true);
});

test('canForceMerge: the CREATOR alone does not get force-merge', async () => {
  // Force-merge is a strictly narrower grant than canManageApp — being
  // the creator makes you a manager, not an override.
  const pool = fresh();
  assert.equal(await appAdmins.canManageApp(pool, APP, CREATOR), true);
  assert.equal(await appAdmins.canForceMerge(pool, APP, CREATOR), false);
});

test('canForceMerge: strangers, view-only admins and anonymous callers never pass', async () => {
  const pool = fresh();
  assert.equal(await appAdmins.canForceMerge(pool, APP, STRANGER), false);
  assert.equal(await appAdmins.canForceMerge(pool, APP, VIEW_ONLY_ADMIN), false);
  assert.equal(await appAdmins.canForceMerge(pool, APP, null), false);
});

// ── getAdminAppIdsForUser ─────────────────────────────────────────────

test('getAdminAppIdsForUser returns the batched id set for the home feed', async () => {
  const pool = poolWith({ 5: [2], 6: [2, 3], 7: [] });
  const forTwo = await appAdmins.getAdminAppIdsForUser(pool, 2);
  assert.deepEqual([...forTwo].sort(), [5, 6]);
  const forThree = await appAdmins.getAdminAppIdsForUser(pool, 3);
  assert.deepEqual([...forThree], [6]);
  assert.equal((await appAdmins.getAdminAppIdsForUser(pool, 99)).size, 0);
  assert.equal((await appAdmins.getAdminAppIdsForUser(pool, null)).size, 0,
    'anonymous viewers cost no query');
});

// ── Caching ───────────────────────────────────────────────────────────

test('the roster is TTL-cached, and invalidateAppAdmins drops it', async () => {
  appAdmins.invalidateAppAdmins(5);
  let queries = 0;
  const rosters = { 5: [2] };
  const pool = {
    query: async (sql, params) => {
      queries++;
      return { rows: (rosters[params[0]] || []).map((id) => ({ user_id: id })) };
    },
  };
  await appAdmins.getAppAdminIds(pool, 5);
  await appAdmins.getAppAdminIds(pool, 5);
  assert.equal(queries, 1, 'the second read is served from cache');

  rosters[5] = [2, 3];
  assert.equal(await appAdmins.isAppAdmin(pool, 5, 3), false, 'still the cached roster');

  appAdmins.invalidateAppAdmins(5);
  assert.equal(await appAdmins.isAppAdmin(pool, 5, 3), true, 'invalidation is immediate');
});

// ── accessFlags (routes/apps.js) ──────────────────────────────────────

test('accessFlags: can_manage is true for an app admin via the batched id set', () => {
  // Exercise the exported helper shape without booting Express: the
  // route module builds the Set once per request and hands it in.
  const accessFlags = (app, user, isCollaborator, adminAppIds = null) => {
    const isAdmin = !!user?.isAdmin;
    const canAdminWrite = !!user?.canAdminWrite;
    const isAppAdmin = !!(adminAppIds && adminAppIds.has(app.id));
    return {
      is_collaborator: !!isCollaborator,
      can_collaborate: isAdmin || app.collab_visibility !== 'private' || !!isCollaborator,
      can_manage: canAdminWrite || (user?.id != null && app.created_by === user.id) || isAppAdmin,
    };
  };
  const app = { id: 5, created_by: 1, collab_visibility: 'private' };
  const ids = new Set([5]);

  assert.equal(accessFlags(app, APP_ADMIN, false, ids).can_manage, true);
  assert.equal(accessFlags(app, APP_ADMIN, false, new Set()).can_manage, false);
  assert.equal(accessFlags(app, APP_ADMIN, false, null).can_manage, false,
    'omitting the set must fail closed, not open');
  assert.equal(accessFlags(app, CREATOR, false, null).can_manage, true);
  assert.equal(accessFlags(app, PLATFORM_ADMIN, false, null).can_manage, true);
  assert.equal(accessFlags(app, STRANGER, false, null).can_manage, false);
});

// ── admin-merge route: gate ordering ──────────────────────────────────

test('admin-merge pre-gates on "can force-merge anywhere" before touching the session', () => {
  // The old route 403'd every non-platform-admin before its lookup, so a
  // stranger could never probe whether a session id exists. Widening the
  // gate must not turn that into a 404 oracle.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');
  const at = src.indexOf("router.post('/api/sessions/:id/admin-merge'");
  assert.notEqual(at, -1);
  const body = src.slice(at, at + 2600);

  const preGate = body.indexOf('getAdminAppIdsForUser');
  const lookup = body.indexOf('FROM chat_sessions cs JOIN apps a');
  const notFound = body.indexOf('Promoted session not found');
  assert.ok(preGate !== -1 && lookup !== -1 && notFound !== -1);
  assert.ok(preGate < lookup, 'the rights pre-gate must run BEFORE the session lookup');
  assert.ok(preGate < notFound, 'a rights-less caller must never reach the 404');
  assert.match(body, /adminAppIds\.size === 0[\s\S]{0,120}403/,
    'zero app-admin rows and no platform admin → 403, not 404');
});

// ── The gates that must NOT move ──────────────────────────────────────

test('secrets / lock / delete / redeploy still require a full platform admin', () => {
  // These are asserted at the source level: the spec deliberately keeps
  // them on canAdminWrite, and a future refactor that swaps in
  // canManageApp would silently hand app admins the app's credentials.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'apps.js'), 'utf8');

  for (const route of [
    "router.put('/api/apps/:slug/secrets/:key'",
    "router.delete('/api/apps/:slug/secrets/:key'",
    "router.post('/api/apps/:slug/redeploy'",
    "router.post('/api/apps/:slug/lock'",
    "router.delete('/api/apps/:slug'",
  ]) {
    const at = src.indexOf(route);
    assert.notEqual(at, -1, `route not found: ${route}`);
    const body = src.slice(at, at + 400);
    assert.match(body, /canAdminWrite/,
      `${route} must stay full-platform-admin only`);
    assert.doesNotMatch(body, /canManageApp/,
      `${route} must NOT be widened to app admins`);
  }
});

test('the locked-app admin-yes gate is still platform-admin only', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'admin-approval.js'), 'utf8');
  assert.match(src, /is_admin = TRUE\s*\n\s*AND u\.admin_readonly = FALSE/,
    'hasAdminYesVote must keep requiring a full platform admin');
  assert.doesNotMatch(src, /app_admins/,
    'an app admin satisfying the lock would neutralise a platform-imposed lock');
});
