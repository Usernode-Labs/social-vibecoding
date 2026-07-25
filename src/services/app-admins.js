'use strict';

// Per-app admins (issue #788) — the shared layer between the
// dapp.json-declared `admins` block (reconciled by
// services/app-manifest.js reconcileAppAdmins into the app_admins
// table) and every consumer: the management gates in routes/apps.js,
// routes/collaborators.js and routes/approvers.js, the force-merge
// escape hatches in routes/votes.js and routes/issues.js, and the
// explicit-approval detection that keeps an app admin from quietly
// promoting a friend.
//
// Two ideas live here, deliberately together because they are two
// halves of one rule:
//
//   1. WHO. An app admin is treated as a second app CREATOR for that
//      one app (canManageApp), plus the power to force-merge that
//      app's proposals (canForceMerge). They get nothing on any other
//      app and nothing platform-wide. Full platform admins
//      (canAdminWrite) keep every power on every app regardless of
//      what a manifest says — the platform owner is never demotable by
//      a repo edit.
//
//      Deliberately NOT granted, and left on canAdminWrite alone:
//      reading/writing app secrets, deleting the app, forcing a
//      redeploy, toggling the app lock, and satisfying a locked app's
//      admin-yes requirement (services/admin-approval.js). Letting an
//      app admin satisfy the lock would let them neutralise a
//      platform-imposed lock, which is the opposite of its purpose.
//
//   2. WHEN A PROPOSAL IS SELF-ESCALATING. detectAdminsChange diffs
//      the manifest's admins list between main and a proposal's head.
//      A proposal that changes it is flagged
//      chat_sessions.requires_explicit_approval, which (a) switches
//      off the time-based merge paths for it (see
//      services/governance.js applyNoTimerMerge) and (b) withdraws the
//      app-admin force-merge, so adding an admin always costs real
//      votes.

const log = require('./logger');

// Short in-process TTL cache, mirroring the governance cache in
// services/governance.js: reads happen on every management gate and
// every force-merge check, changes only land on a production deploy
// (and always call invalidateAppAdmins).
const ADMIN_CACHE_TTL_MS = 10 * 1000;
const adminCache = new Map(); // appId -> { at, ids: number[] }

function invalidateAppAdmins(appId) {
  if (appId != null) adminCache.delete(Number(appId));
}

// Resolved app-admin user ids for one app. TTL-cached.
async function getAppAdminIds(pool, appId) {
  const id = Number(appId);
  if (!Number.isFinite(id)) return [];
  const hit = adminCache.get(id);
  if (hit && Date.now() - hit.at < ADMIN_CACHE_TTL_MS) return hit.ids;
  const { rows } = await pool.query(
    'SELECT user_id FROM app_admins WHERE app_id = $1', [id]
  );
  const ids = rows.map((r) => r.user_id);
  adminCache.set(id, { at: Date.now(), ids });
  return ids;
}

async function isAppAdmin(pool, appId, userId) {
  if (!Number.isInteger(userId) || appId == null) return false;
  const ids = await getAppAdminIds(pool, appId);
  return ids.includes(userId);
}

// The single "may this user manage this app?" predicate. Every
// creator-tier gate should call THIS rather than re-deriving the rule,
// so the three-way condition can't drift across call sites.
// `app` must carry `id` and `created_by`.
async function canManageApp(pool, app, user) {
  if (!app || !user) return false;
  if (user.canAdminWrite) return true;
  if (user.id != null && app.created_by === user.id) return true;
  return isAppAdmin(pool, app.id, user.id);
}

// Force-merge eligibility. Full platform admins always; app admins on
// their own app UNLESS the proposal is flagged as needing explicit
// approval — an app admin force-merging an admins change would be
// unilateral self-escalation, which is exactly what the flag exists to
// prevent. A full platform admin can still force-merge those.
async function canForceMerge(pool, app, user, { explicitApproval = false } = {}) {
  if (!user) return false;
  if (user.canAdminWrite) return true;
  if (explicitApproval) return false;
  if (!app) return false;
  return isAppAdmin(pool, app.id, user.id);
}

