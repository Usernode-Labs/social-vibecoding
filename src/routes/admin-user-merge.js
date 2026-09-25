// Admin "Deduplicate user" (#admin/users/<id>): merge two accounts of one
// person. The work is src/services/user-merge.js; this file is the HTTP edge.
//
//   GET  /api/admin/users/:id/merge-preview?other=<id>
//        Any admin. Both accounts side by side (username, id, email, joined,
//        a few activity counts, sign-in methods) plus, per table, how many
//        rows reference each of them. Read-only.
//   POST /api/admin/users/:id/merge   { mergeUserId, emailFrom, confirmation }
//        Full admins only (requireAdminWrite). `:id` is the account KEPT;
//        `mergeUserId` is anonymised. `emailFrom` is 'kept' or 'merged';
//        `confirmation` must be the merged account's exact username.
'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const log = require('../services/logger');
const merge = require('../services/user-merge');

function toId(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function sendError(res, err) {
  if (err instanceof merge.UserMergeError) return res.status(err.status).json({ error: err.message, code: err.code });
  log.error('user-merge', 'Merge request failed', { code: err && err.code ? err.code : 'internal_error' });
  return res.status(500).json({ error: 'The merge could not be completed. Nothing was changed.' });
}

function adminUserMergeRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();

  router.get('/api/admin/users/:id/merge-preview', adminMiddleware, async (req, res) => {
    const userId = toId(req.params.id);
    const otherId = toId(req.query.other);
    if (!userId || !otherId) return res.status(400).json({ error: 'Choose two users.' });
    try {
      res.json(await merge.mergePreview(pool, { userId, otherId }));
    } catch (err) { sendError(res, err); }
  });

  router.post('/api/admin/users/:id/merge', adminMiddleware, requireAdminWrite, async (req, res) => {
    const body = req.body || {};
    const keepId = toId(req.params.id);
    const mergeId = toId(body.mergeUserId);
    if (!keepId || !mergeId) return res.status(400).json({ error: 'Choose two users.' });
    try {
      const result = await merge.mergeUsers(pool, {
        keepId,
        mergeId,
        actorId: req.user.id,
        emailFrom: body.emailFrom,
        confirmation: typeof body.confirmation === 'string' ? body.confirmation : '',
      });
      res.json(result);
    } catch (err) { sendError(res, err); }
  });

  return router;
}

module.exports = { adminUserMergeRoutes };
