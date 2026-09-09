// Topochain v4 — the zkPassport verification bridge client (plan Task 10;
// SPEC §4.5 POST /mobile/zkpassport/complete, lines 2092-2141, error table
// rows for 500/502).
//
// This platform has no real zkPassport verifier wired in today (the
// production bridge is an external service this migration never touches
// per Global Constraints). `verifyCompletion()` below is the ONE call site
// the route (mobile.js) uses; a real bridge only needs `config
// .topochainZkBridgeUrl` set (env TOPOCHAIN_ZK_BRIDGE_URL) to a base URL
// this function POSTs to — the route never talks to `fetch` directly.
//
// Errors are reported as `ZkBridgeError` (carries the exact v4 status code
// the route should respond with) so the route's own try/catch can funnel
// every failure mode through one `instanceof` check, the same pattern
// `ValidationError` (helpers.js) already establishes for the rest of this
// surface.
'use strict';

const log = require('../logger');

class ZkBridgeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ZkBridgeError';
    this.status = status;
  }
}

// SPEC's error table row: "500 | bridge not configured, or challenge
// reward missing / non-numeric / not positive" — this function only ever
// throws the FIRST half of that OR (the reward half is the route's own
// concern, checked against the challenge row before this is ever called).
function requireBridgeUrl(config) {
  const url = config && config.topochainZkBridgeUrl;
  if (!url) {
    throw new ZkBridgeError('The zkPassport bridge is not configured.', 500);
  }
  return url.replace(/\/+$/, '');
}

// TODO(session-lifecycle): deployed zkpassport-bridge fa3f2c60 has no
// `/verify` route and bypasses SDK verification. This is a placeholder, not
// cryptographic verification; replace it with an authenticated durable
// verifier/receipt contract.
// POSTs the proof to the bridge's `/verify` endpoint and returns
// `{ verified, completedAt }` on ANY well-formed reply (verified may be
// false — that is a 422 the route reports, not a bridge failure). Throws
// `ZkBridgeError(502)` for a network failure or a payload that isn't a
// recognizable verification result — SPEC: "bridge request failed or
// returned an unexpected payload".
async function verifyCompletion(config, { challengeId, sessionId, nullifierHex, walletAddress }) {
  const base = requireBridgeUrl(config);

  let response;
  try {
    response = await fetch(`${base}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challengeId,
        session_id: sessionId,
        nullifier_hex: nullifierHex,
        wallet_address: walletAddress,
      }),
    });
  } catch (err) {
    log.error('topochain-zk-bridge', 'Bridge request failed', { message: err.message });
    throw new ZkBridgeError('The zkPassport bridge request failed.', 502);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    // Body wasn't JSON at all — an unexpected payload either way.
    payload = null;
  }

  if (!response.ok || typeof payload !== 'object' || payload === null || typeof payload.verified !== 'boolean') {
    throw new ZkBridgeError('The zkPassport bridge returned an unexpected payload.', 502);
  }

  return {
    verified: payload.verified,
    // Optional bridge-reported completion timestamp (SPEC: "falls back to
    // the bridge timestamp, then to now" — the route applies that fallback
    // chain; this just parses whatever the bridge sent, or null).
    completedAt: payload.completed_at ? new Date(payload.completed_at) : null,
  };
}

module.exports = { verifyCompletion, ZkBridgeError };