// Batch lookup for list serializers: the set of app ids this user is an
// app admin of. One query instead of one per row (routes/apps.js
// spreads accessFlags across every app in the home feed).
async function getAdminAppIdsForUser(pool, userId) {
  if (!Number.isInteger(userId)) return new Set();
  const { rows } = await pool.query(
    'SELECT app_id FROM app_admins WHERE user_id = $1', [userId]
  );
  return new Set(rows.map((r) => r.app_id));
}

// ── Explicit-approval detection ───────────────────────────────────────

// Canonical form for storing + diffing an admins list: trimmed,
// lowercased, deduped, sorted. Reordering, recasing or reformatting the
// manifest therefore does NOT read as a change — only real membership
// movement does.
function normalizeAdmins(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim().toLowerCase();
    if (name) seen.add(name);
  }
  return [...seen].sort();
}

function sameAdmins(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Parse a raw dapp.json string into its normalized admins list. A
// missing file, unparseable JSON, or an absent/invalid block all
// resolve to [] — matching the deploy reader's leniency, and making
// "no block on either side" a non-change.
function adminsFromManifestSource(raw) {
  if (raw == null) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  // eslint-disable-next-line global-require
  const appManifest = require('./app-manifest');
  return normalizeAdmins(appManifest.readAdmins(parsed) || []);
}

// Does this proposal's head change the declared admins list relative to
// main? Returns { changed, from, to, determinate }.
//
// `determinate: false` means we could not look at all (no head ref, no
// GitHub, no parseable repo) — which is NOT the same as "unchanged".
// Callers must not overwrite a stored `true` with an indeterminate
// `false`, or a thin session row would silently un-flag a proposal and
// hand back both the merge timers and the app-admin force-merge.
//
// A GitHub TRANSPORT failure throws instead, so the caller can pick its
// own fallback explicitly (checkAndMerge keeps the stored column).
async function detectAdminsChange(app, { headRef } = {}) {
  // eslint-disable-next-line global-require
  const github = require('./github');
  // eslint-disable-next-line global-require
  const appManifest = require('./app-manifest');
  const unknown = { changed: false, from: [], to: [], determinate: false };
  if (!headRef) return unknown;
  if (!github.isEnabled()) return unknown;
  const [, owner, repo] = (app?.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!owner || !repo) return unknown;

  const [baseRaw, headRaw] = await Promise.all([
    github.getFileContent(owner, repo, appManifest.MANIFEST_FILENAME, 'main'),
    github.getFileContent(owner, repo, appManifest.MANIFEST_FILENAME, headRef),
  ]);
  const from = adminsFromManifestSource(baseRaw);
  const to = adminsFromManifestSource(headRaw);
  return { changed: !sameAdmins(from, to), from, to, determinate: true };
}

// Persist the flag on a session row. Best-effort at every stamping
// point except checkAndMerge's authoritative re-verify — a failure to
// record it must never break a promote or a push.
async function stampExplicitApproval(pool, sessionId, changed) {
  try {
    await pool.query(
      `UPDATE chat_sessions
          SET requires_explicit_approval = $2,
              explicit_approval_reason = $3
        WHERE id = $1`,
      [sessionId, !!changed, changed ? 'admins' : null]
    );
  } catch (err) {
    log.warn('app-admins', 'Explicit-approval stamp failed', { sessionId, err: err.message });
  }
}

// Resolve + persist in one call, swallowing GitHub failures: used by
// the promote / head-change / sweeper-backfill paths, none of which
// should fail because GitHub hiccupped. Returns the boolean actually
// stamped, or null when it could not be determined (left untouched).
async function refreshExplicitApproval(pool, app, session) {
  const headRef = session?.source === 'imported'
    ? (session.imported_pr_head_sha || session.branch_name || null)
    : (session?.branch_name || null);
  try {
    const { changed, determinate } = await detectAdminsChange(app, { headRef });
    if (!determinate) return null;
    await stampExplicitApproval(pool, session.id, changed);
    return changed;
  } catch (err) {
    log.warn('app-admins', 'Explicit-approval detection failed (leaving flag as-is)', {
      sessionId: session?.id, err: err.message,
    });
    return null;
  }
}

module.exports = {
  invalidateAppAdmins,
  getAppAdminIds,
  isAppAdmin,
  canManageApp,
  canForceMerge,
  getAdminAppIdsForUser,
  normalizeAdmins,
  adminsFromManifestSource,
  detectAdminsChange,
  stampExplicitApproval,
  refreshExplicitApproval,
};
