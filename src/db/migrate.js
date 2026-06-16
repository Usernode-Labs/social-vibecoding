const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('./pool');
const log = require('../services/logger');
const appManifest = require('../services/app-manifest');
const dbManager = require('../services/db-manager');
const { encrypt } = require('../services/secrets');

async function migrate(config) {
  const pool = getPool(config);

  const schema = fs.readFileSync(
    path.join(__dirname, 'schema.sql'),
    'utf-8'
  );

  log.info('db', 'Running migrations...');
  await pool.query(schema);
  log.info('db', 'Schema up to date');

  await seedAdmin(pool, config);
  await seedCaptureUser(pool);
  await seedSelfApp(pool, config);
  await seedStagingNotifications(pool, config);
  await seedStagingEnvProposal(pool, config);
  await seedStagingMergedPrs(pool, config);
  await seedStagingMyOpenPr(pool, config);
  await seedStagingProposalDiscussion(pool, config);
  await seedStagingOtherUserProposal(pool, config);
  await seedStagingTopicScrollThreads(pool, config);
  await seedStagingArchiveProposalFixtures(pool, config);
  await seedStagingActiveSessions(pool, config);
  await seedStagingCcProgressRun(pool, config);
  await seedStagingCcEstimateRun(pool, config);
  await seedStagingDemoAppCard(pool);
  await seedStagingMembersPanel(pool);
  await seedStagingAppQuotaUsers(pool);
  await seedStagingViewOnlyAdmin(pool);
  await seedStagingVisuals(pool);
  await seedStagingLeaderboardProfile(pool);
  await seedStagingQaSession(pool, config);
  await seedStagingCloneQuestionSuggestions(pool, config);
  await seedStagingCloneSpecPills(pool, config);
  await seedStagingSpecViewerSessions(pool, config);
  await seedStagingDemoProposal(pool, config);
  await seedStagingSpecUserShareFixtures(pool, config);
  await seedStagingHeadlessFixtures(pool, config);
  await seedStagingSyncActivity(pool, config);
  await seedStagingChatEditFixtures(pool, config);
  await seedStagingLlmUsage(pool);
  await seedStagingCapReached(pool, config);
  await seedStagingSystemTokenUsage(pool);
  await seedStagingDashboardAdminSplit(pool);
  await backfillEvents(pool);
  await backfillVotesRequired(pool);
  // Must run BEFORE backfillOrphanedSpecDrafts: unwrapping spec_md after that
  // freezes a wrapped version would leave the frozen copy wrapped while the
  // live buffer is clean, churning a new version on every boot.
  await backfillFenceWrappedSpecs(pool);
  await backfillOrphanedSpecDrafts(pool);
  await backfillLinkedIssuesFromPrBodies(pool);
  await failOrphanedHeadlessRuns(pool);
  await migrateAppDbsToPerRole(pool, config);
}

// #155: headless runs interrupted by a restart used to be blanket-failed
// here because the loop lived entirely in the dead process. They are now
// resumable: runHeadlessSession checkpoints its position in
// chat_sessions.headless_step ('planning' / 'cc_running' / 'wrapping'),
// and resumeHeadlessRuns (src/routes/sessions.js, called from server.js
// boot after worker adoption) carries any 'generating' row forward from
// that checkpoint — marking 'failed' only the rows it explicitly gives
// up on. The sweep below is narrowed to rows with NO checkpoint, i.e.
// runs started before the step machine existed; those genuinely cannot
// be resumed. Idempotent; no-ops when nothing is stuck.
async function failOrphanedHeadlessRuns(pool) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE chat_sessions SET headless_status = 'failed'
        WHERE is_headless = TRUE AND headless_status = 'generating'
          AND headless_step IS NULL`
    );
    if (rowCount > 0) {
      log.info('db', 'Marked unresumable (pre-step-machine) headless runs as failed', { count: rowCount });
    }
  } catch (err) {
    log.warn('db', 'Failed to reset orphaned headless runs', { err: err.message });
  }
}

// One-shot, idempotent backfill that recovers chat_sessions.linked_issues for
// PRs whose bodies carry GitHub closing keywords (Closes/Fixes/Resolves #N)
// but predate the #75/#79 linkage plumbing — so the "Closes #N" pills (#80/#82)
// render on historical PR cards instead of only on brand-new sessions.
//
// PR bodies aren't stored locally, so we fetch each candidate once from GitHub
// (owner/repo resolved from apps.repo_url) and parse the closing keywords. To
// avoid re-fetching every boot, each processed session is flagged via
// chat_sessions.linked_issues_backfilled — including the ones whose body had
// no keywords (so they're not retried forever). A PR we couldn't fetch (network
// blip, deleted repo, perms) is left UNflagged so a later boot retries it; the
// set is bounded so that self-heals without churn.
//
// Best-effort throughout: every fetch/update is individually guarded and a
// failure never aborts boot. Sessions that already have linked_issues are
// excluded by the query (cheap, no network) and need no flag.
async function backfillLinkedIssuesFromPrBodies(pool) {
  const github = require('../services/github');
  const prMetadata = require('../services/pr-metadata');

  if (typeof github.isEnabled === 'function' && !github.isEnabled()) {
    log.debug('db', 'linked-issues backfill skipped (github disabled)');
    return;
  }

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT cs.id, cs.pr_number, a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
        WHERE cs.pr_number IS NOT NULL
          AND cs.linked_issues_backfilled = false
          AND COALESCE(array_length(cs.linked_issues, 1), 0) = 0`
    ));
  } catch (err) {
    log.warn('db', 'linked-issues backfill skipped (query failed)', { err: err.message });
    return;
  }
  if (!rows.length) {
    log.debug('db', 'No PRs need linked-issues backfill');
    return;
  }

  let scanned = 0;
  let populated = 0;
  for (const row of rows) {
    const [, owner, repo] = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!owner || !repo) continue; // can't resolve repo → leave unflagged

    let body;
    try {
      const pr = await github.getPR(owner, repo, row.pr_number);
      body = pr && pr.body ? String(pr.body) : '';
    } catch (err) {
      // Leave unflagged so a later boot retries; bounded by the candidate set.
      log.debug('db', 'linked-issues backfill: PR fetch failed', {
        sessionId: row.id, repo: `${owner}/${repo}`, pr: row.pr_number, err: err.message,
      });
      continue;
    }
    scanned++;

    const issues = prMetadata.parseClosingKeywords(body);
    try {
      if (issues.length) {
        await pool.query(
          `UPDATE chat_sessions SET linked_issues = $1, linked_issues_backfilled = true WHERE id = $2`,
          [issues, row.id]
        );
        populated++;
      } else {
        await pool.query(
          `UPDATE chat_sessions SET linked_issues_backfilled = true WHERE id = $1`,
          [row.id]
        );
      }
    } catch (err) {
      log.warn('db', 'linked-issues backfill: update failed', { sessionId: row.id, err: err.message });
    }
  }

  if (scanned) {
    log.info('db', 'Backfilled linked issues from PR bodies', {
      candidates: rows.length, scanned, populated,
    });
  } else {
    log.debug('db', 'linked-issues backfill: no PRs successfully scanned this pass', {
      candidates: rows.length,
    });
  }
}

// One-shot, idempotent backfill that unwraps specs a scout/spec-author LLM
// stored fully enclosed in a single ```markdown … ``` fence — which made the
// whole spec render as one big code block instead of formatted markdown
// (session 153; 11 sessions at time of writing). The conservative unwrap can't
// be expressed in pure SQL, so we read the spec rows, run each through
// stripSpecWrapperFence(), and write back only the ones that actually change.
// Covers BOTH the live buffer (chat_sessions.spec_md — what the viewer shows
// as "latest") and the frozen history (chat_session_specs.content — what older
// version cards open). Row counts here are tiny (≈ one per session), so a full
// scan is cheaper than escaping a backtick LIKE prefilter and is robust to
// leading whitespace.
//
// Idempotent by construction: once unwrapped, a value no longer opens with a
// strippable wrapper, so stripSpecWrapperFence() returns it unchanged and no
// UPDATE fires on subsequent boots.
async function backfillFenceWrappedSpecs(pool) {
  const { stripSpecWrapperFence } = require('../services/spec-format');
  let liveFixed = 0;
  let versionFixed = 0;
  try {
    const { rows: live } = await pool.query(
      `SELECT id, spec_md FROM chat_sessions
        WHERE spec_md IS NOT NULL AND length(btrim(spec_md)) > 0`
    );
    for (const row of live) {
      const unwrapped = stripSpecWrapperFence(row.spec_md);
      if (unwrapped !== row.spec_md) {
        await pool.query('UPDATE chat_sessions SET spec_md = $1 WHERE id = $2', [unwrapped, row.id]);
        liveFixed++;
      }
    }

    const { rows: versions } = await pool.query(
      `SELECT session_id, version, content FROM chat_session_specs
        WHERE content IS NOT NULL AND length(btrim(content)) > 0`
    );
    for (const row of versions) {
      const unwrapped = stripSpecWrapperFence(row.content);
      if (unwrapped !== row.content) {
        await pool.query(
          'UPDATE chat_session_specs SET content = $1 WHERE session_id = $2 AND version = $3',
          [unwrapped, row.session_id, row.version]
        );
        versionFixed++;
      }
    }
  } catch (err) {
    log.warn('db', 'fence-wrapped spec backfill skipped (query failed)', { err: err.message });
    return;
  }

  if (liveFixed || versionFixed) {
    log.info('db', 'Unwrapped fence-wrapped specs', { liveFixed, versionFixed });
  } else {
    log.debug('db', 'No fence-wrapped specs to backfill');
  }
}

// #69: one-shot, idempotent backfill that freezes any orphaned live spec
// buffer as a numbered version. Background: the dev-chat spec viewer used
// to surface chat_sessions.spec_md as a separate "Draft (live)" entry,
// distinct from the numbered versions in chat_session_specs. #69 removes
// that draft surface — numbered versions (v1…vN) become the only spec
// the viewer shows. For sessions created after #27 (auto-snapshot on
// every spec mutation) spec_md is always byte-identical to the latest
// version, so nothing is lost. But PRE-#27 sessions could have edited
// spec_md after the last manual "Save version", leaving the live buffer
// newer than any frozen version — that content would become unreachable
// once the draft view is gone.
//
// This snapshots each such session's current spec_md as MAX(version)+1 so
// every session's latest content is reachable as a numbered version, then
// the default-to-latest viewer shows it. Forward-only (insert-only, no
// drops/renames) per the platform self-edit rule.
//
// Idempotent by construction: after one run each affected session's latest
// version content equals spec_md, so the `latest.content <> cs.spec_md`
// guard excludes it on every subsequent boot — a normal boot inserts
// nothing.
async function backfillOrphanedSpecDrafts(pool) {
  let res;
  try {
    res = await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content)
         SELECT cs.id, COALESCE(latest.max_version, 0) + 1, cs.spec_md
           FROM chat_sessions cs
           LEFT JOIN LATERAL (
             SELECT version AS max_version, content
               FROM chat_session_specs s
              WHERE s.session_id = cs.id
              ORDER BY version DESC
              LIMIT 1
           ) latest ON TRUE
          WHERE cs.spec_md IS NOT NULL
            AND length(btrim(cs.spec_md)) > 0
            AND (latest.content IS NULL OR latest.content <> cs.spec_md)`
    );
  } catch (err) {
    // Never abort boot over a backfill; the ALTERs in schema.sql run first
    // so the columns/table exist, but stay defensive regardless.
    log.warn('db', 'orphaned spec draft backfill skipped (query failed)', { err: err.message });
    return;
  }

  if (res.rowCount) {
    log.info('db', 'Froze orphaned live spec drafts as numbered versions', {
      inserted: res.rowCount,
    });
  } else {
    log.debug('db', 'No orphaned live spec drafts to backfill');
  }
}

// #58: one-shot, idempotent backfill of votes_required / active_users_at_merge
// for merged PRs that predate those columns. The at-merge vote threshold is
// computed live (services/active-users.js) and was never persisted, so the
// only historical record of "how many votes were required when this PR
// merged" is the free-text merge announcement posted to group chat by
// routes/votes.js checkAndMerge():
//
//   "PR #<ref> ... merged and deployed! (<yes>/<active> votes)"
//   "PR #<ref> ... force-merged by admin <name> (<yes>/<active> vote(s) at the time)"
//
// We parse the "(yes/active)" figure out of that message, take <active> as the
// at-merge active-user count, and reconstruct the threshold as
// floor(active/2)+1 — exactly getActiveUserStats()'s majority formula.
//
// Idempotent by construction: only rows with votes_required IS NULL are
// considered, and each fill is COALESCE-guarded, so a normal boot (already
// snapshotted, or already backfilled) scans nothing or no-ops. Rows whose
// announcement can't be found/parsed stay NULL and keep the live-majority
// fallback in the UI — non-regressive.
async function backfillVotesRequired(pool) {
  let sessions;
  try {
    ({ rows: sessions } = await pool.query(
      `SELECT id, app_id, pr_number FROM chat_sessions
        WHERE status = 'merged' AND votes_required IS NULL`
    ));
  } catch (err) {
    // e.g. the column doesn't exist yet on a partial/older schema — the
    // ALTER in schema.sql should have run first, but never abort boot here.
    log.warn('db', 'votes_required backfill skipped (query failed)', { err: err.message });
    return;
  }

  if (!sessions.length) {
    log.debug('db', 'No merged rows need votes_required backfill');
    return;
  }

  log.info('db', 'Backfilling votes_required for merged PRs...', {
    candidates: sessions.length,
  });

  let filled = 0;
  for (const s of sessions) {
    // The announcement label uses `pr_number || session.id` as the PR ref.
    const ref = s.pr_number || s.id;
    try {
      // Find the merge announcement for this PR. The word-boundary regex
      // (`(^|[^0-9])PR #<ref>([^0-9]|$)`) stops "PR #1" from matching
      // "PR #12", and the two LIKEs restrict to merge/force-merge lines
      // (promote / vote / revert messages also mention the PR ref but
      // carry neither phrase).
      const { rows: msgs } = await pool.query(
        `SELECT content FROM chat_messages
          WHERE app_id = $1 AND msg_type = 'system'
            AND content ~ $2
            AND (content LIKE '%merged and deployed!%'
                 OR content LIKE '%force-merged by admin%')
          ORDER BY created_at DESC
          LIMIT 1`,
        [s.app_id, `(^|[^0-9])PR #${ref}([^0-9]|$)`]
      );
      if (!msgs.length) continue;

      const m = /\((\d+)\s*\/\s*(\d+)\s+vote/.exec(msgs[0].content);
      if (!m) continue;
      const activeAtMerge = parseInt(m[2], 10);
      if (!Number.isFinite(activeAtMerge) || activeAtMerge < 1) continue;
      const votesRequired = Math.floor(activeAtMerge / 2) + 1;

      await pool.query(
        `UPDATE chat_sessions
            SET votes_required = COALESCE(votes_required, $2),
                active_users_at_merge = COALESCE(active_users_at_merge, $3)
          WHERE id = $1`,
        [s.id, votesRequired, activeAtMerge]
      );
      filled += 1;
    } catch (err) {
      // One bad row must not abort the backfill or boot.
      log.warn('db', 'votes_required backfill row failed', {
        sessionId: s.id, err: err.message,
      });
    }
  }

  log.info('db', 'votes_required backfill complete', {
    filled, scanned: sessions.length,
  });
}

