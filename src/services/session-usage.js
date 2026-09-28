'use strict';

const finiteCents = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function usageView(row) {
  if (!row) return null;
  const chatCents = finiteCents(row.chat_cents);
  const claudeCents = finiteCents(row.agent_cost_cents);
  const openRouterCents = finiteCents(row.openrouter_cents);
  return {
    totalCents: chatCents + claudeCents + openRouterCents,
    chatCents, claudeCents, openRouterCents,
    pendingOrUnpriced: Number(row.unpriced_turns) > 0,
    basis: 'recorded_list_price',
  };
}

async function readSessionUsage(pool, sessionId, userId) {
  // The same disjoint sources as model-costs.js. The Claude aggregate is an
  // alternative to its per-model rows, never an additional amount. Receipts
  // from the live stream can overlap both ledgers and must not be added here.
  const { rows } = await pool.query(
    `SELECT cs.agent_cost_cents,
            (SELECT COALESCE(SUM(m.cost_cents), 0) FROM chat_session_messages m
              WHERE m.session_id = cs.id AND m.model IS NOT NULL AND m.cost_cents > 0) AS chat_cents,
            (SELECT COALESCE(SUM(t.estimated_cost_usd), 0) * 100 FROM agent_turns t
              WHERE t.session_id = cs.id AND t.estimated_cost_usd > 0) AS openrouter_cents,
            (SELECT COUNT(*) FROM agent_turns t
              WHERE t.session_id = cs.id AND t.estimated_cost_usd IS NULL) AS unpriced_turns
       FROM chat_sessions cs WHERE cs.id = $1 AND cs.user_id = $2`,
    [sessionId, userId],
  );
  return usageView(rows[0]);
}

module.exports = { readSessionUsage, usageView };
