// What the Homeroom bot's loop machines (bot-request, bot-lane) and the old
// module that does the bot's reads and fixes (services/homeroom-bot.js)
// share: the instance keys, the queue's reasons, how long a burst settles,
// how a refused look backs off, which requests wait for their project's
// first version, the lane's candidates and its picks. Pure: the old module
// requires it at load, so it imports nothing but other rules.
//
// workflow-foundation's design-bot-loop.md is the design.

import { isAppendOnly } from './append-only-files.ts';

export const BOT_REQUEST = 'bot-request';
export const BOT_LANE = 'bot-lane';
export const LANE_KEY = 'bot';

// One instance per request the bot may look at: the project and the
// request's number (homeroom_bot_queue's own identity).
export const requestKey = (appId: number, issueNumber: number) => `request:${Number(appId)}:${Number(issueNumber)}`;
export function parseRequestKey(key: string): { appId: number; issueNumber: number } | null {
  const m = /^request:(\d+):(\d+)$/.exec(String(key || ''));
  return m ? { appId: Number(m[1]), issueNumber: Number(m[2]) } : null;
}

// The key a request's activity card is kept under (homeroom-bot-activity.js
// jobCardKey): a new request's first card is the request's own (its
// refresh starts it, its first read goes on with it); every other look has
// its own, by the look's number, the same across its retries.
export const lookCardKey = (appId: number, issueNumber: number, n: number | null = null) =>
  `r${Number(appId)}-${Number(issueNumber)}${n ? `-${Number(n)}` : ''}`;

// Queue reasons the machines decide on (the rest are the callers' words).
export const CHECKS_REASON = 'checks_failing';
export const READ_AGAIN_REASON = 'read_again';
export const BUDGET_RETRY_REASON = 'budget_retry';
export const RESTART_REASON = 'restart';
export const BACKLOG_REASON = 'backlog';
export const ADMIN_REASON = 'admin';
// The debts a refresh keeps while their request is unchanged and nobody
// else's: the bot's own (a failing check's, a read started over, a look
// cut by the budget, an older release's restart) and an older request's
// backlog read. A budget retry is one (trace L6: the refresh pruned it).
export const KEPT_WHILE_QUIET_REASONS: ReadonlySet<string> = new Set([
  RESTART_REASON, CHECKS_REASON, READ_AGAIN_REASON, BACKLOG_REASON, BUDGET_RETRY_REASON,
]);

// One turn for a burst: a request a person is still writing on (or on the
// bot's change for it) is read once they pause this long.
export const SETTLE_MS = 20 * 1000;

// A look refused for now (its proposal's session busy: a sync, a shots run,
// a person's turn) waits this long, doubling to the ceiling.
export const BACKOFF_BASE_MS = 2 * 60 * 1000;
export const BACKOFF_CEILING_MS = 60 * 60 * 1000;
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
}

// The platform failing under the bot (a provider, the worker quota, its
// key) pauses every grant this long, doubling to the ceiling; a look that
// ran ends it. The request it failed on waits too (backoffMs, its own
// count), so one request that always fails is retried at most hourly
// rather than pausing every grant each time it comes round; and its
// FAULT_TRIES-th fault in a row is recorded as a failed read of its thread
// (services/homeroom-bot.js recordFailure), which the refresh counts, so it
// is not owed forever.
export const FAULT_TRIES = 3;
// A look whose work threw on every attempt (a code bug, data it cannot
// read) is no outage: it pauses nothing else, waits on its own count, and
// after THROWN_TRIES in a row is held a day (a person's ask lifts the hold).
export const THROWN_TRIES = 5;
export const THROWN_HOLD_MS = 24 * 60 * 60 * 1000;
export const FAULT_BASE_MS = 2 * 60 * 1000;
export const FAULT_CEILING_MS = 60 * 60 * 1000;
export function faultMs(attempts: number): number {
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  return Math.min(FAULT_CEILING_MS, FAULT_BASE_MS * 2 ** (n - 1));
}
// The bot's weekly cap reached: grants wait this long before one look
// checks it again (the look checks it; nothing is granted meanwhile).
export const BUDGET_PAUSE_MS = 60 * 1000;

// The refresh against GitHub, every five minutes, and a targeted one asked
// for (a person wrote on an idle request, a merge, a settings change) once
// things have been quiet this long.
export const REFRESH_EVERY_MS = 5 * 60 * 1000;
export const REFRESH_SOON_MS = 20 * 1000;

// A ready verdict's build waits this long for its turn before it is
// forgotten by the read lane (classifyIssue's window).
export const ABANDONED_LIVE_WINDOW_DAYS = 7;

