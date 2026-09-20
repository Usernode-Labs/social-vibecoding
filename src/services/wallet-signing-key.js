// Wallet sign-in key binding (issue #2502).
//
// The wallet endpoints in src/routes/auth.js prove "the caller controls the
// key this account linked" by asking the node to verify a signature over a
// server-issued challenge. That proof is worth something only if the key the
// node verifies against is the ACCOUNT's key. The pre-#2502 handlers passed
// `req.body.publicKey` straight through to the verifier while resolving the
// account from a separate `pubkey` field, so a caller could sign the
// challenge with their own key, name somebody else's address, and be logged
// in as that somebody else. No signature was ever forged: the server simply
// treated "valid signature for key X" as authorization for account Y.
//
// This module is the single place that answers "which key may this account's
// signature be checked against", and it answers only from the account's
// stored `users.usernode_pubkey`. That column holds the chain's canonical
// `ut1…` account key, which is the same vocabulary the node uses everywhere
// else (`tx.from_pubkey`, `getNodeAddress()`, the genesis roster), so it is
// what the verifier is asked about.
//
// A caller-supplied key is never forwarded. It is accepted only as an
// assertion about which key signed, and an assertion that names anything
// other than this account's key is a refusal, not a value to use. The
// platform stores no second encoding of the key, so there is deliberately no
// "derive an equivalent form" path here: a key the server cannot tie to the
// account is a key the server cannot honour.

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Return the key the node should verify this account's signature against, or
// null when the caller named a key that is not this account's.
//
// `linkedAddress` MUST come from the database row the server resolved, never
// from the request body. `suppliedKey` is the request's optional claim about
// which key signed.
function verificationKeyFor(linkedAddress, suppliedKey) {
  const linked = normalize(linkedAddress);
  if (!linked) return null;

  const supplied = normalize(suppliedKey);
  if (supplied && supplied !== linked) return null;

  return linked;
}

module.exports = { verificationKeyFor };
