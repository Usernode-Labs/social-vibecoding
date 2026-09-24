'use strict';

// Agent sessions (#2779, spec: docs/agent-sessions.md).
//
// An agent session is one long-lived conversation between a user and the
// Mayor. It is not bound to an app and never closes on its own. The work it
// does happens in CHANGES, which are ordinary chat_sessions rows linked back
// through chat_sessions.agent_session_id, so staging, checks, votes and merge
// run exactly as they do for any proposal. The session tracks one active
// change at a time (D4): starting or switching to another change parks the
// current one, which is today's `paused`.
//
// This module is the data layer: creating and reading sessions, linking a
// change to its session, and the notes the conversation gets when a change
// closes. The Mayor's turn arrives in the next step of #2779.
//
// Every read and write is scoped to the owner. A session is private to the
// user who started it; other members see its changes the way they see any
// proposal.

const log = require('./logger');
const appAccess = require('./app-access');

const TITLE_MAX = 256;
const LIST_LIMIT_MAX = 50;
const MESSAGES_LIMIT_MAX = 200;
const ENTRIES = Object.freeze(['improve', 'workshop', 'app', 'issue', 'feedback', 'proposal', 'messages', 'banner']);

class AgentSessionError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AgentSessionError';
    this.status = status;
  }
}

const positiveInt = (value) => (Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : null);

// ── The app hint ───────────────────────────────────────────────────────
//
// Whatever the entry point knew — an app, and perhaps the request or the
// proposal the user was looking at — stored as the session's focus. It is a
// starting assumption for the Mayor, never a limit. An app the user cannot
// see is dropped rather than refused: the hint is a convenience, and refusing
// the session over it would make a stale link a dead end.
function parseHint(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentSessionError(400, 'hint must be an object');
  }
  const allowed = ['slug', 'issueNumber', 'proposalId', 'entry'];
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AgentSessionError(400, `Unsupported hint field: ${unknown[0]}`);
  const slug = raw.slug == null ? null : String(raw.slug);
  if (slug !== null && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new AgentSessionError(400, 'hint.slug must be an app slug');
  }
  const issueNumber = raw.issueNumber == null ? null : positiveInt(raw.issueNumber);
  const proposalId = raw.proposalId == null ? null : positiveInt(raw.proposalId);
  if ((raw.issueNumber != null && issueNumber === null) || (raw.proposalId != null && proposalId === null)) {
    throw new AgentSessionError(400, 'hint.issueNumber and hint.proposalId must be positive integers');
  }
  if ((issueNumber || proposalId) && !slug) {
    throw new AgentSessionError(400, 'hint.slug is required with an issue or a proposal');
  }
  const entry = raw.entry == null ? null : String(raw.entry);
  if (entry !== null && !ENTRIES.includes(entry)) {
    throw new AgentSessionError(400, `hint.entry must be one of ${ENTRIES.join(', ')}`);
  }
  return { slug, issueNumber, proposalId, entry };
}

async function resolveHint(pool, user, hint) {
  if (!hint || !hint.slug) {
    return { focusAppId: null, focusContext: hint && hint.entry ? { entry: hint.entry } : {} };
  }
  const app = await appAccess.getAppForUser(pool, hint.slug, user, 'view', appAccess.ACCESS_COLUMNS);
  if (!app) return { focusAppId: null, focusContext: hint.entry ? { entry: hint.entry } : {} };
  const context = {};
  if (hint.entry) context.entry = hint.entry;
  if (hint.issueNumber) context.issueNumber = hint.issueNumber;
  if (hint.proposalId) context.proposalId = hint.proposalId;
  return { focusAppId: app.id, focusContext: context };
}

// ── Shaping ────────────────────────────────────────────────────────────

