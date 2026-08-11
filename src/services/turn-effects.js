'use strict';

const EFFECT_KEYS = Object.freeze({
  SCOUT_SPEC_PUBLICATION: 'scout_spec_publication',
  PR_METADATA_GENERATION: 'pr_metadata_generation',
  PR_METADATA_SPEND: 'pr_metadata_spend',
  RECOVERED_STAGING_PUBLICATION: 'recovered_staging_publication',
});

function requireIdentity(turnId, effectKey) {
  if (!turnId) throw new Error('turn-effects: turnId required');
  if (!effectKey) throw new Error('turn-effects: effectKey required');
}

function jsonValue(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

async function withTransaction(pool, fn) {
  const ownsClient = typeof pool?.connect === 'function';
  const client = ownsClient ? await pool.connect() : pool;
  if (!client || typeof client.query !== 'function') {
    throw new Error('turn-effects: database client unavailable');
  }
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

// Run a database-local effect exactly once. The receipt insertion, effect,
// and completed marker share one transaction: a crash rolls all three back,
// while a committed receipt lets every later recovery return the same result
// without repeating the mutation.
async function runDbEffect({
  pool,
  turnId,
  effectKey,
  sessionId = null,
  run,
}) {
  requireIdentity(turnId, effectKey);
  if (typeof run !== 'function') throw new Error('turn-effects: run required');
  return withTransaction(pool, async (client) => {
    const inserted = await client.query(
      `INSERT INTO turn_effects (turn_id, effect_key, session_id, state)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (turn_id, effect_key) DO NOTHING
       RETURNING state`,
      [turnId, effectKey, sessionId],
    );
    if ((inserted.rowCount ?? inserted.rows?.length ?? 0) === 0) {
      const { rows } = await client.query(
        `SELECT state, result FROM turn_effects
         WHERE turn_id = $1 AND effect_key = $2
         FOR UPDATE`,
        [turnId, effectKey],
      );
      const existing = rows[0];
      if (existing?.state === 'completed') {
        return { applied: false, value: existing.result ?? null };
      }
      // A pending database-local receipt cannot survive a committed
      // transaction: insertion and completion are atomic. Seeing one means it
      // was deliberately claimed as an external effect and must be reconciled
      // by that effect's owner instead of being blindly repeated here.
      const err = new Error(`turn-effects: ${effectKey} is pending reconciliation`);
      err.code = 'turn_effect_pending';
      throw err;
    }

    const value = await run(client);
    const stored = jsonValue(value);
    await client.query(
      `UPDATE turn_effects
       SET state = 'completed', result = $3::jsonb,
           completed_at = NOW(), updated_at = NOW()
       WHERE turn_id = $1 AND effect_key = $2`,
      [turnId, effectKey, JSON.stringify(stored)],
    );
    return { applied: true, value: stored };
  });
}

// External effects cannot share a Postgres transaction. Claim a stable intent
// before calling the service; on recovery, a pending claim must be reconciled
// against the external system (or failed closed), never blindly replayed.
async function claimExternalEffect({
  pool,
  turnId,
  effectKey,
  sessionId = null,
  intent = null,
}) {
  requireIdentity(turnId, effectKey);
  const storedIntent = jsonValue(intent);
  const out = await pool.query(
    `INSERT INTO turn_effects (turn_id, effect_key, session_id, state, result)
     VALUES ($1, $2, $3, 'pending', $4::jsonb)
     ON CONFLICT (turn_id, effect_key) DO NOTHING
     RETURNING state`,
    [turnId, effectKey, sessionId, JSON.stringify(storedIntent)],
  );
  if ((out.rowCount ?? out.rows?.length ?? 0) === 1) {
    return { claimed: true, state: 'pending', result: storedIntent };
  }
  const { rows } = await pool.query(
    'SELECT state, result FROM turn_effects WHERE turn_id = $1 AND effect_key = $2',
    [turnId, effectKey],
  );
  return { claimed: false, state: rows[0]?.state || null, result: rows[0]?.result ?? null };
}

async function completeExternalEffect({ pool, turnId, effectKey, result = null }) {
  requireIdentity(turnId, effectKey);
  const out = await pool.query(
    `UPDATE turn_effects
     SET state = 'completed', result = $3::jsonb,
         completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
     WHERE turn_id = $1 AND effect_key = $2 AND state = 'pending'
     RETURNING result`,
    [turnId, effectKey, JSON.stringify(jsonValue(result))],
  );
  if ((out.rowCount ?? out.rows?.length ?? 0) === 1) return true;
  const { rows } = await pool.query(
    'SELECT state FROM turn_effects WHERE turn_id = $1 AND effect_key = $2',
    [turnId, effectKey],
  );
  if (rows[0]?.state === 'completed') return true;
  const err = new Error(`turn-effects: cannot complete unclaimed effect ${effectKey}`);
  err.code = 'turn_effect_not_claimed';
  throw err;
}

function fallbackResult(fallback, err, intent = null) {
  const value = typeof fallback === 'function' ? fallback(err, intent) : fallback;
  return jsonValue(value);
}

// Execute an external effect behind a durable intent without ever issuing it
// twice. Unlike a database-local effect, the provider call and our receipt
// cannot share one transaction. If an earlier owner left the intent pending,
// or if the first owner loses certainty while completing the receipt, use the
// caller's deterministic fallback and mark the intent complete. This is
// deliberately at-most-once/fail-closed: a missing embellishment is safer
// than charging for the same logical turn twice.
async function runExternalEffectFailClosed({
  pool,
  turnId,
  effectKey,
  sessionId = null,
  run,
  fallback,
  intent = null,
}) {
  requireIdentity(turnId, effectKey);
  if (typeof run !== 'function') throw new Error('turn-effects: external run required');

  const claim = await claimExternalEffect({
    pool, turnId, effectKey, sessionId, intent,
  });
  if (!claim.claimed) {
    if (claim.state === 'completed') {
      return { value: claim.result ?? null, disposition: 'replayed', error: null };
    }
    if (claim.state !== 'pending') {
      const err = new Error(`turn-effects: invalid external effect state ${claim.state || 'missing'}`);
      err.code = 'turn_effect_state_invalid';
      throw err;
    }
    const value = fallbackResult(fallback, null, claim.result);
    await completeExternalEffect({ pool, turnId, effectKey, result: value });
    return { value, disposition: 'fallback', error: null };
  }

  try {
    const proposed = jsonValue(await run());
    await completeExternalEffect({ pool, turnId, effectKey, result: proposed });
    // Another recovery owner may have observed our pending intent and
    // reconciled it to fallback while this provider call was still in flight.
    // Always use the receipt as authority; never persist a different result
    // locally after losing that race.
    const reconciled = await claimExternalEffect({ pool, turnId, effectKey, sessionId });
    const value = reconciled.state === 'completed'
      ? (reconciled.result ?? proposed)
      : proposed;
    const keptProposal = JSON.stringify(value) === JSON.stringify(proposed);
    return {
      value,
      disposition: keptProposal ? 'executed' : 'replayed',
      error: null,
    };
  } catch (err) {
    const value = fallbackResult(fallback, err, claim.result);
    // The claim is already durable. Do not call `run` again even when this
    // catch came from an uncertain receipt write after the provider returned.
    // Completing with the fallback reconciles that ambiguity safely.
    try {
      await completeExternalEffect({ pool, turnId, effectKey, result: value });
    } catch (completeErr) {
      completeErr.cause = completeErr.cause || err;
      throw completeErr;
    }
    // The first completion may have committed and only lost its response. Read
    // back the authoritative receipt so this process does not persist a
    // fallback while later recovery sees the real provider result.
    const reconciled = await claimExternalEffect({ pool, turnId, effectKey, sessionId });
    const settledValue = reconciled.state === 'completed'
      ? (reconciled.result ?? value)
      : value;
    const storedFallback = JSON.stringify(settledValue) === JSON.stringify(value);
    return {
      value: settledValue,
      disposition: storedFallback ? 'fallback' : 'replayed',
      error: err,
    };
  }
}

module.exports = {
  EFFECT_KEYS,
  runDbEffect,
  claimExternalEffect,
  completeExternalEffect,
  runExternalEffectFailClosed,
};