// One-shot backfill of the append-only `events` analytics log from the
// existing domain tables. The events table (schema.sql) is the long-term
// source of truth behind the admin /dashboard, but it only starts
// accumulating rows once the action-site emitters (src/services/events.js
// callers) ship. Without a backfill, every growth / retention / funnel
// chart would show a cliff at the deploy boundary. This synthesizes the
// historical rows from the timestamps already recorded elsewhere so the
// curves are continuous.
//
// Idempotent by construction: it no-ops the moment the table holds any
// row, so a normal boot (events already populated, by backfill or by live
// emission) skips it entirely. It only ever runs against a genuinely
// empty table — i.e. the first boot after this migration lands.
async function backfillEvents(pool) {
  const { rows } = await pool.query(
    'SELECT NOT EXISTS (SELECT 1 FROM events LIMIT 1) AS empty'
  );
  if (!rows[0]?.empty) {
    log.debug('db', 'events table already populated; skipping backfill');
    return;
  }

  log.info('db', 'Backfilling events log from existing tables...');

  // Each statement maps one domain table to one event_type. created_at is
  // the best available historical timestamp for that action. app_activity
  // only has day granularity (DATE), which is exactly what the retention /
  // active-day signals need. pr_merged uses merged_at when present (rows
  // merged after this migration) and falls back to promoted_at/created_at
  // for older rows that never recorded a merge time.
  const statements = [
    `INSERT INTO events (user_id, event_type, created_at)
       SELECT id, 'user_signed_up', created_at FROM users`,

    `INSERT INTO events (user_id, app_id, event_type, created_at)
       SELECT created_by, id, 'app_created', created_at
       FROM apps WHERE created_by IS NOT NULL`,

    `INSERT INTO events (user_id, app_id, event_type, created_at, metadata)
       SELECT user_id, app_id, 'dapp_active_day', date::timestamptz,
              jsonb_build_object('secondsSpent', seconds_spent)
       FROM app_activity WHERE user_id IS NOT NULL`,

    `INSERT INTO events (user_id, app_id, event_type, created_at)
       SELECT user_id, app_id, 'chat_message_sent', created_at
       FROM chat_messages WHERE user_id IS NOT NULL`,

    `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
       SELECT u.id, cs.app_id, cs.id, 'dev_session_started', cs.created_at
       FROM chat_sessions cs JOIN users u ON u.id = cs.user_id`,

    `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
       SELECT cs.user_id, cs.app_id, cs.id, 'pr_opened', cs.created_at
       FROM chat_sessions cs WHERE cs.pr_number IS NOT NULL`,

    `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
       SELECT cs.user_id, cs.app_id, cs.id, 'pr_promoted', cs.promoted_at
       FROM chat_sessions cs WHERE cs.promoted_at IS NOT NULL`,

    `INSERT INTO events (user_id, app_id, session_id, event_type, created_at)
       SELECT cs.user_id, cs.app_id, cs.id, 'pr_merged',
              COALESCE(cs.merged_at, cs.promoted_at, cs.created_at)
       FROM chat_sessions cs WHERE cs.status = 'merged'`,

    `INSERT INTO events (user_id, session_id, app_id, event_type, created_at)
       SELECT pv.user_id, pv.session_id, cs.app_id, 'pr_vote_cast', pv.created_at
       FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id`,

    `INSERT INTO events (user_id, session_id, app_id, event_type, created_at)
       SELECT pk.giver_user_id, pk.session_id, cs.app_id, 'kudos_given', pk.created_at
       FROM pr_kudos pk JOIN chat_sessions cs ON cs.id = pk.session_id`,

    `INSERT INTO events (user_id, app_id, event_type, created_at)
       SELECT user_id, app_id, 'app_favorited', created_at FROM app_favorites`,
  ];

  let total = 0;
  for (const sql of statements) {
    try {
      const res = await pool.query(sql);
      total += res.rowCount || 0;
    } catch (err) {
      // A single source table hiccup must not abort boot — log and keep
      // going so the rest of the backfill (and the server) still come up.
      log.warn('db', 'events backfill statement failed', { err: err.message });
    }
  }

  log.info('db', 'Events backfill complete', { inserted: total });
}

async function seedAdmin(pool, config) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    [config.adminUsername]
  );

  if (rows.length === 0) {
    const hash = await bcrypt.hash(config.adminPassword, 12);
    await pool.query(
      'INSERT INTO users (username, password, is_admin) VALUES ($1, $2, TRUE)',
      [config.adminUsername, hash]
    );
    log.info('db', 'Admin user created', { username: config.adminUsername });
  } else {
    log.debug('db', 'Admin user already exists');
  }
}

// Dedicated identity for the before/after screenshot pipeline (#195 fix).
// services/visuals.js signs capture requests as this user so screenshots
// show the real, logged-in app instead of the login screen. An ordinary
// non-admin account (is_admin/can_create_apps both FALSE) because the
// resulting artifacts are public (unauthenticated /visuals/:id route +
// GitHub PR bodies) — it must never see admin-only UI or anyone's
// personal data. The password is a bcrypt hash of 32 random bytes that
// are immediately discarded, so the account can never log in
// interactively; visuals.js authenticates it by minting a JWT / session
// row directly. Idempotent: keyed on the unique username, DO NOTHING on
// conflict (the random hash is never rotated).
async function seedCaptureUser(pool) {
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      ['usernode-capture']
    );
    if (rows.length) {
      log.debug('db', 'Capture user already exists');
      return;
    }
    const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    await pool.query(
      `INSERT INTO users (username, password, is_admin, can_create_apps)
       VALUES ($1, $2, FALSE, FALSE)
       ON CONFLICT (username) DO NOTHING`,
      ['usernode-capture', hash]
    );
    log.info('db', 'Capture user created', { username: 'usernode-capture' });
  } catch (err) {
    // Best-effort: a missing capture user only degrades screenshots back
    // to today's unauthenticated behaviour — never abort boot over it.
    log.warn('db', 'Capture user seed failed', { err: err.message });
  }
}

// SELF-HOSTING.md sub-step 2f: ensure a single row in `apps` exists
// for the platform itself, with self_hosted=TRUE. Idempotent — runs every
// boot. Two roles:
//
//   1. Refresh main_sha + last_deploy_at on every boot. The build's
//      GIT_SHA arg flows through docker-compose.yml as process.env.GIT_SHA,
//      so a new deploy that successfully boots updates the row to point
//      at the new commit. Before this seed runs the row may show the
//      previous SHA (between merge and new container start), which is
//      what the Phase 3 banner uses to detect "platform updated".
//
//   2. Refresh manifest_snapshot from the local dapp.json so the
//      Settings → Secrets UI for the self-app row shows the keys the
//      *currently running* code declares — no clone/round-trip needed.
//      Child apps populate this column from the freshly-cloned working
//      tree on every deploy; the self-app reads it from disk for the
//      same reason.
//
// The row's container_id is hard-pinned to 'usernode' (the docker compose
// service name). Settings → Secrets UI logic also branches on
// app.self_hosted to make the self-app read-only (Phase 2h), so we
// don't accidentally store secrets that won't take effect (the platform
// reads its env from .env written by deploy.yml, not from app_secrets).
async function seedSelfApp(pool, config) {
  // Read the local dapp.json once; missing/unparseable → empty manifest
  // (appManifest.read handles both gracefully). The path resolves to the
  // repo root regardless of how the harness was launched.
  const repoRoot = path.join(__dirname, '..', '..');
  const manifest = appManifest.read(repoRoot);

  const sha = process.env.GIT_SHA || null;
  const manifestJson = JSON.stringify(manifest);

  // Single UPSERT keyed on slug. Insert covers fresh-DB; the DO UPDATE
  // covers every subsequent boot so main_sha and manifest_snapshot
  // reflect the running build. The insert seeds name='Usernode'; the
  // DO UPDATE deliberately does NOT touch name — the reconcile below is
  // the single place the self-app display name is resolved from
  // dapp.json (so a merged self-app rename PR actually applies on the
  // post-deploy reboot, same as child apps do in rebuildProduction).
  const { rows: selfRows } = await pool.query(
    `INSERT INTO apps
       (name, slug, repo_url, container_id, status, self_hosted,
        main_sha, last_deploy_at, manifest_snapshot)
     VALUES
       ('Usernode', $1, $2, 'usernode', 'running', TRUE,
        $3, NOW(), $4::jsonb)
     ON CONFLICT (slug) DO UPDATE SET
       repo_url          = EXCLUDED.repo_url,
       container_id      = EXCLUDED.container_id,
       status            = EXCLUDED.status,
       self_hosted       = TRUE,
       main_sha          = COALESCE(EXCLUDED.main_sha, apps.main_sha),
       last_deploy_at    = NOW(),
       manifest_snapshot = EXCLUDED.manifest_snapshot
     RETURNING id, slug, name`,
    [
      config.selfAppSlug,
      config.platformRepoUrl,
      sha,
      manifestJson,
    ]
  );

  // dapp.json's top-level `name` takes precedence over the platform name.
  // Best-effort — a rename hiccup must not fail boot/migration.
  if (selfRows.length) {
    await appManifest.reconcileAppName(pool, selfRows[0], manifest)
      .catch((err) => log.warn('db', 'Self-app name reconcile failed', { err: err.message }));
  }

  log.info('db', 'Self-app row seeded', {
    slug: config.selfAppSlug,
    sha: sha ? sha.slice(0, 7) : '(none)',
    secretsDeclared: manifest.secrets.length,
  });
}

