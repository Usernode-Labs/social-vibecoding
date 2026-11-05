'use strict';

// One work state per request and per change (5 Nov 2026, step 3 of one bot
// per thread: docs/plans/bot-one-model.md).
//
// Seven pieces of code used to decide where a request stood, one per surface
// (the bot tab's standing, the drawer's outcomes, a request page's track, a
// project chat card's stage, the bell's moments, ...), each from the same
// records with rules of its own, and they disagreed: one request read Decide
// on the bot tab, sat in History in the drawer and said Reading in its
// project's chat. This module decides it once:
//
//   derive(facts)        the stage of a request, from one facts row (the
//                        bot's records, read by REQUEST_FACTS_SQL: the same
//                        per-request query the bot page and the track read)
//   deriveChange(facts)  the stage of a change with no request of its own
//   placeFor(state, you) where an item goes for one viewer: Needs you, In
//                        progress, Waiting, Live, or not listed
//   bellOf(prev, next)   the moment a change of stage rings, if any
//   refresh(db, items)   derives the items again and stores each that
//                        changed (work_states), returning them
//   afterTransition      the workflow's hook: after every accepted event of
//                        a machine that moves a request or a change, in its
//                        own transaction, refresh the items it is about and
//                        push each change (`work_state`)
//
// Ten stages, the same words everywhere: reading, planning, waiting_for_you
// (always with a why), building, checking, up_for_vote, going_live, live,
// stopped (with a reason), closed. The second line (`line`) carries queue and
// hold reasons and detail.

const progress = require('./homeroom-bot-progress');

const STAGES = Object.freeze([
  'reading', 'planning', 'waiting_for_you', 'building', 'checking',
  'up_for_vote', 'going_live', 'live', 'stopped', 'closed',
]);
const WHYS = Object.freeze(['question', 'plan', 'decide', 'already_works', 'needs_detail']);
const REASONS = Object.freeze(['build_failed', 'fix_stopped', 'look_failed', 'change_closed', 'stalled']);
// A live item is listed for a week, as the bot tab always did.
const LIVE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// The bot reads a claim this long (homeroom-bot.js CLAIM_TTL_DAYS).
const CLAIM_DAYS = 7;