// The settings the lane decides from, read from platform_settings.
export const KEY_MODE = 'homeroom_bot_mode';
export const KEY_PAUSED_APPS = 'homeroom_bot_paused_apps';
export const KEY_LIVE_AT_ONCE = 'homeroom_bot_live_at_once';
export const KEY_PER_PERSON = 'homeroom_bot_per_person';
// 3 Nov 2026: how many of one project's requests are read at once, each on
// a triage session of its own (its read slot: homeroom-bot.js
// ensureBotSession). Reads were one per project, behind the project's one
// session: on Homeroom's own board a request once waited behind 35 others,
// though a read only reads the code and costs a few cents.
export const KEY_READS_PER_APP = 'homeroom_bot_reads_per_app';
// 3 Nov 2026: a project's builds under way at once is the same setting as
// its builds waiting or under way (homeroom-bot.js BUILDS_PER_APP, or the
// project's own number in KEY_APP_CAPS). It used to be a fixed 3 here, so
// the console said 5 while only 3 ran and the other 2 waited.
export const BUILDS_PER_APP = 5;
export const MAX_BUILDS_PER_APP = 10;
export const KEY_APP_CAPS = 'homeroom_bot_app_caps';
export const LANE_SETTING_KEYS: readonly string[] = Object.freeze([KEY_MODE, KEY_PAUSED_APPS, KEY_LIVE_AT_ONCE, KEY_PER_PERSON, KEY_READS_PER_APP, KEY_APP_CAPS]);
export const MODES: readonly string[] = Object.freeze(['off', 'shadow', 'live']);
export const MAX_LIVE_AT_ONCE = 24;
export const MAX_PER_PERSON = 6;
export const MAX_READS_PER_APP = 6;
export const LANE_DEFAULTS = Object.freeze({
  mode: 'off', pausedApps: [] as string[], liveAtOnce: 12, perPerson: 3, readsPerApp: 3,
  buildsByApp: {} as Record<string, number>,
});

export interface LaneSettings {
  mode: string; pausedApps: string[]; liveAtOnce: number; perPerson: number; readsPerApp: number;
  buildsByApp: Record<string, number>;
}

// The `source` of a further read slot's triage session (slot 1 and up:
// homeroom-bot.js ensureBotSession), with its slot after the colon. Slot 0
// is the triage session as it always was, with no source; what has this one
// is never slot 0's.
export const READ_SESSION_SOURCE = 'homeroom_bot_read';
export const readSessionSource = (slot: number) => `${READ_SESSION_SOURCE}:${Number(slot)}`;

// The bot-request machine version from which a read runs on the triage
// session of the read slot its grant names (`readSlot`). An older release
// runs every read of a project on its newest triage session, whatever the
// grant says, so a read that an older release may run (its request last
// written by an older version, or granted with no slot) takes the whole
// project's reads while it runs, as every read did before (pickLive). The
// machine's own version is never below this (tests pin it).
export const READ_SLOTS_SINCE = 2;

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// A project's key in KEY_APP_CAPS: its id, as JSON keeps it, and the most
// projects with a number of their own the setting keeps.
const APP_ID_KEY_RE = /^[1-9][0-9]{0,9}$/;
const MAX_APP_CAPS = 1000;

