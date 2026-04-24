const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const { sendSystemMessage, pushAppUpdate, pushIssueUpdate } = require('../services/ws');
const { getActiveUserStats } = require('../services/active-users');
const { issueCreateLimiter } = require('../middleware/rate-limits');

const VALID_KINDS = ['general', 'rename'];
const MAX_APP_NAME_LENGTH = 64;

// Caps on concurrent open rename proposals per app. The per-user cap stops
// one user from flooding a group chat with rename votes; the per-app cap
// keeps the voting UI readable.
const MAX_OPEN_RENAMES_PER_USER = 1;
const MAX_OPEN_RENAMES_PER_APP = 3;

function issueRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // List issues for an app
  router.get('/api/apps/:slug/issues', async (req, res) => {
    try {
      const { rows: appRows } = await pool.query('SELECT id FROM apps WHERE slug = $1', [req.params.slug]);
      if (!appRows.length) return res.status(404).json({ error: 'App not found' });

      const appId = appRows[0].id;

      const { rows } = await pool.query(
        `SELECT i.*, u.username as created_by_username,
           (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'up') as up_count,
           (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'down') as down_count,
           (SELECT vote FROM issue_votes WHERE issue_id = i.id AND user_id = $2) as my_vote
         FROM issues i
         LEFT JOIN users u ON i.created_by = u.id
         WHERE i.app_id = $1 AND i.status = 'open'
         ORDER BY (SELECT COUNT(*) FROM issue_votes WHERE issue_id = i.id AND vote = 'up') DESC, i.created_at DESC`,
        [appId, req.user.id]
      );

      const { active: activeUsers, majority } = await getActiveUserStats(pool, appId);

      res.json({ issues: rows, activeUsers, majority });
    } catch (err) {
      log.error('issues', 'Failed to list issues', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create an issue — supports kind='general' (default) and kind='rename'.
  router.post('/api/apps/:slug/issues', issueCreateLimiter, async (req, res) => {
    let { title, description, kind = 'general', payload = {} } = req.body || {};

    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `Invalid kind; must be one of ${VALID_KINDS.join(', ')}` });
    }

    try {
      const { rows: appRows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!appRows.length) return res.status(404).json({ error: 'App not found' });
      const app = appRows[0];

      // Kind-specific validation + auto-filled title/description.
      if (kind === 'rename') {
        const newName = typeof payload?.newName === 'string' ? payload.newName.trim() : '';
        if (!newName) return res.status(400).json({ error: 'payload.newName is required for rename proposals' });
        if (newName.length > MAX_APP_NAME_LENGTH) {
          return res.status(400).json({ error: `New name must be ${MAX_APP_NAME_LENGTH} characters or fewer` });
        }
        if (newName.toLowerCase() === app.name.toLowerCase()) {
          return res.status(400).json({ error: 'App is already named that' });
        }

        // Reject duplicate open rename proposals for the same target name.
        const { rows: dupe } = await pool.query(
          `SELECT id FROM issues
           WHERE app_id = $1 AND kind = 'rename' AND status = 'open'
             AND LOWER(payload->>'newName') = LOWER($2)
           LIMIT 1`,
          [app.id, newName]
        );
        if (dupe.length) {
          return res.status(409).json({ error: 'A rename proposal with that name is already open' });
        }

        // Cap open rename proposals: 1 per user per app, 3 per app total.
        const { rows: capRows } = await pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE kind = 'rename' AND status = 'open') AS app_open,
             COUNT(*) FILTER (WHERE kind = 'rename' AND status = 'open' AND created_by = $2) AS user_open
           FROM issues WHERE app_id = $1`,
          [app.id, req.user.id]
        );
        const appOpen = parseInt(capRows[0].app_open, 10) || 0;
        const userOpen = parseInt(capRows[0].user_open, 10) || 0;
        if (userOpen >= MAX_OPEN_RENAMES_PER_USER) {
          return res.status(409).json({
            error: 'You already have an open rename proposal for this app',
          });
        }
        if (appOpen >= MAX_OPEN_RENAMES_PER_APP) {
          return res.status(409).json({
            error: `This app has reached the max of ${MAX_OPEN_RENAMES_PER_APP} open rename proposals`,
          });
        }

        payload = { newName };
        title = `Rename to "${newName}"`;
        // No `@` prefix — this renders on github.com and would ping whoever
        // happens to own that GitHub handle.
        description = description?.trim() ||
          `${req.user.username} (via Usernode) proposed renaming "${app.name}" to "${newName}". Auto-applies when a majority of active users vote up.`;
      } else {
        if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
        title = title.trim();
        description = description || null;
        payload = typeof payload === 'object' && payload ? payload : {};
      }

      let githubIssueNumber = null;
      if (github.isEnabled() && app.repo_url) {
        try {
          const [, owner, repo] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
          if (owner && repo) {
            const ghIssue = await github.createIssue(owner, repo, {
              title,
              body: description || '',
            });
            githubIssueNumber = ghIssue.number;
          }
        } catch (err) {
          log.warn('issues', 'GitHub issue creation failed', { err: err.message });
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [app.id, githubIssueNumber, title, description, kind, JSON.stringify(payload), req.user.id]
      );

      const chatPrefix = kind === 'rename'
        ? `${req.user.username} proposed renaming to "${payload.newName}"`
        : `${req.user.username} created issue: "${title}"`;
      await sendSystemMessage(pool, app.id,
        `${chatPrefix}${githubIssueNumber ? ` (#${githubIssueNumber})` : ''}`,
        'system'
      );

      pushIssueUpdate({ action: 'created', appSlug: app.slug, appId: app.id, issueId: rows[0].id, kind });

      log.info('issues', 'Issue created', { issueId: rows[0].id, kind, title });
      res.status(201).json({ issue: rows[0] });
    } catch (err) {
      log.error('issues', 'Failed to create issue', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Vote on an issue — for rename proposals, a passing up-vote auto-applies.
  router.post('/api/issues/:id/vote', async (req, res) => {
    const { vote } = req.body;
    if (!['up', 'down'].includes(vote)) {
      return res.status(400).json({ error: 'Vote must be "up" or "down"' });
    }

    try {
      // Join to apps so we have the slug for the WS broadcast below;
      // without it, other users' vote panels wouldn't refresh until they
      // reload the page.
      const { rows: issueRows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.id = $1`,
        [req.params.id]
      );
      if (!issueRows.length) return res.status(404).json({ error: 'Issue not found' });
      const issue = issueRows[0];

      if (issue.status !== 'open') {
        return res.status(409).json({ error: 'Issue is not open' });
      }

      // Toggle off when re-voting the same direction.
      const { rows: existing } = await pool.query(
        'SELECT vote FROM issue_votes WHERE issue_id = $1 AND user_id = $2',
        [issue.id, req.user.id]
      );

      if (existing.length && existing[0].vote === vote) {
        await pool.query(
          'DELETE FROM issue_votes WHERE issue_id = $1 AND user_id = $2',
          [issue.id, req.user.id]
        );
        pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id, toggled: true });
        return res.json({ ok: true, toggled: true });
      }

      await pool.query(
        `INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, $3)
         ON CONFLICT (issue_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, created_at = NOW()`,
        [issue.id, req.user.id, vote]
      );

      await sendSystemMessage(pool, issue.app_id,
        `${req.user.username} voted ${vote} on ${issue.kind === 'rename' ? `rename proposal "${issue.payload?.newName || issue.title}"` : `issue: "${issue.title}"`}`,
        'vote'
      );

      let renamed = null;
      if (vote === 'up' && issue.kind === 'rename') {
        renamed = await maybeApplyRenameProposal(pool, issue);
      }

      pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id, vote });

      res.json({ ok: true, renamed });
    } catch (err) {
      log.error('issues', 'Vote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Close an issue
  router.post('/api/issues/:id/close', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE issues SET status = 'closed'
         WHERE id = $1
         RETURNING id, app_id,
           (SELECT slug FROM apps WHERE apps.id = issues.app_id) AS app_slug`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Issue not found' });
      pushIssueUpdate({ action: 'closed', appSlug: rows[0].app_slug, appId: rows[0].app_id, issueId: rows[0].id });
      res.json({ ok: true });
    } catch (err) {
      log.error('issues', 'Close failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Check the up-vote tally against the active-user majority. If the threshold
// is met, apply the rename atomically (inside a txn guarded by SELECT FOR
// UPDATE on the issue row so two near-simultaneous tripping votes can't
// double-apply).
async function maybeApplyRenameProposal(pool, issue) {
  const { active, majority } = await getActiveUserStats(pool, issue.app_id);

  const { rows: upRows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM issue_votes WHERE issue_id = $1 AND vote = 'up'`,
    [issue.id]
  );
  const upCount = parseInt(upRows[0].cnt, 10) || 0;
  if (upCount < majority) {
    return { applied: false, upCount, majority, active };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: lockRows } = await client.query(
      'SELECT * FROM issues WHERE id = $1 FOR UPDATE',
      [issue.id]
    );
    if (!lockRows.length || lockRows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return { applied: false, upCount, majority, active };
    }
    const locked = lockRows[0];

    const newName = (locked.payload?.newName || '').trim();
    if (!newName) {
      await client.query('ROLLBACK');
      log.warn('issues', 'Rename proposal missing newName', { issueId: issue.id });
      return { applied: false, upCount, majority, active };
    }

    const { rows: appRows } = await client.query(
      'SELECT id, name, slug FROM apps WHERE id = $1 FOR UPDATE',
      [locked.app_id]
    );
    if (!appRows.length) {
      await client.query('ROLLBACK');
      return { applied: false, upCount, majority, active };
    }
    const app = appRows[0];
    const oldName = app.name;

    await client.query('UPDATE apps SET name = $1 WHERE id = $2', [newName, app.id]);

    const auditPayload = { ...locked.payload, appliedAt: new Date().toISOString(), appliedBy: 'group-vote', upCount, active };
    await client.query(
      `UPDATE issues SET status = 'closed', payload = $1 WHERE id = $2`,
      [JSON.stringify(auditPayload), locked.id]
    );

    await client.query('COMMIT');

    // Side effects (chat + GitHub + WS) are best-effort and live outside the txn.
    await sendSystemMessage(pool, app.id,
      `App renamed from "${oldName}" to "${newName}" by group vote (${upCount}/${active})`,
      'system'
    ).catch((err) => log.warn('issues', 'Rename chat message failed', { err: err.message }));

    if (locked.github_issue_number) {
      // Prefer the PAT (bot token) here — its scopes are known-good for
      // issue mutation, whereas the GitHub App installation token may lack
      // `Issues: Write`. Close BEFORE commenting so a stale "renamed"
      // comment can't land on an issue we failed to close.
      const { rows: r } = await pool.query('SELECT repo_url FROM apps WHERE id = $1', [app.id]);
      const repoUrl = r[0]?.repo_url || '';
      const [, owner, repo] = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      const pat = process.env.GITHUB_BOT_TOKEN;

      if (owner && repo && pat) {
        try {
          const { Octokit } = await import('@octokit/rest');
          const ok = new Octokit({ auth: pat });

          await ok.rest.issues.update({
            owner, repo, issue_number: locked.github_issue_number, state: 'closed',
          });
          log.info('issues', 'GitHub issue closed', {
            repo: `${owner}/${repo}`, issue: locked.github_issue_number,
          });

          // Best-effort audit comment after the close succeeds.
          await ok.rest.issues.createComment({
            owner, repo, issue_number: locked.github_issue_number,
            body: github.safeMention(`Applied by majority vote (${upCount}/${active}). App renamed to "${newName}".`),
          }).catch((err) => log.warn('issues', 'Rename comment failed', {
            issue: locked.github_issue_number, status: err.status, err: err.message,
          }));
        } catch (err) {
          log.warn('issues', 'GitHub issue close failed', {
            issue: locked.github_issue_number,
            status: err.status,
            err: err.message || '(empty)',
          });
        }
      } else if (locked.github_issue_number) {
        log.warn('issues', 'Skipping GitHub issue close (missing repo_url or GITHUB_BOT_TOKEN)', {
          issue: locked.github_issue_number, repoUrl, hasPat: !!pat,
        });
      }
    }

    pushAppUpdate({ action: 'renamed', appId: app.id, slug: app.slug, oldName, newName });

    log.info('issues', 'Rename applied', { appId: app.id, oldName, newName, upCount, active });
    return { applied: true, newName, oldName, upCount, majority, active };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    log.error('issues', 'Rename apply failed', { issueId: issue.id, err: err.message });
    return { applied: false, error: err.message };
  } finally {
    client.release();
  }
}

module.exports = { issueRoutes };
