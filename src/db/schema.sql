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

-- Platform-level user language preference (issue #757). A BCP-47 language
-- tag ("id", "pt-BR", …) or NULL for "unset/auto — use device language".
-- Set from Settings → Language via POST /api/me/locale; exposed to apps as
-- the `locale` claim in the iframe JWT (server.js /api/iframe-token) and
-- through /api/auth/me → the shell → the bridge's usernode.getUserLocale().
-- 35 chars is the RFC 5646 recommended buffer for BCP-47 tags.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale VARCHAR(35);

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

-- #416: detail of the last build/deploy failure so the UI can show a
-- build log instead of a bare "Error" status. Shape:
--   { stage, reason, log, at, sha }
--   stage  : 'repo'|'clone'|'build'|'start'|'healthcheck'|'timeout'|'other'
--   reason : concise human line (<= 280 chars)
--   log    : ANSI-stripped tail of the docker build / boot output (<= 16 kB)
-- Written by the deploy catch paths (services/app-creator.js,
-- services/staging.js rebuildProduction, routes/apps.js watchdog);
-- cleared (NULL) on every successful deploy. Exposed API-side only to
-- the app's creator / collaborators / admins — see routes/apps.js.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS last_failure JSONB;

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
  --                 The only status counting against the per-user
  --                 active-session cap (MAX_USER_SESSIONS, raised for full
  --                 platform admins by MAX_ADMIN_USER_SESSIONS — resolved
  --                 per-requester in src/services/session-caps.js).
  --   'promoted'  = PR is up for a merge vote and the chat is still alive.
  --                 Un-pausable while the vote runs, so it is EXEMPT from
  --                 the active-session cap (#193) and bounded instead by
  --                 the promoted cap (MAX_USER_PROMOTED_SESSIONS /
  --                 MAX_ADMIN_USER_PROMOTED_SESSIONS) at promote time.
  --   'paused'    = open but worker container has been torn down to free
  --                 the slot. CC volume + branch + PR are all preserved
  --                 so /resume restores it cleanly. Unlimited — does NOT
  --                 count against either cap (no warm container).
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

-- #800: the model-selector stats aggregate (services/model-stats.js)
-- joins every assistant row to its session and reads only session_id +
-- model, so this covering index turns what was a full sequential scan of
-- the whole message table (the pkey was its ONLY index) into an
-- index-only scan.
CREATE INDEX IF NOT EXISTS idx_csm_session_model
  ON chat_session_messages(session_id, model);

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
-- Opt-in session visibility: NULL = private to the owner (every
-- pre-existing row), non-NULL = "visible to everyone" — the session
-- renders at the bottom of other users' In progress area on the Dev
-- board, with its discussion thread (chat_messages thread_type
-- 'session') open to comments. Doubles as the sort key there
-- (oldest-shared first so newly shared rows append at the bottom).
-- Set/cleared by POST /api/sessions/:id/share|unshare (owner-scoped);
-- naming mirrors chat_session_specs.shared_to_group_at ("private until
-- explicitly shared").
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;
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
-- #381: console-error "may break the app" check. After each staging build
-- the capture pipeline's headless browser records console errors / uncaught
-- exceptions / failed loads on the staging "after" target(s). Written by
-- services/visuals.js (captureForSession → storeConsoleCheck), latest run
-- only. console_check_state is 'clean' | 'errors' | 'unknown' (NULL until
-- the first check); console_errors is the captured {kind,message,source}
-- list; console_checked_at is when it last ran. Advisory only — never gates
-- voting or merge.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS console_check_state TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS console_errors JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS console_checked_at TIMESTAMPTZ;
-- #47: "CI for proposals". The console-error check above is now the
-- built-in baseline of a general "tests run against staging" framework: a
-- proposal carries automated headless-browser tests (declared in the app's
-- dapp.json `tests` array, accumulating across proposals like CI in a
-- GitHub repo), each navigating one staging route and asserting the page
-- loads, throws no console errors, and (optionally) shows an expected
-- selector/text. After every staging build services/visuals.js runs them
-- (captureForSession → storeChecks) and records the outcome here, latest
-- run only.
--   check_state       : 'passing' | 'failing' | 'pending' | 'error' |
--                       'skipped' | 'unknown' (NULL until the first run).
--                       'pending' is set the moment a (re)build starts so a
--                       stale pass can't slip through; 'error'/'unknown' mean
--                       the staging build or capture run itself broke.
--   test_results      : array of { name, path, status:'pass'|'fail',
--                       consoleErrors:[{kind,message,source}], failureReason }
--   checks_commit_sha : the commit the results describe (staleness signal).
--   checks_checked_at : when the suite last ran.
-- Unlike the advisory console columns above, check_state GATES merge:
-- routes/votes.js checkAndMerge blocks a non-'passing' proposal (admin
-- force-merge still bypasses). The console_* columns are kept written in
-- parallel for one release so a rolling deploy's old readers still work.
-- #447: 'pending' is only ever advanced out by the same captureForSession
-- run that set it, so a restart mid-capture (or a staging rebuild that
-- predated the capture wiring) could leave a promoted PR 'pending'/NULL and
-- permanently merge-blocked. A 'pending' row whose checks_checked_at is
-- older than CHECKS_STALE_MS (default 10m) is now treated as STUCK and
-- re-run: by server.js reconcileStuckChecks (boot + session-sweeper Pass 4),
-- by a vote that reaches threshold (checkAndMerge stale-pending kick), by any
-- staging rebuild (staging-recovery.rebuildSessionStaging now re-runs checks),
-- and by the manual POST /api/sessions/:id/recheck ("Re-run checks" button).
-- #461: 'skipped' is a TERMINAL, GATE-PASSING verdict recorded when the
-- checks genuinely cannot / need not run — the branch carries no commits
-- beyond main, or GitHub isn't configured so no checks infrastructure
-- exists. Written by visuals.storeChecksSkipped (via
-- staging-recovery.recordChecksSkipped) with the human-readable reason in
-- check_error_detail (same column the badge tooltip already surfaces); the
-- merge gate treats it exactly like 'passing', and the next pushed commit
-- returns the row to 'pending' via setChecksPending as usual. Before #461
-- these paths returned silently, leaving check_state NULL — merge-blocked
-- as "still running its tests" forever while the stuck-checks sweeper
-- re-skipped the same row every pass.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_state TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS test_results JSONB NOT NULL DEFAULT '[]';
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS checks_commit_sha VARCHAR(40);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS checks_checked_at TIMESTAMPTZ;
-- Capture-outcome snapshot (screenshot-reliability spec). Before these,
-- "this proposal has no screenshots" was unattributable: an intentional
-- console-only run (no frontend files in the commit range) and a genuinely
-- failed capture looked identical, and per-artifact failure reasons (a
-- dropped over-cap webm, a screencast/ffmpeg error) lived only in
-- short-lived container logs. Written by services/visuals.js
-- (captureForSession → storeCaptureOutcome), latest run only.
--   capture_state  : 'captured'     — media run, everything usable stored
--                    'partial'      — media run stored, but some artifact
--                                     failed or was dropped over-cap
--                    'console_only' — non-UI-affecting commit range; media
--                                     intentionally skipped (NOT a failure)
--                    'failed'       — media run produced no usable "after",
--                                     or the capture run itself broke
--                    (NULL until the first outcome-aware run)
--   capture_detail : jsonb diagnostics — { media, pathDefaulted (the agent
--                    emitted no testing path so capture defaulted to '/'),
--                    prodRunning, paths, failures:[{kind,media,index,
--                    reason}], droppedOverCap:[{kind,media,index,bytes}],
--                    beforeFellBack:[capture indexes], reason? }
--   captured_at    : when the outcome was recorded.
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS capture_state VARCHAR(16);
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS capture_detail JSONB;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ;
-- Deadlock-diagnosis columns. Before these, a staging build that crashed on
-- boot threw before any verdict was written, leaving check_state NULL — the
-- merge gate fail-closes on NULL with no signal, and the stuck-checks sweeper
-- retried the identical failing build every ~2 min forever (an "unclear
-- deadlock": votes pass, nothing merges, nobody is told why). Now a build/boot
-- failure is recorded as a terminal 'error' verdict carrying:
--   check_error_detail       : a concise, human-readable reason for the LAST
--                              failure (e.g. the Postgres error / crash line
--                              pulled from the container's boot logs). Surfaced
--                              in the merge-gate message, the proposal thread,
--                              and the proposal's checks badge tooltip.
--   consecutive_check_failures : count of back-to-back failed check runs for
--                              the current commit. Reset to 0 on any passing/
--                              failing verdict and when a NEW commit starts a
--                              check run (see visuals.setChecksPending). Drives
--                              the sweeper's exponential backoff + the
--                              crash-loop short-circuit (stop auto-retrying a
--                              deterministically-failing build after N tries).
--   first_check_failure_at / last_check_failure_at : streak bounds, for "stuck
--                              for X hours" escalation + diagnostics.
--   check_next_retry_at      : earliest time the sweeper may re-attempt this
--                              errored check. Set to NOW()+backoff on each
--                              failure; the sweeper only re-picks an 'error'
--                              row once this has elapsed, replacing the old
--                              fixed ~2 min retry with 2m → 4m → 8m → … → 30m.
--   check_error_notified_at  : stamped when the proposal owner is notified of
--                              the failure, so they're nudged once per streak
--                              (cleared when a new commit resets the streak).
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_error_detail TEXT;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS consecutive_check_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS first_check_failure_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS last_check_failure_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_next_retry_at TIMESTAMPTZ;
ALTER TABLE chat_sessions          ADD COLUMN IF NOT EXISTS check_error_notified_at TIMESTAMPTZ;
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

-- #687 (PR-import, Slice 1): provenance columns for proposals whose code
-- was authored OUTSIDE the platform — an existing GitHub PR imported into
-- the vote flow rather than opened by the group's AI dev-chat. Append-only:
-- existing rows read as native (source NULL/'native').
--   source               = 'native' (implicit for every existing row; a
--                          NULL value is treated as native) vs 'imported'.
--                          Drives the "Imported PR" source badge + GitHub
--                          link and the read-only dev surface for imported
--                          proposals.
--   imported_pr_head_sha = the PR head commit the current checks/votes
--                          describe. A later push moves the PR head; the
--                          Slice 3 sync poller compares against this to
--                          reset the tally, and Slice 4 pins the merge to
--                          exactly this SHA. NULL for native rows.
--   imported_pr_author   = display handle of the external PR author, shown
--                          beside the badge. NULL for native rows.
-- NOTE: a partial UNIQUE index on (app_id, pr_number) WHERE source='imported'
-- is intentionally DEFERRED (see spec Considerations) — Slice 1 relies on
-- the read-only boot audit in db/migrate.js instead of a hard constraint,
-- to keep this migration strictly append-only.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS source               TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS imported_pr_head_sha VARCHAR(40);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS imported_pr_author   VARCHAR(255);

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
-- `addresses_issues` arg. Accumulates (union) across turns, and shrinks via
-- the tools' `removes_issues` counterpart (#733) when scope is cut
-- mid-session — removal wins over an addition of the same number in the
-- same call. pr-metadata.js appends a `Closes #N` line per number to the PR
-- body so merging the PR auto-closes the issue. `pr_linked_issues_applied`
-- snapshots what was last written to the live PR body so the existing-PR
-- update path can detect a changed linkage even when the title is unchanged.
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
--   testing_paths      : ordered list of validated deep-link routes the
--                        before/after capture pipeline shoots a pair at
--                        (#270). Since #768 elements are objects —
--                        { path, viewport: 'desktop'|'mobile' } (`@mobile`
--                        path annotation → phone-sized capture frame);
--                        older rows hold plain path strings and readers
--                        normalize via testing-notes.normalizeStoredPath.
--                        NULL/absent falls back to [testing_path || '/'],
--                        so legacy single-path rows are unchanged.
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

-- #788: "explicit approval" flag — this proposal's diff changes a
-- privilege-granting block in dapp.json (today only the top-level
-- `admins` list), so the TIME-BASED merge paths are switched off for it:
-- no minimum visibility window, no lazy-consensus "silence is consent"
-- auto-merge. The app's NORMAL approval rules are otherwise untouched
-- (same threshold, same electorate, same at-least-N / invited-approver
-- configuration, same contested handling) — the proposal merges the
-- moment its normal threshold is met by votes actually cast. The
-- rejection countdown and the stale-PR sweep behave exactly as they do
-- for any other proposal on that app. Implemented as the pure
-- applyNoTimerMerge modifier in services/governance.js.
--   requires_explicit_approval : NULL = not computed yet (the stale-PR
--     sweeper backfills), FALSE = ordinary proposal, TRUE = flagged.
--   explicit_approval_reason   : which rule flagged it; only 'admins'
--     today, a string so a second source can be added later without a
--     schema change.
-- Stamped at promote, at manifest-PR creation, and on every head change
-- (native new-commit vote reset + imported-PR head sync);
-- re-verified authoritatively in checkAndMerge just before the gate.
-- Covered by the table-level staging:private comment.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS requires_explicit_approval BOOLEAN;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS explicit_approval_reason   VARCHAR(32);

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

-- #687 Slice 3: revision-scoped approvals for IMPORTED PR proposals. A
-- vote cast on an imported proposal is stamped with the PR head commit it
-- was cast against (imported_pr_head_sha at the time), so a later push that
-- moves the head can re-open approval and the merge gate counts only the
-- approvals matching the CURRENT head. NULL for native proposals (whose
-- branch the platform owns) — the gate applies no head filter there, so
-- their counting is byte-for-byte unchanged. Append-only; safe on re-boot.
ALTER TABLE pr_votes ADD COLUMN IF NOT EXISTS head_sha VARCHAR(40);

-- Community-voted "priority" + "assigned person" on issues and PR
-- proposals. ONE unified table because both fields share identical
-- voting mechanics (one movable vote per user per field per card; the
-- top-voted value is what the card shows). target_ref points at the
-- GitHub issue NUMBER when target_type='issue' (mirroring issue_bounties,
-- which is keyed by (app_id, github_issue_number) because the Dev feed
-- lists repo GitHub issues that may have no internal `issues` row) and at
-- the chat_sessions.id (session id) when target_type='proposal'.
-- value holds 'low'|'medium'|'high' for priority, one of a fixed category
-- slug set (feature|bug|improvement|design|docs|chore) for category, or the
-- typed display name (raw casing) for assignee — assignee dedupe is
-- case-insensitive at read time, never restricted to registered users.
-- NOT staging:private:
-- the tally is a public governance-style signal (closer to issue_votes
-- than to the privacy-flavoured bounty/kudos ledgers), so leaving it
-- copyable lets staging previews show real seeded data.
CREATE TABLE IF NOT EXISTS topic_attribute_votes (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  target_type VARCHAR(16) NOT NULL,   -- 'issue' | 'proposal'
  target_ref  INTEGER NOT NULL,       -- github_issue_number | chat_sessions.id
  field       VARCHAR(16) NOT NULL,   -- 'priority' | 'assignee' | 'category'
  value       TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, target_type, target_ref, field, user_id)
);
-- Per-card tally read (group by value within one target+field).
CREATE INDEX IF NOT EXISTS idx_topic_attribute_votes_target
  ON topic_attribute_votes (app_id, target_type, target_ref, field);

-- #780: per-app registry of CUSTOM category options, listed under the six
-- built-in slugs (feature|bug|improvement|design|docs|chore) in the category
-- chip's dropdown and in the kanban / PM filter bar. Typing a new category
-- in that dropdown registers a row here (scoped to ONE app) and casts the
-- typer's vote for it in the same request — "suggesting" and "voting" stay
-- the same operation, mirroring the free-text assignee field.
--   slug  — lowercased dedupe key; ALSO the literal string written into
--           topic_attribute_votes.value, so a custom category tallies
--           byte-for-byte like a built-in one and needs no vote migration.
--   label — the display casing as FIRST typed ("iOS", "UX"), so a later
--           "ios" votes for the same option without rewriting the label.
-- NOT staging:private — like topic_attribute_votes this is a shared,
-- governance-style signal everyone in the app sees, so it must copy into
-- staging clones.
CREATE TABLE IF NOT EXISTS app_topic_categories (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,           -- lowercase dedupe key + vote value
  label       TEXT NOT NULL,           -- display casing as first typed
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, slug)
);

-- #613: manual drag-and-drop ordering of cards WITHIN a Dev-board kanban
-- column. The board's default order is derived (recency / merge-priority);
-- this table is an OVERLAY: cards whose identity appears here sort first,
-- by `position` asc, and everything else keeps the derived order. Keyed the
-- same way as topic_attribute_votes (heterogeneous cards addressed by a
-- (type, ref) pair) because a column mixes GitHub issues (ref = issue
-- NUMBER) with promoted PR proposals (ref = chat_sessions.id) and governance
-- proposals (ref = issues.id). column_key ∈ 'issues' | 'review' (the two
-- shared columns this feature covers; In progress is per-viewer and Done is
-- paginated, so both are out of scope). One movable order per app+column;
-- writes REPLACE the whole (app_id, column_key) set with a dense 0..N-1
-- sequence (last-write-wins). NOT staging:private — like topic_attribute_votes
-- this is a shared, governance-style signal that everyone sees, so it must
-- copy into staging clones.
CREATE TABLE IF NOT EXISTS dev_board_card_order (
  id          SERIAL PRIMARY KEY,
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  column_key  VARCHAR(16) NOT NULL,   -- 'issues' | 'review'
  card_type   VARCHAR(16) NOT NULL,   -- 'issue' | 'proposal' | 'gov'
  card_ref    INTEGER NOT NULL,       -- github_issue_number | chat_sessions.id | issues.id
  position    INTEGER NOT NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, column_key, card_type, card_ref)
);
-- Per-column ordered read (position asc within one app+column).
CREATE INDEX IF NOT EXISTS idx_dev_board_card_order_col
  ON dev_board_card_order (app_id, column_key, position);

-- Manual drag-and-drop ordering of cards WITHIN one person's section of the
-- Dev board's PM view ("tasks by assignee"). Sibling of dev_board_card_order,
-- but keyed by the case-folded ASSIGNEE instead of a kanban column: the PM
-- view groups cards by their top-voted assignee (see topic-attribute votes),
-- so a manual order is scoped to a person, not a column. Same OVERLAY model —
-- cards whose identity appears here sort first by `position` asc, everything
-- else keeps the client's derived recency order (see _applyManualOrder in
-- public/js/app-view.js). assignee_key = lower(display name), matching
-- topic-attributes.groupKey so it lines up with the rendered section. A PM
-- section only ever holds GitHub issues (card_ref = issue NUMBER) and promoted
-- PR proposals (card_ref = chat_sessions.id) — never governance cards, which
-- carry no assignee. One movable order per (app_id, assignee_key); writes
-- REPLACE the whole set with a dense 0..N-1 sequence (last-write-wins). NOT
-- staging:private — like dev_board_card_order it's a shared, governance-style
-- signal everyone sees, so it must copy into staging clones.
CREATE TABLE IF NOT EXISTS dev_pm_card_order (
  id           SERIAL PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  assignee_key VARCHAR(64) NOT NULL,   -- lower(assignee display name)
  card_type    VARCHAR(16) NOT NULL,   -- 'issue' | 'proposal'
  card_ref     INTEGER NOT NULL,       -- github_issue_number | chat_sessions.id
  position     INTEGER NOT NULL,
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, assignee_key, card_type, card_ref)
);
-- Per-person ordered read (position asc within one app+assignee).
CREATE INDEX IF NOT EXISTS idx_dev_pm_card_order_key
  ON dev_pm_card_order (app_id, assignee_key, position);

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
-- RELATED (#616): the prod-debug read-only role (usernode_debug_ro,
-- src/services/debug-access.js) carries its OWN deny lists
-- (DENIED_TABLES / DENIED_COLUMNS). When you add a NEW credential-
-- bearing table or column here (anything you'd tag staging:private
-- because it stores a password, key, or token — not merely private
-- user content), add it to those deny lists too so admin debugging
-- sessions can never SELECT it. tests/prod-debug-access.test.js
-- cross-checks the credential-tagged columns below against the lists.
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

-- Manual "In progress" claims on GitHub issues (the hand-set half of the
-- issue in-progress status; the automatic half derives from
-- chat_sessions.linked_issues at read time — see GET /github-issues in
-- src/routes/issues.js). One row per (app, issue, user): several people
-- can claim the same issue concurrently, each owning exactly one claim.
-- Claims carry no status column and are never swept — expiry is a
-- read-time filter: a claim is live while GREATEST(claimed_at, the
-- issue's discussion-thread last activity) is within ISSUE_CLAIM_TTL_DAYS
-- (7). Renewal (re-POST by the owner) just refreshes claimed_at; clearing
-- deletes the row (claimer or write-admin only). Keyed by GitHub issue
-- number for the same reason as issue_bounties. NOT staging:private —
-- claims are group-visible coordination data (the chip names claimers to
-- everyone), so cloned rows are as public in staging as in prod.
CREATE TABLE IF NOT EXISTS issue_claims (
  id                   SERIAL PRIMARY KEY,
  app_id               INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  github_issue_number  INTEGER NOT NULL,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, github_issue_number, user_id)
);

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
-- #618: per-user "Your apps" opt-out for member apps. Membership
-- (app_collaborators) pins an app into the home screen's "Your apps"
-- section; a hidden=TRUE row here suppresses that pin for this user
-- only — display preference, zero effect on access or permissions.
-- Row semantics: hidden=FALSE (the default, and every pre-migration
-- row) = a manual add (the classic favorite); hidden=TRUE = an
-- explicit opt-out. The favorite toggle endpoint decides which to
-- write: members get the hidden upsert, non-members get the old
-- insert/delete (see POST /api/apps/:slug/favorite in
-- src/routes/apps.js).
ALTER TABLE app_favorites ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

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

-- Per-app proposal-approval governance (issue #646).
--   approver_policy:    who can approve proposals. 'anyone' = every
--     eligible voter's vote counts toward the merge gate (today's
--     behavior); 'invited' = only votes from app_approvers members
--     count — everyone else's votes are advisory.
--   approvals_required: how many approvals are needed. NULL = the
--     default time-&-majority strategy (services/active-users.js
--     mergeGate); >= 1 = "at least N" mode — a proposal merges as soon
--     as it has N qualifying yes votes, with no visibility window,
--     lazy-consensus clock, contested state, or auto-rejection.
-- Source of truth is dapp.json's top-level `governance` block,
-- reconciled on every production deploy (services/app-manifest.js
-- reconcileAppGovernance) and — unlike visibility — also at boot for
-- the self-hosted platform app (db/migrate.js seedSelfApp). Defaults
-- make every pre-migration app behave exactly as before.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS approver_policy VARCHAR(10) NOT NULL DEFAULT 'anyone';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS approvals_required SMALLINT;

-- Per-app admins (#788), display side. The last reconciled *declared*
-- username list from dapp.json's top-level `admins` block — INCLUDING
-- names that resolved to no registered user, which is exactly why this
-- exists alongside the resolved-id table `app_admins` below: the
-- Members panel can say "@carol — declared, not a registered user"
-- without a second source. Never consulted for permission checks (the
-- `app_admins` rows are the authority); purely for display and to keep
-- the settings endpoint a single query. Defaults to the empty array so
-- every pre-migration app reads as "no declared admins".
ALTER TABLE apps ADD COLUMN IF NOT EXISTS admin_usernames TEXT[] NOT NULL DEFAULT '{}';

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

-- Homescreen icon, source of truth: dapp.json's optional top-level
-- `icon` block ({"emoji": "🎮"} or {"image": "public/icon.png"}),
-- reconciled on every deploy (services/app-manifest.js
-- reconcileAppIcon). Both NULL = the letter-tile fallback the home
-- card always rendered. icon_image_id points at an app_icons row and
-- deliberately carries no FK: the reconcile owns both sides' lifecycle
-- and rotates the id only when the committed bytes change (the
-- /app-icons/:id cache header is immutable, so a new id doubles as
-- the cache-buster).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_emoji VARCHAR(32);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_image_id VARCHAR(32);

-- Fork lineage. NULL for normally-created apps; for a fork it stores a
-- REFERENCE ONLY to the source app: {"appId": <id>, "slug": "<slug>"}.
-- The source's display name is deliberately NOT persisted here — it is
-- resolved LIVE at serialize time (routes/apps.js) by looking the source
-- up by appId, so a rename on the original is reflected immediately and
-- a deleted source resolves to the literal "<deleted>" (link inert).
-- A plain JSONB reference (not an FK) is used on purpose: an FK with
-- ON DELETE would blank the reference exactly when we still want to show
-- "forked from <deleted>". NOT staging:private — lineage renders on the
-- public home feed and must survive into staging clones.
ALTER TABLE apps ADD COLUMN IF NOT EXISTS forked_from JSONB;

-- Icon image bytes, one row per app, keyed by an unguessable random id
-- (same access stance as session_visuals: /app-icons/:id is served
-- unauthenticated so home tiles load it with a plain <img>, and the
-- 32-hex id is the only access control — an icon discloses only
-- itself). Bytes live OFF the apps row on purpose: GET /api/apps
-- spreads SELECT a.* into JSON, and a BYTEA column there would
-- serialize into every list response. NOT staging:private — icons
-- render on the public home feed and should survive into staging
-- clones.
CREATE TABLE IF NOT EXISTS app_icons (
  id           VARCHAR(32) PRIMARY KEY,
  app_id       INTEGER UNIQUE NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  content_type VARCHAR(32) NOT NULL,
  data         BYTEA       NOT NULL,
  sha256       VARCHAR(64) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- Proposal approvers + invites (issue #646), a structural clone of
-- app_collaborators: one table holds both approver members
-- (status='member') and pending invites (status='invited'). A pending
-- invite grants NOTHING — the merge-gate math counts only 'member'
-- rows; declining/revoking deletes the row so re-invites work. Only
-- consulted when apps.approver_policy = 'invited'; rows are kept
-- dormant when the policy flips back to 'anyone'. Deliberately NOT
-- staging:private (like app_collaborators): the roster carries no
-- secrets and must survive into staging clones so the governed-gate
-- math stays testable there. No creator backfill — approvers are
-- opt-in (the reconcile auto-seeds the creator only at the moment an
-- app first switches to 'invited' with an empty roster).
CREATE TABLE IF NOT EXISTS app_approvers (
  app_id      INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      VARCHAR(16) NOT NULL DEFAULT 'member',
  invited_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_approvers_user ON app_approvers(user_id, status);

-- Per-app admins (#788), authority side. A structurally slimmer
-- app_approvers: deliberately NO status/invite columns, because the
-- manifest PR IS the consent mechanism — an admins change is voted in
-- and merged before it ever reaches this table, so there is nothing
-- left to accept. Source of truth is dapp.json's top-level `admins`
-- block, reconciled on every production deploy
-- (services/app-manifest.js reconcileAppAdmins), which makes these rows
-- match the declared list exactly (an explicit empty array clears the
-- roster; an ABSENT block is a no-op). Self-hosted apps are skipped —
-- the platform repo can never mint app admins.
-- An app admin is treated as a second app creator for that ONE app
-- (see services/app-admins.js canManageApp) and may force-merge that
-- app's proposals — except ones flagged requires_explicit_approval,
-- which would be self-escalation.
-- Deliberately NOT staging:private (like app_collaborators /
-- app_approvers): the roster carries no secrets and must survive into
-- staging clones so the access checks keep behaving there.
CREATE TABLE IF NOT EXISTS app_admins (
  app_id     INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_admins_user ON app_admins(user_id);

-- Before/after visuals on UI-affecting proposals (issue #195). Each row is
-- one capture artifact produced by the one-shot usernode-capture container
-- after a staging preview comes up healthy: kind = before (production) /
-- after (staging), media = png (still) / webm (in-app <video> clip) /
-- gif (PR-body inline embed). Retention is latest-set-per-session only —
-- src/services/visuals.js deletes the session's prior rows before
-- inserting a fresh capture, so growth is bounded per session (<= 8
-- artifacts per captured path — a full-media desktop group plus a
-- PNG-only mobile group — times CAPTURE_MAX_PATHS routes).
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
  -- #768: viewport label the group was shot at ('mobile' for a testing
  -- path annotated `@mobile`; NULL = the default desktop frame). Renderers
  -- suffix labelled groups with "(mobile)" so reviewers know what frame
  -- they're looking at. NULL on pre-#768 rows — desktop by definition.
  captured_viewport VARCHAR(16),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS capture_index SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS captured_viewport VARCHAR(16);
-- Capture-outcome columns (screenshot-reliability spec):
--   shot_status      : HTTP status the shot's navigation answered with
--                      (NULL on pre-outcome rows).
--   before_fell_back : TRUE when this "before" artifact was actually shot
--                      at '/' because the deep testing path 404'd / failed
--                      on production (the page didn't exist there yet).
--                      Renderers caption the pair so reviewers aren't
--                      confused by a mismatched comparison.
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS shot_status SMALLINT;
ALTER TABLE session_visuals ADD COLUMN IF NOT EXISTS before_fell_back BOOLEAN NOT NULL DEFAULT FALSE;
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

-- Admin /debug merge & conflict-resolution logs. Each merge attempt (or
-- automatic conflict-resolution attempt) is a "run"; every step inside it
-- (gate check, GitHub merge call, worker sync phase, outcome) is a child
-- row ordered by `seq`. Written fire-and-forget by services/merge-debug.js
-- and read only by the admin-gated /api/debug/* endpoints.
CREATE TABLE IF NOT EXISTS merge_debug_runs (
  id          BIGSERIAL PRIMARY KEY,
  app_id      INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  session_id  INTEGER REFERENCES chat_sessions(id) ON DELETE SET NULL,
  pr_number   INTEGER,
  -- 'merge' | 'conflict_resolution'
  kind        VARCHAR(32) NOT NULL DEFAULT 'merge',
  -- 'vote' | 'force' | 'post_merge_sweep' | 'drift' | 'behind_main' | 'merge_conflict'
  trigger     VARCHAR(48),
  -- running | merged | blocked | conflict_resolving | conflict_failed
  --   | awaiting_github | noop | error
  status      VARCHAR(32) NOT NULL DEFAULT 'running',
  summary     TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_merge_debug_runs_app     ON merge_debug_runs (app_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_debug_runs_session ON merge_debug_runs (session_id);
CREATE INDEX IF NOT EXISTS idx_merge_debug_runs_started ON merge_debug_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS merge_debug_steps (
  id         BIGSERIAL PRIMARY KEY,
  run_id     BIGINT NOT NULL REFERENCES merge_debug_runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  phase      VARCHAR(48),
  -- info | warn | error
  level      VARCHAR(8) NOT NULL DEFAULT 'info',
  message    TEXT,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_merge_debug_steps_run ON merge_debug_steps (run_id, seq);

-- staging:private — these rows carry internal session ids, conflict file
-- paths, error text and resolution details that mirror private build
-- history; they're TRUNCATEd in staging clones rather than leaking into
-- previews (same policy as the events / proposal_ai_messages tables). The
-- /debug view seeds its own mock runs under IS_STAGING + ?demo=1.
COMMENT ON TABLE merge_debug_runs  IS 'staging:private';
COMMENT ON TABLE merge_debug_steps IS 'staging:private';

-- #460: per-user global agent instruction & skill files. Uploaded in the
-- account Settings modal ("Agent instructions & skills") and materialized
-- into the per-session CC volume (~/.claude/CLAUDE.md + ~/.claude/skills/)
-- at every build/scout dispatch the user owns — see
-- services/user-agent-files.js + worker.syncUserAgentFiles. Contents are
-- plain user-authored text (NOT secrets — no encryption), but they are
-- personal scratch config with no value in a staging clone, so the table
-- ships schema-only + empty there (staging:private); the Settings section
-- uses ?demo=1 fabricated rows for staging previews instead.
CREATE TABLE IF NOT EXISTS user_agent_files (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'instruction' | 'skill'
  kind        VARCHAR(16) NOT NULL CHECK (kind IN ('instruction', 'skill')),
  -- normalized slug: ^[a-z0-9][a-z0-9-]{0,63}$
  name        VARCHAR(64) NOT NULL,
  description VARCHAR(200) NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_user_agent_files_user ON user_agent_files (user_id, kind, name);
COMMENT ON TABLE user_agent_files IS 'staging:private';

-- Dev-chat file attachments (#450). Users attach files to dev-chat
-- messages as extra context for the Mayor, scout, and coding agent.
-- Bytea-in-Postgres like session_visuals (the platform container
-- has no persistent file volume); ids are random 32-hex tokens generated
-- in Node. message_id is NULL between upload and send — the chat handler
-- links it when the message posts, and server.js's session sweeper GCs
-- orphans older than 24h. Retention otherwise follows the parent session
-- (ON DELETE CASCADE), bounded by a 50 MB per-session cap at upload time.
CREATE TABLE IF NOT EXISTS chat_session_attachments (
  id           VARCHAR(32) PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  message_id   INTEGER REFERENCES chat_session_messages(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 'image' (png/jpeg/gif/webp, magic-byte verified) | 'text' (UTF-8,
  -- inlined into prompts) | 'zip' (central-directory-validated archive)
  -- | 'binary' (opaque pass-through for the coding agent)
  kind         VARCHAR(8)   NOT NULL,
  filename     VARCHAR(256) NOT NULL,
  content_type VARCHAR(64)  NOT NULL,
  size_bytes   INTEGER      NOT NULL,
  -- Kind-specific metadata captured at upload; for 'zip' the manifest
  -- { entryCount, uncompressedBytes, topLevel } from validateZip.
  meta         JSONB,
  data         BYTEA        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
ALTER TABLE chat_session_attachments ADD COLUMN IF NOT EXISTS meta JSONB;
CREATE INDEX IF NOT EXISTS idx_chat_session_attachments_session ON chat_session_attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_attachments_message ON chat_session_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_attachments_orphan
  ON chat_session_attachments(created_at) WHERE message_id IS NULL;

-- Private like its parent chat_sessions (public-FK-to-private is the
-- combination the migration linter forbids), and the bytes are private
-- chat content in their own right — screenshots and files a user shared
-- with their own dev session only. Schema-only in staging clones;
-- migrate.js seeds a demo fixture so the UI is exercisable there.
COMMENT ON TABLE chat_session_attachments IS 'staging:private';

-- Fallback-title marker for the title auto-heal sweeper (services/
-- title-heal.js). TRUE when the PR's title came from the LLM-unavailable
-- fallback template ("<user>'s changes") — e.g. Anthropic credits ran out
-- or the API errored — instead of the generated one. The sweeper retries
-- generation while this is set and clears it on success; the vote panel
-- renders an "Auto-title pending" chip off the same flag so voters know
-- the placeholder isn't the real description of the change.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pr_title_fallback BOOLEAN NOT NULL DEFAULT FALSE;

-- Feedback issues filed with the fallback title ("Feedback from Usernode")
-- because the Haiku title call failed (routes/feedback.js). The issue is
-- filed immediately regardless — never block feedback on LLM availability —
-- and a row lands here so the title-heal sweeper can regenerate the title
-- from the stored description and PATCH the GitHub issue later. Rows are
-- deleted on success or abandoned after MAX_ATTEMPTS (title-heal.js);
-- next_attempt_at implements per-row exponential backoff.
CREATE TABLE IF NOT EXISTS title_heal_queue (
  id              SERIAL PRIMARY KEY,
  owner           TEXT NOT NULL,
  repo            TEXT NOT NULL,
  issue_number    INTEGER NOT NULL,
  description     TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner, repo, issue_number)
);
CREATE INDEX IF NOT EXISTS idx_title_heal_queue_due ON title_heal_queue(next_attempt_at);

-- #683: drag-selected screenshots attached to filed GitHub issues from
-- the feedback modal. Bytea-in-Postgres like session_visuals (the
-- platform container has no persistent file volume); rows are served on
-- the public pre-auth GET /issue-images/:id route, so the unguessable
-- 32-hex id is the only privacy layer — same stance as visuals, and the
-- user explicitly published the image into a GitHub issue body.
-- issue_owner/repo/number are stamped when the issue is filed; rows
-- never linked (upload abandoned / modal cancelled) are GC'd by the
-- server.js orphan sweeper after 24h.
CREATE TABLE IF NOT EXISTS issue_screenshots (
  id            VARCHAR(32) PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type  VARCHAR(32) NOT NULL,
  size_bytes    INTEGER NOT NULL,
  data          BYTEA NOT NULL,
  issue_owner   TEXT,
  issue_repo    TEXT,
  issue_number  INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_issue_screenshots_orphan
  ON issue_screenshots(created_at) WHERE issue_number IS NULL;
-- Private: the bytea can contain anything visible on the reporter's
-- screen; staging gets the schema only.
COMMENT ON TABLE issue_screenshots IS 'staging:private';

-- Group-chat file attachments (#694). Users attach files to group-chat
-- messages (images, markdown, standalone HTML, anything else as a
-- download). Same bytea-in-Postgres shape as chat_session_attachments
-- (#450): ids are random 32-hex tokens generated in Node; message_id is
-- NULL between upload and send — the WS 'chat' handler links it when the
-- message posts, and server.js's sweeper GCs orphans older than 24h.
-- Retention otherwise follows the parent message (ON DELETE CASCADE),
-- bounded by a 200 MB per-app cap at upload time.
CREATE TABLE IF NOT EXISTS chat_message_attachments (
  id           VARCHAR(32) PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  message_id   INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 'image' (png/jpeg/gif/webp, magic-byte verified) | 'markdown'
  -- (.md/.markdown UTF-8, rendered in the chat's side panel) | 'html'
  -- (.html/.htm UTF-8, previewable only via the sandboxed /view route)
  -- | 'text' (other UTF-8, download-only) | 'binary' (opaque download)
  kind         VARCHAR(8)   NOT NULL,
  filename     VARCHAR(256) NOT NULL,
  content_type VARCHAR(64)  NOT NULL,
  size_bytes   INTEGER      NOT NULL,
  meta         JSONB,
  data         BYTEA        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_app ON chat_message_attachments(app_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_message ON chat_message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_orphan
  ON chat_message_attachments(created_at) WHERE message_id IS NULL;

-- staging:private: chat_messages itself is staging-copied (group chat is
-- shared content), but copying every app's attachment BLOBS into every
-- staging clone would balloon clone size for no testing value — the
-- migrate.js fixture seeds a demo message with attachments instead.
-- Private-FK-to-public is the allowed direction for the migration linter
-- (the forbidden combination is a public table FK'ing a private one).
COMMENT ON TABLE chat_message_attachments IS 'staging:private';

-- App file storage (#752): user-uploaded images apps store through the
-- platform (usernode.uploadFile() / POST /api/app-storage/files). This
-- table holds METADATA ONLY — the bytes live in the MinIO object-store
-- sidecar under key `app/<app_id>/<id>` (see services/app-files.js), so
-- the platform DB, its pg_dump backups, and self-app staging clones
-- never carry image payloads. Ids are random 16-byte hex, served on the
-- public pre-auth GET /app-files/:id route — the unguessable id is the
-- access control for visibility='public' rows (same stance as
-- app_icons); visibility='private' rows additionally require a valid
-- platform user JWT at serve time. `staging` marks uploads made from a
-- staging preview (bridge relay path); the server.js sweeper GCs those
-- after 7 days. Quota sums (per app / per app+user) read size_bytes.
CREATE TABLE IF NOT EXISTS app_files (
  id           VARCHAR(32) PRIMARY KEY,
  app_id       INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename     VARCHAR(256) NOT NULL,
  content_type VARCHAR(64)  NOT NULL,
  size_bytes   INTEGER      NOT NULL,
  visibility   VARCHAR(7)   NOT NULL DEFAULT 'public',
  staging      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_files_app ON app_files(app_id);
CREATE INDEX IF NOT EXISTS idx_app_files_app_user ON app_files(app_id, user_id);
CREATE INDEX IF NOT EXISTS idx_app_files_staging
  ON app_files(created_at) WHERE staging = TRUE;
-- Private: upload ownership is user content a staging clone has no
-- business seeing (same stance as issue_screenshots). Rows are metadata
-- only, so this is about privacy, not clone size. Private-FK-to-public
-- is the allowed linter direction.
COMMENT ON TABLE app_files IS 'staging:private';

-- Per-app credential for the app-storage API (#752), the exact
-- llm_proxy_token pattern: random 64-hex generated lazily at first
-- production deploy (services/app-storage-env.js), injected as
-- USERNODE_STORAGE_TOKEN into production containers only. Staging
-- deploys never receive it. Credential-bearing: tagged staging:private
-- AND listed in debug-access.js's DENIED_COLUMNS (the
-- prod-debug-access test cross-checks the two).
ALTER TABLE apps ADD COLUMN IF NOT EXISTS storage_api_token VARCHAR(64);
COMMENT ON COLUMN apps.storage_api_token IS 'staging:private';