// #6156: the stored per-project build numbers (KEY_APP_CAPS), as the lane
// reads them: an app id maps to its `building`, clamped to 1..MAX_BUILDS_PER_APP.
// A project with no building left out. Never throws: what does not parse is
// no project's.
function parseBuildsByApp(raw: unknown): Record<string, number> {
  let parsed: any;
  try {
    parsed = JSON.parse(String(raw || '{}'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed).slice(0, MAX_APP_CAPS)) {
    if (!APP_ID_KEY_RE.test(key) || !value || typeof value !== 'object') continue;
    const n = parseInt(String((value as any).building ?? ''), 10);
    if (Number.isFinite(n)) out[key] = Math.min(MAX_BUILDS_PER_APP, Math.max(1, n));
  }
  return out;
}

// The lane's settings from platform_settings rows ({ key, value }). The mode
// `shadow` acts as `live` (it always did outside a staging copy: the
// shadow lanes are gone, design-bot-loop.md D2).
export function laneSettings(rows: { key: string; value: string | null }[]): LaneSettings {
  const map = new Map((rows || []).map((r) => [r.key, r.value]));
  const mode = MODES.includes(String(map.get(KEY_MODE))) ? String(map.get(KEY_MODE)) : LANE_DEFAULTS.mode;
  let pausedApps: string[] = [];
  try {
    const parsed = JSON.parse(map.get(KEY_PAUSED_APPS) || '[]');
    if (Array.isArray(parsed)) pausedApps = parsed.filter((s: unknown) => typeof s === 'string').slice(0, 500);
  } catch { pausedApps = []; }
  return {
    mode, pausedApps,
    liveAtOnce: clampInt(map.get(KEY_LIVE_AT_ONCE), LANE_DEFAULTS.liveAtOnce, 1, MAX_LIVE_AT_ONCE),
    perPerson: clampInt(map.get(KEY_PER_PERSON), LANE_DEFAULTS.perPerson, 1, MAX_PER_PERSON),
    readsPerApp: clampInt(map.get(KEY_READS_PER_APP), LANE_DEFAULTS.readsPerApp, 1, MAX_READS_PER_APP),
    buildsByApp: parseBuildsByApp(map.get(KEY_APP_CAPS)),
  };
}

// Whether the bot acts at all here: on, and not a staging copy (which runs
// no worker turns: docs/kubernetes-operations.md).
export const botOn = (s: LaneSettings, staging: boolean) => s.mode !== 'off' && !staging;

// ── A project's first version goes first ────────────────────────────────
//
// While a project's first version is not live, the bot starts nothing else
// on that project: no other request is read and no other build starts
// (homeroom-bot.js has the story, Flat 4B Chores, 4 October 2026). `fv` is
// the first-version row (homeroom_bot_first_versions); the read lane, the
// build lane and the card read this one rule.
export const FIRST_VERSION_PENDING_SQL = `(
         (fv.status IN ('waiting', 'filing') AND fv.created_at > NOW() - INTERVAL '24 hours')
         OR (fv.status = 'filed' AND fv.issue_number IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM chat_sessions fvm
              WHERE fvm.app_id = fv.app_id AND fvm.status = 'merged'
                AND fv.issue_number = ANY(fvm.linked_issues))
           AND NOT EXISTS (
             SELECT 1 FROM homeroom_bot_runs fvr JOIN chat_sessions fvp ON fvp.id = fvr.proposal_session_id
              WHERE fvr.app_id = fv.app_id AND fvr.issue_number = fv.issue_number AND fvp.status = 'merged')
           AND NOT EXISTS (
             SELECT 1 FROM issues fvi
              WHERE fvi.app_id = fv.app_id AND fvi.github_issue_number = fv.issue_number
                AND fvi.kind = 'general' AND fvi.status = 'closed')
           AND (
             EXISTS (
               SELECT 1 FROM homeroom_bot_queue fvq
                WHERE fvq.app_id = fv.app_id AND fvq.issue_number = fv.issue_number)
             OR (COALESCE(fv.filed_at, fv.created_at) > NOW() - INTERVAL '24 hours'
                 AND NOT EXISTS (
                   SELECT 1 FROM homeroom_bot_runs fvn
                    WHERE fvn.app_id = fv.app_id AND fvn.issue_number = fv.issue_number))
             OR EXISTS (
               SELECT 1
                 FROM (SELECT fvlr.mode, fvlr.verdict, fvlr.build_ok, fvlr.proposal_session_id
                         FROM homeroom_bot_runs fvlr
                        WHERE fvlr.app_id = fv.app_id AND fvlr.issue_number = fv.issue_number
                          AND fvlr.budget_stop IS DISTINCT FROM 'input tokens'
                          AND (fvlr.error IS NULL OR fvlr.error NOT LIKE 'collateral:%')
                        ORDER BY fvlr.id DESC LIMIT 1) fvl
                 LEFT JOIN LATERAL (
                   SELECT fvcs.status
                     FROM homeroom_bot_runs fvcr JOIN chat_sessions fvcs ON fvcs.id = fvcr.proposal_session_id
                    WHERE fvcr.app_id = fv.app_id AND fvcr.issue_number = fv.issue_number
                    ORDER BY fvcr.id DESC LIMIT 1) fvc ON TRUE
                WHERE fvl.mode = 'live'
                  AND (fvc.status IN ('promoted', 'merging')
                       OR (fvl.build_ok IS NOT FALSE AND fvl.verdict NOT IN ('person', 'empty', 'failed')
                           AND (fvc.status IS NULL OR fvc.status NOT IN ('closed', 'archived')
                                OR (fvl.verdict IN ('ready', 'question') AND fvl.build_ok IS NULL
                                    AND fvl.proposal_session_id IS NULL)))))))
       )`;

// ── The bot waits for your plan (threads, one loop: phase B) ────────────
//
// 1 Nov 2026: while the person who asked for a request works on it with
// the bot in a private thread about it (private_threads, about_kind
// 'request', opened by them: `holds_bot`), the bot neither reads nor
// builds it. The hold lifts when a plan is posted on the request, when they
// tap Let the bot build it now (`hold_lifted_at`), or by itself once the
// thread has been quiet for PLAN_HOLD_DAYS. Somebody else's private thread
// never holds a request: only the requester's (`person`). A follow-up on
// the bot's change already up for a vote, and an admin's Run now, are not
// held, as the first version's hold leaves them. `appId`, `issueNumber` and
// `person` are SQL expressions of the caller's query.
export const PLAN_HOLD_DAYS = 7;
export const PLAN_HOLD_REASON = 'awaiting_plan';
// A private_threads row (alias `p`) that holds the bot now, whoever asked:
// its requester's, not lifted, still open, and written in within the week.
export const planHoldActiveSql = (p: string) => `${p}.about_kind = 'request' AND ${p}.holds_bot
          AND ${p}.hold_lifted_at IS NULL AND ${p}.state = 'open'
          AND GREATEST(${p}.created_at, COALESCE((SELECT MAX(phm.created_at) FROM conversation_messages phm
                                                   WHERE phm.thread_root_id = ${p}.root_message_id
                                                     AND phm.deleted_at IS NULL), ${p}.created_at))
              > NOW() - make_interval(days => ${PLAN_HOLD_DAYS})`;
// `holds_bot` was set because the thread's person asked for the request;
// `person` (who asks for it now) keeps it so if that ever changes.
export const planHoldSql = (appId: string, issueNumber: string, person: string) => `EXISTS (
       SELECT 1 FROM private_threads ph
        WHERE ph.app_id = ${appId} AND ph.about_number = ${issueNumber}
          AND (${person} IS NULL OR ph.user_id = ${person})
          AND ${planHoldActiveSql('ph')})`;

// ── The lane's candidates ───────────────────────────────────────────────

// A Granted message on its way to a request (not applied yet): the lane
// counts it as in use, and never grants that request twice.
const GRANT_PENDING = (k: string) => `EXISTS (SELECT 1 FROM wf_events g
                    WHERE g.machine = '${BOT_REQUEST}' AND g.key = ${k}
                      AND g.type = 'Granted' AND g.status = 'pending')`;

// The slots in use: what each request that took one carries (data.slot:
// only a look or a build under way holds one), and the grants not applied
// yet. An instance an admin must look at (flagged) holds none: its grant
// is never applied, and counting it would cost a slot until it is cleared.
// One row each: { key, app_id, slot, machine_version }, the version that
// last wrote the request (for a grant on its way, the request it goes to):
// below READ_SLOTS_SINCE, an older release may be running its read.
export const SLOTS_IN_USE_SQL = `
  SELECT w.key, w.app_id, w.data->'slot' AS slot, w.machine_version FROM wf_instances w
   WHERE w.machine = '${BOT_REQUEST}' AND w.state IN ('reading', 'following_up', 'building')
     AND jsonb_typeof(w.data->'slot') = 'object' AND w.flag IS NULL
  UNION ALL
  SELECT g.key, g.app_id, g.payload AS slot, t.machine_version FROM wf_events g
    LEFT JOIN wf_instances t ON t.machine = g.machine AND t.key = g.key
   WHERE g.machine = '${BOT_REQUEST}' AND g.type = 'Granted' AND g.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM wf_instances f WHERE f.machine = g.machine AND f.key = g.key AND f.flag IS NOT NULL)`;

// The reads and follow-ups waiting for a slot, in the order they are taken:
// a person's ask first, then follow-ups on the bot's changes up for a vote
// (somebody is usually waiting there), then priority, then age. Each with
// who it is for ($1: the bot's user id, for its changes). Only the apps
// the bot acts on ($2: every app but these paused slugs), only what is not
// held for its payer's week or backed off, not a request whose live build
// waits or runs, not one its project's first version holds, not one its
// requester is working on with the bot (planHoldSql), and settled. With
// each, the version that last wrote its request (READ_SLOTS_SINCE).
export const READ_CANDIDATES_SQL = `
  SELECT q.app_id, q.issue_number, q.priority, q.reason,
         COALESCE(r.user_id, i.created_by) AS person_id,
         fu.id AS follow_up_session_id, bs.id AS triage_session_id,
         w.machine_version
    FROM homeroom_bot_queue q
    JOIN apps a ON a.id = q.app_id
    JOIN wf_instances w ON w.machine = '${BOT_REQUEST}' AND w.key = 'request:' || q.app_id || ':' || q.issue_number
                       AND w.state = 'queued' AND w.flag IS NULL
    LEFT JOIN homeroom_bot_requesters r ON r.app_id = q.app_id AND r.issue_number = q.issue_number
    LEFT JOIN LATERAL (
      SELECT created_by FROM issues
       WHERE app_id = q.app_id AND github_issue_number = q.issue_number
       ORDER BY id LIMIT 1
    ) i ON TRUE
    LEFT JOIN LATERAL (
      SELECT cs.id FROM chat_sessions cs
       WHERE cs.app_id = q.app_id AND cs.user_id = $1
         AND q.issue_number = ANY(cs.linked_issues)
         AND cs.status = 'promoted' AND cs.is_headless = FALSE
       ORDER BY cs.id DESC LIMIT 1
    ) fu ON TRUE
    -- The app's triage session, when it has one yet (homeroom-bot.js
    -- ensureBotSession's own rule for read slot 0): where its first read
    -- slot's read runs. A further slot's session is the look's to find.
    LEFT JOIN LATERAL (
      SELECT cs.id FROM chat_sessions cs
       WHERE cs.user_id = $1 AND cs.app_id = q.app_id AND cs.status IN ('active', 'paused')
         AND cs.branch_name = 'main'
         AND NOT EXISTS (SELECT 1 FROM homeroom_bot_runs br WHERE br.build_session_id = cs.id)
         AND NOT EXISTS (SELECT 1 FROM homeroom_bot_look_sessions ls WHERE ls.session_id = cs.id)
         AND (cs.source IS NULL OR cs.source NOT LIKE '${READ_SESSION_SOURCE}:%')
       ORDER BY cs.id DESC LIMIT 1
    ) bs ON fu.id IS NULL
   WHERE q.started_at IS NULL
     AND NOT (a.slug = ANY($2::text[]))
     AND (q.held_until IS NULL OR q.held_until <= NOW())
     AND (q.wait_until IS NULL OR q.wait_until <= NOW())
     AND NOT ${GRANT_PENDING('w.key')}
     AND NOT EXISTS (
       SELECT 1 FROM homeroom_bot_runs b
        WHERE b.app_id = q.app_id AND b.issue_number = q.issue_number
          AND b.mode = 'live' AND b.verdict = 'ready' AND b.build_ok IS NULL AND b.proposal_session_id IS NULL
          AND (b.live_build_waiting_at IS NOT NULL OR b.build_session_id IS NOT NULL)
          AND b.created_at > NOW() - make_interval(days => ${ABANDONED_LIVE_WINDOW_DAYS})
     )
     AND (fu.id IS NOT NULL OR q.reason = '${ADMIN_REASON}' OR NOT EXISTS (
       SELECT 1 FROM homeroom_bot_first_versions fv
        WHERE fv.app_id = q.app_id AND fv.bot_builds AND fv.issue_number IS DISTINCT FROM q.issue_number
          AND ${FIRST_VERSION_PENDING_SQL}
     ))
     AND NOT EXISTS (
       SELECT 1 FROM chat_messages m
         LEFT JOIN users mu ON mu.id = m.user_id
        WHERE m.app_id = q.app_id AND m.msg_type = 'message' AND m.deleted_at IS NULL
          AND mu.is_synthetic IS NOT TRUE
          AND ((m.thread_type = 'issue' AND m.thread_ref = q.issue_number)
            OR (fu.id IS NOT NULL AND m.thread_type = 'session' AND m.thread_ref = fu.id))
          AND m.created_at > NOW() - make_interval(secs => ${SETTLE_MS / 1000})
     )
     AND (fu.id IS NOT NULL OR q.reason = '${ADMIN_REASON}'
          OR NOT ${planHoldSql('q.app_id', 'q.issue_number', 'COALESCE(r.user_id, i.created_by)')})
   ORDER BY (q.priority = 0) DESC, (fu.id IS NOT NULL) DESC, q.priority, q.enqueued_at
   LIMIT 200`;

// The live builds waiting for a slot, oldest first: requests in
// `building` whose build was not granted yet, on apps the bot acts on
// ($1: paused slugs), not held by their project's first version nor by
// their requester's plan (planHoldSql).
export const BUILD_CANDIDATES_SQL = `
  SELECT w.app_id, (w.data->>'issueNumber')::int AS issue_number, (w.data->'build'->>'runId')::int AS run_id,
         COALESCE(rq.user_id, i.created_by) AS person_id
    FROM wf_instances w
    JOIN apps a ON a.id = w.app_id
    LEFT JOIN homeroom_bot_requesters rq ON rq.app_id = w.app_id AND rq.issue_number = (w.data->>'issueNumber')::int
    LEFT JOIN LATERAL (
      SELECT created_by FROM issues
       WHERE app_id = w.app_id AND github_issue_number = (w.data->>'issueNumber')::int
       ORDER BY id LIMIT 1
    ) i ON TRUE
   WHERE w.machine = '${BOT_REQUEST}' AND w.state = 'building' AND w.data->'build'->>'phase' = 'waiting' AND w.flag IS NULL
     AND (w.data->'build'->>'heldUntil' IS NULL OR (w.data->'build'->>'heldUntil')::timestamptz <= NOW())
     AND NOT (a.slug = ANY($1::text[]))
     AND NOT ${GRANT_PENDING('w.key')}
     AND NOT EXISTS (
       SELECT 1 FROM homeroom_bot_first_versions fv
        WHERE fv.app_id = w.app_id AND fv.bot_builds AND fv.issue_number IS DISTINCT FROM (w.data->>'issueNumber')::int
          AND ${FIRST_VERSION_PENDING_SQL}
     )
     AND NOT ${planHoldSql('w.app_id', "(w.data->>'issueNumber')::int", 'COALESCE(rq.user_id, i.created_by)')}
   ORDER BY w.data->'build'->>'since', w.key
   LIMIT 50`;

// When the next request waiting becomes eligible (its payer's week, its
// backoff, or its burst settling), so the lane looks again then. A burst
// is read as READ_CANDIDATES_SQL reads it (the request's thread, and its
// change's for a follow-up); the earliest message still settling is the
// next time to look, which may be early (the lane then waits again), never
// late.
export const NEXT_ELIGIBLE_SQL = `
  SELECT MIN(t) AS at FROM (
    SELECT q.held_until AS t FROM homeroom_bot_queue q WHERE q.started_at IS NULL AND q.held_until > NOW()
    UNION ALL
    SELECT q.wait_until FROM homeroom_bot_queue q WHERE q.started_at IS NULL AND q.wait_until > NOW()
    UNION ALL
    SELECT m.created_at + make_interval(secs => ${SETTLE_MS / 1000})
      FROM homeroom_bot_queue q
      JOIN chat_messages m ON m.app_id = q.app_id AND m.msg_type = 'message' AND m.deleted_at IS NULL
                          AND ((m.thread_type = 'issue' AND m.thread_ref = q.issue_number)
                            OR (m.thread_type = 'session' AND m.thread_ref IN (
                                  SELECT cs.id FROM chat_sessions cs
                                   WHERE cs.app_id = q.app_id AND q.issue_number = ANY(cs.linked_issues)
                                     AND cs.status = 'promoted')))
     WHERE q.started_at IS NULL AND m.created_at > NOW() - make_interval(secs => ${SETTLE_MS / 1000})
  ) n`;

// ── Overlap with other changes (#6423) ──────────────────────────────────
//
// Before a build uses its building slot, the files its plan names are
// compared with the files the project's other open changes and its running
// builds touch. On an overlap the build waits for the other one, builds on
// top of it, or goes ahead in parallel (append-only shared files only), and
// says which in its request's thread and on its track.

// How long a build waits for the overlapping change before it builds on
// main anyway.
export const OVERLAP_WAIT_MS = 2 * 60 * 60 * 1000;

// The most file names one plan is read for.
export const NAMED_FILES_CAP = 200;

// The repository paths a plan names: a token with a slash and an extension
// (`src/features/ai/lists.tsx`, `tests/x.test.js`), backticks and the
// punctuation around it stripped. Plans quote them in prose, tables and
// lists alike; what they never do is name a path without a slash.
export function filesNamed(text: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+\.[A-Za-z0-9]+/g;
  for (const m of String(text ?? '').matchAll(re)) {
    const path = m[0].replace(/^[.]+/, '').replace(/[.,;:]+$/, '');
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= NAMED_FILES_CAP) break;
  }
  return out;
}

