'use strict';

// A change's stored work state for the fake pools of unit suites (review A3,
// 19 Nov 2026): "ready to try" is read off the change's row in work_states,
// which services/work-state.js derives (deriveChange) and stores. A suite
// that fakes the database hands its pool the row the derive would store for
// the session columns it already fakes, so a test cannot say ready while the
// derive says otherwise.
//
//   const { storedChange, readsStoredChange } = require('./lib/stored-change');
//   if (readsStoredChange(sql)) return { rows: [storedChange(sessionRow, { id: 31 })] };

const ws = require('../../src/services/work-state');

/**
 * The work_states row services/work-state.js stores for a change whose
 * chat_sessions columns are `session` (its status, check state and head,
 * shots, conflict and merge columns, as CHANGE_FACTS_SQL names them;
 * `checks_checked_at` stands for `checks_at`), as forChanges reads it back.
 * `state` stores a state as it is instead of deriving one.
 */
function storedChange(session = {}, { id = 1, appId = 1, now = new Date(), state = null, slug = 'demo' } = {}) {
  const promotedAt = session.promoted_at || new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const st = state || ws.deriveChange({
    ...session, promoted_at: promotedAt, checks_at: session.checks_at || session.checks_checked_at || null,
  }, { now });
  return {
    app_id: appId, item_kind: 'change', item_ref: id, issue_number: null, session_id: id,
    stage: st.stage, why: st.why || null, reason: st.reason || null, line: st.line || null,
    whose_move: st.whoseMove || null, requester_id: null, since: st.since || null, updated_at: now.toISOString(),
    vote_open: ws.voteOpenOf(st), lead_change_id: null, standing: {}, slug, app_name: slug,
  };
}

/** Whether `sql` is forChanges' read of stored change rows (services/work-state.js). */
function readsStoredChange(sql) {
  const text = String(sql);
  return /FROM work_states ws JOIN apps a/.test(text) && /item_kind = 'change'/.test(text);
}

module.exports = { storedChange, readsStoredChange };
