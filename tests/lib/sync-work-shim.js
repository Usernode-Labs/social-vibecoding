'use strict';

// services/sync-main.js runSyncWork (the proposal machine's branch.sync
// work), called the way the older suites called runSyncMain: with the row it
// loads given, nothing measured (the last turn's count says how far behind
// it is), nothing kept (the inert durable context), and the head adoption a
// push leads to stubbed. `limits` and `votes` override those collaborators
// (a suite that tests the budget leaves `limits` real).
const REASONS = new Map([['manual', 'person'], ['resume_autosync', 'resume'], ['merge_queue', 'conflict']]);
const BACK = new Map([['unresolvable', 'conflict'], ['not_pushed', 'clean']]);

function shim(subject, { limits, adopted = [] } = {}) {
  const steps = require('../../src/services/durable-steps').none();
  return async (config, pool, id, { sessionRow: row, trigger } = {}) => {
    const wrapped = {
      calls: pool.calls,
      query: (sql, params) => (/FROM chat_sessions cs JOIN apps a ON cs\.app_id = a\.id/.test(sql)
        ? Promise.resolve({ rows: row ? [{ ...row, id }] : [] }) : pool.query(sql, params)),
    };
    const out = await subject.runSyncWork(config, wrapped, { sessionId: id, reason: REASONS.get(trigger) || 'person', steps }, {
      integration: { measure: async () => ({ error: 'not measured here' }) },
      ...(limits ? { limits } : {}),
      votes: () => ({ reconcileNativeReviewedHead: async (a) => { adopted.push(['native', a.session.id]); return {}; } }),
      prImportSync: () => ({ reconcileImportedHead: async (a) => { adopted.push(['imported', a.session.id]); return {}; } }),
    });
    return { ...out, ok: out.outcome !== 'unresolvable' && out.outcome !== 'over_budget', syncResult: BACK.get(out.outcome) || out.outcome };
  };
}

module.exports = { shim };
