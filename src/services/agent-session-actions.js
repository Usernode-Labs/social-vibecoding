'use strict';

// The agent-session Mayor's confirmation cards (#2779, spec:
// docs/agent-sessions.md, "How confirmation works").
//
// The Mayor never writes to the platform from the model. When it calls a tool
// that changes something (services/mcp-audiences.js MAYOR_CONFIRMED_TOOLS),
// the turn stores the exact input here, sealed, and shows the user a card.
// Only the owner pressing Confirm runs it:
//
//   1. the row is claimed atomically — pending, unexpired, the owner's, in an
//      open session — so a card runs at most once;
//   2. the sealed input is opened and checked against its fingerprint, so what
//      runs is byte-for-byte what the card showed;
//   3. it runs through the platform MCP with a grant minted for this one
//      action — write scope, bound to the app or change the input names,
//      revoked as soon as the call returns — so every route re-checks the
//      user's own authority as it would for the browser;
//   4. the outcome is written back to the card and into the conversation, so
//      the Mayor reads it on its next turn.
//
// A "yes" typed into the chat confirms nothing: nothing reads chat text here.

const crypto = require('node:crypto');
const log = require('./logger');
const confirmations = require('./confirmations');
const { MAYOR_CONFIRMED_TOOLS } = require('./mcp-audiences');
const { READ_SCOPE, WRITE_SCOPE } = require('./mcp-connect-constants');

const ACTION_TTL_MS = confirmations.MAX_TTL_MS;
const MAX_STORED_RESULT_CHARS = 8 * 1024;

// How each card is titled, and how its outcome reads in the conversation.
const ACTION_LABELS = Object.freeze({
  start_change: 'Start a change',
  promote_change: 'Put the change up for the group vote',
  sync_change: 'Sync the change with main',
  withdraw_change: 'Withdraw the change',
  create_request: 'File a request',
  claim_request: 'Claim the request',
  release_request: 'Release the request',
  update_proposal_issues: 'Update the requests the proposal addresses',
});

class ActionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AgentSessionActionError';
    this.status = status;
    this.code = code;
  }
}

function isConfirmedTool(name) {
  return MAYOR_CONFIRMED_TOOLS.includes(name);
}

// ── Preparing a card ───────────────────────────────────────────────────

const MAX_ISSUE_NUMBER = 2147483647;

// Who is working on a request is shared information: the board shows it, and
// two people building the same request find out there. start_change links the
// requests it is given, and the first is also claimed for the user. So a
// change started in a conversation the user opened from a request links that
// request unless the Mayor said otherwise: it names requests itself, or
// passes an empty list because the change is for something else. Only the
// conversation's first change on that request gets it, so a later, unrelated
// change on the same app does not claim a request the user has moved on from.
// It lands on the card's input, so the user sees the link before confirming.
async function withOpenedRequest(pool, { userId, agentSessionId, toolName, input }) {
  if (toolName !== 'start_change' || !input || typeof input !== 'object' || input.linkedIssues !== undefined) {
    return input;
  }
  const { rows } = await pool.query(
    `SELECT s.focus_context, a.slug
       FROM agent_sessions s JOIN apps a ON a.id = s.focus_app_id
      WHERE s.id = $1 AND s.user_id = $2`,
    [agentSessionId, userId]
  );
  if (!rows.length) return input;
  const context = rows[0].focus_context || {};
  const issueNumber = Number(context.issueNumber);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || issueNumber > MAX_ISSUE_NUMBER) return input;
  if (rows[0].slug !== input.slug) return input;
  const { rows: linked } = await pool.query(
    `SELECT 1 FROM chat_sessions
      WHERE agent_session_id = $1 AND $2 = ANY(linked_issues)
      LIMIT 1`,
    [agentSessionId, issueNumber]
  );
  if (linked.length) return input;
  return { ...input, linkedIssues: [issueNumber] };
}