// Staging clones intentionally TRUNCATE table-level `staging:private`
// tables, including `notifications`, so production social data never leaks
// into a preview. For the platform self-app, that made notification UI work
// hard to test in staging. Seed a tiny, synthetic set after the privacy pass
// has already run. Idempotent on restart: every row is keyed off fixture
// message/session content and checked before insert.
async function seedStagingNotifications(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 2`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging notification fixtures skipped: no users');
    return;
  }

  const target = userRows.find((u) => u.is_admin) || userRows[0];
  const source = userRows.find((u) => u.id !== target.id) || target;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging notification fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const messageIds = {};
  for (const [key, content] of Object.entries({
    mention: `[staging fixture] Mention notification for @${target.username}`,
    reply: '[staging fixture] Reply notification target message',
    reaction: '[staging fixture] Reaction notification target message',
  })) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_messages WHERE app_id = $1 AND content = $2 LIMIT 1',
      [appId, content]
    );
    if (existing.length) {
      messageIds[key] = existing[0].id;
      continue;
    }
    const { rows } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at)
       VALUES ($1, $2, $3, 'message', NOW() - ($4::int * INTERVAL '1 minute'))
       RETURNING id`,
      [appId, source.id, content, key === 'mention' ? 18 : key === 'reply' ? 16 : 14]
    );
    messageIds[key] = rows[0].id;
  }

  const fixtureBranch = 'staging-fixture/notifications';
  let sessionId;
  const { rows: sessionRows } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (sessionRows.length) {
    sessionId = sessionRows[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, status, created_at)
       VALUES
         ($1, $2, $3, 9001, 'Staging fixture PR for notification testing', 'promoted',
          NOW() - INTERVAL '12 minutes')
       RETURNING id`,
      [appId, source.id, fixtureBranch]
    );
    sessionId = rows[0].id;
  }

  // #138: give the fixture session a headless issue number so the
  // auto_solve_done row below renders "issue #9042" and deep-links to the
  // Issues tab. Idempotent (only fills when unset).
  await pool.query(
    `UPDATE chat_sessions
        SET headless_issue_number = COALESCE(headless_issue_number, 9042)
      WHERE id = $1`,
    [sessionId]
  );

  const fixtures = [
    { kind: 'mention', chatMessageId: messageIds.mention, sourceUserId: source.id, minutesAgo: 11 },
    { kind: 'reply', chatMessageId: messageIds.reply, sourceUserId: source.id, minutesAgo: 10 },
    {
      kind: 'reaction',
      chatMessageId: messageIds.reaction,
      sourceUserId: source.id,
      detail: '👀',
      minutesAgo: 9,
    },
    { kind: 'pr_proposed', sessionId, sourceUserId: source.id, minutesAgo: 8 },
    { kind: 'stale_pr', sessionId, sourceUserId: null, minutesAgo: 7 },
    {
      kind: 'kudos',
      sessionId,
      sourceUserId: source.id,
      readAt: true,
      minutesAgo: 6,
    },
    // #138: two UNREAD AI-completion fixtures so the bell's distinct green
    // badge shows "2" on staging load — one interactive dev-session
    // completion and one headless proposal run. Both are system-generated
    // (no source user) and deep-link into the dev tab when clicked.
    { kind: 'session_done', sessionId, sourceUserId: null, minutesAgo: 5 },
    { kind: 'auto_solve_done', sessionId, sourceUserId: null, detail: 'code', minutesAgo: 4 },
  ];

  let inserted = 0;
  for (const f of fixtures) {
    const { rows: existing } = await pool.query(
      `SELECT id FROM notifications
        WHERE user_id = $1
          AND app_id = $2
          AND kind = $3
          AND COALESCE(chat_message_id, -1) = COALESCE($4::int, -1)
          AND COALESCE(session_id, -1) = COALESCE($5::int, -1)
        LIMIT 1`,
      [target.id, appId, f.kind, f.chatMessageId || null, f.sessionId || null]
    );
    if (existing.length) continue;

    await pool.query(
      `INSERT INTO notifications
         (user_id, app_id, chat_message_id, session_id, source_user_id,
          kind, detail, read_at, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7,
          CASE WHEN $8::boolean THEN NOW() - INTERVAL '1 minute' ELSE NULL END,
          NOW() - ($9::int * INTERVAL '1 minute'))`,
      [
        target.id,
        appId,
        f.chatMessageId || null,
        f.sessionId || null,
        f.sourceUserId,
        f.kind,
        f.detail || null,
        !!f.readAt,
        f.minutesAgo,
      ]
    );
    inserted++;
  }

  // Multi-app fixtures (#84 grouping): the self-app block above gives ONE
  // app with many notifications; here we add a few OTHER apps so the
  // grouped/collapsed view has realistic multi-app data to render. The
  // first other app gets two notifications (a collapsible multi-item
  // group); the remaining ones get a single notification each (which the
  // UI renders as a plain leaf row). Same idempotency pattern as above:
  // fixture chat-message content + the notification's (kind, message)
  // tuple are checked before every insert.
  const { rows: otherApps } = await pool.query(
    `SELECT id, slug, name FROM apps
      WHERE slug <> $1
      ORDER BY id ASC
      LIMIT 3`,
    [config.selfAppSlug]
  );

  let multiAppInserted = 0;
  for (let i = 0; i < otherApps.length; i++) {
    const app = otherApps[i];
    const appName = app.name || app.slug;
    // First other app: an over-the-limit group (>GROUP_LEAF_CAP, which is
    // 10 in the drawer) so the inline "Show more" pagination control is
    // exercised. Mixed read/unread so unread-first ordering is visible
    // too. Each row gets unique content -> a distinct fixture chat message
    // -> a distinct (kind, chat_message_id) idempotency key, so reboots
    // never duplicate or drift. Others: one notification each -> a single
    // leaf row.
    let specs;
    if (i === 0) {
      specs = [];
      for (let k = 0; k < 15; k++) {
        specs.push({
          kind: k % 2 === 0 ? 'mention' : 'reply',
          content: `[staging fixture] ${appName} pagination row ${k + 1} for @${target.username}`,
          minutesAgo: 20 - k,   // staggered, newest-first
          readAt: k % 3 === 0,  // ~1/3 read, rest unread
        });
      }
    } else {
      specs = [
        { kind: 'mention', content: `[staging fixture] @${target.username} mentioned in ${appName}`, minutesAgo: 5 - i },
      ];
    }

    for (const spec of specs) {
      // Upsert the fixture chat message this notification points at, so
      // the dropdown row renders a real snippet + a working deep link.
      let chatMessageId;
      const { rows: existingMsg } = await pool.query(
        'SELECT id FROM chat_messages WHERE app_id = $1 AND content = $2 LIMIT 1',
        [app.id, spec.content]
      );
      if (existingMsg.length) {
        chatMessageId = existingMsg[0].id;
      } else {
        const { rows } = await pool.query(
          `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at)
           VALUES ($1, $2, $3, 'message', NOW() - ($4::int * INTERVAL '1 minute'))
           RETURNING id`,
          [app.id, source.id, spec.content, spec.minutesAgo + 1]
        );
        chatMessageId = rows[0].id;
      }

      const { rows: existingNotif } = await pool.query(
        `SELECT id FROM notifications
          WHERE user_id = $1
            AND app_id = $2
            AND kind = $3
            AND COALESCE(chat_message_id, -1) = COALESCE($4::int, -1)
          LIMIT 1`,
        [target.id, app.id, spec.kind, chatMessageId]
      );
      if (existingNotif.length) continue;

      await pool.query(
        `INSERT INTO notifications
           (user_id, app_id, chat_message_id, source_user_id, kind, read_at, created_at)
         VALUES
           ($1, $2, $3, $4, $5,
            CASE WHEN $6::boolean THEN NOW() - INTERVAL '1 minute' ELSE NULL END,
            NOW() - ($7::int * INTERVAL '1 minute'))`,
        [target.id, app.id, chatMessageId, source.id, spec.kind, !!spec.readAt, spec.minutesAgo]
      );
      multiAppInserted++;
    }
  }

  // Backlog fixtures (#279): the "Show older notifications" footer only
  // appears when the first /api/notifications page returns a full 100
  // rows (hasMore). The fixtures above total only ~20-25, so the footer
  // — and the pagination it drives — would never render in a staging
  // preview. Seed a deep backlog under the self-app so the target user
  // comfortably clears the 100-row first page. All older than the
  // fixtures above (so they sort to the bottom) and marked read so the
  // unread badge stays realistic. Idempotent: each backlog row hangs off
  // a fixture chat message whose content carries its index, and both
  // inserts skip rows that already exist (NOT EXISTS), so reboots neither
  // duplicate nor drift. Two set-based statements, not 200 round-trips.
  const BACKLOG_COUNT = 110;
  const backlogPrefix = '[staging fixture] backlog notification';
  const backlogLike = `${backlogPrefix} #%`;

  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at)
     SELECT $1, $2, $3 || ' #' || g, 'message', NOW() - ((100 + g) * INTERVAL '1 minute')
       FROM generate_series(1, $4) AS g
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_messages m
         WHERE m.app_id = $1 AND m.content = $3 || ' #' || g
      )`,
    [appId, source.id, backlogPrefix, BACKLOG_COUNT]
  );

  const { rowCount: backlogInserted } = await pool.query(
    `INSERT INTO notifications
       (user_id, app_id, chat_message_id, source_user_id, kind, read_at, created_at)
     SELECT $1, $2, m.id, $3,
            CASE WHEN m.id % 2 = 0 THEN 'mention' ELSE 'reply' END,
            NOW() - INTERVAL '1 minute',
            m.created_at
       FROM chat_messages m
      WHERE m.app_id = $2
        AND m.content LIKE $4
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = $1 AND n.chat_message_id = m.id
        )`,
    [target.id, appId, source.id, backlogLike]
  );

  log.info('db', 'Staging notification fixtures seeded', {
    targetUser: target.username,
    inserted,
    multiAppInserted,
    backlogInserted,
    otherApps: otherApps.length,
  });
}

// Staging fixtures for multi-line messages + message editing. Both behaviors
// are otherwise invisible on a fresh staging preview (a multi-line message
// needs someone to have typed one; the "edited" marker needs a row with
// edited_at set). Seeds two obviously-fake messages on the self-app:
//   1. a multi-line message (embedded newlines + a blank line) to verify
//      white-space: pre-wrap rendering.
//   2. an already-edited message (edited_at after created_at) to verify the
//      "edited" marker and its full-timestamp tooltip.
// Idempotent: keyed on (app_id, content) like seedStagingNotifications, so a
// rebuild doesn't duplicate. Strictly a staging no-op in production.
async function seedStagingChatEditFixtures(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: userRows } = await pool.query(
    `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging chat-edit fixtures skipped: no users');
    return;
  }
  const author = userRows[0];

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging chat-edit fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  // 1) Multi-line message (pre-wrap rendering). Blank line between
  //    paragraphs is intentional — it must survive to the rendered row.
  const multiline = [
    '[staging fixture] Multi-line message:',
    '• first point',
    '• second point',
    '',
    'A closing paragraph after a blank line.',
  ].join('\n');

  // 2) Already-edited message (shows the "edited" marker + tooltip).
  const edited = '[staging fixture] This message was edited — hover the “edited” marker by the timestamp to see when.';

  // 3) #328: markdown demo. Exercises the full supported subset in one body —
  //    bold/italic/strikethrough, inline + fenced code, a bullet list, an
  //    https link — alongside an @mention and PR#/#N refs (which must still
  //    decorate atop the rendered markdown), plus an inert <script> tag and a
  //    javascript: link to confirm sanitization renders them harmless. Stored
  //    as raw markdown source; formatting is applied only on display.
  const markdown = [
    `[staging fixture] Markdown demo for @${author.username}:`,
    '',
    'Shows **bold**, *italic*, ~~strikethrough~~ and `inline code`.',
    '',
    '- first bullet',
    '- second bullet with a [link](https://example.com)',
    '',
    'A fenced code block:',
    '```',
    'function hi() { return 42; }',
    '```',
    '',
    'Refs stay clickable atop markdown: see PR#1 and issue #1.',
    '',
    'Safety check (must render inert): <script>alert(1)</script> and [bad](javascript:alert(2)).',
  ].join('\n');

  let inserted = 0;
  for (const fixture of [
    { content: multiline, createdMinutesAgo: 8, editedMinutesAgo: null },
    { content: edited, createdMinutesAgo: 7, editedMinutesAgo: 5 },
    { content: markdown, createdMinutesAgo: 6, editedMinutesAgo: null },
  ]) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_messages WHERE app_id = $1 AND content = $2 LIMIT 1',
      [appId, fixture.content]
    );
    if (existing.length) continue;
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at, edited_at)
       VALUES ($1, $2, $3, 'message',
               NOW() - ($4::int * INTERVAL '1 minute'),
               CASE WHEN $5::int IS NULL THEN NULL
                    ELSE NOW() - ($5::int * INTERVAL '1 minute') END)`,
      [appId, author.id, fixture.content, fixture.createdMinutesAgo, fixture.editedMinutesAgo]
    );
    inserted++;
  }

  if (inserted) {
    log.info('db', 'Seeded staging chat-edit/multiline fixtures', { appId, inserted });
  }
}

// Staging fixture for the "Environment variables" vote-panel section
// (#131). The backing `issues` table is public (copied to staging with
// rows), but no open secret_change proposal usually exists in prod, so
// the section would render empty on every preview. Seed one synthetic
// open proposal for the self-app — payload shaped exactly like the
// create path in routes/issues.js, including a real `valueEnc`
// ciphertext (encrypted with this environment's own JWT_SECRET) so
// vote-through-majority / admin-apply work end-to-end against the
// staging app_secrets table. github_issue_number stays NULL: the
// fixture has no GitHub twin, which also means the kudos button is
// (correctly) omitted on its row. Idempotent on restart: keyed off the
// fixture title, any status — a proposal applied/closed during testing
// doesn't resurrect on the next boot.
async function seedStagingEnvProposal(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  if (!config.jwtSecret) {
    log.warn('db', 'Staging env-proposal fixture skipped: no JWT_SECRET to encrypt with');
    return;
  }

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging env-proposal fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 2`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging env-proposal fixture skipped: no users');
    return;
  }
  const creator = userRows[0];
  const secondVoter = userRows[1] || null;

  // Title matches what routes/issues.js generates for a real proposal,
  // and doubles as the idempotency key.
  const fixtureTitle = 'Set secret "STAGING_DEMO_KEY"';
  const { rows: existing } = await pool.query(
    'SELECT id FROM issues WHERE app_id = $1 AND title = $2 LIMIT 1',
    [appId, fixtureTitle]
  );

  let issueId;
  if (existing.length) {
    issueId = existing[0].id;
  } else {
    const demoValue = 'demo-value';
    const payload = {
      key: 'STAGING_DEMO_KEY',
      action: 'set',
      valueEnc: encrypt(demoValue, config.jwtSecret),
      valueLast4: demoValue.slice(-4),
      private: false,
      sensitive: false,
    };
    const { rows } = await pool.query(
      `INSERT INTO issues
         (app_id, github_issue_number, title, description, kind, payload, created_by, status, created_at)
       VALUES
         ($1, NULL, $2, $3, 'secret_change', $4, $5, 'open', NOW() - INTERVAL '30 minutes')
       RETURNING id`,
      [
        appId,
        fixtureTitle,
        `[staging fixture] ${creator.username} (via Usernode) proposed setting the env var "STAGING_DEMO_KEY". `
          + 'Auto-applies + redeploys when a majority of active users vote up.',
        JSON.stringify(payload),
        creator.id,
      ]
    );
    issueId = rows[0].id;
  }

  // A couple of votes so the tally pill renders a partial fill (one up
  // stripe, one down stripe when a second user exists). UNIQUE
  // (issue_id, user_id) + DO NOTHING keeps reboots and real re-votes
  // cast during testing intact.
  await pool.query(
    `INSERT INTO issue_votes (issue_id, user_id, vote, created_at)
     VALUES ($1, $2, 'up', NOW() - INTERVAL '25 minutes')
     ON CONFLICT (issue_id, user_id) DO NOTHING`,
    [issueId, creator.id]
  );
  if (secondVoter) {
    await pool.query(
      `INSERT INTO issue_votes (issue_id, user_id, vote, created_at)
       VALUES ($1, $2, 'down', NOW() - INTERVAL '20 minutes')
       ON CONFLICT (issue_id, user_id) DO NOTHING`,
      [issueId, secondVoter.id]
    );
  }

  log.info('db', 'Staging env-proposal fixture seeded', {
    issueId,
    creator: creator.username,
    voters: secondVoter ? 2 : 1,
  });
}

// Staging fixture for the Merged section's show-more toggle (#149). The
// self-app's prod DB usually has only a handful of merged sessions copied
// into staging, and a fresh staging clone of a young app may have fewer
// than the 4+ needed for the "Show N more" / "Show less" footer to render
// at all. Seed 8 synthetic merged PRs (varied titles, authors, timestamps)
// so the collapsed-to-3 default plus the toggle are exercisable on every
// preview. Idempotent on restart: each row is keyed off its unique
// `staging-fixture/merged-pr-N` branch name and checked before insert;
// pr_votes ride on UNIQUE(session_id, user_id) + DO NOTHING.
async function seedStagingMergedPrs(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging merged-PR fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 3`
  );
  if (!users.length) {
    log.warn('db', 'Staging merged-PR fixtures skipped: no users');
    return;
  }

  // Varied titles/ages so the list reads like real history. hoursAgo
  // staggers created_at (the /merged sort key) across ~a week, newest
  // first; authorIdx rotates rows across the available users (mod the
  // actual user count below). PR numbers sit in the same synthetic 9xxx
  // range as the notifications fixture so they can't shadow real PRs.
  const fixtures = [
    { title: 'Fix vote pill overflow on narrow screens', hoursAgo: 3 },
    { title: 'Add keyboard shortcuts for panel navigation', hoursAgo: 9 },
    { title: 'Debounce group-chat scroll handler', hoursAgo: 26 },
    { title: 'Improve dark-mode contrast on merged rows', hoursAgo: 50 },
    { title: 'Cache app icons in localStorage', hoursAgo: 74 },
    { title: 'Show relative timestamps in activity feed', hoursAgo: 98 },
    { title: 'Refactor kudos button into shared helper', hoursAgo: 122 },
    { title: 'Tidy empty states across dashboard tiles', hoursAgo: 150 },
  ];

  let inserted = 0;
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const branch = `staging-fixture/merged-pr-${i + 1}`;
    const author = users[i % users.length];

    let sessionId;
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch]
    );
    if (existing.length) {
      sessionId = existing[0].id;
    } else {
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
            votes_required, active_users_at_merge, created_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, 'merged', $7, $8,
            NOW() - ($9::int * INTERVAL '1 hour'))
         RETURNING id`,
        [appId, author.id, branch, 9100 + i, `[staging fixture] ${f.title}`,
         'In plain terms: this completed change improves the app for everyone who uses it, with no extra steps needed on your part.',
         Math.max(1, Math.ceil(users.length / 2)), users.length, f.hoursAgo]
      );
      sessionId = rows[0].id;
      inserted++;
    }

    // A yes-vote or two per PR so the tally pill renders a realistic
    // fill instead of 0/N on every fixture row.
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
       VALUES ($1, $2, 'yes', NOW() - ($3::int * INTERVAL '1 hour'))
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sessionId, author.id, f.hoursAgo + 1]
    );
    const secondVoter = users[(i + 1) % users.length];
    if (secondVoter.id !== author.id) {
      await pool.query(
        `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
         VALUES ($1, $2, 'yes', NOW() - ($3::int * INTERVAL '1 hour'))
         ON CONFLICT (session_id, user_id) DO NOTHING`,
        [sessionId, secondVoter.id, f.hoursAgo + 1]
      );
    }
  }

  log.info('db', 'Staging merged-PR fixtures seeded', {
    appId,
    total: fixtures.length,
    inserted,
  });
}