const iso = (at) => {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function clip(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const firstLine = (text, max) => clip(String(text || '').split('\n').find((l) => l.trim()) || '', max);

// ── Deciding ──────────────────────────────────────────────────────────────

const state = (stage, extra = {}) => {
  const out = { stage, why: null, reason: null, line: null, whoseMove: null, since: null, ...extra };
  if (out.whoseMove == null) {
    out.whoseMove = stage === 'waiting_for_you' || stage === 'stopped' ? 'requester'
      : stage === 'up_for_vote' ? 'group'
        : stage === 'reading' || stage === 'planning' || stage === 'building' || stage === 'checking' ? 'bot'
          : null;
  }
  out.since = iso(out.since);
  return out;
};

/**
 * Pure: a request's work state from one stage of homeroom-bot-progress.js
 * stageOf (the bot's own step), mapped to the ten (the plan's table).
 */
function fromStage(s, row) {
  const since = s.since || null;
  switch (s.stage) {
    case 'reading':
      return state('reading', { since, ...(s.reply ? { line: { code: 'reply' } } : {}) });
    case 'queued':
      return s.retry === 'plan'
        ? state('planning', { since, line: { code: 'retry_plan' } })
        : state('reading', { since, line: { code: 'queued', ...(row.queue_place ? { place: Number(row.queue_place) } : {}) } });
    case 'on_hold':
      return state('reading', { since, line: { code: 'on_hold' } });
    case 'held':
      return state('building', { since, line: { code: row.cap_suppressed === 'builds_per_app' ? 'held_builds' : 'held_waiting' } });
    case 'build_queued':
      return state('building', { since, line: { code: 'queued' } });
    case 'starting':
      return state('building', { since, line: { code: 'starting' } });
    case 'stalled':
      return state('stopped', { since, reason: 'stalled' });
    case 'planning':
      return state('planning', { since });
    case 'reviewing': {
      const of = Math.max(1, Number(row.review_max_rounds) || 1);
      const round = Math.max(1, Math.min(Number(row.review_round) || 1, of));
      return state('building', { since, line: { code: 'reviewing', round, of } });
    }
    case 'proposing':
      return state('building', { since, line: { code: 'proposing' } });
    case 'building':
      return state('building', { since });
    case 'plan':
      return state('waiting_for_you', { since, why: 'plan' });
    case 'question':
      return state('waiting_for_you', { since, why: 'question' });
    case 'fixing':
      return state('building', { since, line: { code: 'fixing' } });
    case 'revising':
      return state('building', { since, line: { code: 'revising' } });
    case 'fix_queued':
    case 'followup_queued':
      return state('up_for_vote', { since, line: { code: 'update_queued' } });
    case 'checks':
      return state('checking', { since });
    case 'checks_failed': {
      const failing = Number(row.failed_checks ?? progress.failedCount(row.test_results)) || 0;
      return state('checking', { since, line: { code: 'checks_failing', ...(failing ? { failing } : {}) } });
    }
    case 'fix_stopped':
      return state('stopped', { since, reason: 'fix_stopped' });
    case 'vote':
      return row.first_version === true
        ? state('going_live', { since, line: { code: 'first_version' } })
        : state('up_for_vote', { since });
    case 'merging':
      return state('going_live', { since: row.merged_at || since });
    default:
      return null;
  }
}

/**
 * Pure: where a request stands, from its facts row (REQUEST_FACTS_SQL: the
 * bot's records for it, its change, its claim, a private thread holding it).
 * Never null: a request nothing is happening to waits to be read.
 */
function derive(row, { now = new Date() } = {}) {
  const status = row.proposal_status || null;
  // Its change is live (REQUEST_RECORD_COLUMNS reads a merged change that is
  // not live yet as 'merging').
  if (status === 'merged') return state('live', { since: row.merged_at || row.proposal_at });
  // The bot's own step for it, when it has one.
  const step = progress.stageOf(row, { now });
  let out = step ? fromStage(step, row) : null;
  // An update on its way holds the vote it would otherwise ask for (#6282).
  if (status === 'promoted' && row.update_coming && out && (out.stage === 'up_for_vote' || out.stage === 'checking')) {
    out = row.update_coming === 'running'
      ? state('building', { since: out.since, line: { code: 'revising' } })
      : state('up_for_vote', { since: out.since, line: { code: 'update_queued' } });
  }
  // A private thread of the requester's holds it for their plan: nothing
  // queued overtakes that until a change is up (1 Nov 2026).
  if (row.awaiting_plan === true && !status && (!out || out.stage === 'reading')) {
    return state('planning', { since: row.request_at || row.run_at, line: { code: 'planning_with_you' }, whoseMove: 'requester' });
  }
  if (out) return out;

  // Nothing in progress: what its newest look came to.
  const back = progress.handedBack(row);
  const reason = row.run_reason ? firstLine(row.run_reason, 140) : null;
  const said = reason ? { line: { code: 'reason', text: reason } } : {};
  // Somebody took a hand-back up since (a claim): it is being built.
  if (back && row.claimed_by) return state('building', { since: row.claimed_at, line: { code: 'claimed', by: row.claimed_by }, whoseMove: 'builder' });
  if (back === 'already_works') return state('waiting_for_you', { since: row.run_at, why: 'already_works', ...said });
  if (back === 'decide') return state('waiting_for_you', { since: row.run_at, why: 'decide', ...said });
  if (back === 'build_stopped') return state('stopped', { since: row.run_at, reason: 'build_failed' });
  if (row.request_closed === true) return state('closed', { since: row.closed_at || row.run_at });
  if (status === 'closed') return state('stopped', { since: row.proposal_at, reason: 'change_closed' });
  if (row.mode === 'live' && (row.verdict === 'empty' || /^blocked:/.test(String(row.build_error || '')))) {
    return state('waiting_for_you', { since: row.run_at, why: 'needs_detail', ...said });
  }
  if (row.mode === 'live' && row.verdict === 'failed') return state('stopped', { since: row.run_at, reason: 'look_failed' });
  if (row.claimed_by) return state('building', { since: row.claimed_at, line: { code: 'claimed', by: row.claimed_by }, whoseMove: 'builder' });
  // Not read yet, or read and nothing came of it (a skip): it waits to be read.
  return state('reading', { since: row.request_at || row.run_at, line: { code: 'waiting' } });
}

/** Pure: where a change with no request of its own stands. */
function deriveChange(row, { now = new Date() } = {}) {
  const status = row.status || null;
  if (status === 'merged') {
    return row.live_at ? state('live', { since: row.live_at }) : state('going_live', { since: row.merged_at });
  }
  if (status === 'merging') return state('going_live', { since: row.promoted_at });
  if (status === 'closed' || status === 'archived') return state('closed', { since: row.last_activity_at || row.promoted_at });
  if (status === 'promoted') {
    if (row.check_state !== 'passing' && row.check_state !== 'skipped') {
      const failing = row.check_state === 'failing' || row.check_state === 'error';
      return state('checking', { since: row.checks_at || row.promoted_at, ...(failing ? { line: { code: 'checks_failing' } } : {}) });
    }
    return state('up_for_vote', { since: row.promoted_at });
  }
  void now;
  return state('building', { since: row.last_activity_at || row.created_at, whoseMove: 'builder' });
}

/**
 * Pure: where an item goes for one viewer, or null when it is not theirs to
 * see in these lists. `viewer` says how they stand to it: `requester` (it is
 * theirs, or they decide on its project), `voteOwed` (they still owe a vote,
 * which the Needs you feed lists as Vote), `own` (they asked for it, built it
 * or follow it).
 */
function placeFor(item, viewer = {}) {
  if (!item) return null;
  const mine = !!viewer.requester;
  const own = mine || !!viewer.own;
  switch (item.stage) {
    case 'waiting_for_you':
    case 'stopped':
      return mine ? 'needs' : own ? 'waiting' : null;
    case 'up_for_vote':
      if (viewer.voteOwed) return null; // the feed's Vote row
      return own ? 'waiting' : null;
    case 'live': {
      const at = item.since ? new Date(item.since).getTime() : 0;
      return own && (!at || Date.now() - at <= LIVE_DAYS * DAY_MS) ? 'live' : null;
    }
    case 'closed':
      return null;
    case 'going_live':
      return own ? 'next' : null;
    default: {
      if (!own) return null;
      // Waiting its turn, or held: Waiting. Under way: In progress.
      const code = item.line && item.line.code;
      const waiting = code === 'queued' || code === 'held_builds' || code === 'held_waiting' || code === 'on_hold'
        || code === 'waiting' || code === 'update_queued' || code === 'planning_with_you' || item.stage === 'checking';
      return waiting ? 'waiting' : 'next';
    }
  }
}

/**
 * Pure: the moment a change of stage rings the requester's bell, or null.
 * Into waiting_for_you: needs you; up_for_vote: ready to vote; stopped:
 * stopped; live: live. A row that only moved its line rings nothing.
 */
function bellOf(prev, next) {
  if (!next) return null;
  const same = prev && prev.stage === next.stage && (prev.why || null) === (next.why || null)
    && (prev.reason || null) === (next.reason || null);
  if (same) return null;
  if (next.stage === 'waiting_for_you') return 'needs_you';
  if (next.stage === 'up_for_vote') return prev && prev.stage === 'up_for_vote' ? null : 'ready';
  if (next.stage === 'stopped') return 'stopped';
  if (next.stage === 'live') return 'live';
  return null;
}

// ── Reading the facts ─────────────────────────────────────────────────────

/**
 * One row per request named by ($1 app ids, $2 numbers), with every record
 * derive reads: the same per-request record the bot page and a request's
 * track read (homeroom-bot-progress.js requestRecordJoinsSql), its request's
 * own state, its requester, a claim on it, a private thread holding it for
 * the requester's plan, an update on its way, and its place in the bot's
 * line on its project.
 */
const REQUEST_FACTS_SQL = `
  WITH it AS (
    SELECT DISTINCT x.app_id, x.issue_number
      FROM unnest($1::int[], $2::int[]) AS x(app_id, issue_number)
  )
  SELECT it.app_id, it.issue_number,
         rq.user_id AS requester_id,
         COALESCE(rq.first_version, FALSE) AS first_version,
         iss.created_at AS request_at,
         (SELECT cr.closed_at FROM homeroom_bot_closed_requests cr
           WHERE cr.app_id = it.app_id AND cr.issue_number = it.issue_number) AS closed_at,
         ${progress.REQUEST_RECORD_COLUMNS},
         ${progress.requestClosedSql({ appId: 'it.app_id', issueNumber: 'it.issue_number' })} AS request_closed,
         cl.username AS claimed_by, cl.claimed_at,
         ${require('../workflow/rules/bot-loop.ts').planHoldSql('it.app_id', 'it.issue_number', 'NULL::int')} AS awaiting_plan,
         CASE WHEN cs.id IS NULL THEN NULL ELSE ${progress.updateComingSql('cs')} END AS update_coming,
         CASE WHEN q.id IS NOT NULL AND q.started_at IS NULL THEN (
           SELECT COUNT(*)::int FROM homeroom_bot_queue q2
            WHERE q2.app_id = it.app_id AND q2.started_at IS NULL AND q2.enqueued_at <= q.enqueued_at
         ) END AS queue_place
    FROM it
    LEFT JOIN homeroom_bot_requesters rq ON rq.app_id = it.app_id AND rq.issue_number = it.issue_number
    LEFT JOIN LATERAL (
      SELECT i.created_at FROM issues i
       WHERE i.app_id = it.app_id AND i.github_issue_number = it.issue_number
       ORDER BY i.id DESC LIMIT 1
    ) iss ON TRUE
    ${progress.requestRecordJoinsSql({ appId: 'it.app_id', issueNumber: 'it.issue_number' })}
    LEFT JOIN LATERAL (
      SELECT u.username, ic.claimed_at
        FROM issue_claims ic JOIN users u ON u.id = ic.user_id
       WHERE ic.app_id = it.app_id AND ic.github_issue_number = it.issue_number
         AND ic.claimed_at > NOW() - make_interval(days => ${CLAIM_DAYS})
         AND u.is_synthetic IS NOT TRUE
       ORDER BY ic.claimed_at DESC
       LIMIT 1
    ) cl ON TRUE`;

/** One row per change named by $1 (session ids) that has no request of its own. */
const CHANGE_FACTS_SQL = `
  SELECT cs.id, cs.app_id, cs.user_id, cs.status, cs.check_state, cs.checks_checked_at AS checks_at,
         cs.promoted_at, cs.merged_at, cs.live_at, cs.created_at, cs.last_activity_at
    FROM chat_sessions cs
   WHERE cs.id = ANY($1::int[])`;

/**
 * The requests a session is about: the requests whose bot run built or
 * proposed it, then the ones it says it closes. Empty for a change with no
 * request, which is its own item.
 */
async function requestsOfSession(db, sessionId) {
  const { rows } = await db.query(
    `SELECT DISTINCT r.app_id, r.issue_number FROM homeroom_bot_runs r
      WHERE r.proposal_session_id = $1 OR r.build_session_id = $1
     UNION
     SELECT cs.app_id, n AS issue_number FROM chat_sessions cs, unnest(cs.linked_issues) AS n
      WHERE cs.id = $1`,
    [Number(sessionId)],
  );
  return rows.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) }));
}

