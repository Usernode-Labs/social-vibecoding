// Read-only access to the pre-cutover timestamp delegation history.
// The one-shot native delegation cutover closes every open period and the
// epoch ledger is the sole authority from the immutable cutover epoch on.
'use strict';

// Reads the legacy open-period state without locking. It exists only for
// historical compatibility reads; once cutover C is set the database closes
// and freezes every period, and the epoch ledger is the current authority.
// Returns
// `{ delegated, delegatedSince }` with `delegatedSince` a raw Date (or
// null), left to the caller to `iso()`.
async function readDelegationState(pool, account) {
  const { rows } = await pool.query(
    'SELECT started_at FROM account_delegation_periods WHERE account = $1 AND ended_at IS NULL LIMIT 1',
    [account]
  );
  const open = rows[0] || null;
  return { delegated: !!open, delegatedSince: open ? open.started_at : null };
}

module.exports = { readDelegationState };