// Fixtures for the home screen's "Your active sessions" section.
// chat_sessions is staging:private (schema-only in staging), so without
// these the section would be invisible to testers. The section is
// viewer-own-only, so every fixture row belongs to the user the tester
// logs in as — the first admin, same target-user selection as the
// notifications fixture above. Branches sit in the staging-fixture/
// namespace and titles carry the [staging fixture] prefix so the rows
// can't be mistaken for real work. Note the rows are 'active'-status and
// therefore count against the per-user slot cap (#193) on staging — the
// auto-pause sweeper reclaims them after its idle threshold, and a
// tester can pause them manually from the dev tab if they need a slot.
async function seedStagingActiveSessions(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging active-session fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging active-session fixtures skipped: no users');
    return;
  }
  const owner = userRows[0];

  // Staggered ages make the recency ordering visible; the last row has
  // no PR yet so the section's branch-name fallback renders too. PR
  // numbers sit in the synthetic 9xxx range shared with the other
  // fixtures so they can't shadow real PRs.
  const fixtures = [
    { title: 'Staging demo: refine onboarding copy', prNumber: 9201, minutesAgo: 10 },
    { title: 'Staging demo: polish empty states', prNumber: 9202, minutesAgo: 120 },
    { title: null, prNumber: null, minutesAgo: 1440 },
  ];

  let inserted = 0;
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const branch = `staging-fixture/active-session-${i + 1}`;
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, branch]
    );
    if (existing.length) continue;
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, status, created_at)
       VALUES
         ($1, $2, $3, $4, $5, 'active', NOW() - ($6::int * INTERVAL '1 minute'))`,
      [appId, owner.id, branch, f.prNumber,
       f.title ? `[staging fixture] ${f.title}` : null, f.minutesAgo]
    );
    inserted++;
  }

  log.info('db', 'Staging active-session fixtures seeded', {
    appId,
    owner: owner.username,
    total: fixtures.length,
    inserted,
  });
}

// #50: progress-indicator fixture. The live elapsed ticker only renders
// during a real Claude Code run, but everything persisted — the merged
// "Claude Code is running…" + progress-log rendering, the step counter,
// the activity snippet derived from the log, and the reload-safe
// "(took 4m 12s)" suffix from durationMs metadata — is reviewable from a
// seeded session. Seed one dev-chat session for the staging admin whose
// timeline replays a finished CC run. Idempotent on restart: keyed off
// the fixture branch name; if the session exists, nothing is re-inserted.
async function seedStagingCcProgressRun(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging CC-progress fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging CC-progress fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const fixtureBranch = 'staging-fixture/cc-progress-run';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (existing.length) return;

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, created_at)
     VALUES
       ($1, $2, $3, '[staging fixture] Progress indicator demo run', 'active',
        NOW() - INTERVAL '40 minutes')
     RETURNING id`,
    [appId, owner.id, fixtureBranch]
  );
  const sessionId = sessionRows[0].id;

  // Representative progress log mirroring the vocabulary worker.js emits
  // (phase markers, tool_use labels, ⎿ results, a thinking line) so the
  // summary helpers have realistic input: 12 action lines → "12 steps".
  const progressLog = [
    '[refresh]',
    '[claude (mode build)]',
    '… Planning the change before touching any files',
    'Reading public/js/dev-chat.js',
    '  ⎿ Read: 3152 lines',
    'Reading public/css/app.css',
    '  ⎿ Read: 1287 lines',
    '$ grep -n "cc_progress" public/js/dev-chat.js',
    '  ⎿ 6 lines',
    'Reading src/routes/sessions.js',
    '  ⎿ Read: 4522 lines',
    '… The status line needs an elapsed span plus a live activity snippet',
    'Editing public/js/dev-chat.js',
    '  ⎿ Edit: ok',
    'Editing public/js/dev-chat.js',
    '  ⎿ Edit: ok',
    'Writing public/js/cc-progress-summary.js',
    '  ⎿ Write: ok',
    'Editing public/css/app.css',
    '  ⎿ Edit: ok',
    'Editing public/index.html',
    '  ⎿ Edit: ok',
    '$ node --test tests/cc-progress-summary.test.js',
    '  ⎿ 14 lines',
    'Reading public/js/dev-chat.js',
    '  ⎿ Read: 240 lines',
    '$ git add -A && git commit -m "Add progress indicator for Claude Code runs"',
    '  ⎿ 3 lines',
    '[commit]',
    '[push]',
  ];

  const ccOutput = [
    '[staging fixture] Added a progress indicator for Claude Code runs:',
    '',
    '- Live elapsed timer on every in-progress status line.',
    '- Activity snippet + step counter in the running summary.',
    '- Persisted run durations on finished statuses.',
  ].join('\n');

  // #358: a no-op outcome demo so QA can see the non-success card, which is
  // visually distinct from the green "Claude Code finished" card and never
  // shows the [CODING AGENT COMPLETED] marker. The ccOutcome:'no_changes'
  // discriminator is what makes the harness fold this into the Mayor's
  // context under a non-completed label rather than a fake completion.
  const ccNoOpOutput = [
    '[staging fixture] I reviewed the relevant files but the requested',
    'behaviour was already in place — nothing needed changing, so no commit',
    'was made.',
  ].join('\n');

  // Timeline order matters: the dev-chat pairing pre-pass attaches the
  // 'Claude Code progress' row to the nearest PRECEDING "Claude Code is
  // running" status, so insert status → progress → finished with
  // ascending timestamps.
  const messages = [
    { role: 'user', content: '[staging fixture] Please add a progress indicator for Claude Code runs.', metadata: {}, minutesAgo: 39 },
    { role: 'system', content: 'Spinning up coding agent (Claude Sonnet 4.6)...', metadata: {}, minutesAgo: 38 },
    { role: 'system', content: 'Claude Code is running...', metadata: {}, minutesAgo: 38 },
    { role: 'system', content: 'Claude Code progress', metadata: { progressLog }, minutesAgo: 38 },
    { role: 'system', content: 'Claude Code finished', metadata: { ccOutput, ccOutcome: 'success', durationMs: 252000 }, minutesAgo: 34 },
    { role: 'user', content: '[staging fixture] Make sure the elapsed timer never disappears.', metadata: {}, minutesAgo: 33 },
    { role: 'system', content: 'Spinning up coding agent (Claude Sonnet 4.6)...', metadata: {}, minutesAgo: 32 },
    { role: 'system', content: 'Claude Code is running...', metadata: {}, minutesAgo: 32 },
    { role: 'system', content: 'Claude Code made no changes', metadata: { ccOutput: ccNoOpOutput, ccOutcome: 'no_changes', durationMs: 41000 }, minutesAgo: 31 },
  ];

  for (const m of messages) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))`,
      [sessionId, m.role, m.content, JSON.stringify(m.metadata), m.minutesAgo]
    );
  }

  log.info('db', 'Staging CC-progress fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}

// #286: AI-progress-estimate fixture. The '✦ AI guess' span only renders
// on an *active* "Claude Code is running…" line that carries an estimate,
// and real estimates are emitted live over SSE (never persisted), so the
// finished-run fixture above can never show one. Seed one dev-chat session
// whose newest system row is an active running line carrying persisted
// estimate metadata ({ text, remainingSeconds }), paired with a progress
// row so the merged disclosure summary (and its estimate span) renders.
// dev-chat.js hydrates msg._estimate / _estimateRemaining from
// metadata.estimate on load (mirroring the live cc_estimate path), so the
// guess shows on reload without a worker running — which is exactly what
// makes the mobile-visibility fix reviewable on a narrow viewport.
// chat_sessions is staging:private, so this is invisible without seeding.
// Idempotent on the fixture branch name; strict no-op in production.
async function seedStagingCcEstimateRun(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging CC-estimate fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging CC-estimate fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const fixtureBranch = 'staging-fixture/cc-progress-estimate';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (existing.length) return;

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, created_at)
     VALUES
       ($1, $2, $3, '[staging fixture] AI progress estimate demo run', 'active',
        NOW() - INTERVAL '3 minutes')
     RETURNING id`,
    [appId, owner.id, fixtureBranch]
  );
  const sessionId = sessionRows[0].id;

  // A short in-flight progress log so the running line renders as the
  // disclosure summary (the estimate span lives on that summary).
  const progressLog = [
    '[refresh]',
    '[claude (mode build)]',
    '… Planning the change before touching any files',
    'Reading public/js/dev-chat.js',
    '  ⎿ Read: 3160 lines',
    'Reading public/css/app.css',
    '  ⎿ Read: 1290 lines',
    'Editing public/css/app.css',
    '  ⎿ Edit: ok',
  ];

  // Timeline order matters: the dev-chat pairing pre-pass attaches the
  // 'Claude Code progress' row to the nearest PRECEDING active running
  // status, so insert status → progress with ascending timestamps and
  // NO terminal row (so the running line stays `_active`). The estimate
  // metadata rides on the running line — that's the row that becomes
  // `_active` and whose `_estimate` the summary reads.
  const messages = [
    { role: 'user', content: '[staging fixture] Please add the new route handler.', metadata: {}, minutesAgo: 3 },
    { role: 'system', content: 'Spinning up coding agent (Claude Sonnet 4.6)...', metadata: {}, minutesAgo: 2 },
    {
      role: 'system',
      content: 'Claude Code is running...',
      // #359: a low remainingSeconds so a reviewer opening the seeded run
      // watches the live count-down tick down and cross into "due now" within
      // ~½m (the count-down re-anchors from load time — see dev-chat hydration).
      metadata: { estimate: { text: 'wiring up the new route', remainingSeconds: 35 } },
      minutesAgo: 2,
    },
    { role: 'system', content: 'Claude Code progress', metadata: { progressLog }, minutesAgo: 2 },
  ];

  for (const m of messages) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))`,
      [sessionId, m.role, m.content, JSON.stringify(m.metadata), m.minutesAgo]
    );
  }

  log.info('db', 'Staging CC-estimate fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}

// Sync-with-main activity fixture (issue: make sync emit session-native
// activity). Triggering a real merge against cloned data isn't possible
// in staging (there's no divergent git branch to merge), so we seed one
// dev-chat session that (a) shows the "Sync with main" banner via
// behind_main > 0 and (b) carries a representative *completed* sync
// activity in its timeline: the opening status row, a "Claude Code
// progress" row whose progressLog holds the illustrative fetch/merge/push
// lines, and the terminal "Merged main cleanly" row — exactly the rows a
// real clean sync emits. A matching SYNC_MAIN events row is recorded too.
// All ids sit in the 900xxx synthetic range and the title carries the
// "Staging demo" prefix so the row can't be mistaken for real work.
// chat_sessions is staging:private, so this is invisible without seeding.
// Strict no-op in production.
async function seedStagingSyncActivity(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    const { rows: appRows } = await pool.query(
      'SELECT id FROM apps WHERE slug = $1',
      [config.selfAppSlug]
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Staging sync-activity fixture skipped: self-app row missing', {
        slug: config.selfAppSlug,
      });
      return;
    }

    const { rows: userRows } = await pool.query(
      `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 1`
    );
    if (!userRows.length) {
      log.warn('db', 'Staging sync-activity fixture skipped: no users');
      return;
    }
    const owner = userRows[0];

    const SESSION_ID = 900050;
    const sha = 'a1b2c3d';

    // Idempotent: re-runs on every staging boot. The session row carries
    // behind_main = 2 so the banner shows "behind main"; ON CONFLICT keeps
    // the boot path a no-op after the first seed.
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_title, status, behind_main, created_at)
       VALUES
         ($1, $2, $3, 'staging-demo/sync-activity',
          '[staging fixture] Sync-with-main activity demo', 'active', 2, NOW())
       ON CONFLICT (id) DO UPDATE SET behind_main = 2`,
      [SESSION_ID, appId, owner.id]
    );

    // Only seed the timeline rows once (keyed off whether the terminal
    // row already exists) so re-runs don't pile up duplicate activity.
    const { rows: existingMsgs } = await pool.query(
      `SELECT 1 FROM chat_session_messages
        WHERE session_id = $1 AND metadata->'syncMain' IS NOT NULL LIMIT 1`,
      [SESSION_ID]
    );
    if (!existingMsgs.length) {
      // Opening status — pairs with the progress row below via
      // ACTIVE_CC_STATUS_RE on the frontend.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', 'Syncing with main…', '{}'::jsonb)`,
        [SESSION_ID]
      );
      // The collapsible progress log with a few illustrative lines.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', 'Claude Code progress', $2)`,
        [SESSION_ID, JSON.stringify({
          progressLog: ['Fetching main…', 'Merging origin/main…', 'Pushing…'],
        })]
      );
      // Terminal outcome row.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [SESSION_ID,
         `Merged main cleanly. Pushed ${sha}.`,
         JSON.stringify({ syncMain: { syncResult: 'clean', behind: 2, sha, pushOk: true } })]
      );
      // Matching analytics row.
      await pool.query(
        `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
         VALUES ($1, $2, $3, 'sync_main', $4::jsonb)`,
        [owner.id, appId, SESSION_ID,
         JSON.stringify({ syncResult: 'clean', behind: 2, sha, pushOk: true, trigger: 'manual' })]
      );
    }

    log.info('db', 'Staging sync-activity fixture seeded', {
      appId, owner: owner.username, sessionId: SESSION_ID,
    });
  } catch (err) {
    log.warn('db', 'Staging sync-activity seeding failed', { message: err.message });
  }
}

// Fixtures for the home-card activity chips (#57): one dedicated demo
// app whose card exercises all three chips at once. chat_sessions is
// staging:private (schema-only in staging), so without seeded sessions
// the "to vote" / "in dev" chips would read zero on every card; the
// demo issue guarantees the issues chip is non-zero on a card testers
// can find by name. Explicit IDs sit in the 900xxx range so they can't
// collide with cloned prod rows, every row carries the "Staging demo"
// prefix per the mock-data convention, and ON CONFLICT DO NOTHING
// keeps the re-run-on-every-boot path idempotent. The demo user's
// password is a plain marker string — bcrypt.compare against a
// non-hash always fails, so the account can't be logged into.
async function seedStagingDemoAppCard(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES (900001, 'staging-demo-user', 'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, view_visibility, created_by)
       VALUES (900001, 'Staging demo app', 'staging-demo-app', 'running', 'public', 900001)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status, promoted_at)
       VALUES
         (900001, 900001, 900001, 'staging-demo/promoted-pr', 900001,
          'Staging demo PR — awaiting votes', 'promoted', NOW()),
         (900002, 900001, 900001, 'staging-demo-branch', NULL, NULL, 'active', NULL)
       ON CONFLICT DO NOTHING`
    );
    await pool.query(
      `INSERT INTO issues (id, app_id, title, description, created_by, status)
       VALUES (900001, 900001, 'Staging demo issue',
               'Staging demo issue so the home-card issues chip has a row to count.',
               900001, 'open')
       ON CONFLICT DO NOTHING`
    );
    log.info('db', 'Staging demo app-card fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging demo app-card seeding failed', { message: err.message });
  }
}

// Fixtures for the Members & visibility panel. The public demo app above
// renders the visibility toggles but NOT the collaborator list (that
// section only shows for an invite-only app). To demonstrate the member
// list + invite typeahead — and so the panel-opens fix has data behind it —
// seed a private (collab_visibility='private') app owned by the demo user
// with two collaborators: one accepted member and one pending invite.
// app_collaborators is NOT staging:private (membership must survive into
// clones), but a freshly seeded private app has no extra members until we
// add them here. IDs sit in the 900xxx range, rows carry the "Staging demo"
// prefix, and ON CONFLICT DO NOTHING keeps the every-boot re-run idempotent.
// Sentinel passwords mean the fixture accounts can never log in.
async function seedStagingMembersPanel(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // Demo collaborator accounts (alongside staging-demo-user/900001, which
    // owns the private app below and is its creator-member).
    await pool.query(
      `INSERT INTO users (id, username, password)
       VALUES
         (900020, 'staging-demo-collab',   'staging-demo-not-a-login'),
         (900021, 'staging-demo-invitee',  'staging-demo-not-a-login')
       ON CONFLICT DO NOTHING`
    );
    // Invite-only app: both build + view private (collab-private may keep a
    // public view, but private/private is the clearest demo and satisfies
    // the collab-public⇒view-public invariant).
    await pool.query(
      `INSERT INTO apps (id, name, slug, status, collab_visibility, view_visibility, created_by)
       VALUES (900010, 'Staging demo private app', 'staging-demo-private-app', 'running',
               'private', 'private', 900001)
       ON CONFLICT DO NOTHING`
    );
    // Membership rows: creator as accepted member, one extra accepted
    // member (removable), and one pending invite (renders the "invited"
    // tag + a "Revoke" control).
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       VALUES
         (900010, 900001, 'member',  900001, NOW()),
         (900010, 900020, 'member',  900001, NOW()),
         (900010, 900021, 'invited', 900001, NULL)
       ON CONFLICT (app_id, user_id) DO NOTHING`
    );
    log.info('db', 'Staging members-panel fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging members-panel seeding failed', { message: err.message });
  }
}

// Per-user app-quota fixtures. The admin Users list is a data-dependent
// rows UI, so staging needs users spanning the quota states to exercise
// the inline quota edit, the "N used" indicator, and the bulk "Set all"
// button. We guarantee three states:
//   - AT quota   → reuse staging-demo-user (900001), who already owns the
//                  demo app (900001) from seedStagingDemoAppCard above:
//                  quota 1 with 1 live app = at the limit (create blocked,
//                  affordance hidden).
//   - CAN create → a fresh fixture user with quota 5 and 0 apps.
//   - CANNOT     → a fresh fixture user with quota 0 and 0 apps.
// Obviously-fake usernames + non-login passwords; fixed high ids + explicit
// quota writes make it idempotent, and the whole thing is a strict no-op
// outside staging.
async function seedStagingAppQuotaUsers(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // CAN-create and CANNOT-create fixture users. Sentinel passwords mean
    // these accounts can never log in interactively.
    await pool.query(
      `INSERT INTO users (id, username, password, app_quota)
       VALUES
         (900020, 'staging-demo-quota-ok',   '!staging-fixture-no-login!', 5),
         (900021, 'staging-demo-quota-zero', '!staging-fixture-no-login!', 0)
       ON CONFLICT (id) DO NOTHING`
    );

    // Pin the three quotas explicitly so reboots keep the intended states
    // even if a tester edited them, and so staging-demo-user lands "at
    // limit" (quota 1, owns the 1 live demo app from seedStagingDemoAppCard).
    await pool.query('UPDATE users SET app_quota = 1 WHERE id = 900001');
    await pool.query('UPDATE users SET app_quota = 5 WHERE id = 900020');
    await pool.query('UPDATE users SET app_quota = 0 WHERE id = 900021');

    log.info('db', 'Staging app-quota fixtures seeded');
  } catch (err) {
    log.warn('db', 'Staging app-quota fixtures seeding failed', { message: err.message });
  }
}

// View-only admin role fixtures (issue #311). The admin user list and its
// three-way role selector are row-rendering, data-dependent UI. Staging
// clones preserve prod `users` rows, but prod may contain NO view-only
// admin, so the new read-only treatment and the third selector option
// wouldn't be demonstrable. Seed one obviously-fake account as a view-only
// admin (is_admin = TRUE, admin_readonly = TRUE) so a staging reviewer sees
// the three roles side-by-side in /admin. The existing seeded admin stays a
// FULL admin (untouched), preserving the last-full-admin invariant. Strict
// no-op outside staging; idempotent via fixed id + ON CONFLICT and a pinned
// UPDATE on reboot.
async function seedStagingViewOnlyAdmin(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  try {
    // Sentinel password means this account can never log in interactively.
    await pool.query(
      `INSERT INTO users (id, username, password, is_admin, admin_readonly)
       VALUES (900030, 'staging-demo-view-admin', '!staging-fixture-no-login!', TRUE, TRUE)
       ON CONFLICT (id) DO NOTHING`
    );
    // Pin the role explicitly so a reboot (or a tester flipping it) restores
    // the intended view-only state.
    await pool.query(
      'UPDATE users SET is_admin = TRUE, admin_readonly = TRUE WHERE id = 900030'
    );

    log.info('db', 'Staging view-only admin fixture seeded');
  } catch (err) {
    log.warn('db', 'Staging view-only admin fixture seeding failed', { message: err.message });
  }
}

