// #3471: when a proposal's checks settle as 'failing', the capture pipeline
// wakes the Homeroom bot to look at its own checks, the same way #451's
// passing verdict re-drives the merge drain. This pins the trigger's gating
// (only 'failing', never throwing) and that the call sits beside
// maybeAutoMergeAfterChecks at all three places a verdict settles.
//
// Run with: node --test tests/checks-bot-fix-trigger.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

function loadVisuals() {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    bot: require.resolve('../src/services/homeroom-bot'),
    subject: require.resolve('../src/services/visuals'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = [];
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, { isEnabled: () => true });
  stub(ids.bot, {
    noteProposalChecks: async (pool, sessionId) => { calls.push({ pool, sessionId }); },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, calls, restore };
}

const flush = () => new Promise((r) => setImmediate(r));
const pool = { async query() { return { rows: [] }; } };
const session = { id: 7 };

test('a failing verdict asks the bot to look at its own checks', async () => {
  const { subject, calls, restore } = loadVisuals();
  try {
    subject.noteBotChecksAfterChecks(pool, session, 'failing');
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, 7);
    assert.equal(calls[0].pool, pool);
  } finally {
    restore();
  }
});

test('only failing: passing, skipped, pending and error never wake it', async () => {
  const { subject, calls, restore } = loadVisuals();
  try {
    for (const state of ['passing', 'skipped', 'pending', 'error', null, undefined]) {
      subject.noteBotChecksAfterChecks(pool, session, state);
    }
    await flush();
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('a session with no id is a no-op', async () => {
  const { subject, calls, restore } = loadVisuals();
  try {
    subject.noteBotChecksAfterChecks(pool, null, 'failing');
    subject.noteBotChecksAfterChecks(pool, {}, 'failing');
    await flush();
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('a thrown or rejected wake is swallowed, never thrown into the capture pipeline', async () => {
  const { subject, restore } = loadVisuals();
  const botId = require.resolve('../src/services/homeroom-bot');
  const bot = require.cache[botId].exports;
  const orig = bot.noteProposalChecks;
  try {
    bot.noteProposalChecks = () => { throw new Error('boom'); };
    assert.doesNotThrow(() => subject.noteBotChecksAfterChecks(pool, session, 'failing'));
    bot.noteProposalChecks = async () => { throw new Error('async boom'); };
    assert.doesNotThrow(() => subject.noteBotChecksAfterChecks(pool, session, 'failing'));
    await flush();
  } finally {
    bot.noteProposalChecks = orig;
    restore();
  }
});

test('the call sits beside maybeAutoMergeAfterChecks at all three verdict sites', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const visuals = read('src/services/visuals.js');
  const harvest = read('src/services/check-harvest.js');
  const sites = /maybeAutoMergeAfterChecks\([^\n]*\);\s*\n\s*visuals\.noteBotChecksAfterChecks\(pool, session, settled\.result\.state\);/g;
  assert.equal((harvest.match(sites) || []).length, 1, 'check-harvest, for an adopted run');
  const liveSites = /maybeAutoMergeAfterChecks\([^\n]*\);\s*\n\s*noteBotChecksAfterChecks\([^\n]*\);/g;
  assert.equal((visuals.match(liveSites) || []).length, 2, 'the live capture and its lifecycle wrapper');
});