function shapeChangeRow(row) {
  if (!row || row.change_id == null) return null;
  return {
    id: row.change_id,
    appSlug: row.change_app_slug || null,
    appName: row.change_app_name || null,
    status: row.change_status || null,
    title: row.change_title || null,
    prNumber: row.change_pr_number || null,
    // For the changes drawer: the owner's own preview and checks verdict.
    stagingUrl: row.change_staging_url || null,
    checkState: row.change_check_state || null,
  };
}

function shapeSession(row) {
  return {
    id: row.id,
    title: row.title || null,
    titleSource: row.title_source,
    status: row.status,
    focusApp: row.focus_app_id
      ? { id: row.focus_app_id, slug: row.focus_app_slug || null, name: row.focus_app_name || null }
      : null,
    focusContext: row.focus_context || {},
    activeChange: shapeChangeRow(row),
    busy: !!row.active_turn,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
  };
}

// ── Sessions ───────────────────────────────────────────────────────────

async function createAgentSession(pool, { user, hint = null }) {
  const parsed = parseHint(hint);
  const { focusAppId, focusContext } = await resolveHint(pool, user, parsed);
  const { rows } = await pool.query(
    `INSERT INTO agent_sessions (user_id, focus_app_id, focus_context)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [user.id, focusAppId, JSON.stringify(focusContext)]
  );
  log.info('agent-sessions', 'Agent session created', {
    userId: user.id, agentSessionId: rows[0].id, focusAppId,
  });
  return getAgentSession(pool, { userId: user.id, id: rows[0].id });
}

async function listAgentSessions(pool, { userId, status = 'open', limit = 20, before = null }) {
  if (!['open', 'archived'].includes(status)) throw new AgentSessionError(400, 'status must be open or archived');
  const bounded = Math.max(1, Math.min(LIST_LIMIT_MAX, Number(limit) || 20));
  const cursor = before == null ? null : new Date(before);
  if (cursor && Number.isNaN(cursor.valueOf())) throw new AgentSessionError(400, 'before must be a timestamp');
  const { rows } = await pool.query(
    // The same projection as getAgentSession below, so the list and the
    // detail cannot disagree about what a session looks like.
    `SELECT s.id, s.user_id, s.title, s.title_source, s.status, s.focus_app_id,
            s.focus_context, s.active_change_id, s.active_turn,
            s.last_activity_at, s.created_at, s.archived_at,
            fa.slug AS focus_app_slug, fa.name AS focus_app_name,
            c.id AS change_id, c.status AS change_status, c.pr_number AS change_pr_number,
            COALESCE(c.pr_title, c.session_title) AS change_title,
            c.staging_url AS change_staging_url, c.check_state AS change_check_state,
            ca.slug AS change_app_slug, ca.name AS change_app_name
       FROM agent_sessions s
       LEFT JOIN apps fa ON fa.id = s.focus_app_id
       LEFT JOIN chat_sessions c ON c.id = s.active_change_id
       LEFT JOIN apps ca ON ca.id = c.app_id
      WHERE s.user_id = $1 AND s.status = $2
        AND ($3::timestamptz IS NULL OR s.last_activity_at < $3::timestamptz)
      ORDER BY s.last_activity_at DESC, s.id DESC
      LIMIT $4`,
    [userId, status, cursor, bounded + 1]
  );
  const page = rows.slice(0, bounded).map(shapeSession);
  return {
    sessions: page,
    nextBefore: rows.length > bounded ? page[page.length - 1].lastActivityAt : null,
  };
}

async function getAgentSession(pool, { userId, id }) {
  const sessionId = positiveInt(Number(id));
  if (!sessionId) return null;
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.title, s.title_source, s.status, s.focus_app_id,
            s.focus_context, s.active_change_id, s.active_turn,
            s.last_activity_at, s.created_at, s.archived_at,
            fa.slug AS focus_app_slug, fa.name AS focus_app_name,
            c.id AS change_id, c.status AS change_status, c.pr_number AS change_pr_number,
            COALESCE(c.pr_title, c.session_title) AS change_title,
            c.staging_url AS change_staging_url, c.check_state AS change_check_state,
            ca.slug AS change_app_slug, ca.name AS change_app_name
       FROM agent_sessions s
       LEFT JOIN apps fa ON fa.id = s.focus_app_id
       LEFT JOIN chat_sessions c ON c.id = s.active_change_id
       LEFT JOIN apps ca ON ca.id = c.app_id
      WHERE s.id = $1 AND s.user_id = $2`,
    [sessionId, userId]
  );
  if (!rows.length) return null;
  const session = shapeSession(rows[0]);
  // Every change this conversation has started, newest first: the active one,
  // the parked ones the user can switch back to, and the closed ones.
  const { rows: changes } = await pool.query(
    `SELECT c.id AS change_id, c.status AS change_status, c.pr_number AS change_pr_number,
            COALESCE(c.pr_title, c.session_title) AS change_title,
            c.staging_url AS change_staging_url, c.check_state AS change_check_state,
            a.slug AS change_app_slug, a.name AS change_app_name
       FROM chat_sessions c JOIN apps a ON a.id = c.app_id
      WHERE c.agent_session_id = $1 AND c.user_id = $2
      ORDER BY c.id DESC
      LIMIT 50`,
    [sessionId, userId]
  );
  session.changes = changes.map(shapeChangeRow);
  return session;
}