// (#270) Fixtures for the multi-route before/after gallery. The grouped
// gallery renders one labelled before/after row per captured route, but
// session_visuals is staging:private (schema-only in staging, always
// empty) so without seeding every proposal's "Show before/after" panel is
// blank in a staging preview. Attaches to the promoted demo session
// (900001) seeded by seedStagingDemoAppCard above — so it shows up on the
// Staging demo app's proposals/vote panel — with TWO capture groups
// (capture_index 0 -> '/', 1 -> '/board'), each carrying a before.png +
// after.png so the grouped gallery renders multiple labelled rows. Tiny
// 1x1 inline PNG bytes are enough — the test is layout, not content.
// Idempotent via fixed 32-hex ids + ON CONFLICT DO NOTHING, obviously
// fake, and a strict no-op outside staging.
async function seedStagingVisuals(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  // 1x1 transparent PNG — valid image bytes for the <img>/embed surfaces
  // and the <video> poster.
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  // Tiny placeholder webm: enough to exercise the comparison overlay's
  // <video> branch (#353). It isn't a decodable clip — the point is that
  // the renderer picks the webm and falls back to the PNG poster — so QA
  // can confirm the video tile/column renders without a real recording.
  const WEBM_PLACEHOLDER = Buffer.from(
    'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAAR',
    'base64'
  );
  const CT = { png: 'image/png', webm: 'video/webm', gif: 'image/gif' };
  const DEMO_SESSION_ID = 900001;
  // 32-hex ids (match the /^[a-f0-9]{32}$/ token the renderers validate).
  // Group 2 (#353) uses a self-app hash deep-link path so the captured
  // path label + the hash-route normalisation are visible/testable in
  // staging, and carries a webm (+ PNG poster) per side so the comparison
  // overlay's video branch is exercised too.
  const SELF_APP_DEEP_PATH = '/app/social-vibecoding/dev/proposals/900301';
  const rows = [
    { id: 'a'.repeat(32), kind: 'before', media: 'png',  idx: 0, path: '/' },
    { id: 'b'.repeat(32), kind: 'after',  media: 'png',  idx: 0, path: '/' },
    { id: 'c'.repeat(32), kind: 'before', media: 'png',  idx: 1, path: '/board' },
    { id: 'd'.repeat(32), kind: 'after',  media: 'png',  idx: 1, path: '/board' },
    { id: 'e'.repeat(32), kind: 'before', media: 'png',  idx: 2, path: SELF_APP_DEEP_PATH },
    { id: 'f'.repeat(32), kind: 'before', media: 'webm', idx: 2, path: SELF_APP_DEEP_PATH },
    { id: '0'.repeat(32), kind: 'after',  media: 'png',  idx: 2, path: SELF_APP_DEEP_PATH },
    { id: '1'.repeat(32), kind: 'after',  media: 'webm', idx: 2, path: SELF_APP_DEEP_PATH },
  ];

  try {
    // Point the demo session's testing_paths at the captured routes so the
    // persisted annotation matches the seeded capture groups.
    await pool.query(
      `UPDATE chat_sessions SET testing_paths = $1::jsonb
         WHERE id = $2 AND testing_paths IS NULL`,
      [JSON.stringify(['/', '/board', SELF_APP_DEEP_PATH]), DEMO_SESSION_ID]
    );
    for (const r of rows) {
      const data = r.media === 'webm' ? WEBM_PLACEHOLDER : PNG_1X1;
      await pool.query(
        `INSERT INTO session_visuals
           (id, session_id, commit_hash, kind, media, content_type, data, captured_path, capture_index)
         SELECT $1, $2, NULL, $3, $4, $5, $6, $7, $8
          WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $2)
         ON CONFLICT (id) DO NOTHING`,
        [r.id, DEMO_SESSION_ID, r.kind, r.media, CT[r.media], data, r.path, r.idx]
      );
    }
    log.info('db', 'Staging multi-path visuals fixtures seeded', { sessionId: DEMO_SESSION_ID });
  } catch (err) {
    log.warn('db', 'Staging visuals seeding failed', { message: err.message });
  }
}

// (#60) Fixtures for the leaderboard user-profile drill-in. The profile
// view lists a user's PROPOSED PRs (chat_sessions) with kudos counts
// (pr_kudos) — both staging:private tables, so without seeding the view
// is empty for every user in staging. Seeds two obviously-fake users
// (never reference real ones) at high fixed ids, a handful of sessions
// covering each status badge the view renders (merged / open / merging
// / closed), and kudos from the second user so counts are non-zero and
// @staging-demo-author ranks visibly on the Top users tab. Idempotent
// via ON CONFLICT DO NOTHING on the fixed ids; strictly a no-op outside
// staging.
async function seedStagingLeaderboardProfile(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    `SELECT id FROM apps WHERE view_visibility = 'public' ORDER BY id LIMIT 1`
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging leaderboard-profile fixtures skipped: no public app');
    return;
  }

  // Password is a non-bcrypt sentinel — these accounts can never log in.
  const AUTHOR_ID = 900001;
  const GIVER_ID = 900002;
  await pool.query(
    `INSERT INTO users (id, username, password)
     VALUES ($1, 'staging-demo-author', '!staging-fixture-no-login!'),
            ($2, 'staging-demo-giver',  '!staging-fixture-no-login!')
     ON CONFLICT DO NOTHING`,
    [AUTHOR_ID, GIVER_ID]
  );

  // One session per status the profile renders a badge for. created_at
  // is staggered so the newest-first ordering is visible; merged_at /
  // promoted_at follow what the real lifecycle would have written. The
  // archived row keeps promoted_at set — that's what makes it a CLOSED
  // PR (proposed, then abandoned) rather than a private draft, which
  // the profile endpoint excludes. pr_url present on the merged row so
  // the external GitHub icon renders on at least one fixture.
  const sessions = [
    { id: 9000201, pr: 900301, status: 'merged', hoursAgo: 6,
      title: '[Mock] Staging demo PR — merged: tidy profile chips',
      promoted: true, merged: true, url: true },
    { id: 9000202, pr: 900302, status: 'promoted', hoursAgo: 30,
      title: '[Mock] Staging demo PR — open for vote: dark-mode polish',
      promoted: true, merged: false, url: false },
    { id: 9000203, pr: 900303, status: 'merging', hoursAgo: 54,
      title: '[Mock] Staging demo PR — merging: debounce search box',
      promoted: true, merged: false, url: false },
    { id: 9000204, pr: 900304, status: 'archived', hoursAgo: 80,
      title: '[Mock] Staging demo PR — closed without merging',
      promoted: true, merged: false, url: false },
  ];
  for (const s of sessions) {
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, pr_url,
          status, created_at, promoted_at, merged_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8,
          NOW() - ($9::int * INTERVAL '1 hour'),
          CASE WHEN $10 THEN NOW() - ($9::int * INTERVAL '1 hour') END,
          CASE WHEN $11 THEN NOW() - (($9 - 1)::int * INTERVAL '1 hour') END)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, appId, AUTHOR_ID, `staging-fixture/profile-pr-${s.id}`,
       s.pr, s.title,
       s.url ? `https://github.com/usernode-staging/demo/pull/${s.pr}` : null,
       s.status, s.hoursAgo, s.promoted, s.merged]
    );
  }

  // Kudos from the giver on the merged + open PRs: non-zero per-row
  // counts, and merged credit so the author scores on Top users.
  for (const sessionId of [9000201, 9000202]) {
    await pool.query(
      `INSERT INTO pr_kudos (session_id, giver_user_id, week_start, created_at)
       SELECT $1, $2, date_trunc('week', NOW() AT TIME ZONE 'UTC')::date, NOW()
        WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = $1)
       ON CONFLICT (session_id, giver_user_id) DO NOTHING`,
      [sessionId, GIVER_ID]
    );
  }

  log.info('db', 'Staging leaderboard-profile fixtures seeded', { appId });
}

// LLM-spend fixtures for the admin dashboard's Daily-spend and
// Spend-by-builder charts. `llm_usage` is staging:private (copied
// schema-only → empty in staging), so without this both charts render
// "Not enough data yet." We attach 30 days of spend to a handful of
// existing seeded users, admins FIRST, so the "Include admin users"
// checkbox visibly changes the totals. Each user gets a distinct mix of
// platform-key spend (total_cost_cents) and user-key/BYOK spend
// (byok_cost_cents) so all three toggle modes — and the builder ranking
// per mode — differ. Idempotent via ON CONFLICT (user_id, date).
async function seedStagingLlmUsage(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: users } = await pool.query(
    `SELECT id, is_admin FROM users ORDER BY is_admin DESC, id ASC LIMIT 6`
  );
  if (!users.length) {
    log.warn('db', 'Staging llm_usage fixtures skipped: no users');
    return;
  }

  // Per-user spend profile. Cycle platform-only / byok-only / both so the
  // toggles tell different stories; platform base descends with index
  // while byok base ascends, so the two rankings genuinely disagree.
  for (let i = 0; i < users.length; i++) {
    const mode = i % 3; // 0 platform-only, 1 byok-only, 2 both
    const platformBase = mode === 1 ? 0 : (users.length - i) * 6 + 4; // cents/day
    const byokBase = mode === 0 ? 0 : (i + 1) * 5 + 3;                 // cents/day
    await pool.query(
      `INSERT INTO llm_usage (user_id, date, total_cost_cents, byok_cost_cents)
       SELECT $1,
              CURRENT_DATE - g,
              ($2::numeric * (0.5 + (g % 5) * 0.12))::numeric(10,4),
              ($3::numeric * (0.5 + ((g + 2) % 5) * 0.12))::numeric(10,4)
         FROM generate_series(0, 29) g
       ON CONFLICT (user_id, date) DO NOTHING`,
      [users[i].id, platformBase, byokBase]
    );
  }

  log.info('db', 'Staging llm_usage fixtures seeded', { users: users.length });
}

