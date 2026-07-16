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
const { issueKindLimiter } = require('../middleware/rate-limits');
const events = require('../services/events');
const { weekStartUtc, countWeeklyAllowanceUsed, WEEKLY_KUDOS_LIMIT } = require('./kudos');
const appAccess = require('../services/app-access');
const topicAttrs = require('../services/topic-attributes');
const { FEEDBACK_FALLBACK_TITLE } = require('../services/llm');

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
const VALID_KINDS = ['general', 'secret_change', 'close_issue'];
const MAX_SECRET_VALUE_LENGTH = 4096;
const MAX_CLOSE_REASON_LENGTH = 2000;
// #556: cap for author-edited issue titles (rename route below). Matches
// the feedback form's optional title input; far below GitHub's own limit.
const MAX_ISSUE_TITLE_LENGTH = 200;

// #132: should this issue kind get a GitHub twin on the app's repo?
// Env-var change proposals (kind='secret_change') are in-app governance —
// they're proposed, voted, applied, and audited entirely on the platform,
// so opening a "Set secret …" issue on GitHub just pollutes the repo's
// issue list (GitHub issues are reserved for real issues). Close-issue
// proposals (kind='close_issue') target an EXISTING GitHub issue — a twin
// would be pure noise, and the target's number deliberately lives in the
// payload, not github_issue_number (see the create route). Everything
// downstream already tolerates a null github_issue_number: the apply path
// guards its close/comment on it, and the UI omits the kudos button when
// no twin exists.
function shouldCreateGithubTwin(kind) {
  return kind !== 'secret_change' && kind !== 'close_issue';
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
    // #361: row for the headless `code` outcome — an auto-run that produced
    // a reviewable commit. Its viewer-owned clones (seeded in migrate.js)
    // demonstrate both "Changes ready" card variants (preview-OK and
    // preview-failed).
    mk(900006, '[Mock] Voting buttons need a clearer disabled state',
      'Staging-only mock issue for previewing the headless "code" outcome.\n\n'
      + 'When a proposal is closed, the Yes/No buttons stay full-colour but '
      + 'do nothing on click. They should render visibly disabled (greyed '
      + 'out, no hover) so it is obvious voting is over.', 11),
    // #287: dedicated row for reviewing the has-session button state. The
    // synthetic-myPrSessionId block below targets this number so the
    // "Create new proposal" variant of the start-work button is reviewable
    // in a staging preview.
    mk(900007, '[Mock] issue with an in-progress proposal',
      'Staging-only mock issue for previewing the "Create new proposal" '
      + 'button state. A synthetic per-viewer session is attached to this '
      + "row so the start-work button reads \"Create new proposal\" "
      + 'instead of "Create proposal" — exactly what a viewer who already '
      + 'started a dev chat on this issue would see.', 7),
    // #556: dedicated row for reviewing the author-only "edit title"
    // pencil in the topic head. The staging enrichment block in
    // GET /github-issues marks it as authored by whoever is viewing, so
    // the affordance renders for every staging tester.
    mk(900008, '[Mock] issue you authored — title is editable',
      'Staging-only mock issue for previewing the author-only title edit '
      + 'affordance (#556). Open this topic and a pencil appears next to '
      + 'the title because the row is marked as authored by you. Saving '
      + 'a new title will fail — there is no real GitHub issue behind '
      + 'this mock row — so this is purely for visual review.', 3),
    // #617: the NEWEST mock row, deliberately absent from the demo drag
    // order (stagingMockOrder in board-order.js ranks only 900002/900001).
    // With the fix, an issue filed after the last drag surfaces at the TOP
    // of the kanban Issues column, so this card must render first there.
    mk(900009, '[Mock] Newly filed issue — should render on top',
      'Staging-only mock issue for previewing the #617 fix: this row is '
      + 'the most recent and is NOT part of the saved drag order, so it '
      + 'must appear at the top of the Issues column, above the manually '
      + 'ordered cards.', 1),
  ];
}

// Staging-only mock GOVERNANCE proposals (DB-issue shaped) for the
// Proposals-tab vote panel, so the dynamic threshold + visibility-window
// countdown is exercisable on a prod-cloned staging DB via ?demo=1. Distinct
// from stagingMockIssues above (which mocks external GitHub issues). Each row
// carries precomputed gate fields because mocks bypass the live computation.
function stagingMockGovernance() {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
  const mk = (id, kind, title, payload, hours, up, down, gate = {}) => ({
    id,
    app_id: 0,
    kind,
    title,
    description: 'Staging demo governance proposal (?demo=1).',
    status: 'open',
    payload,
    created_by: 0,
    created_by_username: 'staging-tester',
    created_at: hoursAgo(hours),
    up_count: up,
    down_count: down,
    my_vote: null,
    chat_count: 0,
    last_message_at: null,
    votes_required: gate.required ?? Math.max(up, 1),
    merge_window_ends_at: gate.windowEndsAt ?? null,
    contested: gate.contested ?? false,
  });
  return [
    // Unopposed rename, threshold met, window still running → countdown.
    mk(9100001, 'rename', '[Mock] Rename app to "Staging Demo App"',
      { newName: 'Staging Demo App' }, 6, 2, 0,
      { required: 2, windowEndsAt: hoursAhead(36) }),
    // Contested secret change (down >= 1/3) → no countdown, full count gate.
    mk(9100002, 'secret_change', '[Mock] Set FEATURE_FLAG to "on"',
      { key: 'FEATURE_FLAG', action: 'set', hasValue: true }, 8, 4, 3,
      { required: 6, windowEndsAt: null, contested: true }),
    // Close-issue proposal targeting mock issue 900001 (served by
    // stagingMockIssues above), so the ?demo=1 preview shows the new
    // governance card AND the target issue row's disabled "Close
    // proposed" button state.
    mk(9100003, 'close_issue',
      '[Mock] Close issue #900001: "Dark mode toggle resets after refresh"',
      {
        issueNumber: 900001,
        issueTitle: 'Dark mode toggle resets after refresh',
        reason: 'Obsolete since the theme rework.',
      }, 4, 1, 0,
      { required: 2, windowEndsAt: hoursAhead(40) }),
  ];
}

