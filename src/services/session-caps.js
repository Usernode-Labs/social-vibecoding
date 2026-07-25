'use strict';

// Per-user concurrency caps for dev sessions and open proposals, resolved
// per REQUESTER rather than read straight off config.
//
// Two tiers:
//   base  — every ordinary user: config.maxUserSessions /
//           config.maxUserPromotedSessions (3 / 5 by default).
//   admin — FULL platform admins only: config.maxAdminUserSessions /
//           config.maxAdminUserPromotedSessions (5 / 8 by default).
//
// The admin tier is gated SOLELY on `user.canAdminWrite` — the same gate
// the app-quota bypass (routes/apps.js) and the rate-limiter
// `exemptAdmins` skip use. Deliberately NOT `isAdmin`: view-only admins
// (#311) stay on the base caps like any regular user, because holding
// extra warm workers / staging previews is an elevated capability, not a
// visibility one. Per-app admins (services/app-admins.js) are also
// untouched — that role is scoped to one app and grants nothing
// platform-wide, so it can't move a platform-wide session budget.
//
// Note this is a RAISED CAP, not a bypass: admins are still bounded, and
// the platform-wide ceiling (config.maxGlobalSessions) applies to
// everyone including full admins. The resource being protected is host
// memory, not a policy privilege.
//
// Deliberately dependency-free (no pool, no requires) so every call site
// can resolve caps synchronously from the request it already has, and so
// the rule is unit-testable in isolation.

// Fallbacks for a partial/absent config. Route tests mount routers with
// `sessionRoutes({})`, and the caps ride the /api/me/active-sessions
// payload — `undefined` there would render as an "N/undefined" counter.
const DEFAULT_USER_SESSIONS = 3;
const DEFAULT_USER_PROMOTED = 5;
const DEFAULT_ADMIN_SESSIONS = 5;
const DEFAULT_ADMIN_PROMOTED = 8;

function positiveIntOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// { activeSessions, promotedSessions } for this requester. `user` may be
// undefined (unauthenticated / internal callers) — that resolves to the
// base tier.
function effectiveSessionCaps(config, user) {
  const cfg = config || {};
  const isFullAdmin = !!(user && user.canAdminWrite);
  if (isFullAdmin) {
    return {
      activeSessions: positiveIntOr(cfg.maxAdminUserSessions, DEFAULT_ADMIN_SESSIONS),
      promotedSessions: positiveIntOr(cfg.maxAdminUserPromotedSessions, DEFAULT_ADMIN_PROMOTED),
    };
  }
  return {
    activeSessions: positiveIntOr(cfg.maxUserSessions, DEFAULT_USER_SESSIONS),
    promotedSessions: positiveIntOr(cfg.maxUserPromotedSessions, DEFAULT_USER_PROMOTED),
  };
}

module.exports = {
  effectiveSessionCaps,
  DEFAULT_USER_SESSIONS,
  DEFAULT_USER_PROMOTED,
  DEFAULT_ADMIN_SESSIONS,
  DEFAULT_ADMIN_PROMOTED,
};
