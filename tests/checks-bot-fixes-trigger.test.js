// #3638: when a proposal's checks settle as FAILING, the bot now looks at
// fixing them itself — through visuals.noteBotChecksAfterChecks, called
// beside maybeAutoMergeAfterChecks at the three places a check verdict
// settles (the live capture and the lifecycle branch in services/visuals,
// and check-harvest's adopted runs). This pins the hook's gating: only a
// 'failing' verdict reaches it, a session-less call is a no-op, a rejection
// in the bot's own code is swallowed rather than escaping as an unhandled
// one, and both service files really do call it. Same require.cache
// stubbing pattern as checks-auto-merge-trigger.test.js — nothing real
// spins up.
//
// Run with: node --test tests/checks-bot-fixes-trigger.test.js

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

// Load services/visuals with homeroom-bot stubbed so the hook's effect (a
// noteProposalChecks call) is observable and the bot never loads for real.
function loadVisuals({ noteThrows = false } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    bot: require.resolve('../src/services/homeroom-bot'),
    subject: require.resolve('../src/services/visuals'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const noteCalls = [];
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } });
  stub(ids.bot, {
    noteProposalChecks: async (pool, session, state) => {
      if (noteThrows) throw new Error('the bot is down');
      noteCalls.push({ pool, session, state });
      return true;
    },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, noteCalls, restore };
}

const flush = () => new Promise((r) => setImmediate(r));

const session = { id: 7, app_id: 42 };

test('a failing verdict reaches the bot hook once, with the session and the state', async () => {
  const { subject, noteCalls, restore } = loadVisuals();
  try {
    await subject.noteBotChecksAfterChecks({}, {}, session, 'failing');
    await flush();
    assert.equal(noteCalls.length, 1, 'hook fired exactly once');
    assert.equal(noteCalls[0].session.id, 7);
    assert.equal(noteCalls[0].state, 'failing');
  } finally {
    restore();
  }
});

test('a pending, passing or error verdict never reaches the bot hook', async () => {
  const { subject, noteCalls, restore } = loadVisuals();
  try {
    for (const state of ['passing', 'pending', 'error', 'skipped', null]) {
      await subject.noteBotChecksAfterChecks({}, {}, session, state);
    }
    await flush();
    assert.equal(noteCalls.length, 0, 'only a failing verdict is acted on');
  } finally {
    restore();
  }
});

test('no session row (or one without an id) is a no-op', async () => {
  const { subject, noteCalls, restore } = loadVisuals();
  try {
    await subject.noteBotChecksAfterChecks({}, {}, null, 'failing');
    await subject.noteBotChecksAfterChecks({}, {}, { app_id: 42 }, 'failing');
    await flush();
    assert.equal(noteCalls.length, 0);
  } finally {
    restore();
  }
});

test('the hook never throws, and the bot failing underneath is not an unhandled rejection', async () => {
  const { subject, noteCalls, restore } = loadVisuals({ noteThrows: true });
  try {
    // Fire-and-forget: it returns void, and the detached rejection lands
    // nowhere a caller could see it.
    assert.equal(subject.noteBotChecksAfterChecks({}, {}, session, 'failing'), undefined);
    await flush();
    assert.equal(noteCalls.length, 0, 'the bot never saw it');
  } finally {
    restore();
  }
});

// The hook is only real if every place a verdict settles calls it. The two
// files are read as source and grepped, the way the platform's own drift
// checks read a call's presence.
test('both verdict sites in services/visuals and check-harvest\'s adopted runs call the hook', () => {
  const visualsSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/visuals.js'), 'utf8');
  const harvestSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/check-harvest.js'), 'utf8');
  const hooksInVisuals = [...visualsSrc.matchAll(/noteBotChecksAfterChecks\(/g)].length;
  // One definition + two call sites.
  assert.equal(hooksInVisuals, 3, 'visuals.js defines the hook and calls it at both verdict sites');
  for (const src of [visualsSrc, harvestSrc]) {
    for (const call of [...src.matchAll(/(?<call>noteBotChecksAfterChecks)\([^)]*\)/g)].map((m) => m.groups.call)) {
      assert.ok(call, 'hook is called');
    }
  }
  // Beside the auto-merge drain, not instead of it: each verdict site passes
  // the settled state to both.
  const sites = [...visualsSrc.matchAll(/maybeAutoMergeAfterChecks\(/g)].length;
  assert.ok(sites >= 2, 'the auto-merge drain still runs');
  assert.match(harvestSrc, /visuals\.noteBotChecksAfterChecks\(/, 'check-harvest reaches it for adopted runs');
});
