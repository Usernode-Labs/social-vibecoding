'use strict';

// The workflow platform as a route test sees it, for a turn: a person's turn
// is asked of the turn machine (src/workflow/turn/machine.ts) in the route's
// own transaction, and the route then follows the conversation's stream until
// the turn's `done`. This stand-in records each ask and each stop, and ends
// the asked turn's stream the way a run that finished would, so the request
// settles. What the run itself does with what was asked is
// services/turns.js's, pinned in tests/workflow-turn-postgres.test.js.
//
// With `run: { config, pool }` it runs the asked turn's real handler
// (services/turns.js) in this process instead, as a workflow process would
// once the route's transaction commits, so a suite that drives a route end
// to end still sees the whole turn. `ran` collects each run's promise.
//
// Install before the route module is first required; `restore()` puts the
// real module back.

const sessionBus = require('../../src/services/session-bus');

function installTurnPlatform({ finish = true, run = null, extra = {} } = {}) {
  const file = require.resolve('../../src/workflow/platform.ts');
  const previous = require.cache[file];
  const asks = [];
  const stops = [];
  const ran = [];
  sessionBus.init({ memory: true });
  const exports = {
    ...extra,
    async askTurn(db, ask) {
      asks.push({ ...ask, db });
      if (run) {
        const ctx = {
          workId: `test-${asks.length}`, kind: 'turn.run', key: `run:${ask.turnId}`, resumeFrom: null, lostAttempts: 0,
          signal: new AbortController().signal,
          input: { ...ask.input, turnId: ask.turnId, kind: ask.kind, instanceKey: ask.key },
        };
        // Then its end on its stream, as the machine writes it when it
        // settles the item (turn/machine.ts `released`), however it ended.
        const { turnEndEvent } = require('../../src/workflow/turn/machine.ts');
        const end = () => sessionBus.publish(ask.key.startsWith('agent:') ? ask.key : Number(ask.key.replace(/^session:/, '')),
          turnEndEvent(ask.key, String(ask.turnId)));
        ran.push(new Promise((resolve) => setImmediate(resolve))
          .then(() => require('../../src/services/turns').run(ctx, run))
          .finally(end));
        return { ok: true };
      }
      if (finish && /^agent:\d+$/.test(ask.key)) {
        const agentSessionId = Number(ask.key.slice('agent:'.length));
        const key = require('../../src/services/mayor/agent-turn').busKey(agentSessionId);
        sessionBus.publish(key, { type: 'done', _seq: `end-${ask.turnId}`, turnId: String(ask.turnId), agentSessionId });
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
    ran,
    restore() {
      if (previous) require.cache[file] = previous;
      else delete require.cache[file];
    },
  };
}

module.exports = { installTurnPlatform };
