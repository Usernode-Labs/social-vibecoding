'use strict';

// A project's first version went live: its members are told (#4396).
//
// Its maker hears from Homeroom bot ("Live", homeroom-bot-dm.js build_live).
// Everybody else who joined while it was being made only had "It opens here
// when it's ready." on its App tab, and nothing told them when it did, so
// somebody invited to a project still being made had to keep coming back to
// find out. Now each of them gets one `project_opened` notification: the
// bell, the phone (Change alerts, mobile-push-preferences.js), and, when no
// phone can take the push, an email (activity-mail.js).
//
// Who: the project's community members (community_members, which Join, an
// invite link and an accepted invite all write), but not its maker, not the
// Homeroom bot or any other synthetic account, and not somebody who blocked
// the project. Once per person and project: a first version goes live once,
// and the INSERT checks again so a retried send tells nobody twice.
//
// Best-effort and never throws: the first version is live whatever happens
// here.

const log = require('./logger');

const MEMBERS_SQL = `
  SELECT cm.user_id
    FROM apps a
    JOIN community_members cm ON cm.community_id = a.community_id
    JOIN users u ON u.id = cm.user_id
   WHERE a.id = $1
     AND cm.user_id IS DISTINCT FROM $2
     AND cm.user_id IS DISTINCT FROM a.created_by
     AND u.is_synthetic = FALSE
     AND NOT EXISTS (
       SELECT 1 FROM user_app_blocks b WHERE b.user_id = cm.user_id AND b.app_id = a.id
     )`;

/**
 * Tell `appSlug`'s members (all but `makerId`) that it is open. Resolves the
 * rows it wrote.
 */
async function tellMembers(pool, { appSlug, makerId = null }) {
  try {
    if (!appSlug) return [];
    const { rows: apps } = await pool.query(
      'SELECT id, slug, name FROM apps WHERE slug = $1',
      [String(appSlug)],
    );
    const app = apps[0];
    if (!app) return [];
    const { rows: members } = await pool.query(MEMBERS_SQL, [app.id, makerId == null ? null : Number(makerId)]);
    const ids = members.map((row) => Number(row.user_id)).filter(Number.isSafeInteger);
    if (!ids.length) return [];
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, app_id, source_user_id, kind)
       SELECT u, $2, NULL, 'project_opened'
         FROM UNNEST($1::int[]) AS u
        WHERE NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = u AND n.app_id = $2 AND n.kind = 'project_opened'
        )
       RETURNING id, user_id, app_id, source_user_id, kind, detail, created_at`,
      [ids, app.id],
    );
    const notifications = require('./notifications');
    const activityMail = require('./activity-mail');
    for (const row of rows) {
      await notifications.hydrateAndPush(pool, row);
      void activityMail.emailIfNoPush(pool, {
        userId: row.user_id, kind: 'project_opened', appName: app.name || app.slug, appSlug: app.slug,
      });
    }
    return rows;
  } catch (err) {
    log.warn('project-opened', 'Could not tell a project\'s members it opened', { appSlug, err: err.message });
    return [];
  }
}

module.exports = { tellMembers, MEMBERS_SQL };
