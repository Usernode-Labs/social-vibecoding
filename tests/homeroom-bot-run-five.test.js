'use strict';

// Newcomer test "run five" (13 Oct 2026, app Club Votes): Submit to spec took
// 46 s. Submit published its wake (goAhead), but a live build was started
// only inside a pass's dispatch, after the pass's refresh, and every
// REFRESH_INTERVAL_MS that refresh is the full sweep of every app; a wake
// cannot cut into a pass that is running. The leader's pass is gone: the
// build is owed by its request's machine (bot-request BuildOwed), which asks
// the lane (bot-lane) for a build slot at once, wherever the workflow runs,
// and never while a refresh holds anything up. These pin what is left:
//
//   - goAhead tells the request its build is owed, once per run (its
//     request key), in place of a bus wake to the leader;
//   - a build's start says how long it waited for its slot;
//   - get_homeroom_bot carries the live loop's own last pass, beside the
//     shadow lane's that run five first read as it.
//
// tests/workflow-bot-loop-postgres.test.js drives the build's grant.
//
// Run with: node --test tests/homeroom-bot-run-five.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const rules = require('../src/workflow/rules/bot-loop.ts');
const connectorData = require('../src/services/bench/connector-data');

test('goAhead tells the request its build is owed, once for its run', async () => {
  const appended = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      if (/^\s*SELECT plan FROM homeroom_bot_runs/.test(s)) return { rows: [{ plan: { bullets: ['Polls'], questions: [] } }] };
      if (/UPDATE homeroom_bot_runs/.test(s)) return { rows: [{ app_id: 101, issue_number: 3 }] };
      if (/INSERT INTO wf_events/.test(s)) { appended.push(params); return { rows: [{ id: appended.length }] }; }
      return { rows: [] };
    },
  };
  assert.equal((await bot.goAhead(pool, { runId: 1746 })).ok, true);
  assert.deepEqual(appended.map((p) => [p[0], p[1], p[3], JSON.parse(p[4]), p[7]]), [[
    'bot-request', rules.requestKey(101, 3), 'BuildOwed', { appId: 101, issueNumber: 3, runId: 1746 }, 'build:1746',
  ]], 'its request owes the build; a second tap appends nothing twice');
});

test('a build\'s start says how long it waited for its slot', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  // The go-ahead's time survives the build starting: live_build_waiting_at
  // is cleared then, so "Live build started" says how long it waited.
  assert.match(src, /log\.info\('homeroom-bot', 'Live build started', \{[\s\S]{0,200}waitedMs:/);
});

test('get_homeroom_bot carries the live loop\'s own last pass beside the shadow lane\'s', async () => {
  const payload = {
    settings: {}, bot: null, totals: {}, queue: { depth: 0, items: [] },
    loop: {
      at: '2026-10-13T13:46:09Z', startedAt: '2026-10-13T13:45:15Z', ms: 54000, refreshed: true,
      liveBuilds: 1, dispatched: 2, paused: null, runningSince: '2026-10-13T13:50:15Z', processed: 0,
    },
    builds: {
      queued: 0, building: 0, live: { building: 1, waiting: 0 },
      lane: { at: '2026-10-13T13:46:00Z', started: 0, inFlight: 0, paused: 'off' },
    },
    runs: [],
  };
  const out = await connectorData.botOverview(null, {}, {}, { bot: { async adminPayload() { return payload; } } });
  assert.deepEqual(out.buildLane.live, {
    building: 1, waiting: 0,
    lastPass: {
      startedAt: '2026-10-13T13:45:15Z', at: '2026-10-13T13:46:09Z', ms: 54000,
      refreshed: true, liveBuilds: 1, dispatched: 2, paused: null,
    },
    passRunningSince: '2026-10-13T13:50:15Z',
  });
  assert.equal(out.buildLane.lastPass.at, '2026-10-13T13:46:00Z', 'the shadow lane\'s pass is still its own');
});