// ── Storing ──────────────────────────────────────────────────────────────

const sameLine = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

async function upsert(db, key, next, { touch = false } = {}) {
  const { rows: [prev] } = await db.query(
    `SELECT stage, why, reason, line, whose_move, requester_id, since FROM work_states
      WHERE app_id = $1 AND item_kind = $2 AND item_ref = $3`,
    [key.appId, key.kind, key.ref],
  );
  if (prev && prev.stage === next.stage && (prev.why || null) === next.why && (prev.reason || null) === next.reason
    && sameLine(prev.line, next.line) && (prev.whose_move || null) === next.whoseMove
    && (prev.requester_id == null ? null : Number(prev.requester_id)) === (next.requesterId ?? null)) {
    // Unchanged. The sweep still marks it checked, so it moves on to others.
    if (touch) {
      await db.query('UPDATE work_states SET checked_at = NOW() WHERE app_id = $1 AND item_kind = $2 AND item_ref = $3',
        [key.appId, key.kind, key.ref]);
    }
    return null;
  }
  await db.query(
    `INSERT INTO work_states (app_id, item_kind, item_ref, issue_number, session_id, stage, why, reason, line,
                              whose_move, requester_id, since, updated_at, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, NOW(), NOW())
     ON CONFLICT (app_id, item_kind, item_ref) DO UPDATE
       SET issue_number = EXCLUDED.issue_number, session_id = EXCLUDED.session_id, stage = EXCLUDED.stage,
           why = EXCLUDED.why, reason = EXCLUDED.reason, line = EXCLUDED.line, whose_move = EXCLUDED.whose_move,
           requester_id = EXCLUDED.requester_id, since = EXCLUDED.since, updated_at = NOW(), checked_at = NOW()`,
    [key.appId, key.kind, key.ref, key.issueNumber ?? null, key.sessionId ?? null, next.stage, next.why, next.reason,
      next.line ? JSON.stringify(next.line) : null, next.whoseMove, next.requesterId ?? null, next.since],
  );
  return { prev: prev ? { stage: prev.stage, why: prev.why || null, reason: prev.reason || null } : null };
}

