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
//   2. WHEN A PROPOSAL IS RISKY. detectExplicitApprovalChange diffs
//      the manifest's protected blocks (admins, governance, visibility,
//      platform_env, secrets; services/explicit-approval.js) between
//      the merge base and a proposal's head. A proposal that changes
//      one is flagged chat_sessions.requires_explicit_approval, with the
//      primary block in explicit_approval_reason, which (a) switches
//      off the time-based merge paths for it and (b) adds the member
//      floor: a Yes from someone other than its author whenever the
//      community has more than one member (both in
//      services/governance.js), and (c) withdraws the app-admin
//      force-merge, so none of these changes can land on one person's
//      say-so.

const log = require('./logger');
const explicitApproval = require('./explicit-approval');

// Short in-process TTL cache, mirroring the governance cache in
// services/governance.js: reads happen on every management gate and
// every force-merge check, changes only land on a production deploy
// (and always call invalidateAppAdmins).
const ADMIN_CACHE_TTL_MS = 10 * 1000;
const adminCache = new Map(); // appId -> { at, ids: number[] }

function invalidateAppAdmins(appId) {
  if (appId != null) adminCache.delete(Number(appId));
  else adminCache.clear();
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
// approval: an app admin force-merging a change to the admins, the
// approval rules, who can see the app or its keys would be a unilateral
// decision about exactly what the flag exists to put to another member.
// A full platform admin can still force-merge those.
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

// Parse a raw dapp.json string into its normalized admins list. A
// missing file, unparseable JSON, or an absent/invalid block all
// resolve to [] — matching the deploy reader's leniency, and making
// "no block on either side" a non-change.
function adminsFromManifestSource(raw) {
  return explicitApprovalBlocks(raw).admins;
}

// Parse a raw dapp.json source into a manifest object, or {} for a
// missing file / unparseable JSON / a non-object top level. Every block
// then resolves to its reader's "absent" value, so garbage on one side
// and an empty manifest on the other compare equal.
function parseManifestSource(raw) {
  if (raw == null) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// The five protected blocks of one dapp.json source, each in a canonical
// form so only a change that MEANS something reads as one: through the
// same readers the deploy uses (app-manifest.js), with ordering, casing
// of admin names and documentation-only fields (descriptions, the
// platform_env display group) left out. What stays in is what decides
// power or carries a value: the admin roster, the approval rules, both
// visibility axes, and per variable its key, required, private and its
// defaults.
function explicitApprovalBlocks(raw) {
  // eslint-disable-next-line global-require
  const appManifest = require('./app-manifest');
  const parsed = parseManifestSource(raw);
  const visibility = appManifest.readVisibility(parsed);
  const governance = appManifest.readGovernance(parsed);
  const platformEnv = appManifest.readPlatformEnv(parsed);
  const secrets = appManifest.readSecrets(parsed, { platformEnv });
  return {
    admins: normalizeAdmins(appManifest.readAdmins(parsed) || []),
    governance: governance
      ? { approvers: governance.approvers, approvals: governance.approvals } : null,
    visibility: visibility ? { build: visibility.build, view: visibility.view } : null,
    platform_env: platformEnv
      .map((e) => ({ key: e.key, required: e.required, private: e.private, default: e.default }))
      .sort(byKey),
    secrets: secrets
      .map((e) => ({
        key: e.key, required: e.required, private: e.private,
        default: e.default, staging_default: e.staging_default,
      }))
      .sort(byKey),
  };
}

// Which protected blocks differ between two explicitApprovalBlocks()
// snapshots, in REASONS order (the first is the primary reason).
function changedReasons(from, to) {
  return explicitApproval.REASONS.filter(
    (r) => JSON.stringify(from[r]) !== JSON.stringify(to[r])
  );
}

function pickBlocks(blocks, reasons) {
  const out = {};
  for (const r of reasons) out[r] = blocks[r];
  return out;
}

// Does this proposal's OWN diff change a protected dapp.json block?
// Returns { changed, reasons, reason, from, to, determinate, mergeBaseSha }:
// `reasons` every changed block in services/explicit-approval.js REASONS
// order, `reason` the primary one (what explicit_approval_reason stores),
// and `from` / `to` only the changed blocks, as compared, for the logs.
//
// Three-dot semantics: the head is compared against the MERGE BASE of
// main and the head (the point the branch was cut from), not main's
// current tip. Comparing against a moving main tip mis-flagged any
// proposal whose branch simply predated an admins change that landed
// on main afterwards (the 2648 regression): main gained a name, the
// old branch had none, and the diff read as "removes the admins list".
// Against the merge base, only edits the branch itself made count —
// which still catches every escalation (adding a name → differs
// from base; removing a base name → differs from base), while main
// moving underneath is a non-change (a three-way merge keeps main's
// version; if both sides edited the block the merge conflicts and
// never reaches the gate anyway).
//
// `determinate: false` means we could not look at all (no head ref, no
// GitHub, no parseable repo, no merge base) — which is NOT the same as
// "unchanged". Callers must not overwrite a stored `true` with an
// indeterminate `false`, or a thin session row would silently un-flag
// a proposal and hand back both the merge timers and the app-admin
// force-merge.
//
// A GitHub TRANSPORT failure throws instead, so the caller can pick its
// own fallback explicitly (checkAndMerge keeps the stored column).
async function detectExplicitApprovalChange(app, { headRef } = {}) {
  // eslint-disable-next-line global-require
  const github = require('./github');
  // eslint-disable-next-line global-require
  const appManifest = require('./app-manifest');
  const none = (determinate, mergeBaseSha) => ({
    changed: false, reasons: [], reason: null, from: {}, to: {}, determinate, mergeBaseSha,
  });
  if (!headRef) return none(false, null);
  if (!github.isEnabled()) return none(false, null);
  const [, owner, repo] = (app?.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!owner || !repo) return none(false, null);

  const { mergeBaseSha, files, filesComplete } =
    await github.compareRefs(owner, repo, `main...${headRef}`);
  // No merge base (unrelated histories, vanished ref) — can't attribute
  // a diff to the branch, so keep the stored flag.
  if (!mergeBaseSha) return none(false, null);
  // Common case, one API call total: the proposal doesn't touch the
  // manifest at all. Only trust the file list when it's exhaustive —
  // the compare endpoint caps it, and a capped list missing dapp.json
  // proves nothing.
  if (filesComplete && !files.includes(appManifest.MANIFEST_FILENAME)) {
    return none(true, mergeBaseSha);
  }

  const [baseRaw, headRaw] = await Promise.all([
    github.getFileContent(owner, repo, appManifest.MANIFEST_FILENAME, mergeBaseSha),
    github.getFileContent(owner, repo, appManifest.MANIFEST_FILENAME, headRef),
  ]);
  const fromBlocks = explicitApprovalBlocks(baseRaw);
  const toBlocks = explicitApprovalBlocks(headRaw);
  const reasons = changedReasons(fromBlocks, toBlocks);
  return {
    changed: reasons.length > 0,
    reasons,
    reason: explicitApproval.primaryReason(reasons),
    from: pickBlocks(fromBlocks, reasons),
    to: pickBlocks(toBlocks, reasons),
    determinate: true,
    mergeBaseSha,
  };
}

// Persist the flag and its primary reason on a session row. Best-effort
// at every stamping point except checkAndMerge's authoritative
// re-verify — a failure to record it must never break a promote or a
// push. An unknown reason is stored as NULL rather than invented; every
// surface then says the generic sentence.
async function stampExplicitApproval(pool, sessionId, changed, reason = null) {
  try {
    await pool.query(
      `UPDATE chat_sessions
          SET requires_explicit_approval = $2,
              explicit_approval_reason = $3
        WHERE id = $1`,
      [sessionId, !!changed, changed && explicitApproval.isReason(reason) ? reason : null]
    );
  } catch (err) {
    log.warn('app-admins', 'Explicit-approval stamp failed', { sessionId, err: err.message });
  }
}

// The ref detectExplicitApprovalChange should diff for a given session row: the
// imported-PR head sha for imported proposals, the branch name for
// native ones. Shared by refreshExplicitApproval, checkAndMerge's live
// re-verify, and the sweeper's stale-flag re-check.
function headRefForSession(session) {
  return session?.source === 'imported'
    ? (session.imported_pr_head_sha || session.branch_name || null)
    : (session?.branch_name || null);
}

// Resolve + persist in one call, swallowing GitHub failures: used by
// the promote / head-change / sync-push / sweeper-backfill paths, none
// of which should fail because GitHub hiccupped. Returns the boolean
// actually stamped, or null when it could not be determined (left
// untouched).
async function refreshExplicitApproval(pool, app, session) {
  const headRef = headRefForSession(session);
  try {
    const { changed, reason, determinate } = await detectExplicitApprovalChange(app, { headRef });
    if (!determinate) return null;
    await stampExplicitApproval(pool, session.id, changed, reason);
    return changed;
  } catch (err) {
    log.warn('app-admins', 'Explicit-approval detection failed (leaving flag as-is)', {
      sessionId: session?.id, err: err.message,
    });
    return null;
  }
}

// The stale-PR sweeper's re-verify (server.js Pass 0). Re-detects rows
// whose stored flag is NULL (never classified — the original backfill)
// or TRUE (may have gone stale: main moved, a sync rewrote the branch —
// a below-threshold flagged row never reaches checkAndMerge's live
// re-check, so without this it stays flagged forever). FALSE rows are
// skipped with no GitHub call: they're the bulk of a sweep page, and a
// head change re-stamps them on its own paths — this keeps the
// per-sweep GitHub call count bounded.
//
// Returns the row's effective flag after the sweep (the fresh verdict,
// or the stored value when detection was indeterminate / threw).
// Clearing a stored TRUE is logged with the rosters so a flag flip is
// traceable in the platform logs.
async function sweepExplicitApproval(pool, session) {
  const stored = session?.requires_explicit_approval;
  if (stored === false) return false;
  const wasFlagged = stored === true;
  try {
    const detected = await detectExplicitApprovalChange(session, {
      headRef: headRefForSession(session),
    });
    if (!detected.determinate) return stored ?? null;
    await stampExplicitApproval(pool, session.id, detected.changed, detected.reason);
    if (wasFlagged && !detected.changed) {
      log.info('app-admins', 'Stale explicit-approval flag cleared by sweeper', {
        sessionId: session.id, appId: session.app_id,
        from: detected.from, to: detected.to, mergeBaseSha: detected.mergeBaseSha,
      });
    }
    return detected.changed;
  } catch (err) {
    log.warn('app-admins', 'Explicit-approval re-verify failed (keeping stored flag)', {
      sessionId: session?.id, err: err.message,
    });
    return stored ?? null;
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
  explicitApprovalBlocks,
  detectExplicitApprovalChange,
  headRefForSession,
  stampExplicitApproval,
  refreshExplicitApproval,
  sweepExplicitApproval,
};
