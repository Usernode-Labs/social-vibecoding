'use strict';

// #4803: a new feedback edit window on the disposable after copy. GitHub
// credentials stay out of staging, so the shots member cannot file a report
// through the UI. This fake receipt lets them open the real profile/editor.
// Its five minutes start at boot; a restart never refreshes that deadline.
// Nothing in the product branches on this fixture or reports a fake save.
async function seedStagingFeedback(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  return pool.query(`
    INSERT INTO feedback_reports
      (id, user_id, target, app_id, issue_owner, issue_repo, issue_number,
       title, description, created_at, body_prefix, body_suffix)
    SELECT 9904803, u.id, 'platform', a.id, 'shots-fixture', 'feedback', 4803,
           $2, $3, NOW(), $4, ''
      FROM users u JOIN apps a ON a.slug = $1
     WHERE u.username = 'usernode-capture'
    ON CONFLICT (id) DO NOTHING`, [
    config.selfAppSlug,
    '[staging fixture] Correct a typo after sendding feedback',
    '[staging fixture] I want to correct a typo after sending my feedback.',
    '**Source:** Homeroom user (usernode-capture)\n\n**Description:**\n',
  ]);
}

module.exports = { seedStagingFeedback };
