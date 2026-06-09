'use strict';

/**
 * Shared rename-PR creation, used by both the interactive route
 * (POST /api/apps/:slug/rename in routes/apps.js) and the one-time
 * boot migration that drains the legacy rename-issue backlog
 * (migrateOpenRenameIssues below).
 *
 * Both paths must produce an identical artifact: a PR that edits/creates
 * dapp.json's top-level `name`, dropped into the vote panel as a
 * `promoted` chat_sessions row with full promote-path parity
 * (promoted_at, pr_promoted analytics event, pr_proposed voter-nudge
 * notifications, group-chat vote message). Keeping it in one place means
 * the route and the migration can never drift.
 */

const log = require('./logger');
const github = require('./github');
const appManifest = require('./app-manifest');
const events = require('./events');

// Branch naming pattern: rename/<slug>-<timestamp>. The timestamp suffix
// avoids collisions if a prior rename attempt left a stale branch on the
// remote. (This is plain service code, not a workflow script, so Date.now
// is fine here.)
function renameBranchName(slug) {
  return `rename/${slug}-${Date.now()}`;
}

/**
 * Open a rename PR for `app` targeting `newName`. The caller owns
 * user-facing validation (length, name-differs, GitHub-enabled) and
 * dedupe; this helper assumes it's been cleared to proceed.
 *
 * `actor` is `{ id, username }` — the user attributed as the proposer
 * (the requesting user for the route; the rename issue's creator for the
 * migration). `id` may be null (e.g. a deleted issue author).
 *
 * Throws on GitHub / DB failure so callers can map it to an HTTP error
 * or skip-and-continue. On success returns
 * `{ sessionId, prNumber, prUrl, branch }`.
 */
async function createRenamePR(config, pool, app, newName, actor) {
  const [, owner, repo] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!owner || !repo) throw new Error('Could not parse the app repository URL');

  // Build the updated dapp.json. Preserve existing fields when the file
  // is present + parseable; create a minimal manifest when it's missing
  // (legacy apps predating the manifest). A malformed file is already
  // treated as empty by the deploy reader, so falling back to a fresh
  // object there is safe.
  let manifestObj = { secrets: [] };
  const existing = await github.getFileContent(owner, repo, appManifest.MANIFEST_FILENAME, 'main');
  if (existing != null) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) manifestObj = parsed;
    } catch {
      log.warn('rename-pr', 'Existing dapp.json unparseable; writing fresh manifest', { slug: app.slug });
    }
  }
  manifestObj.name = newName;
  const updatedContent = `${JSON.stringify(manifestObj, null, 2)}\n`;

  const branch = renameBranchName(app.slug);
  await github.createBranch(owner, repo, branch);
  await github.pushFiles(
    owner, repo,
    [{ path: appManifest.MANIFEST_FILENAME, content: updatedContent }],
    { branch, message: `Rename to "${newName}"` }
  );

  const prTitle = `Rename to "${newName}"`;
  // safeMention is applied inside github.createPR; the actor.username
  // and names flow into the body verbatim here.
  const prBody =
    `${actor.username} (via Usernode) proposed renaming "${app.name}" to "${newName}".\n\n` +
    `This PR updates the \`name\` field in \`dapp.json\`. It still needs a regular ` +
    `merge vote to land — vote in the app's group chat panel. The new name applies ` +
    `automatically once the PR merges and the app redeploys.`;
  const prData = await github.createPR(owner, repo, { branch, title: prTitle, body: prBody });

  // Drop the rename PR straight into the vote panel as a promoted
  // session, mirroring the normal promote path (POST
  // /api/sessions/:id/promote in routes/votes.js): set promoted_at
  // (anchors the stale-PR sweeper), emit pr_promoted, fan out
  // pr_proposed notifications.
  const { rows: sessRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status, promoted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'promoted', NOW())
     RETURNING id`,
    [app.id, actor.id || null, branch, prData.number, prData.html_url, prTitle]
  );
  const sessionId = sessRows[0].id;

  const { sendSystemMessage, pushVoteUpdate, pushNotificationToUser } = require('./ws');
  const notifications = require('./notifications');
  const { getActiveUserStats } = require('./active-users');
  const { active: activeUsers, majority } = await getActiveUserStats(pool, app.id);

  await sendSystemMessage(pool, app.id,
    `${actor.username} proposed renaming to "${newName}". Opened PR #${prData.number} — needs ${majority}/${activeUsers} votes to land.`,
    'vote',
    { vote: { sessionId, prNumber: prData.number } }
  ).catch((err) => log.warn('rename-pr', 'Rename chat msg failed', { err: err.message }));

  pushVoteUpdate({ sessionId, appSlug: app.slug, merged: false });

  // pr_promoted is the funnel stage the PR-promotion analytics read;
  // emit it so rename PRs count like every other promoted PR.
  events.record(pool, {
    type: events.EVENT_TYPES.PR_PROMOTED,
    userId: actor.id || null,
    appId: app.id,
    sessionId,
    metadata: { prNumber: prData.number, rename: true },
  });

  // Vote-request fan-out — same as the normal promote path. Non-fatal:
  // the rename PR is already open, so a notification hiccup must not
  // poison the result.
  try {
    const notifRows = await notifications.createPrProposedNotifications(pool, {
      appId: app.id,
      sessionId,
      proposerId: actor.id || null,
    });
    for (const row of notifRows) {
      pushNotificationToUser(row.user_id, {
        type: 'notification_new',
        notification: notifications.serialize({
          ...row,
          app_slug: app.slug,
          app_name: app.name,
          pr_title: prTitle,
          pr_number: prData.number,
          source_username: actor.username,
        }),
      });
    }
    if (notifRows.length) {
      log.info('rename-pr', 'Rename PR-proposed notifications sent', {
        sessionId, count: notifRows.length,
      });
    }
  } catch (err) {
    log.warn('rename-pr', 'Rename pr_proposed notify failed', { sessionId, err: err.message });
  }

  log.info('rename-pr', 'Rename PR opened', {
    slug: app.slug, prNumber: prData.number, newName, by: actor.username,
  });

  return { sessionId, prNumber: prData.number, prUrl: prData.html_url, branch };
}

