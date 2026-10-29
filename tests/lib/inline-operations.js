'use strict';

// Platform operations (services/platform-operations.js) run in the test's
// own process, as a conductor runs them, with inert steps: a route test
// exercises the operation end to end without a workflow runtime. The
// operation reads its requester and project again; `user` and `app` answer
// those two reads from the test's own fixtures, and every other query goes
// to the test's pool.
//
//   const restore = inlineOperations({ pool: () => poolMod.getPool(), user: () => currentUser, app: () => appRow });
//   ...
//   restore();
//
// An operation a route only asks a conductor to take (platform-operations
// admit or append, nobody waits on its answer) is queued, and runs when the
// test calls `await restore.drain()`, as a conductor runs it; `restore.queued`
// is what is waiting. `restore.refuseNext()` makes the next request or
// admitted one refused, as when no conductor takes it (an appended one is
// never refused: it waits for a conductor).
//
// A request's large input (its `payload`, platform-operations "an
// operation's large input") is kept here, in `restore.inputs` (request id ->
// payload, as JSON round-trips it), rather than in the test's database: the
// operation's inputOf and dropInput read and clear it through the same pool,
// whatever pool the test has. A refused request keeps none.

const operations = require('../../src/services/platform-operations');

function userRow(u) {
  return {
    id: u.id, username: u.username, is_admin: !!u.isAdmin, admin_readonly: !!u.adminReadonly,
    has_platform_access: u.hasPlatformAccess !== false, private_member_since: null, anonymised_at: null,
  };
}

function inlineOperations({ pool, user, app, config = {} }) {
  let n = 0;
  const inputs = new Map();
  const keep = (requestId, payload) => {
    if (payload !== undefined && payload !== null && !inputs.has(requestId)) inputs.set(requestId, JSON.parse(JSON.stringify(payload)));
  };
  const wrapped = {
    query(sql, params) {
      const text = String(sql);
      if (/platform_operation_inputs/.test(text) && /^\s*SELECT payload/.test(text)) {
        return Promise.resolve({ rows: inputs.has(params[0]) ? [{ payload: inputs.get(params[0]) }] : [] });
      }
      if (/platform_operation_inputs/.test(text) && /^\s*DELETE FROM platform_operation_inputs WHERE request_id/.test(text)) {
        const had = inputs.delete(params[0]);
        return Promise.resolve({ rows: [], rowCount: had ? 1 : 0 });
      }
      if (/FROM users WHERE id = \$1/.test(text) && /anonymised_at/.test(text)) {
        const u = user();
        return Promise.resolve({ rows: u && u.id === params[0] ? [userRow(u)] : [] });
      }
      if (app && /^SELECT \* FROM apps WHERE id = \$1$/.test(text.trim())) {
        const a = app();
        return Promise.resolve({ rows: a && a.id === params[0] ? [a] : [] });
      }
      return pool().query(sql, params);
    },
  };
  let refuse = 0;
  const prior = operations._setTransportForTests(async ({ payload, ...p }) => {
    n += 1;
    const requestId = p.requestId || `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    if (refuse > 0) { refuse -= 1; return { status: 'refused', requestId, reason: 'operation_unavailable' }; }
    keep(requestId, payload);
    try {
      return { status: 'done', requestId, result: await operations.run({ pool: wrapped, config }, { ...p, requestId }) };
    } catch (err) {
      return { status: 'failed', requestId, error: { message: err.message, code: err.code || null } };
    }
  });
  const queued = [];
  const priorAdmit = operations._setAdmitForTests({
    keep: async (_db, p, payload) => keep(p.requestId, payload),
    append: async (_db, p) => { queued.push(p); return p; },
    settle: async (p) => {
      if (refuse === 0) return { status: 'accepted' };
      refuse -= 1;
      queued.splice(queued.indexOf(p), 1);
      return { status: 'refused', reason: 'operation_unavailable' };
    },
    drop: async (requestId) => { inputs.delete(requestId); },
  });
  const priorAppend = operations._setAppendForTests(async (_db, p) => {
    n += 1;
    const requestId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    queued.push({ ...p, requestId });
    return requestId;
  });
  const restore = () => {
    operations._setTransportForTests(prior);
    operations._setAdmitForTests(priorAdmit);
    operations._setAppendForTests(priorAppend);
  };
  restore.queued = queued;
  restore.refuseNext = () => { refuse += 1; };
  restore.inputs = inputs;
  restore.drain = async () => {
    const results = [];
    while (queued.length) results.push(await operations.run({ pool: wrapped, config }, queued.shift()));
    return results;
  };
  return restore;
}

module.exports = { inlineOperations };
