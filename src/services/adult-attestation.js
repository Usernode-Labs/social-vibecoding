'use strict';

// The 18+ check on the money and node features (#5095, compliance A-02).
//
// Homeroom asks no age at sign-up. Wallet, tokens and transfers, staking,
// running a node and passport proofs are for adults only, so a person is
// asked "Are you 18 or older?" the first time they open one of them
// (frontend/src/features/auth/adult-gate.tsx). "I'm 18 or older" records the answer
// here, once, as `users.adult_attested_at`. "I'm under 18" records nothing:
// the question comes back the next time they open one of these features.
// No birthdate is ever collected.
//
// The write routes of those features refuse an account that has not answered
// yes, with 403 `adult_attestation_required`. The browser's fetch wrapper
// turns that answer into the same question and sends the request again on a
// yes, so no caller handles it by hand. What they refuse:
//
//   POST /api/me/wallet-link                link a wallet (routes/auth.js)
//   POST /api/v4/mobile/wallet/claim        claim an earlier wallet
//   POST /challenges-api/bp/request         ask to run a block-producing node
//   POST /api/v4/mobile/native/delegation   stake: delegate block production
//   POST /api/v4/mobile/zkpassport/complete the passport proof
//
// Reads stay readable: a balance or a node's status is the person's own and
// shows nothing an adult-only rule protects, and every declared check that
// draws these screens reads a fixed preview without writing. A transfer is
// signed and broadcast by the native app on the device, never by this
// server, so the wallet sheet's gate in the shell is its check.
//
// Accounts that used these features before the check existed are asked
// once too, the next time they open one. Nothing they hold is touched.
//
// Later: a zkPassport proof can show over-18 without sharing the passport
// itself, and could stand in for the self-declaration recorded here.

const CODE = 'adult_attestation_required';
const MESSAGE = 'Confirm you are 18 or older to use this. Wallets, tokens, staking, nodes and passport proofs are for adults only.';

/** Whether the account has said it is 18 or older. */
async function isAttested(pool, userId) {
  if (!userId) return false;
  const { rows } = await pool.query(
    'SELECT adult_attested_at IS NOT NULL AS attested FROM users WHERE id = $1',
    [userId]
  );
  return rows[0]?.attested === true;
}

/** Record the yes. The first answer's time is kept; answering again changes nothing. */
async function attest(pool, userId) {
  const { rows } = await pool.query(
    `UPDATE users SET adult_attested_at = COALESCE(adult_attested_at, NOW())
      WHERE id = $1
      RETURNING adult_attested_at`,
    [userId]
  );
  return rows[0]?.adult_attested_at || null;
}

/** The refusal body. `shape: 'topochain'` matches the /api/v4 and /challenges-api envelope. */
function refusalBody(shape) {
  if (shape === 'topochain') return { success: false, error: MESSAGE, code: CODE };
  return { error: MESSAGE, code: CODE };
}

/**
 * Express middleware: refuse a signed-in account that has not said it is 18
 * or older. Mount it after the route's own authentication, so `req.user` is
 * set; a request without one passes through to the route's own 401.
 */
function requireAdultAttestation(pool, { shape } = {}) {
  return async function adultAttestationGate(req, res, next) {
    if (!req.user || !req.user.id) return next();
    let attested;
    try {
      attested = await isAttested(pool, req.user.id);
    } catch {
      // Not a refusal: asking the question again would not help.
      return res.status(500).json(shape === 'topochain'
        ? { success: false, error: 'Internal server error.' }
        : { error: 'Internal server error' });
    }
    if (attested) return next();
    return res.status(403).json(refusalBody(shape));
  };
}

module.exports = { CODE, MESSAGE, isAttested, attest, refusalBody, requireAdultAttestation };