/**
 * Derive the items again and store each that changed. `items` are
 * { appId, issueNumber } (a request) or { sessionId } (a change, which
 * resolves to its requests when it has any). Resolves the changed rows:
 * { appId, kind, ref, issueNumber, sessionId, state, prev, bell }.
 */
async function refresh(db, items, { now = new Date(), touch = false } = {}) {
  const requests = new Map();
  const changes = new Set();
  for (const it of items || []) {
    if (it && Number(it.appId) > 0 && Number(it.issueNumber) > 0) {
      requests.set(`${Number(it.appId)}:${Number(it.issueNumber)}`, { appId: Number(it.appId), issueNumber: Number(it.issueNumber) });
    } else if (it && Number(it.sessionId) > 0) {
      const of = await requestsOfSession(db, Number(it.sessionId));
      if (of.length) for (const r of of) requests.set(`${r.appId}:${r.issueNumber}`, r);
      else changes.add(Number(it.sessionId));
    }
  }
  const changed = [];
  if (requests.size) {
    const list = [...requests.values()];
    const { rows } = await db.query(REQUEST_FACTS_SQL, [list.map((r) => r.appId), list.map((r) => r.issueNumber)]);
    for (const row of rows) {
      const next = { ...derive(row, { now }), requesterId: row.requester_id == null ? null : Number(row.requester_id) };
      const sessionId = Number(row.proposal_session_id || row.build_session_id) || null;
      const key = { appId: Number(row.app_id), kind: 'request', ref: Number(row.issue_number), issueNumber: Number(row.issue_number), sessionId };
      const wrote = await upsert(db, key, next, { touch });
      if (wrote) changed.push({ ...key, state: next, prev: wrote.prev, bell: bellOf(wrote.prev, next) });
    }
  }
  if (changes.size) {
    const { rows } = await db.query(CHANGE_FACTS_SQL, [[...changes]]);
    for (const row of rows) {
      const next = { ...deriveChange(row, { now }), requesterId: row.user_id == null ? null : Number(row.user_id) };
      const key = { appId: Number(row.app_id), kind: 'change', ref: Number(row.id), issueNumber: null, sessionId: Number(row.id) };
      const wrote = await upsert(db, key, next, { touch });
      if (wrote) changed.push({ ...key, state: next, prev: wrote.prev, bell: bellOf(wrote.prev, next) });
    }
  }
  return changed;
}