async function prepareAction(pool, { config, userId, agentSessionId, toolName, input: given, now = new Date() }) {
  if (!isConfirmedTool(toolName)) throw new ActionError(400, 'invalid_action', `${toolName} is not a confirmed action.`);
  const input = await withOpenedRequest(pool, { userId, agentSessionId, toolName, input: given });
  const { sealed, inputHash } = confirmations.sealAction(input, config && config.dataEncryptionKey);
  const { issuedAt, expiresAt } = confirmations.expiryFor(now, ACTION_TTL_MS);
  const id = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO agent_session_actions
       (id, agent_session_id, user_id, tool_name, sealed_input, input_hash, expires_at, created_at)
     SELECT $1, s.id, s.user_id, $4, $5::jsonb, $6, $7, $8
       FROM agent_sessions s
      WHERE s.id = $2 AND s.user_id = $3 AND s.status = 'open'
     RETURNING id`,
    [id, agentSessionId, userId, toolName, JSON.stringify(sealed), inputHash, expiresAt, issuedAt]
  );
  if (!rows.length) throw new ActionError(404, 'session_not_found', 'That agent session is not open.');
  return {
    id,
    toolName,
    title: ACTION_LABELS[toolName],
    input: JSON.parse(confirmations.normalizedJson(input)),
    expiresAt: expiresAt.toISOString(),
  };
}

// ── Reading cards ──────────────────────────────────────────────────────

function shapeAction(row, now = new Date()) {
  const expired = row.status === 'pending' && new Date(row.expires_at) <= now;
  return {
    id: row.id,
    toolName: row.tool_name,
    title: ACTION_LABELS[row.tool_name] || row.tool_name,
    status: expired ? 'expired' : row.status,
    result: row.result || null,
    // The card's "Confirmed · …" line (#3017).
    outcome: row.result ? outcomeLine(row.tool_name, row.result) : null,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
  };
}

async function listActions(pool, { userId, agentSessionId, limit = 50 }) {
  const { rows } = await pool.query(
    `SELECT a.id, a.tool_name, a.status, a.result, a.expires_at, a.created_at, a.decided_at
       FROM agent_session_actions a
      WHERE a.agent_session_id = $1 AND a.user_id = $2
      ORDER BY a.created_at DESC
      LIMIT $3`,
    [agentSessionId, userId, Math.max(1, Math.min(100, Number(limit) || 50))]
  );
  return rows.map((row) => shapeAction(row));
}

// ── Running a card ─────────────────────────────────────────────────────

// What the one-action grant is bound to. A tool that names a change is bound
// to that change (and its app); one that names an app, to that app. A change
// that is not the user's is refused here, before any grant exists.
async function bindingFor(pool, { userId, toolName, input }) {
  const changeId = ['promote_change', 'sync_change', 'withdraw_change'].includes(toolName)
    ? input.changeId
    : toolName === 'update_proposal_issues' ? input.proposalId : null;
  if (changeId != null) {
    const id = Number(changeId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ActionError(400, 'invalid_action', 'The action names no change.');
    const { rows } = await pool.query(
      'SELECT app_id FROM chat_sessions WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (!rows.length) throw new ActionError(404, 'change_not_found', 'That change is not one of yours.');
    return { changeId: id, appId: rows[0].app_id };
  }
  if (typeof input.slug === 'string') {
    const { rows } = await pool.query('SELECT id FROM apps WHERE slug = $1', [input.slug]);
    if (!rows.length) throw new ActionError(404, 'app_not_found', 'That app does not exist.');
    return { changeId: null, appId: rows[0].id };
  }
  return { changeId: null, appId: null };
}

function boundedResult(result) {
  const structured = result.structured && typeof result.structured === 'object' ? result.structured : null;
  let json = structured ? JSON.stringify(structured) : null;
  if (json && json.length > MAX_STORED_RESULT_CHARS) json = null;
  return {
    ok: !result.isError,
    code: result.isError && structured && typeof structured.code === 'string' ? structured.code : null,
    structured: json ? structured : null,
    text: String(result.text || '').slice(0, MAX_STORED_RESULT_CHARS),
  };
}

// Tool answers wrap member-written text (a title, a username) in envelope
// tags for the model. A person reads it without them.
function plainText(value) {
  return String(value == null ? '' : value)
    .replace(/<\/?untrusted-content>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function requestNumber(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function requestList(values) {
  const numbers = (Array.isArray(values) ? values : []).map(requestNumber).filter(Boolean);
  return numbers.map((n) => `#${n}`).join(', ');
}

