// Shared per-app visibility gate (collaborator & viewer privacy).
//
// Two access levels, checked against apps.collab_visibility /
// apps.view_visibility + the app_collaborators membership table:
//   'view'   — may see the app exists and use it (home list, App tab).
//   'collab' — may participate in building it (group chat, dev sessions,
//              voting, issues, kudos).
// Rules (see schema.sql for the invariants):
//   - admins always pass (both levels);
//   - a 'public' visibility passes for everyone;
//   - a 'private' visibility requires an app_collaborators row with
//     status='member' (a pending 'invited' row grants nothing).
// Callers respond 404 (not 403) on a null/false result, matching the
// existing self_hosted precedent so private apps aren't enumerable.

const log = require('./logger');

const ACCESS_COLUMNS = 'id, slug, created_by, self_hosted, collab_visibility, view_visibility';

async function isCollaborator(pool, appId, userId) {
  if (!userId || !appId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM app_collaborators WHERE app_id = $1 AND user_id = $2 AND status = 'member'`,
    [appId, userId]
  );
  return rows.length > 0;
}

// `app` must carry id + collab_visibility + view_visibility (SELECT * or
// ACCESS_COLUMNS both work). Returns boolean.
async function checkAppAccess(pool, app, user, level = 'view') {
  if (!app) return false;
  if (user?.isAdmin) return true;
  const vis = level === 'collab' ? app.collab_visibility : app.view_visibility;
  // Legacy rows mid-migration may briefly lack the column; treat as public.
  if (!vis || vis === 'public') return true;
  return isCollaborator(pool, app.id, user?.id);
}

// Resolve an app by slug AND enforce `level` access for `user` in one
// call. Returns the row or null (caller 404s). `columns` defaults to *
// so existing routes keep their full row.
async function getAppForUser(pool, slug, user, level = 'view', columns = '*') {
  const { rows } = await pool.query(`SELECT ${columns} FROM apps WHERE slug = $1`, [slug]);
  if (!rows.length) return null;
  const app = rows[0];
  if (!(await checkAppAccess(pool, app, user, level))) return null;
  return app;
}

// Express middleware factory for routers that address an app through a
// chat-session id (/api/sessions/:id/...). Resolves session → app and
// enforces collab access; 404 on deny so private sessions aren't
// enumerable. A missing session falls through to the route's own lookup
// (which already 404s with its route-specific wording).
function sessionCollabGuard(pool) {
  return async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return next();
    try {
      const { rows } = await pool.query(
        `SELECT a.id, a.collab_visibility, a.view_visibility
           FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.id = $1`,
        [id]
      );
      if (!rows.length) return next();
      if (!(await checkAppAccess(pool, rows[0], req.user, 'collab'))) {
        return res.status(404).json({ error: 'Session not found' });
      }
      return next();
    } catch (err) {
      log.error('app-access', 'session guard failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// Same idea for routers addressing an app through an internal issue id
// (/api/issues/:id/...).
function issueCollabGuard(pool) {
  return async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return next();
    try {
      const { rows } = await pool.query(
        `SELECT a.id, a.collab_visibility, a.view_visibility
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.id = $1`,
        [id]
      );
      if (!rows.length) return next();
      if (!(await checkAppAccess(pool, rows[0], req.user, 'collab'))) {
        return res.status(404).json({ error: 'Issue not found' });
      }
      return next();
    } catch (err) {
      log.error('app-access', 'issue guard failed', { id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// ── WS broadcast filtering support ────────────────────────────────────
//
// broadcastGlobal-style events for a view-private app must only reach
// admins + members. ws.js asks here per event; a 10s in-process TTL
// cache (same pattern as services/limits.js) keeps it one query per app
// per window instead of one per event. Membership/visibility writes call
// invalidateVisibility() so changes propagate immediately.

const VIS_CACHE_TTL_MS = 10_000;
const visCacheById = new Map();   // appId -> { at, viewPrivate, memberIds:Set }
const slugToId = new Map();       // slug -> { at, appId }
const hostVisBySlug = new Map();  // slug -> { at, appId, viewPrivate } (edge gate)

function invalidateVisibility(appId, slug) {
  if (appId != null) visCacheById.delete(Number(appId));
  if (slug) {
    slugToId.delete(slug);
    hostVisBySlug.delete(slug);
  }
  // Slug entries are tiny and TTL-bounded; a stale slug->id mapping is
  // harmless (ids never re-point), so no full sweep needed.
}

async function getWsVisibility(pool, { appId = null, appSlug = null } = {}) {
  const now = Date.now();
  let id = appId != null ? Number(appId) : null;
  if (id == null && appSlug) {
    const hit = slugToId.get(appSlug);
    if (hit && now - hit.at < VIS_CACHE_TTL_MS) {
      id = hit.appId;
    } else {
      const { rows } = await pool.query('SELECT id FROM apps WHERE slug = $1', [appSlug]);
      if (!rows.length) return null;
      id = rows[0].id;
      slugToId.set(appSlug, { at: now, appId: id });
    }
  }
  if (id == null) return null;

  const cached = visCacheById.get(id);
  if (cached && now - cached.at < VIS_CACHE_TTL_MS) return cached;

  const { rows } = await pool.query('SELECT view_visibility FROM apps WHERE id = $1', [id]);
  if (!rows.length) return null;
  const viewPrivate = rows[0].view_visibility === 'private';
  let memberIds = new Set();
  if (viewPrivate) {
    const { rows: members } = await pool.query(
      `SELECT user_id FROM app_collaborators WHERE app_id = $1 AND status = 'member'`,
      [id]
    );
    memberIds = new Set(members.map((r) => r.user_id));
  }
  const entry = { at: now, viewPrivate, memberIds };
  visCacheById.set(id, entry);
  return entry;
}

// ── Edge (subdomain) gate support ─────────────────────────────────────
//
// Caddy forward_auths every *.<domain> request to GET /__caddy/access
// (src/routes/internal.js). These helpers keep that hot path cheap:
// parseAppHost maps a request host to the owning app slug, and
// getHostVisibility answers "is this slug's app view-private?" from a
// 10s TTL cache so the view-public fast path costs ~zero DB work.

const jwt = require('jsonwebtoken');
const { USERNODE_DOMAIN } = require('./caddy');

// Short-lived grant the apex /__access/authorize route (routes/apps.js)
// mints from a real platform session; the edge gate (/__caddy/access in
// routes/internal.js) exchanges it for the per-host scoped access
// cookie. 120s is plenty for one redirect hop.
function mintAccessGrant(jwtSecret, { uid, appId, host }) {
  return jwt.sign({ t: 'app-access-grant', uid, appId, host }, jwtSecret, { expiresIn: 120 });
}

// Map a request host to its app slug. Handles production hosts
// (`<slug>.<domain>`), per-PR staging previews (`<slug>--s<id>.<domain>`,
// plus the legacy `--<hash>` suffix) — staging previews clone prod data,
// so they inherit the prod app's visibility. Returns
// { slug, label } or null for hosts that aren't a routable app subdomain.
function parseAppHost(rawHost) {
  const host = String(rawHost || '').trim().toLowerCase().replace(/:\d+$/, '');
  const suffix = '.' + USERNODE_DOMAIN;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  // Only single-level subdomains are routable (the Caddy wildcard
  // matches one label).
  if (!label || label.includes('.')) return null;
  const staging = label.match(/^([a-z0-9-]+?)--s\d+(?:--[a-z0-9]+)?$/);
  const slug = staging ? staging[1] : label;
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  return { slug, label, host };
}

async function getHostVisibility(pool, slug) {
  const now = Date.now();
  const cached = hostVisBySlug.get(slug);
  if (cached && now - cached.at < VIS_CACHE_TTL_MS) {
    return cached.appId == null ? null : cached;
  }
  const { rows } = await pool.query(
    'SELECT id, view_visibility FROM apps WHERE slug = $1',
    [slug]
  );
  if (!rows.length) {
    // Negative-cache unknown slugs too — probes shouldn't each cost a query.
    hostVisBySlug.set(slug, { at: now, appId: null, viewPrivate: false });
    return null;
  }
  const entry = {
    at: now,
    appId: rows[0].id,
    viewPrivate: rows[0].view_visibility === 'private',
  };
  hostVisBySlug.set(slug, entry);
  return entry;
}

// "May this user view this (view-private) app?" — admins or members.
// Rides the same member-id cache the WS filter uses, so membership
// revocation propagates within the TTL (or instantly via
// invalidateVisibility at the mutation sites).
async function isViewMember(pool, appId, userId) {
  if (!Number.isInteger(userId)) return false;
  const info = await getWsVisibility(pool, { appId });
  if (!info) return false;          // app deleted
  if (!info.viewPrivate) return true; // flipped public since lookup
  if (info.memberIds.has(userId)) return true;
  const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
  return !!rows[0]?.is_admin;
}

module.exports = {
  ACCESS_COLUMNS,
  isCollaborator,
  checkAppAccess,
  getAppForUser,
  sessionCollabGuard,
  issueCollabGuard,
  getWsVisibility,
  invalidateVisibility,
  parseAppHost,
  getHostVisibility,
  isViewMember,
  mintAccessGrant,
};