async function renameAgentSession(pool, { userId, id, title }) {
  const clean = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
  if (!clean) throw new AgentSessionError(400, 'Title required');
  if (clean.length > TITLE_MAX) throw new AgentSessionError(400, `Title too long (max ${TITLE_MAX} chars)`);
  const { rows } = await pool.query(
    `UPDATE agent_sessions SET title = $1, title_source = 'manual'
      WHERE id = $2 AND user_id = $3
      RETURNING id`,
    [clean, positiveInt(Number(id)), userId]
  );
  return rows.length ? getAgentSession(pool, { userId, id }) : null;
}

// Archiving parks the active change and hides the session. It never
// withdraws a proposal: a change up for a vote keeps its vote, and every
// change stays reachable from its own page.
async function archiveAgentSession(pool, { userId, id }) {
  const { rows } = await pool.query(
    `UPDATE agent_sessions SET status = 'archived', archived_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'open'
      RETURNING active_change_id`,
    [positiveInt(Number(id)), userId]
  );
  if (!rows.length) return null;
  if (rows[0].active_change_id) {
    await parkChange(pool, { userId, changeId: rows[0].active_change_id, reason: 'agent-session-archived' });
  }
  return getAgentSession(pool, { userId, id });
}

async function unarchiveAgentSession(pool, { userId, id }) {
  const { rows } = await pool.query(
    `UPDATE agent_sessions SET status = 'open', archived_at = NULL, last_activity_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'archived'
      RETURNING id`,
    [positiveInt(Number(id)), userId]
  );
  return rows.length ? getAgentSession(pool, { userId, id }) : null;
}

