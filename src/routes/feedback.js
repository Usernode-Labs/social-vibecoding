const crypto = require('crypto');
const express = require('express');
const { Router } = require('express');
const log = require('../services/logger');
const llm = require('../services/llm');
const limits = require('../services/limits');
const github = require('../services/github');
const { announceIssueCreated } = require('../services/issue-announce');
const { getPool } = require('../db/pool');
const { sniffImageType } = require('../services/attachments');
const { feedbackTitleLimiter, issueScreenshotLimiter } = require('../middleware/rate-limits');

// #683: feedback-modal screenshot attachments. Uploads are raw bytes
// (application/octet-stream — deliberately sidesteps the global 100 KB
// express.json() parser, same reasoning as dev-chat attachments), sniffed
// to PNG/JPEG by magic bytes, capped at 4 MB, and stored bytea-in-Postgres
// (issue_screenshots). At filing time POST /api/feedback links the row to
// the created issue and appends the public embed line the coding agents
// and GitHub's camo proxy can fetch (GET /issue-images/:id).
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const SCREENSHOT_ID_RE = /^[a-f0-9]{32}$/;

// Pure (exported for tests): validate an uploaded screenshot body.
// Returns { ok: true, contentType } or { ok: false, error }.
function validateScreenshotUpload(data) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    return { ok: false, error: 'Empty upload' };
  }
  if (data.length > MAX_SCREENSHOT_BYTES) {
    return {
      ok: false,
      error: `Screenshot too large (max ${Math.round(MAX_SCREENSHOT_BYTES / 1024 / 1024)} MB)`,
    };
  }
  const contentType = sniffImageType(data);
  if (contentType !== 'image/png' && contentType !== 'image/jpeg') {
    return { ok: false, error: 'Screenshot must be a PNG or JPEG image' };
  }
  return { ok: true, contentType };
}

// Pure (exported for tests): the exact markdown suffix appended to the
// issue body for an attached screenshot.
function buildScreenshotEmbed(id, domain) {
  return `\n\n**Screenshot:**\n![Screenshot](https://${domain}/issue-images/${id})`;
}

// #685: app-provided state snapshots ("Include app state" checkbox).
// The bridge caps the serialized snapshot at 32,768 chars client-side;
// 40,000 is a defensive server ceiling that keeps the JSON request body
// under the global 100 KB express.json() limit and the final issue body
// (description ≤ 2,000 chars + this) under GitHub's 65,536-char maximum.
const MAX_PAGE_STATE_CHARS = 40000;

// Pure (exported for tests): the collapsed <details> suffix appended to
// the issue body for an app-provided state snapshot. Four-backtick fence
// so snapshot content containing ``` can't break out of the block.
function buildPageStateEmbed(pageState, truncated) {
  const summary = `App state snapshot (provided by the app${truncated ? ', truncated' : ''})`;
  return `\n\n<details>\n<summary>${summary}</summary>\n\n\`\`\`\`json\n${pageState}\n\`\`\`\`\n</details>`;
}

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

// #125 announce (cache seed + issue_update broadcast) lives in
// services/issue-announce.js — shared with the platform-issue draft
// confirm path in routes/sessions.js.

function feedbackRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const { owner: feedbackOwner, repo: feedbackRepo } = parseGitHubRepo(config.platformRepoUrl);

  // #556: live title preview for the feedback modal. The FE debounces
  // calls while the user types the description and fills the editable
  // Title field with the result; whatever ends up in that field is what
  // POST /api/feedback below receives. Soft-degrades on every failure
  // mode — LLM unavailable or a failed generation is a 200 with
  // `title: null`, because an empty Title field is a fully working
  // state (the server names the issue at submit time as before).
  router.post('/api/feedback/title', feedbackTitleLimiter, async (req, res) => {
    const { description } = req.body || {};
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return res.status(400).json({ error: 'Description is required' });
    }
    if (description.length > 2000) {
      return res.status(400).json({ error: 'Description too long (max 2000 chars)' });
    }
    if (!llm.isEnabled()) {
      return res.json({ title: null, note: 'unavailable' });
    }
    try {
      const gen = await llm.generateIssueTitle({ description });
      // Same ledger posture as the filing path below: record the Haiku
      // spend against the user's daily ledger, but don't budget-gate —
      // it's a few dozen tokens, and the per-user limiter plus the FE's
      // debounce/dirty/cap logic bound repetition.
      if (gen.usage && req.user?.id) {
        const costCents = llm.estimateCostCents(gen.usage, gen.model);
        await limits.recordSpend(pool, req.user.id, costCents, { byok: false });
      }
      // Defensive clip to the Title field's maxlength; Haiku's 5-10-word
      // titles never approach it.
      res.json({ title: gen.title.slice(0, 200) });
    } catch (err) {
      log.warn('feedback', 'Title preview generation failed', { message: err.message });
      res.json({ title: null, note: 'failed' });
    }
  });

  // #683: screenshot upload for the feedback modal. Upload happens
  // BEFORE submit: the client POSTs the captured image's raw bytes here,
  // gets back an id, and passes it as `screenshotId` to /api/feedback
  // below, which links the row to the filed issue. Rows never linked are
  // GC'd by the server.js orphan sweeper after 24h.
  router.post(
    '/api/feedback/screenshot',
    issueScreenshotLimiter,
    // Limit must exceed the 4 MB screenshot cap so over-cap uploads get
    // the friendly 400 from validateScreenshotUpload, not a parser 413.
    express.raw({ type: 'application/octet-stream', limit: '5mb' }),
    async (req, res) => {
      try {
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const verdict = validateScreenshotUpload(data);
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        const id = crypto.randomBytes(16).toString('hex');
        await pool.query(
          `INSERT INTO issue_screenshots (id, user_id, content_type, size_bytes, data)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, req.user.id, verdict.contentType, data.length, data]
        );
        return res.json({ id });
      } catch (err) {
        log.error('feedback', 'Screenshot upload failed', { message: err.message });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  router.post('/api/feedback', async (req, res) => {
    const { description, appSlug } = req.body;
    if (!description || typeof description !== 'string' || description.trim().length === 0) {
      return res.status(400).json({ error: 'Description is required' });
    }
    if (description.length > 2000) {
      return res.status(400).json({ error: 'Description too long (max 2000 chars)' });
    }

    // #556: optional user-chosen title. When present (non-empty after
    // trim) it is used verbatim and the Haiku naming call is skipped
    // entirely; when absent/blank the title is auto-generated as before.
    // Over-long titles are rejected rather than silently clipped.
    let customTitle = null;
    if (req.body.title !== undefined && req.body.title !== null && req.body.title !== '') {
      if (typeof req.body.title !== 'string') {
        return res.status(400).json({ error: 'title must be a string' });
      }
      if (req.body.title.length > 200) {
        return res.status(400).json({ error: 'Title too long (max 200 chars)' });
      }
      customTitle = req.body.title.trim() || null;
    }

    // #683: optional attached screenshot. Must be a 32-hex id referencing
    // an existing, not-yet-linked upload owned by this user — verified
    // before any GitHub call so a bad id fails fast and files nothing.
    let screenshotId = null;
    if (req.body.screenshotId !== undefined && req.body.screenshotId !== null && req.body.screenshotId !== '') {
      const sid = req.body.screenshotId;
      if (typeof sid !== 'string' || !SCREENSHOT_ID_RE.test(sid)) {
        return res.status(400).json({ error: 'Invalid screenshotId' });
      }
      try {
        const { rows } = await pool.query(
          `SELECT 1 FROM issue_screenshots
            WHERE id = $1 AND user_id = $2 AND issue_number IS NULL`,
          [sid, req.user?.id]
        );
        if (!rows.length) {
          return res.status(400).json({ error: 'Unknown or already-used screenshot' });
        }
      } catch (err) {
        log.error('feedback', 'Screenshot lookup failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
      screenshotId = sid;
    }

    // #685: optional app-provided state snapshot. Validated whenever
    // present (a bad payload fails fast, before any GitHub call), but
    // only honored for app-targeted feedback below — the shell itself
    // has no provider, so it's silently ignored for platform feedback.
    let pageState = null;
    let pageStateTruncated = false;
    if (req.body.pageState !== undefined && req.body.pageState !== null && req.body.pageState !== '') {
      if (typeof req.body.pageState !== 'string') {
        return res.status(400).json({ error: 'pageState must be a string' });
      }
      if (req.body.pageState.length > MAX_PAGE_STATE_CHARS) {
        return res.status(400).json({ error: 'pageState too large' });
      }
      pageState = req.body.pageState;
      // Client-asserted, cosmetic only (drives the "truncated" label in
      // the <summary> line).
      pageStateTruncated = req.body.pageStateTruncated === true;
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
      // Title via the shared Haiku helper (services/llm.js) — unless the
      // user supplied one themselves (#556), in which case their exact
      // title is used and no LLM call is made. On any generation failure
      // (LLM disabled, credits exhausted, API error) the issue is still
      // filed with the fallback template — feedback must never block on
      // LLM availability — and `titleFallback` drives a title_heal_queue
      // row below so the sweeper regenerates the title later.
      let title = llm.FEEDBACK_FALLBACK_TITLE;
      let titleFallback = true;
      if (customTitle) {
        title = customTitle;
        titleFallback = false;
      } else {
        try {
          const gen = await llm.generateIssueTitle({ description });
          title = gen.title;
          titleFallback = false;
          // Track this Haiku call against the user's daily ledger even though
          // we don't budget-gate it (it's a few dozen tokens per feedback).
          // Without this, the user could spam /api/feedback for a small but
          // unbounded platform spend off-budget. No-op when usage is missing
          // or user_id is unset (e.g. anonymous feedback in the future).
          if (gen.usage && req.user?.id) {
            const costCents = llm.estimateCostCents(gen.usage, gen.model);
            await limits.recordSpend(pool, req.user.id, costCents, { byok: false });
          }
        } catch (err) {
          log.warn('feedback', 'Title generation failed; filing with fallback title', { message: err.message });
        }
      }

      // Queue the filed issue for title regeneration (services/title-heal.js).
      // Best-effort: a queue failure must never fail the request — the
      // issue is already on GitHub by the time this runs.
      const queueTitleHeal = async (owner, repo, issueNumber) => {
        if (!titleFallback) return;
        try {
          await pool.query(
            `INSERT INTO title_heal_queue (owner, repo, issue_number, description)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (owner, repo, issue_number) DO NOTHING`,
            [owner, repo, issueNumber, description.trim()]
          );
        } catch (err) {
          log.warn('feedback', 'Failed to queue title heal', { repo: `${owner}/${repo}`, issueNumber, message: err.message });
        }
      };

      // #683: server-appended embed line for the attached screenshot —
      // the public /issue-images/:id URL GitHub's camo proxy, the in-app
      // topic view, and the coding agents can all fetch. Appended after
      // the description-length validation, so it never eats user budget.
      const screenshotSuffix = screenshotId
        ? buildScreenshotEmbed(screenshotId, require('../services/caddy').USERNODE_DOMAIN)
        : '';
      // Stamp the row with the filed issue so the orphan GC skips it.
      // Best-effort: the issue is already on GitHub by the time this
      // runs, so a failure only risks the image 404ing after the 24h
      // sweep — never a failed request.
      const linkScreenshot = async (owner, repo, issueNumber) => {
        if (!screenshotId) return;
        try {
          await pool.query(
            `UPDATE issue_screenshots
                SET issue_owner = $2, issue_repo = $3, issue_number = $4
              WHERE id = $1`,
            [screenshotId, owner, repo, issueNumber]
          );
        } catch (err) {
          log.warn('feedback', 'Screenshot link failed', { screenshotId, message: err.message });
        }
      };

      // App-targeted feedback files into the app's own repo, which the
      // bot reaches through the GitHub App installation (same path as
      // routes/issues.js) rather than the platform PAT — the PAT isn't
      // guaranteed to have access to every app repo.
      if (target === 'app') {
        // #685: the collapsed state-snapshot block goes last, after the
        // screenshot embed, so it never buries the description.
        const pageStateSuffix = pageState
          ? buildPageStateEmbed(pageState, pageStateTruncated)
          : '';
        const body = `**Source:** ${source}\n**App:** ${appContext.name} (${appContext.slug})\n\n${description.trim()}${screenshotSuffix}${pageStateSuffix}`;
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
        await queueTitleHeal(issueOwner, issueRepo, issue.number);
        await linkScreenshot(issueOwner, issueRepo, issue.number);
        await announceIssueCreated(pool, issueOwner, issueRepo, issue, appContext);
        return res.json({ url: issue.html_url, title, titleFallback });
      }

      const ghRes = await fetch(`https://api.github.com/repos/${issueOwner}/${issueRepo}/issues`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `token ${pat}`,
          'User-Agent': 'usernode-social-vibecoding',
        },
        // This hand-rolled fetch bypasses github.js's write helpers, so
        // apply safeMention here — the user-typed description/title are
        // free-form text that could carry live @mentions (#723).
        body: JSON.stringify({
          title: github.safeMention(title),
          body: github.safeMention(`**Source:** ${source}\n\n${description.trim()}${screenshotSuffix}`),
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
      await queueTitleHeal(issueOwner, issueRepo, issue.number);
      await linkScreenshot(issueOwner, issueRepo, issue.number);
      // Platform feedback: the platform repo is itself an app on
      // self-hosted instances, so its Open Issues panel should refresh
      // too. announceIssueCreated resolves the app row by repo (no-op
      // when none matches).
      await announceIssueCreated(pool, issueOwner, issueRepo, issue, null);
      res.json({ url: issue.html_url, title, titleFallback });
    } catch (err) {
      log.error('feedback', 'Error filing issue', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  feedbackRoutes,
  // #683: pure helpers exported for tests/issue-screenshots.test.js.
  validateScreenshotUpload,
  buildScreenshotEmbed,
  MAX_SCREENSHOT_BYTES,
  // #685: pure helpers exported for tests/feedback-page-state.test.js.
  buildPageStateEmbed,
  MAX_PAGE_STATE_CHARS,
};
