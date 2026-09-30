'use strict';

// Explicit persistence mapping only. Receipt comparison, trace capture and the
// atomic write sequence belong to the shared decision runtime.
const journal = {
  async findReceipt(client, sessionId, actionId) {
    const { rows } = await client.query(`SELECT action_hash, decision FROM proposal_review_receipts
      WHERE session_id = $1 AND action_id = $2`, [sessionId, actionId]);
    return rows[0];
  },
  saveReceipt: (client, values) => client.query(`INSERT INTO proposal_review_receipts (session_id, action_id, action_hash, decision)
    VALUES ($1, $2, $3, $4)`, values),
  saveTrace: (client, values) => client.query(`INSERT INTO proposal_review_decisions (session_id, action_id, reducer_version, pre_state, action, facts, decision)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, values),
  async trace(client, sessionId) {
    const { rows } = await client.query(`SELECT id, action_id, reducer_version, pre_state, action, facts, decision, created_at
      FROM proposal_review_decisions WHERE session_id = $1 ORDER BY id`, [sessionId]);
    return rows;
  },
};

module.exports = { journal };