// The conversation: every row the session and its changes wrote, oldest
// first, paged by id. The owner check is the join, so another user's id
// reads as an empty session rather than as a probe.
async function listMessages(pool, { userId, id, afterId = 0, limit = 100 }) {
  const sessionId = positiveInt(Number(id));
  if (!sessionId) return null;
  const { rows: owner } = await pool.query(
    'SELECT id FROM agent_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );
  if (!owner.length) return null;
  const bounded = Math.max(1, Math.min(MESSAGES_LIMIT_MAX, Number(limit) || 100));
  const after = Number.isSafeInteger(Number(afterId)) && Number(afterId) > 0 ? Number(afterId) : 0;
  const { rows } = await pool.query(
    `SELECT id, session_id, role, content, model, cost_cents, metadata, created_at
       FROM chat_session_messages
      WHERE agent_session_id = $1 AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [sessionId, after, bounded + 1]
  );
  const page = rows.slice(0, bounded);
  return {
    messages: page.map((row) => ({
      id: row.id,
      changeId: row.session_id || null,
      role: row.role,
      content: row.content,
      model: row.model || null,
      costCents: row.cost_cents == null ? null : Number(row.cost_cents),
      metadata: row.metadata || {},
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    })),
    nextAfter: rows.length > bounded ? page[page.length - 1].id : null,
  };
}

// A row that belongs to the conversation itself rather than to any one
// change: a change starting, a change closing. `session_id` is NULL on
// purpose, so a change's own transcript slice stays exactly what it wrote.
async function appendConversationEvent(pool, { agentSessionId, content, event, metadata = {} }) {
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, metadata)
     VALUES (NULL, $1, 'system', $2, $3::jsonb)`,
    [agentSessionId, content, JSON.stringify({ ...metadata, agentSessionEvent: event })]
  );
  await pool.query('UPDATE agent_sessions SET last_activity_at = NOW() WHERE id = $1', [agentSessionId]);
}

// ── Changes ────────────────────────────────────────────────────────────

// Park a change: today's pause, which releases its worker and keeps its
// branch, preview and pull request. A promoted change keeps its vote and its
// status; pauseSession only ever demotes an `active` one.
async function parkChange(pool, { userId, changeId, reason }) {
  const sessionLifecycle = require('./session-lifecycle');
  try {
    return await sessionLifecycle.pauseSession({ pool, sessionId: changeId, userId, reason });
  } catch (err) {
    log.warn('agent-sessions', 'Could not park change', { changeId, reason, err: err.message });
    return { paused: false };
  }
}

// Before a new change starts in a session, the one it was working on is
// parked, so the one-active-change rule (D4) holds and the parked change's
// worker slot is free for the new one. Returns the session row the new
// change will link to, or throws if the session is not the caller's or is
// archived — which the delegation's own liveness check makes unreachable in
// practice, and which is checked again here because this is the write.
async function prepareChangeStart(pool, { agentSessionId, userId }) {
  const { rows } = await pool.query(
    `SELECT id, active_change_id FROM agent_sessions
      WHERE id = $1 AND user_id = $2 AND status = 'open'`,
    [agentSessionId, userId]
  );
  if (!rows.length) throw new AgentSessionError(404, 'Agent session not found');
  if (rows[0].active_change_id) {
    await parkChange(pool, { userId, changeId: rows[0].active_change_id, reason: 'agent-session-switch' });
  }
  return rows[0];
}

// Make a freshly created change this session's active change. Rows the
// change wrote before it was linked (none, in the normal path) are stamped
// too, so nothing it said is missing from the conversation.
async function linkChange(pool, { agentSessionId, userId, change }) {
  const { rows } = await pool.query(
    `UPDATE chat_sessions SET agent_session_id = $1
      WHERE id = $2 AND user_id = $3 AND agent_session_id IS NULL
      RETURNING id, app_id`,
    [agentSessionId, change.id, userId]
  );
  if (!rows.length) return false;
  await pool.query(
    `UPDATE chat_session_messages SET agent_session_id = $1
      WHERE session_id = $2 AND agent_session_id IS NULL`,
    [agentSessionId, change.id]
  );
  await pool.query(
    `UPDATE agent_sessions
        SET active_change_id = $1, focus_app_id = $2, last_activity_at = NOW()
      WHERE id = $3 AND user_id = $4`,
    [change.id, rows[0].app_id, agentSessionId, userId]
  );
  const title = change.session_title || change.title || null;
  const where = change.app_name || change.app_slug || 'the app';
  await appendConversationEvent(pool, {
    agentSessionId,
    content: title ? `Started a change on ${where}: ${title}` : `Started a change on ${where}`,
    event: 'change_started',
    metadata: { changeId: change.id },
  });
  return true;
}

// The sentence the conversation gets when one of its changes closes.
function closedSentence({ prNumber, outcome }) {
  const ref = prNumber ? `PR #${prNumber}` : 'The change';
  switch (outcome) {
    case 'merged': return `${ref} merged. It is part of the app now.`;
    case 'rejected': return `${ref} was set aside by the group's vote.`;
    case 'withdrawn': return `${ref} was withdrawn.`;
    case 'replaced': return `${ref} was replaced by a newer proposal.`;
    default: return `${ref} was closed.`;
  }
}

// How an archive reason reads to the person whose conversation it was.
function outcomeForArchiveReason(reason) {
  if (reason === 'auto-rejected') return 'rejected';
  if (reason === 'proposal-replaced') return 'replaced';
  if (reason === 'manual') return 'withdrawn';
  return 'closed';
}

// Called when a change closes, from the merge path and the archive path.
// Posts a note to the parent conversation and, if the change was the active
// one, clears it so the next dispatch has to name a change. Best-effort and
// never throws: a merge or an archive must not fail over a conversation note.
//
// `change` is the row the caller already holds. A classic session carries
// `agent_session_id: null`, and returns here without a query; a row that did
// not select the column (undefined) is looked up.
async function noteChangeClosed(pool, { change, outcome }) {
  if (!change || change.agent_session_id === null) return false;
  try {
    let agentSessionId = change.agent_session_id;
    let prNumber = change.pr_number || null;
    if (agentSessionId === undefined) {
      const { rows } = await pool.query(
        `SELECT agent_session_id, pr_number FROM chat_sessions
          WHERE id = $1 AND agent_session_id IS NOT NULL`,
        [change.id]
      );
      agentSessionId = rows.length ? rows[0].agent_session_id : null;
      prNumber = prNumber || (rows.length ? rows[0].pr_number : null);
    }
    if (!positiveInt(Number(agentSessionId))) return false;
    await pool.query(
      `UPDATE agent_sessions SET active_change_id = NULL
        WHERE id = $1 AND active_change_id = $2`,
      [agentSessionId, change.id]
    );
    await appendConversationEvent(pool, {
      agentSessionId,
      content: closedSentence({ prNumber, outcome }),
      event: 'change_closed',
      metadata: { changeId: change.id, outcome },
    });
    return true;
  } catch (err) {
    log.warn('agent-sessions', 'Could not note a closed change', {
      changeId: change && change.id, outcome, err: err.message,
    });
    return false;
  }
}

// ── The Mayor's own moves (#2779 step 3b) ──────────────────────────────

// Make one of this conversation's earlier changes the active one again. The
// change must be the user's, started from this session, and still open; the
// change it replaces is parked. Resuming a parked change's worker happens on
// the next dispatch, not here.
async function switchActiveChange(pool, { agentSessionId, userId, changeId }) {
  const id = positiveInt(Number(changeId));
  if (!id) throw new AgentSessionError(400, 'changeId must be a positive integer');
  const { rows: change } = await pool.query(
    `SELECT c.id, c.status, c.app_id, c.pr_number, COALESCE(c.pr_title, c.session_title) AS title
       FROM chat_sessions c
      WHERE c.id = $1 AND c.user_id = $2 AND c.agent_session_id = $3`,
    [id, userId, agentSessionId]
  );
  if (!change.length) throw new AgentSessionError(404, 'That change was not started from this conversation.');
  if (['archived', 'merged'].includes(change[0].status)) {
    throw new AgentSessionError(409, `That change is ${change[0].status}, so it cannot be made active.`);
  }
  const { rows: session } = await pool.query(
    `SELECT active_change_id FROM agent_sessions
      WHERE id = $1 AND user_id = $2 AND status = 'open'`,
    [agentSessionId, userId]
  );
  if (!session.length) throw new AgentSessionError(404, 'Agent session not found');
  const previous = session[0].active_change_id;
  if (previous === id) return { changed: false, change: change[0] };
  if (previous) await parkChange(pool, { userId, changeId: previous, reason: 'agent-session-switch' });
  await pool.query(
    `UPDATE agent_sessions SET active_change_id = $1, focus_app_id = $2, last_activity_at = NOW()
      WHERE id = $3 AND user_id = $4`,
    [id, change[0].app_id, agentSessionId, userId]
  );
  const ref = change[0].pr_number ? `PR #${change[0].pr_number} (change ${id})` : `change ${id}`;
  await appendConversationEvent(pool, {
    agentSessionId,
    content: `Switched to ${ref}.`,
    event: 'change_switched',
    metadata: { changeId: id, previousChangeId: previous || null },
  });
  return { changed: true, change: change[0] };
}

// Record which app the user means. Resolved with the user's own access, so
// the focus can never name an app they cannot see.
async function setFocusApp(pool, { agentSessionId, user, slug }) {
  const clean = typeof slug === 'string' ? slug : '';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(clean)) throw new AgentSessionError(400, 'slug must be an app slug');
  const app = await appAccess.getAppForUser(pool, clean, user, 'view', appAccess.ACCESS_COLUMNS);
  if (!app) throw new AgentSessionError(404, 'That app does not exist, or the user cannot see it.');
  const { rows } = await pool.query(
    `UPDATE agent_sessions SET focus_app_id = $1
      WHERE id = $2 AND user_id = $3 AND status = 'open'
      RETURNING id`,
    [app.id, agentSessionId, user.id]
  );
  if (!rows.length) throw new AgentSessionError(404, 'Agent session not found');
  return { id: app.id, slug: app.slug };
}