// ── The workflow's hook ──────────────────────────────────────────────────

// The machines whose transitions move a request or a change, and how an
// instance's key names what it is about.
const WATCHED = new Set([
  'bot-request', 'bot-build', 'bot-change', 'proposal', 'preview', 'merge-followups', 'app-delivery', 'governance-proposal',
]);

// A vote decides a request only when it closes or reopens one, as it applies.
const DECIDING_KINDS = new Set(['close_issue', 'reopen_issue']);

/**
 * Pure: whether an accepted event may move a request or change (the
 * kernel's afterAccepted `wants`, asked before any query): a watched
 * machine's, and of a governance vote only the one that applies a close or
 * a reopen.
 */
function wants({ machine, state, data } = {}) {
  if (!WATCHED.has(machine)) return false;
  if (machine === 'governance-proposal') return state === 'applied' && DECIDING_KINDS.has(data?.kind);
  return true;
}

/** The items one instance of a watched machine is about. */
async function itemsOf(db, { machine, key, appId }) {
  if (!WATCHED.has(machine) || typeof key !== 'string') return [];
  let m = /^request:(\d+):(\d+)$/.exec(key);
  if (m) return [{ appId: Number(m[1]), issueNumber: Number(m[2]) }];
  m = /^run:(\d+)(?:@.*)?$/.exec(key);
  if (m) {
    const { rows } = await db.query('SELECT app_id, issue_number FROM homeroom_bot_runs WHERE id = $1', [Number(m[1])]);
    return rows.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) }));
  }
  m = /^session:(\d+)$/.exec(key);
  if (m) return [{ sessionId: Number(m[1]) }];
  // A vote to close or reopen a request (governance-proposal): the request
  // it names, and the ones open in its thread that close with it.
  m = machine === 'governance-proposal' && /^issue:(\d+)$/.exec(key);
  if (m) {
    const { rows } = await db.query(
      `SELECT p.app_id, (p.payload->>'issueNumber')::int AS issue_number, p.thread_id
         FROM issues p
        WHERE p.id = $1 AND p.kind IN ('close_issue', 'reopen_issue')
          AND (p.payload->>'issueNumber') ~ '^[0-9]+$'`,
      [Number(m[1])],
    );
    if (!rows.length) return [];
    const { rows: thread } = rows[0].thread_id ? await db.query(
      `SELECT r.app_id, r.number AS issue_number FROM requests r WHERE r.thread_id = $1 AND r.app_id = $2`,
      [rows[0].thread_id, rows[0].app_id],
    ) : { rows: [] };
    const out = new Map();
    for (const r of [...rows, ...thread]) out.set(`${r.app_id}:${r.issue_number}`, { appId: Number(r.app_id), issueNumber: Number(r.issue_number) });
    return [...out.values()];
  }
  m = /^app:(\d+)$/.exec(key);
  if (m) {
    // An app's delivery: whatever of it is going live may be live now.
    const { rows } = await db.query(
      `SELECT app_id, item_kind, item_ref, session_id FROM work_states WHERE app_id = $1 AND stage = 'going_live'`,
      [Number(m[1])],
    );
    return rows.map((r) => (r.item_kind === 'request'
      ? { appId: Number(r.app_id), issueNumber: Number(r.item_ref) }
      : { sessionId: Number(r.item_ref) }));
  }
  void appId;
  return [];
}