// What a finished card says happened, in the user's words (#3017). The tools
// whose answer has no nextStep, or one written for an agent, are read field
// by field: create_request has none, so its card used to print the raw JSON.
// The rest say their nextStep or message. A result that is only JSON says
// nothing rather than print it.
//
// `forModel` is the conversation's note, which the Mayor reads: member-written
// text in it stays inside its envelope, as it is in every tool result.
function outcomeLine(toolName, stored, { forModel = false } = {}) {
  if (!stored) return null;
  const s = stored.structured && typeof stored.structured === 'object' ? stored.structured : null;
  const member = (value) => {
    const text = plainText(value);
    return text && forModel ? `<untrusted-content>${text}</untrusted-content>` : text;
  };
  if (stored.ok && s) {
    if (toolName === 'create_request') {
      const n = requestNumber(s.number);
      const title = member(s.title);
      if (n) return `Filed request #${n}${title ? `: ${title}` : ''}.`;
      return 'Filed the request.';
    }
    if (toolName === 'claim_request' && requestNumber(s.number)) {
      const others = (Array.isArray(s.alsoClaimedBy) ? s.alsoClaimedBy : []).map(member).filter(Boolean);
      return `Claimed request #${requestNumber(s.number)} for you`
        + `${others.length ? `. Also claimed by ${others.join(', ')}` : ''}.`;
    }
    if (toolName === 'release_request' && requestNumber(s.number)) {
      return s.cleared
        ? `Released your claim on request #${requestNumber(s.number)}.`
        : `You had no claim on request #${requestNumber(s.number)}.`;
    }
    if (toolName === 'start_change' && requestNumber(s.changeId)) {
      const linked = requestList(s.linkedIssues);
      return `Change ${requestNumber(s.changeId)} is open${s.appSlug ? ` on ${plainText(s.appSlug)}` : ''}`
        + `${linked ? `, linked to request ${linked}` : ''}.`;
    }
    if (toolName === 'promote_change' && requestNumber(s.changeId)) {
      const pr = requestNumber(s.prNumber);
      return `${pr ? `PR #${pr} (change ${requestNumber(s.changeId)})` : `Change ${requestNumber(s.changeId)}`} `
        + 'is up for the group\'s vote.';
    }
    if (toolName === 'update_proposal_issues' && Array.isArray(s.linkedIssues)) {
      const added = requestList(s.addedIssues);
      const removed = requestList(s.removedIssues);
      const parts = [added && `linked request ${added}`, removed && `unlinked request ${removed}`].filter(Boolean);
      if (!parts.length) return 'The linked requests were already as asked.';
      const said = parts.join(' and ');
      return `${said.charAt(0).toUpperCase()}${said.slice(1)}.`;
    }
  }
  const said = s && (s.nextStep || s.message);
  if (typeof said === 'string' && plainText(said)) return plainText(said);
  const text = plainText(stored.text);
  return text && !/^[[{]/.test(text) ? text : null;
}

// The line the conversation gets, which the Mayor reads on its next turn. The
// platform's own nextStep or message when it has one, because that is what
// the browser would have said, and the plain outcome otherwise.
function outcomeSentence(toolName, stored) {
  const label = ACTION_LABELS[toolName] || toolName;
  const next = stored.structured && (stored.structured.nextStep || stored.structured.message);
  const said = (typeof next === 'string' && next) || outcomeLine(toolName, stored, { forModel: true });
  if (stored.ok) return said ? `Confirmed: ${label}. ${said}` : `Confirmed: ${label}.`;
  return said ? `${label} did not go through. ${said}` : `${label} did not go through.`;
}

async function confirmAction(pool, { config, user, agentSessionId, actionId, deps = {} }) {
  const openMayorMcp = deps.openMayorMcp || require('./mayor/mcp-shim').openMayorMcp;
  const agentSessions = deps.agentSessions || require('./agent-sessions');
  if (typeof actionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(actionId)) {
    throw new ActionError(404, 'action_not_found', 'That confirmation does not exist.');
  }
  const { rows } = await pool.query(
    `UPDATE agent_session_actions a
        SET status = 'running', decided_at = NOW()
       FROM agent_sessions s
      WHERE a.id = $1 AND a.user_id = $2 AND a.agent_session_id = $3
        AND a.status = 'pending' AND a.expires_at > NOW()
        AND s.id = a.agent_session_id AND s.user_id = $2 AND s.status = 'open'
      RETURNING a.tool_name, a.sealed_input, a.input_hash`,
    [actionId, user.id, agentSessionId]
  );
  if (!rows.length) {
    const { rows: existing } = await pool.query(
      `SELECT a.status, a.expires_at, s.status AS session_status
         FROM agent_session_actions a
         JOIN agent_sessions s ON s.id = a.agent_session_id
        WHERE a.id = $1 AND a.user_id = $2 AND a.agent_session_id = $3`,
      [actionId, user.id, agentSessionId]
    );
    if (!existing.length) throw new ActionError(404, 'action_not_found', 'That confirmation does not exist.');
    const [card] = existing;
    if (card.status !== 'pending') {
      throw new ActionError(409, 'action_used', 'This confirmation was already used or dismissed.');
    }
    if (new Date(card.expires_at) <= new Date()) {
      throw new ActionError(410, 'action_expired', 'This confirmation expired. Ask again and a fresh one will be prepared.');
    }
    throw new ActionError(409, 'session_archived', 'This conversation is archived. Unarchive it to confirm.');
  }
  const toolName = rows[0].tool_name;
  let stored;
  try {
    const { input } = confirmations.openAction(rows[0].sealed_input, rows[0].input_hash, config.dataEncryptionKey);
    const binding = await bindingFor(pool, { userId: user.id, toolName, input });
    const shim = await openMayorMcp({
      pool,
      config,
      userId: user.id,
      agentSessionId,
      scopes: [READ_SCOPE, WRITE_SCOPE],
      appId: binding.appId,
      changeId: binding.changeId,
      ttlSeconds: 120,
    });
    try {
      stored = boundedResult(await shim.call(toolName, input));
    } finally {
      await shim.close('action_done');
    }
  } catch (err) {
    stored = {
      ok: false,
      code: err.code || 'action_failed',
      structured: null,
      text: err instanceof ActionError || err instanceof confirmations.ActionConfirmationError
        ? err.message
        : 'The action could not run.',
    };
    if (!(err instanceof ActionError)) {
      log.warn('agent-sessions', 'Confirmed action failed to run', { actionId, toolName, err: err.message });
    }
  }
  await pool.query(
    `UPDATE agent_session_actions SET status = $2, result = $3::jsonb WHERE id = $1`,
    [actionId, stored.ok ? 'done' : 'failed', JSON.stringify(stored)]
  );
  await agentSessions.appendConversationEvent(pool, {
    agentSessionId,
    content: outcomeSentence(toolName, stored),
    event: 'action_result',
    metadata: { actionId, toolName, ok: stored.ok },
  });
  return {
    id: actionId, toolName, status: stored.ok ? 'done' : 'failed', result: stored, outcome: outcomeLine(toolName, stored),
  };
}

async function dismissAction(pool, { user, agentSessionId, actionId, deps = {} }) {
  const agentSessions = deps.agentSessions || require('./agent-sessions');
  if (typeof actionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(actionId)) return false;
  const { rows } = await pool.query(
    `UPDATE agent_session_actions SET status = 'dismissed', decided_at = NOW()
      WHERE id = $1 AND user_id = $2 AND agent_session_id = $3 AND status = 'pending'
      RETURNING tool_name`,
    [actionId, user.id, agentSessionId]
  );
  if (!rows.length) return false;
  await agentSessions.appendConversationEvent(pool, {
    agentSessionId,
    content: `Dismissed: ${ACTION_LABELS[rows[0].tool_name] || rows[0].tool_name}. Nothing was changed.`,
    event: 'action_dismissed',
    metadata: { actionId, toolName: rows[0].tool_name },
  });
  return true;
}

module.exports = {
  ACTION_TTL_MS,
  ACTION_LABELS,
  ActionError,
  isConfirmedTool,
  prepareAction,
  listActions,
  shapeAction,
  bindingFor,
  boundedResult,
  outcomeLine,
  outcomeSentence,
  withOpenedRequest,
  confirmAction,
  dismissAction,
};
