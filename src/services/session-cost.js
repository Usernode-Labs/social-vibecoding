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

module.exports = { sessionCostCents };