// ── The turn lease ─────────────────────────────────────────────────────
//
// One Mayor turn at a time per conversation. The lease is a row write, not a
// process-local lock, so two tabs (or two pods) cannot both start a turn. A
// running turn renews it every minute (a dispatch can run far longer than
// the stale window), so a lease not renewed for TURN_LEASE_STALE_MINUTES
// belongs to a turn whose process died without releasing it, and is taken
// over.
const TURN_LEASE_STALE_MINUTES = 20;

async function acquireTurnLease(pool, { agentSessionId, userId, turnId }) {
  const { rows } = await pool.query(
    `UPDATE agent_sessions
        SET active_turn = jsonb_build_object('id', $3::text, 'startedAt', NOW()),
            last_activity_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'open'
        AND (active_turn IS NULL
             OR COALESCE(active_turn->>'renewedAt', active_turn->>'startedAt')::timestamptz
                < NOW() - make_interval(mins => $4))
      RETURNING id`,
    [agentSessionId, userId, turnId, TURN_LEASE_STALE_MINUTES]
  );
  return rows.length > 0;
}

// Only the turn holding the lease renews it.
async function renewTurnLease(pool, { agentSessionId, turnId }) {
  const { rows } = await pool.query(
    `UPDATE agent_sessions
        SET active_turn = active_turn || jsonb_build_object('renewedAt', NOW())
      WHERE id = $1 AND active_turn->>'id' = $2
      RETURNING id`,
    [agentSessionId, turnId]
  );
  return rows.length > 0;
}

async function releaseTurnLease(pool, { agentSessionId, turnId }) {
  await pool.query(
    `UPDATE agent_sessions SET active_turn = NULL
      WHERE id = $1 AND active_turn->>'id' = $2`,
    [agentSessionId, turnId]
  );
}

module.exports = {
  TITLE_MAX,
  ENTRIES,
  AgentSessionError,
  parseHint,
  resolveHint,
  shapeSession,
  createAgentSession,
  listAgentSessions,
  getAgentSession,
  renameAgentSession,
  archiveAgentSession,
  unarchiveAgentSession,
  listMessages,
  appendConversationEvent,
  parkChange,
  prepareChangeStart,
  linkChange,
  closedSentence,
  outcomeForArchiveReason,
  noteChangeClosed,
  switchActiveChange,
  setFocusApp,
  TURN_LEASE_STALE_MINUTES,
  acquireTurnLease,
  renewTurnLease,
  releaseTurnLease,
};
