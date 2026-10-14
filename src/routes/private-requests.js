// Private requests (#5048): requests only platform admins can see.
//
// Every other request is a GitHub issue, and the platform's repository is
// public, so a request that has to stay confidential (a security problem,
// a partner's plans) cannot be one. These live in Homeroom alone: the
// `private_requests` and `private_request_comments` tables, which are
// staging:private, and nowhere else. No GitHub issue, no chat thread (a
// thread is read by every viewer of the app), no board feed entry, no
// Homeroom bot build (it works on a public branch).
//
// Every route answers 404 to anyone who is not a platform admin, the same
// answer an id that does not exist gets, so a non-admin cannot even learn
// that one exists. Reading takes `isAdmin`; filing, commenting, closing and
// reopening take `canAdminWrite`, as the rest of the admin surface does.
//
// Every write answers only the Homeroom page itself
// (middleware/same-site-browser.js), as the /api/admin writes do: close and
// reopen need no body, so a page on a child app's subdomain (the same site,
// so the Lax session cookie rides along) could otherwise send one for a
// signed-in admin. The routes live outside /api/admin, so that prefix's
// guard does not reach them.

const { Router } = require('express');
const log = require('../services/logger');
const { getPool } = require('../db/pool');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20000;
const COMMENT_MAX = 8000;
// A title made from the description is cut here, on a word when it can be.
const DERIVED_TITLE_MAX = 80;
const ID_RE = /^[1-9][0-9]{0,9}$/;

const SELF_APP_SQL = `
  SELECT id, slug, name FROM apps
   WHERE self_hosted = TRUE
   ORDER BY id ASC
   LIMIT 1
`;

// Pure (exported for tests): the title a request gets when the admin left
// the title blank — its first non-empty line, cut to DERIVED_TITLE_MAX.
function deriveTitle(description) {
  const line = String(description || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find(Boolean) || '';
  if (line.length <= DERIVED_TITLE_MAX) return line;
  const cut = line.slice(0, DERIVED_TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > DERIVED_TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Pure (exported for tests): validate a new request's body.
// Returns { ok: true, title, description, target, appSlug } or { ok: false, error }.
function parseNewRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.description !== 'string' || !b.description.trim()) {
    return { ok: false, error: 'Description is required' };
  }
  const description = b.description.trim();
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, error: `Description too long (max ${DESCRIPTION_MAX} chars)` };
  }
  let title = '';
  if (b.title !== undefined && b.title !== null && b.title !== '') {
    if (typeof b.title !== 'string') return { ok: false, error: 'title must be a string' };
    if (b.title.length > TITLE_MAX) return { ok: false, error: `Title too long (max ${TITLE_MAX} chars)` };
    title = b.title.replace(/\s+/g, ' ').trim();
  }
  if (!title) title = deriveTitle(description);
  const target = b.target === 'app' ? 'app' : 'platform';
  let appSlug = null;
  if (target === 'app') {
    if (typeof b.appSlug !== 'string' || !b.appSlug.trim()) {
      return { ok: false, error: 'appSlug is required for an app request' };
    }
    appSlug = b.appSlug.trim();
  }
  return { ok: true, title, description, target, appSlug };
}

// Pure (exported for tests): the client's shape of one row.
function shapeRequest(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status === 'closed' ? 'closed' : 'open',
    createdBy: row.created_by_username || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedBy: row.closed_by_username || null,
    closedAt: row.closed_at || null,
    commentCount: Number(row.comment_count || 0),
  };
}

function shapeComment(row) {
  return {
    id: row.id,
    author: row.username || null,
    body: row.body,
    createdAt: row.created_at,
  };
}

const REQUEST_SELECT = `
  SELECT pr.id, pr.title, pr.description, pr.status, pr.created_at, pr.updated_at,
         pr.closed_at, cu.username AS created_by_username, xu.username AS closed_by_username,
         (SELECT COUNT(*) FROM private_request_comments c WHERE c.private_request_id = pr.id) AS comment_count
    FROM private_requests pr
    LEFT JOIN users cu ON cu.id = pr.created_by
    LEFT JOIN users xu ON xu.id = pr.closed_by
`;

function notFound(res) {
  return res.status(404).json({ error: 'Not found' });
}

function privateRequestRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // The app, for an admin; null for anyone else or an unknown slug.
  async function adminApp(req, slug) {
    if (!req.user?.isAdmin) return null;
    const { rows } = await pool.query('SELECT id, slug, name FROM apps WHERE slug = $1', [slug]);
    return rows[0] || null;
  }

  async function loadRequest(appId, id) {
    const { rows } = await pool.query(
      `${REQUEST_SELECT} WHERE pr.app_id = $1 AND pr.id = $2`,
      [appId, id]
    );
    return rows[0] || null;
  }

  // GET /api/apps/:slug/private-requests?state=open|closed
  router.get('/api/apps/:slug/private-requests', async (req, res) => {
    try {
      const app = await adminApp(req, req.params.slug);
      if (!app) return notFound(res);
      const state = req.query.state === 'closed' ? 'closed' : 'open';
      const { rows } = await pool.query(
        `${REQUEST_SELECT} WHERE pr.app_id = $1 AND pr.status = $2
          ORDER BY pr.created_at DESC, pr.id DESC
          LIMIT 200`,
        [app.id, state]
      );
      res.json({ requests: rows.map(shapeRequest), canWrite: !!req.user.canAdminWrite });
    } catch (err) {
      log.error('private-requests', 'List failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/apps/:slug/private-requests/:id → { request, comments }
  router.get('/api/apps/:slug/private-requests/:id', async (req, res) => {
    try {
      if (!ID_RE.test(req.params.id)) return notFound(res);
      const app = await adminApp(req, req.params.slug);
      if (!app) return notFound(res);
      const row = await loadRequest(app.id, Number(req.params.id));
      if (!row) return notFound(res);
      const { rows: comments } = await pool.query(
        `SELECT c.id, c.body, c.created_at, u.username
           FROM private_request_comments c
           LEFT JOIN users u ON u.id = c.user_id
          WHERE c.private_request_id = $1
          ORDER BY c.id ASC`,
        [row.id]
      );
      res.json({
        request: shapeRequest(row),
        comments: comments.map(shapeComment),
        canWrite: !!req.user.canAdminWrite,
      });
    } catch (err) {
      log.error('private-requests', 'Read failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/private-requests { target: 'app'|'platform', appSlug?, title?, description }
  // The "file a request" dialog's private switch posts here instead of
  // /api/feedback. A platform request goes on the platform's own project,
  // where /api/feedback's platform issues go.
  router.post('/api/private-requests', sameOriginBrowserOnly, async (req, res) => {
    if (!req.user?.isAdmin) return notFound(res);
    if (!req.user.canAdminWrite) return res.status(403).json({ error: 'Admin write access required' });
    const parsed = parseNewRequest(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    try {
      let app;
      if (parsed.target === 'app') {
        app = await adminApp(req, parsed.appSlug);
      } else {
        const { rows } = await pool.query(SELF_APP_SQL);
        app = rows[0] || null;
      }
      if (!app) return res.status(404).json({ error: 'App not found' });
      const { rows } = await pool.query(
        `INSERT INTO private_requests (app_id, title, description, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [app.id, parsed.title, parsed.description, req.user.id]
      );
      const row = await loadRequest(app.id, rows[0].id);
      // The id and the app only: the words stay out of the logs.
      log.info('private-requests', 'Private request filed', { id: row.id, app: app.slug, by: req.user.id });
      res.status(201).json({ request: shapeRequest(row), appSlug: app.slug, appName: app.name });
    } catch (err) {
      log.error('private-requests', 'Create failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/apps/:slug/private-requests/:id/comments { body }
  router.post('/api/apps/:slug/private-requests/:id/comments', sameOriginBrowserOnly, async (req, res) => {
    try {
      if (!ID_RE.test(req.params.id)) return notFound(res);
      const app = await adminApp(req, req.params.slug);
      if (!app) return notFound(res);
      if (!req.user.canAdminWrite) return res.status(403).json({ error: 'Admin write access required' });
      const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
      if (!body) return res.status(400).json({ error: 'Comment is required' });
      if (body.length > COMMENT_MAX) return res.status(400).json({ error: `Comment too long (max ${COMMENT_MAX} chars)` });
      const row = await loadRequest(app.id, Number(req.params.id));
      if (!row) return notFound(res);
      const { rows } = await pool.query(
        `INSERT INTO private_request_comments (private_request_id, user_id, body)
         VALUES ($1, $2, $3) RETURNING id, body, created_at`,
        [row.id, req.user.id, body]
      );
      await pool.query('UPDATE private_requests SET updated_at = NOW() WHERE id = $1', [row.id]);
      res.status(201).json({ comment: shapeComment({ ...rows[0], username: req.user.username }) });
    } catch (err) {
      log.error('private-requests', 'Comment failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/apps/:slug/private-requests/:id/close and /reopen
  for (const action of ['close', 'reopen']) {
    router.post(`/api/apps/:slug/private-requests/:id/${action}`, sameOriginBrowserOnly, async (req, res) => {
      try {
        if (!ID_RE.test(req.params.id)) return notFound(res);
        const app = await adminApp(req, req.params.slug);
        if (!app) return notFound(res);
        if (!req.user.canAdminWrite) return res.status(403).json({ error: 'Admin write access required' });
        const closing = action === 'close';
        const { rowCount } = await pool.query(
          closing
            ? `UPDATE private_requests
                  SET status = 'closed', closed_by = $3, closed_at = NOW(), updated_at = NOW()
                WHERE app_id = $1 AND id = $2`
            : `UPDATE private_requests
                  SET status = 'open', closed_by = NULL, closed_at = NULL, updated_at = NOW()
                WHERE app_id = $1 AND id = $2`,
          closing ? [app.id, Number(req.params.id), req.user.id] : [app.id, Number(req.params.id)]
        );
        if (!rowCount) return notFound(res);
        res.json({ request: shapeRequest(await loadRequest(app.id, Number(req.params.id))) });
      } catch (err) {
        log.error('private-requests', `${action} failed`, { message: err.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  return router;
}

module.exports = {
  privateRequestRoutes,
  // Pure helpers, exported for tests/private-requests.test.js.
  deriveTitle,
  parseNewRequest,
  shapeRequest,
  TITLE_MAX,
  DESCRIPTION_MAX,
};