/** The push a changed row is carried by, to everyone who may view its app. */
function pushOf(row) {
  return {
    kind: 'scoped',
    routing: { appId: row.appId, appSlug: null },
    data: {
      type: 'work_state',
      appId: row.appId,
      item: { kind: row.kind, ref: row.ref, issueNumber: row.issueNumber, sessionId: row.sessionId },
      state: {
        stage: row.state.stage, why: row.state.why, reason: row.state.reason, line: row.state.line,
        whoseMove: row.state.whoseMove, since: row.state.since,
      },
    },
  };
}

/**
 * Publish pushes from outside a transition (a route, the sweep): the same
 * bus envelope a transition's pushes use, so every process delivers them.
 * Inside a transaction they go out when it commits.
 */
async function publish(db, pushes) {
  if (!pushes || !pushes.length) return;
  const bus = require('./ws-bus');
  await db.query(
    'SELECT pg_notify($1, body) FROM unnest($2::text[]) WITH ORDINALITY AS t(body, n) ORDER BY n',
    [bus.CHANNEL, pushes.map((p) => bus.workflowBody(p.kind, p.routing ?? null, p.data))],
  );
}

/**
 * Refresh items a route changed outside any machine (a close, a reopen, a
 * claim, a vote) and publish what changed. Never throws: the route's own
 * write stands, and the sweep corrects a row this missed.
 */
