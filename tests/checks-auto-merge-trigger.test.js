// #451: when a proposal's checks reach a terminal verdict, the capture
// pipeline re-drives the app-level auto-merge drain — so a PR that already
// had a winning vote merges the moment its checks turn green (the ordering
// the vote-triggered path never covered). This pins the trigger's gating:
// only a 'passing' verdict, only a still-'promoted' row, only when GitHub is
// enabled, and it hands the drain the freshly-read app_id (not the stale
// in-memory one). Same require.cache stubbing pattern as the votes tests —
// nothing real spins up.
//
// Run with: node --test tests/checks-auto-merge-trigger.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// services/visuals pulls in jsonwebtoken (used only to mint a capture
// session cookie — a path these tests never reach). It isn't installed in
// the test environment, so shim it the same way the votes tests shim
// 'express'.
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'jsonwebtoken') return { sign: () => 'tok', verify: () => ({}) };
  if (request === 'pg') return { Pool: class { async query() { return { rows: [] }; } } };
  return _origLoad.call(this, request, ...rest);
};

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load services/visuals with github + conflict-resolver stubbed so the
// trigger's effect (a checkAndResolveConflicts call) is observable and the
// real drain never runs.
function loadVisuals({ githubEnabled = true } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    resolver: require.resolve('../src/services/conflict-resolver'),
    bot: require.resolve('../src/services/homeroom-bot'),
    subject: require.resolve('../src/services/visuals'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const drainCalls = [];
  const botChecks = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, { isEnabled: () => githubEnabled });
  stub(ids.resolver, {
    checkAndResolveConflicts: async (_config, trigger) => { drainCalls.push(trigger); },
  });
  stub(ids.bot, {
    async noteProposalChecks(pool, sessionId) { botChecks.push({ pool, sessionId }); return true; },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, drainCalls, botChecks, restore };
}

// A pool that returns the given chat_sessions row for the status/app_id
// re-read, and records the queries it saw.
function poolReturning(row) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/SELECT status, app_id FROM chat_sessions/.test(String(sql))) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// The trigger is fire-and-forget (returns void, runs detached). Flush
// microtasks so its .then chain settles before we assert.
const flush = () => new Promise((r) => setImmediate(r));

const session = { id: 7 };

test('passing verdict on a still-promoted session drives the drain with the fresh app_id', async () => {
  const { subject, drainCalls, restore } = loadVisuals();
  const pool = poolReturning({ status: 'promoted', app_id: 42 });
  try {
    subject.maybeAutoMergeAfterChecks({ jwtSecret: 's' }, pool, session, 'passing');
    await flush();
    assert.equal(drainCalls.length, 1, 'drain fired exactly once');
    assert.deepEqual(drainCalls[0], { app_id: 42 }, 'drain got the re-read app_id');
  } finally {
    restore();
  }
});

test('a failing verdict never touches the drain (no DB read either)', async () => {
  const { subject, drainCalls, restore } = loadVisuals();
  const pool = poolReturning({ status: 'promoted', app_id: 42 });
  try {
    subject.maybeAutoMergeAfterChecks({ jwtSecret: 's' }, pool, session, 'failing');
    await flush();
    assert.equal(drainCalls.length, 0, 'no drain for a non-passing verdict');
    assert.equal(pool.queries.length, 0, 'short-circuits before the status re-read');
  } finally {
    restore();
  }
});

test('a pending verdict never touches the drain', async () => {
  const { subject, drainCalls, restore } = loadVisuals();
  const pool = poolReturning({ status: 'promoted', app_id: 42 });
  try {
    subject.maybeAutoMergeAfterChecks({ jwtSecret: 's' }, pool, session, 'pending');
    await flush();
    assert.equal(drainCalls.length, 0);
  } finally {
    restore();
  }
});

