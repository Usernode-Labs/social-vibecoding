-- Users & auth
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        VARCHAR(255) UNIQUE NOT NULL,
  password        VARCHAR(255) NOT NULL,
  is_admin        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- #30: optional user-provided Anthropic API key. `anthropic_key_enc`
-- holds the encrypted payload (v1:<iv>:<tag>:<ct>, base64). We also
-- keep the last 4 chars unencrypted purely so the UI can show
-- "sk-ant-…abcd" without a decrypt round-trip.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anthropic_key_enc    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS anthropic_key_last4  VARCHAR(8);

-- Per-user app-creation permission, toggled by admins from /admin.
-- Default FALSE; existing admins are backfilled to TRUE on boot.
-- Enforced server-side on POST /api/apps in src/routes/apps.js;
-- the home-screen "Create new app" affordance is hidden client-side
-- for users who fail the check (see Home.canCreate in public/js/home.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_create_apps BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET can_create_apps = TRUE WHERE is_admin = TRUE AND can_create_apps = FALSE;

-- Per-user app-creation quota: the maximum number of live (non-errored)
-- apps a user may have created. This is the actual app-creation gate (see
-- src/routes/apps.js) — a non-admin may create iff their live app count is
-- below this number, so deleting an app frees a slot (mirrors the server-
-- wide maxApps cap). Default 0 means "cannot create until an admin raises
-- it", matching the old can_create_apps default-off behaviour. Admins
-- bypass enforcement entirely — their quota is purely cosmetic. The client
-- still sees a derived `canCreateApps` boolean (computed in auth/me as
-- isAdmin || liveCount < app_quota) so the home screen needs no change; the
-- numeric quota is surfaced only through the admin API. `can_create_apps`
-- is KEPT for now purely as the one-shot backfill source below — dropping
-- it (and the derived canCreateApps plumbing) is deferred work.
ALTER TABLE users ADD COLUMN IF NOT EXISTS app_quota INTEGER NOT NULL DEFAULT 0;

-- is_admin is now mutable from the admin panel (grant/revoke toggle in
-- public/admin.html → POST /api/admin/users/:id/is-admin). The column is
-- nullable (DEFAULT FALSE, declared at the top of the table) so legacy
-- rows could hold NULL; normalize to FALSE so the last-admin guard's
-- `COUNT(*) WHERE is_admin = TRUE` and every `is_admin = TRUE` read treat
-- NULL and FALSE identically. Idempotent — safe to run every boot.
UPDATE users SET is_admin = FALSE WHERE is_admin IS NULL;

-- View-only admin role (issue #311). `is_admin` remains the visibility
-- tier ("can see every admin surface"); `admin_readonly` marks an admin
-- whose access is read-only — they see everything a full admin sees but
-- cannot perform any mutating/privileged action. The canonical role is
-- derived, no enum needed:
--   is_admin = FALSE                          → normal user (this column ignored)
--   is_admin = TRUE  AND admin_readonly = FALSE → full admin
--   is_admin = TRUE  AND admin_readonly = TRUE  → view-only admin
-- Auth derives `canAdminWrite = is_admin AND NOT admin_readonly` (the single
-- write gate) in src/middleware/auth.js; every read/visibility gate keeps
-- keying off is_admin unchanged. Backfill is automatic — existing admin rows
-- default to FALSE (stay full admins). NOT tagged staging:private below
-- (non-sensitive, like is_admin) so staging shows correct roles. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_readonly BOOLEAN NOT NULL DEFAULT FALSE;

-- Usernode wallet linking: pubkey is the on-chain identity once linked;
-- token + expiry gate the QR-based linking flow.
ALTER TABLE users ADD COLUMN IF NOT EXISTS usernode_pubkey          VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_link_token        VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_link_expires_at   TIMESTAMPTZ;

-- Per-user override of the platform-wide daily LLM spend cap. NULL means
-- "use the global default" stored in platform_settings.user_daily_limit_cents
-- (see below). Set by admins from /admin to grant trusted users a higher
-- cap without raising it for everyone. Read by checkBudget() in
-- src/routes/sessions.js via src/services/limits.js.
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_limit_cents INTEGER;

-- Experimental: opt-in AI progress estimate for coding runs. When TRUE,
-- the platform periodically asks Haiku to skim the in-flight Claude Code
-- progress log and emits a vague "AI guess" line in dev-chat (see
-- runClaudeCodeTool in src/routes/sessions.js). Default OFF for everyone
-- while the experiment runs; toggled from Settings → Experimental via
-- POST /api/me/ai-progress-estimate.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_progress_estimate BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS sessions (
  token      VARCHAR(64) PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS activation_codes (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(32) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at    TIMESTAMPTZ
);

-- Apps. `retry_count` tracks how many times creation has been retried
-- after a failure (see src/routes/apps.js retry endpoint).
CREATE TABLE IF NOT EXISTS apps (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  slug           VARCHAR(255) UNIQUE NOT NULL,
  repo_url       VARCHAR(512),
  container_id   VARCHAR(128),
  status         VARCHAR(32) NOT NULL DEFAULT 'creating',
  retry_count    INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
-- #21: surface the currently deployed commit. `main_sha` is the SHA the
-- prod container was built from; `main_pr_number` is the PR that
-- produced it (null for the initial pre-merge build). Backfilled on
-- server boot for apps created before this migration.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_sha VARCHAR(40);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS main_pr_number INTEGER;
-- Surface "when the app was last code-updated" on the home cards
-- alongside created_at. Bumped to NOW() at every successful prod-
-- container rebuild — the four sites in app-creator.js (initial
-- deploy), routes/apps.js (/redeploy), routes/votes.js (vote-merge),
-- and routes/issues.js (secret-change driven rebuild). Backfilled to
-- created_at for existing rows on first boot so the home tile reads
-- "updated <created_at>" instead of "never" for pre-migration apps;
-- the IS NULL guard makes the backfill a one-shot.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS last_deploy_at TIMESTAMPTZ;
UPDATE apps SET last_deploy_at = created_at WHERE last_deploy_at IS NULL;
-- Snapshot of `dapp.json` from the last successful clone (createApp +
-- rebuildProduction both write it). The Secrets UI reads this so it
-- can render the manifest-declared keys without re-cloning, and the
-- deploy block-on-missing-required check uses it as the source of
-- truth for "what does this dapp create".
ALTER TABLE apps ADD COLUMN IF NOT EXISTS manifest_snapshot JSONB;

-- Admin-gated change lock. When TRUE, applying any group-voted change to
-- this app (PR merge in routes/votes.js, rename proposal + secret-change
-- proposal in routes/issues.js) additionally requires at least one admin
-- "yes"/"up" vote on top of the existing active-user majority. Toggled by
-- admins via POST /api/apps/:slug/lock; the home-card lock icon (admin-
-- only) is the canonical UI affordance. Default FALSE so every existing
-- app starts unlocked and behaves exactly as before.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-app postgres role password. Every app's database has a dedicated
-- postgres role `<dbName>_owner` with this random password; the app's
-- container connects with that role's URL instead of the shared
-- superuser. Compromise of one app's DATABASE_URL no longer authorizes
-- access to other apps' DBs in the cluster. NULL means the app
-- predates the per-role migration; src/db/migrate.js's
-- migrateAppDbsToPerRole adopts such DBs at boot and persists the
-- password here. See src/services/db-manager.js for the role-creation
-- and reassignment logic. Tagged `staging:private` so the existing
-- column-scrub mechanism in cloneDatabase blanks it in any clone — a
-- staging container reading this from its cloned `apps` table would
-- get NULL for every row, which is correct (the staging container
-- has no business connecting to other prod app DBs).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS db_password TEXT;

-- Activity tracking (for home screen sort)
CREATE TABLE IF NOT EXISTS app_activity (
  id             SERIAL PRIMARY KEY,
  app_id         INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  seconds_spent  INTEGER NOT NULL DEFAULT 0,
  date           DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(app_id, user_id, date)
);

-- Group chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id         SERIAL PRIMARY KEY,
  app_id     INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content    TEXT NOT NULL,
  msg_type   VARCHAR(32) NOT NULL DEFAULT 'message',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Individual chat sessions (one per branch/PR)
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                   SERIAL PRIMARY KEY,
  app_id               INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  user_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  branch_name          VARCHAR(255),
  pr_number            INTEGER,
  pr_url               VARCHAR(512),
  pr_title             VARCHAR(256),
  staging_container_id VARCHAR(128),
  staging_url          VARCHAR(512),
  -- Lifecycle:
  --   'active'    = open, has (or can lazily spawn) a warm worker container.
  --                 Counts against the per-user 3-session cap.
  --   'promoted'  = PR was merged, but the chat is still alive — same
  --                 properties as 'active' (worker, cap, etc.).
  --   'paused'    = open but worker container has been torn down to free
  --                 the slot. CC volume + branch + PR are all preserved
  --                 so /resume restores it cleanly. Does NOT count against
  --                 the 3-session cap (no warm container).
  --   'archived'  = abandoned: worker container destroyed, CC volume
  --                 destroyed, PR closed. One-way (no /unarchive route).
  status               VARCHAR(32) NOT NULL DEFAULT 'active',
  -- Claude Code session id captured from the `init` stream-json event on the
  -- first turn of this chat. Subsequent turns pass `--resume <id>` to reuse
  -- CC's on-disk conversation memory (stored in a named Docker volume).
  cc_session_id        VARCHAR(64),
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Individual chat session messages (user <-> LLM)
CREATE TABLE IF NOT EXISTS chat_session_messages (
  id           SERIAL PRIMARY KEY,
  session_id   INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role         VARCHAR(20) NOT NULL,
  content      TEXT NOT NULL,
  model        VARCHAR(100),
  token_count  INTEGER DEFAULT 0,
  cost_cents   NUMERIC(10,4) DEFAULT 0,
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Migrations (idempotent)
ALTER TABLE chat_session_messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS cc_session_id VARCHAR(64);
-- LLM-generated PR title shown alongside the PR number across the UI
-- (dev chat, vote panel, status page). Nullable so old rows predate the
-- auto-title feature and just fall back to showing "by <user>".
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS pr_title VARCHAR(256);
-- #8: how many commits the session branch is behind origin/main, as of
-- the most recent worker turn. Updated by run-cc.sh on every turn
-- (MODE=build and MODE=sync) via the BEHIND= field of the
-- __USERNODE_RESULT__ line. Drives the "Sync with main" banner in the
-- dev-chat session view and the merge-time block in votes.tryMerge.
-- Defaults to 0 for fresh rows; existing rows backfill on their next
-- turn (no separate migration backfill — pre-#8 sessions just show no
-- banner until they next run).
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS behind_main INTEGER NOT NULL DEFAULT 0;
-- #361: persisted merge-conflict snapshot so proposal cards can render a
-- rich merge-status badge (clean | behind | conflict | resolving |
-- failed) without a live GitHub call per render. Derived/written by
-- services/sync-main.js (persistConflictState) and
-- services/conflict-resolver.js; `behind` is derived when behind_main>0
-- and the branch still merges cleanly. conflict_files holds the file
-- paths that contained conflict markers on the last detection, and
-- conflict_checked_at is when the snapshot was last computed.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS merge_conflict_state TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS conflict_files JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS conflict_checked_at TIMESTAMPTZ;
-- #11: vote-to-undo a merged PR. When the undo majority is reached we
-- open a `git revert <merge_commit_sha>` PR and insert a new
-- chat_sessions row pointing back here via revert_of_session_id.
-- The new row goes through the regular promoted → merging → merged
-- flow (a second checkpoint instead of single-voter rollback), so
-- this is just bookkeeping for the original.
--   merge_commit_sha is captured from github.mergePR's response in
--   votes.tryMerge so the revert helper has a SHA to revert.
--   revert_of_session_id, when NOT NULL, marks this row as itself a
--   revert PR — the UI hides chat input + the undo button on
--   reverts so we can't vote-to-undo-an-undo from the merged list.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS merge_commit_sha    VARCHAR(40);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS revert_of_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS chat_sessions_revert_of_idx ON chat_sessions(revert_of_session_id);

-- #11/#16: DEPRECATED. Originally held undo votes on merged PRs (a
-- separate majority gate before a revert PR could be opened). As of #16
-- undo is a single direct action — clicking Undo opens a revert PR
-- immediately and the revert's own merge vote is the only checkpoint —
-- so nothing reads or writes this table anymore. Kept (not dropped) to
-- avoid a destructive migration on existing deployments.
CREATE TABLE IF NOT EXISTS pr_undo_votes (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  vote       VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, user_id)
);
CREATE INDEX IF NOT EXISTS pr_undo_votes_session_idx ON pr_undo_votes(session_id);

-- Spec-stage: per-session markdown spec doc + version history.
-- spec_md is the working buffer (written by the Mayor's scout dispatch
-- — user hand-edits via PUT /spec were dropped, and the Mayor's
-- in-process write_spec/edit_spec tools were removed in #111).
-- chat_session_specs holds the immutable numbered versions (v1…vN) that
-- are the single spec surface the dev-chat viewer presents (#69). Rows
-- are inserted automatically by snapshotSessionSpec() on every spec
-- mutation (#27), so spec_md is always byte-identical to the latest
-- version. The manual "Save version" route (POST /api/sessions/:id/specs)
-- was retired in #69 — it only ever re-snapped that same content.
-- Old sessions also have rows from the now-removed /build-spec route —
-- those carry commit_sha and pr_number; auto-snapshotted rows leave both
-- NULL and the UI degrades gracefully (no PR link rendered).
-- shared_to_group_at is set when the user posts a version into the
-- app's group chat.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS spec_md TEXT NOT NULL DEFAULT '';

-- Session auto-pause: persisted "last interacted with" timestamp. Bumped
-- on every chat turn, on session open/view, and on resume. The DB-driven
-- auto-pause sweeper (server.js) flips long-idle 'active' sessions to
-- 'paused' so they stop counting against the per-user / global session
-- caps; the in-memory worker idle-eviction (which only reclaims the
-- container) is a separate, shorter-timer concern. DEFAULT NOW() is
-- deliberate: it backfills existing rows to "active now" so the first
-- sweep after this migration doesn't mass-pause every open session.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- Supports the sweeper's "active + idle past threshold" scan.
CREATE INDEX IF NOT EXISTS chat_sessions_activity_idx ON chat_sessions(status, last_activity_at);

-- #155: headless "auto sessions" started from an issue's Auto-solve button.
-- A headless session is NOT connected to any user's dev chat: it runs one
-- unattended Mayor turn (scout / build / question) against the issue, may
-- push a branch, but never opens a PR or builds staging. It is billed to
-- the user who clicked the button (user_id), and any collaborator can later
-- clone its state (messages + spec + branch + CC memory) into their own
-- dev-chat session via POST /api/sessions/:id/clone-headless.
--   is_headless            = marks the row as an auto session; excluded from
--                            per-user session lists, the 3-slot cap, and chat.
--   headless_status        = 'generating' (run in flight) | 'ready' | 'failed'.
--                            NULL on ordinary sessions.
--   headless_issue_number  = the GitHub issue the auto session was started for.
--   headless_outcome       = what the run arrived at: 'spec' | 'code' |
--                            'spec_code' (#170 — scout drafted a spec AND the
--                            decision turn implemented it) | 'question'. Drives
--                            the cloned session's follow-up message. NULL until
--                            the run finishes.
--   cloned_from_session_id = on ORDINARY sessions: the headless session this
--                            dev chat was cloned from (many clones per source).
--   created_from_issue_number = #287: on ORDINARY sessions, the GitHub issue
--                            this dev chat was started for via the issue row's
--                            start-work button. Recorded at creation time (not
--                            the async, Mayor-declared `linked_issues`) so the
--                            row can deterministically swap "Create proposal" →
--                            "Create new proposal" for the owning viewer. NULL on
--                            the generic "+ New chat" path and on headless rows.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS is_headless BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_status VARCHAR(20);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_issue_number INTEGER;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_outcome VARCHAR(20);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS cloned_from_session_id INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS created_from_issue_number INTEGER;
-- Supports the per-issue "latest auto session" lookup on the issues panel.
CREATE INDEX IF NOT EXISTS chat_sessions_headless_idx
  ON chat_sessions(app_id, headless_issue_number, created_at DESC)
  WHERE is_headless;
-- #287: supports the per-viewer "latest Create-PR session for this issue"
-- lookup on the issues panel (GET /github-issues → myPrSessionId).
CREATE INDEX IF NOT EXISTS chat_sessions_created_from_issue_idx
  ON chat_sessions(app_id, created_from_issue_number, user_id, created_at DESC)
  WHERE created_from_issue_number IS NOT NULL;

-- Restart-proof turns + resumable headless runs.
--   active_turn   = durable record of an in-flight detached CC turn:
--                   { mode, journal, model, startedAt }. Set by
--                   worker.execInWorker before the detached `docker exec`
--                   dispatch and cleared after post-turn processing. On boot,
--                   server.js's adoption path uses it to replay the turn's
--                   journal file (in the CC volume) instead of killing the
--                   still-running in-container claude. NULL = no turn in
--                   flight.
--   headless_step = where the headless auto-session loop last checkpointed:
--                   'planning' (Mayor phase-1) | 'cc_running' (CC turn
--                   dispatched) | 'wrapping' (Mayor phase-2). Lets
--                   resumeHeadlessRuns continue a 'generating' row after a
--                   restart instead of blanket-failing it. NULL on ordinary
--                   sessions and on headless rows finished before this column
--                   existed.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS active_turn   JSONB;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS headless_step VARCHAR(20);

-- #161: "owner left while a turn was in flight; notify on completion".
-- Armed/disarmed by the client via POST /api/sessions/:id/notify-on-done
-- the moment the owner stops watching a running turn; checked + cleared
-- at every turn-completion point (the chat handler's done hook and
-- server.js resumeDetachedTurn). Persisted rather than in-memory so
-- restart-recovered turns honor it.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS notify_on_done BOOLEAN NOT NULL DEFAULT FALSE;

-- GitHub issue linkage (#75): the open issues this session's work addresses,
-- declared by the Mayor via dispatch_claude_code / dispatch_scout's
-- `addresses_issues` arg. Accumulates (union) across turns. pr-metadata.js
-- appends a `Closes #N` line per number to the PR body so merging the PR
-- auto-closes the issue. `pr_linked_issues_applied` snapshots what was last
-- written to the live PR body so the existing-PR update path can detect a
-- changed linkage even when the title is unchanged.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS linked_issues             INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_linked_issues_applied  INTEGER[] NOT NULL DEFAULT '{}';
-- One-shot marker for the migrate-time backfill that recovers linked_issues
-- from historical PR bodies (closing keywords) predating the #75 plumbing.
-- Set true once a session's PR has been fetched + parsed so PRs without
-- closing keywords aren't re-fetched from GitHub on every boot.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS linked_issues_backfilled  BOOLEAN NOT NULL DEFAULT false;

-- Bot-generated testing guidance for PR previews (#127). The coding agent
-- may end a build turn with a "==== TESTING ====" block (parsed by
-- src/services/testing-notes.js):
--   testing_md         : latest "how to test" markdown (NULL = none).
--   testing_path       : validated relative deep-link path into the app that
--                        lands the tester on the changed feature.
--   pr_testing_applied : snapshot of the rendered "How to test" section last
--                        written into the live PR body (the
--                        pr_linked_issues_applied analog) so the existing-PR
--                        update path detects changed guidance even when the
--                        title is unchanged.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS testing_md         TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS testing_path       VARCHAR(512);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_testing_applied TEXT;
--   testing_paths      : ordered list of validated deep-link paths the
--                        before/after capture pipeline shoots a pair at
--                        (#270). NULL/absent falls back to [testing_path
--                        || '/'], so legacy single-path rows are unchanged.
--                        testing_path stays the PRIMARY path (= the first
--                        of this list) for the "Test this change" button.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS testing_paths      JSONB;

-- Stale-promoted-PR policy + reversible archive.
--   promoted_at       : when the session was proposed to the group. With
--                       the latest pr_votes timestamp this gives the
--                       "interest" recency the stale sweeper measures.
--   stale_notified_at : set when the author was warned the PR is going
--                       stale; cleared when a new vote revives it. The
--                       grace-then-archive step keys off this.
--   archived_at       : when the session was archived. Archive is now
--                       REVERSIBLE within a retention window — the CC
--                       volume + branch are kept so /unarchive restores
--                       it; a hard GC purges the volume only after
--                       archived_at passes ARCHIVED_RETENTION_MS.
--   cc_purged         : TRUE once the hard GC has destroyed the CC volume
--                       (memory gone). /unarchive still works but starts
--                       a fresh Claude session.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS promoted_at        TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS stale_notified_at  TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS cc_purged          BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS chat_sessions_archived_idx ON chat_sessions(status, archived_at);

-- Exact merge timestamp. Historically chat_sessions only recorded the
-- terminal `status = 'merged'` with no time, so "merges over time" could
-- not be charted (see the note in routes/kudos.js leaderboard query).
-- Set in routes/votes.js checkAndMerge() at the moment the PR lands (both
-- vote-driven and admin force-merge paths). NULL for rows merged before
-- this column existed; the events backfill approximates those with
-- promoted_at. Covered by the table-level staging:private comment, so it
-- is scrubbed from staging clones with the rest of the row.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS chat_sessions_merged_at_idx ON chat_sessions(merged_at);

-- #58: snapshot the vote threshold that was in effect at the moment a PR
-- merged. The "majority" needed to merge is computed live from the active-
-- user set (services/active-users.js getActiveUserStats) and is never
-- otherwise persisted, so the merged-PR vote pill used to be rendered
-- against the *current* majority — its denominator drifted as the app's
-- active-user count changed ("3 / 3" at merge could later read "3 / 5").
-- These two columns freeze the at-merge numbers so the pill (and a
-- tooltip) can show the true historical threshold:
--   votes_required        = the majority threshold needed to merge
--   active_users_at_merge = the active-user count the threshold was
--                           derived from (the "/ M" denominator context)
-- Both set in routes/votes.js checkAndMerge() at the moment the PR lands
-- (vote-driven, admin force-merge, and revert-PR paths all flow through
-- there). NULL for rows merged before these columns existed; the boot-time
-- backfill in db/migrate.js reconstructs them from the merge announcement
-- message's "(yes/active votes)" figure where possible, and the frontend
-- falls back to the live majority for any that remain NULL. Covered by the
-- table-level staging:private comment, so they are scrubbed from staging
-- clones with the rest of the row.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS votes_required        INTEGER;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS active_users_at_merge INTEGER;

CREATE TABLE IF NOT EXISTS chat_session_specs (
  id                  SERIAL PRIMARY KEY,
  session_id          INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  content             TEXT    NOT NULL,
  built_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  commit_sha          VARCHAR(40),
  pr_number           INTEGER,
  shared_to_group_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, version)
);
CREATE INDEX IF NOT EXISTS idx_chat_session_specs_session
  ON chat_session_specs (session_id, version DESC);

-- #86: private spec shares. Each row grants ONE user read access to ONE
-- frozen spec version (the "Share to user" button on the dev-session
-- spec viewer). This table is the authorization source of truth for the
-- widened read gate on GET /api/sessions/:id/specs/:version — the
-- matching 'spec_shared' notification row is just UI. The unique
-- constraint makes re-shares idempotent (and is what keeps a recipient
-- from being re-notified per spec version). Independent of
-- chat_session_specs.shared_to_group_at: a later group share simply
-- makes these rows redundant, never conflicting.
CREATE TABLE IF NOT EXISTS chat_session_spec_user_shares (
  id            SERIAL PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  recipient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, version, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_spec_user_shares_recipient
  ON chat_session_spec_user_shares (recipient_id, created_at DESC);

-- Allow group-chat messages to carry structured payloads (spec_share
-- card metadata today; future: PR previews, system-link metadata, etc.)
-- without overloading the free-form `content` field.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- #194: thread scoping for chat_messages. NULL thread_type = general
-- chat (all pre-existing rows; no backfill needed). thread_type is one
-- of 'issue' | 'session' | 'governance'; thread_ref is, respectively,
-- the GitHub issue number (consistent with
-- issue_bounties.github_issue_number keying), chat_sessions.id (PR
-- proposals), or the internal issues.id (governance proposals). No FK
-- on thread_ref — GitHub issue numbers aren't a local table; session /
-- governance refs are validated server-side at post time (ws.js).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread_type VARCHAR(16);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread_ref INTEGER;

-- Message editing: NULL = never edited; a timestamp = the most recent edit
-- time (rendered as the "edited" marker's tooltip). No backfill needed —
-- all pre-existing rows are unedited (matches the metadata/thread_type
-- precedent). Only the original author may set it (enforced in the WS
-- 'edit' handler, src/services/ws.js).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
  ON chat_messages (app_id, thread_type, thread_ref, id)
  WHERE thread_type IS NOT NULL;

-- #25: emoji reactions on group-chat messages (WhatsApp-style, but
-- Slack-model: a user may add multiple distinct emoji to one message,
-- hence UNIQUE(message_id, user_id, emoji) rather than per-user). Toggled
-- via the per-app chat WebSocket ('react' message in src/services/ws.js).
CREATE TABLE IF NOT EXISTS message_reactions (
  id         SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  emoji      VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_message_idx ON message_reactions(message_id);

-- Issues (mirrored to GitHub Issues). `kind` discriminates general issues from
-- structured proposals like 'rename' (see src/routes/issues.js). `payload`
-- carries the proposal-specific data (e.g. { newName }).
CREATE TABLE IF NOT EXISTS issues (
  id                  SERIAL PRIMARY KEY,
  app_id              INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  github_issue_number INTEGER,
  title               VARCHAR(512) NOT NULL,
  description         TEXT,
  kind                VARCHAR(32) NOT NULL DEFAULT 'general',
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status              VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT 'general';
ALTER TABLE issues ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS issue_votes (
  id         SERIAL PRIMARY KEY,
  issue_id   INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  vote       VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(issue_id, user_id)
);
-- User-first scan for the "My history" view (GET /api/me/history).
CREATE INDEX IF NOT EXISTS idx_issue_votes_user ON issue_votes (user_id, created_at DESC);

-- PR votes
CREATE TABLE IF NOT EXISTS pr_votes (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  vote       VARCHAR(10) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_id, user_id)
);
-- User-first scan for the "My history" view (GET /api/me/history).
CREATE INDEX IF NOT EXISTS idx_pr_votes_user ON pr_votes (user_id, created_at DESC);

-- LLM usage tracking
CREATE TABLE IF NOT EXISTS llm_usage (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  total_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  UNIQUE(user_id, date)
);

-- #361: dedicated "system tokens" daily ledger for platform-driven
-- merge-conflict / sync-with-main resolution turns. One row per day (not
-- per user — this spend isn't attributable to a person). Mirrors the
-- llm_usage upsert shape. Kept separate from llm_usage so this
-- housekeeping spend never pollutes per-user analytics or the global
-- cap aggregation. Written via limits.recordSystemSpend, gated via
-- limits.checkSystemBudget against system_tokens_daily_limit_cents.
CREATE TABLE IF NOT EXISTS system_token_usage (
  date       DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- #119: split daily spend by who paid Anthropic.
--   total_cost_cents = platform-key spend (drives the daily caps)
--   byok_cost_cents  = spend billed to the user's own Anthropic key
--                      (display only — never considered by any cap)
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS byok_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0;

-- Platform-level admin-tunable settings. Currently only used for the
-- daily LLM spend caps; designed as a generic key/value store so future
-- admin knobs can land here without another migration. Values are
-- TEXT so callers can interpret per-key (parseInt for cents, etc.).
-- Read via src/services/limits.js with a 10s in-process cache;
-- writes from /api/admin/limits invalidate the cache.
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
-- Seed defaults that match the legacy hardcoded values in
-- src/routes/sessions.js (USER_DAILY_LIMIT_CENTS=2500, GLOBAL=20000)
-- so a fresh deploy preserves the prior behavior. ON CONFLICT DO
-- NOTHING means existing operator-set values survive every boot.
INSERT INTO platform_settings (key, value) VALUES
  ('user_daily_limit_cents',   '2500'),
  ('global_daily_limit_cents', '20000'),
  -- #361: separate "system tokens" budget that funds platform-driven
  -- merge-conflict / sync-with-main resolution turns. Defaults to $25/day.
  ('system_tokens_daily_limit_cents', '2500')
ON CONFLICT (key) DO NOTHING;

-- One-shot backfill of users.app_quota from the legacy can_create_apps
-- boolean. Guarded by a marker row in platform_settings so it runs EXACTLY
-- ONCE: a re-run-safe UPDATE keyed only on can_create_apps = TRUE would
-- re-clobber any quota an admin later resets to 0 for a still-enabled user.
-- Placed after both `apps` and `platform_settings` exist (this whole file
-- runs as one ordered statement). Mapping for existing enabled users:
--   can_create_apps = TRUE  → app_quota = GREATEST(5, <live app count>),
--     where live count = COUNT(*) of their non-errored apps. The floor of
--     5 guarantees no regression — nobody who could already create ends up
--     below the apps they already have. Admins are included (their quota is
--     cosmetic since they bypass enforcement) so the admin UI shows a
--     sensible number.
--   can_create_apps = FALSE → quota stays 0 (the column default).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'app_quota_migrated') THEN
    UPDATE users u
       SET app_quota = GREATEST(5, (
             SELECT COUNT(*)::int FROM apps
              WHERE created_by = u.id AND status <> 'error'
           ))
     WHERE u.can_create_apps = TRUE;
    INSERT INTO platform_settings (key, value)
      VALUES ('app_quota_migrated', 'true')
      ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

-- Notifications. Generic row format so we can add more `kind`s later
-- (PR approvals, etc). Currently 'mention' (group-chat @mention parser
-- in src/services/ws.js), 'kudos' (PR kudos give in src/routes/kudos.js),
-- 'reply' (#15 — someone quoted your message/PR in group chat;
-- chat_message_id points to the reply, set in src/services/ws.js),
-- 'reaction' (#25 — someone reacted to your message; chat_message_id is
-- the reacted message, `detail` holds the emoji), 'stale_pr' (a promoted
-- PR is going quiet, addressed to its author), 'pr_proposed' (a PR
-- was promoted for voting — session_id points to it; fanned out to the
-- app's active users + creator + favoriters in src/routes/votes.js),
-- 'session_done' (#161 — a dev-session turn finished after its owner
-- left; session_id points to the session), 'auto_solve_done' (#161 —
-- a headless auto-solve run finished; `detail` holds the outcome:
-- spec | code | spec_code | question | failed) and 'spec_shared' (#86 —
-- someone privately shared a spec version with you; session_id points
-- to the dev session, `detail` holds the version number as a string).
CREATE TABLE IF NOT EXISTS notifications (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id          INTEGER REFERENCES apps(id) ON DELETE CASCADE,
  chat_message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  source_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            VARCHAR(32) NOT NULL DEFAULT 'mention',
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_user_recent
  ON notifications (user_id, created_at DESC);

-- Kudos notifications carry a chat_sessions reference so the notification
-- dropdown can navigate back to the PR (group-chat tab) and render the
-- PR's title in the preview. Added later than the rest of the column
-- set, so wrapped in IF NOT EXISTS for idempotent re-runs.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS session_id
  INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE;

-- #25: free-form detail for a notification kind that needs a small extra
-- string. Today only 'reaction' uses it (the emoji someone reacted with);
-- kept generic + nullable so future kinds can reuse it.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS detail VARCHAR(32);

-- Per-app environment secrets. Values are AES-256-GCM encrypted via
-- src/services/secrets.js (keyed off jwtSecret), serialized as
-- "v1:<iv>:<tag>:<ct>" — same scheme used for users.anthropic_key_enc.
--
-- A dapp declares which keys it needs in `dapp.json` at its repo root
-- (see src/services/app-manifest.js). Stored values for any `required`
-- key listed there must be present at deploy time, otherwise the
-- deploy is blocked (createApp flips status to 'awaiting_secrets';
-- rebuildProduction throws with `missingSecrets`).
--
-- value_last4 is a redacted preview the UI can show without a decrypt
-- round-trip (e.g. "ut1…abcd"). Sensitive values store NULL here so the
-- UI never shows even a fragment.
CREATE TABLE IF NOT EXISTS app_secrets (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key         VARCHAR(128) NOT NULL,
  value_enc   TEXT NOT NULL,
  value_last4 VARCHAR(8),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (app_id, key)
);

-- Self-hosting: the platform itself appears as one row in `apps` with
-- self_hosted=TRUE. The seed at boot inserts/refreshes this row; two
-- guards in app-creator and votes (Phase 2g) skip container-management
-- side effects for it. See SELF-HOSTING.md.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS self_hosted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_apps_self_hosted
  ON apps (self_hosted) WHERE self_hosted = TRUE;

-- Staging privacy convention. Tables tagged `staging:private` are
-- TRUNCATEd by db-manager.js's cloneDatabase when spawning a staging
-- clone; columns tagged `staging:private` are UPDATE'd to NULL (or a
-- sentinel for NOT NULL columns) so the surrounding row survives.
-- See src/prompts/app-conventions.md for the convention doc.
--
-- Table-level: every row is sensitive in its entirety.
COMMENT ON TABLE sessions               IS 'staging:private';
COMMENT ON TABLE activation_codes       IS 'staging:private';
COMMENT ON TABLE chat_sessions          IS 'staging:private';
COMMENT ON TABLE chat_session_messages  IS 'staging:private';
COMMENT ON TABLE chat_session_specs     IS 'staging:private';
COMMENT ON TABLE chat_session_spec_user_shares IS 'staging:private';
COMMENT ON TABLE llm_usage              IS 'staging:private';
COMMENT ON TABLE notifications          IS 'staging:private';
COMMENT ON TABLE app_secrets            IS 'staging:private';

-- Column-level on `users`: rows survive cloning so FK-targeted
-- attribution (chat_messages.user_id, apps.created_by, …) keeps
-- working in staging. Only the auth-sensitive columns get scrubbed.
-- usernode_pubkey is intentionally NOT scrubbed: it's an on-chain
-- public identity, no different from username for privacy purposes,
-- and a self-app dev wants to see it to test wallet-link flows.
COMMENT ON COLUMN users.password               IS 'staging:private';
COMMENT ON COLUMN users.anthropic_key_enc      IS 'staging:private';
COMMENT ON COLUMN users.anthropic_key_last4    IS 'staging:private';
COMMENT ON COLUMN users.wallet_link_token      IS 'staging:private';
COMMENT ON COLUMN users.wallet_link_expires_at IS 'staging:private';

-- Per-app postgres role passwords. A staging clone has no legitimate
-- need for the prod credentials of any app (including its own — the
-- clone has its own dedicated role with its own ephemeral password),
-- so blank every row's value. Without this scrub, a self-app staging
-- container could SELECT db_password FROM apps and recover every
-- prod app's credential.
COMMENT ON COLUMN apps.db_password IS 'staging:private';

-- Public by omission (no comment): apps, app_activity, issues, the
-- users table itself, chat_messages, issue_votes, pr_votes. These
-- carry no per-row secrets and the aggregates are already visible
-- to anyone the staging clone would be spun up for.

-- PR kudos. A platform-wide appreciation signal that's orthogonal to
-- `pr_votes` (which is a yes/no merge gate). Every user gets 5 kudos
-- per week, can give at most 1 per PR, can't give to their own PR, and
-- can't take a kudos back. Eligibility lives in src/routes/kudos.js:
-- only chat_sessions in status ('promoted','merging','merged') can
-- receive kudos.
--
-- `week_start` is the Monday-00:00-UTC bucket containing `created_at`,
-- stored explicitly so (giver_user_id, week_start) is an indexable
-- equality lookup for the per-week quota check. Postgres
-- `date_trunc('week', x AT TIME ZONE 'UTC')::DATE` returns the Monday
-- of that ISO week, which matches the boundary exactly. See
-- src/routes/kudos.js for both the JS-side (`weekStartUtc`) and SQL
-- usages — keep them aligned if the boundary is ever changed.
--
-- Tagged staging:private so kudos history doesn't leak into staging
-- clones; per-user counts are derivable from production but the
-- row-level (giver, PR) attribution is privacy-flavored social data.
CREATE TABLE IF NOT EXISTS pr_kudos (
  id             SERIAL PRIMARY KEY,
  session_id     INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  giver_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start     DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, giver_user_id)
);
CREATE INDEX IF NOT EXISTS idx_pr_kudos_session     ON pr_kudos (session_id);
CREATE INDEX IF NOT EXISTS idx_pr_kudos_giver_week  ON pr_kudos (giver_user_id, week_start);
CREATE INDEX IF NOT EXISTS idx_pr_kudos_created     ON pr_kudos (created_at DESC);
COMMENT ON TABLE pr_kudos IS 'staging:private';

-- Issue bounties — a "Give kudos" pledge placed on a GitHub issue from the
-- Open Issues activity-panel section. A bounty is a SYMBOLIC off-chain
-- ledger entry (no tokens, no on-chain transfer): pledging it debits the
-- giver's shared weekly kudos allowance (the same 5/week cap pr_kudos
-- enforces, counted across BOTH tables — see src/routes/kudos.js). When a
-- merged PR closes the issue (via its chat_sessions.linked_issues link),
-- the open bounty flips to 'awarded' and is credited to that PR's author —
-- see the payout block in routes/votes.js checkAndMerge.
--
-- Keyed by (app_id, github_issue_number) — NOT the internal `issues` table —
-- because the Open Issues section lists the repo's GitHub issues, which may
-- have no internal proposal row. staging:private for the same reason as
-- pr_kudos: row-level (giver, issue) attribution is privacy-flavored social
-- data. (A private table may FK public tables; only the reverse is barred.)
CREATE TABLE IF NOT EXISTS issue_bounties (
  id                   SERIAL PRIMARY KEY,
  app_id               INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  github_issue_number  INTEGER NOT NULL,
  giver_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  week_start           DATE NOT NULL,
  status               VARCHAR(16) NOT NULL DEFAULT 'open',
  awarded_session_id   INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  awarded_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  awarded_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One OPEN bounty per (app, issue, giver). A partial unique index keeps the
-- constraint scoped to status='open' so a giver can re-pledge after a prior
-- bounty of theirs has already been awarded/voided.
CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_bounties_open_uniq
  ON issue_bounties (app_id, github_issue_number, giver_user_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_issue_bounties_issue
  ON issue_bounties (app_id, github_issue_number, status);
CREATE INDEX IF NOT EXISTS idx_issue_bounties_giver_week
  ON issue_bounties (giver_user_id, week_start);
COMMENT ON TABLE issue_bounties IS 'staging:private';

-- Per-user app favorites. Personal shortcut — starred apps appear in a
-- dedicated section above the main grid on the home screen. No effect
-- on visibility or permissions for other users. Not staging:private
-- because favorites are non-sensitive and useful in staging previews.
CREATE TABLE IF NOT EXISTS app_favorites (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_favorites_user ON app_favorites(user_id);
-- Per-user manual ordering of starred apps (issue #128). NULL = no
-- explicit position: such rows sort after all explicitly ordered ones,
-- falling back to the activity-based list order. Lower = earlier.
-- Uniqueness is deliberately not enforced — gaps/ties are tolerated and
-- resolved by the fallback, and PUT /api/favorites/order rewrites the
-- caller's full set contiguously on every save anyway.
ALTER TABLE app_favorites ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- Append-only product-analytics event log. The long-term source of truth
-- behind the admin /dashboard (growth, retention, and the dapp-usage /
-- PR-promotion funnels). Rows are written fire-and-forget at action sites
-- via src/services/events.js (never blocking or failing the originating
-- request). On first boot the events table is backfilled from the existing
-- domain tables (users, apps, app_activity, chat_messages, pr_votes,
-- pr_kudos, app_favorites, chat_sessions) so the funnels and retention
-- curves are continuous across the cutover — see backfillEvents() in
-- src/db/migrate.js.
--
-- `event_type` is a free-form verb (e.g. 'user_signed_up', 'dapp_opened',
-- 'pr_promoted', 'pr_merged'); see EVENT_TYPES in src/services/events.js
-- for the canonical list. The nullable user/app/session FKs use ON DELETE
-- SET NULL so analytics history survives the deletion of the referenced
-- row (the aggregate counts stay correct even after a user is removed).
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  app_id      INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  session_id  INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  event_type  VARCHAR(64) NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at);

-- Tagged staging:private so the analytics log (which is derived from
-- chat_sessions / pr_kudos, both already private) is TRUNCATEd in staging
-- clones rather than leaking social history into previews.
COMMENT ON TABLE events IS 'staging:private';

-- Per-app visibility (collaborator & viewer privacy).
--   collab_visibility: who may participate in building the app (group
--     chat, dev sessions, voting, issues, kudos). 'public' = everyone.
--   view_visibility:   who may see the app exists and use it (home list,
--     App tab). 'public' = everyone.
-- Invariants (enforced by the CHECK below + API validation in
-- routes/apps.js): collab-public implies view-public, and view-private
-- means the viewer list IS the collaborator list (viewers are never
-- separately enumerated). Admins always see everything — enforced in
-- src/services/app-access.js, the shared gate every route goes through.
-- Post-creation changes go through dapp.json's top-level `visibility`
-- block (issue #124): a vote-gated PR edits the block and the merge's
-- production rebuild reconciles these columns to it
-- (services/app-manifest.js reconcileAppVisibility).
-- Defaults make every pre-migration app public/public (no behavior change).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS collab_visibility VARCHAR(10) NOT NULL DEFAULT 'public';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS view_visibility   VARCHAR(10) NOT NULL DEFAULT 'public';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'apps_visibility_combo_check' AND conrelid = 'apps'::regclass
  ) THEN
    ALTER TABLE apps ADD CONSTRAINT apps_visibility_combo_check
      CHECK (NOT (collab_visibility = 'public' AND view_visibility = 'private'));
  END IF;
END $$;

-- Pixel density the platform captures this app's before/after preview
-- screenshots at (issue #360). 2 = HiDPI/retina (the default, matching
-- real laptops/phones — surfaces "only broken on retina" bugs as a
-- visible before/after diff); 1 = standard density, opted into by apps
-- that genuinely need it (pixel art). Source of truth is dapp.json's
-- top-level `screenshot.deviceScaleFactor`, reconciled here on every
-- deploy (services/app-manifest.js reconcileAppScreenshot) and read by
-- the capture orchestrator (services/visuals.js captureForSession).
-- DEFAULT 2 means every pre-migration app captures at 2× with no
-- manifest edit.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS screenshot_device_scale SMALLINT NOT NULL DEFAULT 2;

-- App membership + invites in one table. A row with status='invited' is
-- a pending invite (grants NO access — every check requires 'member');
-- declining deletes the row so re-invites work. The creator gets a
-- member row at creation time (and via the backfill below for existing
-- apps), so "creator is always a collaborator" holds uniformly.
-- Deliberately NOT staging:private (like app_favorites): membership must
-- survive into staging clones so a cloned platform's own access checks
-- keep working, and rows carry no secrets.
CREATE TABLE IF NOT EXISTS app_collaborators (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(16) NOT NULL DEFAULT 'member',
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_collaborators_user ON app_collaborators(user_id, status);

-- Backfill: every existing app's creator becomes a member. Idempotent.
INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
  SELECT id, created_by, 'member', NOW() FROM apps WHERE created_by IS NOT NULL
ON CONFLICT (app_id, user_id) DO NOTHING;

-- Before/after visuals on UI-affecting proposals (issue #195). Each row is
-- one capture artifact produced by the one-shot usernode-capture container
-- after a staging preview comes up healthy: kind = before (production) /
-- after (staging), media = png (still) / webm (in-app <video> clip) /
-- gif (PR-body inline embed). Retention is latest-set-per-session only —
-- src/services/visuals.js deletes the session's prior rows before
-- inserting a fresh capture, so growth is bounded at <= 6 rows/session.
-- The id is a random 32-hex token generated in Node: GET /visuals/:id is
-- a public (pre-auth) route so GitHub's camo proxy can fetch embeds
-- anonymously, and unguessable ids are the only privacy layer.
-- Artifacts are bytea-in-Postgres because the platform container has no
-- persistent file volume; the serving route isolates that storage choice.
CREATE TABLE IF NOT EXISTS session_visuals (
  id            VARCHAR(32) PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  commit_hash   VARCHAR(64),
  kind          VARCHAR(8)  NOT NULL,
  media         VARCHAR(8)  NOT NULL,
  content_type  VARCHAR(32) NOT NULL,
  data          BYTEA       NOT NULL,
  captured_path VARCHAR(512),
  -- #270: capture order within a session. A proposal can now point its
  -- screenshots at a short ordered list of routes; each route is a
  -- "capture group" sharing one capture_index, and the renderers emit one
  -- labelled before/after row per group. Defaults to 0 so pre-#270 rows
  -- form a single legacy group with no migration backfill needed.
  capture_index SMALLINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS capture_index SMALLINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_session_visuals_session ON session_visuals(session_id);

-- Private like its parent chat_sessions (public-FK-to-private is the
-- combination the migration linter forbids); the artifacts also embed
-- screenshots of other users' staging previews.
COMMENT ON TABLE session_visuals IS 'staging:private';

-- Snapshot of the rendered "Before / after" PR-body block last written to
-- GitHub, mirroring pr_testing_applied: applyPrMetadata compares the fresh
-- block against this to decide whether a title-unchanged turn still needs
-- a PR body update, and src/services/visuals.js stamps it after its
-- targeted post-capture body patch so the next turn doesn't rewrite an
-- unchanged body.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_visuals_applied TEXT;

-- Plain-language, user-facing summary of a proposed change (1-3 sentences,
-- no jargon/file names/code). Generated alongside pr_title by the Haiku
-- PR-metadata call, prepended as the first paragraph of the GitHub PR body,
-- and rendered at the top of the in-app proposal view (the column is this
-- surface's single source of truth). NULL = none generated yet (legacy /
-- pre-feature proposals, or an LLM-unavailable fallback); the view simply
-- omits the summary paragraph in that case.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_summary_md TEXT;

-- App access to user LLM budgets (issue #34). One row per (app, user)
-- consent: the user explicitly allowed this app to spend from their
-- daily AI budget through the platform proxy (/api/app-llm), up to
-- daily_cap_cents per day. Revocation keeps the row (usage history,
-- easy re-grant) and just flips status; the proxy requires
-- status='active'. allow_byok extends the grant onto the user's own
-- stored Anthropic key once the platform allowance is exhausted —
-- strictly opt-in per app, still bounded by the cap.
CREATE TABLE IF NOT EXISTS app_llm_grants (
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  daily_cap_cents INTEGER NOT NULL DEFAULT 100,
  allow_byok      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_llm_grants_user ON app_llm_grants(user_id);
-- Consent/financial-adjacent rows must not leak into staging clones.
-- (A private table may FK public tables; only the reverse is barred.)
COMMENT ON TABLE app_llm_grants IS 'staging:private';

-- Per-app daily spend ledger, mirroring llm_usage's split: total goes
-- against the platform daily caps, byok is the display-only bucket for
-- spend billed to the user's own key. The proxy writes BOTH this table
-- and llm_usage (via limits.recordSpend) so platform-wide caps and the
-- existing /api/budget display stay correct.
CREATE TABLE IF NOT EXISTS app_llm_usage (
  app_id          INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  total_cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  byok_cost_cents  NUMERIC(10,4) NOT NULL DEFAULT 0,
  UNIQUE(app_id, user_id, date)
);
-- Sibling of llm_usage, which is already staging:private.
COMMENT ON TABLE app_llm_usage IS 'staging:private';

-- Per-app credential identifying the calling app to the LLM proxy.
-- Random 64-hex, generated lazily at production deploy when NULL (same
-- adoption shape as db_password). Deliberately NOT a JWT: every dapp
-- container holds the shared JWT_SECRET, so a JWT-based app identity
-- would be forgeable by any other app; a random opaque token is not.
-- staging:private so the column-scrub in cloneDatabase blanks it —
-- staging containers never receive the token and therefore can't
-- spend grants (unreviewed PR code).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS llm_proxy_token TEXT;
COMMENT ON COLUMN apps.llm_proxy_token IS 'staging:private';

-- #249: meaningful default session names. session_title is the
-- display-name layer for dev sessions: set from the first interactive
-- message (Haiku), refreshed at pre-PR turn ends, mirrored from
-- pr_title once a PR exists, and derived deterministically
-- ("#N · issue title") for headless auto sessions. NULL falls back to
-- pr_title then branch_name at every display site. Branch names stay
-- machine-generated and immutable — this column never affects git.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS session_title VARCHAR(256);

-- Experimental AI progress estimate accuracy dataset (#50 follow-up).
-- Each row records one estimator tick: what the small model predicted
-- (remaining-time number + hedged phrase) and how far into the run it
-- was. When the turn ends, the actual outcome is backfilled (whole-turn
-- wall clock, per-tick ground-truth remaining, and how the turn ended)
-- so estimator accuracy can be evaluated later. Anchored on the per-turn
-- progress-log message (progress_message_id) — the codebase has no
-- first-class "turn" row, and a fresh progress message is created per
-- build turn, which uniquely identifies it. Invisible in the product for
-- now; reviewing accuracy is deferred follow-up work.
CREATE TABLE IF NOT EXISTS progress_estimates (
  id                          BIGSERIAL PRIMARY KEY,
  session_id                  INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
  progress_message_id         INTEGER REFERENCES chat_session_messages(id) ON DELETE CASCADE,
  user_id                     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  model                       VARCHAR(64),
  -- Inputs at estimate time.
  elapsed_ms                  INTEGER NOT NULL,
  step_count                  INTEGER NOT NULL DEFAULT 0,
  progress_lines              INTEGER NOT NULL DEFAULT 0,
  -- Prediction.
  estimate_text               VARCHAR(120),
  predicted_remaining_seconds INTEGER,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Later-filled actuals (NULL until the turn reaches a terminal point).
  actual_total_ms             INTEGER,
  actual_remaining_ms         INTEGER,
  outcome                     VARCHAR(16),
  resolved_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_progress_estimates_message ON progress_estimates(progress_message_id);
CREATE INDEX IF NOT EXISTS idx_progress_estimates_session ON progress_estimates(session_id, created_at);
-- staging:private — forced, not a preference: this table FKs both
-- chat_sessions and chat_session_messages, which are already
-- staging:private, and the migration linter forbids a public table
-- FK-ing a private one. The rows are also per-user run-timing data with
-- no value in a staging clone, so it ships schema-only + empty there.
COMMENT ON TABLE progress_estimates IS 'staging:private';

-- #297: per-user, read-only "Ask AI" advisor conversations scoped to a
-- single proposal — the "Mayor in advisor mode" surface. Each row is one
-- turn the conversation OWNER (user_id) sent or the advisor replied with,
-- keyed to either a promoted/merging/merged PR (proposal_kind='pr',
-- proposal_ref=chat_sessions.id) or a governance issue
-- (proposal_kind='gov', proposal_ref=issues.id). proposal_ref is a
-- polymorphic reference with no FK — same precedent as chat_messages
-- thread_ref (a PR session id and a governance issue id can't share one
-- FK target). The conversation is private scratch data: never posted into
-- the shared group thread, and never copied into staging clones
-- (staging:private), so a prod-cloned staging DB ships this table empty
-- and seeds its own "Staging demo …" rows. A private table may FK public
-- tables (apps, users); only the reverse is barred by the linter.
CREATE TABLE IF NOT EXISTS proposal_ai_messages (
  id            SERIAL PRIMARY KEY,
  app_id        INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  proposal_kind VARCHAR(8) NOT NULL,
  proposal_ref  INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          VARCHAR(16) NOT NULL,
  content       TEXT NOT NULL,
  model         VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Per-conversation, per-user history load: WHERE app_id + kind + ref +
-- user_id, ORDER BY id. The composite index makes that an index range scan.
CREATE INDEX IF NOT EXISTS idx_proposal_ai_messages_convo
  ON proposal_ai_messages (app_id, proposal_kind, proposal_ref, user_id, id);
COMMENT ON TABLE proposal_ai_messages IS 'staging:private';