// #370: make the token/spend cap reproducible in a staging preview so a
// tester can verify that hitting the cap on send no longer wipes the
// composer text. Three idempotent, staging-only steps against the
// tester's own login (the admin / first user — the account staging
// previews sign in as):
//   1. Pin their per-user daily limit to 1¢ (users.daily_limit_cents).
//   2. Ensure today's recorded spend is well over that (≥ 50¢), so
//      limits.checkBudget reports "Daily limit reached" → the chat POST
//      returns 429 { error } on the very next send.
//   3. Seed a clearly-named ACTIVE dev session on the self-app for them
//      to type into.
// The result: opening that session, typing a message and pressing Send
// bounces with the cap notice while the typed text stays in the box.
// Strictly a no-op outside staging; only this ephemeral PR preview's DB
// is touched (never prod).
async function seedStagingCapReached(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging cap-reached fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username FROM users ORDER BY is_admin DESC, id ASC LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging cap-reached fixture skipped: no users');
    return;
  }
  const tester = userRows[0];

  // 1. Pin the per-user daily cap to 1¢.
  await pool.query(
    'UPDATE users SET daily_limit_cents = 1 WHERE id = $1',
    [tester.id]
  );

  // 2. Guarantee today's spend exceeds the 1¢ cap (raise-only, so the
  //    dashboard's own llm_usage fixtures aren't reduced on re-runs).
  await pool.query(
    `INSERT INTO llm_usage (user_id, date, total_cost_cents)
     VALUES ($1, CURRENT_DATE, 50)
     ON CONFLICT (user_id, date)
       DO UPDATE SET total_cost_cents = GREATEST(llm_usage.total_cost_cents, 50)`,
    [tester.id]
  );

  // 3. An active dev session to type into, named so the testing steps
  //    can reference it. Idempotent via branch-name lookup.
  const branch = 'staging-fixture/token-cap';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (!existing.length) {
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, session_title, status, created_at)
       VALUES ($1, $2, $3, $4, 'active', NOW() - INTERVAL '2 minutes')`,
      [appId, tester.id, branch,
       '[staging fixture] Token cap — your text is preserved']
    );
  }

  log.info('db', 'Staging cap-reached fixture seeded', {
    appId, tester: tester.username,
  });
}

// #361: seed ~30 days of system-token spend so the dashboard's Daily
// spend chart renders its new cyan "System tokens" segment and the
// "System tokens today: $X.XX / $25.00" readout has real data. A modest
// daily figure (a few hundred cents) tapering down, staying under the
// $25 cap most days and brushing it on one or two so the readout looks
// realistic. Idempotent via ON CONFLICT (date); a no-op outside staging.
async function seedStagingSystemTokenUsage(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;
  // Cost (cents) per day-offset g (0 = today). Base ~480¢ ($4.80) tapering
  // with a wobble; two recent days near the $25 cap (2300–2450¢).
  await pool.query(
    `INSERT INTO system_token_usage (date, cost_cents)
     SELECT CURRENT_DATE - g,
            CASE
              WHEN g = 0 THEN 2310
              WHEN g = 3 THEN 2440
              ELSE GREATEST(60, 480 - g * 9 + (g % 4) * 70)
            END::numeric(10,4)
       FROM generate_series(0, 29) g
     ON CONFLICT (date) DO NOTHING`
  );
  log.info('db', 'Staging system_token_usage fixtures seeded');
}

// Admin-attributed footprint for the dashboard's amber admin-split charts
// (#341). The colour split (Funnels, Growth, Engagement tiers, Top builders)
// is only visible when staging holds an ADMIN user whose recent activity
// overlaps the existing non-admin demo data. seedStagingLlmUsage already
// gives admins spend (so Daily spend / Spend-by-builder show the amber
// outline + tooltip breakout immediately); this fills the rest by giving the
// seeded view-only admin (900030, is_admin = TRUE) a small, recent footprint:
//   - two dev sessions, one promoted (~2wks ago), one merged (~1wk ago)
//     → Funnels admin segment, Growth promoted/merged admin, Top builders bar
//   - a few app_activity days + matching dapp_active_day / pr_promoted events
//     → Funnels "opened/returned" admin segment, Engagement DAU/WAU admin
//   - one kudos given → Funnels "engaged socially" admin segment
// With "Include admin users" ticked every admin-split chart then renders a
// non-zero amber segment beside the non-admin demo data. Idempotent (fixed
// 9000xx ids + ON CONFLICT), [staging fixture]-tagged, a no-op outside staging.
async function seedStagingDashboardAdminSplit(pool) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const ADMIN_ID = 900030; // staging-demo-view-admin (seeded earlier, is_admin)
  try {
    const { rows: adminRows } = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND is_admin', [ADMIN_ID]
    );
    if (!adminRows.length) {
      log.warn('db', 'Staging dashboard admin-split skipped: admin user missing');
      return;
    }

    const { rows: appRows } = await pool.query(
      `SELECT id FROM apps
         WHERE COALESCE(self_hosted, FALSE) = FALSE AND status <> 'deleted'
         ORDER BY id LIMIT 1`
    );
    const appId = appRows[0]?.id;
    if (!appId) {
      log.warn('db', 'Staging dashboard admin-split skipped: no public app');
      return;
    }

    // Two admin dev sessions: one promoted, one merged, dated within the
    // last couple of weeks so they fall inside the 12-week growth/engagement
    // windows. chat_sessions is staging:private → seeded here.
    await pool.query(
      `INSERT INTO chat_sessions
         (id, app_id, user_id, branch_name, pr_number, pr_title, status,
          created_at, promoted_at, merged_at)
       VALUES
         (9000401, $1, $2, 'staging-fixture/admin-split-promoted', 900401,
          '[staging fixture] Staging demo admin PR — promoted',
          'promoted', NOW() - INTERVAL '15 days', NOW() - INTERVAL '14 days', NULL),
         (9000402, $1, $2, 'staging-fixture/admin-split-merged', 900402,
          '[staging fixture] Staging demo admin PR — merged',
          'merged', NOW() - INTERVAL '9 days', NOW() - INTERVAL '8 days', NOW() - INTERVAL '7 days')
       ON CONFLICT (id) DO NOTHING`,
      [appId, ADMIN_ID]
    );

    // app_activity across 4 distinct recent days → Funnels opened/returned
    // admin segment + Engagement WAU (>= 2 days in the trailing 2 weeks).
    await pool.query(
      `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
       SELECT $1, $2, 120, CURRENT_DATE - g
         FROM generate_series(1, 4) g
       ON CONFLICT (app_id, user_id, date) DO NOTHING`,
      [appId, ADMIN_ID]
    );

    // Explicit events so the admin amber shows in Engagement tiers even when
    // the one-shot events backfill already ran on a prior boot of this
    // container: 4 dapp_active_day days (>= 2 → WAU) + a pr_promoted (→ DAU).
    await pool.query(
      `INSERT INTO events (id, user_id, app_id, event_type, created_at)
       SELECT 90004100 + g, $2, $1, 'dapp_active_day', NOW() - (g || ' days')::interval
         FROM generate_series(1, 4) g
       ON CONFLICT (id) DO NOTHING`,
      [appId, ADMIN_ID]
    );
    await pool.query(
      `INSERT INTO events (id, user_id, app_id, session_id, event_type, created_at)
       VALUES (90004110, $2, $1, 9000401, 'pr_promoted', NOW() - INTERVAL '14 days')
       ON CONFLICT (id) DO NOTHING`,
      [appId, ADMIN_ID]
    );

    // One kudos given by the admin → Funnels "engaged socially" admin segment.
    await pool.query(
      `INSERT INTO pr_kudos (session_id, giver_user_id, week_start, created_at)
       SELECT 9000402, $1, date_trunc('week', NOW() AT TIME ZONE 'UTC')::date, NOW()
        WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE id = 9000402)
       ON CONFLICT (session_id, giver_user_id) DO NOTHING`,
      [ADMIN_ID]
    );

    // Admin LLM spend across 6 recent days (inside the 30-day Daily spend
    // window) → the new amber admin segment on Daily spend in all three
    // toggle modes, plus the Spend-by-builder admin outline (bonus). Both
    // platform (total_cost_cents) and user-key (byok_cost_cents) costs are
    // non-zero so Platform / User key / Both modes each show the amber.
    // llm_usage is staging:private and UNIQUE(user_id, date) → ON CONFLICT.
    await pool.query(
      `INSERT INTO llm_usage (user_id, date, total_cost_cents, byok_cost_cents)
       SELECT $1, CURRENT_DATE - g, 40 + g * 6, 15 + g * 3
         FROM generate_series(1, 6) g
       ON CONFLICT (user_id, date) DO NOTHING`,
      [ADMIN_ID]
    );

    log.info('db', 'Staging dashboard admin-split fixtures seeded', { appId });
  } catch (err) {
    log.warn('db', 'Staging dashboard admin-split seeding failed', { message: err.message });
  }
}

// Q/A-mode fixture (#32): one demo dev-chat session whose latest Mayor
// turn asks two numbered clarifying questions and carries a matching
// metadata.suggestions payload, so a tester can see and tap the
// suggested-answer chips without burning a live LLM call.
// chat_sessions / chat_session_messages are staging:private (copied
// schema-only into staging), hence the seed. Same owner selection as
// the other session fixtures — the user the tester logs in as.
// Idempotent via the branch-name existence check.
async function seedStagingQaSession(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging Q/A fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging Q/A fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const branch = 'staging-fixture/qa-suggestions';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) return;

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, created_at)
     VALUES
       ($1, $2, $3, $4, 'active', NOW() - INTERVAL '30 minutes')
     RETURNING id`,
    [appId, owner.id, branch, '[staging fixture] Staging demo: Q/A suggested answers']
  );
  const sessionId = sessionRows[0].id;

  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, created_at)
     VALUES ($1, 'user', $2, NOW() - INTERVAL '29 minutes')`,
    [sessionId, 'Make the header nicer']
  );

  const assistantContent = 'Happy to! Two quick questions before I dispatch anything:\n\n'
    + '1. Which header — the platform-wide top bar, or the app view header? (suggested: the platform-wide top bar)\n'
    + '2. What does "nicer" mean here — tidier spacing, or a bolder visual refresh? (suggested: tidier spacing)';
  const suggestions = [
    {
      question: 'Which header?',
      answers: ['The platform-wide top bar', 'The app view header'],
    },
    {
      question: 'What does "nicer" mean?',
      answers: ['Tidier spacing', 'A bolder visual refresh'],
    },
  ];
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, $3, NOW() - INTERVAL '28 minutes')`,
    [sessionId, assistantContent, JSON.stringify({ suggestions })]
  );

  log.info('db', 'Staging Q/A fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}

// #32: reproduces the "session cloned from an auto run that ended in
// questions" shape so a tester can verify the suggested-answer chips
// render under the FOLLOW-UP message (the last row) without a live LLM
// run. An ordinary active, non-headless session with, in order:
//   1. a user seed message (the issue text),
//   2. an assistant message holding the clarifying questions WITH
//      metadata.suggestions (the cloned question turn), and
//   3. an assistant follow-up message — text in the spirit of
//      buildHeadlessFollowUpMessage's question branch — ALSO carrying the
//      same metadata.suggestions.
// The chips must appear under the follow-up (row 3), confirming Defect 2
// (Part B's forwarding) is fixed. chat_sessions / chat_session_messages
// are staging:private, hence the seed. Owner is the first-admin selection
// shared with the other session fixtures; idempotent via branch name.
async function seedStagingCloneQuestionSuggestions(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging clone-question fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging clone-question fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const branch = 'staging-fixture/clone-question-suggestions';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) return;

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, created_at)
     VALUES
       ($1, $2, $3, $4, 'active', NOW() - INTERVAL '20 minutes')
     RETURNING id`,
    [appId, owner.id, branch, '[staging fixture] Staging demo: chips on a cloned auto-question session']
  );
  const sessionId = sessionRows[0].id;

  // Reuse the two-question shape from seedStagingQaSession.
  const suggestions = [
    {
      question: 'Which header?',
      answers: ['The platform-wide top bar', 'The app view header'],
    },
    {
      question: 'What does "nicer" mean?',
      answers: ['Tidier spacing', 'A bolder visual refresh'],
    },
  ];

  // 1. The issue text the auto session worked from.
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, created_at)
     VALUES ($1, 'user', $2, NOW() - INTERVAL '19 minutes')`,
    [sessionId, 'Please work on GitHub issue #42: "Make the header nicer".']
  );

  // 2. The cloned question turn — clarifying questions WITH suggestions.
  const questionContent = 'Two quick questions before I can proceed:\n\n'
    + '1. Which header — the platform-wide top bar, or the app view header? (suggested: the platform-wide top bar)\n'
    + '2. What does "nicer" mean here — tidier spacing, or a bolder visual refresh? (suggested: tidier spacing)';
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, $3, NOW() - INTERVAL '18 minutes')`,
    [sessionId, questionContent, JSON.stringify({ suggestions })]
  );

  // 3. The appended follow-up — last row, carrying the SAME suggestions so
  // the chips render under it (the thing Part B fixes).
  const followUpContent =
    'This session was cloned from an auto session that ran unattended on GitHub issue #42. '
    + "You're on your own branch (forked from the auto session's, so its commits carry over).\n\n"
    + 'Where things stand: the auto session ran into something that needs a human decision — '
    + 'see its questions above (the same questions were also posted as a comment on the GitHub '
    + "issue). Answer here and we'll continue from where it left off.";
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, $3, NOW() - INTERVAL '17 minutes')`,
    [sessionId, followUpContent, JSON.stringify({ suggestions })]
  );

  log.info('db', 'Staging clone-question fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}


// #330: a cloned-from-auto session whose auto run ended in a SPEC outcome.
// The appended follow-up message (the last row) carries metadata.quickReplies
// so the above-box pill bar renders next-step pills ("Build it" / "Revise the
// spec" / "What will this change?") — the bug this fixes was that bar being
// empty. Sibling of seedStagingCloneQuestionSuggestions (that one covers the
// chips/question path; this one the pills/spec path). chat_sessions /
// chat_session_messages are staging:private (schema-only in staging), hence
// the seed. Idempotent via the branch-name existence check.
async function seedStagingCloneSpecPills(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging clone-spec-pills fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging clone-spec-pills fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const branch = 'staging-fixture/clone-spec-pills';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) return;

  // Carry a spec so the follow-up's "open the spec viewer" line is truthful;
  // headless_outcome 'spec' matches what the clone handler keys pills off.
  const specMd = '## User-facing changes\n\nStaging demo spec for the cloned auto proposal.\n\n'
    + '## Technical implementation\n\nStaging demo: no real change — fixture for the pill bar.';
  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, status, spec_md, cloned_from_session_id,
        is_headless, headless_outcome, headless_issue_number, created_at)
     VALUES
       ($1, $2, $3, $4, 'active', $5, NULL, FALSE, 'spec', 42, NOW() - INTERVAL '15 minutes')
     RETURNING id`,
    [appId, owner.id, branch, '[staging fixture] Staging demo: pills on a cloned auto-spec session', specMd]
  );
  const sessionId = sessionRows[0].id;

  // 1. The issue text the auto session worked from.
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, created_at)
     VALUES ($1, 'user', $2, NOW() - INTERVAL '14 minutes')`,
    [sessionId, 'Please work on GitHub issue #42: "Make the header nicer".']
  );

  // 2. The appended follow-up — last row, carrying the SPEC-outcome pills so
  // the above-box pill bar renders (the thing #330 fixes).
  const quickReplies = ['Build it', 'Revise the spec', 'What will this change?'];
  const followUpContent =
    'This session was cloned from an auto session that ran unattended on GitHub issue #42. '
    + "You're on your own branch (forked from the auto session's, so its commits carry over).\n\n"
    + 'Where things stand: the auto session investigated the repo and drafted a spec — open the '
    + "spec viewer to review it. When you're happy with it, tell me to build it and I'll dispatch "
    + 'the coding agent.';
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
     VALUES ($1, 'assistant', $2, $3, NOW() - INTERVAL '13 minutes')`,
    [sessionId, followUpContent, JSON.stringify({ quickReplies })]
  );

  log.info('db', 'Staging clone-spec-pills fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}


// Spec-viewer fixtures (#233): three dev-chat sessions in differing
// spec states so a tester can verify that switching sessions never
// shows another session's spec. A and C each carry a (different) spec —
// spec_md + a frozen v1 in chat_session_specs + the inline preview card
// message that opens the viewer — while B has no spec at all, so the
// viewer's "No spec yet" empty state is reachable. chat_sessions /
// chat_session_messages / chat_session_specs are staging:private
// (schema-only in staging), hence the seed. Owner is the user the
// tester logs in as (first admin), same selection as the other session
// fixtures. Idempotent via the branch-name existence check; spec
// content conforms to the two-half convention (#196) so the viewer's
// User-facing / Technical tabs render too.
async function seedStagingSpecViewerSessions(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging spec-viewer fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging spec-viewer fixtures skipped: no users');
    return;
  }
  const owner = userRows[0];

  const specA = [
    '# Staging demo spec A: welcome banner',
    '',
    'Fixture spec for session A — if you see this in session B or C, that is bug #233.',
    '',
    '## User-facing changes',
    '',
    '- A "Welcome back" banner appears at the top of the home screen.',
    '- It can be dismissed and stays dismissed for the rest of the day.',
    '',
    '## Technical implementation',
    '',
    '- Render the banner in the home view; persist dismissal in localStorage.',
  ].join('\n');

  const specC = [
    '# Staging demo spec C: compact session rows',
    '',
    'Fixture spec for session C — if you see this in session A or B, that is bug #233.',
    '',
    '## User-facing changes',
    '',
    '- Session rows in the dev tab get a tighter, single-line layout.',
    '- Long titles truncate with an ellipsis instead of wrapping.',
    '',
    '## Technical implementation',
    '',
    '- CSS-only change to the session list row component.',
  ].join('\n');

  const fixtures = [
    { branch: 'staging-fixture/spec-viewer-a', title: 'Staging demo: spec session A', spec: specA, minutesAgo: 60 },
    { branch: 'staging-fixture/spec-viewer-b', title: 'Staging demo: spec-less session B', spec: null, minutesAgo: 55 },
    { branch: 'staging-fixture/spec-viewer-c', title: 'Staging demo: spec session C', spec: specC, minutesAgo: 50 },
  ];

  let inserted = 0;
  for (const f of fixtures) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, f.branch]
    );
    if (existing.length) continue;

    const { rows: sessionRows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_title, status, spec_md, created_at)
       VALUES ($1, $2, $3, $4, 'active', $5, NOW() - ($6::int * INTERVAL '1 minute'))
       RETURNING id`,
      [appId, owner.id, f.branch, `[staging fixture] ${f.title}`, f.spec || '', f.minutesAgo]
    );
    const sessionId = sessionRows[0].id;
    inserted++;

    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, created_at)
       VALUES ($1, 'user', $2, NOW() - ($3::int * INTERVAL '1 minute'))`,
      [sessionId, f.spec
        ? 'Draft a spec for this change please.'
        : 'Just exploring — no spec here yet.', f.minutesAgo]
    );

    if (f.spec) {
      // Mirror the real scout flow: freeze v1 (spec_md stays
      // byte-identical to the latest version) and persist the inline
      // preview card the viewer opens from.
      await pool.query(
        `INSERT INTO chat_session_specs (session_id, version, content, built_at)
         VALUES ($1, 1, $2, NOW() - ($3::int * INTERVAL '1 minute'))
         ON CONFLICT (session_id, version) DO NOTHING`,
        [sessionId, f.spec, f.minutesAgo - 1]
      );
      const lineCount = f.spec.split('\n').length;
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
         VALUES ($1, 'system', $2, $3, NOW() - ($4::int * INTERVAL '1 minute'))`,
        [sessionId, `Scout drafted a ${lineCount}-line spec from the codebase.`,
         JSON.stringify({ specPreview: f.spec, specLines: lineCount, specVersion: 1 }),
         f.minutesAgo - 1]
      );
    }
  }

  log.info('db', 'Staging spec-viewer fixtures seeded', {
    appId,
    owner: owner.username,
    total: fixtures.length,
    inserted,
  });
}

