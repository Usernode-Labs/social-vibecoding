'use strict';

async function isBlocked(pool, userId, appId) {
  if (!userId || !appId) return false;
  const { rows } = await pool.query(
    'SELECT app_id FROM user_app_blocks WHERE user_id = $1 AND app_id = $2', [userId, appId]);
  return rows.some(row => Number(row.app_id) === Number(appId));
}

async function list(pool, userId) {
  const { rows } = await pool.query(
    `SELECT a.slug, a.name, b.created_at FROM user_app_blocks b
       JOIN apps a ON a.id = b.app_id WHERE b.user_id = $1
       ORDER BY LOWER(a.name), a.id`, [userId]);
  return rows;
}

async function setBlocked(pool, user, slug, blocked) {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  if (!user?.id) fail(401, 'Sign in to manage blocked apps');
  const db = await pool.connect();
  let app, changed = false;
  try {
    await db.query('BEGIN');
    // Serialize this person's block/unblock requests without changing membership.
    await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    app = (await db.query(`SELECT id, slug, self_hosted, view_visibility, collab_visibility,
      moderation_suspended_at FROM apps WHERE slug = $1`, [slug])).rows[0];
    if (!app) fail(404, 'App unavailable');
    if (blocked) {
      if (app.self_hosted) fail(400, 'Homeroom itself cannot be blocked');
      if (!await isBlocked(db, user.id, app.id)
          && !await require('./app-access').checkAppAccess(db, app, user)) fail(404, 'App unavailable');
      await db.query('INSERT INTO user_app_blocks (user_id, app_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, app.id]);
    } else {
      // Unblocking stays possible after visibility or moderation changes.
      const removed = await db.query('DELETE FROM user_app_blocks WHERE user_id = $1 AND app_id = $2', [user.id, app.id]);
      changed = removed.rowCount > 0;
    }
    // Clear old activity and its queued push deliveries, including activity
    // created during the block. Unblocking never replays suppressed alerts.
    if (blocked || changed) await db.query('DELETE FROM notifications WHERE user_id = $1 AND app_id = $2', [user.id, app.id]);
    await db.query('COMMIT');
  } catch (err) { await db.query('ROLLBACK').catch(() => {}); throw err; }
  finally { db.release(); }
  require('./app-access').invalidateVisibility(app.id, app.slug);
  return { appId: app.id, slug: app.slug, blocked };
}
module.exports = { isBlocked, list, setBlocked };