async function touched(db, items, deps = {}) {
  try {
    const changed = await refresh(db, items);
    if (typeof deps.ring === 'function') {
      for (const row of changed) if (row.bell && row.state.requesterId) await deps.ring(db, row);
    }
    await publish(db, changed.map(pushOf));
    return changed;
  } catch (err) {
    require('./logger').warn('work-state', 'refresh after a route write failed', { message: err.message });
    return [];
  }
}

/**
 * The workflow's afterAccepted hook (kernel/pipeline.ts): refresh what an
 * accepted event's instance is about, in its own transaction, and resolve
 * the pushes of what changed. Rings a changed stage's bell through
 * `deps.ring` when given (the platform wires the bell's notification).
 */
async function afterTransition(db, info, deps = {}) {
  const items = await itemsOf(db, info);
  if (!items.length) return [];
  const changed = await refresh(db, items);
  if (typeof deps.ring === 'function') {
    for (const row of changed) if (row.bell && row.state.requesterId) await deps.ring(db, row);
  }
  return changed.map(pushOf);
}

// ── Reading the store ────────────────────────────────────────────────────

/** A person's own items (their requests' rows and their changes'), newest first. */
async function forRequester(db, userId, { limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT ws.*, a.slug, a.name AS app_name FROM work_states ws JOIN apps a ON a.id = ws.app_id
      WHERE ws.requester_id = $1
      ORDER BY ws.updated_at DESC
      LIMIT $2`,
    [Number(userId), Math.max(1, Math.min(Number(limit) || 200, 500))],
  );
  return rows.map(fromRow);
}

/** The stored rows of named requests on one app, by number. */
async function forRequests(db, appId, numbers) {
  const list = [...new Set((numbers || []).map(Number).filter((n) => n > 0))];
  if (!list.length) return new Map();
  const { rows } = await db.query(
    `SELECT ws.*, a.slug, a.name AS app_name FROM work_states ws JOIN apps a ON a.id = ws.app_id
      WHERE ws.app_id = $1 AND ws.item_kind = 'request' AND ws.item_ref = ANY($2::int[])`,
    [Number(appId), list],
  );
  return new Map(rows.map((r) => [Number(r.item_ref), fromRow(r)]));
}

/** Pure: a stored row as the readers take it. */
function fromRow(r) {
  return {
    appId: Number(r.app_id),
    app: r.slug ? { slug: r.slug, name: r.app_name || r.slug } : null,
    kind: r.item_kind,
    ref: Number(r.item_ref),
    issueNumber: r.issue_number == null ? null : Number(r.issue_number),
    sessionId: r.session_id == null ? null : Number(r.session_id),
    stage: r.stage,
    why: r.why || null,
    reason: r.reason || null,
    line: r.line || null,
    whoseMove: r.whose_move || null,
    requesterId: r.requester_id == null ? null : Number(r.requester_id),
    since: iso(r.since),
    updatedAt: iso(r.updated_at),
  };
}

// ── The sweep ────────────────────────────────────────────────────────────

// Some stages move on by time alone: a build that never started stalls
// (progress.START_GRACE_MS), a reply's "about to read" lapses
// (progress.REPLY_WAIT_MS), a hold until Monday ends, a week-old live item
// leaves the lists. And a fact written where no machine or route refreshes
// its item is caught here. The sweep refreshes the rows still moving, the
// longest unchecked first, and seeds a row for each request the bot knows
// that has none yet (its first run after the table exists).
async function sweep(db, { olderThanMs = 2 * 60 * 1000, limit = 100, seed = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT app_id, item_kind, item_ref FROM work_states
      WHERE stage <> 'closed' AND checked_at < NOW() - make_interval(secs => $1)
        AND NOT (stage = 'live' AND since < NOW() - make_interval(days => $3))
      ORDER BY checked_at ASC LIMIT $2`,
    [Math.round(olderThanMs / 1000), limit, LIVE_DAYS + 1],
  );
  const { rows: missing } = seed > 0 ? await db.query(
    `SELECT k.app_id, k.issue_number FROM (
       SELECT app_id, issue_number, MAX(at) AS at FROM (
         SELECT app_id, issue_number, created_at AS at FROM homeroom_bot_requesters
         UNION ALL SELECT app_id, issue_number, created_at FROM homeroom_bot_runs WHERE mode = 'live'
         UNION ALL SELECT app_id, issue_number, enqueued_at FROM homeroom_bot_queue
       ) x GROUP BY app_id, issue_number
     ) k
     WHERE NOT EXISTS (SELECT 1 FROM work_states ws
                        WHERE ws.app_id = k.app_id AND ws.item_kind = 'request' AND ws.item_ref = k.issue_number)
       AND EXISTS (SELECT 1 FROM apps a WHERE a.id = k.app_id)
     ORDER BY k.at DESC LIMIT $1`,
    [seed],
  ) : { rows: [] };
  const items = [
    ...rows.map((r) => (r.item_kind === 'request'
      ? { appId: Number(r.app_id), issueNumber: Number(r.item_ref) }
      : { sessionId: Number(r.item_ref) })),
    ...missing.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) })),
  ];
  if (!items.length) return { checked: 0, seeded: 0, changed: [] };
  const changed = await refresh(db, items, { touch: true });
  return { checked: rows.length, seeded: missing.length, changed };
}