export interface OverlapOther {
  sessionId: number | null;
  runId: number | null;
  issueNumber: number | null;
  prNumber: number | null;
  status: string | null;
  branch: string | null;
  // Built on top of another change itself: never built on again.
  stacked?: boolean;
  files: string[];
}

export interface OverlapDecision {
  strategy: 'none' | 'parallel' | 'wait' | 'stack' | 'timeout';
  with: OverlapOther | null;
  files: string[];
}

const EMPTY: OverlapDecision = Object.freeze({ strategy: 'none', with: null, files: [] });

// Pure: what this build does about the files it expects. `files` are its
// own; `others` the open changes and running builds of the same project;
// `since` when it first waited (null: it has not waited yet). A shared file
// that is append-only is combined by the merge sync, so on its own it never
// blocks. Every other shared file blocks: one promoted change (with a pull
// request, a branch, not stacked itself) may be built on; anything else is
// waited for, until OVERLAP_WAIT_MS has passed since the first wait.
export function decideOverlap(p: {
  files: readonly string[];
  others: readonly OverlapOther[];
  since?: string | Date | null;
  now?: Date;
}): OverlapDecision {
  const mine = new Set((p.files || []).map((f) => String(f)));
  if (!mine.size) return { ...EMPTY };
  let blocking: { other: OverlapOther; shared: string[] }[] = [];
  let plain: { other: OverlapOther; shared: string[] } | null = null;
  for (const other of p.others || []) {
    const shared = [...new Set((other.files || []).map((f) => String(f)))].filter((f) => mine.has(f)).sort();
    if (!shared.length) continue;
    if (shared.every(isAppendOnly)) { plain = plain || { other, shared }; continue; }
    blocking.push({ other, shared });
  }
  if (!blocking.length) {
    return plain ? { strategy: 'parallel', with: plain.other, files: plain.shared } : { ...EMPTY };
  }
  const files = [...new Set(blocking.flatMap((b) => b.shared.filter((f) => !isAppendOnly(f))))].sort();
  const stackable = blocking.length === 1
    && blocking[0].other.status === 'promoted'
    && !!blocking[0].other.prNumber && !!blocking[0].other.branch && !blocking[0].other.stacked;
  if (stackable) return { strategy: 'stack', with: blocking[0].other, files };
  // The earliest of them: the oldest change (its session was opened first,
  // so it has the lowest id) or, failing that, the order it was given.
  const earliest = blocking.reduce((a, b) => (
    (b.other.sessionId ?? Number.MAX_SAFE_INTEGER) < (a.other.sessionId ?? Number.MAX_SAFE_INTEGER) ? b : a));
  const started = p.since ? Date.parse(String(p.since)) : NaN;
  const now = (p.now || new Date()).getTime();
  const strategy = Number.isFinite(started) && now >= started + OVERLAP_WAIT_MS ? 'timeout' : 'wait';
  return { strategy, with: earliest.other, files: earliest.shared.filter((f) => !isAppendOnly(f)) };
}