// True when the app already has a rename PR in flight (a promoted/merging
// chat_sessions row on a `rename/*` branch). Used by the migration to stay
// idempotent across reboots — a second pass won't double-open.
async function appHasOpenRenamePr(pool, appId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'rename/%'
      LIMIT 1`,
    [appId]
  );
  return rows.length > 0;
}

/**
 * One-time, idempotent boot routine: convert every open `issues` row with
 * kind='rename' into an equivalent rename PR (via createRenamePR), then
 * best-effort close the GitHub issue + close the DB issue row so the
 * legacy backlog drains and repos' issue trackers stay clean.
 *
 * Idempotency: an app that already has an open rename PR is NOT re-opened
 * — we just drain its lingering issue row. A single failing app (GitHub
 * disabled, no bot access, unparseable repo) logs and continues rather
 * than aborting the batch. No-op when GitHub isn't configured.
 */
async function migrateOpenRenameIssues(config, pool) {
  if (!github.isEnabled() || !process.env.GITHUB_BOT_TOKEN) {
    log.info('rename-pr', 'Skipping rename-issue migration (GitHub not configured)');
    return { migrated: 0, skipped: 0 };
  }

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT i.id, i.app_id, i.github_issue_number, i.payload,
              a.slug, a.name, a.repo_url,
              u.username AS created_by_username, i.created_by
         FROM issues i
         JOIN apps a ON a.id = i.app_id
         LEFT JOIN users u ON u.id = i.created_by
        WHERE i.kind = 'rename' AND i.status = 'open'`
    ));
  } catch (err) {
    // issues table or columns missing on a fresh DB — nothing to migrate.
    log.warn('rename-pr', 'Could not query open rename issues (skipping)', { err: err.message });
    return { migrated: 0, skipped: 0 };
  }
  if (!rows.length) return { migrated: 0, skipped: 0 };

  log.info('rename-pr', 'Migrating open rename issues to rename PRs', { count: rows.length });
  let migrated = 0;
  let skipped = 0;

  for (const issue of rows) {
    try {
      const newName = typeof issue.payload?.newName === 'string' ? issue.payload.newName.trim() : '';
      if (!newName || newName.length > appManifest.MAX_APP_NAME_LENGTH) {
        log.warn('rename-pr', 'Skipping rename issue with invalid newName', { issueId: issue.id });
        skipped++;
        continue;
      }
      const [, owner, repo] = (issue.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (!owner || !repo) {
        log.warn('rename-pr', 'Skipping rename issue (no parseable repo_url)', {
          issueId: issue.id, slug: issue.slug,
        });
        skipped++;
        continue;
      }

      const app = { id: issue.app_id, slug: issue.slug, name: issue.name, repo_url: issue.repo_url };
      const actor = { id: issue.created_by || null, username: issue.created_by_username || 'Usernode' };

      const alreadyNamed = newName.toLowerCase() === (issue.name || '').toLowerCase();
      const hasOpenRenamePr = await appHasOpenRenamePr(pool, issue.app_id);

      if (!alreadyNamed && !hasOpenRenamePr) {
        await createRenamePR(config, pool, app, newName, actor);
        migrated++;
      } else {
        // Nothing to open (name already applied, or a rename PR is already
        // in flight) — just drain this lingering issue row below.
        log.info('rename-pr', 'Rename PR already open / name already applied; draining issue only', {
          issueId: issue.id, slug: issue.slug, alreadyNamed, hasOpenRenamePr,
        });
        skipped++;
      }

      // Best-effort: close the GitHub issue + close the DB row so it leaves
      // the app's open-issues list. Failures don't undo the PR we opened.
      if (issue.github_issue_number) {
        await github.closeIssue(owner, repo, issue.github_issue_number).catch((err) =>
          log.warn('rename-pr', 'GitHub issue close failed during migration', {
            issue: issue.github_issue_number, err: err.message,
          }));
      }
      await pool.query(
        `UPDATE issues SET status = 'closed',
            payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
          WHERE id = $1 AND status = 'open'`,
        [issue.id, JSON.stringify({ migratedToPrAt: new Date().toISOString() })]
      ).catch((err) => log.warn('rename-pr', 'Could not close migrated rename issue row', {
        issueId: issue.id, err: err.message,
      }));
    } catch (err) {
      // One app failing (GitHub disabled mid-run, lost bot access, branch
      // collision, etc.) must not abort the whole batch — leave its issue
      // as-is so a later boot can retry.
      log.warn('rename-pr', 'Rename-issue migration failed for one app; continuing', {
        issueId: issue.id, slug: issue.slug, err: err.message,
      });
      skipped++;
    }
  }

  log.info('rename-pr', 'Rename-issue migration complete', { migrated, skipped });
  return { migrated, skipped };
}

module.exports = { createRenamePR, migrateOpenRenameIssues, appHasOpenRenamePr };