test('a passing verdict on a session that is no longer promoted is a no-op', async () => {
  const { subject, drainCalls, restore } = loadVisuals();
  // The capture took minutes; the row was force-merged in the meantime.
  const pool = poolReturning({ status: 'merged', app_id: 42 });
  try {
    subject.maybeAutoMergeAfterChecks({ jwtSecret: 's' }, pool, session, 'passing');
    await flush();
    assert.equal(drainCalls.length, 0, 'never re-merges a non-promoted row');
    assert.ok(pool.queries.some((q) => /SELECT status, app_id FROM chat_sessions/.test(q.sql)),
      're-read the live status rather than trusting the snapshot');
  } finally {
    restore();
  }
});

test('a vanished session row (archived/deleted mid-capture) is a no-op', async () => {
  const { subject, drainCalls, restore } = loadVisuals();
  const pool = poolReturning(null);
  try {
    subject.maybeAutoMergeAfterChecks({ jwtSecret: 's' }, pool, session, 'passing');
    await flush();
    assert.equal(drainCalls.length, 0);
  } finally {
    restore();
  }
});

test('a failing verdict asks the bot to look at its proposal, once, with its session id', async () => {
  const { subject, botChecks, restore } = loadVisuals();
  const pool = poolReturning({ status: 'promoted', app_id: 42 });
  try {
    subject.noteBotChecksAfterChecks(pool, session, 'failing');
    await flush();
    assert.equal(botChecks.length, 1, 'the bot is asked exactly once');
    assert.equal(botChecks[0].pool, pool);
    assert.equal(botChecks[0].sessionId, 7);
  } finally {
    restore();
  }
});

test('only a failing verdict asks the bot; passing, pending, skipped and error do nothing', async () => {
  const { subject, botChecks, restore } = loadVisuals();
  const pool = poolReturning(null);
  try {
    for (const state of ['passing', 'pending', 'skipped', 'error', 'unknown', undefined, null]) {
      subject.noteBotChecksAfterChecks(pool, session, state);
    }
    await flush();
    assert.equal(botChecks.length, 0);
    assert.equal(pool.queries.length, 0, 'short-circuits before any DB work');
  } finally {
    restore();
  }
});

test('a bot call that rejects is swallowed, never thrown into the capture', async () => {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    resolver: require.resolve('../src/services/conflict-resolver'),
    bot: require.resolve('../src/services/homeroom-bot'),
    subject: require.resolve('../src/services/visuals'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, { isEnabled: () => true });
  stub(ids.bot, { noteProposalChecks: async () => { throw new Error('no bot today'); } });
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  try {
    assert.doesNotThrow(() => subject.noteBotChecksAfterChecks(poolReturning(null), session, 'failing'));
    await flush();
  } finally {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  }
});

test('the hook is wired beside the auto-merge trigger at all three settle sites', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const visuals = read('src/services/visuals.js');
  const harvest = read('src/services/check-harvest.js');
  assert.equal((visuals.match(/noteBotChecksAfterChecks\(/g) || []).length, 3,
    'the definition plus the live capture and lifecycle wrapper sites');
  assert.match(visuals, /if \(completed\?\.state\) \{\n\s+maybeAutoMergeAfterChecks\(config, getPool\(config\), session, completed\.state\);\n\s+noteBotChecksAfterChecks\(getPool\(config\), session, completed\.state\);/);
  assert.match(visuals, /if \(!operation\) \{\n\s+maybeAutoMergeAfterChecks\(config, pool, session, checksResult\.state\);\n\s+noteBotChecksAfterChecks\(pool, session, checksResult\.state\);/);
  assert.match(harvest, /visuals\.maybeAutoMergeAfterChecks\(config, pool, session, settled\.result\.state\);\n\s+visuals\.noteBotChecksAfterChecks\(pool, session, settled\.result\.state\);/);
});

test('passing verdict is a no-op when GitHub is disabled (staging / standalone)', async () => {
  const { subject, drainCalls, restore } = loadVisuals({ githubEnabled: false });
  const pool = poolReturning({ status: 'promoted', app_id: 42 });
  try {
    subject.maybeAutoMergeAfterChecks({ jwtSecret: 's' }, pool, session, 'passing');
    await flush();
    assert.equal(drainCalls.length, 0, 'nothing to merge without GitHub');
    assert.equal(pool.queries.length, 0, 'short-circuits before any DB work');
  } finally {
    restore();
  }
});
