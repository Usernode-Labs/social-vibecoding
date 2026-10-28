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

const operations = require('../../src/services/platform-operations');

function userRow(u) {
  return {
    id: u.id, username: u.username, is_admin: !!u.isAdmin, admin_readonly: !!u.adminReadonly,
    has_platform_access: u.hasPlatformAccess !== false, private_member_since: null, anonymised_at: null,
  };
}

function inlineOperations({ pool, user, app, config = {} }) {
  let n = 0;
  const wrapped = {
    query(sql, params) {
      const text = String(sql);
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
  const prior = operations._setTransportForTests(async (p) => {
    n += 1;
    const requestId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    try {
      return { status: 'done', requestId, result: await operations.run({ pool: wrapped, config }, { ...p, requestId }) };
    } catch (err) {
      return { status: 'failed', requestId, error: { message: err.message, code: err.code || null } };
    }
  });
  return () => operations._setTransportForTests(prior);
}

module.exports = { inlineOperations };
