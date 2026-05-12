const { Router } = require('express');
const log = require('../services/logger');

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

function feedbackRoutes(config) {
  const router = Router();
  const { owner: feedbackOwner, repo: feedbackRepo } = parseGitHubRepo(config.platformRepoUrl);

  router.post('/api/feedback', async (req, res) => {
    const { description } = req.body;
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return res.status(400).json({ error: 'Description is required' });
    }
    if (description.length > 2000) {
      return res.status(400).json({ error: 'Description too long (max 2000 chars)' });
    }

    const pat = process.env.GITHUB_BOT_TOKEN;
    if (!pat) {
      return res.status(503).json({ error: 'GitHub token not configured' });
    }

    const source = req.user?.isAdmin ? 'usernode admin' : `usernode user (${req.user?.username || 'unknown'})`;

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
          }
        } catch {}
      }

      const ghRes = await fetch(`https://api.github.com/repos/${feedbackOwner}/${feedbackRepo}/issues`, {
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
      res.json({ url: issue.html_url, title });
    } catch (err) {
      log.error('feedback', 'Error filing issue', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { feedbackRoutes };
