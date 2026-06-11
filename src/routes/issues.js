const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const { sendSystemMessage, pushAppUpdate, pushIssueUpdate } = require('../services/ws');
const { getActiveUserStats } = require('../services/active-users');
const { isAppLocked, hasAdminUpVote } = require('../services/admin-approval');
const appManifest = require('../services/app-manifest');
const appSecrets = require('../services/app-secrets');
const staging = require('../services/staging');
const { encrypt, decrypt } = require('../services/secrets');
const { issueCreateLimiter } = require('../middleware/rate-limits');
const events = require('../services/events');
const { weekStartUtc, countWeeklyAllowanceUsed, WEEKLY_KUDOS_LIMIT } = require('./kudos');
const appAccess = require('../services/app-access');

// Pull owner/repo out of a stored repo_url. Same shape used across the
// codebase (e.g. the rename-apply path below, routes/votes.js).
function parseOwnerRepo(repoUrl) {
  const [, owner, repo] = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo } : null;
}

// #136: platform-filed GitHub issues are authored by the bot account, but
// the real creator is recorded in the body's first "**Source:**" line
// (written by routes/feedback.js): "usernode user (name)" for regular
// users, "usernode admin (name)" for admins (#140; older issues used a
// bare "usernode admin" with no name). Returns the creator's display name
// or null when no Source line can be parsed.
function creatorFromSourceLine(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/\*\*Source:\*\*\s*([^\n]+)/);
  if (!m) return null;
  const source = m[1].trim();
  const named = source.match(/^usernode (?:user|admin) \(([^)]+)\)/);
  if (named) return named[1];
  if (/^usernode admin\b/.test(source)) return 'admin';
  return null;
}

// Renames are no longer an issue kind — they open a dapp.json `name` PR
// via POST /api/apps/:slug/rename (see src/routes/apps.js). The vote-apply
// path below (maybeApplyRenameProposal) is retained only so any rename
// issues already open at rollout can still resolve.
const VALID_KINDS = ['general', 'secret_change'];
const MAX_SECRET_VALUE_LENGTH = 4096;

// #132: should this issue kind get a GitHub twin on the app's repo?
// Env-var change proposals (kind='secret_change') are in-app governance —
// they're proposed, voted, applied, and audited entirely on the platform,
// so opening a "Set secret …" issue on GitHub just pollutes the repo's
// issue list (GitHub issues are reserved for real issues). Everything
// downstream already tolerates a null github_issue_number: the apply path
// guards its close/comment on it, and the UI omits the kudos button when
// no twin exists.
function shouldCreateGithubTwin(kind) {
  return kind !== 'secret_change';
}

function issueRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Per-app visibility gate for issue-id-addressed routes (/vote,
  // /close): collab-level access via the issue's app, 404 on deny.
  router.use('/api/issues/:id', appAccess.issueCollabGuard(pool));

  // List issues for an app
  router.get('/api/apps/:slug/issues', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });

      const appId = gatedApp.id;

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

      // Strip ciphertext from secret_change rows before serializing —
      // the value should never be readable from this endpoint, even
      // by other admins. The committed value lands in app_secrets via
      // maybeApplySecretChangeProposal once the vote passes.
      const sanitized = rows.map((r) => {
        if (r.kind !== 'secret_change' || !r.payload) return r;
        const { valueEnc, ...rest } = r.payload;
        return { ...r, payload: { ...rest, hasValue: !!valueEnc } };
      });

      res.json({ issues: sanitized, activeUsers, majority });
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
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab');
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Kind-specific validation + auto-filled title/description.
      if (kind === 'secret_change') {
        const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
        const action = typeof payload?.action === 'string' ? payload.action : 'set';
        const value = typeof payload?.value === 'string' ? payload.value : '';
        if (!appManifest.KEY_RE.test(key)) {
          return res.status(400).json({ error: 'payload.key must be UPPER_SNAKE_CASE' });
        }
        if (appManifest.RESERVED_KEYS.has(key)) {
          return res.status(400).json({ error: `${key} is reserved by the platform` });
        }
        if (!['set', 'delete'].includes(action)) {
          return res.status(400).json({ error: 'payload.action must be "set" or "delete"' });
        }
        if (action === 'set' && (!value.length || value.length > MAX_SECRET_VALUE_LENGTH)) {
          return res.status(400).json({
            error: `payload.value is required and must be \u2264 ${MAX_SECRET_VALUE_LENGTH} chars`,
          });
        }

        const manifest = (app.manifest_snapshot && typeof app.manifest_snapshot === 'object')
          ? app.manifest_snapshot : { secrets: [] };
        const declared = (manifest.secrets || []).find((s) => s.key === key);
        // `private` is canonical; manifest.read() also accepts the
        // legacy `sensitive` alias and normalizes to `.private`.
        const isPrivate = !!declared?.private;

        // Encrypt the proposed value before it ever lands in the DB.
        // Even other admins reading the issues table see only ciphertext;
        // the GET /api/apps/:slug/issues route strips it from the
        // payload before serializing (see further below).
        const valueEnc = action === 'set' ? encrypt(value, config.jwtSecret) : null;
        const valueLast4 = action === 'set' && !isPrivate
          ? value.slice(-4) : null;

        // Persist BOTH `private` (canonical) and `sensitive` (BC) on the
        // issue payload so any in-flight issue serialized by an older
        // build keeps deserializing cleanly when the votes complete.
        payload = { key, action, valueEnc, valueLast4, private: isPrivate, sensitive: isPrivate };
        title = action === 'delete'
          ? `Remove secret "${key}"`
          : `Set secret "${key}"`;
        description = description?.trim() ||
          `${req.user.username} (via Usernode) proposed ${
            action === 'delete' ? 'removing' : 'setting'
          } the env var "${key}". Auto-applies + redeploys when a majority of active users vote up.`;
      } else {
        if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
        title = title.trim();
        description = description || null;
        payload = typeof payload === 'object' && payload ? payload : {};
      }

      // GitHub twin — skipped for secret_change proposals (see
      // shouldCreateGithubTwin): env-var proposals are in-app governance,
      // not repo issues (#132). githubIssueNumber stays null for them,
      // which the INSERT, chat message, and vote-apply path all handle.
      let githubIssueNumber = null;
      if (github.isEnabled() && app.repo_url && shouldCreateGithubTwin(kind)) {
        try {
          const [, owner, repo] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
          if (owner && repo) {
            const ghIssue = await github.createIssue(owner, repo, {
              title,
              body: description || '',
            });
            githubIssueNumber = ghIssue.number;
            // #125: seed the open-issues cache so the panel refresh the
            // pushIssueUpdate below triggers (loadVotePanel → GET
            // /github-issues) shows this issue immediately instead of
            // waiting out the cache TTL.
            github.noteIssueCreated(owner, repo, ghIssue);
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

      let chatPrefix;
      if (kind === 'secret_change') {
        chatPrefix = payload.action === 'delete'
          ? `${req.user.username} proposed removing secret ${payload.key}`
          : `${req.user.username} proposed setting secret ${payload.key}`;
      } else {
        chatPrefix = `${req.user.username} created issue: "${title}"`;
      }
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

      let voteSubject;
      if (issue.kind === 'rename') {
        voteSubject = `rename proposal "${issue.payload?.newName || issue.title}"`;
      } else if (issue.kind === 'secret_change') {
        const action = issue.payload?.action === 'delete' ? 'removal' : 'change';
        voteSubject = `secret ${action} "${issue.payload?.key || issue.title}"`;
      } else {
        voteSubject = `issue: "${issue.title}"`;
      }
      await sendSystemMessage(pool, issue.app_id,
        `${req.user.username} voted ${vote} on ${voteSubject}`,
        'vote'
      );

      let renamed = null;
      let secretChanged = null;
      if (vote === 'up' && issue.kind === 'rename') {
        renamed = await maybeApplyRenameProposal(pool, issue);
      } else if (vote === 'up' && issue.kind === 'secret_change') {
        secretChanged = await maybeApplySecretChangeProposal(config, pool, issue);
      }

      pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id, vote });

      res.json({ ok: true, renamed, secretChanged });
    } catch (err) {
      log.error('issues', 'Vote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // GET /api/apps/:slug/github-issues
  //
  // Lists the repo's OPEN GitHub issues (via github.fetchPublicIssues —
  // anonymous, cached, never-throws) for the "Open Issues" activity-panel
  // section. Augments each issue with this app's OPEN-bounty count and a
  // per-viewer `my_bounty` flag, the issue's creating user
  // (`created_by_username`, #133), plus the viewer's remaining weekly kudos
  // allowance so the FE can disable the "Give kudos" button when the shared
  // budget is spent. Distinct from the platform-internal `issues` table
  // (governance proposals) listed by GET /api/apps/:slug/issues above.
  // ----------------------------------------------------------------
  router.get('/api/apps/:slug/github-issues', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const parsed = parseOwnerRepo(app.repo_url);
      if (!github.isEnabled() || !parsed) {
        return res.json({ issues: [], truncatedList: false, note: 'unavailable' });
      }

      // fetchPublicIssues never throws and never returns null; on any
      // failure mode it returns { issues:[], truncatedList:false, note }.
      const result = await github.fetchPublicIssues(parsed.owner, parsed.repo);

      // Open-bounty tallies for this app, keyed by issue number, in one
      // round-trip. BOOL_OR gives the viewer's own-open-bounty flag.
      const { rows: bountyRows } = await pool.query(
        `SELECT github_issue_number AS n,
                COUNT(*)::int AS cnt,
                BOOL_OR(giver_user_id = $2) AS mine
           FROM issue_bounties
          WHERE app_id = $1 AND status = 'open'
          GROUP BY github_issue_number`,
        [app.id, req.user.id]
      );
      const byNumber = new Map(bountyRows.map((r) => [r.n, r]));

      // #133/#136: resolve each issue's creating user so the panel can show
      // it next to the title the way PR rows show their author. Platform-
      // filed issues record created_by in the local issues table; feedback-
      // filed ones carry the creator in the body's "**Source:**" line
      // (the "usernode user (name)" / "usernode admin (name)" forms, plus
      // the legacy bare "usernode admin" written before #140);
      // issues opened directly on GitHub fall back to the GitHub login —
      // but never the platform bot account itself, which would just name
      // "usernode-bot" on every platform-filed row.
      const { rows: creatorRows } = await pool.query(
        `SELECT i.github_issue_number AS n, u.username
           FROM issues i JOIN users u ON u.id = i.created_by
          WHERE i.app_id = $1 AND i.github_issue_number IS NOT NULL`,
        [app.id]
      );
      const creatorByNumber = new Map(creatorRows.map((r) => [r.n, r.username]));

      const issues = (result.issues || []).map((issue) => {
        const b = byNumber.get(issue.number);
        const ghLogin = issue.user && !issue.user.endsWith('[bot]') && issue.user !== 'usernode-bot'
          ? issue.user
          : null;
        return {
          ...issue,
          bounty_count: b ? b.cnt : 0,
          my_bounty: b ? !!b.mine : false,
          created_by_username: creatorByNumber.get(issue.number)
            || creatorFromSourceLine(issue.body)
            || ghLogin,
        };
      });

      const used = await countWeeklyAllowanceUsed(pool, req.user.id, weekStartUtc());
      const myRemaining = Math.max(0, WEEKLY_KUDOS_LIMIT - used);

      res.json({
        issues,
        truncatedList: !!result.truncatedList,
        ...(result.note ? { note: result.note } : {}),
        myRemaining,
        limit: WEEKLY_KUDOS_LIMIT,
      });
    } catch (err) {
      log.error('issues', 'Failed to list GitHub issues', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // POST /api/apps/:slug/issues/:number/bounty
  //
  // Place a "Give kudos" bounty on a GitHub issue. A bounty is a symbolic
  // off-chain pledge (no tokens) that debits the giver's SHARED weekly kudos
  // allowance (the same 5/week cap PR kudos uses, counted across both
  // ledgers). When a merged PR closes this issue, the open bounty is awarded
  // to that PR's author (see routes/votes.js checkAndMerge).
  //
  // Status codes:
  //   200 ok        — bounty recorded; body carries { remaining, limit }
  //   400 bad input — non-positive issue number
  //   404 not_found — app doesn't exist
  //   409 conflict  — viewer already has an open bounty on this issue
  //   429 too_many  — shared weekly kudos allowance exhausted
  // ----------------------------------------------------------------
  router.post('/api/apps/:slug/issues/:number/bounty', async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Verify :number is a CURRENTLY OPEN GitHub issue on this repo BEFORE
      // spending quota, inserting a row, or posting chat noise. Otherwise a
      // user could bounty a closed/nonexistent issue and a later PR carrying
      // `Closes #N` would award that fake/stale bounty. fetchPublicIssues
      // never throws and surfaces degraded fetches via a `note`; if we can't
      // positively confirm the issue is open (closed, nonexistent, or GitHub
      // unavailable) we refuse and change nothing.
      const parsed = parseOwnerRepo(app.repo_url);
      if (!github.isEnabled() || !parsed) {
        return res.status(422).json({
          error: 'Cannot verify the issue right now — GitHub is unavailable for this app.',
        });
      }
      const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
      if (ghResult.note) {
        // 'rate limited' / 'issues unavailable' / 'fetch failed' — no
        // positive confirmation the issue is open.
        return res.status(422).json({
          error: "Couldn't confirm this issue is open right now. Try again in a moment.",
        });
      }
      const isOpen = (ghResult.issues || []).some((i) => i.number === issueNumber);
      if (!isOpen) {
        return res.status(404).json({
          error: `Issue #${issueNumber} isn't an open issue on this repo.`,
        });
      }

      const weekStart = weekStartUtc();

      // Shared weekly allowance check. Same bounded race as the PR-kudos
      // give path (two parallel POSTs could each pass and overshoot by ≤1);
      // not security-critical, documented there.
      const used = await countWeeklyAllowanceUsed(pool, req.user.id, weekStart);
      if (used >= WEEKLY_KUDOS_LIMIT) {
        return res.status(429).json({
          error: `Weekly kudos quota exceeded (${WEEKLY_KUDOS_LIMIT}/week). Resets every Monday 00:00 UTC.`,
          remaining: 0,
          limit: WEEKLY_KUDOS_LIMIT,
        });
      }

      let inserted;
      try {
        const { rows } = await pool.query(
          `INSERT INTO issue_bounties (app_id, github_issue_number, giver_user_id, week_start, status)
           VALUES ($1, $2, $3, $4, 'open')
           RETURNING id, created_at`,
          [app.id, issueNumber, req.user.id, weekStart]
        );
        inserted = rows[0];
      } catch (err) {
        // Partial unique index on open bounties → already pledged.
        if (err.code === '23505') {
          return res.status(409).json({ error: 'You already placed a bounty on this issue' });
        }
        throw err;
      }

      events.record(pool, {
        type: events.EVENT_TYPES.BOUNTY_CREATED,
        userId: req.user.id,
        appId: app.id,
        metadata: { issueNumber },
      });

      // Open-bounty count for this issue after the insert, for live FE update.
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM issue_bounties
          WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open'`,
        [app.id, issueNumber]
      );
      const bountyCount = countRows[0]?.c || 0;

      await sendSystemMessage(pool, app.id,
        `${req.user.username} placed a bounty (kudos) on issue #${issueNumber}`,
        'system'
      ).catch((err) => log.warn('issues', 'Bounty chat message failed', { err: err.message }));

      pushIssueUpdate({
        action: 'bounty', appSlug: app.slug, appId: app.id,
        issueNumber, bountyCount,
      });

      const remaining = Math.max(0, WEEKLY_KUDOS_LIMIT - (used + 1));
      log.info('issues', 'Bounty created', { appId: app.id, issueNumber, giverId: req.user.id, remaining });
      res.json({ ok: true, bountyId: inserted.id, bountyCount, remaining, limit: WEEKLY_KUDOS_LIMIT });
    } catch (err) {
      log.error('issues', 'Bounty create failed', { issueNumber, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Admin force-apply for secret_change proposals — the issue-side
  // counterpart of POST /api/sessions/:id/admin-merge. Lets an admin
  // apply an environment-variable proposal right now, bypassing the
  // active-user majority (and the locked-app admin-up gate, which is
  // trivially satisfied by the admin acting). Same visibility rules:
  // the chat message + GitHub comment name the admin so the override
  // is never silent.
  router.post('/api/issues/:id/admin-apply', async (req, res) => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    try {
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
      if (issue.kind !== 'secret_change') {
        return res.status(400).json({ error: 'Only secret-change proposals can be admin-applied' });
      }

      log.info('issues', 'Admin force-apply requested', {
        issueId: issue.id, by: req.user.username,
      });

      const secretChanged = await maybeApplySecretChangeProposal(config, pool, issue, {
        force: true, forceBy: req.user,
      });

      pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id });

      res.json({ ok: true, secretChanged });
    } catch (err) {
      log.error('issues', 'Admin force-apply failed', { message: err.message });
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

  // Locked apps additionally require at least one admin up vote (see
  // services/admin-approval.js + the apps.locked column). The majority
  // gate above still has to pass — the admin up is an extra condition.
  if (await isAppLocked(pool, issue.app_id)) {
    const adminUp = await hasAdminUpVote(pool, issue.id);
    if (!adminUp) {
      log.info('issues', 'Rename majority reached but app is locked; awaiting admin up', {
        issueId: issue.id, upCount, majority,
      });
      return { applied: false, upCount, majority, active, awaitingAdmin: true };
    }
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

/**
 * Vote-apply path for `kind='secret_change'` issues. Same shape as
 * maybeApplyRenameProposal: count up-votes, lock the issue row, write
 * the change atomically, then trigger an async production rebuild so
 * the new value reaches the running container without a manual step.
 *
 * `options.force` (admin force-apply, POST /api/issues/:id/admin-apply):
 * skip the majority + locked-app gates entirely — the row lock below
 * still prevents a double-apply racing a vote-driven one. `options.forceBy`
 * is the admin user (id, username) named in the chat message, audit
 * payload, and GitHub comment so the override is visible.
 */
async function maybeApplySecretChangeProposal(config, pool, issue, options = {}) {
  const force = !!options.force;
  const { active, majority } = await getActiveUserStats(pool, issue.app_id);

  const { rows: upRows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM issue_votes WHERE issue_id = $1 AND vote = 'up'`,
    [issue.id]
  );
  const upCount = parseInt(upRows[0].cnt, 10) || 0;
  if (!force && upCount < majority) {
    return { applied: false, upCount, majority, active };
  }

  // Locked apps additionally require at least one admin up vote (see
  // services/admin-approval.js + the apps.locked column). Same rule as
  // the rename path above. An admin force-apply trivially satisfies it.
  if (!force && await isAppLocked(pool, issue.app_id)) {
    const adminUp = await hasAdminUpVote(pool, issue.id);
    if (!adminUp) {
      log.info('issues', 'Secret-change majority reached but app is locked; awaiting admin up', {
        issueId: issue.id, upCount, majority,
      });
      return { applied: false, upCount, majority, active, awaitingAdmin: true };
    }
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
    const payload = locked.payload || {};
    const key = (payload.key || '').trim();
    const action = payload.action === 'delete' ? 'delete' : 'set';
    if (!key) {
      await client.query('ROLLBACK');
      log.warn('issues', 'Secret-change proposal missing key', { issueId: issue.id });
      return { applied: false, upCount, majority, active };
    }

    if (action === 'set') {
      const valueEnc = payload.valueEnc || null;
      const plaintext = valueEnc ? decrypt(valueEnc, config.jwtSecret) : null;
      if (!plaintext) {
        await client.query('ROLLBACK');
        log.warn('issues', 'Secret-change proposal could not decrypt value', { issueId: issue.id });
        return { applied: false, upCount, majority, active };
      }
      // Read canonical `private`, fall back to `sensitive` for issues
      // proposed by an older build before the field was renamed.
      const isPrivate = !!(payload.private || payload.sensitive);
      const valueLast4 = isPrivate ? null : plaintext.slice(-4);
      // Re-encrypt to ensure the stored row uses a fresh IV (the
      // payload ciphertext was captured at proposal time).
      const reEnc = encrypt(plaintext, config.jwtSecret);
      await client.query(
        `INSERT INTO app_secrets (app_id, key, value_enc, value_last4, updated_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (app_id, key)
         DO UPDATE SET value_enc = EXCLUDED.value_enc,
                       value_last4 = EXCLUDED.value_last4,
                       updated_at = NOW(),
                       updated_by = EXCLUDED.updated_by`,
        [issue.app_id, key, reEnc, valueLast4, locked.created_by || null]
      );
    } else {
      await client.query(
        'DELETE FROM app_secrets WHERE app_id = $1 AND key = $2',
        [issue.app_id, key]
      );
    }

    // Strip the ciphertext from the audit-trail payload so a closed
    // issue doesn't leave behind any reversible data. The audit
    // metadata (who, when, how many votes) is what matters here.
    const auditPayload = {
      key, action,
      private: !!(payload.private || payload.sensitive),
      sensitive: !!(payload.private || payload.sensitive),
      valueLast4: payload.valueLast4 || null,
      appliedAt: new Date().toISOString(),
      appliedBy: force ? `admin:${options.forceBy?.username || 'unknown'}` : 'group-vote',
      upCount, active,
    };
    await client.query(
      `UPDATE issues SET status = 'closed', payload = $1 WHERE id = $2`,
      [JSON.stringify(auditPayload), locked.id]
    );

    await client.query('COMMIT');

    // Side effects (chat + redeploy + GitHub close) live outside the txn.
    const verb = action === 'delete' ? 'removed' : 'set';
    const appliedHow = force
      ? `by admin override (${options.forceBy?.username || 'admin'})`
      : `by group vote (${upCount}/${active})`;
    await sendSystemMessage(pool, issue.app_id,
      `Secret "${key}" ${verb} ${appliedHow}; redeploying…`,
      'system'
    ).catch((err) => log.warn('issues', 'Secret-change chat msg failed', { err: err.message }));

    // Auto-redeploy: same fan-out the drift poller and dev-chat merge use.
    // Failures (including MissingSecretsError if the dapp still requires
    // additional unset keys) propagate via the existing deploy-status
    // broadcast and don't poison the vote-apply success.
    pool.query('SELECT * FROM apps WHERE id = $1', [issue.app_id])
      .then(({ rows }) => rows[0] && staging.rebuildProduction(config, rows[0]))
      .then(async (result) => {
        if (!result) return;
        await pool.query(
          `UPDATE apps SET container_id = $1, main_sha = $2, status = 'running',
                           last_deploy_at = NOW()
           WHERE id = $3`,
          [result.containerId, result.sha || null, issue.app_id]
        );
      })
      .catch((err) => {
        log.warn('issues', 'Post-secret-change redeploy failed', {
          slug: issue.app_slug, err: err.message,
        });
      });

    if (locked.github_issue_number) {
      const { rows: r } = await pool.query('SELECT repo_url FROM apps WHERE id = $1', [issue.app_id]);
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
          await ok.rest.issues.createComment({
            owner, repo, issue_number: locked.github_issue_number,
            body: github.safeMention(
              force
                ? `Applied by admin override (${options.forceBy?.username || 'admin'}). Secret "${key}" ${verb}.`
                : `Applied by majority vote (${upCount}/${active}). Secret "${key}" ${verb}.`
            ),
          }).catch(() => {});
        } catch (err) {
          log.warn('issues', 'GitHub issue close (secret-change) failed', {
            issue: locked.github_issue_number, err: err.message,
          });
        }
      }
    }

    log.info('issues', 'Secret change applied', { appId: issue.app_id, key, action, upCount, active, force });
    return { applied: true, key, action, upCount, majority, active, force };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    log.error('issues', 'Secret-change apply failed', { issueId: issue.id, err: err.message });
    return { applied: false, error: err.message };
  } finally {
    client.release();
  }
}

module.exports = { issueRoutes, creatorFromSourceLine, shouldCreateGithubTwin };
