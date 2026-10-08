'use strict';

// A merged request's other bot work is settled by noteRequestMerged, which
// the workflow worker runs after a merge (merge-followups' bot.requestMerged).
// The bot's loop runs on a web Pod, not there, so the wake that follows must
// reach every process over the WebSocket bus, not only the local loop.

const test = require('node:test');
const assert = require('node:assert/strict');

const bus = require('../src/services/ws-bus');
const bot = require('../src/services/homeroom-bot');

test('a merge that settles the bot\'s other work wakes the bot on every Pod', async () => {
  const envelopes = [];
  bus.startPublisher({ pool: { query: (sql, params) => { envelopes.push(JSON.parse(params[1])); return Promise.resolve({ rows: [] }); } } });
  const pool = {
    async query(sql) {
      const q = String(sql);
      if (/FROM chat_sessions cs JOIN users u/.test(q)) return { rows: [{ id: 50, app_id: 7, user_id: 3, linked_issues: [12] }] };
      if (/UPDATE homeroom_bot_runs r/.test(q)) return { rows: [{ id: 1, build_session_id: null }] };
      if (/DELETE FROM homeroom_bot_queue/.test(q)) return { rows: [], rowCount: 0 };
      return { rows: [] };
    },
  };
  try {
    const out = await bot.noteRequestMerged(pool, { id: 50 }, { dm: { closePlanCards: async () => {} } });
    assert.equal(out.skipped, 1);
    await new Promise((r) => setImmediate(r));  // a publisher-only send is queued
    const wakes = envelopes.filter((e) => e.k === 'homeroom_bot').map((e) => e.d);
    assert.deepEqual(wakes, [{ appId: 7 }]);
  } finally {
    bus.startPublisher({ pool: null });
  }
});
