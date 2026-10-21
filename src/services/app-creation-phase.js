'use strict';

/**
 * The step a project being made is on, for a client that loaded (or
 * reloaded) mid-creation and so missed the `app_status` frames that say it
 * live (GET /api/apps/:slug, the bot's progress).
 *
 * `apps.status` has no intermediate value between `'creating'` and its
 * terminal ones, so the step is read from the making itself
 * (src/workflow/app-creation/): while it is set up, the parts of its setup
 * done (its work's steps: the database, then the repository); once set up,
 * its first deploy, app delivery's. Durable, so any process answers the
 * same, and a restart loses nothing.
 */

// The made screen's four steps, in order: a step reported marks every one
// before it done.
const PHASES = ['database', 'repository', 'build', 'deploy'];

/** The step `appId` is on, as { phase }, or null when there is none to report. */
async function read(pool, appId) {
  try {
    const { rows: [r] } = await pool.query(
      `SELECT i.state, w.checkpoint, a.deploy_state
         FROM wf_instances i
         JOIN apps a ON a.id = $1
         LEFT JOIN LATERAL (
           SELECT checkpoint FROM wf_work
            WHERE machine = i.machine AND key = i.key AND kind = 'app.setup' AND status IN ('queued', 'running')
            ORDER BY id DESC LIMIT 1) w ON TRUE
        WHERE i.machine = 'app-creation' AND i.key = 'app:' || $1::text`,
      [appId]);
    if (!r) return null;
    if (r.state === 'setting_up') {
      const done = r.checkpoint && typeof r.checkpoint === 'object' ? r.checkpoint : {};
      return { phase: Object.prototype.hasOwnProperty.call(done, 'database') ? 'repository' : 'database' };
    }
    if (r.state === 'deploying') return { phase: 'build' };
    return null;
  } catch {
    return null;
  }
}

module.exports = { read, PHASES };