// ── Picks ───────────────────────────────────────────────────────────────

export function personKeyOf(row: { person_id?: unknown; app_id?: unknown } | null | undefined): string {
  return row?.person_id ? `u${Number(row.person_id)}` : `a${Number(row?.app_id)}`;
}

// A slot in use. A read's `readSlot` is which of its project's triage
// sessions it runs on (0 to readsPerApp - 1); `legacy` a read an older
// release may be running (READ_SLOTS_SINCE), on whichever session it finds.
export interface Slot { kind: string; appId: number; person: string; readSlot?: number | null; legacy?: boolean }

// A read slot as a grant or a request carries it: a whole number from 0,
// below MAX_READS_PER_APP, else none.
export function readSlotOf(v: unknown): number | null {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < MAX_READS_PER_APP ? v as number : null;
}

// A slot as the lane reads it (SLOTS_IN_USE_SQL's row): a read with no read
// slot, or one whose request an older version last wrote, is legacy.
export function slotOfRow(r: { app_id?: unknown; slot?: any; machine_version?: unknown }): Slot {
  const kind = String(r.slot?.kind || '');
  const readSlot = readSlotOf(r.slot?.readSlot);
  const version = r.machine_version == null ? 0 : Number(r.machine_version);
  return {
    kind, appId: Number(r.slot?.appId ?? r.app_id), person: String(r.slot?.person || `a${r.app_id}`),
    ...(kind === 'read' ? { readSlot, legacy: readSlot == null || !(version >= READ_SLOTS_SINCE) } : {}),
  };
}

