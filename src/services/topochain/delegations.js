// Topochain v4 — shared `account_delegation_periods` open/close semantics
// (SPEC 1418-1453). HISTORY MODEL: the table keeps every period. The v4
// source's full unique constraint on `account` (Task 6's judgment call
// #4, which forced re-delegation to overwrite the one row and destroy the
// previous period's timestamps) is replaced by the invariant SPEC 1451's
// "full audit trail" actually needs — a PARTIAL unique index
// (`uq_account_delegation_periods_open`): at most one OPEN period per
// account, any number of closed historical ones. Turning delegation on
// therefore always INSERTS a fresh period; turning it off closes the open
// one in place; closed rows are never touched again.
//
// Two callers share this exact toggle logic: the partner group's PUT
// /delegations/:account (Task 6, unauthenticated-by-account) and the
// mobile group's POST /delegation (Task 10, token-resolved + ownership-
// checked). Only the auth/ownership story differs between them — the
// state machine itself (idempotent re-assert, open a period, close a
// period) is identical, so it lives here once rather than twice.
'use strict';

// Reads current state without locking — safe for a plain read (GET, or a
// pre-transaction existence check). Only an OPEN period speaks for the
// current state; closed history never does. Returns
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

// Mutates state inside an ALREADY-OPEN transaction on `client` (the caller
// owns BEGIN/COMMIT/ROLLBACK — this function only issues the row-locked
// read + the one write the new state needs). Returns
// `{ delegated, changed, delegatedSince }`.
async function setDelegationState(client, account, delegated) {
  // Lock the open period, if any. Closed rows are history and never
  // participate in the state machine, so they are neither read nor locked.
  const { rows: lockedRows } = await client.query(
    'SELECT id, started_at FROM account_delegation_periods WHERE account = $1 AND ended_at IS NULL FOR UPDATE',
    [account]
  );
  const open = lockedRows[0] || null;

  if (delegated === !!open) {
    // Idempotent re-assert (SPEC 1451): no-op.
    return { delegated: !!open, changed: false, delegatedSince: open ? open.started_at : null };
  }

  if (delegated) {
    // Turning delegation ON: always a fresh period. Two racing opens are
    // serialized by the partial unique index — the loser errors and its
    // transaction rolls back, same failure mode the old full unique gave
    // racing first-ever delegations.
    const { rows } = await client.query(
      `INSERT INTO account_delegation_periods (account, started_at, ended_at, created_at, updated_at)
       VALUES ($1, NOW(), NULL, NOW(), NOW())
       RETURNING started_at`,
      [account]
    );
    return { delegated: true, changed: true, delegatedSince: rows[0].started_at };
  }

  // Turning delegation OFF: close the open period in place (`open` must
  // exist here — delegated !== !!open with delegated false means a period
  // was open). Its row becomes immutable history.
  await client.query(
    'UPDATE account_delegation_periods SET ended_at = NOW(), updated_at = NOW() WHERE id = $1',
    [open.id]
  );
  return { delegated: false, changed: true, delegatedSince: null };
}

module.exports = { readDelegationState, setDelegationState };