/**
 * The rows of requests that have none yet, made now (a reader listing
 * requests from before the table, or one the sweep has not reached).
 * Resolves nothing; read the rows after.
 */
async function ensure(db, items) {
  const list = (items || []).filter((it) => Number(it.appId) > 0 && Number(it.issueNumber) > 0);
  if (!list.length) return;
  const { rows } = await db.query(
    `SELECT x.app_id, x.issue_number FROM unnest($1::int[], $2::int[]) AS x(app_id, issue_number)
      WHERE NOT EXISTS (SELECT 1 FROM work_states ws
                         WHERE ws.app_id = x.app_id AND ws.item_kind = 'request' AND ws.item_ref = x.issue_number)`,
    [list.map((it) => Number(it.appId)), list.map((it) => Number(it.issueNumber))],
  );
  if (rows.length) await refresh(db, rows.map((r) => ({ appId: Number(r.app_id), issueNumber: Number(r.issue_number) })));
}

module.exports = {
  STAGES,
  WHYS,
  REASONS,
  LIVE_DAYS,
  fromStage,
  derive,
  deriveChange,
  placeFor,
  bellOf,
  REQUEST_FACTS_SQL,
  CHANGE_FACTS_SQL,
  requestsOfSession,
  refresh,
  WATCHED,
  wants,
  itemsOf,
  pushOf,
  publish,
  touched,
  afterTransition,
  forRequester,
  forRequests,
  fromRow,
  sweep,
  ensure,
};