// A candidate an older release may read, if granted (its request last
// written by an older version): only when nothing else reads its project.
const legacyCandidate = (row: { machine_version?: unknown }) =>
  row.machine_version != null && Number(row.machine_version) < READ_SLOTS_SINCE;

// The projects whose reads are all taken, from what runs: `readsPerApp`
// read slots held, or a legacy read holding all of them. What the queue's
// `reads_per_app` wait reads (homeroom-bot.js queueSnapshot). Pure.
export function projectsFullOfReads(inUse: Slot[], readsPerApp: number): Set<number> {
  const limit = Math.max(1, Math.floor(Number(readsPerApp) || 1));
  const count = new Map<number, number>();
  const full = new Set<number>();
  for (const s of inUse || []) {
    if (s.kind !== 'read') continue;
    const appId = Number(s.appId);
    if (s.legacy) { full.add(appId); continue; }
    count.set(appId, (count.get(appId) || 0) + 1);
    if ((count.get(appId) || 0) >= limit) full.add(appId);
  }
  return full;
}

// Homeroom bot parity (P4): a running batch's raise, for each request its
// Build started (`${appId}:${issueNumber}` → the batch's per-person number,
// read by bot-lane/facts.ts BATCH_RAISES_SQL). The project's owner working
// through its requests may have up to MAX_PER_PERSON of them going at once,
// and as many building on the project (services/homeroom-bot-batches.js
// raiseFor). Only those requests, only while the batch runs: every other
// candidate keeps the settings' numbers.
export type Raised = Readonly<Record<string, number>>;
export const raisedKey = (appId: unknown, issueNumber: unknown) => `${Number(appId)}:${Number(issueNumber)}`;
// The raise rows as the picks read them, never past MAX_PER_PERSON. Pure.
export function raisedOf(rows: { app_id: unknown; issue_number: unknown; per_person: unknown }[]): Raised {
  const out: Record<string, number> = {};
  for (const r of rows || []) {
    const n = Math.min(MAX_PER_PERSON, Math.floor(Number(r.per_person) || 0));
    const key = raisedKey(r.app_id, r.issue_number);
    if (n > 0) out[key] = Math.max(out[key] || 0, n);
  }
  return out;
}
// A candidate's limit: the setting's, or its batch's raise when higher.
const limitFor = (raised: Raised | undefined, row: { app_id: unknown; issue_number?: unknown }, base: number) =>
  Math.max(base, (raised && row.issue_number != null && raised[raisedKey(row.app_id, row.issue_number)]) || 0);