// Checkbox-flicker fix fixture. The fix is a client-rendering change, but
// every checkbox surface is data-driven, so seed a scout/proposal session
// named "Staging demo proposal" carrying GFM task lists across all three
// rendered surfaces: the spec viewer body (spec_md + frozen v1), the inline
// spec-preview snippet (a system message with specPreview whose checklist
// straddles the ~200-char clip boundary, exercising the whole-line clip),
// and the post-turn ccOutput markdown (the dc-cc-attached-md surface). With
// these present a tester can open the session and confirm the ☐ / ✓ rows
// render once and stay put. chat_sessions / chat_session_specs are
// staging:private (schema-only in clones), so without this the session is
// unreachable in a preview. Idempotent on the fixture branch; strict no-op
// in production. Live-streaming flicker itself can't be reproduced from
// seed data alone — start a real turn here to watch it.
async function seedStagingDemoProposal(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging demo-proposal fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging demo-proposal fixture skipped: no users');
    return;
  }
  const owner = userRows[0];

  const fixtureBranch = 'staging-fixture/demo-proposal';
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (existing.length) return;

  // Spec body with a GFM task list mixing unchecked / checked items, so the
  // spec viewer and the inline preview snippet both render ☐ and ✓ rows.
  const specMd = [
    '# Staging demo proposal',
    '',
    '## User-facing changes',
    '',
    'A small demo widget lands on the home screen so we can exercise the',
    'task-checkbox rendering across every surface.',
    '',
    '### Checklist',
    '',
    '- [ ] Add the widget to the home view',
    '- [x] Wire the route on the server',
    '- [ ] Style the widget to match the theme',
    '- [x] Add a unit test for the helper',
    '- [ ] Document the widget in the README',
    '',
    '## Technical implementation',
    '',
    '- Render the widget client-side; persist its state in `localStorage`.',
    '- [ ] Confirm the ☐ / ✓ rows render once and stay put while streaming.',
  ].join('\n');

  // Preview snippet whose checklist sits right around the ~200-char clip
  // boundary, so the whole-line clip (change #3) is exercised: the leading
  // prose pushes the first task lines toward 200 chars, and later items
  // must be dropped on a line boundary rather than half-included.
  const specPreview = [
    '# Staging demo proposal',
    '',
    'This preview snippet deliberately runs long so its checklist sits near',
    'the 200-character clip boundary, exercising the whole-line clip.',
    '',
    '- [ ] Add the widget to the home view',
    '- [x] Wire the route on the server',
    '- [ ] Style the widget to match the theme',
    '- [x] Add a unit test for the helper',
  ].join('\n');
  const specLines = specMd.split('\n').length;

  // Post-turn ccOutput markdown (the dc-cc-attached-md surface) — its own
  // checklist so the finished-status disclosure renders checkboxes too.
  const ccOutput = [
    '[staging fixture] Added the demo widget:',
    '',
    '- [x] Wired the route on the server',
    '- [x] Added a unit test for the helper',
    '- [ ] Styling + README still to do',
  ].join('\n');

  const { rows: sessionRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_title, pr_summary_md, status, spec_md, created_at)
     VALUES
       ($1, $2, $3, '[staging fixture] Staging demo proposal', $5, 'active', $4,
        NOW() - INTERVAL '45 minutes')
     RETURNING id`,
    [appId, owner.id, fixtureBranch, specMd,
     'In plain terms: this proposal adds a small demo widget to the app so people have one more handy thing to interact with.']
  );
  const sessionId = sessionRows[0].id;

  // Freeze v1 (spec_md stays byte-identical to the latest version), mirroring
  // the real scout flow so the spec viewer opens a numbered version.
  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, built_at)
     VALUES ($1, 1, $2, NOW() - INTERVAL '44 minutes')
     ON CONFLICT (session_id, version) DO NOTHING`,
    [sessionId, specMd]
  );

  const messages = [
    { role: 'user', content: '[staging fixture] Please draft a proposal for a demo widget.', metadata: {}, minutesAgo: 45 },
    { role: 'system', content: `Scout drafted a ${specLines}-line spec from the codebase.`,
      metadata: { specPreview, specLines, specVersion: 1 }, minutesAgo: 44 },
    { role: 'system', content: 'Claude Code finished', metadata: { ccOutput, ccOutcome: 'success', durationMs: 198000 }, minutesAgo: 40 },
  ];

  for (const m of messages) {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5::int * INTERVAL '1 minute'))`,
      [sessionId, m.role, m.content, JSON.stringify(m.metadata), m.minutesAgo]
    );
  }

  log.info('db', 'Staging demo-proposal fixture seeded', {
    appId,
    owner: owner.username,
    sessionId,
  });
}

// (#86) Staging fixtures for the private "Share to user" spec flow.
// chat_sessions, chat_session_specs, chat_session_spec_user_shares and
// notifications are all staging:private (schema-only in clones), so
// without seeding the recipient-side path — the 'spec_shared' drawer
// row and its click-through into the read-only spec panel — would be
// unreachable in a staging preview. Must run AFTER
// seedStagingSpecViewerSessions (shares the admin-first "staging login
// user" convention with seedStagingNotifications).
//
// The fixture session is owned by the SECOND user (when one exists) so
// the recipient genuinely exercises the share-widened read gate rather
// than the owner fast-path. Idempotent: session keyed off its fixture
// branch, the share row off its UNIQUE constraint + ON CONFLICT, the
// notification off an existence check.
async function seedStagingSpecUserShareFixtures(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging spec-user-share fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 2`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging spec-user-share fixtures skipped: no users');
    return;
  }
  const recipient = userRows.find((u) => u.is_admin) || userRows[0];
  const sharer = userRows.find((u) => u.id !== recipient.id) || recipient;

  const specContent = [
    '# Staging demo spec: privately shared',
    '',
    'This spec was shared privately with you via the "Share to user"',
    'button — nobody else can see it, and nothing was posted to the',
    'group chat.',
    '',
    '## User-facing changes',
    '',
    '- A "Share to user" button appears in the dev-session spec viewer.',
    '- The recipient gets a notification that opens this read-only panel.',
    '',
    '## Technical implementation',
    '',
    '- chat_session_spec_user_shares rows gate the private read access.',
  ].join('\n');

  const fixtureBranch = 'staging-fixture/spec-user-share';
  let sessionId;
  const { rows: sessionRows } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, fixtureBranch]
  );
  if (sessionRows.length) {
    sessionId = sessionRows[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_title, status, spec_md, created_at)
       VALUES ($1, $2, $3, '[staging fixture] Privately shared spec session', 'active',
               $4, NOW() - INTERVAL '45 minutes')
       RETURNING id`,
      [appId, sharer.id, fixtureBranch, specContent]
    );
    sessionId = rows[0].id;
  }

  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, built_at)
     VALUES ($1, 1, $2, NOW() - INTERVAL '44 minutes')
     ON CONFLICT (session_id, version) DO NOTHING`,
    [sessionId, specContent]
  );

  await pool.query(
    `INSERT INTO chat_session_spec_user_shares (session_id, version, recipient_id, shared_by)
     VALUES ($1, 1, $2, $3)
     ON CONFLICT (session_id, version, recipient_id) DO NOTHING`,
    [sessionId, recipient.id, sharer.id]
  );

  const { rows: existingNotif } = await pool.query(
    `SELECT id FROM notifications
      WHERE user_id = $1 AND app_id = $2 AND kind = 'spec_shared'
        AND session_id = $3
      LIMIT 1`,
    [recipient.id, appId, sessionId]
  );
  if (!existingNotif.length) {
    await pool.query(
      `INSERT INTO notifications
         (user_id, app_id, session_id, source_user_id, kind, detail, created_at)
       VALUES ($1, $2, $3, $4, 'spec_shared', '1', NOW() - INTERVAL '40 minutes')`,
      [recipient.id, appId, sessionId, sharer.id]
    );
  }

  log.info('db', 'Staging spec-user-share fixtures seeded', {
    appId,
    sessionId,
    recipient: recipient.username,
    sharer: sharer.username,
  });
}

// Staging fixtures for the issue panel's headless proposal-run states
// (#228 rename verification). The /github-issues route serves mock issues
// 900001–900005 in staging (stagingMockIssues, routes/issues.js), but the
// per-issue `headless` field comes from chat_sessions rows that never
// exist in a staging clone — so the "Generating proposal…" / retry /
// notification states would be unreachable by clicking around. Seed one
// headless session per state, keyed to the mock issue numbers, plus the
// two auto_solve_done notifications (notifications is staging:private,
// copied schema-only).
//
// user_id is deliberately NULL on every fixture session: boot-time
// resumeHeadlessRuns INNER JOINs users, so NULL keeps the 'generating'
// fixture from being "resumed" (which would hit GitHub for a mock issue
// number and fail the run); the issue panel and notification queries both
// LEFT JOIN and degrade gracefully. headless_step is set on the
// 'generating' row so failOrphanedHeadlessRuns (which sweeps step-less
// generating rows) leaves it alone. Idempotent: sessions keyed off their
// fixture branch name, notifications off (user, app, kind, session).
async function seedStagingHeadlessFixtures(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging headless fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: userRows } = await pool.query(
    `SELECT id, username, is_admin
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 1`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging headless fixtures skipped: no users');
    return;
  }
  const target = userRows[0];

  // Issue numbers match stagingMockIssues; 900001 is left without a run so
  // the idle "Generate proposal" button stays reachable on its row.
  const fixtures = [
    { branch: 'staging-fixture/headless-generating', status: 'generating', outcome: null, issue: 900002, step: 'planning' },
    { branch: 'staging-fixture/headless-question', status: 'ready', outcome: 'question', issue: 900003, step: null },
    { branch: 'staging-fixture/headless-spec', status: 'ready', outcome: 'spec', issue: 900004, step: null },
    { branch: 'staging-fixture/headless-failed', status: 'failed', outcome: null, issue: 900005, step: null },
  ];

  const sessionIds = {};
  let inserted = 0;
  for (const f of fixtures) {
    const { rows: existing } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, f.branch]
    );
    if (existing.length) {
      sessionIds[f.branch] = existing[0].id;
      continue;
    }
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, status, is_headless,
          headless_status, headless_outcome, headless_issue_number,
          headless_step, created_at)
       VALUES ($1, NULL, $2, 'active', TRUE, $3, $4, $5, $6,
               NOW() - INTERVAL '30 minutes')
       RETURNING id`,
      [appId, f.branch, f.status, f.outcome, f.issue, f.step]
    );
    sessionIds[f.branch] = rows[0].id;
    inserted++;
  }

  // Viewer-owned clone of the ready/spec headless session for issue 900004,
  // so the issues route resolves mySessionId for the tester (the target
  // admin) and that row renders "Go to session" + the violet
  // issueProposalMine chip. Owned by `target` (the user the tester logs in
  // as) and cloned_from the headless-spec session; non-headless, 'active'
  // (the myCloneByHeadlessId lookup excludes 'archived'). The other ready
  // issues stay clone-less so a reviewer sees the sky-vs-violet contrast.
  const specHeadlessId = sessionIds['staging-fixture/headless-spec'];
  let cloneInserted = 0;
  if (specHeadlessId) {
    const cloneBranch = 'staging-fixture/headless-spec-myclone';
    const { rows: existingClone } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, cloneBranch]
    );
    if (!existingClone.length) {
      await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, status, is_headless,
            cloned_from_session_id, created_at)
         VALUES ($1, $2, $3, 'active', FALSE, $4,
                 NOW() - INTERVAL '20 minutes')`,
        [appId, target.id, cloneBranch, specHeadlessId]
      );
      cloneInserted++;
    }
  }

  // Unread completion notifications for the renamed drawer rows / toast /
  // tab-title markers: one ready-with-spec, one failed.
  const notifFixtures = [
    { branch: 'staging-fixture/headless-spec', detail: 'spec', minutesAgo: 4 },
    { branch: 'staging-fixture/headless-failed', detail: 'failed', minutesAgo: 3 },
  ];
  let notifInserted = 0;
  for (const f of notifFixtures) {
    const sessionId = sessionIds[f.branch];
    if (!sessionId) continue;
    const { rows: existing } = await pool.query(
      `SELECT id FROM notifications
        WHERE user_id = $1 AND app_id = $2 AND kind = 'auto_solve_done'
          AND session_id = $3
        LIMIT 1`,
      [target.id, appId, sessionId]
    );
    if (existing.length) continue;
    await pool.query(
      `INSERT INTO notifications
         (user_id, app_id, session_id, source_user_id, kind, detail,
          read_at, created_at)
       VALUES ($1, $2, $3, NULL, 'auto_solve_done', $4, NULL,
               NOW() - ($5::int * INTERVAL '1 minute'))`,
      [target.id, appId, sessionId, f.detail, f.minutesAgo]
    );
    notifInserted++;
  }

  log.info('db', 'Staging headless proposal fixtures seeded', {
    appId,
    targetUser: target.username,
    sessionsInserted: inserted,
    clonesInserted: cloneInserted,
    notificationsInserted: notifInserted,
  });
}

// Fixture for the "PR proposal I created" violet chip (proposalMine). The
// notifications fixture above seeds a promoted PR, but owns it to the
// `source` user, so it never shows "Open session" for the tester. This
// seeds one open/awaiting-votes (status 'promoted') PR owned by the
// `target` user — the admin the tester logs in as — so pr.user_id ===
// App.user.id holds, rendering the violet proposalMine chip + the "Open
// session" button. A couple of pr_votes give the tally pill a realistic
// fill, matching the merged-PR fixture pattern. chat_sessions is
// staging:private (schema-only in staging), so this is the only way the
// state is reachable; gated on staging + idempotent by branch name.
async function seedStagingMyOpenPr(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging my-open-PR fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 3`
  );
  if (!users.length) {
    log.warn('db', 'Staging my-open-PR fixture skipped: no users');
    return;
  }
  const target = users[0];

  const branch = 'staging-fixture/my-open-pr';
  let sessionId;
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) {
    sessionId = existing[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
          votes_required, created_at)
       VALUES
         ($1, $2, $3, 9200, '[staging fixture] My open PR — awaiting votes',
          $5, 'promoted', $4, NOW() - INTERVAL '15 minutes')
       RETURNING id`,
      [appId, target.id, branch, Math.max(1, Math.ceil(users.length / 2)),
       'In plain terms: this proposed change makes the app a little nicer to use. Open it to read the details and cast your vote.']
    );
    sessionId = rows[0].id;
  }

  // A yes-vote or two so the tally pill renders a realistic fill. The
  // author's own vote plus a second user when one exists.
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
     VALUES ($1, $2, 'yes', NOW() - INTERVAL '14 minutes')
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [sessionId, target.id]
  );
  if (users.length > 1) {
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
       VALUES ($1, $2, 'yes', NOW() - INTERVAL '13 minutes')
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sessionId, users[1].id]
    );
  }

  // #361: give the main fixture a real "Conflicts · 2 files" badge so the
  // card + detail block render in staging (idempotent UPDATE on re-runs).
  await pool.query(
    `UPDATE chat_sessions
        SET merge_conflict_state = 'conflict',
            conflict_files = '["src/app.js","public/index.html"]'::jsonb,
            conflict_checked_at = NOW()
      WHERE id = $1`,
    [sessionId]
  );

  // #361: two sibling promoted fixtures so all the new badge states show
  // at once — a red "Conflict resolution failed" card and an amber
  // "Behind main · 2" card. Idempotent via branch-name lookup.
  const siblings = [
    {
      branch: 'staging-fixture/conflict-failed',
      pr: 9201,
      title: '[staging fixture] Conflict resolution failed',
      state: 'failed',
      files: '["src/server.js"]',
      behind: 1,
    },
    {
      branch: 'staging-fixture/behind-main',
      pr: 9202,
      title: '[staging fixture] Behind main — still mergeable',
      state: 'behind',
      files: '[]',
      behind: 2,
    },
  ];
  for (const s of siblings) {
    const { rows: have } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
      [appId, s.branch]
    );
    let sibId = have[0]?.id;
    if (!sibId) {
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
            votes_required, behind_main, merge_conflict_state, conflict_files,
            conflict_checked_at, created_at)
         VALUES
           ($1, $2, $3, $4, $5,
            'In plain terms: a demo proposal showing the new merge-status badge.',
            'promoted', $6, $7, $8, $9::jsonb, NOW(), NOW() - INTERVAL '20 minutes')
         RETURNING id`,
        [appId, target.id, s.branch, s.pr, s.title,
         Math.max(1, Math.ceil(users.length / 2)), s.behind, s.state, s.files]
      );
      sibId = rows[0].id;
    } else {
      await pool.query(
        `UPDATE chat_sessions
            SET behind_main = $2, merge_conflict_state = $3,
                conflict_files = $4::jsonb, conflict_checked_at = NOW()
          WHERE id = $1`,
        [sibId, s.behind, s.state, s.files]
      );
    }
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
       VALUES ($1, $2, 'yes', NOW() - INTERVAL '18 minutes')
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sibId, target.id]
    );
  }

  log.info('db', 'Staging my-open-PR fixture seeded', {
    appId,
    targetUser: target.username,
    sessionId,
  });
}

// #297: seed a short "Ask AI" advisor conversation on the staging
// my-open-PR fixture so a tester on a prod-cloned staging DB (where
// proposal_ai_messages ships empty — it's staging:private) sees a
// populated panel without needing a live LLM. Idempotent: fixed high IDs
// + ON CONFLICT DO NOTHING. Owned by the same demo author the fixture PR
// belongs to, pointed at that PR session (proposal_kind='pr').
async function seedStagingProposalDiscussion(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) return;

  // Anchor on the open-PR fixture seeded just above (same branch name).
  const { rows: sessRows } = await pool.query(
    `SELECT id, user_id FROM chat_sessions
      WHERE app_id = $1 AND branch_name = $2 LIMIT 1`,
    [appId, 'staging-fixture/my-open-pr']
  );
  if (!sessRows.length) {
    log.warn('db', 'Staging proposal-discuss fixture skipped: open-PR fixture missing');
    return;
  }
  const proposalRef = sessRows[0].id;
  const userId = sessRows[0].user_id;

  // 4 alternating turns — a tiny multi-turn Q&A so the panel shows the
  // back-and-forth feel. Fixed high IDs keep the seed idempotent.
  const turns = [
    [990001, 'user', 'Staging demo: explain this proposal in plain terms.'],
    [990002, 'assistant', 'Staging demo: This proposal adds a small, self-contained change to the app. In plain terms, it introduces a new feature without touching the existing data model, so it should be low-risk to merge. (This is seeded demo content — no live AI ran.)'],
    [990003, 'user', 'Staging demo: what could break, and should I vote yes?'],
    [990004, 'assistant', 'Staging demo: The main thing to watch is the new UI surface, but it degrades gracefully and is private per-user, so the blast radius is small. If it matches the linked issue, voting yes is reasonable. Remember I can only advise here — to actually build something, use "Propose a change" in your own dev chat.'],
  ];

  for (const [id, role, content] of turns) {
    await pool.query(
      `INSERT INTO proposal_ai_messages (id, app_id, proposal_kind, proposal_ref, user_id, role, content, model)
       VALUES ($1, $2, 'pr', $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [id, appId, proposalRef, userId, role, content, role === 'assistant' ? 'claude-sonnet-4-6' : null]
    );
  }

  log.info('db', 'Staging proposal-discuss fixture seeded', { appId, proposalRef, userId });
}

