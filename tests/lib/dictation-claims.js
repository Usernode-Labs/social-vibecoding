'use strict';

// dictation_claims (services/dictation.js claim/release) in memory, for the
// route suites' fake pools: one claim per person until it is released or
// its lease lapses. tests/paid-generation-claims-postgres.test.js holds the
// real SQL to the same answers. Claims are shared by every pool wrapped with
// the same `claims` map: two of them are two processes.

function withDictationClaims(pool, claims = new Map()) {
  return {
    async query(sql, values = []) {
      if (/INSERT INTO dictation_claims/.test(sql)) {
        const [userId, claimId, leaseSeconds] = values;
        const held = claims.get(userId);
        if (held && held.until > Date.now()) return { rows: [], rowCount: 0 };
        claims.set(userId, { claimId, until: Date.now() + leaseSeconds * 1000 });
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM dictation_claims/.test(sql)) {
        const [userId, claimId] = values;
        const held = claims.get(userId);
        if (!held || held.claimId !== claimId) return { rows: [], rowCount: 0 };
        claims.delete(userId);
        return { rows: [], rowCount: 1 };
      }
      return pool.query(sql, values);
    },
  };
}

module.exports = { withDictationClaims };