// Which waiting reads and follow-ups to start now. `candidates` in order;
// `inUse` what runs. A read runs on one of its project's triage sessions,
// its read slot, so at most `readsPerApp` per project, each on a slot no
// other read holds (the lowest free one); a follow-up runs on its
// proposal's session, so it neither waits for its project's reads nor
// holds one. A read an older release may run takes its project's every
// slot, as reads did before (READ_SLOTS_SINCE): one is granted only while
// nothing else reads its project, and nothing else is while it runs. At
// most `perPerson` per person counting what runs (a running batch's
// request: its `raised` number), at most `slots` new.
export function pickLive<R extends { app_id: unknown; issue_number?: unknown; follow_up_session_id?: unknown; person_id?: unknown; machine_version?: unknown }>(
  candidates: R[], { inUse = [], slots = 0, perPerson = 1, raised = {}, readsPerApp = 1 }:
    { inUse?: Slot[]; slots?: number; perPerson?: number; raised?: Raised; readsPerApp?: number } = {},
): (R & { person: string; followUp: boolean; readSlot: number | null })[] {
  const limit = Math.min(MAX_READS_PER_APP, Math.max(1, Math.floor(Number(readsPerApp) || 1)));
  // Per project: the read slots its reads hold, and the projects a legacy
  // read holds whole.
  const held = new Map<number, Set<number>>();
  const whole = new Set<number>();
  const slotsOf = (appId: number) => {
    if (!held.has(appId)) held.set(appId, new Set());
    return held.get(appId)!;
  };
  for (const s of inUse) {
    if (s.kind !== 'read') continue;
    const appId = Number(s.appId);
    const k = readSlotOf(s.readSlot);
    if (s.legacy || k == null) whole.add(appId);
    else slotsOf(appId).add(k);
  }
  const count = new Map<string, number>();
  for (const a of inUse) count.set(a.person, (count.get(a.person) || 0) + 1);
  const picks: (R & { person: string; followUp: boolean; readSlot: number | null })[] = [];
  for (const row of candidates || []) {
    if (picks.length >= slots) break;
    const appId = Number(row.app_id);
    const followUp = row.follow_up_session_id != null;
    let readSlot: number | null = null;
    const legacy = !followUp && legacyCandidate(row);
    if (!followUp) {
      if (whole.has(appId)) continue;
      const taken = slotsOf(appId);
      // As many as it may already (a setting lowered under what runs
      // counts what runs), or an older release's candidate beside any.
      if (taken.size >= limit || (legacy && taken.size)) continue;
      for (let k = 0; k < limit; k++) if (!taken.has(k)) { readSlot = k; break; }
      if (readSlot == null) continue;
    }
    const person = personKeyOf(row);
    if ((count.get(person) || 0) >= limitFor(raised, row, perPerson)) continue;
    if (legacy) whole.add(appId);
    else if (readSlot != null) slotsOf(appId).add(readSlot);
    count.set(person, (count.get(person) || 0) + 1);
    picks.push({ ...row, person, followUp, readSlot });
  }
  return picks;
}

