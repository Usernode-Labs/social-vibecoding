const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const staging = require('../services/staging');
const docker = require('../services/docker');
const { checkAndResolveConflicts, isResolving } = require('../services/conflict-resolver');
const { sendSystemMessage, pushNotificationToUser } = require('../services/ws');
const { getActiveUserStats, isUserActive } = require('../services/active-users');
const notifications = require('../services/notifications');
const { isAppLocked, hasAdminYesVote } = require('../services/admin-approval');
const events = require('../services/events');
const appAccess = require('../services/app-access');
const topicAttrs = require('../services/topic-attributes');

// Staging-only mock PR proposals for GET /api/apps/:slug/promoted,
// appended only when the request carries ?demo=1 (forwarded from the
// page URL by _demoQS in app-view.js). Sibling of stagingMockIssues in
// routes/issues.js: deliberately long titles (~90-120 chars) so the dev
// card list's progressive title wrapping can be verified on narrow
// screens against a prod-cloned DB. Rows are "[Mock]"-prefixed and use
// ids/PR numbers far above anything real so they can't collide with
// (or be mistaken for) live sessions; user_id 0 matches no viewer, so
// owner-only affordances ("Open session") never render on them. Casting
// a vote on one 404s harmlessly. Strictly a no-op in production.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

function stagingMockProposals() {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const mk = (id, prNumber, title, hours, yes, no, chat) => ({
    id,
    pr_number: prNumber,
    pr_url: null,
    pr_title: title,
    pr_summary_md: 'This is a sample plain-language summary so testers can see '
      + 'the new explanation that now appears at the top of a proposal — written '
      + 'in everyday words, with no technical jargon.',
    staging_url: null,
    testing_md: null,
    testing_path: null,
    user_id: 0,
    status: 'promoted',
    linked_issues: null,
    username: 'staging-tester',
    created_at: hoursAgo(hours),
    promoted_at: hoursAgo(hours),
    yes_count: yes,
    no_count: no,
    my_vote: null,
    kudos_count: 0,
    my_kudos: false,
    my_kudos_direct: false,
    revert_of_session_id: null,
    original_pr_number: null,
    original_pr_title: null,
    chat_count: chat,
    last_message_at: chat ? hoursAgo(Math.max(0, hours - 1)) : null,
    visuals: null,
    resolving: false,
    // #381: console-error check snapshot. Clean by default; the dedicated
    // error mock below overrides these so the warning badge + detail block
    // are reviewable on staging via ?demo=1.
    console_check_state: 'clean',
    console_errors: [],
    console_checked_at: hoursAgo(hours),
    // #47: "CI for proposals" check snapshot. Passing by default; the
    // dedicated failing/pending/error mocks below override these so every
    // checks-badge variant + the per-test detail are reviewable via ?demo=1.
    check_state: 'passing',
    test_results: [
      { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
    ],
    checks_checked_at: hoursAgo(hours),
    // Community-voted priority + assignee chips. Populated so both card
    // states are reviewable on staging via ?demo=1.
    priority: { top: 'high', count: 2, myValue: null },
    assignee: { top: 'staging-tester', count: 3, myValue: null },
  });
  return [
    mk(9000001, 900101,
      '[Mock] Long-title test: rework the proposal card header so the '
      + 'discussion badge and vote tally wrap gracefully on narrow phones',
      3, 1, 0, 4),
    mk(9000002, 900102,
      '[Mock] Long-title test: walk brand-new collaborators through '
      + 'voting, kudos and dev sessions step by step',
      11, 0, 1, 0),
    // #239/#388: a row mid-auto-conflict-resolution so the "Resolving
    // conflicts…" badge is verifiable on staging via ?demo=1 without
    // manufacturing a real merge conflict. Aged to ~10h so that, without
    // the #388 merge-pipeline pin, recency alone would sink it down the
    // list — making the pin (which lifts it near the top) obvious.
    {
      ...mk(9000003, 900103,
        '[Mock] Resolving-state test: add a dark-mode toggle to the settings drawer',
        10, 2, 0, 2),
      resolving: true,
    },
    // #388: a row in the GitHub merge pipeline ('merging') so the
    // "Merging…" badge — and the top-of-stack pin — are verifiable on
    // staging via ?demo=1. Deliberately the OLDEST mock (~13h) so without
    // the pin it would sort dead last; the pin must lift it to rank 0,
    // above every other proposal.
    {
      ...mk(9000006, 900106,
        '[Mock] Merging-state test: this PR is mid-merge and should pin to the very top',
        13, 4, 0, 5),
      status: 'merging',
    },
    // #388: a row whose automatic conflict resolution failed
    // (merge_conflict_state 'failed') so the "⚠ Conflict resolution
    // failed" badge, the expanded conflicting-file list, and the pin
    // (just below merging + resolving) are verifiable via ?demo=1. Aged
    // ~12h so recency alone wouldn't float it.
    {
      ...mk(9000007, 900107,
        '[Mock] Conflict-failed test: auto-resolve could not finish; owner must fix it',
        12, 3, 1, 2),
      merge_conflict_state: 'failed',
      behind_main: 2,
      conflict_files: ['src/app.js', 'public/index.html'],
      conflict_checked_at: hoursAgo(11),
    },
    // #124: a visibility-change proposal (a dapp.json PR opened by the
    // Members & visibility modal) so its self-describing card is
    // reviewable on staging via ?demo=1.
    mk(9000004, 900104,
      '[Mock] Make this app invite-only build, public to view',
      2, 1, 0, 1),
    // #381: a proposal whose staging preview logged console errors, so the
    // amber "⚠ Console errors" badge and the expanded error list in the
    // detail view are reviewable on staging via ?demo=1.
    {
      ...mk(9000005, 900105,
        '[Mock] Console-error test: refactor the feed renderer (logs errors on load)',
        4, 1, 0, 3),
      console_check_state: 'errors',
      console_errors: [
        { kind: 'pageerror', message: "TypeError: Cannot read properties of undefined (reading 'map')", source: 'app.js:142' },
        { kind: 'console', message: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)', source: '/api/feed:0' },
      ],
      // #47: same proposal fails its checks — the amber "⚠ Checks failing"
      // badge + the per-test detail (a console-error failure plus a
      // missing-selector failure) are reviewable via ?demo=1, and the gate
      // would block this merge.
      check_state: 'failing',
      test_results: [
        { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
        {
          name: 'Feed renders', path: '/#/feed', status: 'fail',
          consoleErrors: [
            { kind: 'pageerror', message: "TypeError: Cannot read properties of undefined (reading 'map')", source: 'app.js:142' },
          ],
          failureReason: '1 console error on load',
        },
        {
          name: 'Composer is visible', path: '/#/feed', status: 'fail',
          consoleErrors: [],
          failureReason: 'Expected element ".composer" was not found',
        },
      ],
    },
    // #47: a proposal still running its checks — the grey "Checks running…"
    // spinner badge is reviewable via ?demo=1, and the gate would block the
    // merge until the run reports.
    {
      ...mk(9000008, 900108,
        '[Mock] Checks-pending test: tests are still running on the staging build',
        5, 2, 0, 1),
      check_state: 'pending',
      test_results: [],
    },
    // #47: a proposal whose checks could not run (staging build / capture
    // broke) — the red "⚠ Checks couldn't run" badge is reviewable via
    // ?demo=1, and the gate blocks fail-closed.
    {
      ...mk(9000009, 900109,
        '[Mock] Checks-error test: the staging build or test run itself broke',
        6, 1, 0, 0),
      check_state: 'error',
      test_results: [],
    },
    // #405: a proposal that PASSED the vote with green checks and is not
    // behind — eligible and queued to merge. Verifies the new green
    // "Passed — merging shortly" badge on the feed card + home strip via
    // ?demo=1. yes_count is set well above any plausible staging majority so
    // the row reliably reads as past-threshold (the vote pill fills green).
    mk(9000010, 900110,
      '[Mock] Ready-to-merge test: votes passed and checks are green — queued to merge',
      4, 9, 0, 3),
  ];
}

// #194: staging demo rows for the Completed (merged) list, mirroring
// stagingMockProposals. Lets ?demo=1 verify the new clickable Completed
// rows, the chevron/hover affordance, and the 💬 badge against a
// prod-cloned DB. Caveat: these mock rows have NO backing chat_messages,
// so opening one shows an empty (but still postable) thread — useful for
// the card affordance + badge, not for existing-comment display.
function stagingMockMerged() {
  const daysAgo = (d) => new Date(Date.now() - d * 86400 * 1000).toISOString();
  const mk = (id, prNumber, title, days, chat) => ({
    id,
    pr_number: prNumber,
    pr_url: null,
    pr_title: title,
    pr_summary_md: 'This is a sample plain-language summary so testers can see '
      + 'the new explanation at the top of a completed proposal — in everyday '
      + 'words, with no technical jargon.',
    user_id: 0,
    status: 'merged',
    linked_issues: null,
    username: 'staging-tester',
    created_at: daysAgo(days),
    revert_of_session_id: null,
    votes_required: 2,
    active_users_at_merge: 3,
    yes_count: 2,
    no_count: 0,
    my_vote: null,
    kudos_count: 0,
    my_kudos: false,
    my_kudos_direct: false,
    chat_count: chat,
    revert_session_id: null,
    revert_pr_number: null,
    revert_pr_url: null,
    revert_status: null,
    // #381: merged mocks are clean by default (the warning is reviewable on
    // the promoted list); these keep the detail view from reading undefined.
    console_check_state: 'clean',
    console_errors: [],
    console_checked_at: daysAgo(days),
    // #47: a merged proposal passed its checks by definition of the gate.
    check_state: 'passing',
    test_results: [
      { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
    ],
    checks_checked_at: daysAgo(days),
    // Read-only priority + assignee chips persist on completed proposals.
    priority: { top: 'medium', count: 2, myValue: null },
    assignee: { top: 'staging-tester', count: 2, myValue: null },
  });
  return [
    mk(9100001, 910101,
      '[Mock] Completed: tighten the empty-state copy on the dev forum',
      1, 5),
    mk(9100002, 910102,
      '[Mock] Completed: bump the chat composer hit area on mobile',
      4, 0),
  ];
}

function voteRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Per-app visibility gate for the session-id-addressed vote routes
  // (promote / vote / votes / undo / admin-merge): collab-level access,
  // 404 on deny. Admins always pass inside the guard.
  router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));

  // Promote a session's PR for voting
  router.post('/api/sessions/:id/promote', async (req, res) => {
    try {
      // #183: headless rows are excluded — auto sessions are never
      // promotable themselves; users clone them and propose the clone.
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status = 'active'
           AND cs.is_headless = FALSE`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Active session not found' });
      const session = rows[0];

      // Promoted-PR cap: worker-less promoted sessions don't count
      // against maxUserSessions (see the create-session cap in
      // routes/sessions.js), so this is the bound that keeps one user
      // from accumulating unlimited open-for-vote PRs (each holding a
      // staging preview and vote-panel attention). Checked before the
      // lazy PR creation below so an over-cap promote doesn't open a
      // PR it then refuses to put up for vote.
      const { rows: promotedRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM chat_sessions
         WHERE user_id = $1 AND status IN ('promoted', 'merging') AND is_headless = FALSE`,
        [req.user.id]
      );
      if (parseInt(promotedRows[0].cnt) >= config.maxUserPromotedSessions) {
        return res.status(429).json({
          error: `You already have ${config.maxUserPromotedSessions} PRs up for vote. Wait for one to merge, or archive one first.`,
        });
      }

      const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

      // #183 lazy PR creation: sessions cloned from a headless auto run
      // arrive here without a PR (the headless contract defers it). Create
      // it now on THIS session's branch — the clone's, never the auto
      // branch — so the vote has something to merge. applyPrMetadata reads
      // the clone's copied history via gatherSessionContext, so the PR
      // title/body get the full auto-session context.
      //
      // Also runs when a PR exists but pr_title is missing: staging
      // recovery (server.js rebuildSessionStaging) can mint a PR before
      // promotion without a generated title, and a NULL pr_title would
      // otherwise render as "Change by <user>" forever. Backfilling it
      // here updates both GitHub and pr_title/session_title.
      if (!session.pr_number || !session.pr_title) {
        // Distinguish creating a PR (no pr_number → a failure must block
        // promotion) from merely backfilling a missing title on an
        // existing PR (best-effort — never block promotion on it).
        const isBackfill = !!session.pr_number;
        const { rows: msgRows } = await pool.query(
          `SELECT content FROM chat_session_messages
           WHERE session_id = $1 AND role = 'user'
           ORDER BY id DESC LIMIT 1`,
          [session.id]
        );
        const prMetadata = require('../services/pr-metadata');
        let prResult = null;
        let prError = null;
        try {
          prResult = await prMetadata.applyPrMetadata({
            pool, session, repoOwner, repoName,
            userMessage: msgRows[0]?.content || '',
            ccSummary: '',
            username: req.user.username,
            userId: req.user.id,
          });
        } catch (err) {
          prError = err;
          log.warn('votes', 'Lazy PR creation/backfill threw', { sessionId: session.id, backfill: isBackfill, err: err.message, code: err.code || null });
        }
        if (!isBackfill && (!prResult || !session.pr_number)) {
          // Refuse to promote PR-less — a vote with nothing to merge is a
          // dead end. Nothing was mutated yet.
          if (prError && prError.code === 'no_commits') {
            // Permanent condition: the branch has no commits on GitHub
            // (typically committed locally but never pushed). "Try again
            // in a moment" would loop forever — tell the truth instead.
            return res.status(409).json({
              error: 'This change has no committed code on its branch yet, so there is nothing to open a pull request for. Re-run your request in the session so it produces and pushes a commit, then propose again.',
            });
          }
          return res.status(502).json({
            error: 'Could not create the pull request for this change. Please retry; if it keeps failing, re-run your request in the session.',
          });
        }
      }

      // Mark PR as ready for review on GitHub. We deliberately DO NOT
      // touch the title here — previously this overwrote the LLM-
      // generated title back to "<user>'s changes" every time a PR
      // was promoted, wiping the more descriptive title.
      if (github.isEnabled() && session.repo_url && session.pr_number) {
        try {
          const [, owner, repo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
          if (owner && repo) {
            // octokit.request rather than .rest.pulls.update —
            // @octokit/app's installation Octokit is a bare core
            // instance without the rest-endpoint-methods plugin, so
            // .rest is undefined.
            const octokit = await github.getInstallationOctokit(owner);
            await octokit.request(
              'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
              { owner, repo, pull_number: session.pr_number, draft: false }
            );
          }
        } catch (err) {
          log.warn('votes', 'Failed to update PR on GitHub', { err: err.message });
        }
      }

      // promoted_at anchors the stale-PR sweeper's "no interest since"
      // clock; clearing stale_notified_at handles the re-promote case
      // (a previously-stale PR that's proposed again starts fresh).
      await pool.query(
        `UPDATE chat_sessions SET status = 'promoted', promoted_at = NOW(), stale_notified_at = NULL WHERE id = $1`,
        [session.id]
      );

      // Post to group chat. Include the PR title when we have one so
      // the feed reads like "evan promoted PR #8 — Add emoji stamp
      // centering fix for voting" instead of the opaque "PR #8 for
      // voting" which gives no hint about what's being voted on.
      const promoLabel = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} promoted ${promoLabel} for voting`,
        'vote',
        // Lets the group-chat client render live vote buttons inline on
        // this activity row (see group-chat.js renderMessageHtml).
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } }
      );
      // Dual-post into the proposal's own thread so the topic discussion
      // carries its lifecycle in context (general chat stays the
      // app-wide entry point).
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} promoted ${promoLabel} for voting`,
        'vote',
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } },
        { type: 'session', ref: session.id }
      ).catch(() => {});

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'promoted', sessionId: session.id, appSlug: session.app_slug });
      log.info('votes', 'Session promoted', { sessionId: session.id });
      events.record(pool, {
        type: events.EVENT_TYPES.PR_PROMOTED,
        userId: req.user.id,
        appId: session.app_id,
        sessionId: session.id,
        metadata: { prNumber: session.pr_number || null },
      });
      // #183: return the PR info so the dev-chat staging card can flip
      // its "Changes ready" header to the PR link without a refetch —
      // the promote may have just created the PR lazily.
      res.json({
        ok: true,
        prNumber: session.pr_number || null,
        prUrl: session.pr_url || null,
        prTitle: session.pr_title || null,
      });

      // #183: a clone promoted straight off a headless auto run's pre-built
      // preview may not have its own staging yet (the copied card points at
      // the auto session's URL — same content, since the clone branch was
      // forked from it). Build the clone's own staging from its branch head,
      // fire-and-forget; the Pass-3 heal sweeper in server.js is the backstop.
      if (!session.staging_url) {
        (async () => {
          let commitHash = 'latest';
          if (github.isEnabled() && repoOwner && repoName) {
            try {
              const octokit = await github.getInstallationOctokit(repoOwner);
              const { data: ref } = await octokit.request(
                'GET /repos/{owner}/{repo}/git/ref/{+ref}',
                { owner: repoOwner, repo: repoName, ref: `heads/${session.branch_name}` }
              );
              commitHash = ref.object.sha;
            } catch {}
          }
          const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
          const result = await staging.buildAndDeployStaging(config, session, app, commitHash);
          await pool.query(
            `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
            [result.containerId, result.stagingUrl, session.id]
          );
          await staging.warmStagingCert(session, result.hostname, result.stagingUrl);
          // #195: capture before/after visuals off the fresh preview so
          // headless proposals promoted from clones get media on the vote
          // card + PR body even though the auto session's own staging (and
          // its capture window) may be long gone. Fire-and-forget; the
          // heuristic + all failure handling live inside the service.
          const visualsService = require('../services/visuals');
          visualsService.captureForSession(
            config, session, app, commitHash === 'latest' ? null : commitHash, result
          ).catch((err) => {
            log.warn('votes', 'Post-promote visuals capture failed', { sessionId: session.id, err: err.message });
          });
        })().catch((err) => {
          log.warn('votes', 'Post-promote staging build failed', { sessionId: session.id, err: err.message });
        });
      }

      // Vote-request fan-out. Non-fatal + post-response: the promote
      // itself has already succeeded, so a notification hiccup must not
      // 500 the request. Pings the app's active users + creator +
      // favoriters (minus the proposer) so the right people come vote,
      // and de-dupes per session so a re-promote doesn't re-spam.
      try {
        const notifRows = await notifications.createPrProposedNotifications(pool, {
          appId: session.app_id,
          sessionId: session.id,
          proposerId: req.user.id,
        });
        for (const row of notifRows) {
          pushNotificationToUser(row.user_id, {
            type: 'notification_new',
            notification: notifications.serialize({
              ...row,
              app_slug: session.app_slug,
              app_name: session.app_name,
              pr_title: session.pr_title,
              pr_number: session.pr_number,
              source_username: req.user.username,
            }),
          });
        }
        if (notifRows.length) {
          log.info('votes', 'PR-proposed notifications sent', {
            sessionId: session.id, count: notifRows.length,
          });
        }
      } catch (err) {
        log.warn('votes', 'pr_proposed notify failed', { sessionId: session.id, err: err.message });
      }
    } catch (err) {
      log.error('votes', 'Promote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Cast a vote on a promoted PR
  router.post('/api/sessions/:id/vote', async (req, res) => {
    const { vote } = req.body;
    if (!['yes', 'no'].includes(vote)) {
      return res.status(400).json({ error: 'Vote must be "yes" or "no"' });
    }

    try {
      // Accept votes on 'promoted' OR 'merging' sessions — once a merge
      // has started, a user flipping their vote shouldn't 404. But we
      // only *do* anything with the vote (chat message, merge check) if
      // it actually changed; see below.
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.id as app_id, a.repo_url,
                a.self_hosted as app_self_hosted
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status IN ('promoted', 'merging')`,
        [req.params.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Promoted session not found' });
      const session = sessionRows[0];

      // Was this a new vote, or a flip? Distinguishing matters because
      // without this, a user mashing "Yes" would post the same
      // "X voted yes on PR #N" line to group chat every time AND fire a
      // fresh checkAndMerge on every click — which, before the merge
      // concurrency guard, caused 7× parallel GitHub merges + docker
      // rebuilds stepping on each other's tempdirs and container names.
      // The DB upsert itself is still safe (UNIQUE(session_id,user_id))
      // but we avoid the side-effects on a no-op.
      const { rows: prevRows } = await pool.query(
        `SELECT vote FROM pr_votes WHERE session_id = $1 AND user_id = $2`,
        [session.id, req.user.id]
      );
      const previousVote = prevRows[0]?.vote || null;
      const unchanged = previousVote === vote;

      await pool.query(
        `INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, $3)
         ON CONFLICT (session_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, created_at = NOW()`,
        [session.id, req.user.id, vote]
      );

      // Any voting activity revives a going-stale PR: clear the warning
      // flag so the stale sweeper restarts its clock instead of archiving.
      if (session.stale_notified_at) {
        await pool.query(
          `UPDATE chat_sessions SET stale_notified_at = NULL WHERE id = $1`,
          [session.id]
        );
      }

      // Auto-dismiss this voter's PR notifications for this session now that
      // the vote is recorded in the DB (i.e. confirmed, not optimistic). Runs
      // before the `unchanged` early-return below so a re-vote still ensures
      // the nudge is cleared, and it's idempotent (clears only unread rows).
      // Non-fatal: a notification hiccup must never 500 a successful vote.
      try {
        const cleared = await notifications.markReadForSession(pool, req.user.id, session.id);
        if (cleared > 0) {
          // Fan out to the voter's OTHER tabs/devices so their unread badge
          // syncs without a manual refresh; the acting tab refreshes itself.
          pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
        }
      } catch (err) {
        log.warn('votes', 'notification auto-dismiss failed', {
          sessionId: session.id, userId: req.user.id, err: err.message,
        });
      }

      if (unchanged) {
        log.debug('votes', 'Vote unchanged, skipping broadcast+merge', {
          sessionId: session.id, userId: req.user.id, vote,
        });
        return res.json({ ok: true, merged: false, unchanged: true });
      }

      const voteLabel = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} voted ${vote} on ${voteLabel}`,
        'vote',
        // Lets the group-chat client render live vote buttons inline on
        // this activity row (see group-chat.js renderMessageHtml).
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } },
        // #194: per-vote activity lands in the proposal's own thread, not
        // general chat — the promote/merge announcements remain the
        // general-chat entry points.
        { type: 'session', ref: session.id }
      );

      // Broadcast the new tally *before* we try to merge, and respond
      // to the voter right away. checkAndMerge can take 30+ seconds on
      // the majority path (GitHub merge + prod rebuild + staging
      // teardown) and blocking on it here meant:
      //   - every other user's vote count sat stale until merge
      //     finished, which looked like "votes don't update live",
      //   - the voter's own UI sat mid-click with a spinning button
      //     while the merge ran, sometimes for the full 30s.
      // The merge itself still runs atomically (checkAndMerge claims
      // the session via 'promoted' → 'merging'), so kicking it into
      // the background doesn't change correctness.
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: false });
      log.info('votes', 'Vote cast', { sessionId: session.id, vote, userId: req.user.id });

      // Emit only on a real (new or flipped) vote — the `unchanged`
      // no-op already returned above. pr_vote_cast credits the voter;
      // pr_vote_received credits the PR author (when still attributed),
      // so the PR-promotion funnel can measure "got a vote" reach.
      events.record(pool, {
        type: events.EVENT_TYPES.PR_VOTE_CAST,
        userId: req.user.id,
        appId: session.app_id,
        sessionId: session.id,
        metadata: { vote },
      });
      if (session.user_id && session.user_id !== req.user.id) {
        events.record(pool, {
          type: events.EVENT_TYPES.PR_VOTE_RECEIVED,
          userId: session.user_id,
          appId: session.app_id,
          sessionId: session.id,
          metadata: { vote, voterId: req.user.id },
        });
      }
      res.json({ ok: true, merged: false });

      // Kick off the majority check in the background. If it turns
      // into a merge, we send a second broadcast so clients flip the
      // PR out of the vote panel and update the "merged" list.
      checkAndMerge(config, pool, session)
        .then((mergeResult) => {
          if (mergeResult?.merged) {
            pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: true });
          }
        })
        .catch((err) => {
          log.error('votes', 'Background merge failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('votes', 'Vote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get vote tally for a session
  router.get('/api/sessions/:id/votes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT pv.vote, u.username
         FROM pr_votes pv JOIN users u ON pv.user_id = u.id
         WHERE pv.session_id = $1`,
        [req.params.id]
      );

      const yes = rows.filter((r) => r.vote === 'yes');
      const no = rows.filter((r) => r.vote === 'no');

      res.json({ yes: yes.map((r) => r.username), no: no.map((r) => r.username) });
    } catch (err) {
      log.error('votes', 'Failed to get votes', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #194: the viewer's own proposals currently open for voting, across
  // all apps — PR proposals (their promoted/merging sessions) plus their
  // open governance (secret_change) proposals. Backs the home screen's
  // "Your proposals" section. Like /api/me/active-sessions, no extra
  // visibility filter is needed: these are the viewer's own rows, so the
  // apps are by construction ones they can collaborate on.
  router.get('/api/me/proposals', async (req, res) => {
    try {
      const { rows: sessions } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.status,
                cs.created_at, cs.promoted_at,
                cs.merge_conflict_state, cs.behind_main,
                cs.check_state,
                a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
                (SELECT COUNT(*)::int FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes WHERE session_id = cs.id AND vote = 'no') AS no_count
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
         WHERE cs.user_id = $1 AND cs.status IN ('promoted', 'merging')
           AND cs.is_headless = FALSE
         ORDER BY cs.promoted_at DESC NULLS LAST, cs.created_at DESC`,
        [req.user.id]
      );

      const { rows: governance } = await pool.query(
        `SELECT i.id, i.title, i.kind, i.created_at,
                a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'up') AS up_count,
                (SELECT COUNT(*)::int FROM issue_votes WHERE issue_id = i.id AND vote = 'down') AS down_count
         FROM issues i JOIN apps a ON a.id = i.app_id
         WHERE i.created_by = $1 AND i.kind = 'secret_change' AND i.status = 'open'
         ORDER BY i.created_at DESC`,
        [req.user.id]
      );

      // Per-app active-user majority (the denominator for the tally
      // pill). One getActiveUserStats call per distinct app, cached in
      // a map — most users have proposals on a handful of apps at most.
      const appIds = [...new Set([...sessions, ...governance].map((r) => r.app_id))];
      const statsByApp = {};
      for (const appId of appIds) {
        statsByApp[appId] = await getActiveUserStats(pool, appId);
      }

      const proposals = sessions.map((s) => ({
        ...s,
        majority: statsByApp[s.app_id]?.majority || 1,
        activeUsers: statsByApp[s.app_id]?.active || 1,
      }));

      // #405: staging-only demo rows (?demo=1) so the home "Your proposals"
      // strip's canonical merge-lifecycle chips — In vote, Behind, Resolving
      // conflicts…, Checks running…, Passed — merging shortly, Merging… — are
      // all reviewable against a prod-cloned DB. Reuses the same fixtures the
      // proposal feed uses (stagingMockProposals), mapped into this endpoint's
      // shape with a fixed demo majority of 3 so the tally-dependent states
      // (in-vote vs. ready) resolve deterministically regardless of the
      // staging app's live active-user count. Gated on IS_STAGING — a no-op
      // in production.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set(proposals.map((p) => p.id));
        const DEMO_MAJORITY = 3;
        const demoRows = stagingMockProposals()
          .filter((m) => (m.status === 'promoted' || m.status === 'merging') && !have.has(m.id))
          .map((m) => ({
            id: m.id,
            pr_number: m.pr_number,
            pr_url: m.pr_url,
            pr_title: m.pr_title,
            status: m.status,
            created_at: m.created_at,
            promoted_at: m.promoted_at,
            merge_conflict_state: m.merge_conflict_state || null,
            behind_main: m.behind_main || 0,
            check_state: m.check_state || null,
            test_results: m.test_results || [],
            resolving: m.resolving || false,
            app_id: 0,
            app_slug: 'staging-demo',
            app_name: 'Staging demo app',
            yes_count: m.yes_count,
            no_count: m.no_count,
            majority: DEMO_MAJORITY,
            activeUsers: DEMO_MAJORITY,
          }));
        proposals.push(...demoRows);
      }

      res.json({
        proposals,
        governance: governance.map((g) => ({
          ...g,
          majority: statsByApp[g.app_id]?.majority || 1,
          activeUsers: statsByApp[g.app_id]?.active || 1,
        })),
      });
    } catch (err) {
      log.error('votes', 'Failed to list my proposals', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List promoted sessions (for the vote panel in group chat)
  router.get('/api/apps/:slug/promoted', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', `${appAccess.ACCESS_COLUMNS}, locked`
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });
      const appRows = [gatedApp];

      const userId = req.user?.id || null;
      // Include 'merging' alongside 'promoted' so the PR stays visible
      // during the GitHub merge + prod rebuild + staging teardown
      // pipeline (~30s). Otherwise the card disappears the instant the
      // majority threshold is crossed and only reappears in the "merged"
      // list at the very end, making it look like the vote was lost.
      const { rows } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.pr_summary_md, cs.staging_url, cs.testing_md, cs.testing_path, cs.user_id, cs.status, cs.linked_issues, u.username, cs.created_at,
           -- #361: persisted merge-conflict snapshot for the card badge +
           -- detail block (state, conflicting file paths, last-checked).
           cs.merge_conflict_state, cs.behind_main, cs.conflict_files, cs.conflict_checked_at,
           -- #381: console-error check snapshot for the "may break the app"
           -- warning badge + detail block (advisory, never gates the vote).
           cs.console_check_state, cs.console_errors, cs.console_checked_at,
           -- #47: "CI for proposals" check snapshot for the checks badge +
           -- per-test detail block. Unlike the console snapshot this GATES
           -- merge (checkAndMerge blocks a non-'passing' proposal).
           cs.check_state, cs.test_results, cs.checks_checked_at,
           (SELECT COUNT(*) FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') as yes_count,
           (SELECT COUNT(*) FROM pr_votes WHERE session_id = cs.id AND vote = 'no') as no_count,
           (SELECT vote FROM pr_votes WHERE session_id = cs.id AND user_id = $2) as my_vote,
           -- Kudos counts piggy-back on this query so the vote panel
           -- doesn't fan out to N extra round-trips per PR card. The
           -- (session_id, giver_user_id) UNIQUE constraint makes EXISTS
           -- a single-index probe; COUNT runs against the per-session
           -- index added in schema.sql.
           -- kudos_count folds in any issue bounties AWARDED to this PR on
           -- merge (a bounty resolves into kudos credit for the closing PR's
           -- author), so the count matches the leaderboards. my_kudos is
           -- likewise true if the viewer either gave a PR kudos OR pledged a
           -- bounty that was awarded to this PR. my_kudos_direct isolates
           -- the first source — only a direct pr_kudos row is retractable
           -- (DELETE /api/sessions/:id/kudos), so the FE needs to know
           -- which kind of credit it's rendering.
           ((SELECT COUNT(*)::int FROM pr_kudos WHERE session_id = cs.id)
             + (SELECT COUNT(*)::int FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded')) as kudos_count,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)
                 OR EXISTS(SELECT 1 FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded' AND giver_user_id = $2)) as my_kudos,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)) as my_kudos_direct,
           -- #11: revert_of_session_id is non-null on PRs that are
           -- themselves a git-revert of an earlier merged PR. The
           -- vote panel uses this to render a Revert label
           -- instead of the regular title so voters know what they
           -- are voting on.
           cs.revert_of_session_id,
           orig.pr_number as original_pr_number,
           orig.pr_title  as original_pr_title,
           -- #194: per-proposal thread message count for the chat badge,
           -- plus the latest thread-message timestamp for the forum
           -- feed's activity sort. The partial thread index makes these
           -- index-only probes per row. promoted_at is the proposal's own
           -- activity anchor (falls back to created_at client-side).
           -- chat_count counts human messages only (msg_type='message')
           -- so dual-posted lifecycle/vote system rows don't make the 💬
           -- badge claim a discussion that hasn't happened.
           cs.promoted_at,
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id
               AND cm.msg_type = 'message') as chat_count,
           (SELECT MAX(cm.created_at) FROM chat_messages cm
             WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id) as last_message_at,
           -- #195/#270: before/after capture artifact ids, aggregated to
           -- one jsonb per row. Key is 'kind_index_media'
           -- ('before_0_png' -> id, 'after_1_webm' -> id, ...) so multiple
           -- captured routes (capture_index) don't collide. Shaped into the
           -- grouped client form below via visuals.shapeAgg (which also
           -- still accepts the legacy 'kind_media' key for pre-#270 rows).
           (SELECT jsonb_object_agg(
                     sv.kind || '_' || sv.capture_index || '_' || sv.media, sv.id)
              FROM session_visuals sv WHERE sv.session_id = cs.id) as visuals_agg
         FROM chat_sessions cs
         JOIN users u ON cs.user_id = u.id
         LEFT JOIN chat_sessions orig ON orig.id = cs.revert_of_session_id
         WHERE cs.app_id = $1 AND cs.status IN ('promoted', 'merging')
         ORDER BY cs.created_at DESC`,
        [appRows[0].id, userId]
      );

      const visualsService = require('../services/visuals');
      for (const row of rows) {
        row.visuals = visualsService.shapeAgg(row.visuals_agg);
        delete row.visuals_agg;
        // #239: surface in-flight auto-conflict-resolution so the vote
        // panel can render a "Resolving conflicts…" badge. Process-local
        // map lookup (no SQL) — authoritative in the single-process
        // platform, and self-healing on every panel refresh.
        row.resolving = isResolving(row.id);
      }

      // Community-voted priority + assigned-person summary per proposal,
      // keyed by session id (target_type='proposal'). Same minimal shape
      // the issue feed attaches; the dropdown lazy-loads the full tally
      // from /api/apps/:slug/topics/proposal/:id/attributes.
      const promotedAttrs = await topicAttrs.summarizeForTargets(
        pool, appRows[0].id, 'proposal', rows.map((r) => r.id), userId
      );
      for (const row of rows) {
        const s = promotedAttrs.get(row.id) || topicAttrs.emptySummary();
        row.priority = s.priority;
        row.assignee = s.assignee;
      }

      // Staging-only demo mode (?demo=1): append long-title mock
      // proposals for layout verification. The id check keeps the
      // append idempotent should a mock id ever materialize in the
      // result. See stagingMockProposals above.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set(rows.map((r) => r.id));
        rows.push(...stagingMockProposals().filter((m) => !have.has(m.id)));
      }

      const { active: activeUsers, majority } = await getActiveUserStats(pool, appRows[0].id);
      // Whether the viewer themself counts as active for this app —
      // surfaced on the group-chat dashboard so they can see their
      // own status and (if not counted) understand what to do about
      // it. Cheap query (two EXISTS lookups), runs alongside the
      // existing active-stats query.
      const viewerActive = await isUserActive(pool, appRows[0].id, userId);

      res.json({
        promoted: rows,
        activeUsers,
        majority,
        viewerActive,
        // Surfaced so the vote panel can render the "(locked — also
        // needs an admin yes)" hint on the Open PRs / Rename proposals
        // sections without a second round-trip. See loadVotePanel in
        // public/js/app-view.js.
        locked: !!appRows[0].locked,
      });
    } catch (err) {
      log.error('votes', 'Failed to list promoted', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List merged sessions
  router.get('/api/apps/:slug/merged', async (req, res) => {
    try {
      const gatedApp = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!gatedApp) return res.status(404).json({ error: 'App not found' });
      const appRows = [gatedApp];

      const userId = req.user?.id || null;
      // Same kudos subqueries as /promoted so the merged card can show
      // its count + per-viewer "you gave kudos" state without a second
      // round-trip per row. cs.user_id is also surfaced so the FE
      // kudos button can disable itself client-side for self-PRs
      // (server still 403s as authority).
      //
      // #11/#16: surfaces the revert-session metadata (pr_number, status)
      // when one exists — so the UI can render "Undone by PR #N" /
      // "Revert in vote (PR #N)" labels without a per-row round-trip.
      // (Undo is now a single direct action that opens a revert PR, so
      // there are no separate undo-vote tallies to surface.)
      const { rows } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.pr_summary_md, cs.user_id, cs.status, cs.linked_issues, u.username, cs.created_at,
           cs.revert_of_session_id,
           -- #381: console-error check snapshot so the warning + detail
           -- block stay visible on a merged proposal for post-hoc review.
           cs.console_check_state, cs.console_errors, cs.console_checked_at,
           -- #47: checks snapshot, kept visible on merged proposals for
           -- post-hoc review (a merged proposal passed, by the gate).
           cs.check_state, cs.test_results, cs.checks_checked_at,
           -- #58: the vote threshold + active-user count snapshotted at merge
           -- time. The merged-PR pill renders against votes_required (falling
           -- back to the live majority for legacy rows where it's NULL), and a
           -- tooltip surfaces "needed N of M active users at merge time" when
           -- both are present.
           cs.votes_required,
           cs.active_users_at_merge,
           -- Vote tally + per-viewer vote carried through so the group-chat
           -- activity row can keep its "x / y" pill and "You voted X" box
           -- after the PR merges (status='merged'), rather than the controls
           -- vanishing. Mirrors the /promoted subqueries.
           (SELECT COUNT(*) FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') as yes_count,
           (SELECT COUNT(*) FROM pr_votes WHERE session_id = cs.id AND vote = 'no') as no_count,
           (SELECT vote FROM pr_votes WHERE session_id = cs.id AND user_id = $2) as my_vote,
           -- kudos_count folds in any issue bounties AWARDED to this PR on
           -- merge (a bounty resolves into kudos credit for the closing PR's
           -- author), so the count matches the leaderboards. my_kudos is
           -- likewise true if the viewer either gave a PR kudos OR pledged a
           -- bounty that was awarded to this PR. my_kudos_direct isolates
           -- the first source — only a direct pr_kudos row is retractable
           -- (DELETE /api/sessions/:id/kudos), so the FE needs to know
           -- which kind of credit it's rendering.
           ((SELECT COUNT(*)::int FROM pr_kudos WHERE session_id = cs.id)
             + (SELECT COUNT(*)::int FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded')) as kudos_count,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)
                 OR EXISTS(SELECT 1 FROM issue_bounties WHERE awarded_session_id = cs.id AND status = 'awarded' AND giver_user_id = $2)) as my_kudos,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)) as my_kudos_direct,
           -- #194: per-proposal human-message count so the Completed list
           -- renders the same 💬 badge as the active proposals (and signals
           -- which merged proposals have a discussion worth opening). Counts
           -- msg_type='message' only — matching the /promoted subquery — so
           -- dual-posted lifecycle/vote system rows don't inflate the badge.
           (SELECT COUNT(*)::int FROM chat_messages cm
             WHERE cm.app_id = cs.app_id AND cm.thread_type = 'session' AND cm.thread_ref = cs.id
               AND cm.msg_type = 'message') as chat_count,
           rv.id        as revert_session_id,
           rv.pr_number as revert_pr_number,
           rv.pr_url    as revert_pr_url,
           rv.status    as revert_status
         FROM chat_sessions cs
         JOIN users u ON cs.user_id = u.id
         LEFT JOIN chat_sessions rv ON rv.revert_of_session_id = cs.id
           AND rv.status IN ('promoted', 'merging', 'merged')
         WHERE cs.app_id = $1 AND cs.status = 'merged'
         ORDER BY cs.created_at DESC
         LIMIT 20`,
        [appRows[0].id, userId]
      );

      // Same priority + assigned-person summary on completed proposals, so
      // the read-only chips stay visible after a PR merges.
      const mergedAttrs = await topicAttrs.summarizeForTargets(
        pool, appRows[0].id, 'proposal', rows.map((r) => r.id), userId
      );
      for (const row of rows) {
        const s = mergedAttrs.get(row.id) || topicAttrs.emptySummary();
        row.priority = s.priority;
        row.assignee = s.assignee;
      }

      // Staging-only demo mode (?demo=1): append mock merged rows so the
      // clickable Completed list + 💬 badge are verifiable against a
      // prod-cloned DB. Idempotent by id. See stagingMockMerged above.
      if (IS_STAGING && req.query.demo === '1') {
        const have = new Set(rows.map((r) => r.id));
        rows.unshift(...stagingMockMerged().filter((m) => !have.has(m.id)));
      }

      res.json({ merged: rows });
    } catch (err) {
      log.error('votes', 'Failed to list merged', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── #11/#16: undo a merged PR by opening a revert PR ───────────────
  //
  // Undo is symmetric with proposing a forward change: a single click
  // opens a revert PR (clone repo, `git revert <merge_sha>`, push, open
  // PR), inserted as a `promoted` session, which then goes through the
  // SAME merge vote as any other PR. There is no separate "undo vote"
  // gate anymore (#16) — previously undo was double-gated (a majority to
  // open the revert, then a second majority to merge it), which was
  // confusing and redundant. The merge vote on the revert PR is now the
  // single checkpoint, mirroring the forward propose→vote flow.
  //
  // The caller becomes the revert session's owner (user_id) so they
  // "own" the resulting PR for chat / status purposes.
  router.post('/api/sessions/:id/undo', async (req, res) => {
    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.id as app_id, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status = 'merged'`,
        [req.params.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Merged session not found' });
      const session = sessionRows[0];

      // Revert PRs are not themselves undoable — would create an endless
      // undo-undo-undo loop. The button is hidden on the client already;
      // this is the server-side enforcement.
      if (session.revert_of_session_id) {
        return res.status(409).json({ error: 'Cannot undo a revert PR' });
      }

      // Block if a revert is already in flight or landed for this merge.
      const { rows: existingRevert } = await pool.query(
        `SELECT id, status, pr_number, pr_url FROM chat_sessions
         WHERE revert_of_session_id = $1 AND status IN ('promoted', 'merging', 'merged')
         ORDER BY id DESC LIMIT 1`,
        [session.id]
      );
      if (existingRevert.length) {
        const rv = existingRevert[0];
        return res.status(409).json({
          error: `A revert PR for this merge already exists (status: ${rv.status})`,
          revertSessionId: rv.id,
          revertPrNumber: rv.pr_number,
          revertPrUrl: rv.pr_url,
        });
      }

      log.info('votes', 'Undo requested — opening revert PR', {
        sessionId: session.id, by: req.user.username,
      });
      // Respond immediately; the revert (clone + git revert + push + PR)
      // runs in the background and announces itself in group chat. The
      // vote panel refreshes via the pushVoteUpdate broadcast below.
      res.json({ ok: true, opening: true });

      const { pushVoteUpdate } = require('../services/ws');
      checkAndOpenRevert(config, pool, session, req.user)
        .then((result) => {
          if (result?.reverted) {
            pushVoteUpdate({
              sessionId: session.id,
              appSlug: session.app_slug,
              merged: false,
              kind: 'undo',
              revertSessionId: result.revertSessionId,
              revertPrNumber: result.revertPrNumber,
            });
          }
        })
        .catch((err) => {
          log.error('votes', 'Background revert failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('votes', 'Undo failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Admin force-merge ─────────────────────────────────────────────
  //
  // Admin-only escape hatch: merge a promoted PR right now, regardless
  // of vote tally or the locked-app admin-yes gate. Used when an admin
  // is confident the change should ship and doesn't want to wait for
  // the active-user majority. The frontend gates this behind a
  // ConfirmModal so a misclick can't accidentally bypass voting.
  //
  // The actual merge pipeline (atomic 'promoted → merging' claim,
  // GitHub merge, prod rebuild, staging teardown, broadcasts) is the
  // same `checkAndMerge` path the regular vote route uses — we just
  // pass `force: true` to skip the early gates. The chat message
  // distinguishes the override so users see who did it and why a PR
  // landed without the usual tally.
  router.post('/api/sessions/:id/admin-merge', async (req, res) => {
    if (!req.user?.canAdminWrite) {
      return res.status(403).json({ error: 'Full admin access required' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.id as app_id, a.repo_url,
                a.self_hosted as app_self_hosted
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status = 'promoted'`,
        [req.params.id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Promoted session not found' });
      }
      const session = rows[0];

      // Respond immediately; the merge itself runs in the background
      // exactly like the regular vote-driven path. Clients refresh via
      // the `pushVoteUpdate` broadcasts emitted by checkAndMerge.
      log.info('votes', 'Admin force-merge requested', {
        sessionId: session.id, by: req.user.username,
      });
      res.json({ ok: true, queued: true });

      checkAndMerge(config, pool, session, { force: true, forceBy: req.user })
        .then((mergeResult) => {
          if (mergeResult?.merged) {
            const { pushVoteUpdate } = require('../services/ws');
            pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: true });
          }
        })
        .catch((err) => {
          log.error('votes', 'Admin force-merge failed', {
            sessionId: session.id, err: err.message,
          });
        });
    } catch (err) {
      log.error('votes', 'Admin force-merge route failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// `options.force` (admin force-merge): skip the vote-count, locked-app
// admin-yes, and behind_main gates entirely and proceed straight to the
// claim+merge pipeline. The atomic `promoted → merging` claim still
// races against any concurrent vote-driven merge, so we won't double-
// merge. `options.forceBy` is the admin user object (id, username) used
// for the "merged by <admin> overriding vote" chat message.
// Resolve open issue bounties for a single closed issue when a PR merges.
//
// A bounty pledged via the Open Issues panel ("Give kudos") flips 'open' →
// 'awarded' and credits the merged PR's author — EXCEPT a bounty whose
// pledger IS that author, which would be self-kudos (the same thing the
// direct PR-kudos give path refuses with a 403; see routes/kudos.js). The
// awardee isn't known until merge, so the self-check lives here: self-pledged
// rows are 'voided' instead — not left 'open', because the issue is now
// closed on GitHub and no later PR will close it again, so an open row would
// linger forever and keep inflating the issue's open-bounty count. Voided
// rows keep awarded_session_id/awarded_at for audit but no awarded_user_id,
// so they earn no leaderboard credit. The pledger's weekly allowance slot is
// still forfeited (no refund) — every pledged bounty consumes a slot.
//
// `IS DISTINCT FROM` keeps a NULL giver (deleted pledger) and a NULL awardee
// (deleted PR author) on the award path. Self-voiding only runs when the PR
// has an author. Returns { awarded, voided } id arrays. Extracted from
// checkAndMerge so the self-bounty guard is unit-testable without driving the
// whole merge pipeline.
async function resolveIssueBounty(pool, { appId, sessionId, awardeeUserId, issueNumber }) {
  const { rows: awarded } = await pool.query(
    `UPDATE issue_bounties
        SET status = 'awarded',
            awarded_session_id = $1,
            awarded_user_id = $2,
            awarded_at = NOW()
      WHERE app_id = $3 AND github_issue_number = $4 AND status = 'open'
        AND giver_user_id IS DISTINCT FROM $2
      RETURNING id`,
    [sessionId, awardeeUserId || null, appId, issueNumber]
  );

  let voided = [];
  if (awardeeUserId) {
    const { rows } = await pool.query(
      `UPDATE issue_bounties
          SET status = 'voided',
              awarded_session_id = $1,
              awarded_at = NOW()
        WHERE app_id = $2 AND github_issue_number = $3 AND status = 'open'
          AND giver_user_id = $4
        RETURNING id`,
      [sessionId, appId, issueNumber, awardeeUserId]
    );
    voided = rows;
  }

  return { awarded, voided };
}

async function checkAndMerge(config, pool, session, options = {}) {
  // `options.autoResolve` (default true): when a merge is blocked by a
  // conflict / behind-main, kick off the worker-based auto-resolver
  // (sync with main + retry). The resolver re-invokes checkAndMerge with
  // autoResolve:false so its own conflict paths don't re-trigger the
  // resolver — this bounds the resolve+retry to a single cycle.
  const { force = false, forceBy = null, autoResolve = true } = options;
  const { active: activeCount, majority } = await getActiveUserStats(pool, session.app_id);

  const { rows: yesRows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM pr_votes WHERE session_id = $1 AND vote = 'yes'`,
    [session.id]
  );
  const yesCount = parseInt(yesRows[0].cnt);

  if (!force) {
    if (yesCount < majority) {
      return { merged: false, yesCount, needed: majority };
    }

    // Locked apps additionally require at least one admin yes vote (see
    // services/admin-approval.js + the apps.locked column). The active-user
    // majority gate above still has to pass — the admin yes is an extra
    // condition, not a replacement. Toggled via the home-card lock icon
    // (admin-only); see POST /api/apps/:slug/lock in routes/apps.js.
    if (await isAppLocked(pool, session.app_id)) {
      const adminYes = await hasAdminYesVote(pool, session.id);
      if (!adminYes) {
        log.info('votes', 'Majority reached but app is locked; awaiting admin yes', {
          sessionId: session.id, yesCount, majority,
        });
        return { merged: false, yesCount, needed: majority, awaitingAdmin: true };
      }
    }

    // #8: refuse the merge if the branch is behind origin/main. We don't
    // auto-spawn a sync turn from here because:
    //   1. Charging the sync to the voter who happened to push us over
    //      the threshold is unfair — the cost should land on the
    //      session owner who controls the branch.
    //   2. Auto-spawning would add ~30-90s latency to the merge with no
    //      visible feedback to the voter who triggered it.
    // Instead, surface in group chat that the owner needs to click
    // "Sync with main" in their dev-chat. The next yes vote will
    // re-attempt the merge, which succeeds once behind_main=0.
    if ((session.behind_main || 0) > 0) {
      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      const behindMsg = `${label} is ${session.behind_main} commit${session.behind_main === 1 ? '' : 's'} behind main — syncing automatically and will retry the merge. ${owner}: you can also resolve it from the session's dev-chat.`;
      await sendSystemMessage(pool, session.app_id, behindMsg, 'system');
      // Dual-post into the proposal's thread (lifecycle in context).
      await sendSystemMessage(pool, session.app_id, behindMsg, 'system',
        null, { type: 'session', ref: session.id }).catch(() => {});
      log.info('votes', 'Merge blocked: branch behind main', {
        sessionId: session.id, behind: session.behind_main,
      });
      // Auto-heal: sync the branch with main (worker git-merge +
      // Claude-on-markers) and retry the merge. The PR keeps its votes
      // because the sync push doesn't go through the vote-resetting
      // dev-turn path. Fire-and-forget so the voter's request returns
      // immediately.
      if (autoResolve) {
        // Funnel through the app-level drain so this vote-triggered resolve
        // is serialized with any other in-flight resolve for the app —
        // only one proposal per app resolves+merges at a time, highest-
        // voted first (this PR is eligible, so it's in that queue).
        checkAndResolveConflicts(config, { app_id: session.app_id }).catch((err) => {
          log.error('votes', 'Auto-resolve (behind_main) failed', {
            sessionId: session.id, err: err.message,
          });
        });
      }
      return { merged: false, yesCount, needed: majority, behindMain: session.behind_main };
    }

    // #47: "CI for proposals" gate. A proposal merges only when its
    // automated tests (the dapp.json `tests` suite, run against the staging
    // build by services/visuals.js — see check_state) are PASSING. Anything
    // else blocks fail-closed: 'failing' (a test broke), 'pending' (the
    // check is still running, or a fresh commit reset it and the rebuild
    // hasn't reported yet), 'error' ("couldn't run"), or NULL (never
    // checked). This is the answer to "everything got super broken" (#47).
    // Re-read fresh: the in-memory `session` row can predate the latest
    // build's verdict. Admin force-merge bypasses (skipped under !force).
    const { rows: checkRows } = await pool.query(
      `SELECT check_state, test_results FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    const checkState = checkRows[0]?.check_state || null;
    if (checkState !== 'passing') {
      const failingCount = Array.isArray(checkRows[0]?.test_results)
        ? checkRows[0].test_results.filter((r) => r && r.status !== 'pass').length
        : 0;
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      const reason = checkState === 'failing'
        ? `has ${failingCount || 'failing'} test${failingCount === 1 ? '' : 's'} failing`
        : checkState === 'error'
          ? "couldn't run its tests"
          : 'is still running its tests';
      const blockMsg = `${label} reached the vote threshold but ${reason} — merge is blocked until checks pass. The proposal's tests re-run automatically when its owner pushes a fix.`;
      await sendSystemMessage(pool, session.app_id, blockMsg, 'system').catch(() => {});
      await sendSystemMessage(pool, session.app_id, blockMsg, 'system',
        null, { type: 'session', ref: session.id }).catch(() => {});
      log.info('votes', 'Merge blocked: checks not passing', {
        sessionId: session.id, checkState, failingCount,
      });
      return {
        merged: false, yesCount, needed: majority,
        checksBlocked: true, checkState: checkState || 'pending', failingCount,
      };
    }
  }
  // For admin force-merge we deliberately skip the behind_main pre-check
  // — GitHub will still reject the merge if there's a real conflict,
  // and the catch-block below surfaces that the same way it does for
  // votes. Admins overriding the vote can decide whether to push the
  // branch sync themselves.

  // Majority reached. Try to claim the merge by atomically flipping
  // status 'promoted' → 'merging'. Only one concurrent caller will
  // win this; everyone else bails out. This guards against the
  // previous bug where hammering "Yes" fired N parallel merge+rebuild
  // pipelines that stomped on each other (GitHub lock, /tmp/usernode-
  // rebuild-* git clone races, duplicate `docker run --name ...`, etc).
  const { rows: claim } = await pool.query(
    `UPDATE chat_sessions SET status = 'merging'
     WHERE id = $1 AND status = 'promoted'
     RETURNING id`,
    [session.id]
  );
  if (!claim.length) {
    log.info('votes', 'Merge already claimed by another request, skipping', {
      sessionId: session.id,
    });
    return { merged: false, inProgress: true };
  }

  // Broadcast the 'merging' transition so every client refreshes its
  // vote panel and re-renders the PR as "Merging…" — rather than having
  // it silently disappear between the vote and the eventual 'merged'
  // state (30s+ on the majority path). `merged:false` here means "still
  // in flight"; the final `merged:true` broadcast fires below after the
  // GitHub merge + prod rebuild + staging teardown finish.
  //
  // SELF-HOSTING.md Phase 3: `selfHosted` rides along so clients
  // can latch into the "platform updating…" banner state at the moment
  // the merge starts. We can't rely on the post-merge
  // `app_version_changed` event for self-hosted apps because the GHA
  // rolling restart that follows drops the WebSocket — clients persist
  // the banner in sessionStorage on this event and dismiss it once
  // /api/version reports a different SHA. See public/js/app.js
  // (handleVoteUpdate / beginPlatformUpdating).
  const { pushVoteUpdate } = require('../services/ws');
  pushVoteUpdate({
    sessionId: session.id,
    appSlug: session.app_slug,
    merged: false,
    merging: true,
    selfHosted: !!session.app_self_hosted,
  });

  log.info('votes',
    force ? 'Admin force-merge invoked, merging' : 'Majority reached, merging',
    {
      sessionId: session.id, yesCount, needed: majority,
      ...(force && forceBy ? { forcedBy: forceBy.username } : {}),
    });

  let mergeCommitSha = null;
  // Tracks whether the irreversible GitHub merge has already happened. Once
  // it has, a failure in any LATER step (prod rebuild, staging teardown,
  // bounty payout, …) must NOT roll the session back to 'promoted' — the PR
  // is merged on GitHub and re-opening it for voting is the bug behind
  // "merged PRs still show up for voting" (the rebuild can keep failing —
  // e.g. a newly-required secret with no production value — yet the merge is
  // done). See the catch block below.
  let githubMerged = false;

  try {
    // Merge PR on GitHub
    if (github.isEnabled() && session.repo_url && session.pr_number) {
      const [, owner, repo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (owner && repo) {
        const mergeData = await github.mergePR(owner, repo, session.pr_number);
        // #11: capture the squash-merge commit SHA so future vote-to-undo
        // can `git revert <sha>` against main. The Octokit `pulls.merge`
        // response shape is { sha, merged: true, message }.
        mergeCommitSha = mergeData?.sha || null;
        githubMerged = true;
      }
    }

    // Rebuild production
    const { rows: appRows } = await pool.query('SELECT * FROM apps WHERE id = $1', [session.app_id]);
    const app = appRows[0];

    if (app) {
      let sha = null;
      // SELF-HOSTING.md sub-step 2g (Guard B): for the self-app,
      // there's no platform-managed prod container to rebuild — the
      // GitHub Actions deploy workflow rolls the harness when the merge
      // lands on main. Skip rebuildProduction entirely, but keep the
      // app_version_changed broadcast firing so Phase 3's banner has its
      // hook. main_sha is refreshed by seedSelfApp() on the next boot,
      // which clients pick up via /api/version.
      if (!app.self_hosted) {
        const result = await staging.rebuildProduction(config, app);
        sha = result.sha;
        // Also record the SHA + originating PR so the main app view can
        // show "live on <sha> · PR #<n>" (#21). pr_number comes from the
        // session we just merged; sha is what `rebuildProduction` cloned.
        await pool.query(
          `UPDATE apps SET container_id = $1, main_sha = $2, main_pr_number = $3,
                           last_deploy_at = NOW()
           WHERE id = $4`,
          [result.containerId, sha || null, session.pr_number || null, app.id]
        );
      } else {
        log.info('votes', 'Self-app PR merged; GitHub Actions auto-deploy will roll', {
          appId: app.id, prNumber: session.pr_number,
        });
      }
      // Let every tab watching this app refresh its commit pill without
      // polling. The existing vote_update event already fires on merge
      // but is scoped to vote panel refreshes; a dedicated event keeps
      // the concerns separated and avoids over-broadcasting. Fires for
      // self-hosted too (sha=null) so the future banner can detect
      // "platform updating" without a sha to anchor to.
      try {
        const { broadcastGlobalScoped } = require('../services/ws');
        broadcastGlobalScoped({
          type: 'app_version_changed',
          appSlug: session.app_slug,
          sha: sha || null,
          prNumber: session.pr_number || null,
        }, { appId: session.app_id, appSlug: session.app_slug });
      } catch {}
    }

    // Teardown staging
    await staging.teardownStaging(session, app);

    // #58: snapshot the vote threshold + active-user count in effect at
    // this merge, so the merged-PR pill shows the historical "yes / N"
    // instead of drifting with the live majority. majority/activeCount come
    // from getActiveUserStats() at the top of this function. COALESCE keeps
    // any earlier snapshot (defensive; the promoted→merging claim already
    // guarantees a single merge transition).
    await pool.query(
      `UPDATE chat_sessions SET status = 'merged', merged_at = NOW(),
                                merge_commit_sha = COALESCE($2, merge_commit_sha),
                                votes_required = COALESCE(votes_required, $3),
                                active_users_at_merge = COALESCE(active_users_at_merge, $4)
       WHERE id = $1`,
      [session.id, mergeCommitSha, majority, activeCount]
    );

    // pr_merged is the terminal stage of the PR-promotion funnel and the
    // signal behind the "merges over time" growth chart (now exact thanks
    // to merged_at above). Attributed to the PR author (session.user_id),
    // which may be NULL if the author was deleted.
    events.record(pool, {
      type: events.EVENT_TYPES.PR_MERGED,
      userId: session.user_id || null,
      appId: session.app_id,
      sessionId: session.id,
      metadata: {
        prNumber: session.pr_number || null,
        forced: !!force,
        ...(force && forceBy ? { forcedBy: forceBy.username } : {}),
      },
    });

    // Resolve any open issue bounties for the issues this PR closes (declared
    // through the session's linked_issues → `Closes #N` in the PR body).
    // Bounties pledged by OTHER users flip 'open' → 'awarded' and credit this
    // PR's author; a bounty the author pledged on their own resolved issue is
    // 'voided' instead (self-kudos guard — see resolveIssueBounty). Idempotent
    // (only status='open' rows transition, so a later PR closing the same
    // issue finds none) and best-effort — a failure here must never roll back
    // or fail the merge, same as the CC volume teardown below.
    try {
      const linked = Array.isArray(session.linked_issues) ? session.linked_issues : [];
      const seen = new Set();
      for (const raw of linked) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
        seen.add(n);
        const { awarded, voided } = await resolveIssueBounty(pool, {
          appId: session.app_id,
          sessionId: session.id,
          awardeeUserId: session.user_id || null,
          issueNumber: n,
        });
        if (voided.length) {
          log.info('votes', 'Self-bounty voided on merge', {
            sessionId: session.id, issueNumber: n, count: voided.length,
          });
        }
        // Only announce / record genuine awards; a purely self-voided issue
        // produces no "awarded" chat noise or event.
        if (!awarded.length) continue;
        events.record(pool, {
          type: events.EVENT_TYPES.BOUNTY_AWARDED,
          userId: session.user_id || null,
          appId: session.app_id,
          sessionId: session.id,
          metadata: { issueNumber: n, prNumber: session.pr_number || null, count: awarded.length },
        });
        const recipient = session.user_id ? `<@${session.user_id}>` : 'the author';
        const bountyMsg = `Bounty on issue #${n} (${awarded.length} kudos) awarded to ${recipient} — PR #${session.pr_number || session.id} merged`;
        await sendSystemMessage(pool, session.app_id, bountyMsg, 'system').catch(() => {});
        // Dual-post into the proposal's thread (lifecycle in context).
        await sendSystemMessage(pool, session.app_id, bountyMsg, 'system',
          null, { type: 'session', ref: session.id }).catch(() => {});
      }
    } catch (err) {
      log.warn('votes', 'Bounty payout failed', { sessionId: session.id, err: err.message });
    }

    // Keep the "Open Issues" panel honest. A merged PR carrying `Closes #N`
    // has just closed those issues on GitHub, but the panel reads
    // github.fetchPublicIssues (cached, state=open) and nothing else learns
    // the issue closed — so without this the closed issue lingers until the
    // cache TTL expires AND something separately triggers a panel reload.
    // Bust this repo's open-issues cache and broadcast a refresh so every
    // client viewing the app's group chat refetches (App.handleIssueUpdate →
    // AppView.loadVotePanel). Use the same repo_url regex as parseOwnerRepo
    // (routes/issues.js) so the invalidated key matches the cached one.
    // Best-effort and post-merge — a failure here must never fail the merge.
    try {
      const [, ghOwner, ghRepo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (ghOwner && ghRepo) {
        // #144: record the linked issues as closed BEFORE busting the
        // cache + broadcasting. GitHub's auto-close is async and its
        // anonymous list endpoint lags even further, so the refetch this
        // broadcast triggers can read the issues as still open and
        // re-cache them — the suppression list makes fetchPublicIssues
        // drop them no matter what the list says. Optimistic on purpose:
        // GitHub closes `Closes #N` reliably (just late), and the
        // suppression TTL self-heals the rare case where it doesn't.
        const { sanitizeIssueNumbers } = require('../services/pr-metadata');
        const closedNumbers = sanitizeIssueNumbers(session.linked_issues);
        if (closedNumbers.length) github.noteIssuesClosed(ghOwner, ghRepo, closedNumbers);
        github.invalidateIssuesCache(ghOwner, ghRepo);
        const { pushIssueUpdate } = require('../services/ws');
        pushIssueUpdate({
          action: 'github_synced',
          appSlug: session.app_slug,
          appId: session.app_id,
          source: 'pr_merged',
        });
      }
    } catch (err) {
      log.warn('votes', 'Open-issues refresh after merge failed', {
        sessionId: session.id, err: err.message,
      });
    }

    // #135: GitHub closes `Closes #N`-referenced issues itself, but a few
    // seconds AFTER the merge — so the cache bust + refetch above can race
    // it, re-caching the issue as open and leaving the group-chat panel
    // stale for the cache TTL. Watch the referenced issues (PR-body closing
    // keywords ∪ linked_issues) with retry/backoff until GitHub reports
    // them closed, then bust the cache and broadcast the refresh again.
    // Fired-and-forgotten — the polling must never slow down or fail the
    // merge flow, and nothing is ever written to GitHub.
    try {
      if (github.isEnabled() && session.pr_number) {
        const [, wOwner, wRepo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
        if (wOwner && wRepo) {
          const { watchIssuesClosedAfterMerge } = require('../services/issue-close-watcher');
          watchIssuesClosedAfterMerge({
            owner: wOwner,
            repo: wRepo,
            prNumber: session.pr_number,
            linkedIssues: session.linked_issues,
            appSlug: session.app_slug,
            appId: session.app_id,
          }).catch((err) => {
            log.warn('votes', 'Post-merge issue-close watch failed', {
              sessionId: session.id, err: err.message,
            });
          });
        }
      }
    } catch (err) {
      log.warn('votes', 'Post-merge issue-close watch setup failed', {
        sessionId: session.id, err: err.message,
      });
    }

    // Chat session is done — no further turns will reference CC memory,
    // so drop the persistent `.claude` volume.
    try {
      const worker = require('../services/worker');
      await worker.destroyCcVolume(session.id);
    } catch (err) {
      log.warn('votes', 'Failed to destroy CC volume', { sessionId: session.id, err: err.message });
    }

    // Announce in group chat, and dual-post into the proposal's own
    // thread so its discussion carries the outcome in context.
    const mergedLabel = session.pr_title
      ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
      : `PR #${session.pr_number || session.id}`;
    const mergedSuffix = force && forceBy
      ? `force-merged by admin ${forceBy.username} (${yesCount}/${activeCount} vote${yesCount === 1 ? '' : 's'} at the time)`
      : `merged and deployed! (${yesCount}/${activeCount} votes)`;
    await sendSystemMessage(pool, session.app_id,
      `${mergedLabel} ${mergedSuffix}`,
      'system'
    );
    await sendSystemMessage(pool, session.app_id,
      `${mergedLabel} ${mergedSuffix}`,
      'system', null, { type: 'session', ref: session.id }
    ).catch(() => {});

    // Cascade: drain the next eligible promoted PR for this app. The
    // app-level drain serializes this with any vote-triggered resolves so
    // only one PR per app resolves+merges at a time. Exclude the session we
    // just merged so it's never re-picked.
    checkAndResolveConflicts(config, { app_id: session.app_id, excludeSessionId: session.id }).catch((err) => {
      log.error('votes', 'Conflict resolution check failed', { err: err.message });
    });

    return { merged: true };
  } catch (err) {
    log.error('votes', 'Merge failed', { sessionId: session.id, err: err.message, githubMerged });

    // The GitHub merge is irreversible. If it already succeeded and a
    // LATER step threw (most commonly `staging.rebuildProduction` — e.g. a
    // PR that introduces a new required secret with no production value
    // raises MissingSecretsError, or two sibling rebuilds race on the
    // container name), the PR *is* merged. Rolling the session back to
    // 'promoted' here is exactly what left whiteboard PRs #41/#44/#52/#54
    // showing "up for voting" forever: `GET /api/apps/:slug/promoted`
    // returns `status IN ('promoted','merging')`, and any "retry" merge
    // 405s because GitHub has nothing left to merge. Instead, record the
    // merge and surface the deploy failure separately so an operator can
    // fix the cause and re-run the rebuild ("Check for updates" / drift
    // poller). The pre-merge conflict/behind_main handling further down is
    // premised on the merge NOT having happened, so we return early.
    if (githubMerged) {
      await pool.query(
        `UPDATE chat_sessions
            SET status = 'merged',
                merged_at = COALESCE(merged_at, NOW()),
                merge_commit_sha = COALESCE(merge_commit_sha, $2),
                votes_required = COALESCE(votes_required, $3),
                active_users_at_merge = COALESCE(active_users_at_merge, $4)
          WHERE id = $1 AND status IN ('merging', 'merged')`,
        [session.id, mergeCommitSha, majority, activeCount]
      ).catch((e) => log.error('votes',
        'Failed to mark session merged after post-merge error', {
          sessionId: session.id, err: e.message,
        }));

      const failLabel = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${failLabel} merged on GitHub, but the production deploy failed: ${err.message}. ` +
        `The change is on main; an operator can retry the deploy once the cause is resolved.`,
        'system'
      ).catch(() => {});

      try {
        const { pushVoteUpdate } = require('../services/ws');
        pushVoteUpdate({
          sessionId: session.id,
          appSlug: session.app_slug,
          merged: true,
          merging: false,
          deployFailed: true,
          selfHosted: !!session.app_self_hosted,
        });
      } catch (_) { /* ws failures non-fatal */ }

      return { merged: true, deployFailed: true, error: err.message };
    }

    // GitHub merge did NOT happen (conflict, auth, transient API error).
    // Release the 'merging' claim so a subsequent vote (or retry) can
    // try again. Without this the session would be stuck in 'merging'
    // forever on any transient failure.
    await pool.query(
      `UPDATE chat_sessions SET status = 'promoted'
       WHERE id = $1 AND status = 'merging'`,
      [session.id]
    ).catch(() => {});

    // #9: detect GitHub's "merge conflict" rejection specifically.
    // Octokit returns status 405 with a message containing "merge
    // conflict" or "not mergeable" when `pulls.merge` is called on
    // an unmergeable PR. Computed before the mergeFailed broadcast
    // below so the broadcast can flag whether the auto-resolver is
    // about to kick in (#239).
    const msg = String(err.message || '').toLowerCase();
    const isConflict =
      err.status === 405 ||
      msg.includes('merge conflict') ||
      msg.includes('not mergeable') ||
      msg.includes('pull request is not mergeable');

    // Un-latch clients. The `merging:true` broadcast above armed the
    // Phase 3 "Platform updating…" banner on every tab for self-hosted
    // apps — and that banner only dismisses on a /api/version SHA flip,
    // which will never come if the GitHub merge itself failed (no
    // deploy happens). Without this counter-event, a failed self-app
    // merge leaves the whole platform read-only for everyone until the
    // 5-minute stuck timer. mergeFailed:false-positives are harmless:
    // the client just clears a banner that wasn't armed.
    //
    // #239: `resolving` rides along when the failure is a conflict AND
    // the auto-resolver is about to be fired below — clients transition
    // the banner in place (updating → resolving) instead of silently
    // dismissing it while the resolver spends 1–2 minutes fixing the
    // branch. The resolver's own start broadcast can lag by a few
    // seconds (pollMergeable runs first), so this flag closes the gap.
    try {
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({
        sessionId: session.id,
        appSlug: session.app_slug,
        merged: false,
        merging: false,
        mergeFailed: true,
        resolving: isConflict && autoResolve,
        selfHosted: !!session.app_self_hosted,
      });
    } catch (_) { /* ws failures non-fatal */ }

    // The pre-merge gate in checkAndMerge catches
    // the common case (our recorded behind_main > 0), but races
    // (another PR merging in the window between our last sync and
    // the vote crossing threshold) can slip past it. When that
    // happens, our local behind_main is stale (= 0) but the branch
    // really is behind main, so we:
    //   1. Bump behind_main to at least 1 so the dev-chat banner
    //      reappears for the owner. The next worker turn will
    //      recompute the exact count.
    //   2. Broadcast session_update(behind_main) so any open dev-chat
    //      banner refreshes in place.
    //   3. Post a tailored group-chat message that matches the
    //      pre-merge gate's wording, so the user knows it's a
    //      "owner needs to click Sync" situation rather than a
    //      mysterious GitHub blowup.
    if (isConflict) {
      try {
        const { rows: bumpRows } = await pool.query(
          `UPDATE chat_sessions
             SET behind_main = GREATEST(behind_main, 1),
                 -- #361: a real merge-time conflict — reflect it on the
                 -- card immediately (conflict_files fills in on the next
                 -- sync, which captures the --diff-filter=U set).
                 merge_conflict_state = 'conflict',
                 conflict_checked_at = NOW()
           WHERE id = $1 RETURNING behind_main`,
          [session.id]
        );
        const newBehind = bumpRows[0]?.behind_main || 1;
        try {
          const { pushSessionUpdate } = require('../services/ws');
          pushSessionUpdate({
            action: 'behind_main',
            sessionId: session.id,
            appSlug: session.app_slug,
            behindMain: newBehind,
          });
        } catch (_) { /* ws failures non-fatal */ }
      } catch (_) { /* DB bump failures non-fatal — chat msg still goes out */ }

      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${label} hit a conflict with main — syncing automatically and will retry the merge. ${owner}: you can also resolve it from the session's dev-chat.`,
        'system'
      );
      // Auto-heal the conflict the same way the behind_main gate does.
      // autoResolve guards against the resolver's own retry re-entering
      // this path (it calls checkAndMerge with autoResolve:false).
      if (autoResolve) {
        // Same app-level drain as the behind_main path — serialized,
        // one-proposal-at-a-time-per-app resolution.
        checkAndResolveConflicts(config, { app_id: session.app_id }).catch((e) => {
          log.error('votes', 'Auto-resolve (merge conflict) failed', {
            sessionId: session.id, err: e.message,
          });
        });
      }
    } else {
      await sendSystemMessage(pool, session.app_id,
        `Failed to merge PR #${session.pr_number || session.id}: ${err.message}`,
        'system'
      );
    }
    return { merged: false, error: err.message, conflict: isConflict };
  }
}

// #11/#16: undo helper. Called from the /undo route. Opens a revert PR
// for a merged session (clone, `git revert <merge_sha>`, push, open PR)
// and inserts a `promoted` chat_sessions row for it that then goes
// through the normal merge vote. As of #16 there's no undo-vote gate —
// the merge vote on the revert PR is the single checkpoint.
//
// `decider` is the user who requested the undo — becomes the revert
// session's user_id so they own the resulting PR in dev-chat.
async function checkAndOpenRevert(config, pool, session, decider) {
  // #16: opening a revert is now a direct action (like proposing a
  // forward change) — there's no separate undo-vote gate to clear. We
  // still read activeCount/majority so the announcement can tell users
  // how many votes the revert PR will need to actually land. The
  // locked-app admin-yes gate is NOT applied here: it's a merge-time
  // control and is enforced when the revert PR's own merge vote is
  // tallied (checkAndMerge), exactly like a forward proposal.
  const { active: activeCount, majority } = await getActiveUserStats(pool, session.app_id);

  // Atomic claim — race-safe against parallel undo requests. We mark
  // the original session with revert_of_session_id = its own id as a
  // sentinel "claimed" value; the real revert session id swaps in
  // below once we have it. The WHERE NULL guarantees only one caller
  // wins this transition.
  const { rows: claim } = await pool.query(
    `UPDATE chat_sessions SET revert_of_session_id = id
     WHERE id = $1 AND revert_of_session_id IS NULL
     RETURNING id`,
    [session.id]
  );
  if (!claim.length) {
    log.info('votes', 'Revert already claimed by another request, skipping', {
      sessionId: session.id,
    });
    return { reverted: false, inProgress: true };
  }

  // Sanity precondition: we need a merge SHA to revert. For pre-#11
  // merged rows the column is NULL because mergePR's response wasn't
  // captured at the time. GitHub still knows the SHA via pulls.get —
  // try to backfill on demand, persist for next time, and proceed.
  // Only fall through to the manual-revert message if GitHub can't
  // help either (auth disabled, repo gone, PR never actually merged,
  // etc.).
  if (!session.merge_commit_sha) {
    let backfilledSha = null;
    let backfillReason = 'unknown';
    if (!github.isEnabled()) {
      backfillReason = 'GitHub auth not configured on this deployment';
    } else if (!session.repo_url) {
      backfillReason = 'session has no repo_url';
    } else if (!session.pr_number) {
      backfillReason = 'session has no pr_number';
    } else {
      const bm = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!bm) {
        backfillReason = `unparseable repo_url ${session.repo_url}`;
      } else {
        const [, bOwner, bRepo] = bm;
        try {
          // Use octokit.request rather than octokit.rest.pulls.get —
          // @octokit/app's installation octokit is a bare @octokit/core
          // instance and does not include the rest-endpoint-methods
          // plugin, so .rest is undefined.
          const octokit = await github.getInstallationOctokit(bOwner);
          const { data: pr } = await octokit.request(
            'GET /repos/{owner}/{repo}/pulls/{pull_number}',
            { owner: bOwner, repo: bRepo, pull_number: session.pr_number }
          );
          if (pr.merged && pr.merge_commit_sha) {
            await pool.query(
              `UPDATE chat_sessions SET merge_commit_sha = $2
               WHERE id = $1 AND merge_commit_sha IS NULL`,
              [session.id, pr.merge_commit_sha]
            );
            session.merge_commit_sha = pr.merge_commit_sha;
            backfilledSha = pr.merge_commit_sha;
            log.info('votes', 'Backfilled merge_commit_sha from GitHub', {
              sessionId: session.id, prNumber: session.pr_number,
              sha: pr.merge_commit_sha,
            });
          } else {
            backfillReason = pr.merged
              ? 'GitHub returned a merged PR with no merge_commit_sha'
              : 'GitHub says this PR is not merged';
          }
        } catch (err) {
          backfillReason = `GitHub lookup failed: ${err.message}`;
          log.warn('votes', 'merge_commit_sha backfill from GitHub failed', {
            sessionId: session.id, prNumber: session.pr_number, err: err.message,
          });
        }
      }
    }

    if (!backfilledSha) {
      await pool.query(
        `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
        [session.id]
      ).catch(() => {});
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `Couldn't auto-revert ${label}: ${backfillReason}. Please open the revert PR manually.`,
        'system'
      );
      return { reverted: false, error: 'no merge_commit_sha', backfillReason };
    }
  }
  if (!session.repo_url) {
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    return { reverted: false, error: 'no repo_url' };
  }

  const m = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) {
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    return { reverted: false, error: 'unparseable repo_url' };
  }
  const [, repoOwner, repoName] = m;

  log.info('votes', 'Opening revert PR', {
    sessionId: session.id, needed: majority, requestedBy: decider.username,
  });

  let revertInfo;
  try {
    revertInfo = await createRevertPR({
      session,
      mergeSha: session.merge_commit_sha,
      repoOwner,
      repoName,
      deciderUsername: decider.username,
    });
  } catch (err) {
    // Release the claim so a future vote can retry. Most common
    // failure here is `git revert` conflict — surface it clearly.
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    log.error('votes', 'Revert PR creation failed', { sessionId: session.id, err: err.message });
    const label = session.pr_title
      ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
      : `PR #${session.pr_number || session.id}`;
    await sendSystemMessage(pool, session.app_id,
      `Couldn't auto-revert ${label}: ${err.message}. ` +
      `Most likely later commits depend on it. Please open the revert PR manually.`,
      'system'
    );
    return { reverted: false, error: err.message };
  }

  // Insert the revert session row. status=promoted means it lands
  // directly in the vote panel ready for a second checkpoint vote.
  const { rows: revertRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_number, pr_url, pr_title,
        status, revert_of_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'promoted', $7)
     RETURNING id`,
    [
      session.app_id, decider.id, revertInfo.branch,
      revertInfo.prNumber, revertInfo.prUrl, revertInfo.prTitle,
      session.id,
    ]
  );
  const revertSessionId = revertRows[0].id;

  // Patch the original's revert_of_session_id pointer to actually
  // point at the revert session (was set to its own id as a claim
  // sentinel above). Now `revert_of_session_id IS NOT NULL` on the
  // original correctly identifies "has a revert in flight".
  await pool.query(
    `UPDATE chat_sessions SET revert_of_session_id = $1 WHERE id = $2`,
    [revertSessionId, session.id]
  );

  // Announce in group chat so the new revert PR shows up in the vote
  // panel with context. Tag the original PR # for breadcrumbs.
  const label = session.pr_title
    ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
    : `PR #${session.pr_number || session.id}`;
  await sendSystemMessage(pool, session.app_id,
    `${decider.username} proposed undoing ${label}. Opened revert PR #${revertInfo.prNumber} — needs ${majority}/${activeCount} votes to land.`,
    'system'
  );

  return {
    reverted: true,
    revertSessionId,
    revertPrNumber: revertInfo.prNumber,
    revertPrUrl: revertInfo.prUrl,
  };
}

// Clone the repo to a tmpdir, branch off main, `git revert <sha>`,
// push, open a PR. Returns { branch, prNumber, prUrl, prTitle }.
// Throws on revert conflict or network errors; caller surfaces the
// failure to chat.
async function createRevertPR({ session, mergeSha, repoOwner, repoName, deciderUsername }) {
  const token = process.env.GITHUB_BOT_TOKEN;
  if (!token) throw new Error('GITHUB_BOT_TOKEN not set');

  const cloneUrl = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;
  const tmpDir = `/tmp/usernode-revert-${session.id}-${Date.now()}`;
  // Branch naming pattern: revert/<original-branch>-<timestamp>. The
  // timestamp suffix avoids collisions if a prior revert attempt left
  // a stale branch on the remote.
  const safeBase = (session.branch_name || `pr-${session.pr_number || session.id}`).replace(/[^a-zA-Z0-9._/-]/g, '-');
  const revertBranch = `revert/${safeBase}-${Date.now()}`;

  try {
    // Full clone — we need history reaching back to the merge SHA, so
    // the rebuildProduction shallow-clone pattern doesn't apply here.
    await docker.execFileAsync('git', ['clone', cloneUrl, tmpDir], { timeout: 180000 });

    // Committer identity for the revert commit. Matches the
    // usernode-bot convention used elsewhere.
    await docker.execFileAsync('git', ['-C', tmpDir, 'config', 'user.name', 'usernode-bot']);
    await docker.execFileAsync('git', ['-C', tmpDir, 'config', 'user.email', 'usernode-bot@users.noreply.github.com']);

    // Branch off the current main. main has already been updated by
    // the original merge + any subsequent merges by the time we get
    // here, so this is the "current" main.
    await docker.execFileAsync('git', ['-C', tmpDir, 'checkout', '-b', revertBranch], { timeout: 10000 });

    // `git revert --no-edit <sha>` — squash merges produce single-parent
    // commits, so no `-m 1` needed. If the revert conflicts (later
    // commits depend on this one), git exits non-zero and the docker
    // helper rejects.
    try {
      await docker.execFileAsync('git', ['-C', tmpDir, 'revert', '--no-edit', mergeSha], { timeout: 30000 });
    } catch (revertErr) {
      // Clean up the conflicted state inside the tmp dir for hygiene
      // (best-effort), then surface a tight error.
      await docker.execFileAsync('git', ['-C', tmpDir, 'revert', '--abort']).catch(() => {});
      const m = String(revertErr.message || '').toLowerCase();
      if (m.includes('conflict')) {
        throw new Error('Revert produced merge conflicts');
      }
      throw new Error(`git revert failed: ${revertErr.message.slice(0, 200)}`);
    }

    await docker.execFileAsync('git', ['-C', tmpDir, 'push', '-u', 'origin', revertBranch], { timeout: 60000 });

    const origLabel = session.pr_title
      ? `${session.pr_title} (PR #${session.pr_number || session.id})`
      : `PR #${session.pr_number || session.id}`;
    const prTitle = `Revert: ${session.pr_title || `PR #${session.pr_number || session.id}`}`.slice(0, 200);
    const prBody =
      `Automated revert of ${origLabel}.\n\n` +
      `Undo vote reached majority on the original PR; deciding vote cast by @${deciderUsername}. ` +
      `This PR still needs a regular merge vote to land — vote in the app's group chat panel.\n\n` +
      `Reverts commit ${mergeSha}.`;

    const prData = await github.createPR(repoOwner, repoName, {
      branch: revertBranch,
      title: prTitle,
      body: prBody,
    });

    return {
      branch: revertBranch,
      prNumber: prData.number,
      prUrl: prData.html_url,
      prTitle,
    };
  } finally {
    await docker.execFileAsync('rm', ['-rf', tmpDir]).catch(() => {});
  }
}

// checkAndMerge is exported (in addition to voteRoutes) so the
// auto-conflict-resolver can re-attempt a merge for an already-approved
// PR after it syncs cleanly with main. Consumers should lazy-require
// this module from inside a function to avoid the votes <-> conflict-
// resolver circular-require load-order trap.
module.exports = { voteRoutes, checkAndMerge, resolveIssueBounty };
