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

// Staging-only mock issues for GET /api/apps/:slug/github-issues. A
// staging preview whose repo has no open issues (or can't reach GitHub
// from the preview container) would render an empty Topics feed in the
// Dev card list, making the UI impossible to review. When the live
// fetch comes back empty in staging, these are served instead — clearly
// "[Mock]"-prefixed so testers know they're synthetic. High numbers
// keep them clear of any real bounty / thread rows in the cloned DB;
// updatedAt is computed per request so the feed's activity sort places
// them naturally. Strictly a no-op in production.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

function stagingMockIssues(repoUrl) {
  const base = (repoUrl || 'https://github.com/example/app')
    .replace(/\.git$/, '').replace(/\/$/, '');
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const mk = (number, title, body, hours) => ({
    number,
    title,
    body,
    labels: ['usernode'],
    updatedAt: hoursAgo(hours),
    htmlUrl: `${base}/issues/${number}`,
    user: 'staging-tester',
  });
  return [
    mk(900001, '[Mock] Dark mode toggle resets after refresh',
      'Staging-only mock issue for previewing the Dev card list.\n\n'
      + 'Steps to reproduce:\n1. Enable dark mode in the header\n'
      + '2. Refresh the page\n3. The app is back in light mode\n\n'
      + 'Expected: the preference persists across reloads.', 2),
    mk(900002, '[Mock] Add a keyboard shortcut for voting',
      'Staging-only mock issue for previewing the Dev card list.\n\n'
      + 'Power users vote on a lot of proposals — pressing Y/N while a '
      + 'proposal card is focused should cast the vote without reaching '
      + 'for the mouse.', 9),
    mk(900003, '[Mock] Topic cards overflow on narrow phones',
      'Staging-only mock issue for previewing the Dev card list.\n\n'
      + 'On a 360px-wide viewport the action buttons on issue cards can '
      + 'push past the card edge. They should wrap onto their own row '
      + 'instead.', 30),
    // Long-title variants (~90 and ~120 chars) for verifying the dev
    // card list's progressive title wrapping on narrow screens: the 💬
    // badge should drop to the next line first, then the bounty pill,
    // and only then should the title wrap — never an ellipsis.
    mk(900004, '[Mock] Long-title test: the settings panel re-expands '
      + 'every advanced section after navigating back to it',
      'Staging-only mock issue with a deliberately long title for '
      + 'checking that dev-card titles wrap instead of truncating on '
      + 'narrow phone screens.', 5),
    mk(900005, '[Mock] Long-title test: scrolling the leaderboard on a '
      + 'narrow phone while the keyboard is open jumps back to the top '
      + 'whenever a new kudos event arrives',
      'Staging-only mock issue with a deliberately long title (~120 '
      + 'chars) for checking that dev-card titles wrap instead of '
      + 'truncating on narrow phone screens.', 14),
  ];
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
           (SELECT vote FROM issue_votes WHERE issue_id = i.id AND user_id = $2) as my_vote,
           -- #194: governance-thread message count for the chat badge,
           -- plus the latest thread-message timestamp for the forum
           -- feed's activity sort. chat_count counts human messages only
           -- (msg_type='message') so vote/lifecycle system rows don't
           -- inflate the 💬 badge.
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id
               AND cm.msg_type = 'message') as chat_count,
           (SELECT MAX(cm.created_at) FROM chat_messages cm
             WHERE cm.app_id = i.app_id AND cm.thread_type = 'governance' AND cm.thread_ref = i.id) as last_message_at
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
      const createdMsg = `${chatPrefix}${githubIssueNumber ? ` (#${githubIssueNumber})` : ''}`;
      await sendSystemMessage(pool, app.id, createdMsg, 'system');
      // Dual-post the creation into the topic's own thread so the
      // discussion opens with its origin in context: governance proposals
      // (secret_change / rename) thread on the local issue id; general
      // issues thread on the GitHub twin number (no twin → no thread yet).
      if (kind === 'secret_change' || kind === 'rename') {
        await sendSystemMessage(pool, app.id, createdMsg, 'system',
          null, { type: 'governance', ref: rows[0].id }).catch(() => {});
      } else if (githubIssueNumber) {
        await sendSystemMessage(pool, app.id, createdMsg, 'system',
          null, { type: 'issue', ref: githubIssueNumber }).catch(() => {});
      }

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
        'vote',
        null,
        // #194: per-vote activity lands in the proposal's own thread
        // (the governance card on the Proposals tab), not general chat.
        { type: 'governance', ref: issue.id }
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
  // (`created_by_username`, #133), the latest live headless auto session
  // (`headless`, #155 — including the viewer's own derived session as
  // `headless.mySessionId`, #172), plus the viewer's remaining weekly kudos
  // allowance so the FE can disable the "Give kudos" button when the shared
  // budget is spent. Distinct from the platform-internal `issues` table
  // (governance proposals) listed by GET /api/apps/:slug/issues above.
  //
  // #192: `?refresh=1` forces a refetch past the server-side cache TTL
  // (throttled per repo inside github.refreshPublicIssues — within the
  // cooldown it serves the cache). Refresh responses additionally carry
  // `refreshed` and `refreshRetryMs` so the FE can disable its button for
  // the cooldown window; the normal payload shape is unchanged.
  // ----------------------------------------------------------------
  router.get('/api/apps/:slug/github-issues', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const parsed = parseOwnerRepo(app.repo_url);
      const wantRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      let result;
      if (!github.isEnabled() || !parsed) {
        if (!IS_STAGING) {
          return res.json({ issues: [], truncatedList: false, note: 'unavailable' });
        }
        // Staging: serve mocks so the Dev card list is reviewable even
        // when GitHub isn't reachable from the preview container.
        result = { issues: stagingMockIssues(app.repo_url), truncatedList: false };
      } else {
        // Neither fetcher ever throws or returns null; on any failure mode
        // they return { issues:[], truncatedList:false, note }.
        result = wantRefresh
          ? await github.refreshPublicIssues(parsed.owner, parsed.repo)
          : await github.fetchPublicIssues(parsed.owner, parsed.repo);
        // Staging-only fallback: an empty (or degraded) live list would
        // render an empty Topics feed in the preview — substitute mocks.
        if (IS_STAGING && (!Array.isArray(result.issues) || result.issues.length === 0)) {
          result = {
            ...result,
            issues: stagingMockIssues(app.repo_url),
            truncatedList: false,
            note: undefined,
          };
        }
      }

      // Staging-only demo mode: with ?demo=1 the mocks are appended even
      // when the live list has rows, so layout work (e.g. long-title
      // wrapping) is verifiable against a prod-cloned DB. The FE forwards
      // the page's own ?demo=1 here (see _demoQS in app-view.js). The
      // number check keeps this idempotent against the empty-list
      // fallback above having already served the same mocks. Strictly a
      // no-op in production.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set((result.issues || []).map((i) => i.number));
        result = {
          ...result,
          issues: [
            ...(result.issues || []),
            ...stagingMockIssues(app.repo_url).filter((m) => !have.has(m.number)),
          ],
        };
      }

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

      // #194: per-issue thread message counts (and the latest message
      // timestamp, for the forum feed's activity sort) in one grouped
      // query. Keyed by GitHub issue number (thread_ref for
      // thread_type='issue'). The badge count covers human messages only
      // (msg_type='message') so dual-posted lifecycle system rows don't
      // inflate it; last_at stays over all rows so system activity still
      // freshens the feed sort.
      const { rows: chatRows } = await pool.query(
        `SELECT thread_ref AS n,
                (COUNT(*) FILTER (WHERE msg_type = 'message'))::int AS cnt,
                MAX(created_at) AS last_at
           FROM chat_messages
          WHERE app_id = $1 AND thread_type = 'issue'
          GROUP BY thread_ref`,
        [app.id]
      );
      const chatByNumber = new Map(chatRows.map((r) => [r.n, r]));

      // #155: latest live headless auto session per issue, so the panel can
      // render the right button state (Generate proposal / Generating… / the
      // outcome-specific "Review … & start session" clone button). 'failed'
      // rows are excluded — the button recovers to Generate proposal so the
      // run can be retried.
      // staging_url/pr_number ride along (#183) so the panel can render the
      // changes-ready label + Preview button for auto runs that pushed code
      // and built a preview. staging_url is nulled on teardown, so a GC'd
      // preview degrades the label back to the plain outcome wording.
      const { rows: headlessRows } = await pool.query(
        `SELECT DISTINCT ON (cs.headless_issue_number)
                cs.headless_issue_number AS n, cs.id, cs.headless_status,
                cs.headless_outcome, cs.staging_url, cs.pr_number, u.username
           FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.app_id = $1 AND cs.is_headless = TRUE
            AND cs.headless_status IN ('generating', 'ready')
          ORDER BY cs.headless_issue_number, cs.created_at DESC`,
        [app.id]
      );
      // #172: the viewer's own most recent non-archived clone of each
      // listed headless session, so the FE can swap the clone button for
      // "Go to session" once they've already started one. Strictly
      // per-viewer — sessions are owner-scoped, so another user's clone
      // isn't navigable and must not hide the clone button. 'archived'
      // clones are excluded (one-way abandoned state) so the user can
      // start over. No dedicated index: the lookup filters by user_id +
      // cloned_from_session_id over a handful of ids, fine at current
      // volumes.
      const headlessIds = headlessRows.map((r) => r.id);
      const myCloneByHeadlessId = new Map();
      if (headlessIds.length) {
        const { rows: cloneRows } = await pool.query(
          `SELECT DISTINCT ON (cloned_from_session_id)
                  cloned_from_session_id AS src, id
             FROM chat_sessions
            WHERE user_id = $1 AND cloned_from_session_id = ANY($2)
              AND status <> 'archived'
            ORDER BY cloned_from_session_id, created_at DESC`,
          [req.user.id, headlessIds]
        );
        for (const r of cloneRows) myCloneByHeadlessId.set(r.src, r.id);
      }

      const headlessByNumber = new Map(headlessRows.map((r) => [r.n, {
        sessionId: r.id,
        status: r.headless_status,
        outcome: r.headless_outcome,
        username: r.username,
        mySessionId: myCloneByHeadlessId.get(r.id) || null,
        stagingUrl: r.staging_url || null,
        prNumber: r.pr_number || null,
      }]));

      // #287: the viewer's own most recent non-archived dev chat started
      // from each issue's "Create PR" button (created_from_issue_number),
      // so the row can swap "Create PR" → "Open Session". Strictly
      // per-viewer (sessions are owner-scoped — another user's session
      // isn't navigable and must not hide the button) and 'archived' rows
      // are excluded so the button reverts to "Create PR" after the viewer
      // abandons their session. Independent of the headless lookup above.
      const { rows: prSessionRows } = await pool.query(
        `SELECT DISTINCT ON (created_from_issue_number)
                created_from_issue_number AS n, id
           FROM chat_sessions
          WHERE app_id = $1 AND user_id = $2
            AND created_from_issue_number IS NOT NULL
            AND status <> 'archived'
          ORDER BY created_from_issue_number, created_at DESC`,
        [app.id, req.user.id]
      );
      const myPrSessionByNumber = new Map(prSessionRows.map((r) => [r.n, r.id]));

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
          headless: headlessByNumber.get(issue.number) || null,
          // #287: per-viewer Create-PR session id, or null. Drives the
          // "Create PR" → "Open Session" swap on the issue row.
          myPrSessionId: myPrSessionByNumber.get(issue.number) || null,
          chatCount: chatByNumber.get(issue.number)?.cnt || 0,
          lastMessageAt: chatByNumber.get(issue.number)?.last_at || null,
        };
      });

      // #227: the staging mocks have no chat_sessions rows, so the feed's
      // auto-solve-first ordering would be unreviewable in a preview.
      // Attach synthetic headless state to two [Mock] rows — 900003
      // 'generating' (30h old, naturally last by recency, so the re-rank
      // is unmistakable) and 900005 'ready'/spec — only where no real
      // headless row already claimed the number, so prod-cloned data is
      // never overridden. Request-time and read-only; strictly a no-op
      // in production.
      if (IS_STAGING) {
        const mockHeadless = new Map([
          [900003, { status: 'generating', outcome: null }],
          [900005, { status: 'ready', outcome: 'spec' }],
        ]);
        for (const issue of issues) {
          const m = mockHeadless.get(issue.number);
          if (m && !issue.headless) {
            issue.headless = {
              sessionId: issue.number,
              status: m.status,
              outcome: m.outcome,
              username: 'staging-tester',
              mySessionId: null,
              stagingUrl: null,
              prNumber: null,
            };
          }
        }
        // #287: the staging mocks have no chat_sessions rows, so the
        // "Open Session" variant of the Create-PR button would never
        // render in a preview. Attach a synthetic myPrSessionId to one
        // [Mock] row (900001) so the swapped button is reviewable — only
        // where no real session already claimed it. The id is synthetic
        // (the mock issue number), so clicking through in staging lands on
        // a harmless "session not found"; this is for visual review of the
        // button state only. Request-time, read-only, no-op in production.
        for (const issue of issues) {
          if (issue.number === 900001 && !issue.myPrSessionId) {
            issue.myPrSessionId = issue.number;
          }
        }
      }

      const used = await countWeeklyAllowanceUsed(pool, req.user.id, weekStartUtc());
      const myRemaining = Math.max(0, WEEKLY_KUDOS_LIMIT - used);

      res.json({
        issues,
        truncatedList: !!result.truncatedList,
        ...(result.note ? { note: result.note } : {}),
        ...(wantRefresh
          ? { refreshed: !!result.refreshed, refreshRetryMs: result.retryInMs || 0 }
          : {}),
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

      const bountyMsg = `${req.user.username} placed a bounty (kudos) on issue #${issueNumber}`;
      await sendSystemMessage(pool, app.id, bountyMsg, 'system')
        .catch((err) => log.warn('issues', 'Bounty chat message failed', { err: err.message }));
      // Dual-post into the issue's thread (lifecycle in context).
      await sendSystemMessage(pool, app.id, bountyMsg, 'system',
        null, { type: 'issue', ref: issueNumber }).catch(() => {});

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
    if (!req.user?.canAdminWrite) {
      return res.status(403).json({ error: 'Full admin access required' });
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
    const renamedMsg = `App renamed from "${oldName}" to "${newName}" by group vote (${upCount}/${active})`;
    await sendSystemMessage(pool, app.id, renamedMsg, 'system')
      .catch((err) => log.warn('issues', 'Rename chat message failed', { err: err.message }));
    // Dual-post the outcome into the governance proposal's thread.
    await sendSystemMessage(pool, app.id, renamedMsg, 'system',
      null, { type: 'governance', ref: locked.id }).catch(() => {});

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
    const secretMsg = `Secret "${key}" ${verb} ${appliedHow}; redeploying…`;
    await sendSystemMessage(pool, issue.app_id, secretMsg, 'system')
      .catch((err) => log.warn('issues', 'Secret-change chat msg failed', { err: err.message }));
    // Dual-post the outcome into the governance proposal's thread.
    await sendSystemMessage(pool, issue.app_id, secretMsg, 'system',
      null, { type: 'governance', ref: locked.id }).catch(() => {});

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
