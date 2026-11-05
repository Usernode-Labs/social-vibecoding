'use strict';

// #3249: what one change (a dev session) has cost so far, in cents, for the
// dev chat meter's "this change $X". The same disjoint sources the schema
// comment on chat_sessions.agent_cost_cents and model-costs.js
// (observedPerModel) define a change's cost by:
//
//   chat_session_messages.cost_cents  — Homeroom's own replies in the chat
//   chat_sessions.agent_cost_cents    — the Claude coding agent's ledger
//   agent_turns.estimated_cost_usd    — OpenRouter coding turns (list price)
//
// A list-price cost record, not a billing record: credits are billed from
// llm_usage. Sessions older than the ledger read low, which is accepted.

async function sessionCostCents(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT (
        COALESCE((SELECT SUM(m.cost_cents) FROM chat_session_messages m
                   WHERE m.session_id = cs.id AND m.cost_cents > 0), 0)
        + GREATEST(cs.agent_cost_cents, 0)
        + COALESCE((SELECT SUM(t.estimated_cost_usd) * 100 FROM agent_turns t
                     WHERE t.session_id = cs.id AND t.estimated_cost_usd > 0), 0)
      )::float8 AS cents
       FROM chat_sessions cs
      WHERE cs.id = $1`,
    [sessionId],
  );
  const cents = Number(rows[0]?.cents);
  return Number.isFinite(cents) && cents > 0 ? cents : 0;
}

// #6116: the same figure for a change's page, whose reads (/details, the
// proposal read) answer anyone who may view the change. The meter's own read
// (GET /api/sessions/:id) is its author's or an admin's, and so is this: a
// voter on a change never gets what it cost its author. A change submitted
// from a fork was not built in a dev session here, so it has no such figure,
// whatever else the ledger holds for its row. `null` for all of these, for a
// read that failed and for nothing recorded: the page then says nothing.
function canReadSessionCost(session, user) {
  if (!session || !user) return false;
  return session.user_id === user.id || !!user.isAdmin;
}

async function sessionCostForViewer(pool, session, user) {
  if (!canReadSessionCost(session, user) || session.source === 'imported') return null;
  try {
    return (await sessionCostCents(pool, session.id)) || null;
  } catch {
    return null;
  }
}

module.exports = { sessionCostCents, canReadSessionCost, sessionCostForViewer };
