'use strict';

// The stale sweep leaves a run that is still on the cluster to the harvest
// instead of starting it over (server.js reconcileStuckChecks,
// checkRunLeftToHarvest).
//
// 7 Oct 2026, 21:59 UTC. A new leader booted while 7014's run still had
// its capture Job running and 7015's run had both Jobs finished. Neither
// was in flight in the new process: the old Pod had been harvesting them,
// and its heartbeat had not lapsed yet. Both read as overdue, because
// checks_checked_at is when a run starts and a busy cluster runs a suite
// for longer than CHECKS_STALE_MS, so the stale sweep started both over.
// The new run cancelled 7014's capture mid-run, and 7015's finished suite
// was never read. 7022, whose error verdict was due for its retry, had no
// run on the cluster and is re-driven as before.
//
// Run with: node --test tests/stuck-checks-left-to-harvest.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// loadConfig() (module level in server.js) hard-exits when these are
// missing. Same preamble as tests/server-graceful-shutdown.test.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

const log = require('../src/services/logger');
const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  log[level] = (cat, msg, data) => { logs.push({ level, cat, msg, data }); };
}

// Module-level code in server.js's require graph schedules housekeeping
// timers without unref. Auto-unref anything scheduled during the require.
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...args) => { const t = origSetInterval(...args); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...args) => { const t = origSetTimeout(...args); if (t && t.unref) t.unref(); return t; };
let server;
try {
  server = require('../server');
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

const github = require('../src/services/github');
const stagingRecovery = require('../src/services/staging-recovery');
const harvest = require('../src/services/check-harvest');

function stub(t, mod, patch) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) { saved[k] = mod[k]; mod[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) mod[k] = v; });
}

const config = { databaseUrl: process.env.DATABASE_URL };

test('reconcileStuckChecks leaves a run still on the cluster to the harvest and re-drives the rest', async (t) => {
  logs.length = 0;
  const rechecked = [];
  const asked = [];
  stub(t, github, { isEnabled: () => true });
  stub(t, stagingRecovery, {
    findStuckCheckSessions: async () => ({ rows: [
      { id: 7014, checks_commit_sha: 'abc123', check_state: 'pending' },
      { id: 7015, checks_commit_sha: 'def456', check_state: 'pending' },
      { id: 7022, checks_commit_sha: 'aaa111', check_state: 'error' },
    ] }),
    recheckSessionChecks: async ({ session, reason }) => { rechecked.push([session.id, reason]); return 'rechecked'; },
  });
  stub(t, harvest, {
    runOnCluster: async (_cfg, _pool, session, { staleMs }) => {
      asked.push([session.id, staleMs]);
      if (session.id === 7014) return { runId: 'f7895663', owner: 'old-pod:1', capture: 'running', unitSuite: 'succeeded' };
      if (session.id === 7015) return { runId: '338cd4cb', owner: 'old-pod:1', capture: 'succeeded', unitSuite: 'succeeded' };
      return null;
    },
  });

  await server.reconcileStuckChecks(config);

  assert.deepEqual(rechecked, [[7022, 'stuck-checks-boot']], 'only the session with nothing on the cluster starts over');
  assert.deepEqual(asked.map(([id]) => id), [7014, 7015, 7022]);
  assert.equal(asked[0][1], stagingRecovery.checksStaleMs(), 'a finished run is waited on for as long as a pending one');
  const left = logs.filter((l) => l.msg === 'Stuck checks still have their run on the cluster; leaving it to the harvest');
  assert.deepEqual(left.map((l) => [l.data.sessionId, l.data.runId, l.data.capture, l.data.reason]), [
    [7014, 'f7895663', 'running', 'stuck-checks-boot'],
    [7015, '338cd4cb', 'succeeded', 'stuck-checks-boot'],
  ]);
  const done = logs.find((l) => l.msg === 'Stuck-check reconciliation complete');
  assert.deepEqual(done.data, { scanned: 3, rechecked: 1, leftToHarvest: 2 });
});

test('a session left to the harvest does not use up the reconcile\'s re-drives', async (t) => {
  const rechecked = [];
  stub(t, github, { isEnabled: () => true });
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: 9000 + i, checks_commit_sha: 'abc123', check_state: 'pending' }));
  stub(t, stagingRecovery, {
    findStuckCheckSessions: async () => ({ rows }),
    recheckSessionChecks: async ({ session }) => { rechecked.push(session.id); },
  });
  // The first three are still on the cluster.
  stub(t, harvest, { runOnCluster: async (_c, _p, session) => (session.id < 9003 ? { runId: `r${session.id}` } : null) });
  await server.reconcileStuckChecks(config);
  assert.deepEqual(rechecked, [9003, 9004, 9005, 9006, 9007], 'five re-drives, as before, counted after the skips');
});
