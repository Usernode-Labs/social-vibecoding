'use strict';

// 11 Nov 2026 (docs/plans/bot-one-model.md, step 3): whether a change is
// open for votes, and where a request stands, is its stored work state
// (src/services/work-state.js), derived again from what the triggers mark
// (work_state_dirty). The work-state-drain clock does that within seconds;
// a test that writes a request's or a change's facts and then reads a list
// that reads the rows (Needs you, the vote digest, a request's standing)
// drains the marks first, as that clock would have.
async function settleWorkStates(pool) {
  const ws = require('../../src/services/work-state');
  for (let i = 0; i < 50; i += 1) {
    const { taken } = await ws.drainDirty(pool);
    if (!taken) return;
  }
}

module.exports = { settleWorkStates };
