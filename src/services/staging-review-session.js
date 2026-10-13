'use strict';

const appAccess = require('./app-access');
const { transaction } = require('./conversations');

const TITLE = '[Preview sample] Your editable change';
const DESCRIPTION = '### Try editing this description\n\n'
  + 'Open More actions, choose Edit description, and save your own explanation. '
  + 'This sample belongs to you. Your edits are saved only in this preview.';

// Ordinary preview viewers need their own real row, too. The screenshot
// identities' fixtures are private, and the ?demo=1 layout placeholders
// cannot exercise a save. This creates no branch, PR, worker or model turn.
// Repeated reads never reset an edited or archived sample.
async function ensure(pool, config, user, app = null) {
  if (process.env.USERNODE_ENV !== 'staging' || !config.selfAppSlug || !user?.id) return null;
  if (app && app.slug !== config.selfAppSlug) return null;
  const target = await appAccess.getAppForUser(
    pool, config.selfAppSlug, user, 'collab', appAccess.ACCESS_COLUMNS
  );
  if (!target) return null;
  const branch = `staging-fixture/review-session-${user.id}`;
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(3587, $1)', [user.id]);
    const existing = await db.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND user_id = $2 AND branch_name = $3 LIMIT 1',
      [target.id, user.id, branch]
    );
    if (existing.rows.length) return existing.rows[0].id;
    const { rows } = await db.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, session_title, status, pr_summary_md,
          pr_summary_source, pr_summary_stale, pr_summary_input_version, pr_summary_applied_version)
       VALUES ($1, $2, $3, $4, 'paused', $5, 'author', FALSE, 1, 1)
       RETURNING id`,
      [target.id, user.id, branch, TITLE, DESCRIPTION]
    );
    const id = rows[0].id;
    await db.query(
      `INSERT INTO chat_session_messages (session_id, role, content)
       VALUES ($1, 'system', $2)`,
      [id, 'This is your editable sample change in this preview. Open its change page and use More actions to edit the description.']
    );
    return id;
  });
}

module.exports = { ensure, TITLE, DESCRIPTION };