// #363: the topic sub-view (issue / PR proposal / governance proposal) now
// scrolls as ONE region — the topic card/body and the discussion share a
// single scroller, with only the back bar and composer pinned. That unified
// scroll is only visible when a topic carries enough content to overflow one
// screen, so seed a long human discussion thread for one topic of EACH kind:
//
//   - a GitHub issue   → thread_type 'issue',      ref = mock issue #900001
//   - a PR proposal    → thread_type 'session',    ref = the open-PR fixture
//   - a governance prop → thread_type 'governance', ref = the env-var fixture
//
// Idempotent: each row is keyed on (app_id, thread_type, thread_ref, content)
// and skipped if already present (chat_messages.id is SERIAL, so we don't pin
// ids). Strictly a no-op outside staging. Anchors are the fixtures seeded
// earlier in this run; any missing anchor is skipped with a warning.
async function seedStagingTopicScrollThreads(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging topic-scroll threads skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  // A few authors so the thread reads like a real back-and-forth. Falls back
  // to a single author when staging has only one user.
  const { rows: userRows } = await pool.query(
    `SELECT id FROM users ORDER BY is_admin DESC, id ASC LIMIT 3`
  );
  if (!userRows.length) {
    log.warn('db', 'Staging topic-scroll threads skipped: no users');
    return;
  }
  const authorIds = userRows.map((u) => u.id);

  // Resolve the PR-proposal anchor (the open-PR fixture session).
  const { rows: sessRows } = await pool.query(
    `SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1`,
    [appId, 'staging-fixture/my-open-pr']
  );
  const sessionRef = sessRows[0]?.id || null;

  // Resolve the governance anchor (the env-var change proposal fixture).
  const { rows: govRows } = await pool.query(
    `SELECT id FROM issues WHERE app_id = $1 AND title = $2 LIMIT 1`,
    [appId, 'Set secret "STAGING_DEMO_KEY"']
  );
  const govRef = govRows[0]?.id || null;

  // The GitHub-issue anchor: mock issue #900001, always served in staging by
  // the mock-issues fallback in routes/issues.js. Thread ref = issue number.
  const issueRef = 900001;

  // 18 human turns — long enough that header + messages overflow one screen
  // and the single scroller is genuinely exercised on every preview.
  const bodies = [
    'Kicking off the discussion here — does the proposed direction match what we agreed in the last round?',
    'I think it does, but I want to double-check the edge cases before we commit.',
    'Good point. The main risk I see is the narrow-phone layout — has anyone tried it at 360px?',
    'Tried it on my end; the action row wraps cleanly now, no overflow past the card edge.',
    'Nice. What about dark mode — does the contrast still pass on the muted text?',
    'Contrast is fine in dark mode. Light mode the secondary text is a touch low but acceptable.',
    'Can we keep the change scoped? I’d rather not expand into a full redesign in one pass.',
    'Agreed, let’s keep it tight. Follow-ups can be their own proposals.',
    'One more thing: how does this behave when the body is really long?',
    'That’s exactly the case we’re testing — the whole thing should scroll as one continuous area.',
    'So the header and the conversation move together, and only the reply box stays put?',
    'Right, only the back bar at the top and the composer at the bottom are pinned.',
    'That matches the main group chat, which is what people kept asking for.',
    'Reading from the top down feels much more natural than two boxes fighting for space.',
    'Did the vote roster and the Ask-AI button survive the move into the scroll area?',
    'They did — still interactive, they just scroll up with the rest of the header now.',
    'Great. I’m comfortable voting this through once the preview looks right.',
    'Same here. Scroll all the way down to confirm the composer never gets pushed off-screen.',
  ];

  const seedThread = async (threadType, threadRef, label) => {
    if (!threadRef) {
      log.warn('db', 'Staging topic-scroll thread skipped: missing anchor', { threadType });
      return 0;
    }
    let inserted = 0;
    for (let i = 0; i < bodies.length; i++) {
      // Prefix makes each row's content unique per thread, which doubles as
      // the idempotency key and an obviously-fake "Staging demo" marker.
      const content = `[Staging demo] ${label} #${i + 1}: ${bodies[i]}`;
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM chat_messages
          WHERE app_id = $1 AND thread_type = $2 AND thread_ref = $3 AND content = $4
          LIMIT 1`,
        [appId, threadType, threadRef, content]
      );
      if (existing.length) continue;
      const minutesAgo = (bodies.length - i) * 4; // oldest first, newest last
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
         VALUES ($1, $2, $3, 'message', $4, $5, NOW() - ($6::int * INTERVAL '1 minute'))`,
        [appId, authorIds[i % authorIds.length], content, threadType, threadRef, minutesAgo]
      );
      inserted++;
    }
    return inserted;
  };

  const n1 = await seedThread('issue', issueRef, 'issue thread');
  const n2 = await seedThread('session', sessionRef, 'proposal thread');
  const n3 = await seedThread('governance', govRef, 'governance thread');

  log.info('db', 'Staging topic-scroll threads seeded', {
    appId, issueRef, sessionRef, govRef, inserted: n1 + n2 + n3,
  });
}

// #313/#321: a PROMOTED proposal owned by a user OTHER than the tester, so
// the card-level "Ask AI" pill (rendered only on proposals you do NOT own)
// is exercisable in staging. seedStagingMyOpenPr covers the owned case;
// this covers the non-owned case both issues are about. #321 reuses this
// same fixture: opening this proposal FULL-SCREEN is how a tester confirms
// the duplicate standalone "Ask AI" button is gone and only the pill-row
// control remains. Also seeds a short advisor history keyed to the TESTER's
// user_id (proposal_ai_messages is staging:private, so it ships empty) so
// opening the panel from the foreign card shows a back-and-forth rather
// than the empty state. Idempotent via branch name + fixed high message
// IDs; a no-op outside staging.
async function seedStagingOtherUserProposal(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging other-user-proposal fixture skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 5`
  );
  if (!users.length) {
    log.warn('db', 'Staging other-user-proposal fixture skipped: no users');
    return;
  }
  // The tester logs in as the first admin (same selection as the other
  // fixtures). The proposal must be owned by SOMEONE ELSE so the card has
  // no "Open session" button and the new Ask AI button renders.
  const tester = users[0];
  const owner = users.find((u) => u.id !== tester.id);
  if (!owner) {
    log.warn('db', 'Staging other-user-proposal fixture skipped: need a second user');
    return;
  }

  const branch = 'staging-fixture/other-user-open-pr';
  let sessionId;
  const { rows: existing } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, branch]
  );
  if (existing.length) {
    sessionId = existing[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, pr_summary_md, status,
          votes_required, created_at)
       VALUES
         ($1, $2, $3, 9300,
          '[staging fixture] Another user''s proposal — Ask AI about it',
          $5, 'promoted', $4, NOW() - INTERVAL '20 minutes')
       RETURNING id`,
      [appId, owner.id, branch, Math.max(1, Math.ceil(users.length / 2)),
       'In plain terms: another collaborator proposed a small improvement to the app. This summary explains what it does for users before you vote.']
    );
    sessionId = rows[0].id;
  }

  // The owner's own yes-vote so the tally pill renders a realistic fill.
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
     VALUES ($1, $2, 'yes', NOW() - INTERVAL '19 minutes')
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [sessionId, owner.id]
  );

  // Advisor history keyed to the TESTER (the per-user, private
  // conversation they'd see), pointed at this PR session.
  const turns = [
    [990101, 'user', 'Staging demo: explain this proposal in plain terms.'],
    [990102, 'assistant', 'Staging demo: This is another user\'s proposal, opened for the group to review and vote on. You can ask me anything about it here — privately. I can only advise; I can\'t vote or change the proposal. (Seeded demo content — no live AI ran.)'],
    [990103, 'user', 'Staging demo: what should I watch for before voting yes?'],
    [990104, 'assistant', 'Staging demo: Check that the change matches any linked issue, that its blast radius is small, and that it degrades gracefully. If all that holds, voting yes is reasonable. Remember this advisor is read-only.'],
  ];
  for (const [id, role, content] of turns) {
    await pool.query(
      `INSERT INTO proposal_ai_messages (id, app_id, proposal_kind, proposal_ref, user_id, role, content, model)
       VALUES ($1, $2, 'pr', $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [id, appId, sessionId, tester.id, role, content, role === 'assistant' ? 'claude-sonnet-4-6' : null]
    );
  }

  log.info('db', 'Staging other-user-proposal fixture seeded', {
    appId, ownerUser: owner.username, testerUser: tester.username, sessionId,
  });
}

// Archive-restore fixtures (#287-style regression): seed the two states
// that exercise the restored Archive action but are hard to reach by
// clicking around in a fresh staging container.
//
//  1. A viewer-owned PROMOTED session with NO warm worker. Because it's
//     never registered in worker.warmRegistrySnapshot(), GET
//     /api/apps/:slug/sessions reports `warm: false`, exactly the
//     cold-promoted case that used to lose its Archive button in the
//     dev-chat session list — and the same proposer-owned promoted state
//     the proposal card now shows an Archive button for on the Dev feed.
//  2. A viewer-owned ARCHIVED session so the Unarchive control and the
//     archived-inline listing are visible without first archiving one.
//
// Owned by the user the tester logs in as (first admin, same selection
// as the other session fixtures) so both appear in that user's own
// owner-scoped sessions list. chat_sessions is staging:private (copied
// schema-only into staging), hence the seed. Idempotent via the
// branch-name existence check; strictly a no-op outside staging.
async function seedStagingArchiveProposalFixtures(pool, config) {
  if (process.env.USERNODE_ENV !== 'staging') return;

  const { rows: appRows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1',
    [config.selfAppSlug]
  );
  const appId = appRows[0]?.id;
  if (!appId) {
    log.warn('db', 'Staging archive-proposal fixtures skipped: self-app row missing', {
      slug: config.selfAppSlug,
    });
    return;
  }

  const { rows: users } = await pool.query(
    `SELECT id, username
       FROM users
      ORDER BY is_admin DESC, id ASC
      LIMIT 3`
  );
  if (!users.length) {
    log.warn('db', 'Staging archive-proposal fixtures skipped: no users');
    return;
  }
  const owner = users[0];
  const votesRequired = Math.max(1, Math.ceil(users.length / 2));

  // Cold promoted proposal — PR up for vote, worker spun down.
  const coldBranch = 'staging-fixture/archive-cold-promoted';
  const { rows: coldExisting } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, coldBranch]
  );
  let coldSessionId = coldExisting[0]?.id;
  if (!coldSessionId) {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, pr_url, status,
          votes_required, created_at, promoted_at)
       VALUES
         ($1, $2, $3, 9300,
          '[Mock] Cold promoted proposal — worker spun down, still archivable',
          'https://github.com/usernode-staging/demo/pull/9300',
          'promoted', $4,
          NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')
       RETURNING id`,
      [appId, owner.id, coldBranch, votesRequired]
    );
    coldSessionId = rows[0].id;
  }
  // The author's own yes-vote so the tally pill renders a realistic fill.
  await pool.query(
    `INSERT INTO pr_votes (session_id, user_id, vote, created_at)
     VALUES ($1, $2, 'yes', NOW() - INTERVAL '3 days')
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [coldSessionId, owner.id]
  );

  // Already-archived session — shows the Unarchive control + archived
  // row in the inline session list.
  const archivedBranch = 'staging-fixture/archive-already-archived';
  const { rows: archivedExisting } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, archivedBranch]
  );
  if (!archivedExisting.length) {
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_title, status,
          created_at, promoted_at, archived_at)
       VALUES
         ($1, $2, $3, 9301,
          '[Mock] Archived proposal — restorable via Unarchive',
          'archived',
          NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days',
          NOW() - INTERVAL '1 day')`,
      [appId, owner.id, archivedBranch]
    );
  }

  // Active, non-promoted session — surfaces as a chip in the viewer's
  // "Your dev session" strip with the new inline Archive button. No
  // promoted_at so it stays a live in-progress session (not a proposal
  // card). /api/me/active-sessions (status IN active/promoted/paused)
  // returns it and the strip filters to active/paused for this app.
  const activeBranch = 'staging-fixture/archive-active';
  const { rows: activeExisting } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, activeBranch]
  );
  if (!activeExisting.length) {
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_title, status, created_at)
       VALUES
         ($1, $2, $3, '[Mock] Active session — archivable from the strip',
          'active', NOW() - INTERVAL '2 hours')`,
      [appId, owner.id, activeBranch]
    );
  }

  // Paused, non-promoted session — exercises the paused-row variant of
  // the strip chip (status tag + Archive button).
  const pausedBranch = 'staging-fixture/archive-paused';
  const { rows: pausedExisting } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [appId, pausedBranch]
  );
  if (!pausedExisting.length) {
    await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_title, status, created_at)
       VALUES
         ($1, $2, $3, '[Mock] Paused session — archivable from the strip',
          'paused', NOW() - INTERVAL '1 day')`,
      [appId, owner.id, pausedBranch]
    );
  }

  log.info('db', 'Staging archive-proposal fixtures seeded', {
    appId,
    owner: owner.username,
    coldSessionId,
  });
}

// Per-app postgres role migration. Pre-migration model: every per-app
// database (`app_<slug>`) is owned by the shared `usernode` superuser
// and accessed via DATABASE_URL embedding the superuser password.
// Compromise of any one app's URL grants access to every DB in the
// cluster. Post-migration model: each DB has a dedicated role
// `<dbName>_owner` with a unique random password persisted in
// apps.db_password (staging:private). Compromise of one app's URL
// only authorizes access to that one DB.
//
// This runs on every platform boot, idempotent in two modes:
//   - Adopt (db_password IS NULL): create role, ALTER DATABASE OWNER,
//     REASSIGN OWNED, REVOKE PUBLIC, persist password. After this
//     succeeds, the running app container's URL is stale (still
//     superuser); we restart it via app-respawn so it picks up the
//     new credential immediately.
//   - Verify (db_password IS NOT NULL): confirm the role exists with
//     the stored password. If it was dropped (manual postgres
//     intervention, partial backup restore, etc.), recreate it.
//
// Skipped for self_hosted apps: the platform's own DB is owned by
// the `usernode` superuser intentionally — db-manager needs that
// superuser to spawn child app DBs and create roles.
//
// Failure for any one app is logged but does NOT abort boot; other
// apps continue to migrate. A failed adoption leaves the app in the
// pre-migration state (still working with the shared superuser URL)
// and will be retried on next boot.
async function migrateAppDbsToPerRole(pool, config) {
  log.info('db', 'Running per-app role migration');

  const { rows } = await pool.query(
    `SELECT id, slug, container_id, manifest_snapshot, db_password, status, self_hosted
       FROM apps
       WHERE COALESCE(self_hosted, FALSE) = FALSE
         AND status NOT IN ('deleted', 'creating', 'awaiting_secrets')`
  );

  if (rows.length === 0) {
    log.info('db', 'No apps to migrate to per-role model');
    return;
  }

  const respawnQueue = [];
  let adopted = 0, verified = 0, recreated = 0, skipped = 0, failed = 0;

  for (const app of rows) {
    const dbName = dbManager.appDbName(app.slug);

    try {
      if (!app.db_password) {
        // First-time adoption. Verify the DB actually exists before
        // trying to ALTER it — apps in transient states (failed
        // create, errored mid-deploy) might be in apps without a
        // matching postgres database yet.
        const exists = await dbManager.databaseExists(dbName);
        if (!exists) {
          log.info('db', 'Skipping per-role migration; app DB does not exist yet', {
            slug: app.slug, dbName, status: app.status,
          });
          skipped += 1;
          continue;
        }
        const { password } = await dbManager.adoptExistingDatabase(dbName);
        await pool.query(
          'UPDATE apps SET db_password = $1 WHERE id = $2',
          [password, app.id]
        );
        // Mutate in place so the respawn loop sees the new password.
        app.db_password = password;
        adopted += 1;
        if (app.status === 'running' && app.container_id) {
          respawnQueue.push(app);
        }
      } else {
        // Verify role still exists; recreate with stored password if not.
        const role = dbManager.ownerRoleName(dbName);
        const exists = await dbManager.roleExists(role);
        if (!exists) {
          await dbManager.ensureRoleExists(dbName, app.db_password);
          recreated += 1;
        } else {
          verified += 1;
        }
      }
    } catch (err) {
      log.error('db', 'Per-role migration failed for app', {
        slug: app.slug, dbName, err: err.message,
      });
      failed += 1;
    }
  }

  log.info('db', 'Per-app role migration scan complete', {
    adopted, verified, recreated, skipped, failed,
    toRespawn: respawnQueue.length,
  });

  // Restart freshly-adopted apps so they pick up the per-role URL.
  // Sequential rather than parallel: each restart briefly stops a
  // child app, and we don't want a thundering herd of new container
  // boots all hitting Docker at once on a small VPS.
  if (respawnQueue.length > 0) {
    log.info('db', 'Respawning freshly-adopted app containers', {
      count: respawnQueue.length, apps: respawnQueue.map((a) => a.slug),
    });
    const { respawnAppContainer } = require('../services/app-respawn');
    for (const app of respawnQueue) {
      try {
        await respawnAppContainer(config, app);
      } catch (err) {
        log.error('db', 'App respawn failed during per-role migration', {
          slug: app.slug, err: err.message,
        });
      }
    }
  }
}

module.exports = { migrate };