// #396: staging-only mock comment threads for the topic view's GitHub
// comment section, served by GET /api/apps/:slug/github-issues/:number/
// comments when the live fetch is empty/unavailable. Keyed by the mock
// issue numbers above; obviously-fake "[Mock]" bodies, oldest-first (the
// same order fetchIssueComments returns), and at least one BOT-authored
// comment (`usernode-bot`) so the bot-labelling renders. Returns [] for
// numbers without a mock thread. Strictly a no-op in production.
function stagingMockIssueComments(number) {
  const n = Number(number);
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const threads = {
    900001: [
      { author: 'staging-tester', body: '[Mock] I can reproduce this every time on Firefox — the toggle flips back to light as soon as I reload.', createdAt: hoursAgo(40) },
      { author: 'usernode-bot', body: '[Mock] Thanks for the report. Is the preference meant to persist per-device or per-account? Defaulting to per-device unless you say otherwise.', createdAt: hoursAgo(36) },
      { author: 'staging-tester', body: '[Mock] Per-device is fine — just make it survive a refresh.', createdAt: hoursAgo(30) },
    ],
    900002: [
      { author: 'another-tester', body: '[Mock] +1, Y/N shortcuts would be a huge time-saver during a voting spree.', createdAt: hoursAgo(20) },
      { author: 'usernode-bot', body: '[Mock] Should the shortcut act on the focused card only, or the top card in the list? Going with the focused card.', createdAt: hoursAgo(18) },
    ],
    900003: [
      { author: 'staging-tester', body: '[Mock] Happens on my iPhone SE in portrait — the Vote and Preview buttons spill off the right edge.', createdAt: hoursAgo(28) },
    ],
  };
  return threads[n] || [];
}

function issueRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Per-app visibility gate for issue-id-addressed routes (/vote,
  // /close): collab-level access via the issue's app, 404 on deny.
  router.use('/api/issues/:id', appAccess.issueCollabGuard(pool));

  // List issues for an app. View-level (#621): read-only viewers see
  // the issue board; creating/voting stays collab-gated.
  router.get('/api/apps/:slug/issues', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
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

      // #646: governance-aware per-row gate (mirrors /promoted). Under
      // the default settings this is the old mergeGate over the raw
      // tallies; under 'invited' only approver votes qualify (batched in
      // one query); under at-least-N the gate is the clock-free count.
      const governanceSvc = require('../services/governance');
      const gov = await governanceSvc.getGovernance(pool, appId);
      const electorate = await governanceSvc.getElectorate(pool, appId, gov);
      const qualifiedByRow = electorate.approverIds
        ? await governanceSvc.qualifiedCountsBatch(
          pool, 'issue', rows.map((r) => r.id), electorate.approverIds
        )
        : null;

      // Strip ciphertext from secret_change rows before serializing —
      // the value should never be readable from this endpoint, even
      // by other admins. The committed value lands in app_secrets via
      // maybeApplySecretChangeProposal once the vote passes.
      // Also attach the per-row dynamic merge gate (eased threshold +
      // visibility window) anchored on the issue's created_at, mirroring
      // the PR /promoted endpoint so governance pills get the same
      // countdown/Contested treatment.
      const sanitized = rows.map((r) => {
        const q = qualifiedByRow
          ? (qualifiedByRow.get(r.id) || { yes: 0, no: 0 })
          : { yes: r.up_count, no: r.down_count };
        const gate = governanceSvc.computeGate(gov, electorate.active, q.yes, q.no, r.created_at);
        const withGate = {
          ...r,
          votes_required: gate.required,
          merge_window_ends_at: gate.windowEndsAt,
          contested: gate.contested,
          approval_policy: gate.policy,
          approvals_required: gate.approvalsRequired,
          qualified_yes_count: gate.qualifiedYes,
          qualified_no_count: gate.qualifiedNo,
        };
        if (withGate.kind !== 'secret_change' || !withGate.payload) return withGate;
        const { valueEnc, ...rest } = withGate.payload;
        return { ...withGate, payload: { ...rest, hasValue: !!valueEnc } };
      });

      // Staging-only demo mode (?demo=1): append mock governance proposals
      // spanning the gate regimes (countdown + contested). No-op in prod.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set(sanitized.map((r) => r.id));
        sanitized.push(...stagingMockGovernance().filter((m) => !have.has(m.id)));
      }

      res.json({ issues: sanitized, activeUsers, majority });
    } catch (err) {
      log.error('issues', 'Failed to list issues', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create an issue / proposal — kinds per VALID_KINDS above (general is
  // the default). Rate-limited per kind: close_issue proposals draw from
  // their own bucket, everything else from issue-create.
  router.post('/api/apps/:slug/issues', issueKindLimiter, async (req, res) => {
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
      } else if (kind === 'close_issue') {
        const issueNumber = Number(payload?.issueNumber);
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
          return res.status(400).json({ error: 'payload.issueNumber must be a positive integer' });
        }
        const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
        if (reason.length > MAX_CLOSE_REASON_LENGTH) {
          return res.status(400).json({
            error: `payload.reason must be ≤ ${MAX_CLOSE_REASON_LENGTH} chars`,
          });
        }

        // Verify the target is a CURRENTLY OPEN GitHub issue on this repo
        // before creating the proposal — same policy as the bounty route:
        // fetchPublicIssues never throws; a degraded fetch (note) means no
        // positive confirmation, so refuse and change nothing.
        const parsed = parseOwnerRepo(app.repo_url);
        if (!github.isEnabled() || !parsed) {
          return res.status(422).json({
            error: 'Cannot verify the issue right now — GitHub is unavailable for this app.',
          });
        }
        const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
        if (ghResult.note) {
          return res.status(422).json({
            error: "Couldn't confirm this issue is open right now. Try again in a moment.",
          });
        }
        const target = (ghResult.issues || []).find((i) => i.number === issueNumber);
        if (!target) {
          return res.status(404).json({
            error: `Issue #${issueNumber} isn't an open issue on this repo.`,
          });
        }

        // Dedupe: one open close proposal per issue per app. The UI also
        // disables the button, but two clients can race — refuse here.
        const { rows: dupRows } = await pool.query(
          `SELECT id FROM issues
            WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open'
              AND (payload->>'issueNumber')::int = $2`,
          [app.id, issueNumber]
        );
        if (dupRows.length) {
          return res.status(409).json({
            error: `A close proposal for issue #${issueNumber} is already open`,
          });
        }

        // The target's number lives ONLY in the payload — never in
        // github_issue_number, which means "this proposal's GitHub twin"
        // and would make the withdraw route close the target issue.
        const issueTitle = String(target.title || '').slice(0, 300);
        payload = { issueNumber, issueTitle, reason: reason || null };
        title = `Close issue #${issueNumber}: "${issueTitle}"`.slice(0, 512);
        description = reason || null;
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
      } else if (kind === 'close_issue') {
        chatPrefix = `${req.user.username} proposed closing issue #${payload.issueNumber}: "${payload.issueTitle}"`;
      } else {
        chatPrefix = `${req.user.username} created issue: "${title}"`;
      }
      const createdMsg = `${chatPrefix}${githubIssueNumber ? ` (#${githubIssueNumber})` : ''}`;
      await sendSystemMessage(pool, app.id, createdMsg, 'system');
      // Dual-post the creation into the topic's own thread so the
      // discussion opens with its origin in context: governance proposals
      // (secret_change / rename / close_issue) thread on the local issue
      // id; general issues thread on the GitHub twin number (no twin → no
      // thread yet). A close_issue proposal ALSO posts into its target
      // issue's thread so followers of the issue see the vote start.
      if (kind === 'secret_change' || kind === 'rename' || kind === 'close_issue') {
        await sendSystemMessage(pool, app.id, createdMsg, 'system',
          null, { type: 'governance', ref: rows[0].id }).catch(() => {});
        if (kind === 'close_issue' && payload.issueNumber) {
          await sendSystemMessage(pool, app.id, createdMsg, 'system',
            null, { type: 'issue', ref: payload.issueNumber }).catch(() => {});
        }
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
      } else if (issue.kind === 'close_issue') {
        voteSubject = `close proposal for issue #${issue.payload?.issueNumber || '?'}`;
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
      let issueClosed = null;
      if (vote === 'up' && issue.kind === 'rename') {
        renamed = await maybeApplyRenameProposal(pool, issue);
      } else if (vote === 'up' && issue.kind === 'secret_change') {
        secretChanged = await maybeApplySecretChangeProposal(config, pool, issue);
      } else if (vote === 'up' && issue.kind === 'close_issue') {
        issueClosed = await maybeApplyCloseIssueProposal(pool, issue);
      }

      pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id, vote });

      res.json({ ok: true, renamed, secretChanged, issueClosed });
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
      // View-level (#621): the GitHub issue list is read-only.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, repo_url`
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
      // from each issue's start-work button (created_from_issue_number),
      // so the row can swap "Create proposal" → "Create new proposal".
      // Strictly per-viewer (sessions are owner-scoped — another user's
      // session must not flip the label) and 'archived' rows are excluded
      // so the button reverts to "Create proposal" after the viewer
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
          // #287: per-viewer proposal session id, or null. Drives the
          // "Create proposal" → "Create new proposal" swap on the issue row.
          myPrSessionId: myPrSessionByNumber.get(issue.number) || null,
          chatCount: chatByNumber.get(issue.number)?.cnt || 0,
          lastMessageAt: chatByNumber.get(issue.number)?.last_at || null,
          // The Haiku title call failed when this feedback issue was
          // filed, so it carries the placeholder template. Drives the
          // "Auto-title pending" chip on the issue row; the title-heal
          // sweeper regenerates it (services/title-heal.js), after which
          // the refreshed title no longer matches and the chip drops.
          title_fallback: issue.title === FEEDBACK_FALLBACK_TITLE,
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
        // "Create new proposal" variant of the start-work button would
        // never render in a preview. Attach a synthetic myPrSessionId to
        // the dedicated [Mock] row (900007, "issue with an in-progress
        // proposal") so the has-session button is reviewable — only where
        // no real session already claimed it. The id is synthetic (the
        // mock issue number); clicking "Create new proposal" still just
        // spawns a fresh dev chat, so this is purely for visual review of
        // the button label. Request-time, read-only, no-op in production.
        for (const issue of issues) {
          if (issue.number === 900007 && !issue.myPrSessionId) {
            issue.myPrSessionId = issue.number;
          }
        }
        // #556: the [Mock] rows resolve no platform creator, so the
        // author-only "edit title" pencil in the topic head would never
        // render in a preview. Mark the dedicated row (900008) as authored
        // by the viewer — only where no real creator resolved — so the
        // affordance is reviewable. Saving still fails (no real GitHub
        // issue behind the mock); purely visual. No-op in production.
        for (const issue of issues) {
          if (issue.number === 900008 && !issue.created_by_username) {
            issue.created_by_username = req.user.username;
          }
        }
      }

      // Community-voted priority + assigned-person summary per issue (the
      // chip top value + count + the viewer's pick), keyed by GitHub issue
      // number — mirroring the bounty enrichment above. The dropdown's full
      // tally lazy-loads from /api/apps/:slug/topics/issue/:n/attributes.
      const attrByNumber = await topicAttrs.summarizeForTargets(
        pool, app.id, 'issue', issues.map((i) => i.number), req.user.id
      );
      for (const issue of issues) {
        const s = attrByNumber.get(issue.number) || topicAttrs.emptySummary();
        issue.priority = s.priority;
        issue.assignee = s.assignee;
        issue.category = s.category;
      }
      // Staging: the [Mock] rows have no topic_attribute_votes, so seed a
      // synthetic summary onto a few so the chips' states are reviewable in
      // a preview — a clear leader, a tie, and an untouched (placeholder)
      // row. Only where the real query found nothing. No-op in production.
      if (IS_STAGING) {
        // #600: so both assignee-dropdown states are reviewable, 900001's
        // assignee is seeded to the VIEWING user (myValue = their own
        // username) — opening its dropdown shows the viewer's name already
        // checked and the name box empty (no pre-fill, since they've voted).
        // 900002 stays untouched (Unassigned) so opening ITS dropdown shows
        // the name box PRE-FILLED with the viewer's username.
        const viewer = (req.user && req.user.username) || 'staging-tester';
        const mockAttrs = new Map([
          // Clear leader on all fields; the viewer is their own assignee.
          [900001, {
            priority: { top: 'high', count: 3, myValue: null },
            assignee: { top: viewer, count: 2, myValue: viewer },
            // #504: a clear category leader (count 3) so the chip + colour
            // and the category filter dropdown are reviewable.
            category: { top: 'bug', count: 3, myValue: null },
          }],
          // A tie (count 1 vs 1) — the earlier-suggested value wins the chip.
          [900003, {
            priority: { top: 'low', count: 1, myValue: null },
            assignee: { top: 'staging-demo-user', count: 1, myValue: null },
            category: { top: 'docs', count: 1, myValue: null },
          }],
          // #489: a third assignee whose first letter (M) differs from the
          // others (S), so the deterministic initial-avatar colouring is
          // reviewable across several visibly-distinct avatars on the board.
          [900006, {
            priority: { top: 'medium', count: 2, myValue: null },
            assignee: { top: 'maya-builder', count: 3, myValue: null },
            // A second, distinct category leader so the filter has choices.
            category: { top: 'feature', count: 2, myValue: null },
          }],
          // 900002 deliberately left untouched → muted "Set priority" /
          // "Unassigned" / "Set category"; opening its assignee dropdown
          // pre-fills the viewer's own username.
        ]);
        for (const issue of issues) {
          const m = mockAttrs.get(issue.number);
          if (m && (!issue.priority || !issue.priority.top) && (!issue.assignee || !issue.assignee.top)) {
            issue.priority = m.priority;
            issue.assignee = m.assignee;
            issue.category = m.category;
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
  // GET /api/apps/:slug/github-issues/:number/comments
  //
  // #396: the GitHub comment thread for ONE issue, for the Dev topic
  // view's comment section. Lazy — fetched only when a viewer opens an
  // issue topic, never as part of the list payload, so the panel's
  // rate-limit cost is unchanged. Collab-gated like the list route above.
  // Returns `{ comments: [{ author, body, createdAt }], truncated, note? }`;
  // github.fetchIssueComments never throws (failures degrade to an empty
  // list with a note). In staging the thread is backed by mock comments
  // when the live fetch is empty/unavailable, so the section is reviewable.
  // ----------------------------------------------------------------
  router.get('/api/apps/:slug/github-issues/:number/comments', async (req, res) => {
    try {
      // View-level (#621): comment history is read-only.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const number = parseInt(req.params.number, 10);
      const parsed = parseOwnerRepo(app.repo_url);

      if (!github.isEnabled() || !parsed || !Number.isFinite(number)) {
        if (!IS_STAGING) {
          return res.json({ comments: [], truncated: false, note: 'unavailable' });
        }
        const mocks = stagingMockIssueComments(number);
        const clipped = github.clipIssueComments(mocks);
        return res.json({ comments: clipped.comments, truncated: clipped.truncated });
      }

      const raw = await github.fetchIssueComments(parsed.owner, parsed.repo, number);
      let { comments, truncated } = github.clipIssueComments(raw.comments, { wasTruncated: raw.truncated });

      // Staging-only fallback: an empty (or degraded) live thread would
      // render nothing in the preview — substitute mocks so the section is
      // reviewable. Strictly a no-op in production.
      if (IS_STAGING && comments.length === 0) {
        const clipped = github.clipIssueComments(stagingMockIssueComments(number));
        comments = clipped.comments;
        truncated = clipped.truncated;
        return res.json({ comments, truncated });
      }

      return res.json({
        comments,
        truncated,
        ...(raw.note ? { note: raw.note } : {}),
      });
    } catch (err) {
      log.error('issues', 'Failed to fetch GitHub issue comments', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ----------------------------------------------------------------
  // PATCH /api/apps/:slug/github-issues/:number/title
  //
  // #556: author-only rename of an open GitHub issue from inside the app.
  // The GitHub issue is retitled FIRST (nothing local changes if that
  // fails), then best-effort follow-ups: the local `issues` mirror row
  // (platform-filed issues only), removal of any pending title_heal_queue
  // row (so the sweeper can't clobber the author's choice), a system
  // message in the issue's own discussion thread recording old → new, and
  // the cache-bust + issue_update broadcast that live-refreshes open
  // panels (same pair title-heal uses).
  //
  // Authorship: platform-filed issues record created_by in the local
  // issues table; feedback-filed ones carry the creator in the body's
  // "**Source:**" line. GitHub-native issues match neither and stay
  // read-only — author-only by design, no admin override.
  // ----------------------------------------------------------------
  router.patch('/api/apps/:slug/github-issues/:number/title', async (req, res) => {
    const issueNumber = parseInt(req.params.number, 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'Invalid issue number' });
    }
    const rawTitle = req.body?.title;
    const newTitle = typeof rawTitle === 'string' ? rawTitle.trim() : '';
    if (!newTitle) return res.status(400).json({ error: 'Title required' });
    if (newTitle.length > MAX_ISSUE_TITLE_LENGTH) {
      return res.status(400).json({
        error: `Title too long (max ${MAX_ISSUE_TITLE_LENGTH} chars)`,
      });
    }

    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, repo_url`
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Verify :number is a CURRENTLY OPEN GitHub issue on this repo —
      // same policy as the bounty route: fetchPublicIssues never throws;
      // a degraded fetch (note) means no positive confirmation, so refuse
      // and change nothing. The snapshot also yields the old title + body.
      const parsed = parseOwnerRepo(app.repo_url);
      if (!github.isEnabled() || !parsed) {
        return res.status(422).json({
          error: 'Cannot verify the issue right now — GitHub is unavailable for this app.',
        });
      }
      const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
      if (ghResult.note) {
        return res.status(422).json({
          error: "Couldn't confirm this issue is open right now. Try again in a moment.",
        });
      }
      const target = (ghResult.issues || []).find((i) => i.number === issueNumber);
      if (!target) {
        return res.status(404).json({
          error: `Issue #${issueNumber} isn't an open issue on this repo.`,
        });
      }

      const { rows: authorRows } = await pool.query(
        `SELECT 1 FROM issues
          WHERE app_id = $1 AND github_issue_number = $2 AND created_by = $3`,
        [app.id, issueNumber, req.user.id]
      );
      const isAuthor = authorRows.length > 0
        || creatorFromSourceLine(target.body) === req.user.username;
      if (!isAuthor) {
        return res.status(403).json({ error: "Only the issue's author can edit its title" });
      }

      const oldTitle = String(target.title || '');
      if (newTitle === oldTitle) {
        return res.json({ ok: true, unchanged: true, title: oldTitle });
      }

      // GitHub first — a failed PATCH must leave everything untouched.
      try {
        await github.patchIssueTitle(parsed.owner, parsed.repo, issueNumber, newTitle);
      } catch (err) {
        log.warn('issues', 'GitHub issue title PATCH failed', { issueNumber, message: err.message });
        return res.status(502).json({
          error: "Couldn't update the title on GitHub. Try again in a moment.",
        });
      }

      // Local mirror row (platform-filed issues only; no-op otherwise).
      await pool.query(
        `UPDATE issues SET title = $3 WHERE app_id = $1 AND github_issue_number = $2`,
        [app.id, issueNumber, newTitle]
      ).catch((err) => log.warn('issues', 'Local issue title update failed', { issueNumber, err: err.message }));

      // A pending auto-title heal must not overwrite the author's choice.
      await pool.query(
        `DELETE FROM title_heal_queue WHERE owner = $1 AND repo = $2 AND issue_number = $3`,
        [parsed.owner, parsed.repo, issueNumber]
      ).catch((err) => log.warn('issues', 'title_heal_queue cleanup failed', { issueNumber, err: err.message }));

      // On-the-record rename note in the issue's own thread. Thread-only —
      // renames are issue-local housekeeping, unlike creation's dual-post.
      await sendSystemMessage(pool, app.id,
        `${req.user.username} changed the title from "${oldTitle}" to "${newTitle}"`,
        'system', null, { type: 'issue', ref: issueNumber }
      ).catch((err) => log.warn('issues', 'Rename chat message failed', { err: err.message }));

      github.invalidateIssuesCache(parsed.owner, parsed.repo);
      pushIssueUpdate({
        action: 'updated', source: 'github',
        appSlug: app.slug, appId: app.id, issueNumber,
      });

      log.info('issues', 'Issue title edited', { appId: app.id, issueNumber, by: req.user.username });
      res.json({ ok: true, title: newTitle });
    } catch (err) {
      log.error('issues', 'Issue title edit failed', { issueNumber, message: err.message });
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
      if (issue.kind !== 'secret_change' && issue.kind !== 'close_issue') {
        return res.status(400).json({ error: 'Only secret-change and close-issue proposals can be admin-applied' });
      }

      log.info('issues', 'Admin force-apply requested', {
        issueId: issue.id, kind: issue.kind, by: req.user.username,
      });

      const applied = issue.kind === 'close_issue'
        ? await maybeApplyCloseIssueProposal(pool, issue, { force: true, forceBy: req.user })
        : await maybeApplySecretChangeProposal(config, pool, issue, { force: true, forceBy: req.user });

      pushIssueUpdate({ action: 'voted', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id });

      res.json({
        ok: true,
        applied,
        // BC alias for clients written when only secret_change existed.
        secretChanged: issue.kind === 'secret_change' ? applied : null,
      });
    } catch (err) {
      log.error('issues', 'Admin force-apply failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Withdraw a governance proposal (secret_change / legacy rename). This was
  // originally an unguarded "close any issue" route with no caller; it is now
  // the creator-gated self-service withdraw for governance proposals (the
  // PR-proposal equivalent is POST /api/sessions/:id/archive). Only the
  // proposal's creator may withdraw, and only while it is still open, so a
  // stale double-tap or a race against a passing vote is a harmless no-op.
  router.post('/api/issues/:id/close', async (req, res) => {
    try {
      const { rows: issueRows } = await pool.query(
        `SELECT i.*, a.slug AS app_slug, a.repo_url AS repo_url
           FROM issues i JOIN apps a ON a.id = i.app_id
          WHERE i.id = $1`,
        [req.params.id]
      );
      if (!issueRows.length) return res.status(404).json({ error: 'Issue not found' });
      const issue = issueRows[0];

      // Creator-only. (Admins already have other paths — admin merge / direct
      // GitHub close — so the gate stays creator-scoped per the spec.)
      if (!issue.created_by || issue.created_by !== req.user.id) {
        return res.status(403).json({ error: 'Only the proposer can withdraw this proposal' });
      }

      // Restrict to open proposals: a withdraw that loses the race against a
      // passing vote (which flips status to 'closed') simply no-ops here.
      const auditPayload = {
        ...(issue.payload || {}),
        withdrawnAt: new Date().toISOString(),
        withdrawnBy: req.user.username,
      };
      const { rows } = await pool.query(
        `UPDATE issues SET status = 'closed', payload = $2
          WHERE id = $1 AND status = 'open'
          RETURNING id, app_id`,
        [issue.id, JSON.stringify(auditPayload)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Proposal not open' });

      // Announce the withdrawal in group chat, and dual-post into the
      // proposal's governance thread (mirrors the create path).
      const withdrewMsg = `${req.user.username} withdrew their proposal: "${issue.title}"`;
      await sendSystemMessage(pool, issue.app_id, withdrewMsg, 'system')
        .catch((err) => log.warn('issues', 'Withdraw chat message failed', { err: err.message }));
      await sendSystemMessage(pool, issue.app_id, withdrewMsg, 'system',
        null, { type: 'governance', ref: issue.id }).catch(() => {});

      // Best-effort close the GitHub twin (legacy renames carry one;
      // secret_change proposals have no twin, so this is skipped silently).
      if (issue.github_issue_number) {
        const [, owner, repo] = (issue.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        const pat = process.env.GITHUB_BOT_TOKEN;
        if (owner && repo && pat) {
          try {
            const { Octokit } = await import('@octokit/rest');
            const ok = new Octokit({ auth: pat });
            await ok.rest.issues.update({
              owner, repo, issue_number: issue.github_issue_number, state: 'closed',
            });
          } catch (err) {
            log.warn('issues', 'GitHub issue close on withdraw failed', {
              issue: issue.github_issue_number, status: err.status, err: err.message || '(empty)',
            });
          }
        }
      }

      pushIssueUpdate({ action: 'closed', appSlug: issue.app_slug, appId: issue.app_id, issueId: issue.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('issues', 'Withdraw failed', { message: err.message });
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
  const { majority } = await getActiveUserStats(pool, issue.app_id);

  // #646: governance-aware gate. Down votes feed both governance gates,
  // mirroring PRs; the window is anchored on the issue's created_at (no
  // separate promote step exists). Under 'invited' only approver votes
  // qualify; under at-least-N the gate is the clock-free count.
  const governanceSvc = require('../services/governance');
  const gate = await governanceSvc.governedGate(pool, issue.app_id, {
    kind: 'issue', id: issue.id, openedAt: issue.created_at,
  });
  const upCount = gate.qualifiedYes;
  const active = gate.activeCount;
  const required = gate.required;
  // Apply paths mirror PR merges (services/active-users.js → mergeGate):
  // threshold met + window elapsed, OR the lazy-consensus clock elapsed
  // (unopposed support below threshold — silence is consent). Not yet →
  // leave the proposal open (the next vote, or the sweeper's
  // window-elapsed pass, re-checks).
  if (!gate.mergeable) {
    return {
      applied: false, upCount, majority, active,
      required, windowEndsAt: gate.windowEndsAt,
      waitingForWindow: (gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed,
    };
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

    const auditPayload = { ...locked.payload, appliedAt: new Date().toISOString(), appliedBy: 'group-vote', upCount, required, active };
    await client.query(
      `UPDATE issues SET status = 'closed', payload = $1 WHERE id = $2`,
      [JSON.stringify(auditPayload), locked.id]
    );

    await client.query('COMMIT');

    // Side effects (chat + GitHub + WS) are best-effort and live outside the txn.
    const renamedMsg = `App renamed from "${oldName}" to "${newName}" by group vote (${upCount}/${required})`;
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
            body: github.safeMention(`Applied by group vote (${upCount}/${required}). App renamed to "${newName}".`),
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
  const { majority } = await getActiveUserStats(pool, issue.app_id);

  // #646: governance-aware gate (down votes feed both gates, anchored
  // on created_at). An admin force-apply skips it, like force-merge.
  const governanceSvc = require('../services/governance');
  const gate = await governanceSvc.governedGate(pool, issue.app_id, {
    kind: 'issue', id: issue.id, openedAt: issue.created_at,
  });
  const upCount = gate.qualifiedYes;
  const active = gate.activeCount;
  const required = force ? upCount : gate.required;
  // Same two apply paths as maybeApplyRenameProposal (threshold or lazy
  // consensus); an admin force-apply skips both, like force-merge.
  if (!force && !gate.mergeable) {
    return {
      applied: false, upCount, majority, active,
      required: gate.required, windowEndsAt: gate.windowEndsAt,
      waitingForWindow: (gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed,
    };
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
      upCount, required, active,
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
      : `by group vote (${upCount}/${required})`;
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

/**
 * Auto-resolve open close-issue proposals whose target was closed by other
 * means (a merged PR carrying `Closes #N`, or a manual close on GitHub).
 * Called from the merge path (routes/votes.js checkAndMerge), the post-merge
 * issue-close watcher, and maybeApplyCloseIssueProposal's superseded guard.
 *
 * `cause` is { kind: 'pr-merge', prNumber } or { kind: 'github-close' } and
 * drives both the audit payload's supersededBy value and the chat wording.
 *
 * Race-safe: each row flips via a single `WHERE status = 'open'` UPDATE (the
 * same guard the withdraw route uses), so a concurrent vote-apply or
 * withdraw that wins produces zero rows here and no duplicate messages.
 * Best-effort throughout — never throws; callers must never be failed by it.
 * No GitHub writes (the issue is already closed; the proposer's reason is
 * NOT posted — the group never approved it) and no bounty changes.
 */
async function resolveSupersededCloseProposals(pool, { appId, appSlug, numbers, cause } = {}) {
  const nums = (Array.isArray(numbers) ? numbers : [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0);
  const resolved = [];
  if (!appId || !nums.length) return { resolved };

  try {
    const { rows } = await pool.query(
      `SELECT id, app_id, payload FROM issues
        WHERE app_id = $1 AND kind = 'close_issue' AND status = 'open'
          AND (payload->>'issueNumber')::int = ANY($2::int[])`,
      [appId, nums]
    );

    const supersededBy = cause?.kind === 'pr-merge'
      ? `pr-merge:#${cause.prNumber}`
      : 'github-close';

    for (const row of rows) {
      const n = Number(row.payload?.issueNumber);
      const auditPayload = {
        ...(row.payload || {}),
        supersededAt: new Date().toISOString(),
        supersededBy,
      };
      const { rows: updated } = await pool.query(
        `UPDATE issues SET status = 'closed', payload = $2
          WHERE id = $1 AND status = 'open'
          RETURNING id`,
        [row.id, JSON.stringify(auditPayload)]
      );
      if (!updated.length) continue; // lost the race to a vote-apply/withdraw

      resolved.push(row.id);
      const msg = cause?.kind === 'pr-merge'
        ? `Close proposal for issue #${n} resolved automatically — PR #${cause.prNumber} closed the issue`
        : `Close proposal for issue #${n} resolved automatically — the issue was closed on GitHub`;
      await sendSystemMessage(pool, row.app_id, msg, 'system')
        .catch((err) => log.warn('issues', 'Superseded chat message failed', { err: err.message }));
      await sendSystemMessage(pool, row.app_id, msg, 'system',
        null, { type: 'governance', ref: row.id }).catch(() => {});
      // Same event the withdraw path emits — open clients drop the card and
      // the target issue's row reverts to "Propose to close".
      pushIssueUpdate({ action: 'closed', appSlug: appSlug || null, appId: row.app_id, issueId: row.id });
      log.info('issues', 'Close proposal superseded', {
        issueId: row.id, appId: row.app_id, target: n, supersededBy,
      });
    }
  } catch (err) {
    log.warn('issues', 'Superseded close-proposal resolve failed', {
      appId, numbers: nums, err: err.message,
    });
  }
  return { resolved };
}

/**
 * Vote-apply path for `kind='close_issue'` issues. Same shape as
 * maybeApplyRenameProposal: gate check, lock the issue row, mark the
 * proposal closed atomically, then best-effort side effects (chat, GitHub
 * close + explanation comment, bounty voiding, cache/UI sync).
 *
 * Runs a SUPERSEDED GUARD first, on every invocation (including
 * non-mergeable sweeper calls): when a healthy cached open-issues fetch
 * shows the target is no longer open, the proposal is resolved as
 * superseded instead of applied — this doubles as the hourly catch-all for
 * issues closed by hand on GitHub.
 *
 * `options.force` (admin force-apply) skips the majority + locked-app gates,
 * like the secret-change path; the row lock still prevents a double-apply.
 */
async function maybeApplyCloseIssueProposal(pool, issue, options = {}) {
  const force = !!options.force;
  const issueNumber = Number(issue.payload?.issueNumber);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    log.warn('issues', 'Close proposal missing issueNumber', { issueId: issue.id });
    return { applied: false, error: 'missing issueNumber' };
  }

  // Repo coordinates for the superseded guard and the GitHub close below.
  // (The vote route's issue row carries app_slug but not repo_url.)
  const { rows: appRows } = await pool.query(
    'SELECT slug, repo_url FROM apps WHERE id = $1',
    [issue.app_id]
  );
  const appSlug = issue.app_slug || appRows[0]?.slug || null;
  const parsed = parseOwnerRepo(appRows[0]?.repo_url);

  // Superseded guard: a healthy fetch (no degradation note) that doesn't
  // list the target means it was already closed by other means — retire the
  // proposal instead of applying. A degraded fetch skips the guard and
  // proceeds optimistically.
  if (github.isEnabled() && parsed) {
    const ghResult = await github.fetchPublicIssues(parsed.owner, parsed.repo);
    if (!ghResult.note) {
      const stillOpen = (ghResult.issues || []).some((i) => i.number === issueNumber);
      if (!stillOpen) {
        await resolveSupersededCloseProposals(pool, {
          appId: issue.app_id,
          appSlug,
          numbers: [issueNumber],
          cause: { kind: 'github-close' },
        });
        return { applied: false, superseded: true };
      }
    }
  }

  // #646: governance-aware gate (down votes feed both gates, anchored
  // on created_at). An admin force-apply skips it, like force-merge.
  const { majority } = await getActiveUserStats(pool, issue.app_id);
  const governanceSvc = require('../services/governance');
  const gate = await governanceSvc.governedGate(pool, issue.app_id, {
    kind: 'issue', id: issue.id, openedAt: issue.created_at,
  });
  const upCount = gate.qualifiedYes;
  const active = gate.activeCount;
  const required = force ? upCount : gate.required;
  if (!force && !gate.mergeable) {
    return {
      applied: false, upCount, majority, active,
      required: gate.required, windowEndsAt: gate.windowEndsAt,
      waitingForWindow: (gate.thresholdMet || gate.lazyArmed) && !gate.windowElapsed,
    };
  }

  // Locked apps additionally require at least one admin up vote — same rule
  // as the rename/secret paths. An admin force-apply trivially satisfies it.
  if (!force && await isAppLocked(pool, issue.app_id)) {
    const adminUp = await hasAdminUpVote(pool, issue.id);
    if (!adminUp) {
      log.info('issues', 'Close-issue majority reached but app is locked; awaiting admin up', {
        issueId: issue.id, upCount, majority,
      });
      return { applied: false, upCount, majority, active, awaitingAdmin: true };
    }
  }

  const client = await pool.connect();
  let locked;
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
    locked = lockRows[0];

    const auditPayload = {
      ...(locked.payload || {}),
      appliedAt: new Date().toISOString(),
      appliedBy: force ? `admin:${options.forceBy?.username || 'unknown'}` : 'group-vote',
      upCount, required, active,
    };
    await client.query(
      `UPDATE issues SET status = 'closed', payload = $1 WHERE id = $2`,
      [JSON.stringify(auditPayload), locked.id]
    );

    // Also close any internal open twin rows for the target (a platform-
    // filed 'general' issue whose GitHub twin is the number being closed),
    // so creator-attribution rows don't linger open.
    await client.query(
      `UPDATE issues SET status = 'closed'
        WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open' AND id <> $3`,
      [issue.app_id, issueNumber, locked.id]
    );

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    log.error('issues', 'Close-issue apply failed', { issueId: issue.id, err: err.message });
    return { applied: false, error: err.message };
  } finally {
    client.release();
  }

  // ---- Side effects: best-effort, outside the txn. ----

  // Void open bounties on the target: the issue is closing without a merged
  // PR, so no one earns the kudos — and an 'open' row would linger forever
  // and keep inflating the issue's bounty count (same rationale as the
  // self-bounty voiding in routes/votes.js resolveIssueBounty). Allowance
  // slots stay forfeited, consistent with existing policy.
  try {
    await pool.query(
      `UPDATE issue_bounties SET status = 'voided', awarded_at = NOW()
        WHERE app_id = $1 AND github_issue_number = $2 AND status = 'open'`,
      [issue.app_id, issueNumber]
    );
  } catch (err) {
    log.warn('issues', 'Bounty voiding on close-issue apply failed', {
      issueId: issue.id, issueNumber, err: err.message,
    });
  }

  const appliedHow = force
    ? `by admin override (${options.forceBy?.username || 'admin'})`
    : `by group vote (${upCount}/${required})`;
  const closedMsg = `Issue #${issueNumber} closed ${appliedHow}`;
  await sendSystemMessage(pool, issue.app_id, closedMsg, 'system')
    .catch((err) => log.warn('issues', 'Close-issue chat msg failed', { err: err.message }));
  // Dual-post the outcome into the proposal's governance thread AND the
  // target issue's thread (mirrors the create path's dual-post).
  await sendSystemMessage(pool, issue.app_id, closedMsg, 'system',
    null, { type: 'governance', ref: locked.id }).catch(() => {});
  await sendSystemMessage(pool, issue.app_id, closedMsg, 'system',
    null, { type: 'issue', ref: issueNumber }).catch(() => {});

  // GitHub: close FIRST, then comment (same ordering rationale as the
  // rename path — a stale "closed by vote" comment must not land on an
  // issue we failed to close). Both helpers route through getOctokit
  // (PAT-preferred) and safeMention.
  if (github.isEnabled() && parsed) {
    try {
      await github.closeIssue(parsed.owner, parsed.repo, issueNumber);

      let commentBody = force
        ? `Closed by admin override (${options.forceBy?.username || 'admin'}) on Usernode.`
        : `Closed by group vote (${upCount}/${required}) on Usernode.`;
      const reason = typeof locked.payload?.reason === 'string'
        ? locked.payload.reason.trim() : '';
      if (reason) {
        let proposerName = null;
        try {
          const { rows: userRows } = await pool.query(
            'SELECT username FROM users WHERE id = $1', [locked.created_by]
          );
          proposerName = userRows[0]?.username || null;
        } catch {}
        commentBody += `\n\n${proposerName || 'The proposer'}'s reason: ${reason}`;
      }
      await github.createIssueComment(parsed.owner, parsed.repo, issueNumber, commentBody)
        .catch((err) => log.warn('issues', 'Close-issue comment failed', {
          issue: issueNumber, status: err.status, err: err.message,
        }));
    } catch (err) {
      log.warn('issues', 'GitHub issue close (close-issue vote) failed', {
        issue: issueNumber, status: err.status, err: err.message || '(empty)',
      });
    }

    // Cache/UI sync (mirrors the issue-close watcher's bustAndBroadcast):
    // suppress the number so the eventually-consistent GitHub list can't
    // resurrect it, bust the cache, and tell every open panel to refetch.
    try {
      github.noteIssuesClosed(parsed.owner, parsed.repo, [issueNumber]);
      github.invalidateIssuesCache(parsed.owner, parsed.repo);
      pushIssueUpdate({
        action: 'github_synced',
        appSlug,
        appId: issue.app_id,
        source: 'close_issue_vote',
      });
    } catch (err) {
      log.warn('issues', 'Cache bust after close-issue apply failed', {
        issueNumber, err: err.message,
      });
    }
  }

  log.info('issues', 'Close-issue proposal applied', {
    issueId: issue.id, appId: issue.app_id, issueNumber, upCount, active, force,
  });
  return { applied: true, issueNumber, upCount, majority, active, force };
}

module.exports = {
  issueRoutes,
  creatorFromSourceLine,
  shouldCreateGithubTwin,
  // Exported so the stale-PR sweeper can fire window-elapsed governance
  // applies (parity with PR window-elapsed merges).
  maybeApplyRenameProposal,
  maybeApplySecretChangeProposal,
  maybeApplyCloseIssueProposal,
  // Exported for the merge path and the issue-close watcher (auto-resolve
  // of close proposals whose target was closed by other means).
  resolveSupersededCloseProposals,
};
