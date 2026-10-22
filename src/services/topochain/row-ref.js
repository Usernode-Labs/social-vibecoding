// The opaque reference a public leaderboard row carries so the drill-down can
// ask for that person's activities without the row exposing a numeric user id,
// an email, a hidden username or a wallet.
//
// Why it exists: the season board's rows are built by computeStandings with
// `wallet_address: null, bech32m: null`, so a player with no Discord handle
// had nothing the activities route accepted, and their row's Activities part
// said "No identifier available for this row." (issue #5807). A scrambled code
// the server alone can turn back into a person fixes that without widening
// what the page reveals.
//
// The shape follows `activity-mail.js`'s `unsubscribeToken`: an HMAC of the
// id under the server's session secret, so it cannot be guessed from the id
// and cannot be reversed without the secret. It is the SAME for a person on
// every board, because it signs the id and nothing else.
'use strict';

const crypto = require('crypto');

/** 22 base64url characters: an HMAC-SHA256 of the id, truncated. */
const ROW_REF_RE = /^[A-Za-z0-9_-]{22}$/;

function rowRef(userId, key) {
  if (!key || !Number.isInteger(Number(userId))) return null;
  return crypto.createHmac('sha256', key)
    .update(`leaderboard-row:${Number(userId)}`)
    .digest('base64url')
    .slice(0, 22);
}

/** The row of `rows` this ref stands for, or null. Compared in constant time. */
function findRowByRef(rows, ref, key) {
  if (!ROW_REF_RE.test(String(ref || '')) || !key) return null;
  const want = Buffer.from(ref);
  for (const row of rows || []) {
    const mine = rowRef(row.user_id, key);
    if (mine && mine.length === want.length && crypto.timingSafeEqual(Buffer.from(mine), want)) return row;
  }
  return null;
}

module.exports = { rowRef, findRowByRef, ROW_REF_RE };
