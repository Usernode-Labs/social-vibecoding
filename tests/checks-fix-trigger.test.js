// #3603: a failing checks verdict asks the Homeroom bot to look at the
// proposal it opened. visuals.noteBotChecksAfterChecks sits beside
// maybeAutoMergeAfterChecks, at every place a verdict settles, and calls
// homeroom-bot's noteProposalChecks once, for 'failing' only. Fire and
// forget: it never throws, so the capture pipeline's contract is unchanged.
//
// Run with: node --test tests/checks-fix-trigger.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// services/visuals pulls in jsonwebtoken (used only to mint a capture
// session cookie, a path these tests never reach). Same shims as
// checks-auto-merge-trigger.test.js.
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

function loadVisuals({ throwOnNote = false } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    resolver: require.resolve('../src/services/conflict-resolver'),
    bot: require.resolve('../src/services/homeroom-bot'),
    subject: require.resolve('../src/services/visuals'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const noteCalls = [];
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, { isEnabled: () => true });
  stub(ids.resolver, { checkAndResolveConflicts: async () => {} });
  stub(ids.bot, {
    noteProposalChecks: async (pool, session, state) => {
      noteCalls.push({ pool, session, state });
      if (throwOnNote) throw new Error('boom');
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

test('a failing verdict asks the bot to look, exactly once', async () => {
  const { subject, noteCalls, restore } = loadVisuals();
  try {
    subject.noteBotChecksAfterChecks({ query: async () => ({ rows: [] }) }, { id: 5001 }, 'failing');
    await flush();
    assert.equal(noteCalls.length, 1);
    assert.deepEqual(noteCalls[0].session, { id: 5001 });
    assert.equal(noteCalls[0].state, 'failing');
  } finally {
    restore();
  }
});

test('no other verdict asks it anything', async () => {
  for (const state of ['passing', 'skipped', 'error', 'pending', 'captured', undefined]) {
    const { subject, noteCalls, restore } = loadVisuals();
    try {
      subject.noteBotChecksAfterChecks({ query: async () => ({ rows: [] }) }, { id: 5001 }, state);
      await flush();
      assert.equal(noteCalls.length, 0, `${state} must not reach the bot`);
    } finally {
      restore();
    }
  }
});

test('it never throws, even when the bot does', async () => {
  const { subject, noteCalls, restore } = loadVisuals({ throwOnNote: true });
  try {
    assert.doesNotThrow(() => subject.noteBotChecksAfterChecks({ query: async () => ({ rows: [] }) }, { id: 5001 }, 'failing'));
    await flush();
    assert.equal(noteCalls.length, 1);
  } finally {
    restore();
  }
});

test('it sits beside maybeAutoMergeAfterChecks at all three places a verdict settles', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const visuals = read('src/services/visuals.js');
  // The lifecycle wrapper.
  assert.match(visuals, /maybeAutoMergeAfterChecks\(config, getPool\(config\), session, completed\.state\);[\s\S]{0,80}?noteBotChecksAfterChecks\(getPool\(config\), session, completed\.state\);/);
  // settleCaptureRun (the live capture): unconditional, unlike the auto-merge.
  assert.match(visuals, /if \(!operation\) maybeAutoMergeAfterChecks\(config, pool, session, checksResult\.state\);[\s\S]{0,120}?noteBotChecksAfterChecks\(pool, session, checksResult\.state\);/);
  // check-harvest, for a run adopted after its process died.
  const harvest = read('src/services/check-harvest.js');
  assert.match(harvest, /visuals\.maybeAutoMergeAfterChecks\(config, pool, session, settled\.result\.state\);[\s\S]{0,200}?visuals\.noteBotChecksAfterChecks\(pool, session, settled\.result\.state\);/);
  // The skipped call in staging-recovery is left as it is: the hook returns
  // before doing anything, so it never reaches the bot.
  assert.doesNotMatch(read('src/services/staging-recovery.js'), /noteBotChecksAfterChecks/);
});
