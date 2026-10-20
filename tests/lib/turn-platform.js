'use strict';

// The workflow platform as a route test sees it, for a turn: a person's turn
// is asked of the turn machine (src/workflow/turn/machine.ts) in the route's
// own transaction, and the route then follows the conversation's stream until
// the turn's `done`. This stand-in records each ask and each stop, and ends
// the asked turn's stream the way a run that finished would, so the request
// settles. What the run itself does with what was asked is
// services/turns.js's, pinned in tests/workflow-turn-postgres.test.js.
//
// Install before the route module is first required; `restore()` puts the
// real module back.

const sessionBus = require('../../src/services/session-bus');

function installTurnPlatform({ finish = true, extra = {} } = {}) {
  const file = require.resolve('../../src/workflow/platform.ts');
  const previous = require.cache[file];
  const asks = [];
  const stops = [];
  sessionBus.init({ memory: true });
  const exports = {
    ...extra,
    async askTurn(db, ask) {
      asks.push({ ...ask, db });
      if (finish && /^agent:\d+$/.test(ask.key)) {
        const agentSessionId = Number(ask.key.slice('agent:'.length));
        const key = require('../../src/services/mayor/agent-turn').busKey(agentSessionId);
        sessionBus.publish(key, { type: 'done', _seq: `${String(ask.turnId).slice(0, 8)}-z`, agentSessionId });
      }
      return { ok: true };
    },
    async stopTurn(stop) {
      stops.push(stop);
      return { ok: true };
    },
  };
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
  return {
    asks,
    stops,
    restore() {
      if (previous) require.cache[file] = previous;
      else delete require.cache[file];
    },
  };
}

module.exports = { installTurnPlatform };
