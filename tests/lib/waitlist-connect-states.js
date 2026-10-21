'use strict';

// waitlist_connect_states as routes/waitlist-connect.js uses it, for a
// suite that stubs the pool: parked, taken once for its provider, its
// outcome remembered and replayed. Answers whatever else with no rows.
// tests/waitlist-connect-states-postgres.test.js holds the real table to it.

function connectStatesPool() {
  const rows = new Map(); // state_hash -> { provider, token, verifier, status, handle, expired }
  return {
    rows,
    async query(sql, params = []) {
      const text = String(sql);
      if (/INSERT INTO waitlist_connect_states/.test(text)) {
        for (const [k, r] of rows) if (r.expired) rows.delete(k);
        rows.set(params[0], { provider: params[1], token: params[2], verifier: params[3], status: null, handle: null, expired: false });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE waitlist_connect_states SET status = 'working'/.test(text)) {
        const r = rows.get(params[0]);
        if (!r || r.expired || r.provider !== params[1] || r.status !== null) return { rows: [], rowCount: 0 };
        r.status = 'working';
        return { rows: [{ token: r.token, verifier: r.verifier }], rowCount: 1 };
      }
      if (/UPDATE waitlist_connect_states SET status = \$2/.test(text)) {
        const r = rows.get(params[0]);
        if (r) Object.assign(r, { status: params[1], handle: params[2] });
        return { rows: [], rowCount: r ? 1 : 0 };
      }
      if (/FROM waitlist_connect_states/.test(text)) {
        const r = rows.get(params[0]);
        const done = r && !r.expired && r.provider === params[1] && r.status && r.status !== 'working';
        return { rows: done ? [{ token: r.token, status: r.status, handle: r.handle }] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

module.exports = { connectStatesPool };