// Which waiting builds to start now: at most `perApp` for the row's project
// (its own number in the setting), else `perProject`, under way on one
// project counting those building; at most `perPerson` live pieces of work
// for any one person counting what runs, at most `slots` in all. A running
// batch's request (`raised`) may go to its batch's number for both.
export function pickLiveBuilds<R extends { app_id: unknown; issue_number?: unknown; person_id?: unknown }>(
  candidates: R[], { inUse = [], slots = 0, perPerson = 1, perProject = BUILDS_PER_APP, perApp = {}, raised = {} }:
    { inUse?: Slot[]; slots?: number; perPerson?: number; perProject?: number; perApp?: Record<string, number>; raised?: Raised } = {},
): (R & { person: string })[] {
  const building = new Map<number, number>();
  for (const s of inUse) if (s.kind === 'build') building.set(Number(s.appId), (building.get(Number(s.appId)) || 0) + 1);
  const count = new Map<string, number>();
  for (const a of inUse) count.set(a.person, (count.get(a.person) || 0) + 1);
  const picks: (R & { person: string })[] = [];
  for (const row of candidates || []) {
    if (picks.length >= slots) break;
    const appId = Number(row.app_id);
    const perProjectHere = perApp[String(appId)] ?? perProject;
    if ((building.get(appId) || 0) >= limitFor(raised, row, perProjectHere)) continue;
    const person = personKeyOf(row);
    if ((count.get(person) || 0) >= limitFor(raised, row, perPerson)) continue;
    building.set(appId, (building.get(appId) || 0) + 1);
    count.set(person, (count.get(person) || 0) + 1);
    picks.push({ ...row, person });
  }
  return picks;
}
