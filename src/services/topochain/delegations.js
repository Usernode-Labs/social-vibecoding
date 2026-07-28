// Topochain v4 — shared `account_delegation_periods` open/close semantics
// (SPEC 1418-1453; Task 6's judgment call #4, restated: this table carries
// a FULL unique constraint on `account`, so v4 upserts the SAME row per
// account rather than inserting a new historical row on every re-assert —
// see partner.js's original comment block for the full reasoning).
//
// Two callers share this exact toggle logic: the partner group's PUT
// /delegations/:account (Task 6, unauthenticated-by-account) and the
// mobile group's POST /delegation (Task 10, token-resolved + ownership-
// checked). Only the auth/ownership story differs between them — the
// state machine itself (idempotent re-assert, open a period, close a
// period) is identical, so it lives here once rather than twice.
'use strict';

// Reads current state without locking — safe for a plain read (GET, or a
// pre-transaction existence check). Returns `{ delegated, delegatedSince }`
// with `delegatedSince` a raw Date (or null), left to the caller to `iso()`.
async function readDelegationState(pool, account) {
  const { rows } = await pool.query(
    'SELECT started_at, ended_at FROM account_delegation_periods WHERE account = $1',
    [account]
  );
  const period = rows[0] || null;
  const delegated = !!(period && period.ended_at == null);
  return { delegated, delegatedSince: delegated ? period.started_at : null };
}

// Mutates state inside an ALREADY-OPEN transaction on `client` (the caller
// owns BEGIN/COMMIT/ROLLBACK — this function only issues the row-locked
// read + the one write the new state needs). Returns
// `{ delegated, changed, delegatedSince }`.
async function setDelegationState(client, account, delegated) {
  const { rows: lockedRows } = await client.query(
    'SELECT id, started_at, ended_at FROM account_delegation_periods WHERE account = $1 FOR UPDATE',
    [account]
  );
  const current = lockedRows[0] || null;
  const isOpen = !!(current && current.ended_at == null);

  if (delegated === isOpen) {
    // Idempotent re-assert (SPEC 1451): no-op.
    return { delegated: isOpen, changed: false, delegatedSince: isOpen ? current.started_at : null };
  }

  let startedAt = null;
  if (delegated) {
    // Turning delegation ON: open a period on this account's single row
    // (insert if it has never had one).
    if (current) {
      const { rows } = await client.query(
        `UPDATE account_delegation_periods
            SET started_at = NOW(), ended_at = NULL, updated_at = NOW()
          WHERE id = $1
          RETURNING started_at`,
        [current.id]
      );
      startedAt = rows[0].started_at;
    } else {
      const { rows } = await client.query(
        `INSERT INTO account_delegation_periods (account, started_at, ended_at, created_at, updated_at)
         VALUES ($1, NOW(), NULL, NOW(), NOW())
         RETURNING started_at`,
        [account]
      );
      startedAt = rows[0].started_at;
    }
  } else {
    // Turning delegation OFF: close the open period. (current must exist
    // and be open here — delegated !== isOpen and delegated is false
    // means isOpen was true.)
    await client.query(
      'UPDATE account_delegation_periods SET ended_at = NOW(), updated_at = NOW() WHERE id = $1',
      [current.id]
    );
  }

  return { delegated, changed: true, delegatedSince: delegated ? startedAt : null };
}

module.exports = { readDelegationState, setDelegationState };
