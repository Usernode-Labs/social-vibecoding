const { Router } = require('express');
const log = require('../services/logger');
const llm = require('../services/llm');
const limits = require('../services/limits');
const github = require('../services/github');
const { pushIssueUpdate } = require('../services/ws');
const { getPool } = require('../db/pool');

// Derive `owner/repo` from a github.com URL. We do this at module
// load (well, at route-factory load) so a malformed
// USERNODE_PLATFORM_REPO fails the platform fast at startup rather
// than 500-ing the first time a user clicks "Send feedback".
function parseGitHubRepo(url) {
  const u = new URL(url);
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') {
    throw new Error(`Expected github.com URL, got: ${url}`);
  }
  const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Expected /<owner>/<repo> path, got: ${url}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

// #125: after a feedback issue lands in a repo, make the "Open Issues"
// panel of any app backed by that repo update without a reload. Two
// halves: seed the server-side open-issues cache with the new issue
// (warm path — no extra GitHub list call, no read-after-write lag),
// then broadcast an issue_update so connected clients re-pull the
// panel (App.handleIssueUpdate → AppView.loadVotePanel). `app` is the
// known target row for app feedback, or null for platform feedback —
// in that case we look the app up by repo, since the platform repo is
// itself an app on self-hosted instances. Best-effort: a failure here
// must never fail the request (the issue is already filed).
async function announceIssueCreated(pool, owner, repo, rawIssue, app) {
  try {
    github.noteIssueCreated(owner, repo, rawIssue);
    let target = app;
    if (!target) {
      const { rows } = await pool.query('SELECT id, slug, repo_url FROM apps');
      target = rows.find((r) => {
        const [, o, rp] = (r.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        return o && rp
          && o.toLowerCase() === owner.toLowerCase()
          && rp.replace(/\.git$/, '').toLowerCase() === repo.replace(/\.git$/, '').toLowerCase();
      });
    }
    if (target) {
      pushIssueUpdate({
        action: 'created',
        source: 'github',
        appSlug: target.slug,
        appId: target.id,
        issueNumber: rawIssue.number,
      });
    }
  } catch (err) {
    log.warn('feedback', 'Failed to announce new issue', { repo: `${owner}/${repo}`, message: err.message });
  }
}

function feedbackRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const { owner: feedbackOwner, repo: feedbackRepo } = parseGitHubRepo(config.platformRepoUrl);

  router.post('/api/feedback', async (req, res) => {
    const { description, appSlug } = req.body;
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return res.status(400).json({ error: 'Description is required' });
    }
    if (description.length > 2000) {
      return res.status(400).json({ error: 'Description too long (max 2000 chars)' });
    }

    // Normalise the feedback target. Anything other than the explicit
    // 'app' opt-in falls back to platform feedback (today's behaviour).
    const target = req.body.target === 'app' ? 'app' : 'platform';

    const pat = process.env.GITHUB_BOT_TOKEN;
    if (!pat) {
      return res.status(503).json({ error: 'GitHub token not configured' });
    }

    // Resolve the destination repo up front so we fail fast (before
    // spending a Haiku call on title generation) when the app target is
    // unusable. `appContext` is non-null only for app-targeted feedback.
    let issueOwner = feedbackOwner;
    let issueRepo = feedbackRepo;
    let appContext = null;
    if (target === 'app') {
      if (!appSlug || typeof appSlug !== 'string') {
        return res.status(400).json({ error: 'appSlug is required for app feedback' });
      }
      if (!github.isEnabled()) {
        return res.status(503).json({ error: 'GitHub token not configured' });
      }
      let appRow;
      try {
        const { rows } = await pool.query('SELECT id, slug, name, repo_url FROM apps WHERE slug = $1', [appSlug]);
        appRow = rows[0];
      } catch (err) {
        log.error('feedback', 'App lookup failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
      if (!appRow) {
        return res.status(404).json({ error: 'App not found' });
      }
      const [, owner, repo] = (appRow.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (!owner || !repo) {
        return res.status(409).json({ error: 'This app has no repository yet — try platform feedback' });
      }
      issueOwner = owner;
      issueRepo = repo;
      appContext = { id: appRow.id, slug: appRow.slug, name: appRow.name };
    }

    // #140: include the admin's actual username so the issues panel can show
    // who filed it instead of a bare "admin" (mirrors the user form).
    const source = req.user?.isAdmin
      ? `usernode admin (${req.user?.username || 'unknown'})`
      : `usernode user (${req.user?.username || 'unknown'})`;

    try {
      let title = 'Feedback from Usernode';

      if (config.anthropicApiKey) {
        try {
          const titleRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': config.anthropicApiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5',
              max_tokens: 60,
              messages: [{
                role: 'user',
                content: `Write a short GitHub issue title (5-10 words, no quotes) for this feedback:\n\n${description.trim()}`,
              }],
            }),
          });
          if (titleRes.ok) {
            const data = await titleRes.json();
            const text = data.content?.[0]?.text?.trim();
            if (text) title = text;
            // Track this Haiku call against the user's daily ledger
            // even though we don't budget-gate it (it's a few dozen
            // tokens per feedback). Without this, the user could spam
            // /api/feedback for a small but unbounded platform spend
            // off-budget. No-op when usage is missing or user_id is
            // unset (e.g. anonymous feedback in the future).
            if (data.usage && req.user?.id) {
              const costCents = llm.estimateCostCents(data.usage, 'claude-haiku-4-5');
              await limits.recordSpend(pool, req.user.id, costCents, { byok: false });
            }
          }
        } catch {}
      }

      // App-targeted feedback files into the app's own repo, which the
      // bot reaches through the GitHub App installation (same path as
      // routes/issues.js) rather than the platform PAT — the PAT isn't
      // guaranteed to have access to every app repo.
      if (target === 'app') {
        const body = `**Source:** ${source}\n**App:** ${appContext.name} (${appContext.slug})\n\n${description.trim()}`;
        let issue;
        try {
          issue = await github.createIssue(issueOwner, issueRepo, { title, body });
        } catch (err) {
          log.error('feedback', 'App GitHub issue creation failed', {
            repo: `${issueOwner}/${issueRepo}`,
            message: err.message,
          });
          // Never silently reroute to the platform repo — the user
          // explicitly chose this app. Surface an actionable hint.
          return res.status(502).json({
            error: "Failed to create GitHub issue: couldn't file to this app's repo — the bot may not be installed on it",
          });
        }
        await announceIssueCreated(pool, issueOwner, issueRepo, issue, appContext);
        return res.json({ url: issue.html_url, title });
      }

      const ghRes = await fetch(`https://api.github.com/repos/${issueOwner}/${issueRepo}/issues`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `token ${pat}`,
          'User-Agent': 'usernode-social-vibecoding',
        },
        body: JSON.stringify({
          title,
          body: `**Source:** ${source}\n\n${description.trim()}`,
          labels: ['usernode'],
        }),
      });

      if (!ghRes.ok) {
        const err = await ghRes.text();
        log.error('feedback', 'GitHub API error', { status: ghRes.status, body: err });
        // Surface the underlying status in the client-facing error so we
        // don't have to spelunk server logs to tell "bot has no access to
        // the feedback repo" (404) from "PAT revoked" (401) from rate
        // limiting (403). Never include the raw body — it can leak repo
        // metadata — but the status alone is safe + actionable.
        const hint = ghRes.status === 404
          ? 'feedback repo not visible to the bot — add usernode-bot as a collaborator or install the GitHub App on it'
          : ghRes.status === 401
            ? 'GITHUB_BOT_TOKEN is invalid or expired'
            : ghRes.status === 403
              ? 'bot lacks Issues:write on the feedback repo, or is rate-limited'
              : `GitHub returned ${ghRes.status}`;
        return res.status(502).json({ error: `Failed to create GitHub issue: ${hint}` });
      }

      const issue = await ghRes.json();
      // Platform feedback: the platform repo is itself an app on
      // self-hosted instances, so its Open Issues panel should refresh
      // too. announceIssueCreated resolves the app row by repo (no-op
      // when none matches).
      await announceIssueCreated(pool, issueOwner, issueRepo, issue, null);
      res.json({ url: issue.html_url, title });
    } catch (err) {
      log.error('feedback', 'Error filing issue', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { feedbackRoutes };
