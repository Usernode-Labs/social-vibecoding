const fs = require('fs');
const path = require('path');
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
  await seedSelfApp(pool, config);
  await seedStagingNotifications(pool, config);
  await seedStagingEnvProposal(pool, config);
  await seedStagingMergedPrs(pool, config);
  await seedStagingActiveSessions(pool, config);
  await seedStagingLeaderboardProfile(pool);
  await seedStagingQaSession(pool, config);
  await seedStagingHeadlessFixtures(pool, config);
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

  log.info('db', 'Staging notification fixtures seeded', {
    targetUser: target.username,
    inserted,
    multiAppInserted,
    otherApps: otherApps.length,
  });
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
           (app_id, user_id, branch_name, pr_number, pr_title, status,
            votes_required, active_users_at_merge, created_at)
         VALUES
           ($1, $2, $3, $4, $5, 'merged', $6, $7,
            NOW() - ($8::int * INTERVAL '1 hour'))
         RETURNING id`,
        [appId, author.id, branch, 9100 + i, `[staging fixture] ${f.title}`,
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
    notificationsInserted: notifInserted,
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
