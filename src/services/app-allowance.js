const notifications = require('./notifications');
const { withTransaction } = require('./cli-auth');
const log = require('./logger');

// Read independently of optional profile/credential data. A failed profile
// lookup must not make a user with available slots appear unable to create.
async function read(pool, user) {
  const { rows } = await pool.query(
    `SELECT u.app_quota, u.app_quota_requested_at,
            (SELECT COUNT(*)::int FROM apps owned_app
              WHERE owned_app.created_by = u.id
                AND owned_app.status <> 'error') AS app_quota_used
       FROM users u WHERE u.id = $1`,
    [user.id],
  );
  if (!rows.length) throw new Error('App allowance user not found');
  const used = Number(rows[0].app_quota_used);
  const limit = user.canAdminWrite ? null : Number(rows[0].app_quota);
  if (!Number.isInteger(used) || used < 0
      || (limit !== null && (!Number.isInteger(limit) || limit < 0))) {
    throw new Error('Invalid app allowance');
  }
  return {
    quota: { used, limit, remaining: limit === null ? null : Math.max(0, limit - used) },
    canCreateApps: limit === null || used < limit,
    requestedAt: rows[0].app_quota_requested_at || null,
  };
}

function refusal(allowance) {
  return {
    code: 'app_allowance_exhausted',
    error: `You have used ${allowance.quota.used} of ${allowance.quota.limit} app slots. Request more slots from the app allowance panel.`,
    ...allowance,
  };
}

async function publish(pool, rows, userIds) {
  await Promise.all(rows.map((row) => notifications.hydrateAndPush(pool, row)));
  // Also refresh open dialogs/home screens if the bell is not mounted.
  try {
    const { pushNotificationToUser } = require('./ws');
    for (const id of userIds) pushNotificationToUser(id, { type: 'app_allowance_changed' });
  } catch (err) {
    log.warn('app-allowance', 'Live refresh failed', { message: err.message });
  }
}

async function requestMore(pool, user) {
  const rows = await withTransaction(pool, async (db) => {
    // A user row is the single pending request. Concurrent clicks and retries
    // cannot create another notification while that request is outstanding.
    const result = await db.query(
      `UPDATE users SET app_quota_requested_at = NOW()
        WHERE id = $1 AND app_quota_requested_at IS NULL
          AND NOT (is_admin = TRUE AND admin_readonly = FALSE)
        RETURNING id`,
      [user.id],
    );
    if (!result.rows.length) return [];
    return (await db.query(
      `INSERT INTO notifications (user_id, source_user_id, kind)
       SELECT id, $1, 'app_quota_requested' FROM users
        WHERE is_admin = TRUE
       RETURNING id, user_id`,
      [user.id],
    )).rows;
  });
  await publish(pool, rows, [user.id]);
  return read(pool, user);
}

async function setQuota(pool, { userId = null, quota, actorId }) {
  const result = await withTransaction(pool, async (db) => {
    const { rows: users } = await db.query(
      `SELECT id, username, app_quota FROM users
        WHERE ($1::int IS NULL OR id = $1) ORDER BY id FOR UPDATE`,
      [userId],
    );
    const changed = users.filter((user) => user.app_quota !== quota);
    if (!changed.length) return { users, changed, notifications: [] };
    await db.query(
      `UPDATE users SET
         app_quota_requested_at = CASE WHEN $1 > app_quota THEN NULL ELSE app_quota_requested_at END,
         app_quota = $1
       WHERE id = ANY($2::int[])`,
      [quota, changed.map((user) => user.id)],
    );
    const { rows } = await db.query(
      `INSERT INTO notifications (user_id, source_user_id, kind, detail)
       SELECT id, $1, 'app_quota_changed', old_quota::text || ':' || $2::int::text
         FROM unnest($3::int[], $4::int[]) AS changed(id, old_quota)
       RETURNING id, user_id`,
      [actorId, quota, changed.map((user) => user.id), changed.map((user) => user.app_quota)],
    );
    return { users, changed, notifications: rows };
  });
  await publish(pool, result.notifications, result.changed.map((user) => user.id));
  return result.users;
}

async function declineRequest(pool, { userId, actorId }) {
  const rows = await withTransaction(pool, async (db) => {
    const result = await db.query(
      `UPDATE users SET app_quota_requested_at = NULL
        WHERE id = $1 AND app_quota_requested_at IS NOT NULL RETURNING id`,
      [userId],
    );
    if (!result.rows.length) return [];
    return (await db.query(
      `INSERT INTO notifications (user_id, source_user_id, kind)
       VALUES ($1, $2, 'app_quota_request_declined') RETURNING id, user_id`,
      [userId, actorId],
    )).rows;
  });
  await publish(pool, rows, [userId]);
}

async function grantRequest(pool, { userId, actorId }) {
  // Increment the live value and consume the pending request atomically.
  // Two admins reviewing the same request can only grant it once.
  const { rows } = await pool.query(
    `WITH changed AS (
       UPDATE users SET app_quota = app_quota + 2, app_quota_requested_at = NULL
        WHERE id = $1 AND app_quota_requested_at IS NOT NULL AND app_quota <= 2147483645
        RETURNING id, app_quota
     ), notified AS (
       INSERT INTO notifications (user_id, source_user_id, kind, detail)
       SELECT id, $2, 'app_quota_changed', (app_quota - 2)::text || ':' || app_quota::text
         FROM changed RETURNING id, user_id
     )
     SELECT notified.id, notified.user_id, changed.app_quota
       FROM notified JOIN changed ON changed.id = notified.user_id`,
    [userId, actorId],
  );
  await publish(pool, rows, rows.map((row) => row.user_id));
  return rows[0] || null;
}

module.exports = { read, refusal, requestMore, setQuota, declineRequest, grantRequest };
